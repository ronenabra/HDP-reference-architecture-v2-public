'use strict';
/** Pure presentation of ordinary provider results; never consult private sandbox state. */
const lifecycle = require('./fhir/healthcare-service-lifecycle');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { CATEGORY_LABELS } = require('../../shared/consent-presentation');
const { UNITS } = require('./service-definition-form');

/** Describe only permissions actually returned by the provider's ordinary API. */
function accessDetails(definition) {
    if (!definition) return { summary: 'Definition unavailable', history: [], period: 'Not available' };
    const extensions = definition.extension || [];
    const history = extensions.filter(item => item.url === EXTENSIONS.informationBucket).map(item => {
        const code = item.extension?.find(part => part.url === 'bucket')?.valueCodeableConcept?.coding?.[0]?.code;
        const depth = item.extension?.find(part => part.url === 'historyDepth')?.valueDuration;
        return `${CATEGORY_LABELS[code] || code || 'Unspecified category'}${depth ? `: ${depth.value} ${UNITS[depth.code] || depth.code} at creation (generator input)` : ': history not recorded'}`;
    });
    const duration = extensions.find(item => item.url === EXTENSIONS.accessDuration)?.valueDuration;
    const mode = extensions.find(item => item.url === EXTENSIONS.accessMode)?.valueCode;
    return { summary: history.map(text => text.split(':')[0]).join(', ') || 'Data categories not recorded', history,
        period: `${duration ? `${duration.value} ${UNITS[duration.code] || duration.code}` : 'Not recorded'}${mode ? `; ${mode === 'continuous' ? 'ongoing within the approved period' : mode === 'one-time' ? 'one hour per client and source from first qualifying use' : mode}` : ''}` };
}

/** Group each visible registration with its permitted definition, preserving exact registration IDs.
 * @param {object} options Ordinary resources, selected provider and configured public names.
 * @returns {object} Owned, available and other-provider rows; no authority or mutation decisions.
 */
function projectServices({ resources, providerId, providers = [] }) {
    const unique = [...new Map(resources.filter(item => item?.resourceType === 'HealthcareService').map(item => [item.id, item])).values()];
    const definitions = new Map(unique.filter(item => lifecycle.serviceKind(item) === 'catalog').map(item => [item.id, item]));
    const instances = unique.filter(item => lifecycle.serviceKind(item) === 'instance');
    const knownOwned = new Set(instances.filter(item => lifecycle.ownerId(item) === providerId).map(lifecycle.basedOnId));
    const row = service => {
        const kind = lifecycle.serviceKind(service), definition = kind === 'catalog' ? service : definitions.get(lifecycle.basedOnId(service));
        const state = lifecycle.businessStatus(service) || 'unknown', definitionState = definition ? lifecycle.businessStatus(definition) || 'unknown' : 'unavailable';
        const ready = kind === 'instance' && state === 'active' && service.active === true && definitionState === 'active' && definition.active === true;
        const ownerId = lifecycle.ownerId(service);
        return { service, definition, kind, state, definitionState, ownerId,
            name: service.name || definition?.name || 'Unnamed service',
            ownerName: providers.find(provider => provider.id === ownerId)?.name || ownerId || '',
            status: kind === 'catalog' ? 'No loaded registration' : state === 'pending' ? 'Waiting for activation' : state[0].toUpperCase() + state.slice(1),
            availability: kind === 'catalog' ? 'Registrable definition' : ready ? 'Ready to use' : state !== 'active' || service.active !== true ? 'Not ready to use' : !definition ? 'Definition unavailable; usability unknown' : 'Not ready to use',
            access: accessDetails(definition) };
    };
    return { owned: instances.filter(item => lifecycle.ownerId(item) === providerId).map(row),
        available: [...definitions.values()].filter(item => lifecycle.businessStatus(item) === 'active' && item.active === true && !knownOwned.has(item.id)).map(row),
        others: instances.filter(item => lifecycle.ownerId(item) !== providerId).map(row) };
}

/** Read one ordinary search page plus bounded linked definitions. No continuation is followed here.
 * @param {object} options Authenticated client, optional caller-bound cursor and clock/budget overrides.
 * @returns {Promise<object>} Loaded ordinary resources, next cursor and explicit partial warnings.
 */
async function loadServicesPage({ client, page, now = Date.now, maxReads = 20, maxBytes = 1048576, maxMilliseconds = 15000 }) {
    const started = now(), warnings = [];
    const bundle = await client.search(page);
    if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'searchset' || !Array.isArray(bundle.entry || [])) throw new Error('The service API returned an unexpected result.');
    let bytes = Buffer.byteLength(JSON.stringify(bundle));
    if (bytes > maxBytes || (bundle.entry || []).length > 50) throw new Error('The service results exceeded the bounded page budget.');
    const resources = (bundle.entry || []).filter(entry => entry.search?.mode !== 'include' && entry.resource?.resourceType === 'HealthcareService').map(entry => entry.resource);
    const nextLinks = (bundle.link || []).filter(link => link.relation === 'next');
    if (nextLinks.length > 1) throw new Error('The service API returned ambiguous page links.');
    const nextPage = nextLinks.length ? client.nextPage(nextLinks[0].url, page) : '';
    const ids = [...new Set(resources.filter(item => lifecycle.serviceKind(item) === 'instance').map(lifecycle.basedOnId).filter(Boolean))];
    let reads = 0;
    for (const id of ids) {
        if (resources.some(resource => resource.id === id && lifecycle.serviceKind(resource) === 'catalog')) continue;
        if (reads >= maxReads || now() - started >= maxMilliseconds) { warnings.push('Linked-definition read budget reached. Some definitions are unavailable; no further pages were scanned.'); break; }
        reads++;
        try {
            const definition = await client.read(id);
            const size = Buffer.byteLength(JSON.stringify(definition));
            if (bytes + size > maxBytes) { warnings.push('Linked-definition byte budget reached. Some definitions are unavailable.'); break; }
            bytes += size;
            if (definition?.id !== id || lifecycle.serviceKind(definition) !== 'catalog') throw new Error('Unexpected definition response');
            resources.push(definition);
        } catch (failure) {
            warnings.push(failure.status === 404 ? `Shared definition ${id} is not visible through this provider’s regular API. Private previews are separate below.` : `Shared definition ${id} could not be read. Its availability is unknown; refresh to retry.`);
        }
    }
    return { resources, nextPage, warnings };
}
module.exports = { projectServices, loadServicesPage };
