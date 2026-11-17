'use strict';

/** Hash the exact tracked and nonignored source tree without recording source contents. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** Include dirty/untracked implementation files; ignored teams, keys and evidence stay excluded. */
function sourceIdentity(root) {
    // Evidence paths can exceed Node's 1MiB default; retain the complete list or fail at this finite cap.
    const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const files = [...new Set(names.split('\0').filter(Boolean))].sort().map(name => {
        const file = path.join(root, name);
        let stat;
        try { stat = fs.lstatSync(file); } catch (error) {
            if (error.code === 'ENOENT') return { path: name, deleted: true };
            throw error;
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported source entry: ${name}`);
        const kind = stat.isSymbolicLink() ? 'symlink' : 'file';
        const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
        return { path: name, kind, executable: Boolean(stat.mode & 0o111), sha256: sha256(bytes) };
    });
    return { schemaVersion: 'pcm-source-identity/1', sha256: sha256(JSON.stringify(files)), files };
}
module.exports = { sourceIdentity };
