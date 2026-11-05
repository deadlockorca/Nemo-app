"""The shared IPA upload must enforce the same blank-source gate as signing."""
import hashlib
import plistlib
import tempfile
import unittest
import zipfile
from pathlib import Path

from package import Invalid, inspect_source


class SourceInspection(unittest.TestCase):
    def source(self, root, *, plugin=b'NemoBlankIdentity-1', info=None, extra=None):
        target = Path(root) / 'test.ipa'
        properties = {'CFBundleDisplayName': 'Nemo', 'CFBundleIdentifier': 'vn.fractal.nemo-rebuild',
                      'CFBundleExecutable': 'Runner', 'CFBundleShortVersionString': '6.11.23', 'CFBundleVersion': '322'}
        properties.update(info or {})
        with zipfile.ZipFile(target, 'w') as archive:
            archive.writestr('Payload/Runner.app/Info.plist', plistlib.dumps(properties))
            archive.writestr('Payload/Runner.app/Frameworks/uuid_helper.framework/uuid_helper', plugin)
            for name, data in (extra or {}).items():
                archive.writestr(name, data)
        return target

    def test_extracts_content_hash_and_version_without_customer_certificate(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.source(root)
            result = inspect_source(path)
            self.assertEqual(result, {'name': 'Nemo', 'bundle': 'vn.fractal.nemo-rebuild',
                                     'version': '6.11.23', 'build': '322', 'blankIdentity': True,
                                     'sourceSha256': hashlib.sha256(path.read_bytes()).hexdigest()})

    def test_rejects_both_types_of_embedded_customer_id(self):
        for value in [b'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', b'c' * 64]:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(Invalid) as raised:
                    inspect_source(self.source(root, plugin=b'NemoBlankIdentity-1\x00' + value))
                self.assertEqual(str(raised.exception), 'embedded_identity_found')

    def test_rejects_wrong_app_or_legacy_import_plugin(self):
        for options, error in [({'info': {'CFBundleDisplayName': 'Nemo VPS'}}, 'wrong_app'),
                               ({'plugin': b'NemoVPSRegistrationImport-1'}, 'blank_ipa_required'),
                               ({'plugin': b'NemoBlankIdentity-1 NemoVPSRegistrationImport-1'}, 'blank_ipa_required')]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(Invalid) as raised:
                    inspect_source(self.source(root, **options))
                self.assertEqual(str(raised.exception), error)

    def test_rejects_unsafe_archive_and_unexpected_bundles(self):
        for name, error in [('../escape', 'unsafe_ipa'),
                            ('Payload/Runner.app/PlugIns/Other.appex/a', 'unsupported_ipa'),
                            ('Payload/Other.app/Info.plist', 'unsupported_ipa')]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(Invalid) as raised:
                    inspect_source(self.source(root, extra={name: b'bad'}))
                self.assertEqual(str(raised.exception), error)

    def test_rejects_unusable_version_metadata(self):
        for value in ['<script>', 'a' * 81, '']:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(Invalid) as raised:
                    inspect_source(self.source(root, info={'CFBundleVersion': value}))
                self.assertEqual(str(raised.exception), 'invalid_ipa')


if __name__ == '__main__':
    unittest.main()
