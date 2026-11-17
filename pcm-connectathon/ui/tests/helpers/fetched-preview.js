'use strict';

/** Read the bounded fetched result separately from the saved permission snapshot. */

/**
 * Require one actual FHIR result in the existing named preview region of this Consent card.
 * @param {object} card Playwright locator for the exact stored Consent card.
 * @returns {Promise<object>} The fetched first-page Bundle; unavailable or malformed evidence rejects.
 */
async function readFetchedPreview(card) {
    const preview = card.getByRole('region', { name: 'Fetched FHIR data', exact: true });
    if (await preview.count() !== 1) throw new Error('Fetched FHIR preview is unavailable or ambiguous');
    const values = await preview.locator('pre').allTextContents();
    if (values.length !== 1) throw new Error('Fetched FHIR result is unavailable or ambiguous');
    let result;
    try { result = JSON.parse(values[0]); } catch (_) { throw new Error('Fetched FHIR result is malformed'); }
    if (result?.resourceType !== 'Bundle' || !Array.isArray(result.entry)) throw new Error('Fetched FHIR result is not a preview Bundle');
    return result;
}

module.exports = { readFetchedPreview };
