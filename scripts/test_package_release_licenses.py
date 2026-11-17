"""Test reproducibility and the source/identity checks of license packaging."""

import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('license_package', Path(__file__).with_name('package-release-licenses.py'))
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class LicensePackageTest(unittest.TestCase):
    """Exercise failures that could silently misbind or omit release material."""

    def setUp(self):
        """Create a minimal independently packaged image and reviewed source."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'src/ho-fhir-server/THIRD_PARTY_NOTICES.md']:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name + '\n')
        (self.root / 'upstream.tar').write_bytes(b'corresponding source')
        self.images = {'sourceManifestSha256': 'source-sha', 'archiveSha256': 'archive-sha',
                       'images': [{'id': 'sha256:image', 'roles': ['example']}]}
        self.inventory = {'sourceManifestSha256': 'source-sha', 'packages': []}
        self.plan = {'sourceManifestSha256': 'source-sha', 'imageArchiveSha256': 'archive-sha',
                     'imageIds': ['sha256:image'], 'inventorySha256': PACKAGE.digest(PACKAGE.json_bytes(self.inventory)),
                     'sources': [{'file': 'upstream.tar', 'sha256': PACKAGE.digest(b'corresponding source')}],
                     'obligations': [{'package': 'example:1', 'status': 'complete', 'sourceRequired': True,
                                      'sourceFiles': ['upstream.tar'], 'review': 'Exact upstream source and build scripts.'}]}
        self.notices = [{'notices': [{'location': '/private/path/images.tar!layer!LICENSE', 'text': 'Full upstream terms\n'},
                                     {'location': '/private/path/LICENSE', 'text': 'Full upstream terms\n'}]}]

    def build(self):
        """Build members from the current test inputs."""
        return PACKAGE.build_files(self.root, self.images, self.inventory, self.notices, self.plan, self.root)

    def test_archive_is_reproducible_and_contains_full_material(self):
        """Repeated builds retain exact notices, sources and neutral metadata."""
        files, report = self.build()
        self.assertEqual(report['status'], 'reviewed-complete')
        self.assertEqual(report['noticeTexts'], 1)
        self.assertEqual(files['corresponding-source/upstream.tar'], b'corresponding source')
        self.assertNotIn(b'/private/path', files['NOTICES.json'])
        first, second = self.root / 'first.tar.gz', self.root / 'second.tar.gz'
        PACKAGE.write_archive(files, first)
        PACKAGE.write_archive(files, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first) as archive:
            self.assertEqual(archive.extractfile('LICENSE').read(), b'LICENSE\n')
            self.assertTrue(all(member.mtime == 0 and member.uid == 0 for member in archive))

    def test_new_runtime_package_requires_review(self):
        """A changed inventory cannot silently inherit a previous approval."""
        self.inventory['packages'].append({'type': 'deb', 'name': 'new', 'version': '1'})
        with self.assertRaisesRegex(ValueError, 'Runtime inventory binding'):
            self.build()
        self.plan['inventorySha256'] = PACKAGE.digest(PACKAGE.json_bytes(self.inventory))
        with self.assertRaisesRegex(ValueError, 'absent from source/terms review'):
            self.build()

    def test_notices_for_another_image_are_rejected(self):
        """Notices with an explicit stale artifact binding must fail."""
        self.notices[0]['imageArchiveSha256'] = 'another-image'
        with self.assertRaisesRegex(ValueError, 'Notice image archive binding'):
            self.build()

    def test_review_files_are_verified_and_packaged(self):
        """Supporting legal decisions accompany the bundle with verified bytes."""
        (self.root / 'REVIEW.txt').write_bytes(b'exact artifact review')
        self.plan['reviewFiles'] = [{'file': 'REVIEW.txt', 'sha256': PACKAGE.digest(b'exact artifact review')}]
        files, _ = self.build()
        self.assertEqual(files['REVIEW.txt'], b'exact artifact review')
        (self.root / 'REVIEW.txt').write_bytes(b'changed review')
        with self.assertRaisesRegex(ValueError, 'Review file checksum mismatch'):
            self.build()

    def test_review_files_cannot_replace_the_report(self):
        """Review inputs cannot impersonate the tool's own completion report."""
        self.plan['reviewFiles'] = [{'file': 'COMPANION.json', 'sha256': 'unused'}]
        with self.assertRaisesRegex(ValueError, 'collides'):
            self.build()

    def test_public_nested_notice_provenance_is_preserved(self):
        """Only host prefixes are removed; Maven/WAR ownership stays visible."""
        for location in ['maven-source:group/artifact/1/source.jar!Class.java',
                         'app/main.war!WEB-INF/lib/library.jar!META-INF/NOTICE']:
            with self.subTest(location=location):
                self.assertEqual(PACKAGE.public_location(location), location)

    def test_source_hash_mismatch_fails(self):
        """Reject changed or corrupt source archives."""
        (self.root / 'upstream.tar').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.build()

    def test_missing_source_fails(self):
        """An unavailable source must not disappear silently from a companion."""
        (self.root / 'upstream.tar').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing source'):
            self.build()

    def test_exact_image_binding_is_required(self):
        """Reject source plans for another image archive or source snapshot."""
        self.plan['imageArchiveSha256'] = 'another-archive'
        with self.assertRaisesRegex(ValueError, 'Image archive binding'):
            self.build()
        self.plan['imageArchiveSha256'] = 'archive-sha'
        self.plan['sourceManifestSha256'] = 'another-source'
        with self.assertRaisesRegex(ValueError, 'Source manifest binding'):
            self.build()

    def test_each_image_identity_is_required(self):
        """A new independent image needs an updated review."""
        self.images['images'].append({'id': 'sha256:unreviewed'})
        with self.assertRaisesRegex(ValueError, 'exact image IDs'):
            self.build()

    def test_traversal_and_symlinks_are_rejected(self):
        """Source names cannot read host files outside the source directory."""
        for name in ['/etc/passwd', '../outside', 'folder/../../outside', 'folder\\outside', './upstream.tar', 'folder//source.tar']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                PACKAGE.source_file(self.root, name)
        (self.root / 'link').symlink_to(self.root / 'upstream.tar')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            PACKAGE.source_file(self.root, 'link')

    def test_unverified_obligation_reference_fails(self):
        """A claimed source dependency must be included and verified."""
        self.plan['obligations'][0]['sourceFiles'] = ['not-packaged.tar']
        with self.assertRaisesRegex(ValueError, 'unverified source'):
            self.build()

    def test_complete_source_obligation_requires_sources_and_rationale(self):
        """Empty checklists must not claim completion."""
        self.plan['obligations'][0]['sourceFiles'] = []
        with self.assertRaisesRegex(ValueError, 'no corresponding source'):
            self.build()
        self.plan['obligations'][0]['sourceFiles'] = ['upstream.tar']
        self.plan['obligations'][0]['review'] = ''
        with self.assertRaisesRegex(ValueError, 'review rationale'):
            self.build()

    def test_release_mode_refuses_unresolved_obligations(self):
        """An incomplete prepared companion cannot pass the release gate."""
        self.plan['obligations'][0]['status'] = 'unresolved'
        _, report = self.build()
        self.assertEqual(report['status'], 'prepared-incomplete')
        for name, data in [('images.json', self.images), ('inventory.json', self.inventory),
                           ('notices.json', self.notices[0]), ('plan.json', self.plan)]:
            (self.root / name).write_text(json.dumps(data))
        output = self.root / 'release.tar.gz'
        rc = PACKAGE.main(['--project-root', str(self.root), '--image-manifest', str(self.root / 'images.json'),
                           '--inventory', str(self.root / 'inventory.json'), '--notices', str(self.root / 'notices.json'),
                           '--source-plan', str(self.root / 'plan.json'), '--source-root', str(self.root),
                           '--output', str(output), '--require-complete'])
        self.assertEqual(rc, 1)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
