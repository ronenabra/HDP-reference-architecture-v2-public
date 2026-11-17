/**
 * Helpers for patient business-identifier and local identity mapping.
 */

const DEFAULT_PATIENT_ID_SYSTEM = 'http://fhir.health.gov.il/identifier/il-national-id';
const PALESTINIAN_NATIONAL_ID_SYSTEM = 'http://fhir.health.gov.il/identifier/pna-national-id';
const SANDBOX_GUID_ID_SYSTEM = 'http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id';
const SANDBOX_GUID_TAG = 'urn:pcm:sandbox:guid-patient';
/** Permit the local identity branch only with explicit connectathon configuration. */
function sandboxIdentityOptions(config) { return { allowSandboxGuid: config?.conformance?.mode === 'connectathon' && config.conformance.preset !== 'strict' }; }
/** Accept non-nil hyphenated UUID shapes; casing is preserved on the wire. */
function isSandboxGuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value); }
const SYNTHETIC_TEST_ID_SYSTEM = 'http://fhir.health.gov.il/identifier/il-hdp-test-id';
// Exact codes from the IL Core passport-uri ValueSet used by the pinned PCM-IG.
const PASSPORT_COUNTRY_CODES = Object.freeze(new Set(`AFG ALB DZA ASM AND AGO AIA ATA ATG ARG ARM ABW AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BMU BTN BOL BIH BWA BVT BRA IOT BRN BGR BFA BDI KHM CMR CAN CPV CYM CAF TCD CHL CHN CXR CCK COL COM COG COD COK CRI CIV HRV CUB CYP CZE DNK DJI DMA DOM ECU EGY SLV GNQ ERI EST ETH FLK FRO FJI FIN FRA GUF PYF ATF GAB GMB GEO DEU GHA GIB GRC GRL GRD GLP GUM GTM GGY GIN GNB GUY HTI HMD VAT HND HKG HUN ISL IND IDN IRN IRQ IRL IMN ISR ITA JAM JPN JEY JOR KAZ KEN KIR PRK KOR KWT KGZ LAO LVA LBN LSO LBR LBY LIE LTU LUX MAC MKD MDG MWI MYS MDV MLI MLT MHL MTQ MRT MUS MYT MEX FSM MDA MCO MNG MNE MSR MAR MOZ MMR NAM NRU NPL NLD ANT NCL NZL NIC NER NGA NIU NFK MNP NOR OMN PAK PLW PSE PAN PNG PRY PER PHL PCN POL PRT PRI QAT REU ROU RUS RWA SHN KNA LCA SPM VCT WSM SMR STP SAU SEN SRB SYC SLE SGP SVK SVN SLB SOM ZAF SGS ESP LKA SDN SUR SJM SWZ SWE CHE SYR TWN TJK TZA THA TLS TGO TKL TON TTO TUN TUR TKM TCA TUV UGA UKR ARE GBR USA UMI URY UZB VUT VEN VNM VGB VIR WLF ESH YEM ZMB ZWE`.split(' ')));
const PASSPORT_ID_SYSTEMS = Object.freeze(new Set(
    [...PASSPORT_COUNTRY_CODES].map(code => `http://hl7.org/fhir/sid/passport-${code}`)
));

/** Return whether a nine-digit Israeli national identifier has a valid check digit. */
function hasValidIsraeliNationalId(value) {
    if (!/^\d{9}$/.test(value || '')) return false;
    const sum = [...value].reduce((total, digit, index) => {
        const product = Number(digit) * (index % 2 === 0 ? 1 : 2);
        return total + (product > 9 ? product - 9 : product);
    }, 0);
    return sum % 10 === 0;
}

/**
 * Validate and normalize one identifier-only PCM patient reference.
 * System and value remain distinct and the returned key is never value-only.
 * @param {object} identifier
 * @returns {{system: string, value: string, key: string, synthetic: boolean}}
 */
function normalizePatientIdentifier(identifier, { allowSandboxGuid = false, maxLength } = {}) {
    if (!identifier || typeof identifier !== 'object' || Array.isArray(identifier)
        || typeof identifier.system !== 'string' || typeof identifier.value !== 'string') {
        throw new TypeError('Patient identifier requires distinct system and value strings');
    }
    const { system, value } = identifier;
    if (!system || system !== system.trim() || !value || value !== value.trim()) {
        throw new TypeError('Patient identifier system and value must be non-empty without surrounding whitespace');
    }
    if (maxLength !== undefined && [...value].length > maxLength) {
        throw new TypeError(`Patient identifier value exceeds ${maxLength} characters`);
    }
    if (system === DEFAULT_PATIENT_ID_SYSTEM && !hasValidIsraeliNationalId(value)) {
        throw new TypeError('Israeli national identifier must contain nine digits with a valid check digit');
    }
    if (system === SYNTHETIC_TEST_ID_SYSTEM && !['1', '2'].includes(value)) {
        throw new TypeError('Synthetic test identifier must be exactly 1 or 2');
    }
    if (system === SANDBOX_GUID_ID_SYSTEM && (!allowSandboxGuid || !isSandboxGuid(value))) throw new TypeError('Sandbox GUID identity requires connectathon and a non-nil hyphenated UUID');
    if (system !== DEFAULT_PATIENT_ID_SYSTEM
        && system !== PALESTINIAN_NATIONAL_ID_SYSTEM
        && system !== SYNTHETIC_TEST_ID_SYSTEM
        && !(system === SANDBOX_GUID_ID_SYSTEM && allowSandboxGuid)
        && !PASSPORT_ID_SYSTEMS.has(system)) {
        throw new TypeError('Patient identifier system is not in the pinned PCM passport identifier subset');
    }
    return { ...(system === SANDBOX_GUID_ID_SYSTEM ? { sandboxSynthetic: true } : {}), system, value, key: `${system}|${value}`, synthetic: system === SYNTHETIC_TEST_ID_SYSTEM };
}

