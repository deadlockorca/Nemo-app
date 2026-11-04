"""Inspect/sign the blank Nemo IPA. JSON input on stdin, safe JSON output only.

Uses Apple codesign on macOS or pinned zsign with independent verification on
Linux. No credentials, subprocess arguments or tool output are logged. The macOS
keychain is temporary and serialized by a host-wide lock. Never operates on an
installed application.
"""
import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import signal
import shlex
import stat
import subprocess
import sys
import tempfile
import zipfile
import plistlib
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization.pkcs12 import load_key_and_certificates, serialize_key_and_certificates, PBES
from macho import normalized_macho
from verify import verify_app

HERE = Path(__file__).resolve().parent
MACHO = (b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xfe\xed\xfa\xcf')
# Apple issues both OS X-style profiles (also seen in iOS development assets)
# and iPhone OS profiles. Match the role on the verified CMS signer, not merely
# any certificate embedded in the CMS or the developer's code-signing identity.
PROFILE_SIGNER_ROLES = {
    '1.2.840.113635.100.4.11',  # OS X provisioning profile signing
    '1.2.840.113635.100.6.58',  # iPhone OS provisioning profile signing
}


class Invalid(Exception):
    pass


def run(*args):
    r = subprocess.run([str(a) for a in args], capture_output=True, timeout=90)
    if r.returncode:
        tool = Path(args[0]).name
        operation = str(args[1]) if tool == 'security' else 'operation'
        raise Invalid(f'{tool}_{operation}_failed'.replace('-', '_'))
    return r.stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def keychain_pkcs12(p12_data, password):
    """Rewrap the same identity for macOS, only inside temporary private storage.

    Modern PKCS12 encryption/MAC defaults are not accepted by all versions of
    Apple's Security importer. The original upload remains AES-GCM encrypted;
    this compatibility copy uses a fresh password and is deleted with its stage.
    """
    try:
        key, cert, chain = load_key_and_certificates(p12_data, password.encode())
    except (ValueError, TypeError):
        raise Invalid('wrong_p12_password') from None
    if key is None or cert is None:
        raise Invalid('missing_private_key')
    temporary_password = secrets.token_urlsafe(32)
    encryption = (serialization.PrivateFormat.PKCS12.encryption_builder()
                  .kdf_rounds(20000).key_cert_algorithm(PBES.PBESv1SHA1And3KeyTripleDESCBC)
                  .hmac_hash(hashes.SHA1()).build(temporary_password.encode()))
    return serialize_key_and_certificates(b'Nemo signing identity', key, cert, chain, encryption), temporary_password


def verify_profile(profile_data, stage):
    pp = stage / 'profile.mobileprovision'
    pp.write_bytes(profile_data)
    signer = stage / 'profile-signer.pem'
    try:
        decoded = run('/usr/bin/openssl', 'cms', '-verify', '-binary', '-inform', 'DER',
                      '-in', pp, '-CAfile', HERE / 'apple-chain.pem', '-purpose', 'any', '-signer', signer)
        signers = x509.load_pem_x509_certificates(signer.read_bytes())
        if len(signers) != 1:
            raise ValueError('Expected exactly one profile signer')
        signer_oids = {extension.oid.dotted_string for extension in signers[0].extensions}
        if not PROFILE_SIGNER_ROLES.intersection(signer_oids):
            raise ValueError('Certificate is not a provisioning-profile signer')
        profile = plistlib.loads(decoded)
        if not isinstance(profile, dict):
            raise ValueError('Expected a profile dictionary')
        return profile
    except Exception:
        raise Invalid('invalid_profile_signature') from None


def archive(ipa):
    try:
        z = zipfile.ZipFile(ipa)
        entries = z.infolist()
        if len(entries) > 15000 or sum(e.file_size for e in entries) > 768 * 1024 * 1024:
            raise Invalid('ipa_too_large')
        names = set()
        for e in entries:
            path = PurePosixPath(e.filename)
            mode = e.external_attr >> 16
            if (e.filename in names or path.is_absolute() or '..' in path.parts or
                    '\\' in e.filename or '\x00' in e.filename or
                    stat.S_ISLNK(mode) or e.flag_bits & 1 or
                    (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                raise Invalid('unsafe_ipa')
            names.add(e.filename)
        infos = [n for n in names if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', n)]
        if len(infos) != 1 or any('/PlugIns/' in n or '/Watch/' in n for n in names):
            raise Invalid('unsupported_ipa')
        app = PurePosixPath(infos[0]).parent
        if any(not n.startswith(str(app) + '/') and n.rstrip('/') not in ('Payload', str(app)) for n in names):
            raise Invalid('unsupported_ipa')
        info = plistlib.loads(z.read(infos[0]))
        if info.get('CFBundleDisplayName') != 'Nemo' or info.get('CFBundleIdentifier') != 'vn.fractal.nemo-rebuild':
            raise Invalid('wrong_app')
        if not re.fullmatch(r'[A-Za-z0-9_-]+', info.get('CFBundleExecutable', '')):
            raise Invalid('wrong_app')
        plugin = z.read(str(app / 'Frameworks/uuid_helper.framework/uuid_helper'))
        if b'NemoBlankIdentity-1' not in plugin or b'NemoVPSRegistrationImport-' in plugin:
            raise Invalid('blank_ipa_required')
        if any(re.search(pattern, plugin) for pattern in
               (rb'[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}', rb'(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])')):
            raise Invalid('embedded_identity_found')
        if z.testzip() is not None:
            raise Invalid('unsafe_ipa')
        return z, app, info
    except (zipfile.BadZipFile, KeyError, ValueError, plistlib.InvalidFileException):
        raise Invalid('invalid_ipa') from None


def inspect(ipa, p12_data, password, profile_data, udid, stage):
    if not re.fullmatch(r'(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-Fa-f]{40})', udid):
        raise Invalid('invalid_apple_udid')
    try:
        key, cert, _ = load_key_and_certificates(p12_data, password.encode())
    except (ValueError, TypeError):
        raise Invalid('wrong_p12_password') from None
    if key is None or cert is None:
        raise Invalid('missing_private_key')
    now = dt.datetime.now(dt.timezone.utc)
    if not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
        raise Invalid('certificate_expired')
    # Verify the CMS signature and Apple chain, then restrict the signer to the
    # provisioning-profile signing role. This does not check online revocation.
    profile = verify_profile(profile_data, stage)
    expires = profile['ExpirationDate'].replace(tzinfo=dt.timezone.utc)
    created = profile['CreationDate'].replace(tzinfo=dt.timezone.utc)
    if not created <= now < expires:
        raise Invalid('profile_expired')
    devices = profile.get('ProvisionedDevices', [])
    if udid.upper() not in [d.upper() for d in devices]:
        raise Invalid('device_not_in_profile')
    if cert.fingerprint(hashes.SHA256()).hex() not in [sha(c) for c in profile.get('DeveloperCertificates', [])]:
        raise Invalid('certificate_profile_mismatch')
    ent = profile.get('Entitlements', {})
    team = ent.get('com.apple.developer.team-identifier')
    ous = [a.value for a in cert.subject.get_attributes_for_oid(x509.NameOID.ORGANIZATIONAL_UNIT_NAME)]
    if not team or team not in ous or not ent.get('application-identifier', '').startswith(team + '.'):
        raise Invalid('certificate_profile_mismatch')
    z, app, info = archive(ipa)
    with z:
        metadata = {
            'name': 'Nemo', 'bundle': info['CFBundleIdentifier'], 'version': str(info.get('CFBundleShortVersionString', '1')),
            'build': str(info.get('CFBundleVersion', '1')), 'sourceSha256': sha(Path(ipa).read_bytes()),
            'team': team, 'certificateSha256': cert.fingerprint(hashes.SHA256()).hex(),
            'certificateExpiresAt': cert.not_valid_after_utc.isoformat(), 'profileName': str(profile.get('Name', ''))[:200],
            'profileExpiresAt': expires.isoformat(), 'profileDeviceCount': len(devices),
            'signingMode': 'development' if ent.get('get-task-allow') else 'ad-hoc',
            'blankIdentity': True,
        }
    return metadata, cert, profile


def inspect_profile(data, stage):
    profile = verify_profile(base64.b64decode(data['profile'], validate=True), stage)
    expires = profile['ExpirationDate'].replace(tzinfo=dt.timezone.utc)
    created = profile['CreationDate'].replace(tzinfo=dt.timezone.utc)
    if not created <= dt.datetime.now(dt.timezone.utc) < expires:
        raise Invalid('profile_expired')
    devices = profile.get('ProvisionedDevices', [])
    if not isinstance(devices, list) or not 1 <= len(devices) <= 1000 or any(
        not isinstance(d, str) or not re.fullmatch(r'(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})', d) for d in devices
    ):
        raise Invalid('profile_has_no_devices')
    certificates = profile.get('DeveloperCertificates', [])
    # A profile with multiple signing identities cannot tell us which P12 the
    # admin will choose. Get the exact expiry after checking the selected P12.
    certificate_expiry = None
    if len(certificates) == 1:
        certificate_expiry = x509.load_der_x509_certificate(certificates[0]).not_valid_after_utc.isoformat()
    return {'profileName': str(profile.get('Name', ''))[:200],
            'team': str(profile.get('Entitlements', {}).get('com.apple.developer.team-identifier', ''))[:40],
            'udids': sorted(set(d.upper() for d in devices)), 'profileExpiresAt': expires.isoformat(),
            'certificateExpiresAt': certificate_expiry}


def signing_backend():
    backend = os.environ.get('IOS_SIGN_BACKEND', 'auto')
    if backend == 'auto':
        backend = 'apple' if sys.platform == 'darwin' else 'zsign'
    if backend not in ('apple', 'zsign') or (backend == 'apple' and sys.platform != 'darwin'):
        raise Invalid('unsupported_signer')
    return backend


def sign_apple(data, stage, app, info, cert, profile, p12_data, ep):
    identity = cert.fingerprint(hashes.SHA1()).hex().upper()
    compatible_p12, import_password = keychain_pkcs12(p12_data, data['password'])
    p12 = stage / 'cert.p12'; p12.write_bytes(compatible_p12); p12.chmod(0o600)
    kc_password = secrets.token_urlsafe(32)
    # All workers under this OS user share the search list, including workers
    # configured with different storage roots. A crash never keeps the lock held.
    lock_path = Path.home() / 'Library/Caches/nemo-signing.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # SecTrust does not discover intermediate certificates in keychains inside
    # some hidden storage directories (such as .local). Keep the ephemeral
    # keychain in the OS temporary directory, separate from private file storage.
    with lock_path.open('a') as lock, tempfile.TemporaryDirectory(prefix='nemo-keychain-') as key_tmp:
        keychain = Path(key_tmp) / 'signing.keychain-db'
        lock_path.chmod(0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        search = shlex.split(run('security', 'list-keychains', '-d', 'user').decode())
        created = False
        try:
            run('security', 'create-keychain', '-p', kc_password, keychain); created = True
            run('security', 'unlock-keychain', '-p', kc_password, keychain)
            run('security', 'import', p12, '-k', keychain, '-P', import_password, '-T', '/usr/bin/codesign')
            run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kc_password, keychain)
            for index, ca in enumerate(x509.load_pem_x509_certificates((HERE / 'apple-chain.pem').read_bytes())):
                ca_path = stage / f'public-ca-{index}.der'
                ca_path.write_bytes(ca.public_bytes(serialization.Encoding.DER))
                run('security', 'import', ca_path, '-k', keychain, '-t', 'cert')
            run('security', 'list-keychains', '-d', 'user', '-s', *search, keychain)
            binaries = []
            for path in app.rglob('*'):
                if path.is_file():
                    with path.open('rb') as f:
                        magic = f.read(4)
                    if magic in MACHO:
                        path.chmod(0o755)
                        if path != app / info['CFBundleExecutable']:
                            binaries.append(path)
            for binary in sorted(binaries, key=lambda p: len(p.parts), reverse=True):
                target = binary.parent if binary.parent.suffix == '.framework' else binary
                run('codesign', '--force', '--sign', identity, '--keychain', keychain, '--timestamp=none', target)
            run('codesign', '--force', '--sign', identity, '--keychain', keychain, '--timestamp=none',
                '--generate-entitlement-der', '--entitlements', ep, app)
            run('codesign', '--verify', '--deep', '--strict', app)
            if plistlib.loads(run('codesign', '-d', '--entitlements', ':-', app)) != profile['Entitlements']:
                raise Invalid('signature_verification_failed')
            extracted = stage / 'cert-'
            run('codesign', '-d', '--extract-certificates=' + str(extracted), app)
            if sha(Path(str(extracted) + '0').read_bytes()) != cert.fingerprint(hashes.SHA256()).hex():
                raise Invalid('signature_verification_failed')
        finally:
            if created:
                try:
                    run('security', 'list-keychains', '-d', 'user', '-s', *search)
                finally:
                    run('security', 'delete-keychain', keychain)
    return binaries


def sign_zsign(data, stage, app, cert, profile, p12_data, ep):
    executable = os.environ.get('IOS_ZSIGN_BIN', '/usr/local/bin/zsign')
    if not Path(executable).is_absolute() or not os.access(executable, os.X_OK):
        raise Invalid('linux_signer_unavailable')
    # Never put the uploaded password or private-key contents in argv/logs.
    key, _, _ = load_key_and_certificates(p12_data, data['password'].encode())
    key_path, cert_path = stage / 'signing-key.pem', stage / 'signing-cert.pem'
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    key_path.chmod(0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    try:
        # Force signing without cache; preserve every bundle field and resource.
        result = subprocess.run([executable, '-q', '-f', '-2', '-k', str(key_path), '-c', str(cert_path),
                                 '-m', str(stage / 'profile.mobileprovision'), '-e', str(ep), str(app)],
                                cwd=stage, capture_output=True, timeout=180)
        if result.returncode:
            raise Invalid('zsign_failed')
    finally:
        key_path.unlink(missing_ok=True)
    try:
        return verify_app(app, profile, cert, HERE / 'apple-chain.pem', stage)
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        raise Invalid('signature_verification_failed') from None


def sign(data, stage):
    ipa = Path(data['source'])
    p12_data = base64.b64decode(data['p12'], validate=True)
    profile_data = base64.b64decode(data['profile'], validate=True)
    metadata, cert, profile = inspect(ipa, p12_data, data['password'], profile_data, data['udid'], stage)
    if data['mode'] == 'inspect':
        return metadata
    if metadata['sourceSha256'] != data['expectedSourceSha256']:
        raise Invalid('source_changed')
    with archive(ipa)[0] as z:
        z.extractall(stage)
    app = next((stage / 'Payload').glob('*.app'))
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    (app / 'embedded.mobileprovision').write_bytes(profile_data)
    ep = stage / 'entitlements.plist'; ep.write_bytes(plistlib.dumps(profile['Entitlements']))
    if signing_backend() == 'apple':
        binaries = sign_apple(data, stage, app, info, cert, profile, p12_data, ep)
    else:
        binaries = sign_zsign(data, stage, app, cert, profile, p12_data, ep)
    pending = stage / 'signed.ipa'
    with zipfile.ZipFile(pending, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for path in sorted((stage / 'Payload').rglob('*')):
            if path.is_file():
                output.write(path, path.relative_to(stage))
    with zipfile.ZipFile(ipa) as before, zipfile.ZipFile(pending) as after:
        a = {n for n in before.namelist() if not n.endswith('/')}
        b = {n for n in after.namelist() if not n.endswith('/')}
        allowed = lambda n: n.endswith('/_CodeSignature/CodeResources') or n == str(app.relative_to(stage) / 'embedded.mobileprovision')
        if a - b or any(not allowed(n) for n in b - a) or after.testzip():
            raise Invalid('unexpected_package_change')
        for name in a & b:
            old, new = before.read(name), after.read(name)
            if old == new or allowed(name):
                continue
            if old[:4] not in MACHO or normalized_macho(old) != normalized_macho(new):
                raise Invalid('unexpected_package_change')
    target = Path(data['output'])
    if target.exists():
        raise Invalid('output_exists')
    # Storage is on the same filesystem as the temporary directory.
    os.replace(pending, target); target.chmod(0o600)
    return {**metadata, 'outputSha256': sha(target.read_bytes()), 'verified': True, 'nestedBinaries': len(binaries)}


if __name__ == '__main__':
    try:
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(Invalid('worker_interrupted')))
        data = json.load(sys.stdin)
        if data.get('mode') not in ('inspect', 'sign', 'inspect-profile'):
            raise Invalid('unsupported_signer')
        parent = Path(data['tempRoot'])
        with tempfile.TemporaryDirectory(prefix='ios-', dir=parent) as tmp:
            result = inspect_profile(data, Path(tmp)) if data['mode'] == 'inspect-profile' else sign(data, Path(tmp))
        print(json.dumps(result))
    except Invalid as e:
        print(json.dumps({'error': str(e)})); sys.exit(1)
    except Exception:
        print(json.dumps({'error': 'invalid_signing_assets'})); sys.exit(1)
