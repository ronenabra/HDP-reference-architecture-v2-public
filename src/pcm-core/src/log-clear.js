'use strict';
/** Shared clear scope and per-component results for both operator listeners. */
const fs = require('node:fs');
const path = require('node:path');
const { isGatewaySource, assertSafeExtensionPath } = require('./log-source');
const generations = new Map();

/** Return the process-local revision used to invalidate byte cursors after a clear. */
function logGeneration(root) { return generations.get(root) || 0; }

/** Truncate current streams in place and remove history; active writers may append new events.
 * @param {string} root Configured log root.
 * @param {Array<string|object>} components Validated component directories.
 * @param {object} io Filesystem interface, injectable for deterministic failure tests.
 * @returns {object} Cleared/partial verdict, scope, generation and per-component outcomes.
 */
function clearConfiguredLogs(root, components, io = fs) {
    generations.set(root, logGeneration(root) + 1);
    const results = components.map(component => {
        const dir = typeof component === 'string' ? component : component.dir;
        if (component.readOnly || dir.startsWith('extensions/')) return { component: dir, status: 'retained', reason: 'operator-owned read-only source' };
        try {
            const directory = path.join(root, dir);
            if (component.strictPath) {
                try { assertSafeExtensionPath(root, component, directory, io); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            io.mkdirSync(directory, { recursive: true });
            if (component.strictPath) for (const filename of [directory, path.join(directory, 'history'), path.join(directory, 'current.log')]) {
                try { assertSafeExtensionPath(root, component, filename, io); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            io.rmSync(path.join(directory, 'history'), { recursive: true, force: true });
            if (component.strictPath) {
                const filename = path.join(directory, 'current.log');
                const fd = io.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
                try {
                    if (!io.fstatSync(fd).isFile()) throw new Error('Native log current path is not a regular file');
                    assertSafeExtensionPath(root, component, filename, io); io.ftruncateSync(fd, 0);
                } finally { io.closeSync(fd); }
            } else io.writeFileSync(path.join(directory, 'current.log'), '');
            if (isGatewaySource(component)) io.writeFileSync(path.join(directory, 'error.log'), '');
            return { component: dir, status: 'cleared' };
        } catch (error) { return { component: dir, status: 'failed', error: error.message }; }
    });
    return { status: results.every(result => ['cleared', 'retained'].includes(result.status)) ? 'cleared' : 'partial',
        scope: 'current-and-retained-history', generation: logGeneration(root), results,
        notice: 'Active services may write new events immediately after truncation. Read-only extension sources are retained.' };
}
module.exports = { clearConfiguredLogs, logGeneration };
