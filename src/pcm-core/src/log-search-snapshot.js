'use strict';
/** Snapshot identity/probes shared by the request owner and worker; never copies raw data to clients. */
const fs = require('node:fs');
const crypto = require('node:crypto');

/** Hash the captured first/last 4 KiB, including an unterminated final record.
 * Append-only writes preserve these probes; ordinary truncate/regrow/rewrite does not.
 */
function probe(fd, size) {
    const hash = crypto.createHash('sha256');
    for (const start of [0, Math.max(0, size - 4096)]) {
        const buffer = Buffer.alloc(Math.min(4096, size - start));
        const count = fs.readSync(fd, buffer, 0, buffer.length, start);
        if (count !== buffer.length) throw new Error('Captured log was truncated');
        hash.update(buffer);
    }
    return hash.digest('hex');
}

/** Reject replacement/truncation and changed snapshot boundary content. */
function verifyFile(fd, file) {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== file.ino || stat.dev !== file.dev || stat.size < file.size || probe(fd, file.size) !== file.probe) {
        throw new Error('Captured logs changed or rotated; start a new search');
    }
}
module.exports = { probe, verifyFile };
