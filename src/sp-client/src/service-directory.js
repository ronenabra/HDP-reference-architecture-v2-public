'use strict';
/** Bounded ordinary HealthcareService discovery. No private PCM state or inferred authority. */
const { EXTENSIONS, CODE_SYSTEMS, PROFILES } = require('../../shared/pcm-contract');
const { servicePermissions } = require('./permission-plan');
const { createHash } = require('node:crypto');
const ID = /^[A-Za-z0-9.-]{1,64}$/;
const LIMITS = Object.freeze({ pages: 20, requests: 100, bytes: 2 * 1024 * 1024, milliseconds: 15000, entries: 50 });

/** Map only registered provider choices; diagnostics never inherit the primary provider. */
function providerRole(identity) {
    return ({ 'hospital-a': 'serviceProvider', 'hospital-b': 'hospitalBServiceProvider' })[identity] || null;
}
/** Read the public lifecycle coding without interpreting an active flag as a complete decision. */
function serviceStatus(resource) {
    const values = (resource?.extension || []).filter(value => value.url === EXTENSIONS.serviceBusinessStatus);
    return values.length === 1 && values[0].valueCoding?.system === CODE_SYSTEMS.serviceBusinessStatus ? values[0].valueCoding.code : 'unknown';
}
/** Retain exactly one local canonical reference; catalog and foreign IDs are never picker choices. */
function definitionId(service) {
    const values = (service?.extension || []).filter(value => value.url === EXTENSIONS.basedOnCanonicalHealthcareService);
    const match = values.length === 1 && /^HealthcareService\/([A-Za-z0-9.-]{1,64})$/.exec(values[0].valueReference?.reference || '');
    return match ? match[1] : null;
}
/** Capture only documented public facts that can change Doctor request/context behavior.
 * @param {object|null} resource Public service resource.
 * @returns {object|null} Known public fields for stale-state signatures, without private payloads.
 */
function publicServiceFacts(resource) {
    if (!resource) return null;
    const urls = new Set([EXTENSIONS.serviceBusinessStatus, EXTENSIONS.basedOnCanonicalHealthcareService, EXTENSIONS.accessMode,
        EXTENSIONS.accessDuration, EXTENSIONS.allowPatientBucketChange, EXTENSIONS.informationBucket, EXTENSIONS.exampleQuery]);
    return { id: resource.id, identifier: resource.identifier, active: resource.active, providedBy: resource.providedBy,
        version: resource.meta?.versionId, profile: resource.meta?.profile, name: resource.name, purpose: resource.extraDetails,
        category: resource.category, type: resource.type, extension: resource.extension?.filter(value => urls.has(value.url)) };
}
/** Describe public service settings without reconstructing an individual grant.
 * @param {object} service Owned public registration and its readable definition.
 * @returns {object} Plain text facts for the one selected-service summary.
 */
