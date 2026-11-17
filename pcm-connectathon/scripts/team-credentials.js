'use strict';

/** Preserve one installation's private database identity during configuration recreation. */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const REQUIRED_SECRETS = Object.freeze(['PCM_POSTGRES_ADMIN_PASSWORD',
    ...['A', 'B', 'C'].flatMap(letter => [`PCM_${letter}_DB_PASSWORD`, `PCM_${letter}_IMPORT_CREDENTIAL`])]);

/** Determine whether a raw Compose environment value contains an actual value. */
function nonempty(value) {
    return typeof value === 'string' && !['', '""', "''"].includes(value.trim()) && !value.trim().startsWith('#');
}

/**
 * Encode newly supplied plaintext once for Compose's .env quoting/interpolation.
 * Retained .env values are already encoded and must never pass through this function.
 * @param {string} value Newly supplied single-line plaintext.
 * @returns {string} Raw serialized value for one .env assignment.
 */
function encodeEnvironmentValue(value) {
    if (/[\r\n]/.test(value)) throw new Error('environment secret must be a single line');
    return value === '' || /^[A-Za-z0-9_/-]+$/.test(value) ? value
        : JSON.stringify(value.replaceAll('$', () => '$$'));
}

/**
 * Decode literal dollar pairs; never guess unresolved Compose variable references.
 * @param {string} value Parsed double-quoted or unquoted Compose text.
 * @param {string} name Selected field for value-free diagnostics.
 * @returns {string} Actual plaintext, rejecting unresolved references.
 */
function decodeLiteralInterpolation(value, name) {
    if (/\$(?:[A-Za-z_]|\{)/.test(value.replaceAll('$$', () => ''))) {
        throw new Error(`ambiguous Compose interpolation in ${name}`);
    }
    return value.replaceAll('$$', () => '$');
}

/**
 * Decode one managed .env value for host CLI requests, matching actual Compose Env.
 * Canonical quoted plaintext and retained literal single quotes are supported;
 * ambiguous duplicates, malformed quoting and unresolved interpolation fail visibly.
 * @param {string} text Complete managed environment text.
 * @param {string} name Exact selected variable name.
 * @returns {string} Plaintext value, or empty when absent.
 */
function readEnvironmentValue(text, name) {
    const prefix = `${name}=`, lines = text.split(/\r?\n/).filter(line => line.startsWith(prefix));
    if (!lines.length) return '';
    if (lines.length !== 1) throw new Error(`ambiguous serialized ${name}`);
    const raw = lines[0].slice(prefix.length).trim();
    if (raw.startsWith('"')) {
        let value;
        try {
            const quoted = raw.match(/^("(?:\\.|[^"\\])*")(?:\s+#.*)?$/);
            if (!quoted) throw new Error('invalid quoted value');
            value = JSON.parse(quoted[1]);
        } catch (_) { throw new Error(`invalid serialized ${name}`); }
        return decodeLiteralInterpolation(value, name);
    }
    if (raw.startsWith("'")) {
        const quoted = raw.match(/^'((?:\\'|[^'])*)'(?:\s+#.*)?$/);
        if (!quoted) throw new Error(`invalid serialized ${name}`);
        return quoted[1].replaceAll("\\'", "'");
    }
    const value = raw.replace(/\s+#.*$/, '');
    return decodeLiteralInterpolation(value, name);
}

/**
 * Read and validate retained credentials before any stop, repair or file replacement.
 * Raw values retain their existing Compose quoting semantics. No value enters errors.
 * @param {string} teamDir Selected installation directory.
 * @returns {{text:string, values:object}|null} Existing environment or a fresh-install marker.
 */
function readRetainedTeamEnvironment(teamDir) {
    if (!fs.existsSync(teamDir)) return null;
    const file = path.join(teamDir, '.env');
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error('existing installation requires a regular private .env; no files were changed');
    const text = fs.readFileSync(file, 'utf8'), values = {};
    for (const name of [...REQUIRED_SECRETS, 'TEAM_ADMIN_PASSWORD']) {
        const lines = text.match(new RegExp(`^${name}=([^\\r\\n]*)$`, 'gm')) || [];
        if (lines.length !== 1) throw new Error(`existing installation requires exactly one ${name}; no files were changed`);
        values[name] = lines[0].slice(name.length + 1);
        if (name !== 'TEAM_ADMIN_PASSWORD' && !nonempty(values[name])) throw new Error(`existing installation is missing ${name}; no files were changed`);
    }
    return { text, values };
}

/**
 * Select fresh random secrets or preserve a complete existing installation.
 * DB/import rotation is not configuration recreation. Explicit Admin changes remain supported.
 * @param {string} teamDir Selected installation directory.
 * @param {string} preset Target conformance preset.
 * @param {object} environment Operator environment, without printing its values.
 * @returns {{retained:object|null, values:object}} Serialized Compose values and original environment.
 */
function planTeamCredentials(teamDir, preset, environment = process.env) {
    const retained = readRetainedTeamEnvironment(teamDir), values = {};
    for (const name of REQUIRED_SECRETS) {
        const supplied = environment[name];
        if (supplied !== undefined && (!nonempty(supplied) || /[\r\n]/.test(supplied))) throw new Error(`invalid explicit ${name}`);
        if (retained && supplied !== undefined && supplied !== retained.values[name] && encodeEnvironmentValue(supplied) !== retained.values[name]) throw new Error(`configuration recreation cannot rotate ${name}; use a separately reviewed credential rotation`);
        values[name] = retained ? retained.values[name] : encodeEnvironmentValue(supplied ?? randomBytes(32).toString('base64url'));
    }
    const explicitAdmin = environment.TEAM_ADMIN_PASSWORD;
    if (explicitAdmin !== undefined && /[\r\n]/.test(explicitAdmin)) throw new Error('invalid explicit TEAM_ADMIN_PASSWORD');
    values.TEAM_ADMIN_PASSWORD = explicitAdmin !== undefined ? encodeEnvironmentValue(explicitAdmin) : retained ? retained.values.TEAM_ADMIN_PASSWORD
        : preset === 'strict' ? randomBytes(32).toString('base64url') : '';
    if (preset === 'strict' && !nonempty(values.TEAM_ADMIN_PASSWORD)) throw new Error('strict requires an explicit nonempty TEAM_ADMIN_PASSWORD before recreating a password-free installation; no files were changed');
    return { retained, values };
}

module.exports = { REQUIRED_SECRETS, encodeEnvironmentValue, readEnvironmentValue, readRetainedTeamEnvironment, planTeamCredentials };
