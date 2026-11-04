"""Independent verification of the SHA256-only signatures produced by zsign.

This deliberately supports our restricted blank IPA format, not arbitrary apps.
CMS signatures and the Apple chain are checked by OpenSSL; code pages, special
slots, bundle resource seals and entitlements are checked here before publication.
"""
import hashlib
from pathlib import Path, PurePosixPath
import plistlib
import struct
import subprocess

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.serialization.pkcs7 import load_der_pkcs7_certificates


class VerificationError(ValueError):
    pass


CRITICAL_CERTIFICATE_EXTENSIONS = {
    '2.5.29.19', '2.5.29.15', '2.5.29.37',  # basic constraints, key usage, extended key usage
    '1.2.840.113635.100.6.1.2',  # Apple iOS development signing role
    '1.2.840.113635.100.6.1.4',  # Apple iOS distribution signing role
    '1.2.840.113635.100.6.1.12',  # Apple Development (also carries iOS development role)
    '1.2.840.113635.100.6.1.13',  # Apple Distribution
    '1.2.840.113635.100.6.2.1',  # Apple WWDR intermediate role
}


def require(value):
    if not value:
        raise VerificationError('Invalid signed package')


def check_critical_extensions(certificates):
    for cert in certificates:
        require(all(not extension.critical or extension.oid.dotted_string in CRITICAL_CERTIFICATE_EXTENSIONS
                    for extension in cert.extensions))


def u32(data, offset, order='>'):
    require(0 <= offset <= len(data) - 4)
    return struct.unpack_from(order + 'I', data, offset)[0]


def slices(data):
    if data[:4] == b'\xca\xfe\xba\xbe':
        count = u32(data, 4)
        require(0 < count <= 16 and 8 + 20 * count <= len(data))
        end = 8 + 20 * count
        for i in range(count):
            offset, size = struct.unpack_from('>II', data, 16 + 20 * i)
            require(end <= offset and size > 0 and offset + size <= len(data))
            yield data[offset:offset + size]
            end = offset + size
    else:
        yield data


def blobs(data):
    require(data[:4] == b'\xcf\xfa\xed\xfe' and len(data) >= 32)
    count, size = u32(data, 16, '<'), u32(data, 20, '<')
    require(count <= 4096 and 32 + size <= len(data))
    cursor, signature = 32, None
    for _ in range(count):
        command, length = u32(data, cursor, '<'), u32(data, cursor + 4, '<')
        require(length >= 8 and cursor + length <= 32 + size)
        if command == 29:
            require(signature is None and length == 16)
            signature = (u32(data, cursor + 8, '<'), u32(data, cursor + 12, '<'))
        cursor += length
    require(cursor == 32 + size and signature is not None)
    start, length = signature
    require(start >= cursor and start + length <= len(data) and not any(data[start + length:]))
    sig = data[start:start + length]
    require(u32(sig, 0) == 0xfade0cc0)
    total, count = u32(sig, 4), u32(sig, 8)
    require(count <= 32 and 12 + 8 * count <= total <= len(sig))
    result, ranges = {}, []
    for i in range(count):
        slot, offset = u32(sig, 12 + 8 * i), u32(sig, 16 + 8 * i)
        length = u32(sig, offset + 4)
        require(slot not in result and offset >= 12 + 8 * count and length >= 8 and offset + length <= total)
        require(all(offset + length <= a or offset >= b for a, b in ranges))
        ranges.append((offset, offset + length))
        result[slot] = sig[offset:offset + length]
    require(0 in result and 0x10000 in result and not any(0x1000 <= s < 0x10000 for s in result))
    return start, result


def der_value(data, offset=0, depth=0):
    require(depth < 32 and offset + 2 <= len(data))
    tag, length = data[offset:offset + 2]
    offset += 2
    if length & 0x80:
        n = length & 0x7f
        require(0 < n <= 4 and offset + n <= len(data))
        length = int.from_bytes(data[offset:offset + n], 'big')
        offset += n
    end = offset + length
    require(end <= len(data))
    payload = data[offset:end]
    if tag == 1:
        require(payload in (b'\0', b'\xff'))
        value = payload == b'\xff'
    elif tag == 2:
        require(0 < length <= 8)
        value = int.from_bytes(payload, 'big', signed=True)
    elif tag == 12:
        value = payload.decode('utf8')
    elif tag in (0x30, 0x31, 0x70, 0xb0):
        values, cursor = [], offset
        while cursor < end:
            item, cursor = der_value(data, cursor, depth + 1)
            values.append(item)
        require(cursor == end)
        if tag in (0x31, 0xb0):
            require(all(isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) for v in values))
            require(len({v[0] for v in values}) == len(values))
            value = dict(values)
        else:
            value = values
    else:
        raise VerificationError('Unsupported entitlement type')
    return value, end