function serviceSummary(service) {
    const missing = 'Not provided by PCM', definition = service.definition;
    const permissions = service.permissions || servicePermissions(definition);
    const labels = { laboratoryTests: 'Laboratory tests', medications: 'Medications', encounterInformation: 'Encounters', encounters: 'Encounters',
        diagnoses: 'Diagnoses', conditions: 'Conditions', procedures: 'Procedures', allergies: 'Allergies and intolerances',
        allergiesAndIntolerances: 'Allergies and intolerances', immunizations: 'Immunizations' };
    const category = code => code === 'Unavailable' ? missing : labels[code] || code;
    const present = text => {
        if (!text || text === 'Unavailable') return missing;
        // Public Duration values often supply only a UCUM code; display it without converting its period.
        const match = /^(\d+(?:\.\d+)?) (a|mo|wk|d|h|min|s)$/.exec(text);
        const units = { a: 'year', mo: 'month', wk: 'week', d: 'day', h: 'hour', min: 'minute', s: 'second' };
        return match ? `${match[1]} ${units[match[2]]}${Number(match[1]) === 1 ? '' : 's'}` : text;
    };
    const sensitivity = permissions.buckets.flatMap(bucket => bucket.sensitivity.flatMap(part =>
        (part.valueCodeableConcept?.coding || []).map(coding => `${category(bucket.code)}: ${coding.system}|${coding.code}`)));
    const purpose = definition?.extraDetails || service.instance?.extraDetails || service.purpose || missing;
    return {
        name: service.name,
        purpose: purpose.length > 240 ? purpose.slice(0, 240) + '… (full purpose in Service details)' : purpose,
        fullPurpose: purpose,
        data: permissions.categories.length ? permissions.categories.map(category).join(', ') + ' — service categories' : missing,
        history: permissions.buckets.length ? permissions.buckets.map(bucket => `${category(bucket.code)}: ${present(bucket.history)}`).join('; ') + ' — service settings, not granted record dates' : missing,
        duration: present(permissions.duration) + (permissions.duration !== 'Unavailable' ? ' — service maximum; approval may be shorter' : ''),
        access: permissions.access === 'continuous' ? 'Ongoing — service setting; PCM approval may narrow this to one-time'
            : permissions.access === 'one-time' ? 'One-time — one hour per approved source, starting with its first qualifying access check; issuing a token does not start the hour' : missing,
        restrictions: 'Record cutoffs and exclusions of Restricted (R), Very Restricted (V) or sensitive records: ' + missing + ' before a token grant.',
        sensitivity: sensitivity.length ? 'Public sensitive-data settings: ' + sensitivity.join('; ') + '. These settings are not granted permissions.' : missing,
        registration: `HealthcareService/${service.id}`,
        definition: service.definitionReference || missing,
        identifiers: [service.instance, definition].flatMap(resource => (resource?.identifier || []).map(identifier => `${identifier.system || missing}|${identifier.value || missing}`)).join('; ') || missing,
        versions: `Registration: ${service.instanceVersion || missing}; definition: ${service.definitionVersion || missing}`,
        patientChanges: typeof permissions.patientChanges === 'boolean' ? (permissions.patientChanges ? 'Allowed by service setting; actual decision belongs to PCM' : 'Not allowed by service setting') : missing,
        intent: permissions.ceiling || missing,
        grant: 'Granted permissions not yet obtained',
        readiness: service.readiness
    };
}
/** Project visible owned registrations with canonical/version provenance, keeping permission planning unchanged. */
function projectOwnedServices(bundle, providerId, provider = null) {
    const resources = (bundle?.entry || []).map(entry => entry.resource).filter(Boolean);
    const definitions = new Map(resources.filter(resource => resource.meta?.profile?.includes(PROFILES.healthcareServiceCanonical)).map(resource => [resource.id, resource]));
    return resources.filter(service => service.resourceType === 'HealthcareService' && ID.test(service.id || '')
        && service.meta?.profile?.includes(PROFILES.healthcareServiceInstance)
        && service.providedBy?.reference === `Organization/${providerId}` && definitionId(service)).map(service => {
        const canonicalId = definitionId(service), definition = definitions.get(canonicalId);
        const state = serviceStatus(service), definitionState = definition ? serviceStatus(definition) : 'unavailable';
        const providerReady = provider?.id === providerId && provider.active === true;
        const available = providerReady && service.active === true && state === 'active' && definition?.active === true && definitionState === 'active';
        const permissions = servicePermissions(definition);
        const scope = available && permissions.usable ? permissions.ceiling : '';
        const readiness = !providerReady ? 'Provider unavailable' : state === 'pending' ? 'Waiting for activation'
            : state !== 'active' || service.active !== true ? `Registration ${state}`
                : !definition ? 'Definition unavailable' : !available ? `Definition ${definitionState}` : 'Ready to request';
        return { id: service.id, providerName: provider?.name || service.providedBy?.display || '', name: service.name || definition?.name || 'Unnamed service', purpose: definition?.extraDetails || service.extraDetails || 'Not provided by PCM',
            definitionId: canonicalId, definitionReference: `HealthcareService/${canonicalId}`, instanceVersion: service.meta?.versionId || null,
            definitionVersion: definition?.meta?.versionId || null, state, definitionState, available, readiness, scope, permissions,
            definition: definition || null, instance: service,
            signature: createHash('sha256').update(JSON.stringify([publicServiceFacts(service), publicServiceFacts(definition), provider ? { id: provider.id, active: provider.active, identifier: provider.identifier, version: provider.meta?.versionId } : null])).digest('hex'), grantReason: 'Exact approved scope; every preset enforces context' };
    });
}
/** Validate the actual server link, preserving its opaque caller/query-bound cursor and logical origin. */
function nextPage(link, logicalBase, current, seen = []) {
    let url;
    try { url = new URL(link); } catch { throw new Error('Invalid service continuation link'); }
    const expected = new URL(`${logicalBase}/HealthcareService`);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password
        || !url.search || link.length > 4096 || link === current || seen.includes(link)) {
        throw new Error('Invalid, foreign or cyclic service continuation link');
    }
    return link;
}
/** Execute one finite request group. Timeout/byte/request limits also apply to linked exact reads. */
function boundedReader(client, { signal, limits = LIMITS, used = { requests: 0, bytes: 0 }, now = Date.now } = {}) {
    const controller = new AbortController(), start = now();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, limits.milliseconds);
    return { used,
        async read(type, id, page) {
            if (controller.signal.aborted || now() - start >= limits.milliseconds) throw new Error('Service load cancelled or time budget reached');
            if (used.requests >= limits.requests) throw new Error('Service request budget reached; refresh from the first page');
            used.requests++;
            const resource = await client({ type, id, page, signal: controller.signal, maxBytes: Math.max(1, limits.bytes - used.bytes) });
            if (controller.signal.aborted) throw new Error('Service load cancelled');
            used.bytes += Buffer.byteLength(JSON.stringify(resource));
            if (used.bytes > limits.bytes) throw new Error('Service byte budget reached; refresh from the first page');
            return resource;
        },
        close() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    };
}
/** Load one actual advertised search page plus visible owned definitions within a shared finite budget. */
async function loadServicesPage({ client, providerId, logicalBase, page = '', seen = [], pages = 0, ...options }) {
    const limits = options.limits || LIMITS;
    if (pages >= limits.pages) throw new Error('Service page budget reached; refresh from the first page');
    const reader = boundedReader(client, options), warnings = [];
    try {
        const bundle = await reader.read('HealthcareService', null, page);
        if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'searchset' || !Array.isArray(bundle.entry || []) || (bundle.entry || []).length > limits.entries) throw new Error('Unexpected service search page');
        const resources = (bundle.entry || []).filter(entry => entry.search?.mode !== 'include').map(entry => entry.resource).filter(resource => resource?.resourceType === 'HealthcareService');
        const links = (bundle.link || []).filter(link => link.relation === 'next');
        let next = '';
        if (links.length > 1) warnings.push('Ambiguous continuation; list incomplete. Refresh to retry.');
        else if (links.length) {
            try { next = nextPage(links[0].url, logicalBase, page, seen); }
            catch (error) { warnings.push(error.message + '; list incomplete.'); }
        }
        let provider;
        try { provider = await reader.read('Organization', providerId); }
        catch { warnings.push('Provider prerequisites could not be read; requests are unavailable. Refresh to retry.'); }
        const owned = resources.filter(resource => resource.providedBy?.reference === `Organization/${providerId}`);
        for (const id of [...new Set(owned.map(definitionId).filter(Boolean))]) {
            if (resources.some(resource => resource.id === id && resource.meta?.profile?.includes(PROFILES.healthcareServiceCanonical))) continue;
            try {
                const definition = await reader.read('HealthcareService', id);
                if (definition?.id !== id || !definition.meta?.profile?.includes(PROFILES.healthcareServiceCanonical)) throw new Error('Unexpected definition');
                resources.push(definition);
            } catch { warnings.push('A linked definition is unavailable through this provider’s ordinary API; refresh to retry.'); }
        }
        if (next && (pages + 1 >= limits.pages || reader.used.requests >= limits.requests || reader.used.bytes >= limits.bytes)) { next = ''; warnings.push('Service load budget reached; list incomplete. Refresh from the first page.'); }
        return { services: projectOwnedServices({ entry: resources.map(resource => ({ resource })) }, providerId, provider), next, warnings,
            pages: pages + 1, used: reader.used, complete: !next && !warnings.length };
    } finally { reader.close(); }
}
/** Resolve a selected or historical instance by exact ordinary reads, independent of loaded search pages. */
async function readOwnedService({ client, providerId, id, ...options }) {
    if (!ID.test(id || '')) throw new Error('Choose a valid provider registration');
    const reader = boundedReader(client, options);
    try {
        let service;
        try { service = await reader.read('HealthcareService', id); }
        catch (error) {
            if ([403, 404].includes(error.response?.status || error.status)) return { id, available: false, readiness: 'Service missing or not visible', signature: 'missing' };
            throw error;
        }
        const canonicalId = definitionId(service);
        if (service?.id !== id || service.providedBy?.reference !== `Organization/${providerId}` || !canonicalId || !service.meta?.profile?.includes(PROFILES.healthcareServiceInstance)) throw new Error('Choose a provider registration owned by this application');
        let definition;
        try { definition = await reader.read('HealthcareService', canonicalId); }
        catch (error) { if (![403, 404].includes(error.response?.status || error.status)) throw error; }
        const provider = await reader.read('Organization', providerId);
        return projectOwnedServices({ entry: [service, ...(definition?.id === canonicalId ? [definition] : [])].map(resource => ({ resource })) }, providerId, provider)[0];
    } finally { reader.close(); }
}
module.exports = { serviceSummary, LIMITS, providerRole, serviceStatus, definitionId, projectOwnedServices, nextPage, loadServicesPage, readOwnedService };
