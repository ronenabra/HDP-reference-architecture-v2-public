'use strict';

/** Real Doctor EJS option projection: prompt and exact ordinary provider registrations. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { verifyOwnedPicker } = require('../ui/tests/helpers/service-picker');
const catalog = require('../../config/demo-services.json');
const config = { serviceCatalog: { bindings: Object.entries({ doctor: 'serviceProvider', 'doctor-b': 'hospitalBServiceProvider' })
    .flatMap(([application, providerRole]) => catalog.clinicalServices.map(service => ({ application, providerRole, serviceKey: service.key, instanceId: `owned-${application}-${service.key}` }))) } };
const view = fs.readFileSync(path.resolve(__dirname, '../../src/sp-client/src/views/index.ejs'), 'utf8');

/** Render the maintained picker for one provider and extract only its literal current option controls. */
function renderedOptions(identity) {
    const role = identity === 'hospital-a' ? 'serviceProvider' : 'hospitalBServiceProvider';
    const services = config.serviceCatalog.bindings.filter(binding => binding.providerRole === role).map(binding => ({
        id: binding.instanceId, name: binding.serviceKey, available: true, readiness: 'Ready to request', signature: 'a'.repeat(64)
    }));
    const html = ejs.render(view, { teamId: 'picker-unit', currentIdentity: identity, identities: [{ id: identity, label: identity }],
        publicBaseUrls: { pcmUi: 'http://pcm.test' }, conformance: { mode: 'strict', resultLabel: 'Strict', warnings: [] },
        flash: null, services, selectedServiceId: '', selectedPatientId: '', consents: [], patients: [], identifierTypes: [] });
    const picker = html.match(/<select\b[^>]*id="service-id"[^>]*>([\s\S]*?)<\/select>/)[1];
    return [...picker.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(([, attributes, text]) => ({
        value: attributes.match(/\bvalue="([^"]*)"/)[1], text: text.trim(), disabled: /\bdisabled\b/.test(attributes),
        stamp: attributes.match(/\bdata-service-stamp="([^"]*)"/)?.[1] || null
    }));
}

for (const identity of ['hospital-a', 'hospital-b']) test(`actual ${identity} EJS has one separate prompt and five exact owned registrations`, () => {
    const options = renderedOptions(identity);
    assert.equal(options.length, 6);
    const result = verifyOwnedPicker(options, config, identity);
    assert.equal(result.ids.length, 5); assert.equal(result.laboratoryStamp, 'a'.repeat(64));
    assert.ok(result.laboratoryId.endsWith('lab-follow-up'));
    const other = identity === 'hospital-a' ? 'hospital-b' : 'hospital-a';
    assert.throws(() => verifyOwnedPicker(options, config, other), /owned IDs/);
});

for (const [name, change] of [
    ['missing prompt', options => options.slice(1)],
    ['duplicate prompt', options => [...options, options[0]]],
    ['prompt carrying a stamp', options => options.map((option, index) => index ? option : { ...option, stamp: 'a'.repeat(64) })],
    ['foreign registration', options => options.map((option, index) => index === 1 ? { ...option, value: 'foreign-registration' } : option)],
    ['duplicate registration', options => options.map((option, index) => index === 2 ? options[1] : option)],
    ['missing current stamp', options => options.map((option, index) => index === 1 ? { ...option, stamp: null } : option)],
    ['unavailable laboratory', options => options.map(option => option.value.endsWith('lab-follow-up') ? { ...option, disabled: true } : option)]
]) test(`picker fixture rejects ${name}`, () => {
    assert.throws(() => verifyOwnedPicker(change(renderedOptions('hospital-a')), config, 'hospital-a'), assert.AssertionError);
});
