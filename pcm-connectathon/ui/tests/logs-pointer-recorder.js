'use strict';

/** Read-only event evidence for real browser pointer delivery. Instrumentation
 * never releases capture, injects pointer events, or changes resize state.
 */
async function installPointerRecorder(page) {
    await page.addInitScript(() => {
        const records = [];
        let latestPointerId = null;
        function state(pointerId = latestPointerId) {
            const splitter = document.getElementById('resizer');
            return { pointerId, hasPointerCapture: splitter && pointerId !== null ? splitter.hasPointerCapture(pointerId) : false,
                controllerPointerId: typeof dragPointerId === 'undefined' ? null : dragPointerId,
                resizing: Boolean(splitter?.classList.contains('resizing')),
                value: splitter?.getAttribute('aria-valuenow'), minimum: splitter?.getAttribute('aria-valuemin'),
                activeElement: document.activeElement?.id || null, windowFocused: document.hasFocus(), visibility: document.visibilityState };
        }
        function record(event, phase) {
            if (typeof event.pointerId === 'number') latestPointerId = event.pointerId;
            records.push({ kind: 'event', type: event.type, phase, trusted: event.isTrusted, time: performance.now(),
                target: event.target?.id || event.target?.nodeName || 'window', pointerType: event.pointerType || null,
                button: event.button ?? null, buttons: event.buttons ?? null, clientX: event.clientX ?? null, clientY: event.clientY ?? null,
                ...state() });
            if (records.length > 2048) records.shift();
        }
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture', 'mousedown', 'mousemove', 'mouseup', 'blur']) {
            window.addEventListener(type, event => record(event, 'capture-before-controller'), true);
            window.addEventListener(type, event => record(event, 'bubble-after-controller'));
        }
        window.qaPointerEvidence = records;
        window.qaPointerCheckpoint = label => { const result = { kind: 'checkpoint', label, time: performance.now(), ...state() }; records.push(result); return result; };
    });
}

async function checkpointPointer(page, label) {
    return page.evaluate(label => window.qaPointerCheckpoint?.(label), label);
}

async function attachPointerEvidence(page, testInfo) {
    const records = await page.evaluate(() => window.qaPointerEvidence || []);
    if (records.length) await testInfo.attach('pointer-capture-lifecycle', { body: JSON.stringify({ browser: testInfo.project.name, viewport: page.viewportSize(), records }, null, 2), contentType: 'application/json' });
}
module.exports = { installPointerRecorder, checkpointPointer, attachPointerEvidence };
