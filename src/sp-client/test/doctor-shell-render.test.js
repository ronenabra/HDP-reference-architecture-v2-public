'use strict';
/** Shell rendering preserves exact context, notices and existing workflow forms. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ejs = require('ejs');
const { render } = require('../../../test-support/doctor-ux-render');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { buildEffectivePolicy } = require('../../shared/conformance-policy');
const { doctorNotice } = require('../src/doctor-notice');
const { ORDINARY } = require('../src/patient-choice');
const template = fs.readFileSync(path.join(__dirname, '../src/views/patients.ejs'), 'utf8');

/** Render the library with the same configured context its existing route supplies. */
function library(overrides = {}) {
    return ejs.render(template, { browserBase: '/team/doctor', teamId: 'shell-test', identity: 'hospital-a',
        applicationLabel: 'Hospital A', publicBaseUrls: { pcmUi: 'https://pcm.example/team/pcm' },
        fixed: [ORDINARY], sources: [], state: { generation: 1, state: 'idle' }, ...overrides });
}
test('ordinary, empty and long application shells keep one title, context and navigation', () => {
    for (const applicationLabel of ['Hospital A', '', '<Hospital> ' + 'very-long-name-'.repeat(25)]) {
        const html = library({ applicationLabel, fixed: [] });
        assert.equal((html.match(/<h1\b/g) || []).length, 1);
        assert.equal((html.match(/class="explain-toggle"/g) || []).length, 1);
        assert.match(html, /sandbox-header doctor-shell-header/);
        assert.match(html, /Requesting application:/);
        assert.ok(html.includes(ejs.escapeXML(applicationLabel)));
        assert.match(html, /Back to request/);
        assert.match(html, /No source: sampling is disabled/);
        assert.doesNotMatch(html, /localStorage|data-patient-mode/);
        assert.match(html, /<table class="library-table"/);
    }
    assert.match(library(), /Name unknown \(ordinary demo patient\)/);
    assert.match(library(), />Use patient<\/button>/);
    const html = render();
    assert.match(html, /<legend[^>]*patient-section-heading[^>]*>.*Patient library<\/a><\/legend>/);
    assert.equal((html.match(/data-patient-library\b/g) || []).length, 1);
});
test('navigation retains configured deployment mounts and exactly encoded application identity', () => {
    const identity = 'client /&?';
    const html = library({ identity });
    for (const href of ['/team/doctor/?identity=client%20%2F%26%3F',
        'https://pcm.example/team/pcm/ui', 'https://pcm.example/team/pcm/logs-view',
        '/team/doctor/?identity=client%20%2F%26%3F#manual-testing', '/team/doctor/reset']) {
        assert.ok(html.includes(`="${href}"`), href);
    }
    assert.match(html, /name="identity" value="client \/&amp;\?"/);
    assert.match(html, /data-tools-close/);
});
test('main retains preset diagnostics while library gives contextual sampling guidance', () => {
    for (const preset of ['strict', 'connectathon-easy', 'connectathon-balanced', 'connectathon-mtls']) {
        const config = buildTeamConfig({}, preset), policy = buildEffectivePolicy(config);
        const context = { conformance: { ...policy, warnings: ['Fixture warning'] }, sandboxNotice: doctorNotice(config, policy) };
        for (const html of [render(undefined, 'active', context)]) {
            assert.ok(html.includes(policy.resultLabel));
            assert.ok(html.includes(context.sandboxNotice.message));
            assert.match(html, /Exact approved permissions and Patient\/source context apply in every preset/);
            assert.match(html, /<details><summary[^>]*>Sandbox details and diagnostics/);
            assert.doesNotMatch(html, /<details open/);
            for (const source of context.sandboxNotice.sources) assert.ok(html.includes(ejs.escapeXML(source.name)));
            assert.match(html, /Fixture warning/);
        }
    }
    assert.doesNotMatch(library(), /Sandbox details and diagnostics|Fixture warning/);
    assert.match(library(), /Synthetic patients only/);
    assert.match(library({ conformance: { preset: 'strict' } }), /Unsupported: sampling is disabled in Strict/);
});
