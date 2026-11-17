'use strict';
/** Audit meaningful controls using the same Help target contract as the shared controller. */
async function assertBindings(page, expect) {
    const missing = await page.locator('a,button,input:not([type="hidden"]),select,textarea').evaluateAll(nodes => {
        const copy = window.PCM_HELP_COPY;
        const known = key => Object.hasOwn(copy, key) && typeof copy[key]?.title === 'string' && Boolean(copy[key].title.trim()) && typeof copy[key]?.body === 'string' && Boolean(copy[key].body.trim());
        return nodes.filter(node => {
            // Only the controller's own dismiss action is intentionally unbound.
            if (node.matches('#pcm-help-tooltip > button.explain-close')) return false;
            const proxy = node.closest('[data-help-for]');
            const target = proxy ? proxy.helpTarget : node.closest('[data-help-key]');
            if (!target?.isConnected || !known(target.dataset.helpKey)) return true;
            // A data-help-for string alone cannot provide focus/click Help.
            if (proxy && (!proxy.classList.contains('explain-affordance') || proxy.dataset.helpFor !== target.dataset.helpKey)) return true;
            const option = target.tagName === 'SELECT' && !target.hasAttribute('data-help-options') ? target.selectedOptions[0]?.dataset.helpKey : null;
            return !known(option || target.dataset.helpKey);
        }).map(node => ({ tag: node.tagName, id: node.id, name: node.getAttribute('name'), text: node.textContent.trim().slice(0, 70) }));
    });
    expect(missing).toEqual([]);
    const unknown = await page.locator('[data-help-key]').evaluateAll(nodes => nodes.map(node => node.dataset.helpKey)
        .filter(key => !Object.hasOwn(window.PCM_HELP_COPY, key) || typeof window.PCM_HELP_COPY[key]?.title !== 'string' || !window.PCM_HELP_COPY[key].title.trim()
            || typeof window.PCM_HELP_COPY[key]?.body !== 'string' || !window.PCM_HELP_COPY[key].body.trim()));
    expect(unknown).toEqual([]);
}

/** Select page content for focus Help, excluding the already-focused Explain control itself.
 * @param {object} page Owning Playwright page.
 * @returns {object} First authored page-content Help target locator.
 */
function firstPageHelpTarget(page) {
    return page.locator('[data-help-key]:not(input):not(.explain-toggle)')
        .filter({ hasNot: page.locator('input') }).first();
}

/** Wait for the existing controller before changing a server-rendered Explain checkbox.
 * @param {object} page Owning Playwright page.
 * @param {Function} expect Playwright assertion function.
 * @returns {Promise<void>} Resolves after the initialized controller enables Explain.
 */
async function enablePageHelp(page, expect) {
    await expect(page.locator('#pcm-help-tooltip')).toBeAttached();
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    await toggle.check();
    await expect(toggle).toBeChecked();
}

module.exports = { assertBindings, firstPageHelpTarget, enablePageHelp };
