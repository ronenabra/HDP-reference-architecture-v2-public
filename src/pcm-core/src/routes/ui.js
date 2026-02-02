/**
 * PCM internal UI routes (dashboard and consent approvals).
 */
const express = require('express');
const router = express.Router();
const store = require('../fhir/store');

const EXT_PCM_SERVICE = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service';

/**
 * Render the consent dashboard view.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
const renderDashboard = (req, res) => {
    const allConsents = store.getAll('Consent');

    const enrichedConsents = allConsents.map(c => {
        let requesterName = 'Unknown';
        let parentOrgName = 'Unknown';
        let serviceName = 'Unknown';

        const actors = c.provision?.actor || [];
        const requestorActor = actors.find(a => a.role?.coding?.some(code => code.code === 'IRCP'));

        if (requestorActor && requestorActor.reference) {
            requesterName = requestorActor.reference.display || 'Unknown';
            const orgId = requestorActor.reference.reference?.split('/').pop();
            const org = store.get('Organization', orgId);

            if (org && org.partOf && org.partOf.reference) {
                const parentId = org.partOf.reference.split('/').pop();
                const parent = store.get('Organization', parentId);
                if (parent) parentOrgName = parent.name;
            }
        }

        const serviceExt = c.extension?.find(e => e.url === EXT_PCM_SERVICE);
        if (serviceExt && serviceExt.valueReference) {
            const svcId = serviceExt.valueReference.reference?.split('/').pop();
            const svc = store.get('HealthcareService', svcId);
            if (svc) serviceName = svc.name;
        }

        return {
            ...c,
            requesterName,
            parentOrgName,
            serviceName
        };
    });

    enrichedConsents.sort((a, b) => (a.status === 'proposed' ? -1 : 1));

    res.render('dashboard', { consents: enrichedConsents });
};

/**
 * Render the approval page for a single consent.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
const renderApproval = (req, res) => {
    const consent = store.get('Consent', req.params.id);
    if (!consent) return res.status(404).send('Not Found');

    let requesterName = 'Unknown';
    let serviceName = 'Unknown';

    const actors = consent.provision?.actor || [];
    const requestorActor = actors.find(a => a.role?.coding?.some(code => code.code === 'IRCP'));
    if (requestorActor && requestorActor.reference) {
        requesterName = requestorActor.reference.display || 'Unknown';
    }

    const serviceExt = consent.extension?.find(e => e.url === EXT_PCM_SERVICE);
    if (serviceExt && serviceExt.valueReference) {
        const svcId = serviceExt.valueReference.reference?.split('/').pop();
        const svc = store.get('HealthcareService', svcId);
        if (svc) serviceName = svc.name;
    }

    const dataSources = store.getAll('Organization')
        .filter(org => org.type && org.type.some(t => t.coding.some(c => c.code === 'source')))
        .map(org => ({ id: org.id, name: org.name }));

    res.render('consent', { consent, dataSources, requesterName, serviceName });
};

/**
 * Handle approval or rejection for a consent.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
const handleApproval = (req, res) => {
    const consent = store.get('Consent', req.params.id);
    if (!consent) return res.status(404).send('Not Found');

    const { action } = req.body;

    if (action === 'decline') {
        consent.status = 'rejected';
        store.update(consent);
        console.log(`[UI] Consent ${consent.id} DECLINED.`);
        return res.redirect('/ui');
    }

    consent.status = 'active';

    const sources = store.getAll('Organization')
        .filter(org => org.type && org.type.some(t => t.coding.some(c => c.code === 'source')));

    const newActors = sources.map(ds => ({
        role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] },
        reference: { reference: `Organization/${ds.id}`, display: ds.name }
    }));

    if (!consent.provision) consent.provision = { type: 'permit', actor: [] };
    if (!consent.provision.actor) consent.provision.actor = [];

    const existingRefs = new Set(consent.provision.actor.map(a => a.reference.reference));
    newActors.forEach(a => {
        if (!existingRefs.has(a.reference.reference)) {
            consent.provision.actor.push(a);
        }
    });

    try {
        store.update(consent);
        console.log(`[UI] Consent ${consent.id} Approved.`);
        res.redirect('/ui');
    } catch (err) {
        console.error('Approval Failed', err);
        res.status(500).send('Approval Failed: ' + err.message);
    }
};

router.get('/ui', renderDashboard);
router.get('/ui/approve/:id', renderApproval);
router.post('/ui/approve/:id', handleApproval);

module.exports = router;
