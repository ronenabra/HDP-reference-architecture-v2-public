'use strict';

/** Browser component tests use only authored local assets and a fixture origin. */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const path = require('node:path');
const assetRoot = process.env.PCM_HELP_ASSETS || '/ui-assets';
const fixture = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Help fixture</title><link rel="stylesheet" href="/connectathon.css"><script defer src="/help-copy.js"></script><script defer src="/help.js"></script></head><body data-help-team="TEAM"><main><h1 data-help-key="doctor.page">Fixture</h1><section id="outer" data-help-key="doctor.manual"><button id="action" type="button" data-help-key="doctor.fetch" title="Useful original title" aria-describedby="original" onclick="window.actions++">Fetch</button></section><p id="original">Existing description</p><button id="disabled" disabled data-help-key="simulation.publicClientMtls" data-help-disabled-key="admin.simulation-locked">Disabled action</button><div id="dynamic"></div><select id="choice" data-help-key="doctor.identity"><option data-help-key="doctor.identity-registered">Registered</option><option data-help-key="doctor.identity-untrusted">Untrusted</option></select><button id="missing" data-help-key="missing.key">Unbound fixture</button></main><script>window.actions=0</script></body></html>`;

/** Route all fixture requests in-process: tests cannot call application APIs. */
async function load(page, { team = 'team-a', denyStorage = false } = {}) {
    if (denyStorage) await page.addInitScript(() => {
        Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Denied'); } });
    });
    await page.route('https://help.test/**', route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (['help.js', 'help-copy.js', 'admin-feedback.js', 'connectathon.css'].includes(name)) {
            return route.fulfill({ body: fs.readFileSync(path.join(assetRoot, name)), contentType: name.endsWith('.js') ? 'application/javascript' : 'text/css' });
        }
        return route.fulfill({ body: fixture.replace('TEAM', team), contentType: 'text/html' });
    });
    await page.goto('https://help.test/');
}

test('help component: nested targets, keyboard, disabled controls, safe copy and ordinary actions @smoke', async ({ page }) => {
    await load(page);
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    const tooltip = page.getByRole('tooltip');
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('.explain-affordance')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await page.locator('#action').focus();
    const normalFocus = await page.locator('#action').evaluate(node => {
        const style = getComputedStyle(node);
        return [style.outlineColor, style.outlineStyle, style.outlineWidth, style.outlineOffset];
    });
    await toggle.check();
    await page.evaluate(() => { window.PCM_HELP_COPY['doctor.fetch'].technical = '<img src=x onerror=window.injected=true>'; });
    await page.locator('#action').hover();
    await expect(tooltip).toContainText('Fetch data');
    await expect(tooltip).not.toContainText('Manual Sandbox');
    await expect(tooltip).toContainText('<img src=x onerror=window.injected=true>');
    await expect(tooltip.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await expect(page.locator('#action')).not.toHaveAttribute('title');
    await tooltip.hover();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await page.waitForTimeout(300);
    await expect(tooltip).toBeHidden();
    await page.keyboard.press('Tab');
    await page.locator('#action').focus();
    await expect(tooltip).toBeVisible();
    expect(await page.locator('#action').evaluate(node => {
        const style = getComputedStyle(node);
        return [style.outlineColor, style.outlineStyle, style.outlineWidth, style.outlineOffset];
    })).toEqual(normalFocus);
    await expect(page.locator('#action')).toHaveAttribute('aria-describedby', 'original pcm-help-tooltip');
    await page.keyboard.press('Escape');
    await expect(page.locator('#action')).toHaveAttribute('aria-describedby', 'original');
    await page.locator('[data-help-for="simulation.publicClientMtls"]').focus();
    await expect(tooltip).toContainText('strict');
    await expect(page.locator('#disabled')).toBeDisabled();
    await page.evaluate(() => {
        const label = document.createElement('label');
        label.htmlFor = 'disabled';
        label.dataset.helpKey = 'simulation.publicClientMtls';
        label.textContent = 'Disabled input label';
        document.getElementById('disabled').before(label);
    });
    await page.locator('label[for="disabled"] + .explain-affordance').focus();
    await expect(tooltip).toContainText('strict');
    await expect.poll(() => page.evaluate(() => window.actions)).toBe(0);
    await page.keyboard.press('Escape');
    await page.locator('#action').click();
    await expect.poll(() => page.evaluate(() => window.actions)).toBe(1);
    await page.locator('#choice').selectOption({ label: 'Untrusted' });
    await page.locator('#choice').focus();
    await expect(tooltip).toContainText('Untrusted transport');
    await page.locator('#missing').focus();
    await expect(tooltip).toBeHidden();
    await toggle.uncheck();
    await expect(page.locator('.explain-affordance')).toHaveCount(0);
    await expect(page.locator('#action')).toHaveAttribute('title', 'Useful original title');
    await expect(page.locator('#outer')).not.toHaveAttribute('tabindex');
});

test('help component: keyboard help, viewport, dynamic cleanup and no application mutations', async ({ page }) => {
    await load(page, { denyStorage: true });
    await page.setViewportSize({ width: 390, height: 500 });
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    await toggle.check();
    await page.locator('[data-help-key="doctor.fetch"]').focus();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    const box = await tooltip.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(500);
    await expect.poll(() => page.evaluate(() => window.actions)).toBe(0);
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await expect(tooltip).toBeHidden();
    await page.evaluate(() => {
        const target = document.getElementById('dynamic');
        for (let i = 0; i < 500; i++) {
            const row = document.createElement('p');
            row.dataset.helpKey = 'logs.message';
            row.textContent = `Recorded event ${i}`;
            target.append(row);
        }
    });
    await expect(page.locator('[data-help-key="logs.message"]')).toHaveCount(500);
    await page.locator('[data-help-key="logs.message"]').first().focus();
    await expect(tooltip).toBeVisible();
    // Conditional content can disappear without being removed from the DOM.
    await page.evaluate(() => { document.getElementById('dynamic').hidden = true; });
    await expect(tooltip).toBeHidden();
    await expect(page.locator('[data-help-key="logs.message"][tabindex]')).toHaveCount(0);
    await page.evaluate(() => { document.getElementById('dynamic').hidden = false; });
    await expect(page.locator('[data-help-key="logs.message"]')).toHaveCount(500);
    await page.locator('[data-help-key="logs.message"]').first().focus();
    await expect(tooltip).toBeVisible();
    await page.evaluate(() => { document.querySelector('#dynamic p').dataset.helpKey = 'common.feedback'; });
    await expect(tooltip).toBeHidden();
    await expect(page.locator('[data-help-key="logs.message"]')).toHaveCount(499);
    await page.locator('[data-help-key="common.feedback"]').blur();
    await page.locator('[data-help-key="common.feedback"]').focus();
    await expect(tooltip).toContainText('current condition');
    await page.evaluate(() => document.getElementById('dynamic').replaceChildren());
    await expect(tooltip).toBeHidden();
    await expect(page.locator('[data-help-key="logs.message"][tabindex]')).toHaveCount(0);
    for (let i = 0; i < 4; i++) { await toggle.uncheck(); await toggle.check(); }
    await expect(page.locator('[data-help-key="doctor.fetch"]')).toHaveCount(1);
    await page.evaluate(() => {
        const table = document.createElement('table');
        const row = table.insertRow();
        row.addEventListener('click', () => { window.actions++; });
        const cell = row.insertCell();
        cell.id = 'updated-log-cell';
        cell.dataset.helpKey = 'logs.message';
        cell.textContent = 'First message';
        document.getElementById('dynamic').append(table);
    });
    const cellHelp = page.locator('#updated-log-cell');
    await expect(cellHelp).toHaveCount(1);
    // A cell rerender keeps its own keyboard target.
    await page.locator('#updated-log-cell').evaluate(node => { node.textContent = 'Refreshed message'; });
    await expect(cellHelp).toHaveCount(1);
    await cellHelp.focus();
    await expect(tooltip).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.actions)).toBe(0);
});

test('help component: opening long copy never covers or swallows an ordinary submit click @smoke', async ({ page }) => {
    await load(page);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.evaluate(() => {
        window.PCM_HELP_COPY['doctor.request'].body = 'A long explanation that must remain scrollable. '.repeat(40);
        const form = document.createElement('form');
        form.innerHTML = '<button type="submit" id="submit-probe" data-help-key="doctor.request" style="position:fixed;top:65vh;left:10px;width:200px;height:40px">Submit probe</button>';
        form.addEventListener('submit', event => { event.preventDefault(); window.actions++; });
        document.body.append(form);
    });
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('#submit-probe').click();
    await expect.poll(() => page.evaluate(() => window.actions)).toBe(1);
    const target = await page.locator('#submit-probe').boundingBox();
    const box = await page.getByRole('tooltip').boundingBox();
    expect(box).not.toBeNull();
    expect(box.y + box.height <= target.y || box.y >= target.y + target.height).toBe(true);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(500);
    expect(await page.getByRole('tooltip').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
});

test('help component: nearly full-height forms cannot cover their submit control @smoke', async ({ page }) => {
    await load(page);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.evaluate(() => {
        const form = document.createElement('form');
        // Fractional layout leaves less than a pixel below the form after the
        // tooltip margin: its padding must not be clamped over the button.
        form.style.cssText = 'position:fixed;top:0;bottom:16.5625px;left:8px;width:374px';
        form.innerHTML = '<button type="submit" id="tall-submit-probe" data-help-key="pcm.approve" style="position:absolute;bottom:0;left:0;width:220px;height:40px">Approve probe</button>';
        form.addEventListener('submit', event => { event.preventDefault(); window.actions++; });
        document.body.append(form);
    });
    await page.locator('#tall-submit-probe').click();
    await expect.poll(() => page.evaluate(() => window.actions)).toBe(1);
    const target = await page.locator('#tall-submit-probe').boundingBox();
    const box = await page.getByRole('tooltip').boundingBox();
    expect(box).not.toBeNull();
    expect(box.y + box.height <= target.y || box.y >= target.y + target.height).toBe(true);
});

test('help component: inactive Consent warning badges retain readable contrast @smoke', async ({ page }) => {
    await load(page);
    await page.evaluate(() => {
        const badge = document.createElement('span');
        badge.id = 'inactive-consent-probe';
        badge.className = 'badge bg-warning';
        badge.textContent = 'inactive';
        document.querySelector('main').append(badge);
    });
    const result = await new AxeBuilder({ page }).include('#inactive-consent-probe').withRules(['color-contrast']).analyze();
    expect(result.violations).toEqual([]);
});

test('help component: field explanations leave the next submit control reachable @smoke', async ({ page }) => {
    for (const width of [390, 1200]) {
        await load(page);
        await page.setViewportSize({ width, height: 500 });
        await page.evaluate(() => {
            const form = document.createElement('form');
            form.style.cssText = 'position:fixed;top:180px;left:8px;width:300px';
            form.innerHTML = '<input id="field-probe" data-help-key="admin.password" style="display:block;width:100%"><button id="next-submit-probe" type="submit" data-help-key="admin.login">Submit next</button>';
            form.addEventListener('submit', event => { event.preventDefault(); window.actions++; });
            document.body.append(form);
        });
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await page.locator('#field-probe').fill('synthetic');
        await expect(page.getByRole('tooltip')).toBeVisible();
        await page.locator('#next-submit-probe').click();
        await expect.poll(() => page.evaluate(() => window.actions)).toBe(1);
    }
});

test('help component: preference is scoped to team and origin, malformed storage defaults off', async ({ page }) => {
    await load(page);
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    await page.evaluate(() => sessionStorage.setItem('pcm-explain:https://help.test:team-a', '{bad json'));
    await page.reload();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.reload();
    await expect(toggle).toBeChecked();
    await page.unrouteAll();
    await load(page, { team: 'team-b' });
    await expect(toggle).not.toBeChecked();
    expect(await page.evaluate(() => Object.keys(sessionStorage).sort())).toEqual([
        'pcm-explain:https://help.test:team-a', 'pcm-explain:https://help.test:team-b'
    ]);
});


test('help component: affordance descriptions, dismissal focus, pointer exit and explicit dismissal @smoke', async ({ page }) => {
    await load(page);
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    await toggle.check();
    const button = page.locator('#action');
    const disabledHelp = page.locator('[data-help-for="simulation.publicClientMtls"]');
    const tooltip = page.getByRole('tooltip');
    await button.evaluate(node => node.setAttribute('aria-describedby', 'original'));
    await button.focus();
    await expect(button).toHaveAttribute('aria-describedby', 'original pcm-help-tooltip');
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-describedby', 'original');
    await expect(tooltip).toBeHidden();
    await page.waitForTimeout(300);
    await expect(tooltip).toBeHidden();
    await disabledHelp.focus();
    await expect(disabledHelp).toHaveAttribute('aria-describedby', 'pcm-help-tooltip');
    await expect(page.locator('#disabled')).toBeDisabled();
    await page.getByRole('button', { name: 'Dismiss explanation' }).focus();
    await page.keyboard.press('Escape');
    await expect(disabledHelp).toBeFocused();
    await expect(disabledHelp).not.toHaveAttribute('aria-describedby');
    await expect(tooltip).toBeHidden();
    await button.focus();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await page.mouse.move(800, 400);
    await page.locator('#action').hover();
    await expect(tooltip).toBeVisible();
    await tooltip.hover();
    const viewport = page.viewportSize();
    await page.mouse.move(viewport.width - 1, viewport.height - 1);
    await expect(tooltip).toBeHidden();
    expect(await page.evaluate(() => window.actions)).toBe(0);
});

/** Compare real geometry, including table cells and inline controls, across toggles. */
test('help component: hover adds no visible markers or layout shifts @smoke', async ({ page }) => {
    await load(page);
    await page.evaluate(() => {
        document.getElementById('dynamic').innerHTML = '<table><tr><td data-help-key="logs.message">Message</td><td>Adjacent cell</td></tr></table>';
    });
    const geometry = () => page.locator('main, main *').evaluateAll(nodes => nodes
        .filter(node => !node.classList.contains('explain-affordance'))
        .map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    const before = await geometry();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    expect(await geometry()).toEqual(before);
    expect(await page.locator('.explain-affordance').evaluateAll(nodes => nodes.every(node =>
        node.textContent !== '?' && getComputedStyle(node).clipPath === 'inset(50%)'))).toBe(true);
    await page.locator('#action').hover();
    await expect(page.getByRole('tooltip')).toContainText('Fetch data');
    expect(await geometry()).toEqual(before);
});

/** Use the actual server renderer so Admin markup cannot drift from this regression. */
test('help component: server-rendered Admin header toggle is visible and unique @smoke', async ({ page }) => {
    const html = fs.readFileSync(process.env.PCM_HELP_ADMIN_FIXTURE || '/admin-fixture.html', 'utf8');
    await page.route('https://admin.test/**', route => {
        const name = new URL(route.request().url()).pathname.split('/').pop();
        if (['help.js', 'help-copy.js', 'admin-feedback.js', 'connectathon.css'].includes(name)) {
            return route.fulfill({ body: fs.readFileSync(path.join(assetRoot, name)), contentType: name.endsWith('.js') ? 'application/javascript' : 'text/css' });
        }
        if (name === 'connectathon.js') return route.fulfill({ body: '', contentType: 'application/javascript' });
        return route.fulfill({ body: html, contentType: 'text/html' });
    });
    for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('https://admin.test/admin');
        const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
        await expect(toggle).toHaveCount(1);
        await expect(toggle).toBeInViewport();
        await toggle.check();
        await page.locator('[data-help-key="admin.deployment"]').hover();
        await expect(page.getByRole('tooltip')).toBeVisible();
        await page.reload();
        await expect(toggle).toBeChecked();
    }
});

/** Tooltip mutations must never rescan a large, continuously updating log table. */
test('help component: large log updates keep hover responsive without full rescans @smoke', async ({ page }, testInfo) => {
    await load(page);
    await page.evaluate(() => {
        document.getElementById('dynamic').innerHTML = '<table><tbody>' + Array.from({ length: 1500 }, (_, i) =>
            `<tr><td data-help-key="logs.message">Log ${i}</td><td data-help-key="logs.time">Time</td></tr>`).join('') + '</tbody></table>';
    });
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await expect(page.locator('[data-help-key="logs.message"]')).toHaveCount(1500);
    await page.evaluate(() => {
        window.fullScans = 0;
        document.querySelector('#dynamic td').addEventListener('pointerover', () => { window.hoverStarted = performance.now(); });
        new MutationObserver(() => {
            if (window.hoverStarted && window.hoverLatency === undefined && !document.getElementById('pcm-help-tooltip').hidden) {
                window.hoverLatency = performance.now() - window.hoverStarted;
            }
        }).observe(document.getElementById('pcm-help-tooltip'), { attributes: true, attributeFilter: ['hidden'] });
        const original = Element.prototype.querySelectorAll;
        Element.prototype.querySelectorAll = function(selector) {
            if (this === document.body) window.fullScans++;
            return original.call(this, selector);
        };
        const cell = document.querySelector('#dynamic tr:last-child td');
        window.refresh = setInterval(() => { cell.textContent = 'Updated log'; }, 100);
    });
    await page.locator('#dynamic td').first().hover();
    // Measure in a quiet observation window: repeated remote assertions over
    // this large DOM can starve Firefox's event loop and delay the timer itself.
    // The application continues refreshing every 100ms throughout the window.
    await page.waitForTimeout(1100);
    const latency = await page.evaluate(() => window.hoverLatency);
    await testInfo.attach('hover-latency', { body: JSON.stringify({ rows: 1500, refreshMs: 100, latencyMs: latency }), contentType: 'application/json' });
    expect(latency).toBeLessThan(1000);
    await expect(page.locator('#pcm-help-tooltip')).toContainText('Message column');
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => window.fullScans)).toBe(0);
    await page.evaluate(() => clearInterval(window.refresh));
    await expect(page.locator('[data-help-key="logs.message"]')).toHaveCount(1500);
});

test('opted-in workflow action help supports native touch without submitting @smoke', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
        await load(page);
        await page.evaluate(() => { document.body.classList.add('workflow-page'); document.querySelector('#action').setAttribute('data-help-proxy', ''); });
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const help = page.locator('[data-help-for="doctor.fetch"]');
        await expect(help).toBeVisible(); await help.tap();
        await expect(page.getByRole('tooltip')).toContainText('Fetch');
        expect(await page.evaluate(() => window.actions)).toBe(0);
        await page.getByRole('button', { name: 'Dismiss explanation', exact: true }).tap();
        await page.locator('#action').tap(); expect(await page.evaluate(() => window.actions)).toBe(1);
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await expect(help).toHaveCount(0);
    } finally { await context.close(); }
});

/** Long mobile content keeps dismissal reachable and remains anchored to the field. */
test('help component: long field help has initially visible sticky close and stays nearby at 200 percent @smoke', async ({ page }) => {
    await load(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
        const form = document.createElement('form');
        form.style.cssText = 'height:3000px;padding-top:220px';
        form.innerHTML = '<label for="nearby-field">Current field</label><input id="nearby-field" data-help-key="services.history"><button id="following-action" type="button" onclick="window.actions++">Next action</button>';
        document.querySelector('main').append(form);
        window.PCM_HELP_COPY['services.history'].body += ' Long readable explanation.'.repeat(100);
    });
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    for (const zoom of ['100%', '200%']) {
        await page.evaluate(value => document.body.style.zoom = value, zoom);
        const field = page.locator('#nearby-field');
        await field.scrollIntoViewIfNeeded(); await field.focus();
        const tooltip = page.getByRole('tooltip'), close = tooltip.getByRole('button', { name: 'Dismiss explanation' });
        await expect(tooltip).toBeVisible(); await expect(close).toBeInViewport({ ratio: 1 });
        const bounds = await tooltip.boundingBox(), target = await field.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
        expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(845);
        expect(Math.min(Math.abs(bounds.y + bounds.height - target.y), Math.abs(bounds.y - target.y - target.height))).toBeLessThanOrEqual(10);
        await tooltip.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(close).toBeInViewport({ ratio: 1 });
        await close.focus(); await page.keyboard.press('Escape');
        await expect(field).toBeFocused(); await expect(tooltip).toBeHidden();
        await page.locator('#following-action').click(); expect(await page.evaluate(() => window.actions)).toBe(zoom === '100%' ? 1 : 2);
        await field.blur();
    }
});

/** A changing disabled state must update proxies without unlocking the real action. */
test('help component: dynamically disabled action gains reachable help and loses proxy when enabled @smoke', async ({ page }) => {
    await load(page);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('#action').evaluate(node => { node.disabled = true; });
    const help = page.locator('[data-help-for="doctor.fetch"]');
    await expect(help).toHaveCount(1); await help.focus();
    await expect(page.getByRole('tooltip')).toContainText('Fetch data');
    await expect(page.locator('#action')).toBeDisabled();
    await page.keyboard.press('Escape'); expect(await page.evaluate(() => window.actions)).toBe(0);
    await page.locator('#action').evaluate(node => { node.disabled = false; });
    await expect(help).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    await expect(page.locator('.explain-affordance')).toHaveCount(0);
});

/** Open help survives real viewport/scroll changes and dismisses a detached binding. */
test('help component: open popup follows resize and scroll and dismisses replaced control @smoke', async ({ page }) => {
    await load(page);
    await page.setViewportSize({ width: 800, height: 700 });
    await page.evaluate(() => {
        document.body.style.minHeight = '3000px';
        const input = document.createElement('input'); input.id = 'moving-field'; input.dataset.helpKey = 'services.history';
        input.style.cssText = 'position:fixed;top:220px;left:20px;width:250px;height:44px';
        document.body.append(input); window.PCM_HELP_COPY['services.history'].body += ' Long scrollable explanation.'.repeat(80);
    });
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('#moving-field').focus();
    const popup = page.getByRole('tooltip'), close = popup.getByRole('button', { name: 'Dismiss explanation' });
    for (const viewport of [{ width: 390, height: 500 }, { width: 800, height: 700 }]) {
        await page.setViewportSize(viewport); await expect(popup).toBeVisible(); await expect(close).toBeInViewport({ ratio: 1 });
        const bounds = await popup.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
        await popup.evaluate(node => { node.scrollTop = 100; });
        await page.evaluate(() => window.scrollBy(0, 100)); await expect(close).toBeInViewport({ ratio: 1 });
        expect(await popup.evaluate(node => node.scrollTop)).toBe(100);
    }
    await page.locator('#moving-field').evaluate(node => node.replaceWith(node.cloneNode()));
    await expect(popup).toBeHidden();
    await page.locator('#moving-field').focus(); await expect(popup).toBeVisible();
    await close.focus(); await page.keyboard.press('Escape'); await expect(page.locator('#moving-field')).toBeFocused();
    expect(await page.evaluate(() => window.actions)).toBe(0);
});
