/**
 * Watch team runtime config and call back when its revision changes.
 */
const fs = require('fs');
const { reloadTeamConfig } = require('./team-config');

function readRevision(configPath) {
    try {
        if (!configPath || !fs.existsSync(configPath)) return null;
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return `${parsed.runtime?.revision || 0}:${parsed.runtime?.certificateRevision || 0}:${parsed.security?.pcmApi?.clientAuth || ''}`;
    } catch (err) {
        console.warn(`[Runtime] Failed to read revision from ${configPath}: ${err.message}`);
        return null;
    }
}

function watchRuntimeConfig(configPath, onChange, intervalMs = 1000) {
    let lastRevision = readRevision(configPath);
    const interval = setInterval(() => {
        const nextRevision = readRevision(configPath);
        if (nextRevision && nextRevision !== lastRevision) {
            try {
                reloadTeamConfig();
                onChange(nextRevision);
                lastRevision = nextRevision;
            } catch (error) {
                console.warn(`[Runtime] Config reload rejected: ${error.message}`);
            }
        }
    }, intervalMs);
    return () => clearInterval(interval);
}

module.exports = {
    readRevision,
    watchRuntimeConfig
};
