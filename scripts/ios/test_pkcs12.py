"""Verify macOS compatibility conversion preserves the uploaded identity."""
import datetime as dt
import unittest

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12

import package


class KeychainBundle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Synthetic signing identity')])
        now = dt.datetime.now(dt.timezone.utc)
        cls.cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                    .public_key(cls.key.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=1))
                    .sign(cls.key, hashes.SHA256()))

    def test_modern_bundle_keeps_identity_and_chain(self):
        original = pkcs12.serialize_key_and_certificates(
            b'original', self.key, self.cert, [self.cert], serialization.BestAvailableEncryption(b'original-password'))
        converted, password = package.keychain_pkcs12(original, 'original-password')
        key, cert, chain = pkcs12.load_key_and_certificates(converted, password.encode())
        self.assertEqual(key.private_numbers(), self.key.private_numbers())
        self.assertEqual(cert.fingerprint(hashes.SHA256()), self.cert.fingerprint(hashes.SHA256()))
        self.assertEqual([c.public_bytes(serialization.Encoding.DER) for c in chain],
                         [self.cert.public_bytes(serialization.Encoding.DER)])
        with self.assertRaises(ValueError):
            pkcs12.load_key_and_certificates(converted, b'original-password')
        self.assertEqual(pkcs12.load_key_and_certificates(original, b'original-password')[0].private_numbers(), self.key.private_numbers())

    def test_wrong_password_is_rejected(self):
        original = pkcs12.serialize_key_and_certificates(
            b'original', self.key, self.cert, None, serialization.BestAvailableEncryption(b'correct'))
        with self.assertRaisesRegex(package.Invalid, '^wrong_p12_password$'):
            package.keychain_pkcs12(original, 'wrong')

    def test_missing_private_key_is_rejected(self):
        original = pkcs12.serialize_key_and_certificates(
            b'cert only', None, self.cert, None, serialization.BestAvailableEncryption(b'correct'))
        with self.assertRaisesRegex(package.Invalid, '^missing_private_key$'):
            package.keychain_pkcs12(original, 'correct')


if __name__ == '__main__':
    unittest.main()
