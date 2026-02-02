/**
 * Helpers for building fhirContext entries.
 */
const CATALOG_ID_SYSTEM = 'http://pcm.fhir.health.gov.il/identifier/pcm-healthcareservice-catalog-id';

/**
 * Normalize a value into an array.
 * @param {any} value
 * @returns {any[]}
 */
const toArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

/**
 * Find a catalog identifier on a HealthcareService.
 * @param {object|null|undefined} service
 * @returns {object|null}
 */
const findCatalogIdentifier = service => {
    if (!service) return null;
    return toArray(service.identifier).find(id => id.system === CATALOG_ID_SYSTEM) || null;
};

/**
 * Build fhirContext entry for a HealthcareService.
 * @param {object|null|undefined} service
 * @param {object|null|undefined} canonicalService
 * @returns {object|null}
 */
function buildHealthcareServiceContext(service, canonicalService) {
    if (!service && !canonicalService) return null;

    const catalogIdentifier = findCatalogIdentifier(service) || findCatalogIdentifier(canonicalService);
    const value = catalogIdentifier?.value || service?.id || canonicalService?.id;

    if (!value) return null;

    return {
        type: 'HealthcareService',
        identifier: {
            system: CATALOG_ID_SYSTEM,
            value
        }
    };
}

module.exports = {
    CATALOG_ID_SYSTEM,
    buildHealthcareServiceContext
};
