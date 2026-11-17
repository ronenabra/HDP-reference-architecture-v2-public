'use strict';

/** Give the unprivileged browser container temporary read-only certificate access. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Copy a generated certificate tree without changing its permissions.
 * The private parent prevents other host users from reading the copies; Docker
 * mounts only its readable child. Call cleanup after the browser process exits.
 * @param {string} source Original team certificate directory.
 * @param {string} temporaryRoot Parent for the disposable private directory.
 * @returns {{directory: string, cleanup: Function}} Mount path and cleanup.
 */
function stageBrowserCertificates(source, temporaryRoot = os.tmpdir()) {
    const parent = fs.mkdtempSync(path.join(temporaryRoot, 'pcm-browser-certs-'));
    const cleanup = () => fs.rmSync(parent, { recursive: true, force: true });
    try {
        fs.chmodSync(parent, 0o700);
        if (!fs.lstatSync(source).isDirectory()) throw new Error('Browser certificates must be a real directory');
        /** Preserve custom identity subdirectories without following any symlink. */
        function copyDirectory(input, output) {
            fs.mkdirSync(output, { mode: 0o755 });
            fs.chmodSync(output, 0o755);
            for (const entry of fs.readdirSync(input, { withFileTypes: true })) {
                const original = path.join(input, entry.name);
                const target = path.join(output, entry.name);
                if (entry.isDirectory()) copyDirectory(original, target);
                else if (entry.isFile()) {
                    fs.copyFileSync(original, target);
                    fs.chmodSync(target, 0o444);
                } else throw new Error(`Browser certificate entry must be a regular file or directory: ${entry.name}`);
            }
        }
        const directory = path.join(parent, 'certs');
        copyDirectory(source, directory);
        return { directory, cleanup };
    } catch (error) {
        cleanup();
        throw error;
    }
}

module.exports = { stageBrowserCertificates };
