'use strict';

/** Atomic private publication for generated team environment credentials. */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

/**
 * Write an environment with private permissions before any credential byte is written.
 * @param {string} target Selected generated team's environment path.
 * @param {string} text Complete replacement environment.
 * @returns {void}
 */
function writePrivateEnvironment(target, text) {
    if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
    const temporary = path.join(path.dirname(target), `.env.pending-${randomBytes(12).toString('hex')}`);
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, text);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        fs.renameSync(temporary, target);
    } catch (error) {
        try { fs.closeSync(descriptor); } catch (_) { /* Publication may fail after the descriptor was closed. */ }
        throw error;
    } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { writePrivateEnvironment };
