#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Resolve shared policy modules from a checkout or the PCM container mount. */
function sharedModuleRoot() {
    const checkout = path.resolve(__dirname, '..', '..', 'src', 'shared');
    if (fs.existsSync(checkout)) return checkout;
    if (fs.existsSync('/shared')) return '/shared';
    return checkout;
}

const { createOpaqueClientId } = require(path.join(sharedModuleRoot(), 'pcm-contract'));

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i += 1;
        }
    }
    return args;
}

function repoRoot() {
    return path.resolve(__dirname, '..', '..');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Read and validate one versioned team configuration before side effects. */
function readValidatedTeamConfig(filePath, options = {}) {
    const config = readJson(filePath);
    const { assertValidTeamConfig } = require(path.join(sharedModuleRoot(), 'team-config-validator'));
    return assertValidTeamConfig(config, options);
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

/**
 * Return a Docker Compose bind-mount host path.
 *
 * Compose treats a bare relative path such as ``tmp/team`` as a named volume.
 * Paths inside the repository therefore receive an explicit ``./`` prefix;
 * paths outside it remain absolute so generated team environments work from
 * the repository Compose working directory.
 */
function composeHostPath(root, destination) {
    const relative = path.relative(root, destination);
    if (!relative) return '.';
    if (relative.startsWith('..') || path.isAbsolute(relative)) return path.resolve(destination);
    return `./${relative.split(path.sep).join('/')}`;
}

const LOCAL_ONLY_ENV = 'PCM_AUTONOMOUS_LOCAL_ONLY';

/** Refuse cloud, registry, remote-state, and publication commands in local-only verification. */
function assertLocalOnlyCommand(command, args, env = process.env) {
    if (env[LOCAL_ONLY_ENV] !== 'true') return;
    const lowerCommand = String(command).toLowerCase();
    const values = args.map(value => String(value));
    const terraformOperation = values.find(value => !value.startsWith('-')) || '';
    if (lowerCommand === 'aws') throw new Error('local-only guard refused an AWS CLI command');
    if (lowerCommand === 'terraform') {
        const operation = terraformOperation;
        const safeInit = operation === 'init'
            && values.includes('-backend=false')
            && values.some(value => value.startsWith('-plugin-dir='));
        if (!['validate', 'fmt', 'version'].includes(operation) && !safeInit) {
            throw new Error(`local-only guard refused Terraform ${operation || 'operation'}; only init -backend=false with a local -plugin-dir, validate, fmt, and version are allowed`);
        }
    }
    if (lowerCommand === 'docker' && values.some(value => ['push', 'login'].includes(value))) {
        throw new Error('local-only guard refused a container-registry command');
    }
    if (lowerCommand === 'git' && values[0] === 'push') {
        throw new Error('local-only guard refused git push');
    }
    if (['bash', 'sh'].includes(lowerCommand) && values.some(value => /(?:push|publish|deploy-team-environment|build-and-push)/i.test(value))) {
        throw new Error('local-only guard refused a publication/deployment wrapper');
    }
}

/** Execute explicit arguments with common local-only, capture and failure behavior. */
function run(command, args, options = {}) {
    const { capture = false, dryRun = false, allowFailure = false, forwardOutput = true, ...spawnOptions } = options;
    assertLocalOnlyCommand(command, args, options.env || process.env);
    const printable = [command, ...args].join(' ');
    if (dryRun) {
        console.log(`[dry-run] ${printable}`);
        return capture ? '' : undefined;
    }
    const result = spawnSync(command, args, {
        cwd: repoRoot(), encoding: 'utf8',
        stdio: capture || !forwardOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        ...spawnOptions
    });
    if ((result.error || result.status !== 0) && !allowFailure) {
        const detail = capture || !forwardOutput ? String(result.stderr || result.stdout || '').trim() : '';
        const error = new Error(detail || result.error?.message || `${printable} failed with status ${result.status}`, { cause: result.error });
        Object.assign(error, { status: result.status, exitCode: result.status ?? 1,
            signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '' });
        throw error;
    }
    return capture ? (result.stdout || '') : undefined;
}

function numberArg(args, name, fallback) {
    const value = args[name] === undefined ? fallback : Number(args[name]);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`--${name} must be an integer TCP port from 1 to 65535`);
    }
    return value;
}

function portSet(args, portIndex = 0) {
    if (!Number.isInteger(portIndex) || portIndex < 0 || portIndex > 99) {
        throw new Error('--port-index must be an integer from 0 to 99');
    }
    return {
        sp: numberArg(args, 'sp-port', 3100 + (portIndex * 100)),
        pcmUi: numberArg(args, 'pcm-ui-port', 4100 + (portIndex * 100)),
        pcmApi: numberArg(args, 'pcm-api-port', 4101 + (portIndex * 100)),
        pcmMetadata: numberArg(args, 'pcm-metadata-port', 4102 + (portIndex * 100)),
        ds: numberArg(args, 'ds-port', 8180 + (portIndex * 100)),
        dsLegacy: numberArg(args, 'legacy-ds-port', 8183 + (portIndex * 100)),
        dsHttp: numberArg(args, 'ds-http-port', 8184 + (portIndex * 100))
    };
}

function assertUniquePorts(namedPorts) {
    const seen = new Map();
    for (const [name, port] of Object.entries(namedPorts)) {
        if (seen.has(port)) {
            throw new Error(`port ${port} is used by both ${seen.get(port)} and ${name}`);
        }
        seen.set(port, name);
    }
}

function requireSafeTeamId(teamId) {
    if (!teamId || !/^[a-z0-9][a-z0-9-]*$/.test(teamId)) {
        throw new Error('team id must match /^[a-z0-9][a-z0-9-]*$/');
    }
}

/**
 * Derive a deterministic, opaque sandbox client identifier for one team role.
 * FHIR Resource.id values and business identifiers are deliberately excluded.
 */
function teamClientId(teamId, role) {
    requireSafeTeamId(teamId);
    return createOpaqueClientId(`pcm-${role}`, teamId);
}

const DEFAULT_TEAMS_ROOT = 'tmp/connectathon-teams';

module.exports = {
    DEFAULT_TEAMS_ROOT,
    LOCAL_ONLY_ENV,
    assertLocalOnlyCommand,
    numberArg,
    portSet,
    assertUniquePorts,
    composeHostPath,
    parseArgs,
    repoRoot,
    readJson,
    readValidatedTeamConfig,
    writeJson,
    copyFile,
    run,
    requireSafeTeamId,
    sharedModuleRoot,
    teamClientId
};
