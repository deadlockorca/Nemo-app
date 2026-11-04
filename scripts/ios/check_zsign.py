"""Real-asset signing regression. Read private requests from stdin; never log them.

Each request uses the package.py JSON contract plus a test-only `label` field.
Only signed IPA outputs survive. Uploaded keys/passwords are never copied to logs.
"""
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import zipfile

from cryptography.hazmat.primitives.serialization.pkcs12 import load_key_and_certificates

import package
from verify import VerificationError, blobs, verify_app


def rejected(fn, description):
    try:
        fn()
    except (ValueError, package.Invalid, KeyError):
        return
    raise AssertionError('Tampering accepted: ' + description)


for request in json.load(sys.stdin):
    label = request.pop('label')
    output = Path(request['output'])
    output.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='signer-regression-', dir=request['tempRoot']) as tmp:
        result = package.sign(request, Path(tmp))
        assert result['verified'] and result['nestedBinaries'] >= 1
    print('PASS:', label, 'signing;', result['nestedBinaries'], 'nested binaries;', result['outputSha256'], flush=True)
    with tempfile.TemporaryDirectory(prefix='verify-regression-', dir=request['tempRoot']) as tmp:
        stage = Path(tmp)
        with zipfile.ZipFile(output) as archive:
            archive.extractall(stage)
        app = next((stage / 'Payload').glob('*.app'))
        info = plistlib.loads((app / 'Info.plist').read_bytes())
        executable = app / info['CFBundleExecutable']
        profile = package.verify_profile((app / 'embedded.mobileprovision').read_bytes(), stage)
        import base64
        _, certificate, _ = load_key_and_certificates(base64.b64decode(request['p12']), request['password'].encode())
        def verify():
            return verify_app(app, profile, certificate, package.HERE / 'apple-chain.pem', stage)
        verify()
        if sys.platform == 'darwin':
            package.run('codesign', '--verify', '--deep', '--strict', app)
            print('PASS:', label, 'Apple codesign deep/strict verification', flush=True)
        original = executable.read_bytes()
        limit, slots = blobs(original)
        changes = {
            'code page': 4096,
            'code directory': original.find(slots[0], limit) + len(slots[0]) - 1,
            'entitlements': original.find(slots[5], limit) + len(slots[5]) - 1,
            'CMS signature': original.find(slots[0x10000], limit) + len(slots[0x10000]) - 1,
        }
        for name, offset in changes.items():
            modified = bytearray(original)
            modified[offset] ^= 1
            executable.write_bytes(modified)
            try:
                rejected(verify, name)
            finally:
                executable.write_bytes(original)
        resource = app / 'embedded.mobileprovision'
        original_resource = resource.read_bytes()
        resource.write_bytes(original_resource + b'tampered')
        try:
            rejected(verify, 'bundle resource')
        finally:
            resource.write_bytes(original_resource)
        # A different profile-approved signing identity cannot validate this IPA.
        rejected(lambda: verify_app(app, profile, package.x509.load_pem_x509_certificates(
            (package.HERE / 'apple-chain.pem').read_bytes())[0], package.HERE / 'apple-chain.pem', stage), 'signer certificate')
        print('PASS:', label, 'rejects modified code, CodeDirectory, entitlements, CMS, resources and wrong signer', flush=True)
