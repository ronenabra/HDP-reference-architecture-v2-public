#!/usr/bin/env python3
"""Build a reproducible image companion containing notices and reviewed sources.

The inputs are an exact-image manifest, runtime license inventory, discovered
notice texts, and a reviewed source plan. Downloads and legal decisions happen
before packaging. This tool verifies hashes and keeps incomplete obligations
visible; it does not infer permission from an SPDX label or a successful build.
"""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile


def digest(data):
    """Return the SHA-256 identity of a byte string."""
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    """Serialize evidence with stable key ordering and a trailing newline."""
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + '\n').encode()


def read_json(path):
    """Read one UTF-8 JSON evidence document."""
    return json.loads(Path(path).read_text(encoding='utf-8'))


def source_file(root, name):
    """Resolve a relative source path while rejecting traversal and symlinks."""
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or str(path) != name or any(p in ('..', '.') for p in path.parts) or '\\' in name:
        raise ValueError('Source path must be a safe relative POSIX path: ' + name)
    current = Path(root)
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Source path must not contain a symlink: ' + name)
    if not current.is_file():
        raise ValueError('Missing source file: ' + name)
    return current


def package_key(package):
    """Return the exact runtime package identity used in the source plan."""
    return package['type'] + ':' + package['name'] + '@' + package['version']


def public_location(location):
    """Keep artifact member names without exposing a local evidence directory."""
    # Scanner locations can describe nested archives. Only their member chain
    # identifies distributed content; an absolute host prefix is not needed.
    if location.startswith('/'):
        if '!' in location:
            return 'image-archive!' + location.split('!', 1)[1]
        return 'source/' + PurePosixPath(location).name
    return location


def collect_notices(documents):
    """Deduplicate full notice texts and retain every public artifact location."""
    notices = {}
    for document in documents:
        for notice in document.get('notices', []):
            data = notice['text'].encode('utf-8')
            sha = digest(data)
            item = notices.setdefault(sha, {'sha256': sha, 'locations': set(), 'originSha256': set(), 'text': data})
            item['locations'].add(public_location(notice.get('location', notice.get('path', 'upstream'))))
            if notice.get('sha256'):
                item['originSha256'].add(notice['sha256'])
    return notices


