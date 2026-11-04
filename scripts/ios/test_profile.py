"""Cryptographic regression tests for both Apple provisioning signer roles.

Synthetic keys/CA are confined to this process. Real Apple profiles, when given
with --profile, are verified against the unmodified, pinned Apple CA bundle.
No developer private keys or passwords are needed for these tests.
"""
import argparse
import datetime as dt
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs7

import package

NOW = dt.datetime.now(dt.timezone.utc)
PAYLOAD = plistlib.dumps({'Name': 'Synthetic regression profile', 'ProvisionedDevices': ['TEST-ONLY']})


def certificate(key, subject, issuer, issuer_key, *, ca=False, role=None):
    builder = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer)
               .public_key(key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(NOW - dt.timedelta(days=1))
               .not_valid_after(NOW + dt.timedelta(days=1))
               .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if role:
        builder = builder.add_extension(x509.UnrecognizedExtension(x509.ObjectIdentifier(role), b'\x05\x00'), critical=False)
    return builder.sign(issuer_key, hashes.SHA256())


class Profiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.ca_name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Ephemeral Test CA')])
        cls.ca = certificate(cls.ca_key, cls.ca_name, cls.ca_name, cls.ca_key, ca=True)
        cls.leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def cms(self, role, payload=PAYLOAD, multiple=False):
        name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Synthetic profile signer')])
        leaf = certificate(self.leaf_key, name, self.ca_name, self.ca_key, role=role)
        builder = pkcs7.PKCS7SignatureBuilder().set_data(payload).add_signer(leaf, self.leaf_key, hashes.SHA256())
        if multiple:
            other_name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Second signer')])
            other = certificate(self.leaf_key, other_name, self.ca_name, self.ca_key, role=role)
            builder = builder.add_signer(other, self.leaf_key, hashes.SHA256())
        return builder.sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.Binary])

    def verify_synthetic(self, cms):
        with tempfile.TemporaryDirectory(prefix='nemo-profile-unit-') as tmp:
            stage = Path(tmp)
            (stage / 'apple-chain.pem').write_bytes(self.ca.public_bytes(serialization.Encoding.PEM))
            with patch.object(package, 'HERE', stage):
                return package.verify_profile(cms, stage)

    def test_iphone_profile_role(self):
        self.assertEqual(self.verify_synthetic(self.cms('1.2.840.113635.100.6.58')), plistlib.loads(PAYLOAD))

    def test_existing_osx_profile_role(self):
        self.assertEqual(self.verify_synthetic(self.cms('1.2.840.113635.100.4.11')), plistlib.loads(PAYLOAD))

    def test_developer_certificate_cannot_sign_profiles(self):
        with self.assertRaisesRegex(package.Invalid, '^invalid_profile_signature$'):
            self.verify_synthetic(self.cms('1.2.840.113635.100.6.1.4'))

    def test_missing_role_rejected(self):
        with self.assertRaisesRegex(package.Invalid, '^invalid_profile_signature$'):
            self.verify_synthetic(self.cms(None))

    def test_tampered_payload_rejected(self):
        cms = self.cms('1.2.840.113635.100.6.58')
        self.assertIn(b'TEST-ONLY', cms)
        with self.assertRaisesRegex(package.Invalid, '^invalid_profile_signature$'):
            self.verify_synthetic(cms.replace(b'TEST-ONLY', b'FAKE-ONLY'))

    def test_untrusted_chain_rejected(self):
        with tempfile.TemporaryDirectory(prefix='nemo-profile-untrusted-') as tmp:
            with self.assertRaisesRegex(package.Invalid, '^invalid_profile_signature$'):
                package.verify_profile(self.cms('1.2.840.113635.100.6.58'), Path(tmp))

    def test_multiple_signers_rejected(self):
        with self.assertRaisesRegex(package.Invalid, '^invalid_profile_signature$'):
            self.verify_synthetic(self.cms('1.2.840.113635.100.6.58', multiple=True))

    def test_invalid_plist_rejected(self):
        with self.assertRaisesRegex(package.Invalid, '^invalid_profile_signature$'):
            self.verify_synthetic(self.cms('1.2.840.113635.100.6.58', payload=b'not a plist'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', action='append', default=[])
    args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Profiles))
    if not result.wasSuccessful():
        raise SystemExit(1)
    for path in args.profile:
        data = Path(path).read_bytes()
        with tempfile.TemporaryDirectory(prefix='nemo-profile-real-') as tmp:
            profile = package.verify_profile(data, Path(tmp))
        print(f'PASS real Apple profile: {Path(path).parent.name}; {len(profile.get("ProvisionedDevices", []))} device(s)')
        # Modifying a covered UDID must invalidate the signed payload.
        udid = profile.get('ProvisionedDevices', [''])[0].encode()
        if not udid or udid not in data:
            raise SystemExit('No testable embedded UDID')
        changed = (b'F' if udid[-1:] != b'F' else b'E')
        tampered = data.replace(udid, udid[:-1] + changed)
        with tempfile.TemporaryDirectory(prefix='nemo-profile-tamper-') as tmp:
            try:
                package.verify_profile(tampered, Path(tmp))
            except package.Invalid:
                print('PASS tampered real profile rejected')
            else:
                raise SystemExit('Tampered profile was accepted')
