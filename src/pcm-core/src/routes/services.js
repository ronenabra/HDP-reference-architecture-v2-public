'use strict';
/** Consent-app service administration: ordinary provider APIs plus labelled private simulations. */
const express = require('express');
const { providerManagementClient } = require('../provider-management-client');
const { existingRegistration, UNITS } = require('../service-definition-form');
const command = require('../sandbox-service-command');
const lifecycle = require('../fhir/healthcare-service-lifecycle');
const { CATEGORY_LABELS } = require('../../../shared/consent-presentation');
const { BUCKET_RESOURCES } = require('../../../shared/clinical-resource-mapping');
const { SENSITIVITY_LABELS } = require('../../../shared/information-buckets');
const { loadTemplates, addTemplate } = require('../service-templates');
const { previewDefinition } = require('../service-scope-authoring');
const crypto = require('node:crypto');
/** Bind exact draft content and authoring clock without a preview persistence service. */
const previewSignature = (role, definition, anchor) => command.csrf(role, 'service-preview:' + crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex'), anchor);
const model = require('../services-admin-model');
/** Verify a generated review's exact draft and fixed clock; manual text needs no proof. */
function reviewedClock(proof, role, definition) {
    const now = Date.parse(proof?.anchor) / 1000;
    if (!proof || Object.keys(proof).sort().join(',') !== 'anchor,signature' || !Number.isSafeInteger(now) || now > Date.now() / 1000 || now < Date.now() / 1000 - 900
        || proof.signature !== previewSignature(role, definition, proof.anchor)) throw Object.assign(new Error('The reviewed scope preview expired or the draft changed. Regenerate before creating; your draft is retained.'), { status: 409 });
    return now;
}


/** Build an Admin-mounted router with injectable ordinary transport for owned integration tests. */
function servicesRouter({ store, getConfig, tokenStore, audit, clientFactory = providerManagementClient, templateLoader = loadTemplates }) {
    const router = express.Router();
    // Existing Admin middleware can be intentionally open in some installations;
    // these credentialed and private service operations always require a configured login.
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        return process.env.TEAM_ADMIN_PASSWORD ? next() : res.status(503).send('Services requires a configured Admin login. Ask the sandbox administrator to configure it.');
    });
    /** Resolve configured bindings only for identities present in the actual provider registry. */
    function providerRoles(config) {
        return Object.keys(config.organizations).filter(key => require('../fhir/participant-lifecycle').organizationRole(store.get('Organization', config.organizations[key]?.id)) === 'service-provider');
    }
    function providerRole(config, value = 'serviceProvider') {
        if (!providerRoles(config).includes(value)) throw Object.assign(new Error('Choose a registered service provider with a configured credential binding.'), { status: 400 });
        return value;
    }
    /** Protected owner inventory is separate from caller-scoped public discovery. */
    router.get('/inventory', (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(model.catalogInventory({ store, config: getConfig(), query: req.query })); }
        catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    });
    router.get('/providers', (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(model.providerInventory({ store, config: getConfig(), query: req.query })); }
        catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    });
    router.get('/inventory/:id/providers', (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(model.providerInventory({ store, config: getConfig(), catalogId: req.params.id, query: req.query })); }
        catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    });
    router.post('/catalog', (req, res) => {
        try {
            const body = req.body;
            if (!body || !['csrf,definition,expectedRevision', 'csrf,definition,expectedRevision,previewProof'].includes(Object.keys(body).sort().join(',')) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || Buffer.byteLength(JSON.stringify(body)) > 32768) throw Object.assign(new Error('Use the bounded current catalog creation form.'), { status: 400 });
            command.assertCommand(req, { id: 'catalog-create', version: String(body.expectedRevision) });
            res.json(model.createCatalog({ store, config: getConfig(), definition: body.definition, expectedRevision: body.expectedRevision, operator: 'team-admin', audit, now: body.previewProof === undefined ? undefined : reviewedClock(body.previewProof, '', body.definition) }));
        } catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    });
    router.post('/catalog/:id/validate', (req, res) => {
        try {
            const body = req.body;
            if (!body || Object.keys(body).sort().join(',') !== 'csrf,expectedVersion' || typeof body.expectedVersion !== 'string' || !/^[1-9]\d*$/.test(body.expectedVersion)) throw Object.assign(new Error('Use the displayed version-bound validation form.'), { status: 400 });
            command.assertCommand(req, { id: req.params.id, version: body.expectedVersion });
            if (getConfig().conformance.preset === 'strict') throw Object.assign(new Error('Private sandbox actions are unavailable in strict mode.'), { status: 403 });
            const result = model.validateCatalog({ store, id: req.params.id, expectedVersion: body.expectedVersion });
            audit({ visibility: 'diagnostic', component: 'pcm-services', operation: 'admin-catalog-validate', operator: 'team-admin', target: `HealthcareService/${req.params.id}`, outcome: 'validated' });
            res.set('Cache-Control', 'no-store').json(result);
        } catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    });
    router.get('/', async (req, res) => {
        const config = getConfig();
        const selectedView = req.query.view === 'assignments' ? 'assignments' : 'catalog';
        let role, doctorProviderRole = '', catalogError = '', warnings = [], catalog;
        try {
            if (Object.keys(req.query).some(key => !['providerRole', 'target', 'view', 'offset', 'revision', 'group', 'providerOffset', 'providerRevision'].includes(key)) || req.query.view !== undefined && !['catalog', 'assignments'].includes(req.query.view)) throw Object.assign(new Error('Choose Service catalog or Provider assignments and its displayed page.'), { status: 400 });
            if (req.query.providerRole !== undefined) doctorProviderRole = providerRole(config, req.query.providerRole);
            const query = Object.fromEntries(['offset', 'revision'].filter(key => req.query[key] !== undefined).map(key => [key, req.query[key]]));
            if (req.query.target && query.offset === undefined) {
                const target = store.get('HealthcareService', req.query.target);
                const id = lifecycle.basedOnId(target) || target?.id;
                const ids = store.getAll('HealthcareService').filter(item => lifecycle.serviceKind(item) === 'catalog').map(item => item.id).sort((a, b) => a.localeCompare(b));
                const index = ids.indexOf(id);
                if (index >= 25) { query.offset = String(Math.floor(index / 25) * 25); query.revision = String(store.privateState.revision); }
            }
            if ((req.query.providerOffset !== undefined || req.query.providerRevision !== undefined) && !req.query.group
                || req.query.group !== undefined && (typeof req.query.group !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(req.query.group))) throw Object.assign(new Error('Choose the named service group and its displayed provider page.'), { status: 400 });
            catalog = model.catalogInventory({ store, config, query });
            catalog.items = catalog.items.map(require('../services-catalog-presentation').catalogRow);
            if (req.query.group && !catalog.items.some(item => item.id === req.query.group)) throw Object.assign(new Error('The named service group is not on this catalog page. Refresh its exact service context.'), { status: 400 });
            audit({ visibility: 'diagnostic', component: 'pcm-services', operation: 'read-admin-catalog', outcome: 'recorded', revision: catalog.revision });
        } catch (failure) { catalogError = failure.message; if ([400, 409].includes(failure.status)) res.status(failure.status); }
        // Assignments are a protected service-paged inventory, never a selected-provider search.
        // Each named group has an independently bounded provider page from the same revision.
        const groups = [];
        if (selectedView === 'assignments' && catalog) {
            for (const service of catalog.items) {
                try {
                    const query = req.query.group === service.id
                        ? Object.fromEntries([['offset', req.query.providerOffset], ['revision', req.query.providerRevision]].filter(([, value]) => value !== undefined)) : {};
                    // Exact registration links and post-action inspection locate the owner's actual page.
                    if (!req.query.group && req.query.target) {
                        const target = store.get('HealthcareService', req.query.target);
                        if (lifecycle.basedOnId(target) === service.id) {
                            const ids = new Set(model.providers({ store, config }).map(provider => provider.id));
                            for (const registration of store.getAll('HealthcareService').filter(item => lifecycle.basedOnId(item) === service.id)) ids.add(lifecycle.ownerId(registration));
                            const index = [...ids].sort((a, b) => a.localeCompare(b)).indexOf(lifecycle.ownerId(target));
                            if (index >= 25) { query.offset = String(Math.floor(index / 25) * 25); query.revision = String(store.privateState.revision); }
                        }
                    }
                    groups.push({ service, providers: model.providerInventory({ store, config, catalogId: service.id, query }) });
                } catch (failure) {
                    groups.push({ service, error: failure.message });
                    if ([400, 409].includes(failure.status)) res.status(failure.status);
                }
            }
        }
        role = providerRoles(config).find(key => config.organizations[key]?.id) || 'serviceProvider';
        let templates = [];
        try { templates = templateLoader(); } catch (failure) { warnings.push(`Service templates are unavailable: ${failure.message} Ask the operator to repair config/service-templates.json; manual service creation remains available.`); }
        const doctorBase = require('../../../shared/browser-navigation').browserNavigation(config.publicBaseUrls, req, 'pcmUi').spClient;
        // Return navigation retains the originating Doctor only; inventory and command roles remain independent.
        const doctorIdentity = { serviceProvider: 'hospital-a', hospitalBServiceProvider: 'hospital-b' }[doctorProviderRole || role];
        const doctorReturnUrl = doctorIdentity ? `${doctorBase.replace(/\/$/, '')}/?identity=${doctorIdentity}` : doctorBase;
        res.render('services', { teamId: config.teamId, role, doctorReturnUrl, doctorProviderRole,
            selectedView, catalog, catalogError, groups, templates, warnings,
            privateActionsUnavailable: config.conformance.preset === 'strict', formCsrf: command.csrf(role), ownerCsrf: command.csrf,
            catalogCreation: { revision: store.privateState.revision, creation: { csrf: command.csrf('', 'catalog-create', String(store.privateState.revision)) } }, categoryLabels: CATEGORY_LABELS, bucketResources: BUCKET_RESOURCES, units: UNITS, sensitivityLabels: SENSITIVITY_LABELS });
    });
    /** Validate a closed ordinary form before obtaining the selected identity's own credentials. */
    function ordinary(action) {
        return async (req, res) => {
            try {
                const config = getConfig(), body = req.body;
                const allowed = action === 'template' ? ['providerRole', 'csrf', 'templateKey'] : action === 'create' ? ['providerRole', 'csrf', 'definition', 'templateKey', 'previewProof'] : ['providerRole', 'csrf', 'catalogId'];
                if (!body || Object.keys(body).some(key => !allowed.includes(key))) throw Object.assign(new Error('Use the service form fields.'), { status: 400 });
                const role = providerRole(config, body.providerRole);
                command.assertCommand(req, { providerRole: role });
                const template = action === 'template' ? templateLoader().find(item => item.key === body.templateKey) : null;
                if (action === 'template' && !template) throw Object.assign(new Error('Choose a currently configured service template.'), { status: 400 });
                if (action === 'create' && body.templateKey !== undefined) {
                    if (typeof body.templateKey !== 'string' || !templateLoader().some(item => item.key === body.templateKey)) throw Object.assign(new Error('This template is no longer available. Refresh the picker or use New service; your edited draft is retained.'), { status: 400 });
                }
                let now;
                if (action === 'create' && body.previewProof !== undefined) {
                    const proof = body.previewProof;
                    now = Date.parse(proof?.anchor) / 1000;
                    if (!proof || Object.keys(proof).sort().join(',') !== 'anchor,signature' || !Number.isSafeInteger(now) || now > Date.now() / 1000 || now < Date.now() / 1000 - 900
                        || proof.signature !== previewSignature(role, body.definition, proof.anchor)) throw Object.assign(new Error('The reviewed scope preview expired or the draft changed. Recalculate the preview before creating; your draft is retained.'), { status: 409 });
                }
                const authored = action === 'create' ? require('../service-definition-form').serviceDefinitionCommand(body.definition, { now }) : null;
                const request = action === 'template' ? template.request : authored ? authored.resource : existingRegistration(body.catalogId);
                if (!model.providerBinding({ store, config, providerId: config.organizations[role].id }).available) throw Object.assign(new Error('This provider’s exact credentials are unavailable.'), { status: 503 });
                const client = await clientFactory({ config, providerRole: role, tokenStore, store });
                const owner = { getDefinition: id => store.privateRecords.services.getDefinition(id),
                    register: (publicRequest, privateDefinition) => lifecycle.registerHealthcareService({ store, callerOrganization: store.get('Organization', config.organizations[role].id),
                        request: publicRequest, privateDefinition }).instance };
                const addition = template || authored ? await addTemplate(client, template || { request, privateDefinition: authored.definition }, config.organizations[role].id, owner) : { service: await client.register(request), alreadyAdded: false };
                const result = addition.service;
                if (result.resourceType !== 'HealthcareService' || lifecycle.ownerId(result) !== config.organizations[role].id) throw new Error('PCM returned an unexpected provider registration. Refresh Services to inspect the actual result before retrying.');
                audit({ operator: 'team-admin', visibility: 'diagnostic', component: 'pcm-services', operation: `service-owner-${action}`, providerRole: role, provider: config.organizations[role].id,
                    target: `HealthcareService/${result.id}`, state: lifecycle.businessStatus(result) });
                res.json({ id: result.id, reviewTarget: result.id, state: lifecycle.businessStatus(result), alreadyAdded: addition.alreadyAdded, serviceGrant: store.privateRecords.services.getDefinition(result.id).grant || null,
                    ...((template || action === 'create') ? { businessIdentifier: result.identifier?.find(item => item.use === 'official'), reference: `HealthcareService/${result.id}`,
                        canonicalReference: `HealthcareService/${lifecycle.basedOnId(result)}` } : {}),
                    message: `${addition.alreadyAdded ? (template ? 'Already added' : 'Already registered') : template ? 'Added' : action === 'create' ? 'Created' : 'Assigned'} — ${lifecycle.businessStatus(result) === 'pending' ? 'waiting for activation' : lifecycle.businessStatus(result)}. ${addition.alreadyAdded ? 'No stored service was changed.' : 'PCM saved the provider registration and private definition together.'}` });
            } catch (error) { res.status(error.status || 503).json({ error: error.message }); }
        };
    }
    /** Bounded authenticated draft calculation: no transport, resource, token or patient lookup. */
    router.post('/preview', (req, res) => {
        try {
            const body = req.body;
            if (!body || !['csrf,definition', 'csrf,definition,providerRole'].includes(Object.keys(body).sort().join(',')) || Buffer.byteLength(JSON.stringify(body)) > 32768) throw Object.assign(new Error('Preview requires only the bounded service form (maximum 32768 bytes).'), { status: 400 });
            const config = getConfig(), role = body.providerRole === undefined ? '' : providerRole(config, body.providerRole);
            if (body.providerRole === undefined) command.assertCommand(req, { id: 'catalog-preview' });
            else command.assertCommand(req, { providerRole: role });
            const request = require('../service-definition-form').serviceDefinitionDraft(body.definition);
            const preview = previewDefinition(request);
            audit({ visibility: 'diagnostic', component: 'pcm-services', operation: 'preview-private-definition', outcome: 'calculated' });
            res.set('Cache-Control', 'no-store').json({ ...preview, previewProof: { anchor: preview.calculatedAt, signature: previewSignature(role, body.definition, preview.calculatedAt) } });
        } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
    });
    router.post('/templates', ordinary('template'));
    router.post('/create', ordinary('create'));
    router.post('/assign', ordinary('assign'));
    /** Re-read through ordinary credentials before requesting one closed owner transition. */
    router.post('/:id/status', async (req, res) => {
        try {
            const config = getConfig(), body = req.body, id = req.params.id;
            if (!body || Object.keys(body).length !== 5 || !['providerRole', 'csrf', 'expectedVersion', 'expectedState', 'state'].every(key => typeof body[key] === 'string')
                || !/^[A-Za-z0-9.-]{1,64}$/.test(id) || !/^[1-9]\d*$/.test(body.expectedVersion)
                || !['active', 'suspended', 'cancelled'].includes(body.state)) throw Object.assign(new Error('Use the displayed registration action.'), { status: 400 });
            const role = providerRole(config, body.providerRole);
            command.assertCommand(req, { providerRole: role, id, version: body.expectedVersion });
            const client = await clientFactory({ config, providerRole: role, tokenStore, store });
            const current = await client.read(id);
            if (current.id !== id || lifecycle.serviceKind(current) !== 'instance' || lifecycle.ownerId(current) !== config.organizations[role].id) throw Object.assign(new Error('Only this provider’s exact registration can be managed.'), { status: 403 });
            const state = lifecycle.businessStatus(current);
            if (current.meta?.versionId !== body.expectedVersion || state !== body.expectedState) throw Object.assign(new Error('This registration changed. Refresh and inspect its actual state before retrying.'), { status: 409 });
            const transitions = { pending: ['cancelled'], active: ['suspended'], suspended: ['active', 'cancelled'], cancelled: [] };
            if (!transitions[state] || (state !== body.state && !transitions[state].includes(body.state))) throw Object.assign(new Error('This owner transition is unavailable. Active registrations must first be suspended and inspected.'), { status: 409 });
            // The public API independently revalidates authenticated ownership and its current transition atomically.
            const result = await client.status(id, body.state);
            if (result.id !== id || lifecycle.serviceKind(result) !== 'instance' || lifecycle.ownerId(result) !== config.organizations[role].id || lifecycle.businessStatus(result) !== body.state) throw new Error('Unexpected result. Refresh and inspect this registration before retrying.');
            audit({ operator: 'team-admin', operation: 'regular-service-status', providerRole: role, provider: config.organizations[role].id, target: `HealthcareService/${id}`, state: body.state });
            res.json({ id, state: body.state, message: `Registration ${body.state}. Refresh Services to inspect the current result. Existing identifiers and history are retained. Fresh tokens are required after restoration; cached decisions may last up to 30 seconds.` });
        } catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    });
    router.post('/:id/sandbox', (req, res) => {
        try {
            const body = req.body;
            if (!body || Object.keys(body).length !== 3 || !['activate', 'enable', 'disable', 'delete'].includes(body.action) || !['csrf', 'action', 'expectedVersion'].every(key => typeof body[key] === 'string') || !/^[1-9]\d*$/.test(body.expectedVersion)) throw Object.assign(new Error('Use the displayed version-bound sandbox action.'), { status: 400 });
            command.assertCommand(req, { id: req.params.id, version: body.expectedVersion });
            res.json(command.applyServiceCommand({ store, config: getConfig(), id: req.params.id, action: body.action, expectedVersion: body.expectedVersion,
                operator: 'team-admin', audit }));
        } catch (error) {
            // Failure evidence is separate from the transactional success event.
            audit({ operator: 'team-admin', operation: 'sandbox-service-failure', target: req.params.id, action: req.body?.action, result: error.status || 503 });
            res.status(error.status || 503).json({ error: error.message });
        }
    });
    return router;
}
module.exports = { servicesRouter };
