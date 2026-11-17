'use strict';
/** Bounded administrative response outcomes; protocol and native producers stay independent. */

/** Capture missing protected command outcomes without logging request bodies or viewer GETs.
 * @param {object} dependencies Existing logger and current configuration reader.
 * @returns {Function} Express middleware, installed after Admin authentication.
 */
function middleware({ logger, getConfig }) {
    return (req, res, next) => {
        const pathname = req.path; // Express has already removed this Admin mount.
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
            || !/^\/(?:config\/|api\/(?:fhir-servers|data-operations)\/|migration\/checkpoint$|restore$|reset$|certs\/)/.test(pathname)) return next();
        const before = getConfig();
        const correlationId = req.requestId || logger.getCorrelationId();
        const sourceMatch = /^\/config\/data-sources\/([^/]+)(?:\/|$)/.exec(pathname);
        const serverMatch = /^\/(?:config|api)\/fhir-servers\/([^/]+)(?:\/|$)/.exec(pathname);
        const operationMatch = /^\/api\/data-operations\/([^/]+)\//.exec(pathname);
        let result = {}, redirectedSource;
        const scalar = value => typeof value === 'string' ? value.slice(0, 256) : undefined;
        const decoded = value => { try { return scalar(decodeURIComponent(value)); } catch { return undefined; } };
        const originalRedirect = res.redirect.bind(res);
        res.redirect = (...args) => {
            try { redirectedSource = scalar(new URL(args[typeof args[0] === 'number' ? 1 : 0], 'http://admin.invalid').searchParams.get('source')); } catch { /* No contextual redirect. */ }
            return originalRedirect(...args);
        };
        const originalJson = res.json.bind(res);
        res.json = body => { result = body || {}; return originalJson(body); };
        const basePath = require('../../shared/browser-navigation').applicationPath(before.publicBaseUrls.pcmUi).replace(/\/$/, '');
        res.set('x-admin-diagnostics', `${basePath}/logs-view?diagnostics=true&inspection=correlationId&correlationId=${encodeURIComponent(correlationId)}`);
        res.once('finish', () => {
            let config;
            try { config = getConfig(); } catch { config = before; }
            const failed = res.statusCode >= 400;
            logger[failed ? 'warn' : 'info']('ADMIN_COMMAND_OUTCOME', {
                type: 'ADMIN_COMMAND_OUTCOME', category: 'admin', visibility: 'diagnostic', causesSystemFlow: false,
                actor: process.env.TEAM_ADMIN_PASSWORD ? 'team-admin' : 'sandbox-operator', teamId: config.teamId,
                correlationId, operation: pathname, method: req.method, statusCode: res.statusCode,
                sourceId: scalar(result.dataSource?.id || result.sourceId) || redirectedSource || (sourceMatch && !['add', 'remove'].includes(sourceMatch[1]) ? decoded(sourceMatch[1]) : scalar(req.body?.id || req.body?.sourceId)),
                serverId: serverMatch ? decoded(serverMatch[1]) : scalar(result.operation?.serverId || result.serverId),
                operationId: scalar(result.operation?.id || (result.serverId ? result.id : undefined) || result.operationId) || (operationMatch ? decoded(operationMatch[1]) : undefined),
                revision: Number(config.runtime.revision) || 0, previousRevision: Number(before.runtime.revision) || 0,
                outcome: failed ? 'rejected' : res.statusCode === 202 ? 'accepted' : scalar(result.status) || 'completed',
                ...(failed ? { failurePhase: scalar(result.failureStage || result.details?.failureStage) || 'command-response' } : {})
            });
        });
        next();
    };
}
module.exports = { middleware };
