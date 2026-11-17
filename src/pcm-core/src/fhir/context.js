/**
 * Helpers for building fhirContext entries.
 */
const { IDENTIFIER_SYSTEMS } = require('../../../shared/pcm-contract');

const CATALOG_ID_SYSTEM = IDENTIFIER_SYSTEMS.healthcareServiceCatalog;
const INSTANCE_ID_SYSTEM = IDENTIFIER_SYSTEMS.healthcareServiceInstance;

/**
 * Normalize a value into an array.
 * @param {any} value
 * @returns {any[]}
 */
const toArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

/**
 * Find a HealthcareService identifier for the requested system.
 * @param {object|null|undefined} service
 * @param {string} system
 * @returns {object|null}
 */
const findIdentifier = (service, system) => {
    if (!service) return null;
    return toArray(service.identifier).find(id => id.system === system) || null;
};

/**
 * Build fhirContext entry for a HealthcareService.
 * @param {object|null|undefined} service
 * @param {object|null|undefined} canonicalService
 * @returns {object|null}
 */
function buildHealthcareServiceContext(service, canonicalService) {
    if (!service && !canonicalService) return null;

    const instanceIdentifier = findIdentifier(service, INSTANCE_ID_SYSTEM);
    const value = instanceIdentifier?.value || service?.id || canonicalService?.id;

    if (!value) return null;

    return {
        type: 'HealthcareService',
        identifier: {
            system: INSTANCE_ID_SYSTEM,
            value
        }
    };
}

module.exports = {
    CATALOG_ID_SYSTEM,
    INSTANCE_ID_SYSTEM,
    buildHealthcareServiceContext
};
