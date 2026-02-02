/**
 * Seed PCM with initial FHIR resources and certificate thumbprints.
 */
const fs = require('fs');
const path = require('path');
const store = require('./fhir/store');
const { certToX5tS256 } = require('./crypto');

/**
 * Compute x5t#S256 thumbprint (base64url) for a certificate on disk.
 * @param {string} certPath
 * @returns {string|null}
 */
function getThumbprint(certPath) {
    if (!fs.existsSync(certPath)) return null;
    const cert = fs.readFileSync(certPath, 'utf8');
    return certToX5tS256(cert);
}


/**
 * Load baseline organizations, endpoints, and services into the FHIR store.
 * @returns {Promise<void>}
 */
async function bootstrap() {
    console.log('Bootstrapping PCM data...');

    // 1. Calculate Thumbprints
    const gatewayThumbprint = getThumbprint('/app/certs/ds-gateway.crt') || 'mock-gateway-thumb';
    const clientThumbprint = getThumbprint('/app/certs/sp-client.crt') || 'mock-client-thumb';
    const pcmThumbprint = getThumbprint('/app/certs/pcm-core.crt') || 'mock-pcm-thumb';

    console.log('DS Gateway Thumbprint:', gatewayThumbprint);
    console.log('SP Client Thumbprint:', clientThumbprint);
    console.log('PCM Core Thumbprint:', pcmThumbprint);

    // 2. Define Resources

    // --- MoH & Vaccination Repo (Data Source) ---
    const orgMoh = {
        resourceType: 'Organization',
        id: 'org-moh-parent',
        active: true,
        name: 'Ministry of Health',
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'parent-org' }] }]
    };

    const endpointVaccine = {
        resourceType: 'Endpoint',
        id: 'endpoint-vaccine-repo',
        status: 'active',
        connectionType: {
            system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type',
            code: 'hl7-fhir-rest',
            display: 'HL7 FHIR REST'
        },
        payloadType: [{
            coding: [{
                code: 'urn:ihe:pcc:xphr:2007',
                system: 'urn:oid:1.3.6.1.4.1.19376.1.2.3',
                display: 'XPHR Extract'
            }]
        }],
        address: 'https://ds-gateway:8080/fhir', // Discoverable URL (HTTPS)
        managingOrganization: { reference: 'Organization/org-vaccine-repo' },
        extension: [{
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-applicable-certificates',
            extension: [{ url: 'thumbprint', valueString: gatewayThumbprint }]
        }]
    };

    // Note: The example structure has the Data Source Org referencing the Endpoint
    const orgVaccineRepo = {
        resourceType: 'Organization',
        id: 'org-vaccine-repo',
        active: true, // Should be active to work
        name: 'Vaccinations Repository',
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'source' }] }],
        partOf: { reference: 'Organization/org-moh-parent' },
        endpoint: [{ reference: 'Endpoint/endpoint-vaccine-repo' }]
    };


    // --- Hospital A & Doctor's Consultation (Service Provider) ---
    const orgHospitalA = {
        resourceType: 'Organization',
        id: 'org-hospital-a-parent',
        active: true,
        name: 'Hospital A',
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'parent-org' }] }],
        contact: [
            { purpose: { coding: [{ code: 'ADMIN' }] }, name: { text: 'Hospital A - Admin' }, telecom: [{ system: 'email', value: 'admin@hospital-a.example.org' }] }
        ]
    };

    const orgDoctorApp = {
        resourceType: 'Organization',
        id: 'org-sp', // Renamed to match client mapping
        active: true,
        name: "Doctor's Consultation",
        type: [
            { coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'service-provider' }] },
            { coding: [{ system: 'http://fhir.health.gov.il/cs/institution-type-moh', code: '1', display: 'General Hospital' }] }
        ],
        partOf: { reference: 'Organization/org-hospital-a-parent' },
        extension: [
            { url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-oauth2-redirect-uri', valueUrl: 'http://localhost:3000/callback' },
            { url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-applicable-certificates', extension: [{ url: 'thumbprint', valueString: clientThumbprint }] }
        ]
    };

    // --- PCM Admin Organization ---
    const orgPcm = {
        resourceType: 'Organization',
        id: 'org-pcm-system',
        active: true,
        name: 'Patient Consent Manager (PCM)',
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'pcm' }] }],
        extension: [
            { url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-applicable-certificates', extension: [{ url: 'thumbprint', valueString: pcmThumbprint }] }
        ],
        endpoint: [{ reference: 'Endpoint/endpoint-pcm-system' }]
    };

    // 3. Load into Store
    store.add(orgMoh);
    store.add(endpointVaccine);
    store.add(orgVaccineRepo);
    store.add(orgHospitalA);

    store.add(orgDoctorApp);
    store.add(orgPcm);

    const endpointPcmSystem = {
        resourceType: 'Endpoint',
        id: 'endpoint-pcm-system',
        status: 'active',
        connectionType: {
            system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type',
            code: 'hl7-fhir-rest',
            display: 'HL7 FHIR REST'
        },
        payloadType: [{
            coding: [{
                code: 'urn:ihe:pcc:xphr:2007',
                system: 'urn:oid:1.3.6.1.4.1.19376.1.2.3',
                display: 'XPHR Extract'
            }]
        }],
        address: 'https://pcm.fhir.health.gov.il/r4',
        managingOrganization: { reference: 'Organization/org-pcm-system' },
        extension: [{
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-applicable-certificates',
            extension: [{ url: 'thumbprint', valueString: pcmThumbprint }]
        }]
    };

    store.add(endpointPcmSystem);

    // --- Healthcare Service ---
    const serviceGP = {
        resourceType: 'HealthcareService',
        id: 'service-1',
        active: true,
        providedBy: { reference: 'Organization/org-hospital-a-parent' },
        name: 'General Practice / Telehealth',
        type: [{ coding: [{ system: 'http://snomed.info/sct', code: '700232004', display: 'General medical service' }] }]
    };
    store.add(serviceGP);

    // --- Hospital B & Service Provider (Hospital B) ---
    const hospitalBThumbprint = getThumbprint('/app/certs/hospital-b-sp.crt') || 'mock-hospital-b-thumb';
    console.log('Hospital B SP Thumbprint:', hospitalBThumbprint);

    const orgHospitalB = {
        resourceType: 'Organization',
        id: 'org-hospital-b-parent',
        active: true,
        name: 'Hospital B',
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'parent-org' }] }]
    };

    const orgHospitalBSP = {
        resourceType: 'Organization',
        id: 'org-hospital-b-sp',
        active: true,
        name: "Hospital B - Doctor's Portal",
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'service-provider' }] }],
        partOf: { reference: 'Organization/org-hospital-b-parent' },
        extension: [
            { url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-applicable-certificates', extension: [{ url: 'thumbprint', valueString: hospitalBThumbprint }] }
        ]
    };

    store.add(orgHospitalB);
    store.add(orgHospitalBSP);

    console.log('Bootstrap complete. Organizations loaded.');
}

module.exports = bootstrap;