def build_files(project, images, inventory, notices, plan, source_root):
    """Validate bindings and materialize the companion's deterministic members.

    Source-plan obligations use explicit review decisions. Every source reference
    must resolve to a checksum-verified file. Incomplete decisions remain in the
    resulting report and prevent release mode from producing an archive.
    """
    binding = images['sourceManifestSha256']
    if inventory.get('sourceManifestSha256') != binding or plan.get('sourceManifestSha256') != binding:
        raise ValueError('Source manifest binding differs between image, inventory and source plan')
    if plan.get('imageArchiveSha256') != images.get('archiveSha256'):
        raise ValueError('Image archive binding differs from source plan')
    if plan.get('inventorySha256') != digest(json_bytes(inventory)):
        raise ValueError('Runtime inventory binding differs from source plan')
    for document in notices:
        if document.get('sourceManifestSha256', binding) != binding:
            raise ValueError('Notice source manifest binding differs')
        if document.get('imageArchiveSha256', images['archiveSha256']) != images['archiveSha256']:
            raise ValueError('Notice image archive binding differs')
    image_ids = sorted({image['id'] for image in images['images']})
    if sorted(plan.get('imageIds', [])) != image_ids:
        raise ValueError('Source plan does not cover the exact image IDs')
    package_keys = {package_key(package) for package in inventory['packages']}
    reviewed_keys = {obligation['package'] for obligation in plan.get('obligations', [])}
    missing = package_keys - reviewed_keys
    if missing:
        raise ValueError('Runtime packages absent from source/terms review: ' + ', '.join(sorted(missing)))
    files = {}
    for name in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'src/ho-fhir-server/THIRD_PARTY_NOTICES.md']:
        files[name] = source_file(project, name).read_bytes()
    notice_index = []
    for sha, item in sorted(collect_notices(notices).items()):
        name = 'notices/' + sha + '.txt'
        files[name] = item['text']
        notice_index.append({key: sorted(value) if isinstance(value, set) else value for key, value in item.items() if key != 'text'})
    source_names = set()
    for source in plan.get('sources', []):
        name = source['file']
        if name in source_names:
            raise ValueError('Duplicate source file: ' + name)
        source_names.add(name)
        data = source_file(source_root, name).read_bytes()
        if digest(data) != source['sha256']:
            raise ValueError('Source checksum mismatch: ' + name)
        files['corresponding-source/' + name] = data
    for review_file in plan.get('reviewFiles', []):
        name = review_file['file']
        if name in files or name in ('COMPANION.json', 'SHA256SUMS', 'NOTICES.json', 'SOURCE-PLAN.json', 'RUNTIME-LICENSE-INVENTORY.json') or name.startswith(('notices/', 'corresponding-source/')):
            raise ValueError('Review file collides with companion content: ' + name)
        data = source_file(source_root, name).read_bytes()
        if digest(data) != review_file['sha256']:
            raise ValueError('Review file checksum mismatch: ' + name)
        files[name] = data
    unresolved = []
    if not plan.get('obligations'):
        raise ValueError('Source plan must contain reviewed obligations')
    for obligation in plan['obligations']:
        refs = obligation.get('sourceFiles', [])
        if any(ref not in source_names for ref in refs):
            raise ValueError('Obligation references an unverified source file: ' + obligation['package'])
        if obligation.get('status') != 'complete':
            unresolved.append(obligation)
        elif not obligation.get('review'):
            raise ValueError('Completed obligation needs a review rationale: ' + obligation['package'])
        elif obligation.get('sourceRequired') and not refs:
            raise ValueError('Completed source obligation has no corresponding source: ' + obligation['package'])
    files['NOTICES.json'] = json_bytes(notice_index)
    # Package records retain runtime identity and declared licenses. Layer paths
    # are already public artifact paths; host-only scanner locations are omitted.
    packages = [{key: package[key] for key in ['roles', 'imageId', 'name', 'version', 'type', 'purl', 'licenses'] if key in package}
                for package in inventory['packages']]
    files['RUNTIME-LICENSE-INVENTORY.json'] = json_bytes(packages)
    files['SOURCE-PLAN.json'] = json_bytes(plan)
    report = {'schemaVersion': 'pcm-image-license-companion/1', 'sourceManifestSha256': binding,
              'imageArchiveSha256': images['archiveSha256'], 'imageIds': image_ids,
              'projectLicenseSha256': digest(files['LICENSE']), 'noticeTexts': len(notice_index),
              'sourceFiles': len(source_names), 'status': 'prepared-incomplete' if unresolved else 'reviewed-complete',
              'unresolvedObligations': unresolved,
              'delivery': 'Supply this complete companion with every listed image, including independent image downloads. '
                          'Retain the corresponding source files at the same download location as the images. '
                          'The status records the supplied review; it is not a legal certification.'}
    files['COMPANION.json'] = json_bytes(report)
    files['SHA256SUMS'] = ''.join(digest(data) + '  ' + name + '\n' for name, data in sorted(files.items())).encode()
    return files, report


def write_archive(files, output):
    """Write a gzip/tar archive without host paths, timestamps or user IDs."""
    with Path(output).open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                for name, data in sorted(files.items()):
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o644
                    archive.addfile(member, io.BytesIO(data))


def main(argv=None):
    """Package reviewed local inputs; return nonzero if release checks fail."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--image-manifest', required=True, type=Path)
    parser.add_argument('--inventory', required=True, type=Path)
    parser.add_argument('--notices', required=True, action='append', type=Path)
    parser.add_argument('--source-plan', required=True, type=Path)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--require-complete', action='store_true', help='Refuse an archive with unresolved source/terms obligations')
    args = parser.parse_args(argv)
    try:
        files, report = build_files(args.project_root, read_json(args.image_manifest), read_json(args.inventory),
                                    [read_json(path) for path in args.notices], read_json(args.source_plan), args.source_root)
        if args.require_complete and report['unresolvedObligations']:
            print(json_bytes(report).decode(), end='')
            return 1
        write_archive(files, args.output)
        print(json.dumps({'status': report['status'], 'archiveSha256': digest(args.output.read_bytes()),
                          'noticeTexts': report['noticeTexts'], 'sourceFiles': report['sourceFiles'],
                          'unresolvedObligations': len(report['unresolvedObligations'])}, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError) as error:
        parser.exit(2, str(error) + '\n')


if __name__ == '__main__':
    raise SystemExit(main())
