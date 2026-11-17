'use strict';

/** Qualification chooses two distinct decisions: the literal built-in wildcard and a restrictive manual grant. */
const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
const DEFAULT_SCOPE = 'patient/*.rs';
const MANUAL_SCOPE = ['Patient', 'Observation', 'DiagnosticReport', 'Condition'].map(type => `patient/${type}.rs?${V}`).join(' ');

/** Review the actual default, then explicitly choose the separate manual scope when requested. */
async function selectDemoApproval(page, expect, manual = false) {
    const authored = page.locator('#scope-service-provided');
    await expect(authored).toBeChecked();
    const exact = await authored.getAttribute('data-scope-value');
    expect(exact).toBe(DEFAULT_SCOPE);
    if (manual) {
        await page.locator('[data-alternative-permissions] > summary').click();
        await page.locator('#scope-custom').check(); await page.locator('#custom-scope').fill(MANUAL_SCOPE);
        await expect(page.locator('#scope-custom')).toBeChecked(); await expect(page.locator('#custom-scope')).toHaveValue(MANUAL_SCOPE);
        await expect(authored).toHaveAttribute('data-scope-value', DEFAULT_SCOPE);
    }
    return manual ? MANUAL_SCOPE : exact;
}
module.exports = { DEFAULT_SCOPE, MANUAL_SCOPE, selectDemoApproval };
