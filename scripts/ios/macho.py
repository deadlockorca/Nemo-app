"""Compare executable content independently of signatures."""
import hashlib, struct, json
def digest(data):
    return hashlib.sha256(data).hexdigest()

def signature_blobs(data):
    if data[:4] != b'\xcf\xfa\xed\xfe':
        raise ValueError('Expected thin arm64 Mach-O')
    offset = 32
    location = None
    for _ in range(struct.unpack_from('<I', data, 16)[0]):
        (command, size) = struct.unpack_from('<II', data, offset)
        if command == 29:
            location = struct.unpack_from('<II', data, offset + 8)
        offset += size
    if location is None:
        raise ValueError('No code signature')
    (start, size) = location
    signature = data[start:start + size]
    (magic, length, count) = struct.unpack_from('>III', signature)
    if magic != 4208856256 or length > len(signature):
        raise ValueError('Invalid signature superblob')
    result = {}
    for i in range(count):
        (slot, start) = struct.unpack_from('>II', signature, 12 + 8 * i)
        (magic, length) = struct.unpack_from('>II', signature, start)
        result[slot] = signature[start:start + length]
    return result

def normalized_macho(data):
    """Exclude signature blobs and signature-size metadata only; retain all code/data."""
    if data[:4] == b'\xcf\xfa\xed\xfe':
        result = bytearray(data)
        count = struct.unpack_from('<I', data, 16)[0]
        offset = 32
        sig = None
        for _ in range(count):
            (command, size) = struct.unpack_from('<II', data, offset)
            if size < 8 or offset + size > len(data):
                raise ValueError('Invalid Mach-O load command')
            if command == 29:
                sig = struct.unpack_from('<II', data, offset + 8)
                result[offset + 8:offset + 16] = b'\x00' * 8
            if command == 25 and data[offset + 8:offset + 24].rstrip(b'\x00') == b'__LINKEDIT':
                result[offset + 32:offset + 40] = b'\x00' * 8
                result[offset + 48:offset + 56] = b'\x00' * 8
            offset += size
        if sig:
            (start, size) = sig
            if start + size > len(data):
                raise ValueError('Invalid signature bounds')
            if any(data[start + size:]):
                raise ValueError('Nonzero data after code signature')
            return bytes(result[:start]).rstrip(b'\x00')
        return bytes(result)
    if data[:4] == b'\xca\xfe\xba\xbe':
        count = struct.unpack_from('>I', data, 4)[0]
        slices = []
        for i in range(count):
            (cpu, sub, start, size, align) = struct.unpack_from('>IIIII', data, 8 + i * 20)
            slices.append((cpu, sub, digest(normalized_macho(data[start:start + size]))))
        return json.dumps(slices).encode()
    raise ValueError('Unsupported Mach-O format')
