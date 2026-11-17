'use strict';

/**
 * Wait for the real create command and its distinct rendered Consent identity.
 * Selection saves defer native form submission, so click completion alone does
 * not establish that the POST or redirected render has completed.
 * @param {object} page Playwright page owning the Doctor form.
 * @param {object} options Doctor origin and Playwright's retrying expect helper.
 * @returns {Promise<string>} The one newly created Consent ID.
 */
async function createConsent(page, { origin, expect }) {
    // Stored identity is distinct from the deliberately editable request override.
    const cards = page.locator('[data-consent-card]');
    const identifiers = () => cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-consent-card')));
    const before = await identifiers();
    const endpoint = new URL('/create-consent', origin).href;
    const [response] = await Promise.all([
        page.waitForResponse(value => value.url() === endpoint && value.request().method() === 'POST'),
        page.waitForEvent('domcontentloaded'),
        page.getByRole('button', { name: 'Create consent request', exact: true }).click()
    ]);
    if (response.status() !== 302) throw new Error(`Consent creation did not succeed: HTTP ${response.status()}`);
    await expect(page.getByText(/Consent request created\./)).toBeVisible();
    // The visible cohort can change when the patient changes. The server appends
    // the successful creation to its ordered store; do not count the old cohort.
    const created = (await identifiers()).at(-1);
    if (!created || before.includes(created)) throw new Error('Consent creation did not render one distinct new identity');
    return created;
}

module.exports = { createConsent };
