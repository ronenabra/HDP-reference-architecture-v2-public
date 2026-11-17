'use strict';
/** Presentation validation preserves authority inputs and never turns invalid suffixes into valid facts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/workflow-presentation');
const system = 'http://fhir.health.gov.il/identifier/il-national-id';
test('pasted IDs preserve zeros and exact system/value syntax while DOB is validated in full', () => {
    const value = p.formInput({ identifier: `  ${system}|000000018  `, birthDate: '1980-01-02', homeHmoId: 'registered-hmo' });
    assert.equal(value.identifier, '000000018'); assert.equal(value.system, system); assert.equal(p.validateForm(value), null);
    for (const date of ['1980-01-02suffix', '1980-02-30', '1980-13-01', '1980-01', '']) assert.equal(p.validateForm({ ...value, birthDate: date }).field, 'birthDate');
    assert.equal(p.validateForm({ ...value, identifier: 'x'.repeat(161) }).field, 'identifier');
});
test('identifier type choices are readable and omit unsupported Israeli passport and synthetic person login', () => {
    const types = p.identifierTypes(); assert.ok(types.length > 2);
    assert.ok(types.every(type => type.label && !type.label.includes('http')));
    assert.ok(!types.some(type => /passport-ISR|il-hdp-test-id/.test(type.value)));
});
