'use strict';
/** Disposable real approval routes for HTTP and browser tests; no retained team is touched. */
const fs = require('node:fs'), path = require('node:path');

/** Start isolated PCM UI routes and return helpers for creating requested Consents. */
async function startApprovalFixture() {
    const definitions = require('../config/demo-services.json');
    const config = require('./team-config').installTestRuntime({ serviceCatalog: {
        file: 'config/demo-services.json', bindings: definitions.clinicalServices.map(item => ({
            application: 'serviceProvider', providerRole: 'serviceProvider', serviceKey: item.key,
            instanceId: `approval-${item.key}`, instanceIdentifier: `APPROVAL-${item.key}`
        }))
    } });
    const express = require('express');
    const store = require('../src/pcm-core/src/fhir/store');
    store.clear();
    require('../src/pcm-core/src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
    for (const resource of require('../src/pcm-core/src/bootstrap').buildSeedDrafts(config)) require('../src/pcm-core/src/public-fhir').publishNewResource(store, resource);
    const app = express();
    app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../src/pcm-core/src/views'));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/assets', express.static(path.resolve(__dirname, '../src/shared/ui')));
    app.use(require('../src/pcm-core/src/routes/ui'));
    const server = await new Promise(resolve => { const server = app.listen(0, '0.0.0.0', () => resolve(server)); });
    let sequence = 0;
    return {
        base: `http://127.0.0.1:${server.address().port}`, store, config,
        /** Create a real non-auto-approved request for the chosen registered service. */
        create(serviceKey = 'lab-follow-up') {
            const request = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json')));
            request.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
            request.extension.find(item => item.url.endsWith('/ext-pcm-service')).valueReference.reference = `HealthcareService/approval-${serviceKey}`;
            return require('../src/pcm-core/src/fhir/consent-lifecycle').createConsent({ store,
                callerOrganization: store.get('Organization', config.organizations.serviceProvider.id), request,
                idGenerator: () => `approval-fixture-${++sequence}` });
        },
        /** Stop the owned listener and discard the isolated resource state. */
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.clear(); }
    };
}

module.exports = { startApprovalFixture };
