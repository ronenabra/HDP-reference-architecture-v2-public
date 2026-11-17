'use strict';

/** Pure helpers shared by lifecycle commands and orchestration tests. */

const net = require('net');

const ACTIVE_SERVICES = Object.freeze([
    'pcm-core', 'sp-client', 'ho-postgres',
    'ho-a-adapter', 'ho-b-adapter', 'ho-c-adapter',
    'ho-a-hapi', 'ho-b-hapi', 'ho-c-hapi',
    'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway',
    'ds-auth-adapter', 'ds-fhir-server', 'ds-gateway'
]);

function activeServices(config = null) {
    if (config?.legacyDataSource?.enabled === false) {
        return ACTIVE_SERVICES.filter(service => !['ds-auth-adapter', 'ds-fhir-server', 'ds-gateway'].includes(service));
    }
    return [...ACTIVE_SERVICES];
}

function composeBase(envPath) {
    return ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml', '--env-file', envPath];
}

/** Validate an explicit Compose readiness budget in whole seconds (1–3,600). */
function readinessWaitTimeout(value) {
    if (value === undefined) return 600;
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
        throw new TypeError('--wait-timeout must be a whole number of seconds from 1 through 3600');
    }
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
        throw new TypeError('--wait-timeout must be a whole number of seconds from 1 through 3600');
    }
    return seconds;
}

/** Keep HAPI's startup grace inside the selected outer readiness budget. */
function readinessEnvironment(environment, waitTimeout) {
    return { ...environment,
        PCM_HAPI_HEALTH_START_PERIOD: `${Math.max(90, readinessWaitTimeout(waitTimeout))}s` };
}

function composeUpArgs(envPath, options = {}) {
    if (options.noBuild && options.pull) throw new TypeError('--no-build and --pull cannot be combined');
    const args = [...composeBase(envPath), 'up', ...activeServices(options.config)];
    if (options.noBuild) args.push('--no-build', '--pull', 'never');
    else {
        args.push('--build');
        if (options.pull) args.push('--pull', 'always');
    }
    if (!options.foreground) args.push('-d', '--wait', '--wait-timeout', String(readinessWaitTimeout(options.waitTimeout)));
    return args;
}

function listenProbe(port, host = '127.0.0.1') {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', error => resolve({ port, available: false, error: error.code }));
        server.once('listening', () => server.close(() => resolve({ port, available: true })));
        server.listen(port, host);
    });
}

async function checkPorts(ports) {
    return Promise.all([...new Set(ports)].map(port => listenProbe(port)));
}

module.exports = { ACTIVE_SERVICES, activeServices, checkPorts, composeBase, composeUpArgs, listenProbe, readinessWaitTimeout, readinessEnvironment };
