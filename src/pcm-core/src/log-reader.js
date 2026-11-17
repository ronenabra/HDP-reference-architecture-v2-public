/** Read the shared PCM history/current/gateway files before API projection. */
const fs = require('fs');
const path = require('path');
const { parseGatewayErrorLine } = require('./gateway-error-log');
const { isGatewaySource, assertSafeExtensionPath, openLogFile } = require('./log-source');
const { project } = require('./admin-log-view');

/** Return parsed records and malformed lines with stable file/line coordinates. */
function readComponentLogRecords(root, component, idPrefix = component, { allHistory = false, source = null } = {}) {
    const resolvedSource = source || { dir: component };
    // Validate before existsSync/readdir: dangling or directory symlinks must not
    // silently look like an empty extension in an otherwise complete export.
    const stat = filename => {
        try { assertSafeExtensionPath(root, resolvedSource, filename); return fs.statSync(filename); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const historyDir = path.join(root, component, 'history');
    const limit = allHistory ? Infinity : Number(process.env.HISTORY_LOG_LIMIT || 5);
    const history = stat(historyDir)
        ? fs.readdirSync(historyDir, { withFileTypes: true }).filter(entry => {
            // Reject even dangling rotation symlinks rather than silently dropping
            // them from a source that would otherwise be labelled complete.
            assertSafeExtensionPath(root, resolvedSource, path.join(historyDir, entry.name));
            return entry.isDirectory();
        })
            .map(entry => entry.name).sort().slice(-limit).map(dir => `history/${dir}/app.log`)
        : [];
    return [...history, 'current.log', ...(isGatewaySource(source || component) ? ['error.log'] : [])].flatMap(logFile => {
        const filename = path.join(root, component, logFile);
        const info = stat(filename);
        if (!info) return [];
        if (!info.isFile()) throw new Error('Configured log is not a regular file');
        const fd = openLogFile(root, { component: resolvedSource, filename });
        let contents;
        try { contents = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
        return contents.trim().split('\n').filter(Boolean).map((raw, index) => {
            let parsed = null;
            try {
                parsed = logFile === 'error.log'
                    ? parseGatewayErrorLine(raw, { id: `${idPrefix}-${logFile}-${index + 1}` })
                    : JSON.parse(raw);
            } catch (_) { /* Admin retains malformed lines; legacy unified projection omits them. */ }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = null;
            if (resolvedSource.external || resolvedSource.role === 'hapi') {
                const projected = project(raw, { component: resolvedSource, logFile }, index + 1);
                return { parsed: projected, raw: projected.raw, logFile, componentLine: index + 1 };
            }
            const safe = project(raw, { component: resolvedSource, logFile }, index + 1);
            return { parsed: parsed ? require('../../shared/log-policy').sanitizeLogDetails(parsed) : null,
                raw: safe.raw, rawRedacted: safe.rawRedacted, logFile, componentLine: index + 1 };
        });
    });
}

module.exports = { readComponentLogRecords };
