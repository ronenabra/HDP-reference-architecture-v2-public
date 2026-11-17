'use strict';

/** Local, delegated contextual help. Only its team/origin-scoped preference is stored. */
document.addEventListener('DOMContentLoaded', () => {
    const copy = window.PCM_HELP_COPY;
    const team = document.body.dataset.helpTeam;
    if (!copy || !team) return;
    const preference = `pcm-explain:${location.origin}:${team}`;
    // Admin supplies a visible header control; other pages use the shared default.
    let toggleLabel = document.querySelector('.explain-toggle');
    if (!toggleLabel) {
        toggleLabel = document.createElement('label');
        toggleLabel.className = 'explain-toggle';
        toggleLabel.dataset.helpKey = 'common.explain';
        const input = document.createElement('input');
        input.type = 'checkbox';
        toggleLabel.append(input, document.createTextNode(' Explain this page'));
        document.body.prepend(toggleLabel);
    }
    // Body-level placement anchors the compact overlay to the browser viewport.
    // Logs and Admin keep it after the last link in their header navigation.
    const helpHost = toggleLabel.closest('main') || document.body;
    const inlineNavigation = document.querySelector('.logs-page > .sandbox-header .sandbox-navigation, .local-logs-page > .sandbox-header .sandbox-navigation, .admin-workspace > .sandbox-header .sandbox-navigation');
    const explainBar = document.createElement('div');
    explainBar.className = inlineNavigation ? 'explain-bar explain-bar-inline' : 'explain-bar';
    explainBar.setAttribute('role', 'region');
    explainBar.setAttribute('aria-label', 'Page explanations');
    if (inlineNavigation) inlineNavigation.append(explainBar);
    else document.body.prepend(explainBar);
    explainBar.append(toggleLabel);
    const toggle = toggleLabel.querySelector('input[type="checkbox"]');
    // A neutral host supports tooltip semantics; aside cannot take this role.
    const tooltip = document.createElement('div');
    tooltip.id = 'pcm-help-tooltip';
    tooltip.className = 'explain-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    // Authored controls inside main keep their dynamic explanation in the same
    // landmark. Pages using the body-level default retain their existing host.
    helpHost.append(tooltip);
    const affordances = new Map();
    const titles = new Map();
    const tabStops = new Map();
    let enabled = false;
    let active = null;
    let activeBindingKey = null;
    let activeTrigger = null;
    let previousDescription = null;
    let activator = null;
    let activatorDescription = null;
    let restoringFocus = false;
    let helpWasOpenOnPointerDown = false;
    let suppressHover = false;
    let timer;
    let observer;
    const targetFor = node => node?.closest?.('[data-help-key]');
    const isHelp = node => tooltip.contains(node) || node?.closest?.('[data-help-for]');

    /** Restore target accessibility attributes exactly when help is dismissed. */
    function dismiss() {
        suppressHover = true;
        clearTimeout(timer);
        const focusWasInside = tooltip.contains(document.activeElement);
        const returnTarget = activator || active;
        if (activator && activator !== active) {
            if (activatorDescription === null) activator.removeAttribute('aria-describedby');
            else activator.setAttribute('aria-describedby', activatorDescription);
        }
        if (active) {
            active.classList.remove('explain-target');
            if (previousDescription === null) active.removeAttribute('aria-describedby');
            else active.setAttribute('aria-describedby', previousDescription);
        }
        active = null;
        activeBindingKey = null;
        activeTrigger = null;
        activator = null;
        tooltip.hidden = true;
        tooltip.replaceChildren();
        if (focusWasInside) {
            const destination = returnTarget?.isConnected && !returnTarget.disabled && returnTarget.tabIndex >= 0
                ? returnTarget : toggle;
            // Returning focus must not reopen the explanation through focusin.
            restoringFocus = true;
            try { destination.focus({ preventScroll: true }); }
            finally { restoringFocus = false; }
        }
    }
    /** Keep the full scrollable explanation inside even a zoomed mobile viewport. */
    function position() {
        if (!active) return;
        const targetRect = active.getBoundingClientRect();
        const readingPosition = tooltip.scrollTop;
        // Anchor to this control, never the outside of its potentially page-long
        // form. The proxy belongs to the same label and remains tappable.
        // Focus/hover on the ordinary action must also leave its adjacent help
        // proxy reachable, including after a result disables the action.
        const proxy = activator || affordances.get(active);
        const proxyRect = proxy?.isConnected ? proxy.getBoundingClientRect() : null;
        const rect = proxyRect && proxyRect.width > 1
            ? { top: Math.min(targetRect.top, proxyRect.top), bottom: Math.max(targetRect.bottom, proxyRect.bottom),
                left: Math.min(targetRect.left, proxyRect.left), right: Math.max(targetRect.right, proxyRect.right) }
            : targetRect;
        const viewport = window.visualViewport;
        const vw = viewport?.width || document.documentElement.clientWidth;
        const vh = viewport?.height || document.documentElement.clientHeight;
        const vx = viewport?.offsetLeft || 0, vy = viewport?.offsetTop || 0;
        // CSS zoom is used by maintained accessibility fixtures. Keep physical
        // viewport bounds while retaining the enlarged font and tap targets.
        const scale = tooltip.getBoundingClientRect().width / tooltip.offsetWidth || 1;
        tooltip.style.maxWidth = `${Math.max(0, vw - 16) / scale}px`;
        tooltip.style.maxHeight = `${Math.max(0, vh - 16) / scale}px`;
        const width = tooltip.getBoundingClientRect().width;
        let height = tooltip.getBoundingClientRect().height;
        const right = rect.right + 8, left = rect.left - width - 8;
        let x, y;
        if (right + width <= vx + vw - 8 || left >= vx + 8) {
            x = right + width <= vx + vw - 8 ? right : left;
            y = Math.max(vy + 8, Math.min(rect.top, vy + vh - height - 8));
        } else {
            const above = Math.max(0, rect.top - vy - 16);
            const below = Math.max(0, vy + vh - rect.bottom - 16);
            // Prefer above fields so the next input/action remains unobscured.
            const placeAbove = above >= Math.min(height, 120) || above >= below;
            const available = placeAbove ? above : below;
            if (available >= 80) {
                tooltip.style.maxHeight = `${available / scale}px`;
                height = tooltip.getBoundingClientRect().height;
            }
            x = Math.max(vx + 8, Math.min(rect.left, vx + vw - width - 8));
            y = placeAbove ? rect.top - height - 8 : rect.bottom + 8;
            y = Math.max(vy + 8, Math.min(y, vy + vh - height - 8));
        }
        tooltip.style.left = `${x / scale}px`;
        tooltip.style.top = `${y / scale}px`;
        // WebKit can reset scroll when temporary measurement bounds grow. Restore
        // the reader's position after positioning; the browser clamps if needed.
        tooltip.scrollTop = readingPosition;
    }
    /** Select-option keys override the select's general explanation when authored. */
    function show(target, source = null, trigger = 'focus') {
        if (!enabled || !target?.isConnected) return;
        const selectedKey = target.tagName === 'SELECT' && !target.hasAttribute('data-help-options') ? target.selectedOptions[0]?.dataset.helpKey : null;
        const entry = copy[selectedKey || target.dataset.helpKey];
        if (!entry) { dismiss(); return; }
        dismiss();
        active = target;
        activeBindingKey = target.dataset.helpKey;
        activeTrigger = trigger;
        activator = source;
        activatorDescription = source?.getAttribute('aria-describedby') ?? null;
        if (source && source !== target) {
            source.setAttribute('aria-describedby', `${activatorDescription || ''} ${tooltip.id}`.trim());
        }
        previousDescription = target.getAttribute('aria-describedby');
        target.setAttribute('aria-describedby', `${previousDescription || ''} ${tooltip.id}`.trim());
        target.classList.add('explain-target');
        const heading = document.createElement('strong');
        heading.textContent = entry.title;
        const body = document.createElement('p');
        body.textContent = entry.body;
        // The first sticky control stays visible while long explanations scroll.
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'explain-close';
        close.textContent = 'Dismiss explanation';
        close.addEventListener('click', dismiss, { once: true });
        tooltip.append(close, heading, body);
        if (target.dataset.helpContext) {
            const context = document.createElement('p');
            context.textContent = target.dataset.helpContext;
            tooltip.append(context);
        }
        if (target.tagName === 'SELECT' && target.hasAttribute('data-help-options')) {
            const options = document.createElement('ul');
            for (const option of target.options) {
                const explanation = copy[option.dataset.helpKey];
                const item = document.createElement('li');
                item.textContent = `${option.textContent.trim()}: ${explanation?.body || 'Configured requester option; rejection depends on effective checks and credentials.'}`;
                options.append(item);
            }
            tooltip.append(options);
        }
        const control = target.control || target;
        const disabledHelp = control.disabled && copy[control.dataset.helpDisabledKey];
        if (disabledHelp) {
            const reason = document.createElement('p');
            reason.textContent = disabledHelp.body;
            tooltip.append(reason);
        }
        if (entry.technical) {
            const detail = document.createElement('details');
            detail.className = 'explain-technical';
            const summary = document.createElement('summary');
            summary.textContent = 'Technical details';
            const text = document.createElement('p');
            text.textContent = entry.technical;
            detail.append(summary, text);
            detail.addEventListener('toggle', position);
            tooltip.append(detail);
        }

        tooltip.hidden = false;
        position();
    }
    /** Reconcile dynamic targets with bounded nodes and no per-target listeners. */
    function reconcile(roots = [document.body], detached = []) {
        const matching = selector => roots.flatMap(root => [
            ...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)
        ]);
        observer.disconnect();
        // Reconcile only bindings in changed/removed subtrees, not every stored
        // tab stop on every refreshed cell. Detached roots retain their children.
        const candidates = new Set([...roots, ...detached].flatMap(root =>
            [root, ...root.querySelectorAll('[data-help-key]')]));
        for (const target of candidates) {
            const button = affordances.get(target);
            if (!button) continue;
            if (!target.isConnected || !button.isConnected || !enabled || target.closest('[hidden]')
                || !copy[target.dataset.helpKey] || button.dataset.helpFor !== target.dataset.helpKey
                || !(target.control || target).disabled && !target.hasAttribute('data-help-proxy')) {
                button.remove();
                affordances.delete(target);
            }
        }
        for (const target of candidates) {
            if (!tabStops.has(target)) continue;
            const previous = tabStops.get(target);
            if (!enabled || !target.isConnected || target.closest('[hidden]') || !copy[target.dataset.helpKey]) {
                if (previous === null) target.removeAttribute('tabindex');
                else target.setAttribute('tabindex', previous);
                tabStops.delete(target);
            }
        }
        if (active && (!active.isConnected || active.closest('[hidden]') || !copy[active.dataset.helpKey]
            || active.dataset.helpKey !== activeBindingKey)) dismiss();
        if (enabled) {
            for (const titled of matching('[data-help-key][title], [data-help-key] [title]')) {
                titles.set(titled, titled.getAttribute('title'));
                titled.removeAttribute('title');
            }
            for (const target of matching('[data-help-key]')) {
                if (!copy[target.dataset.helpKey] || ['OPTION', 'INPUT'].includes(target.tagName) && target.type === 'hidden') continue;
                if (target.tagName === 'OPTION' || target.closest('[hidden]') || target === toggleLabel) continue;
                if (target.hasAttribute('title')) {
                    titles.set(target, target.getAttribute('title'));
                    target.removeAttribute('title');
                }
                // Reuse targets for keyboard help instead of adding thousands of
                // hidden controls to a log table. Disabled controls and explicitly opted-in
                // actions need a proxy so touch can request help without submitting.
                if (!(target.control || target).disabled && !target.hasAttribute('data-help-proxy')) {
                    if (target.tabIndex < 0 && !tabStops.has(target)) {
                        tabStops.set(target, target.getAttribute('tabindex'));
                        target.tabIndex = 0;
                    }
                    continue;
                }
                if (affordances.has(target)) continue;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'explain-affordance';
                button.dataset.helpFor = target.dataset.helpKey;
                button.helpTarget = target;
                button.setAttribute('aria-label', `Explain ${copy[target.dataset.helpKey].title}`);
                button.textContent = `Explain ${copy[target.dataset.helpKey].title}`;
                // Table rows/cells cannot accept sibling buttons; keep affordances in cells.
                if (['TD', 'TH'].includes(target.tagName)) target.append(button);
                else if (['TR', 'TABLE', 'TBODY', 'THEAD'].includes(target.tagName)) continue;
                else (target.closest('label') || target).after(button);
                affordances.set(target, button);
            }
        }
        for (const [target, title] of titles) {
            if (!enabled || !target.isConnected) {
                target.setAttribute('title', title);
                titles.delete(target);
            }
        }
        if (enabled) observer.observe(document.body, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['hidden', 'disabled', 'data-help-key', 'data-help-proxy']
        });
    }
    // Tooltip text/outline updates are not application changes. Scanning every
    // log cell after these mutations makes hover latency grow with log history.
    observer = new MutationObserver(records => {
        const roots = new Set();
        const detached = [];
        for (const record of records) {
            if (record.target === tooltip || tooltip.contains(record.target)) continue;
            if (record.type === 'attributes') roots.add(record.target);
            else {
                detached.push(...[...record.removedNodes].filter(node => node.nodeType === 1));
                for (const node of record.addedNodes) {
                    if (node.nodeType === 1) roots.add(node);
                }
                // A cell rerender may remove its keyboard help button.
                if (record.target.matches?.('[data-help-key]')) roots.add(record.target);
            }
        }
        if (detached.length === 0 && roots.size === 0) return;
        // Avoid scanning the same descendants again when both parent and child
        // were changed in one render batch.
        reconcile([...roots].filter(root => {
            if (!root.isConnected) return false;
            for (let parent = root.parentElement; parent; parent = parent.parentElement) {
                if (roots.has(parent)) return false;
            }
            return true;
        }), detached);
    });
    function setEnabled(value) {
        enabled = value;
        toggle.checked = value;
        if (!value) dismiss();
        reconcile();
        try { sessionStorage.setItem(preference, value ? 'on' : 'off'); } catch (_) { /* Storage is optional. */ }
    }
    toggle.addEventListener('change', () => setEnabled(toggle.checked));
    /** Layout changes beneath a dismissed popup must not immediately reopen it. */
    function hover(event) {
        if (suppressHover || !enabled || isHelp(event.target)) { clearTimeout(timer); return; }
        const target = targetFor(event.target);
        if (!target || target === active) return;
        clearTimeout(timer);
        timer = setTimeout(() => show(target, null, 'hover'), 220);
    }
    document.addEventListener('pointerover', hover);
    document.addEventListener('pointermove', event => {
        if (!suppressHover) return;
        suppressHover = false;
        hover(event);
    });
    document.addEventListener('pointerout', event => {
        const from = targetFor(event.target);
        // Keyboard/explicit help remains open when resize moves content beneath
        // a stationary pointer. Hover help still dismisses on pointer departure.
        if (activeTrigger === 'touch') return;
        if (activeTrigger !== 'hover' && active && (active === document.activeElement
            || active.contains(document.activeElement) || activator === document.activeElement
            || tooltip.contains(document.activeElement))) return;
        const next = targetFor(event.relatedTarget);
        if (!enabled || isHelp(event.relatedTarget) || next === active && active
            || from && from === next) return;
        clearTimeout(timer);
        timer = setTimeout(dismiss, 250);
    });
    document.addEventListener('focusin', event => {
        if (restoringFocus || tooltip.contains(event.target)) return;
        const source = event.target.closest?.('[data-help-for]');
        const target = source?.helpTarget || targetFor(event.target);
        if (enabled && target) show(target, source);
        else if (!tooltip.contains(event.target)) dismiss();
    });
    document.addEventListener('pointerdown', event => {
        // Disabled native controls cannot receive focus. A native touch opens the
        // same explanation directly; enabled actions retain their ordinary click.
        const target = targetFor(event.target);
        if (enabled && event.pointerType === 'touch' && (target?.control || target)?.disabled) {
            // Prevent native fallback focus on a focusable containing section.
            event.preventDefault();
            show(target, null, 'touch');
        }
        const button = event.target.closest?.('[data-help-for]');
        // Focusin may open help before the ensuing click; remember the state
        // before pointer focus so the first touch opens and the second closes.
        helpWasOpenOnPointerDown = Boolean(button && active === button.helpTarget && activator === button);
    }, true);
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-help-for]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const alreadyOpen = event.detail === 0
            ? active === button.helpTarget && activator === button : helpWasOpenOnPointerDown;
        helpWasOpenOnPointerDown = false;
        if (alreadyOpen) dismiss();
        else show(button.helpTarget, button, 'explicit');
    }, true);
    document.addEventListener('change', event => { if (active === event.target) show(active); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && active) { event.preventDefault(); dismiss(); }
    });
    /** A popup's own scroll must retain its reading position and Dismiss target.
     * Reposition only when scrolling changes the underlying control's geometry.
     */
    function repositionAfterScroll(event) {
        if (event.target === tooltip || event.target?.closest?.('#pcm-help-tooltip')) return;
        position();
    }
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    window.addEventListener('scroll', repositionAfterScroll, true);
    let saved = false;
    try { saved = sessionStorage.getItem(preference) === 'on'; } catch (_) { /* Default off without storage. */ }
    setEnabled(saved);
});
