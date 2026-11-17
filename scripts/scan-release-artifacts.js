#!/usr/bin/env node
'use strict';

/** Deterministic scanner for generated release reports and service logs. */

const fs = require('fs');
const path = require('path');
const { sanitizeLogDetails, sanitizeLogMessage } = require('../src/shared/log-policy');

const PATTERNS = Object.freeze([
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
    ['bearer-token', /\bBearer[ \t]+(?!\[REDACTED\])[^\s"']+/gi],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g],
    ['oauth-form-secret', /(?:^|[?&\s"])(?:access_token|client_assertion|code|code_verifier|refresh_token|state|token|verifier)=(?!\[REDACTED\])[^&\s"']+/gim],
    ['oauth-json-secret', /"(?:access_token|client_assertion|code_verifier|refresh_token|state|token|verifier)"\s*:\s*"(?!\[REDACTED\])[^"\n]+"/gi],
    ['patient-fixture', /(?<![A-Za-z0-9])(?:000000018|000000026)(?![A-Za-z0-9])/g],
    ['local-fixture-secret', /\b(?:change-me-[A-Za-z0-9-]+|local-only-[A-Za-z0-9-]+)\b/g],
]);

function filesUnder(target) {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) throw new Error(`scan target does not exist: ${target}`);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error(`scan target must not be a symbolic link: ${target}`);
    if (stat.isFile()) return [resolved];
    if (!stat.isDirectory()) return [];
    return fs.readdirSync(resolved, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap(entry => filesUnder(path.join(resolved, entry.name)));
}

function lineNumber(text, index) {
    return text.slice(0, index).split('\n').length;
}

function scanFiles(targets, { awsOnly = false } = {}) {
    const files = [...new Set(targets.flatMap(filesUnder))].sort();
    const findings = [];
    for (const file of files) {
        const bytes = fs.readFileSync(file);
        if (bytes.includes(0)) continue;
        const text = bytes.toString('utf8');
        if (awsOnly) {
            let exposed = sanitizeLogMessage(text) !== text;
            try {
                const value = JSON.parse(text);
                exposed ||= JSON.stringify(value) !== JSON.stringify(sanitizeLogDetails(value));
            } catch (_) { /* Plain logs still receive AWS key/signature detection. */ }
            if (exposed) findings.push({ file, line: 1, rule: 'aws-operational-credential' });
            continue;
        }
        for (const [rule, pattern] of PATTERNS) {
            pattern.lastIndex = 0;
            for (const match of text.matchAll(pattern)) {
                findings.push({ file, line: lineNumber(text, match.index), rule });
            }
        }
    }
    return { scannedFiles: files.length, findings };
}

function main(argv = process.argv.slice(2)) {
    if (!argv.length) {
        console.error('Usage: node scripts/scan-release-artifacts.js <report-or-log-path> [...]');
        return 2;
    }
    try {
        const result = scanFiles(argv);
        console.log(JSON.stringify({ status: result.findings.length ? 'fail' : 'pass', ...result }, null, 2));
        return result.findings.length ? 1 : 0;
    } catch (error) {
        console.error(String(error.message || error));
        return 2;
    }
}

if (require.main === module) process.exitCode = main();

module.exports = { PATTERNS, filesUnder, main, scanFiles };
