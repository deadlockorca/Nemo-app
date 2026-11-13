"""Synthetic signing identities only. Apple CMS trust is covered by test_profile."""
import base64
import copy
import datetime as dt
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization.pkcs12 import serialize_key_and_certificates
from signing_assets import inspect


class SigningAssets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.now = dt.datetime.now(dt.timezone.utc)
        name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Synthetic'), x509.NameAttribute(x509.NameOID.ORGANIZATIONAL_UNIT_NAME, 'TESTTEAM00')])
        cls.cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(cls.key.public_key()).serial_number(123)
                    .not_valid_before(cls.now - dt.timedelta(days=1)).not_valid_after(cls.now + dt.timedelta(days=30)).sign(cls.key, hashes.SHA256()))
        p12 = serialize_key_and_certificates(b'test', cls.key, cls.cert, [], serialization.BestAvailableEncryption(b'correct'))
        cls.data = {'p12': base64.b64encode(p12).decode(), 'password': 'correct', 'profile': 'placeholder'}
        cls.profile = {'CreationDate': cls.now - dt.timedelta(days=1), 'ExpirationDate': cls.now + dt.timedelta(days=20),
                       'UUID': '00000000-0000-0000-0000-000000000000', 'Name': 'Test', 'ProvisionedDevices': ['00008120-0123456789ABCDEF'],
                       'Entitlements': {'com.apple.developer.team-identifier': 'TESTTEAM00', 'application-identifier': 'TESTTEAM00.*'}}

    def run_inspect(self, profile=None, data=None, certs=None):
        with patch('signing_assets.profile_assets', return_value=(profile or self.profile, certs if certs is not None else [self.cert], [])):
            return inspect(data or self.data, Path('.'))

    def test_matching_key_certificate_profile_returns_metadata_only(self):
        result = self.run_inspect()
        self.assertEqual(result['udids'], self.profile['ProvisionedDevices'])
        self.assertEqual(result['certificateSha256'], self.cert.fingerprint(hashes.SHA256()).hex())
        self.assertNotIn('p12', result)
        self.assertNotIn('password', result)

    def test_wrong_password(self):
        with self.assertRaises(ValueError):
            self.run_inspect(data={**self.data, 'password': 'wrong'})

    def test_profile_does_not_contain_certificate(self):
        with self.assertRaises(ValueError):
            self.run_inspect(certs=[])

    def test_wrong_team_bundle_expired_profile_and_missing_devices(self):
        for mutation in ['team', 'bundle', 'expiry', 'devices']:
            p = copy.deepcopy(self.profile)
            if mutation == 'team': p['Entitlements']['com.apple.developer.team-identifier'] = 'OTHERTEAM0'
            if mutation == 'bundle': p['Entitlements']['application-identifier'] = 'TESTTEAM00.other.app'
            if mutation == 'expiry': p['ExpirationDate'] = self.now - dt.timedelta(seconds=1)
            if mutation == 'devices': p['ProvisionedDevices'] = []
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.run_inspect(profile=p)

    def test_unsigned_profile_is_rejected_without_mock(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(Exception):
            inspect({**self.data, 'profile': base64.b64encode(b'unsigned').decode()}, Path(directory))


if __name__ == '__main__':
    unittest.main()
