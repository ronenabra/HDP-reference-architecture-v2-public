'use strict';
/** Explicit-user clipboard operations with selection-preserving compatibility copy. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PCM_LOG_CLIPBOARD = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
    /** Copy complete text via the native copy event; always restore reading state. */
    function legacyCopy(document, text) {
        const active = document.activeElement, selection = document.getSelection();
        const ranges = Array.from({ length: selection?.rangeCount || 0 }, (_, i) => selection.getRangeAt(i).cloneRange());
        const inputSelection = active && typeof active.selectionStart === 'number'
            ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
        const scroll = [];
        for (let node = active; node; node = node.parentElement) scroll.push([node, node.scrollTop, node.scrollLeft]);
        const view = document.defaultView, x = view?.scrollX, y = view?.scrollY;
        const area = document.createElement('textarea');
        area.value = text; area.readOnly = true; area.setAttribute('aria-label', 'Temporary copy text');
        area.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;';
        // The event supplies original CR/LF, avoiding textarea value normalization.
        const supply = event => { event.clipboardData.setData('text/plain', text); event.preventDefault(); };
        try {
            // An open native dialog makes body siblings inert. Keep its copy
            // textarea inside that dialog so compatible copy can receive focus.
            (active?.closest?.('dialog[open]') || document.body).append(area); area.focus({ preventScroll: true }); area.select();
            document.addEventListener('copy', supply);
            return document.execCommand?.('copy') === true;
        } catch (_) { return false; }
        finally {
            document.removeEventListener('copy', supply); area.remove();
            if (active?.isConnected) active.focus({ preventScroll: true });
            if (inputSelection) active.setSelectionRange(...inputSelection);
            if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
            for (const [node, top, left] of scroll) { node.scrollTop = top; node.scrollLeft = left; }
            if (view) view.scrollTo(x, y);
        }
    }
    /** Create one transient controller; new attempts and context changes fence old results. */
    function create({ document, navigator, status, manual }) {
        let sequence = 0;
        function cancel() { sequence++; manual(null); }
        async function copy(text, { current = () => true, success = 'Text copied.' } = {}) {
            if (typeof text !== 'string') return 'unavailable';
            const attempt = ++sequence, valid = () => sequence === attempt && current();
            manual(null);
            status('Copying selected text…');
            let copied = false;
            try {
                if (typeof navigator.clipboard?.writeText === 'function') {
                    await navigator.clipboard.writeText(text); copied = true;
                }
            } catch (_) { /* Permissions and unfocused documents may reject native writes. */ }
            if (!valid()) return 'stale';
            if (!copied) copied = legacyCopy(document, text);
            if (!valid()) return 'stale';
            if (copied) { status(success); return 'copied'; }
            manual(text);
            status('Automatic copy was blocked. Use Select copy text, then your keyboard or touch Copy command.');
            return 'manual';
        }
        return { copy, cancel };
    }
    return { create, legacyCopy };
});
