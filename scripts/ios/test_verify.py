"""Guard against broad critical-extension bypass in CMS verification."""
import datetime as dt
import unittest

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa

from verify import VerificationError, check_critical_extensions, der_value


class Verifier(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def certificate(self, oid, critical=True):
        name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Synthetic test signer')])
        now = dt.datetime.now(dt.timezone.utc)
        return (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                .public_key(self.key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=1))
                .add_extension(x509.UnrecognizedExtension(x509.ObjectIdentifier(oid), b'\x05\x00'), critical)
                .sign(self.key, hashes.SHA256()))

    def test_apple_development_and_distribution_markers_allowed(self):
        for oid in ['1.2.840.113635.100.6.1.2', '1.2.840.113635.100.6.1.4',
                    '1.2.840.113635.100.6.1.12', '1.2.840.113635.100.6.1.13']:
            check_critical_extensions([self.certificate(oid)])

    def test_unknown_critical_marker_rejected_even_under_apple_prefix(self):
        with self.assertRaises(VerificationError):
            check_critical_extensions([self.certificate('1.2.840.113635.100.6.1.999')])

    def test_unknown_noncritical_marker_allowed(self):
        check_critical_extensions([self.certificate('1.2.3.4', critical=False)])

    def test_truncated_and_indefinite_der_rejected(self):
        for value in [b'\x30\x80', b'\x0c\x05a', b'\x30\x03\x0c\x02x', b'\x01\x01\x01']:
            with self.assertRaises(VerificationError):
                der_value(value)

    def test_duplicate_entitlement_keys_rejected(self):
        entry = b'\x30\x06\x0c\x01a\x01\x01\xff'
        with self.assertRaises(VerificationError):
            der_value(b'\xb0\x10' + entry + entry)


if __name__ == '__main__':
    unittest.main()
