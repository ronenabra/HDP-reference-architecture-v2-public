'use strict';
/** Resolve semantic stream capabilities independently of their display labels. */
const fs = require('node:fs');
const path = require('node:path');

/** Legacy callers pass directory IDs; new callers pass configured source objects. */
function isGatewaySource(component) {
    return typeof component === 'object' ? component.role === 'gateway' || /(?:^|-)gateway$/.test(component.dir || '')
        : /(?:^|-)gateway$/.test(String(component));
}

/** Extension files are an operator-owned read-only mount; never follow symlinks out of it. */
function assertSafeExtensionPath(root, component, filename, io = fs) {
    if (!component.external && !component.strictPath && !String(component.dir || '').startsWith('extensions/')) return;
    const relative = path.relative(path.resolve(root), path.resolve(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Extension log path escaped configured root');
    let current = path.resolve(root);
    for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if (io.lstatSync(current).isSymbolicLink()) throw new Error('Extension log symlinks are not supported');
    }
}
module.exports = { isGatewaySource, assertSafeExtensionPath };

/** Open one immutable path identity; extension writers may append but may not swap paths while opening. */
function openLogFile(root, file, io = fs) {
    const source = file.component;
    const external = source.external || source.strictPath || String(source.dir || '').startsWith('extensions/');
    // Nonblocking has no effect on ordinary files, but prevents a FIFO swapped
    // into a configured path from hanging the operator before fstat can reject it.
    const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
    if (!external) {
        const fd = io.openSync(file.filename, readFlags);
        try {
            if (!io.fstatSync(fd).isFile()) throw new Error('Configured log is not a regular file');
            return fd;
        } catch (error) { io.closeSync(fd); throw error; }
    }
    if (typeof fs.constants.O_NOFOLLOW !== 'number') throw new Error('Safe extension log opening is unavailable on this platform');
    assertSafeExtensionPath(root, source, file.filename, io);
    const relative = path.relative(path.resolve(root), path.resolve(file.filename));
    let current = path.resolve(root);
    const ancestors = [current, ...relative.split(path.sep).map(part => { current = path.join(current, part); return current; })];
    const before = ancestors.map(filename => ({ filename, stat: io.lstatSync(filename) }));
    if (before.some(item => item.stat.isSymbolicLink())) throw new Error('Extension log symlinks are not supported');
    if (!before.at(-1).stat.isFile()) throw new Error('Configured log is not a regular file');
    const fd = io.openSync(file.filename, readFlags | fs.constants.O_NOFOLLOW);
    try {
        const opened = io.fstatSync(fd), expected = before.at(-1).stat;
        if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) throw new Error('Extension log changed while opening');
        for (const item of before) {
            const after = io.lstatSync(item.filename);
            if (after.isSymbolicLink() || after.dev !== item.stat.dev || after.ino !== item.stat.ino) throw new Error('Extension log path changed while opening');
        }
        return fd;
    } catch (error) { io.closeSync(fd); throw error; }
}
module.exports.openLogFile = openLogFile;

/** Read only the fixed native writer health signal within the existing page byte budget. */
function readRuntimeHealth(root, component, budget, io = fs) {
    if (component.role !== 'hapi') return undefined;
    const file = { component, filename: path.join(root, component.dir, 'health.json') };
    let fd;
    try {
        fd = openLogFile(root, file, io);
        const size = io.fstatSync(fd).size;
        if (size < 2 || size > 4096 || budget.bytes + size > 1024 * 1024) return { state: 'health-unavailable' };
        const bytes = Buffer.alloc(size); const count = io.readSync(fd, bytes, 0, size, 0); budget.bytes += count;
        const value = JSON.parse(bytes.subarray(0, count));
        if (!value || typeof value !== 'object' || !['available', 'loss', 'disabled'].includes(value.state)) return { state: 'health-unavailable' };
        const health = { state: value.state };
        for (const key of ['queuedEntries', 'queuedBytes', 'dropped', 'writeFailures', 'lastSuccessEpochMs', 'pendingLoss']) {
            if (!Number.isSafeInteger(value[key]) || value[key] < 0) return { state: 'health-unavailable' };
            health[key] = value[key];
        }
        if (value.state !== 'disabled' && Number.isSafeInteger(value.observedAtEpochMs) && Date.now() - value.observedAtEpochMs > 5000) health.state = 'health-stale';
        return health;
    } catch (_) { return { state: 'health-unavailable' }; }
    finally { if (fd !== undefined) io.closeSync(fd); }
}
module.exports.readRuntimeHealth = readRuntimeHealth;
