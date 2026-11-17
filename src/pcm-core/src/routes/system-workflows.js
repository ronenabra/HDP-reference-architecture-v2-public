'use strict';

/** PCM-owned local authentication, OTP and dependent discovery browser interaction. */
const express = require('express');
const crypto = require('crypto');
const { loadTeamConfig } = require('../team-config');
const { systemWorkflows } = require('../system-workflow-runtime');
const { getConfiguredDataSources } = require('../data-sources');
const { BINDING_COOKIE, FLOW_COOKIE, cookie, csrf } = require('../system-browser-session');
const logger = require('../logger');
const presentation = require('../workflow-presentation');
const { browserDestination } = require('../../../shared/browser-navigation');
const BASE = '/sandbox/authentication';

/** Inject the same orchestration boundary in HTTP tests without bypassing browser binding. */
function createSystemWorkflowRouter({ loadConfig = loadTeamConfig, runtime = config => systemWorkflows(config, logger), diagnostics = logger, authorize = config => require('./authorize').configuredAuthorizeService(config) } = {}) {
    const router = express.Router();
    router.use(BASE, express.urlencoded({ extended: false, limit: '8kb' }), (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('X-Frame-Options', 'DENY');
        next();
    });
    const setCookie = (req, res, name, value) => res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 600000 });
    const currentFlow = (req, service) => {
        const flow = service.flows.browserFlow(cookie(req, FLOW_COOKIE), cookie(req, BINDING_COOKIE));
        const smart = req.method === 'GET' ? req.query.smart : req.body.smart;
        if (typeof smart === 'string' && flow.smartRequestId !== smart) throw new Error('Another tab owns the current test sign-in. Return to your SMART request or start sign-in again.');
        return flow;
    };

    /** Clear selection before any await and bind publication to this refresh generation. */
    function beginRefresh(service, flow) {
        if (flow.phase !== 'authenticated') throw new Error('Authentication required');
        delete flow.selectedPatient;
        const generation = flow.refreshGeneration = (flow.refreshGeneration || 0) + 1;
        return () => {
            if (!service.flows.isCurrent(flow) || flow.phase !== 'authenticated' || flow.refreshGeneration !== generation) {
                throw new Error('Workflow refresh superseded');
            }
        };
    }

    /** Resolve the actual listener's declared path prefix while keeping cross-listener navigation absolute. */
    function paths(req, config) {
        const surface = req.app.locals.browserSurface || (req.secure ? 'pcmApi' : 'pcmUi');
        const own = new URL(browserDestination(config.publicBaseUrls[surface], req));
        const suffix = require('../../../shared/pcm-environment').PCM_PATH;
        const prefix = surface === 'pcmApi' && own.pathname.endsWith(suffix) ? own.pathname.slice(0, -suffix.length) : own.pathname.replace(/\/+$/, '');
        const ui = browserDestination(config.publicBaseUrls.pcmUi, req);
        const smart = req.method === 'GET' ? req.query.smart : req.body.smart;
        const continuation = typeof smart === 'string' ? `?smart=${encodeURIComponent(smart)}` : '';
        return { base: `${prefix}${BASE}`, canonical: `${prefix}${BASE}${continuation}`, smart,
            resumeUrl: `${prefix}${require('../../../shared/pcm-environment').PCM_PATH}/authorize/resume?transaction_id=${encodeURIComponent(smart || '')}`,  assetBase: prefix, doctorUrl: browserDestination(config.publicBaseUrls.spClient, req),
            consentUrl: `${ui}/ui`, logsUrl: `${ui}/logs-view`, adminUrl: `${ui}/admin` };
    }

    /** Render only browser-owned input/feedback and the state its current verified flow permits. */
    function render(req, res) {
        const config = loadConfig(), service = runtime(config);
        let binding = cookie(req, BINDING_COOKIE);
        if (!binding || !/^[A-Za-z0-9_-]{43}$/.test(binding)) {
            binding = crypto.randomBytes(32).toString('base64url'); setCookie(req, res, BINDING_COOKIE, binding);
        }
        const feedback = service.flows.feedback(binding);
        let flow, anotherTab = false;
        try { flow = currentFlow(req, service); } catch (error) {
            flow = null; anotherTab = error.message.startsWith('Another tab');
            if (anotherTab) feedback.notice = { message: error.message };
        }
        if (!flow && !anotherTab && cookie(req, FLOW_COOKIE)) {
            res.clearCookie(FLOW_COOKIE, { path: '/' });
            feedback.showCodeFor = null;
            feedback.notice ||= { message: 'This test sign-in expired or became unavailable. Choose a patient and start again.' };
        }
        const verified = flow?.phase === 'authenticated';
        const configured = getConfiguredDataSources(config);
        const sourceLabels = new Map(configured.map(source => [source.id, source.compatibilityOnly ? `${source.name} (legacy Node compatibility)` : source.name]));
        const hmos = require('../hmo-sources').hmoSources(config, service.store, { includeUnavailable: true });
        const available = new Set(require('../hmo-sources').hmoSources(config, service.store).map(source => source.id));
        const authPolicy = service.store?.getAll('Contract').filter(contract => require('../fhir/system-policy').scenarioOf(contract) === 'patient-authentication');
        const choices = hmos.map(source => ({ id: source.id, name: source.name, available: available.has(source.id) && (!service.store || authPolicy?.some(contract =>
            require('../fhir/system-policy').evaluatePolicy({ store: service.store, config, identifier: contract.identifier[0], clientId: config.oauthClients.authenticationOrchestrator.clientId, targetOrganizationId: source.id, now: service.clock() }))) }));
        const now = service.clock(), otp = config.systemAuthorization.otp;
        const currentCode = feedback.showCodeFor === flow?.id && flow?.phase === 'authenticating' ? service.transport.inspect?.(flow.id)?.code : null;
        return res.render('system-authentication', {
            ...paths(req, config), teamId: config.teamId, csrfToken: csrf(binding), notice: feedback.notice,
            input: { system: presentation.identifierTypes()[0].value, identifier: '', birthDate: '', homeHmoId: '', ...feedback.input },
            identifierTypes: presentation.identifierTypes(), patientChoices: presentation.configuredChoices(config), hmoChoices: choices,
            canStart: choices.some(choice => choice.available), sourceLabels, localCode: currentCode, now, time: presentation.time,
            otp: flow?.phase === 'authenticating' ? { expiresAt: flow.otpExpiresAt, resendAt: flow.lastSent + otp.resendSeconds,
                attemptsRemaining: Math.max(0, otp.maxAttempts - flow.attempts), resendsRemaining: Math.max(0, otp.maxResends - flow.resends) } : null,
            ssoChoices: service.identityProvider?.listChoices() || [], fixtureChoices: config.systemAuthorization.memberships.filter(member => member.sandboxFixture === true),
            authenticationMethod: flow?.syntheticFixture ? 'HTEST fixture simulation — no person login' : flow?.authenticationMethod || 'Selected HMO and local verification code',
            stage: flow?.phase || 'start', environment: config.contract.environment,
            homeHmo: flow ? sourceLabels.get(flow.homeHmoId) || flow.homeHmoId : null,
            verified: verified ? { identifier: flow.identifier, name: flow.patient.name || [], expiresAt: flow.expiresAt } : null,
            discovery: verified ? flow.discovery || null : null, selected: verified ? flow.selectedPatient || null : null,
            presence: verified ? flow.presence || null : null
        });
    }
    router.use(BASE, (req, res, next) => {
        const input = req.method === 'GET' ? req.query : req.body;
        if (Object.keys(input || {}).some(key => /return|redirect/i.test(key))) return res.status(400).send('External return destinations are not supported. Restart from Doctor.');
        if (input?.smart !== undefined && (typeof input.smart !== 'string' || !authorize(loadConfig()).canResume(input.smart, req))) {
            return res.status(400).send('This pending SMART request expired, changed, or belongs to another browser. Restart from Doctor.');
        }
        next();
    });
    router.get(BASE, (req, res) => render(req, res));
    router.post(`${BASE}/:action`, async (req, res) => {
        const binding = cookie(req, BINDING_COOKIE);
        if (!binding || typeof req.body.csrf !== 'string' || req.body.csrf !== csrf(binding)) {
            if (binding && /^[A-Za-z0-9_-]{43}$/.test(binding)) runtime(loadConfig()).flows.feedback(binding).notice = { message: 'Browser interaction expired. Reload this page and try again.' };
            return res.redirect(303, paths(req, loadConfig()).canonical);
        }
        const config = loadConfig();
        const service = runtime(config);
        const feedback = service.flows.feedback(binding), generation = ++feedback.generation;
        feedback.notice = null; feedback.showCodeFor = null;
        const traceId = diagnostics.getTraceContext?.()?.traceId || crypto.randomBytes(16).toString('hex');
        let flowId, current, fieldError;
        try {
            const action = req.params.action;
            if (['start', 'local-sso', 'fixture-start'].includes(action)) {
                try { service.flows.cancel(currentFlow(req, service).id); } catch (_) { /* no previous owned flow */ }
                if (action === 'start') {
                    feedback.input = presentation.formInput(req.body);
                    fieldError = presentation.validateForm(feedback.input);
                    if (!feedback.input.homeHmoId) fieldError = { field: 'homeHmoId', message: 'Choose an available registered HMO for this test.' };
                    if (fieldError) throw new Error('Invalid sign-in input');
                }
                const result = action === 'local-sso' ? service.authenticateSso(req.body.subject, binding)
                    : action === 'fixture-start' ? await service.authenticateFixture(req.body.subject, binding)
                    : await service.authenticate({ browserBinding: binding, birthDate: feedback.input.birthDate, homeHmoId: feedback.input.homeHmoId,
                        identifier: { system: feedback.input.system, value: feedback.input.identifier } });
                flowId = result.flowId;
                service.flows.browserFlow(flowId, binding).smartRequestId = typeof req.body.smart === 'string' ? req.body.smart : null;
                if (feedback.generation !== generation) { service.flows.cancel(flowId); return res.redirect(303, paths(req, config).canonical); }
                setCookie(req, res, FLOW_COOKIE, result.flowId);
            } else {
                const flow = currentFlow(req, service); current = flow;
                flowId = flow.id;
                if (action === 'verify') service.verify(flow.id, binding, req.body.code);
                else if (action === 'resend') await service.resend(flow.id, binding);
                else if (action === 'cancel') {
                    service.transport.clear?.(flow.id);
                    service.flows.cancel(flow.id);
                    res.clearCookie(FLOW_COOKIE, { path: '/' });
                } else if (action === 'local-code') {
                    if (flow.phase !== 'authenticating') throw new Error('No pending OTP');
                    const delivery = service.transport.inspect?.(flow.id);
                    if (!delivery || delivery.expiresAt <= service.clock()) throw new Error('No current local delivery');
                    feedback.showCodeFor = flow.id;
                } else if (action === 'discover') {
                    const current = beginRefresh(service, flow);
                    const discovery = await service.discover(flow.id, binding);
                    current();
                    flow.discovery = discovery;
                } else if (action === 'presence' || action === 'presence-dependents') {
                    if (flow.phase !== 'authenticated') throw new Error('Authentication required');
                    const patients = [flow.identifier];
                    let current = () => {
                        if (!service.flows.isCurrent(flow)) throw new Error('Workflow unavailable');
                    };
                    if (action === 'presence-dependents') {
                        current = beginRefresh(service, flow);
                        const discovery = await service.discover(flow.id, binding);
                        current();
                        flow.discovery = discovery;
                        patients.push(...flow.discovery.dependents.map(dependent => dependent.identifier));
                    }
                    const previous = Object.fromEntries((flow.presence?.results || []).map(result => [
                        `${result.sourceId}|${result.identifier.system}|${result.identifier.value}`,
                        result.state === 'unknown' ? result.previouslyKnown : { state: result.state, checkedAt: result.checkedAt }
                    ]));
                    const presence = await service.presence(patients, previous);
                    current();
                    flow.presence = presence;
                } else if (action === 'select') {
                    if (flow.phase !== 'authenticated') throw new Error('Authentication required');
                    // Refresh every source before accepting a selection; stale displayed relationships cannot authorize it.
                    const current = beginRefresh(service, flow);
                    const discovery = await service.discover(flow.id, binding);
                    current();
                    flow.discovery = discovery;
                    const match = flow.discovery.dependents.find(dependent => `${dependent.identifier.system}|${dependent.identifier.value}` === req.body.patient);
                    if (!match) throw new Error('Relationship is no longer eligible');
                    flow.selectedPatient = structuredClone(match.identifier);
                } else throw new Error('Unknown action');
            }
            if (feedback.generation !== generation) return res.redirect(303, paths(req, config).canonical);
            diagnostics.info('System browser action completed', { type: 'SYSTEM_BROWSER_ACTION', flowId, traceId,
                action: req.params.action, state: 'complete', environment: config.contract.environment });
            return res.redirect(303, paths(req, config).canonical);
        } catch (error) {
            diagnostics.info('System browser action denied', { type: 'SYSTEM_BROWSER_ACTION', flowId, traceId,
                action: req.params.action, state: 'denied', environment: config.contract.environment, reason: error.message });
            if (feedback.generation === generation) feedback.notice = { ...(error.message.startsWith('Another tab') ? { message: error.message } : presentation.failure(req.params.action, current, config, service.clock(), fieldError)), traceId };
            return res.redirect(303, paths(req, config).canonical);
        }
    });
    return router;
}
module.exports = { BASE, createSystemWorkflowRouter };
