/**
 * Tests for request lifecycle and process metadata logging.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { once } = require('node:events');
const express = require('express');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

function loadLogger(tmp) {
    const previousLogDir = process.env.LOG_DIR;
    const previousSessionId = process.env.LOG_SESSION_ID;
    process.env.LOG_DIR = tmp;
    process.env.LOG_SESSION_ID = 'test-session';
    delete require.cache[require.resolve('../src/logger')];
    const logger = require('../src/logger');
    return {
        logger,
        restore: () => {
            if (previousLogDir === undefined) delete process.env.LOG_DIR;
            else process.env.LOG_DIR = previousLogDir;
            if (previousSessionId === undefined) delete process.env.LOG_SESSION_ID;
            else process.env.LOG_SESSION_ID = previousSessionId;
            delete require.cache[require.resolve('../src/logger')];
        }
    };
}

function readLogs(tmp) {
    return fs.readFileSync(path.join(tmp, 'current.log'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function request(server, pathName = '/', headers = {}) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: pathName, headers }, res => {
            res.resume();
            res.on('end', () => resolve(res));
        });
        req.on('error', reject);
    });
}

test('logger records session id, boot event, and finished response lifecycle', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-logger-lifecycle-'));
    const { logger, restore } = loadLogger(tmp);
    const app = express();
    app.use(logger.requestLogger);
    app.get('/token', (req, res) => {
        logger.info('Handler event', { type: 'HANDLER_EVENT' });
        res.json({ ok: true });
    });
    const server = app.listen(0);

    try {
        logger.logBoot('pcm-core-test');
        await request(server, '/token', { 'x-correlation-id': 'corr-1', 'x-flow-id': 'flow-1' });
        const logs = readLogs(tmp);
        assert.equal(logs[0].details.sessionId, 'test-session');
        const boot = logs.find(log => log.details.type === 'PROCESS_BOOT');
        assert.equal(boot.details.category, 'lifecycle');
        assert.equal(boot.details.visibility, 'diagnostic');
        assert.equal(boot.details.causesSystemFlow, false);
        const response = logs.find(log => log.details.type === 'RESPONSE');
        assert.equal(response.details.lifecycleEvent, 'finish');
        assert.equal(response.details.aborted, false);
        assert.equal(response.details.correlationId, 'corr-1');
        assert.equal(response.details.requestId, 'corr-1');
        assert.equal(response.details.flowId, 'flow-1');
        const handler = logs.find(log => log.details.type === 'HANDLER_EVENT');
        assert.equal(handler.details.category, 'system');
        assert.equal(handler.details.visibility, 'default');
        assert.equal(handler.details.correlationId, 'corr-1');
        assert.equal(handler.details.flowId, 'flow-1');
    } finally {
        await new Promise(resolve => server.close(resolve));
        restore();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('logger records close lifecycle when client aborts before a response', { timeout: 30000 }, async t => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-logger-close-'));
    const { logger, restore } = loadLogger(tmp);
    const app = express();
    app.use(logger.requestLogger);
    const requestReceived = new Promise(resolve => {
        app.get('/token', (req, res) => resolve(res));
    });
    const server = app.listen(0, '127.0.0.1');
    let req;

    try {
        await once(server, 'listening', { signal: t.signal });
        const { port } = server.address();
        req = http.get({ hostname: '127.0.0.1', port, path: '/token' });
        const requestError = once(req, 'error', { signal: t.signal });
        // Abort only after the middleware and route have seen this request.
        // An earlier connection error must fail rather than impersonate an abort.
        const res = await Promise.race([
            requestReceived,
            requestError.then(([error]) => { throw error; })
        ]);
        assert.equal(res.headersSent, false);
        const responseClosed = once(res, 'close', { signal: t.signal });
        const intentionalAbort = new Error('Intentional test client abort');
        req.destroy(intentionalAbort);
        // The logger's close listener is installed before this route's listener.
        await responseClosed;
        assert.equal((await requestError)[0], intentionalAbort);
        const logs = readLogs(tmp);
        assert.equal(logs.filter(log => log.details.type === 'REQUEST').length, 1);
        const responses = logs.filter(log => log.details.type === 'RESPONSE');
        assert.equal(responses.length, 1);
        const [response] = responses;
        assert.equal(response.details.lifecycleEvent, 'close');
        assert.equal(response.details.aborted, true);
    } finally {
        req?.destroy();
        await new Promise(resolve => server.close(resolve));
        restore();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('logger error middleware records route and body-parser failures', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-logger-error-'));
    const { logger, restore } = loadLogger(tmp);
    const app = express();
    app.use(logger.requestLogger);
    app.use(express.json());
    app.post('/token', (req, res) => res.json(req.body));
    app.get('/introspect', () => {
        throw new Error('route exploded');
    });
    app.use(logger.errorLogger);
    const server = app.listen(0);

    try {
        await request(server, '/introspect');
        const { port } = server.address();
        await new Promise(resolve => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/token',
                method: 'POST',
                headers: { 'content-type': 'application/json' }
            }, res => {
                res.resume();
                res.on('end', resolve);
            });
            req.end('{bad-json');
        });
        const errors = readLogs(tmp).filter(log => log.details.type === 'ROUTE_ERROR');
        assert.equal(errors.length, 2);
        assert.ok(errors.some(log => log.details.url === '/introspect'));
        assert.ok(errors.some(log => log.details.url === '/token'));
    } finally {
        await new Promise(resolve => server.close(resolve));
        restore();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('helper imports preserve current logs and explicit startup rotates only once', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-logger-rotation-'));
    fs.writeFileSync(path.join(tmp, 'current.log'), 'previous process\n');
    const beforeHooks = process.listenerCount('uncaughtException');
    const { logger, restore } = loadLogger(tmp);
    try {
        assert.equal(fs.readFileSync(path.join(tmp, 'current.log'), 'utf8'), 'previous process\n');
        assert.equal(fs.existsSync(path.join(tmp, 'history')), false);
        assert.equal(process.listenerCount('uncaughtException'), beforeHooks);
        logger.initialize();
        logger.logBoot('pcm-core-test');
        logger.initialize();
        const history = fs.readdirSync(path.join(tmp, 'history'));
        assert.equal(history.length, 1);
        assert.equal(fs.readFileSync(path.join(tmp, 'history', history[0], 'app.log'), 'utf8'), 'previous process\n');
        assert.equal(readLogs(tmp)[0].details.type, 'PROCESS_BOOT');
    } finally {
        restore();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
