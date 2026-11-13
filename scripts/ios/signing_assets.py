"""Inspect a signing set locally; never output private assets or passwords."""
import base64
import datetime as dt
import json
from pathlib import Path
import re
import sys
import tempfile
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization.pkcs12 import load_key_and_certificates
from certificate_status import profile_assets, require


def inspect(data, stage):
    key, cert, _ = load_key_and_certificates(base64.b64decode(data['p12'], validate=True), data['password'].encode() or None)
    require(key is not None and cert is not None)
    public = lambda k: k.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    require(public(key.public_key()) == public(cert.public_key()))
    profile, certs, _ = profile_assets(data, stage)
    sha = cert.fingerprint(hashes.SHA256()).hex()
    require(any(c.fingerprint(hashes.SHA256()).hex() == sha for c in certs))
    now = dt.datetime.now(dt.timezone.utc)
    require(cert.not_valid_before_utc <= now < cert.not_valid_after_utc)
    expires = profile['ExpirationDate'].replace(tzinfo=dt.timezone.utc)
    require(profile['CreationDate'].replace(tzinfo=dt.timezone.utc) <= now < expires)
    ent = profile.get('Entitlements', {})
    team = ent.get('com.apple.developer.team-identifier', '')
    require(isinstance(team, str) and bool(re.fullmatch('[A-Z0-9]{1,40}', team)))
    require(team in [a.value for a in cert.subject.get_attributes_for_oid(x509.NameOID.ORGANIZATIONAL_UNIT_NAME)])
    app = ent.get('application-identifier', '')
    require(app.startswith(team + '.') and len(app) <= 240)
    pattern = app[len(team) + 1:]
    bundle = 'vn.fractal.nemo-rebuild'
    require(pattern == bundle or (pattern.endswith('*') and '*' not in pattern[:-1] and bundle.startswith(pattern[:-1])))
    devices = profile.get('ProvisionedDevices', [])
    require(isinstance(devices, list) and 1 <= len(devices) <= 1000)
    require(all(isinstance(d, str) and re.fullmatch(r'(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{16}|[0-9a-fA-F]{40})', d) for d in devices))
    uuid = profile.get('UUID', '')
    require(isinstance(uuid, str) and bool(re.fullmatch(r'[0-9A-Fa-f-]{36}', uuid)))
    return {'certificateSha256': sha, 'certificateExpiresAt': cert.not_valid_after_utc.isoformat(),
            'profileExpiresAt': expires.isoformat(), 'profileUuid': uuid, 'profileName': str(profile.get('Name', ''))[:200],
            'team': team, 'applicationIdentifier': app, 'udids': sorted(set(d.upper() for d in devices)),
            'signingMode': 'development' if ent.get('get-task-allow') else 'ad-hoc'}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(6 * 1024 * 1024 + 1)
        require(len(raw) <= 6 * 1024 * 1024)
        data = json.loads(raw)
        with tempfile.TemporaryDirectory(prefix='nemo-assets-', dir=data['tempRoot']) as directory:
            result = inspect(data, Path(directory))
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'error': 'invalid_signing_assets'}))
        sys.exit(1)
