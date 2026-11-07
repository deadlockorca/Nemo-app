"""Synthetic PKI tests; no Apple credentials and no network requests."""
import base64
import datetime as dt
from pathlib import Path
import tempfile
import unittest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509 import ocsp
from certificate_status import check_certificate, endpoint, inspect, verify_crl, verify_ocsp

NOW = dt.datetime.now(dt.timezone.utc)
DAY = dt.timedelta(days=1)


def cert(key, name, issuer_name, issuer_key, *, ca=False, eku=None, end=NOW + DAY, aia=True):
    builder = (x509.CertificateBuilder().subject_name(name).issuer_name(issuer_name).public_key(key.public_key())
               .serial_number(x509.random_serial_number()).not_valid_before(NOW - 2 * DAY).not_valid_after(end)
               .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if eku:
        builder = builder.add_extension(x509.ExtendedKeyUsage(eku), critical=False)
    if aia:
        builder = builder.add_extension(x509.AuthorityInformationAccess([x509.AccessDescription(x509.AuthorityInformationAccessOID.OCSP, x509.UniformResourceIdentifier('http://ocsp.apple.com/test'))]), critical=False)
    return builder.sign(issuer_key, hashes.SHA256())


class CertificateStatuses(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.delegate_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Ephemeral issuer')])
        cls.ca = cert(cls.ca_key, cls.name, cls.name, cls.ca_key, ca=True, aia=False)
        cls.leaf_name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Synthetic code signer')])
        cls.leaf = cert(cls.leaf_key, cls.leaf_name, cls.name, cls.ca_key, eku=[x509.ExtendedKeyUsageOID.CODE_SIGNING])

    def response(self, status=ocsp.OCSPCertStatus.GOOD, *, target=None, issuer=None, signer=None, key=None, this=None, until=None):
        signer = signer or self.ca
        builder = ocsp.OCSPResponseBuilder().add_response(cert=target or self.leaf, issuer=issuer or self.ca, algorithm=hashes.SHA1(), cert_status=status,
            this_update=this or NOW - dt.timedelta(minutes=1), next_update=until or NOW + dt.timedelta(hours=4),
            revocation_time=NOW - dt.timedelta(hours=1) if status == ocsp.OCSPCertStatus.REVOKED else None,
            revocation_reason=x509.ReasonFlags.key_compromise if status == ocsp.OCSPCertStatus.REVOKED else None)
        builder = builder.responder_id(ocsp.OCSPResponderEncoding.HASH, signer)
        if signer != self.ca:
            builder = builder.certificates([signer])
        return builder.sign(key or self.ca_key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)

    def test_good_signed_ocsp(self):
        result = verify_ocsp(self.response(), self.leaf, self.ca, NOW)
        self.assertEqual((result['status'], result['method']), ('good', 'ocsp'))

    def test_revoked_signed_ocsp(self):
        self.assertEqual(verify_ocsp(self.response(ocsp.OCSPCertStatus.REVOKED), self.leaf, self.ca, NOW)['status'], 'revoked')

    def test_unknown_is_not_good_or_revoked(self):
        with self.assertRaises(ValueError):
            verify_ocsp(self.response(ocsp.OCSPCertStatus.UNKNOWN), self.leaf, self.ca, NOW)

    def test_tampered_signature_rejected(self):
        data = bytearray(self.response()); data[-1] ^= 1
        with self.assertRaises(ValueError):
            verify_ocsp(bytes(data), self.leaf, self.ca, NOW)

    def test_wrong_serial_and_issuer_rejected(self):
        other = cert(self.leaf_key, self.leaf_name, self.name, self.ca_key)
        other_name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Wrong issuer')])
        other_issuer = cert(self.delegate_key, other_name, other_name, self.delegate_key, ca=True)
        for data in [self.response(target=other), self.response(issuer=other_issuer)]:
            with self.subTest(data=data[:8]), self.assertRaises(ValueError):
                verify_ocsp(data, self.leaf, self.ca, NOW)

    def test_stale_future_and_excessively_long_lived_evidence_rejected(self):
        for this, until in [(NOW - 2 * DAY, NOW - DAY), (NOW + DAY, NOW + 2 * DAY), (NOW - DAY, NOW + 30 * DAY)]:
            with self.subTest(this=this), self.assertRaises(ValueError):
                verify_ocsp(self.response(this=this, until=until), self.leaf, self.ca, NOW)

    def test_authorized_delegate_verified(self):
        delegate = cert(self.delegate_key, self.leaf_name, self.name, self.ca_key, eku=[x509.ExtendedKeyUsageOID.OCSP_SIGNING])
        self.assertEqual(verify_ocsp(self.response(signer=delegate, key=self.delegate_key), self.leaf, self.ca, NOW)['status'], 'good')

    def test_delegate_without_ocsp_role_rejected(self):
        delegate = cert(self.delegate_key, self.leaf_name, self.name, self.ca_key, eku=[x509.ExtendedKeyUsageOID.CODE_SIGNING])
        with self.assertRaises(ValueError):
            verify_ocsp(self.response(signer=delegate, key=self.delegate_key), self.leaf, self.ca, NOW)

    def test_unrelated_delegate_even_with_ocsp_role_rejected(self):
        delegate = cert(self.delegate_key, self.leaf_name, self.leaf_name, self.delegate_key, eku=[x509.ExtendedKeyUsageOID.OCSP_SIGNING])
        with self.assertRaises(ValueError):
            verify_ocsp(self.response(signer=delegate, key=self.delegate_key), self.leaf, self.ca, NOW)

    def crl(self, *, revoked=False, key=None, until=NOW + DAY, extension=None):
        builder = x509.CertificateRevocationListBuilder().issuer_name(self.name).last_update(NOW - DAY).next_update(until)
        if revoked:
            entry = x509.RevokedCertificateBuilder().serial_number(self.leaf.serial_number).revocation_date(NOW - DAY).build()
            builder = builder.add_revoked_certificate(entry)
        if extension:
            builder = builder.add_extension(extension, critical=True)
        return builder.sign(key or self.ca_key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)

    def test_full_crl_good_and_revoked(self):
        self.assertEqual(verify_crl(self.crl(), self.leaf, self.ca, NOW)['status'], 'good')
        self.assertEqual(verify_crl(self.crl(revoked=True), self.leaf, self.ca, NOW)['status'], 'revoked')

    def test_crl_stale_bad_signature_and_delta_rejected(self):
        for data in [self.crl(until=NOW - dt.timedelta(hours=1)), self.crl(key=self.leaf_key), self.crl(extension=x509.DeltaCRLIndicator(1))]:
            with self.subTest(data=data[:8]), self.assertRaises(ValueError):
                verify_crl(data, self.leaf, self.ca, NOW)

    def test_network_failure_is_unknown(self):
        def offline(*args):
            raise OSError('network offline')
        self.assertEqual(check_certificate(self.leaf, self.ca, NOW, offline)['status'], 'unknown')

    def test_expired_cert_never_needs_a_network_request(self):
        leaf = cert(self.leaf_key, self.leaf_name, self.name, self.ca_key, eku=[x509.ExtendedKeyUsageOID.CODE_SIGNING], end=NOW - DAY)
        self.assertEqual(check_certificate(leaf, self.ca, NOW, lambda *a: self.fail('unexpected network request'))['status'], 'expired')

    def test_no_endpoint_is_unknown(self):
        leaf = cert(self.leaf_key, self.leaf_name, self.name, self.ca_key, eku=[x509.ExtendedKeyUsageOID.CODE_SIGNING], aia=False)
        self.assertEqual(check_certificate(leaf, self.ca, NOW)['detail'], 'no_status_endpoint')

    def test_endpoint_restricts_hosts_ports_schemes_and_credentials(self):
        self.assertEqual(endpoint('http://ocsp.apple.com/ocsp03-wwdrg302'), 'http://ocsp.apple.com/ocsp03-wwdrg302')
        for url in ['http://127.0.0.1/', 'http://ocsp.apple.com.evil.invalid/', 'http://ocsp.apple.com:8080/', 'file:///etc/passwd', 'http://user:pass@ocsp.apple.com/', 'http://ocsp.apple.com/#fragment', 'http://ocsp.apple.com/\nanything']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                endpoint(url)

    def test_unsigned_profile_is_not_a_source_of_certificate_status(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(Exception):
            inspect({'profile': base64.b64encode(b'fake').decode(), 'certificateSha256': 'a' * 64}, Path(directory))


if __name__ == '__main__':
    unittest.main()
