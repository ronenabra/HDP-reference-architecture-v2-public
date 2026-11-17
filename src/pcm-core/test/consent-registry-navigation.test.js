/** Verify rendered registry navigation reaches existing active Consent details. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

/** Render the registry with a single Consent in the specified lifecycle state. */
function renderRegistry(status) {
    const template = fs.readFileSync(path.join(__dirname, '../src/views/dashboard.ejs'), 'utf8');
    return ejs.render(template, {
        workflowUrl: 'https://pcm.test/sandbox/authentication', teamId: 'navigation-test', publicBaseUrls: { spClient: '', pcmUi: '' },
        consents: [{ id: 'consent-navigation', status, requesterName: 'Doctor',
            serviceName: 'Demo service', parentOrgName: 'Parent' }]
    });
}

test('active Consents expose a working details link for source simulation', () => {
    assert.match(renderRegistry('active'), /href="\/ui\/approve\/consent-navigation"[^>]*>View Consent<\/a>/);
});

test('pending Consents retain ordinary Review navigation', () => {
    assert.match(renderRegistry('proposed'), /href="\/ui\/approve\/consent-navigation"[^>]*>Review<\/a>/);
});

test('inactive and terminal Consents remain navigable for read-only inspection', () => {
    for (const status of ['inactive', 'rejected', 'entered-in-error']) {
        assert.match(renderRegistry(status), /href="\/ui\/approve\/consent-navigation"[^>]*>View Consent<\/a>/);
    }
});
