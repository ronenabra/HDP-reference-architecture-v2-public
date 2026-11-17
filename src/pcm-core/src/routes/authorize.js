'use strict';

/** Standalone SMART authorization endpoint and sandbox approval interaction. */

const express = require('express');
const crypto = require('node:crypto');

const { createAuthorizeService } = require('../authorize-service');
const { getConfiguredAuthorizationStore } = require('../authorization-store');
const { getIssuer } = require('../oauth-metadata');
const { createBrowserAwareMtlsMiddleware } = require('../public-mtls');
const { parseForm } = require('../rar-request');
const { findClientById } = require('../store');
const { loadTeamConfig } = require('../team-config');
const { BrowserAuthenticatedIdentityProvider } = require('../sandbox-identity-provider');

function respond(res, result) {
    res.set('Cache-Control', 'no-store');
    if (result.type === 'redirect') return res.redirect(302, result.location);
    if (result.type === 'interaction') {
        return res.status(200).render('authorize', { ...result, permissions: require('../smart-presentation').describeScopes(result.scopes), teamId: loadTeamConfig().teamId || process.env.TEAM_ID || 'local' });
    }
    if (String(res.req?.headers?.accept || '').includes('text/html')) return res.status(result.status).render('authorize-error', {
        teamId: loadTeamConfig().teamId, doctorUrl: loadTeamConfig().publicBaseUrls.spClient,
        message: result.body.error_description, errorCode: result.body.error
    });
    return res.status(result.status).json(result.body);
}

/** Reuse live configuration and the existing private repositories across both browser pages. */
function configuredAuthorizeService(config = loadTeamConfig()) {
    return createAuthorizeService({ findClient: findClientById, store: getConfiguredAuthorizationStore(config),
        identityProvider: new BrowserAuthenticatedIdentityProvider(config.patients, require('../system-flow-store').getSystemFlowStore(config)),
        getFhirAudience: req => getIssuer(req) });
}

/** Build the router with injectable protocol dependencies for deterministic tests. */
function createAuthorizeRouter(options = {}) {
    const router = express.Router();
    const config = options.config || loadTeamConfig();
    const service = options.service || createAuthorizeService({
        findClient: options.findClient || findClientById,
        store: options.store || getConfiguredAuthorizationStore(config),
        identityProvider: options.identityProvider || new BrowserAuthenticatedIdentityProvider(config.patients, require('../system-flow-store').getSystemFlowStore(config)),
        getFhirAudience: options.getFhirAudience || (req => getIssuer(req))
    });
    const getService = () => Object.keys(options).length ? service : configuredAuthorizeService();
    const requireMtls = options.requireMtls || createBrowserAwareMtlsMiddleware();
    router.use('/authorize', (req, res, next) => {
        res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
        if (req.method === 'GET' || req.path === '/authorize') {
            const { cookie, BINDING_COOKIE } = require('../system-browser-session');
            if (!/^[A-Za-z0-9_-]{43}$/.test(cookie(req, BINDING_COOKIE) || '')) {
                const binding = crypto.randomBytes(32).toString('base64url');
                res.cookie(BINDING_COOKIE, binding, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 600000 });
                req.headers.cookie = [...String(req.headers.cookie || '').split(';').filter(part => !part.trim().startsWith(`${BINDING_COOKIE}=`)), `${BINDING_COOKIE}=${binding}`].filter(Boolean).join('; ');
            }
        }
        next();
    });
    router.get('/authorize/resume', requireMtls, (req, res) => {
        if (Object.keys(req.query).some(key => key !== 'transaction_id')) return res.status(400).json({ error: 'invalid_request' });
        return respond(res, getService().resume(req.query.transaction_id, req));
    });

    router.get('/authorize', requireMtls, (req, res) => {
        try {
            const raw = req.originalUrl.split('?').slice(1).join('?');
            return respond(res, getService().start(raw ? parseForm(raw) : {}, req));
        } catch (error) { return res.status(400).json({ error: 'invalid_request', error_description: error.message }); }
    });
    router.post('/authorize', requireMtls, (req, res) => respond(res, getService().start(req.body, req)));
    router.post('/authorize/decision', requireMtls, (req, res) => respond(res, getService().decide(req.body, req)));
    return router;
}

module.exports = { createAuthorizeRouter, respond, configuredAuthorizeService };