def verify_macho(data, info, resources, expected_entitlements, certificate, team, ca_file, stage):
    for thin in slices(data):
        limit, slots = blobs(thin)
        cd = slots[0]
        require(len(cd) >= 88 and u32(cd, 0) == 0xfade0c02 and u32(cd, 8) == 0x20400)
        require(not u32(cd, 12) & 2 and cd[36:40] == b'\x20\x02\x00\x0c' and u32(cd, 44) == 0)
        hash_offset, special, pages = u32(cd, 16), u32(cd, 24), u32(cd, 28)
        require(u32(cd, 32) == limit and pages == (limit + 4095) // 4096 and special <= 7)
        require(hash_offset >= 88 + special * 32 and hash_offset + pages * 32 == len(cd))
        team_offset = u32(cd, 48)
        require(88 <= team_offset < hash_offset - special * 32)
        require(cd[team_offset:].split(b'\0', 1)[0].decode() == team)
        if info:
            identifier = u32(cd, 20)
            require(88 <= identifier < hash_offset - special * 32)
            require(cd[identifier:].split(b'\0', 1)[0].decode() == plistlib.loads(info)['CFBundleIdentifier'])
        for index in range(pages):
            require(hashlib.sha256(thin[index * 4096:min((index + 1) * 4096, limit)]).digest()
                    == cd[hash_offset + index * 32:hash_offset + (index + 1) * 32])
        special_data = {1: info, 2: slots.get(2), 3: resources, 5: slots.get(5), 7: slots.get(7)}
        for slot in range(1, special + 1):
            content = special_data.get(slot)
            expected = hashlib.sha256(content).digest() if content else bytes(32)
            require(cd[hash_offset - slot * 32:hash_offset - (slot - 1) * 32] == expected)
        require(info is None or special >= 3)
        require(5 in slots and u32(slots[5], 0) == 0xfade7171)
        require(plistlib.loads(slots[5][8:]) == expected_entitlements)
        if expected_entitlements:
            require(special >= 7 and 7 in slots and u32(slots[7], 0) == 0xfade7172)
            decoded, end = der_value(slots[7][8:])
            require(end == len(slots[7]) - 8 and decoded == [1, expected_entitlements])
        cms = slots[0x10000]
        require(u32(cms, 0) == 0xfade0b01)
        # OpenSSL does not understand Apple's critical role markers. Explicitly
        # reject every other unknown critical extension before allowing these
        # markers during normal chain/signature verification against pinned CAs.
        check_critical_extensions(load_der_pkcs7_certificates(cms[8:]))
        (stage / 'cd.bin').write_bytes(cd)
        (stage / 'cms.der').write_bytes(cms[8:])
        signer = stage / 'signer.pem'
        result = subprocess.run(['openssl', 'cms', '-verify', '-binary', '-inform', 'DER',
                                 '-in', str(stage / 'cms.der'), '-content', str(stage / 'cd.bin'),
                                 '-CAfile', str(ca_file), '-purpose', 'any', '-ignore_critical', '-signer', str(signer)],
                                capture_output=True, timeout=30)
        require(result.returncode == 0)
        signers = x509.load_pem_x509_certificates(signer.read_bytes())
        require(len(signers) == 1 and signers[0].fingerprint(hashes.SHA256()) == certificate.fingerprint(hashes.SHA256()))


def verify_resources(folder, executable):
    seal_path = folder / '_CodeSignature/CodeResources'
    seal = seal_path.read_bytes()
    entries = plistlib.loads(seal)['files2']
    require(isinstance(entries, dict))
    for name, entry in entries.items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts and '\\' not in name)
        require(isinstance(entry, dict) and isinstance(entry.get('hash2'), bytes))
        require(hashlib.sha256((folder / name).read_bytes()).digest() == entry['hash2'])
    for path in folder.rglob('*'):
        if not path.is_file():
            continue
        name = path.relative_to(folder).as_posix()
        omitted = (name in (executable, 'Info.plist', 'PkgInfo', '_CodeSignature/CodeResources')
                   or path.name == '.DS_Store' or name.endswith('.lproj/locversion.plist'))
        require(omitted or name in entries)
    return seal


def verify_app(app, profile, certificate, ca_file, stage):
    binaries = []
    team = profile['Entitlements']['com.apple.developer.team-identifier']
    for path in app.rglob('*'):
        if not path.is_file():
            continue
        with path.open('rb') as f:
            magic = f.read(4)
        if magic not in (b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe'):
            continue
        info_path = path.parent / 'Info.plist'
        info, resources = None, None
        if info_path.is_file() and plistlib.loads(info_path.read_bytes()).get('CFBundleExecutable') == path.name:
            info = info_path.read_bytes()
            resources = verify_resources(path.parent, path.name)
        entitlements = profile['Entitlements'] if path.parent == app else {}
        verify_macho(path.read_bytes(), info, resources, entitlements, certificate, team, ca_file, stage)
        binaries.append(path)
    require(binaries and app / plistlib.loads((app / 'Info.plist').read_bytes())['CFBundleExecutable'] in binaries)
    return binaries