/**
 * Decide login eligibility separately from lookup syntax. Foreign passports need
 * explicit trusted eligibility facts; their namespace never establishes nationality.
 * Portal/HMO integration consumes this predicate in PCM-IG-041-07.
 * @param {object} identifier Exact system/value identifier.
 * @param {object} facts Verified identity-provider facts, never browser assertions.
 * @returns {boolean} Whether the identity may establish normative PCM login.
 */
function isPatientLoginEligible(identifier, facts = {}) {
    let patient;
    try { patient = normalizePatientIdentifier(identifier); } catch (_) { return false; }
    if ([DEFAULT_PATIENT_ID_SYSTEM, PALESTINIAN_NATIONAL_ID_SYSTEM].includes(patient.system)) return true;
    return PASSPORT_ID_SYSTEMS.has(patient.system)
        && patient.system !== 'http://hl7.org/fhir/sid/passport-ISR'
        && facts.foreignPassportEligible === true
        && facts.israeliNationalWithId === false;
}

/**
 * Parse either a bare business identifier or a FHIR `system|value` token.
 * @param {string} input
 * @param {string} defaultSystem
 * @returns {{system: string, value: string, key: string}|null}
 */
function parseBusinessIdentifier(input, defaultSystem = DEFAULT_PATIENT_ID_SYSTEM) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const separator = raw.indexOf('|');
    if (separator === -1) {
        return { system: defaultSystem, value: raw, key: raw };
    }
    const system = raw.slice(0, separator).trim() || defaultSystem;
    const value = raw.slice(separator + 1).trim();
    if (!value) return null;
    return { system, value, key: value };
}

function businessIdentifierStorageKey(input, defaultSystem = DEFAULT_PATIENT_ID_SYSTEM) {
    const parsed = parseBusinessIdentifier(input, defaultSystem);
    if (!parsed) return '';
    return `${parsed.system}|${parsed.value}`;
}

/**
 * Build the canonical PCM patient context string.
 * @param {string} input
 * @param {string} defaultSystem
 * @returns {string}
 */
function toPatientContext(input, defaultSystem = DEFAULT_PATIENT_ID_SYSTEM) {
    const parsed = parseBusinessIdentifier(input, defaultSystem);
    return parsed ? `${parsed.system}|${parsed.value}` : '';
}

/**
 * Trim a local patient identifier while preserving the exact configured form.
 * @param {string} value
 * @returns {string}
 */
function cleanLocalSubject(value) {
    return String(value || '').trim();
}

/**
 * Return effective patient mapping overrides. Configured patients are seeded
 * as `Patient/local-[idValue]`; explicit overrides take precedence.
 * @param {object} config
 * @returns {Record<string, string>}
 */
function getEffectiveBusinessIdOverrides(config = {}) {
    const result = {};
    for (const patient of Array.isArray(config.patients) ? config.patients : []) {
        const parsed = parseBusinessIdentifier(patient?.idValue, patient?.idSystem || DEFAULT_PATIENT_ID_SYSTEM);
        if (parsed) result[parsed.system === DEFAULT_PATIENT_ID_SYSTEM ? parsed.value : `${parsed.system}|${parsed.value}`] = `Patient/local-${parsed.value}`;
    }

    const explicit = config.identityMapping?.businessIdOverrides || {};
    for (const [businessId, internalId] of Object.entries(explicit)) {
        const parsed = parseBusinessIdentifier(businessId);
        if (!parsed) continue;
        const storageKey = businessId.includes('|') ? `${parsed.system}|${parsed.value}` : parsed.key;
        const localSubject = cleanLocalSubject(internalId);
        if (storageKey && localSubject) {
            if (parsed.system === DEFAULT_PATIENT_ID_SYSTEM) delete result[parsed.key];
            result[storageKey] = localSubject;
        }
    }
    const localOwners = new Map();
    for (const [businessId, local] of Object.entries(result)) {
        const canonical = businessIdentifierStorageKey(businessId);
        if (localOwners.has(local) && localOwners.get(local) !== canonical) {
            throw new TypeError('Ambiguous patient mapping: distinct system/value identities share one local subject');
        }
        localOwners.set(local, canonical);
    }
    return result;
}

module.exports = {
    DEFAULT_PATIENT_ID_SYSTEM,
    PALESTINIAN_NATIONAL_ID_SYSTEM,
    isPatientLoginEligible,
    SANDBOX_GUID_ID_SYSTEM, SANDBOX_GUID_TAG, sandboxIdentityOptions, isSandboxGuid,
    PASSPORT_COUNTRY_CODES,
    PASSPORT_ID_SYSTEMS,
    SYNTHETIC_TEST_ID_SYSTEM,
    businessIdentifierStorageKey,
    cleanLocalSubject,
    getEffectiveBusinessIdOverrides,
    hasValidIsraeliNationalId,
    normalizePatientIdentifier,
    parseBusinessIdentifier,
    toPatientContext
};
