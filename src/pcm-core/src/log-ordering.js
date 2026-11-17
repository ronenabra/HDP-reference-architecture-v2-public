/**
 * Ordering helpers for the unified log viewer.
 */

const { configuredExtensionSources } = require('../../shared/log-event');
const { isGatewaySource } = require('./log-source');

const COMPONENTS = [
    { dir: 'pcm-core', label: 'PCM Core' },
    { dir: 'sp-client', label: 'Doctor App' },
    { dir: 'ds-gateway', label: 'DS Gateway' },
    { dir: 'ds-auth-adapter', label: 'DS Auth Adapter' },
    { dir: 'ds-fhir-server', label: 'DS FHIR' }
];

/** Derive trusted Node, native-runtime and separate import-only HAPI streams. */
function configuredLogComponents(config = {}) {
    const components = [
        { dir: 'pcm-core', label: 'PCM Core', role: 'pcm' },
        { dir: 'sp-client', label: 'Doctor App', role: 'doctor' }
    ];
    for (const ho of config.healthOrganizations || []) {
        components.push(
            { dir: `${ho.id}-gateway`, label: `${ho.name} Gateway`, role: 'gateway', healthOrganizationId: ho.id },
            { dir: `${ho.id}-adapter`, label: `${ho.name} Adapter`, role: 'adapter', healthOrganizationId: ho.id },
            { dir: `${ho.id}-hapi`, label: `${ho.name} HAPI import`, role: 'hapi-import', healthOrganizationId: ho.id },
            { dir: `${ho.id}-hapi-runtime`, label: `${ho.name} HAPI runtime`, role: 'hapi', healthOrganizationId: ho.id, strictPath: true, coverage: 'native-request-and-permission' }
        );
    }
    if (config.legacyDataSource?.enabled) {
        components.push(
            { dir: 'ds-gateway', label: 'Legacy DS Gateway', role: 'gateway', healthOrganizationId: 'legacy-ds' },
            { dir: 'ds-auth-adapter', label: 'Legacy DS Adapter', role: 'adapter', healthOrganizationId: 'legacy-ds' },
            { dir: 'ds-fhir-server', label: 'Legacy Node FHIR', role: 'fhir', healthOrganizationId: 'legacy-ds' }
        );
    }
    return [...components.map(component => ({ ...component, coverage: component.coverage || (component.role === 'hapi-import' ? 'import-only' : 'protocol') })), ...configuredExtensionSources(config)];
}

const COMPONENT_INDEX = Object.fromEntries(COMPONENTS.map((component, index) => [component.label, index]));
const HOST_LABELS = [
    { pattern: /pcm-core|pcm\.fhir\.health\.gov\.il/i, label: 'PCM Core' },
    { pattern: /ds-gateway/i, label: 'DS Gateway' },
    { pattern: /ds-auth-adapter/i, label: 'DS Auth Adapter' },
    { pattern: /ds-fhir-server/i, label: 'DS FHIR' }
];

function numericTick(entry) {
    if (!entry.tick || !/^\d+$/.test(String(entry.tick))) return null;
    return BigInt(entry.tick);
}

function timestampMs(entry) {
    const parsed = Date.parse(entry.timestamp || '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function eventWeight(entry) {
    const type = entry.details?.type;
    if (type === 'OUTGOING_REQUEST') return 10;
    if (type === 'GATEWAY_REQUEST') return 15;
    if (type === 'REQUEST') return 20;
    if (type === 'GATEWAY_RESPONSE' || type === 'GATEWAY_ERROR') return 35;
    if (type === 'RESPONSE') return 40;
    if (type === 'OUTGOING_RESPONSE' || type === 'OUTGOING_ERROR') return 50;
    return 30;
}

function requestMethod(entry) {
    const details = entry.details || {};
    if (details.method) return String(details.method).toUpperCase();
    const match = String(entry.message || '').match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i);
    return match ? match[1].toUpperCase() : '';
}

function parseEntryUrl(entry) {
    const details = entry.details || {};
    const url = details.url || details.targetUrl || details.path;
    if (url) return String(url);

    const message = String(entry.message || '');
    const absolute = message.match(/https?:\/\/\S+/i);
    if (absolute) return absolute[0];

    const relative = message.match(/\s(\/[^\s]+)/);
    return relative ? relative[1] : '';
}

function hostLabel(url) {
    try {
        const parsed = new URL(url);
        const known = HOST_LABELS.find(({ pattern }) => pattern.test(parsed.hostname));
        return known?.label || parsed.hostname;
    } catch (err) {
        return '';
    }
}

function operationPath(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url, 'http://local');
        const id = parsed.searchParams.get('_id');
        if (id) return `${parsed.pathname}?_id=${id.slice(0, 8)}...`;
        const queryKeys = [...parsed.searchParams.keys()];
        if (queryKeys.length) return `${parsed.pathname}?${queryKeys.slice(0, 2).join('&')}...`;
        return parsed.pathname;
    } catch (err) {
        return url;
    }
}

function operationKey(entry) {
    const method = requestMethod(entry);
    const url = parseEntryUrl(entry);
    return `${method}:${url}`;
}

function operationLabel(value = '') {
    return String(value)
        .trim()
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ');
}

function flowId(entry) {
    const explicit = entry.details?.flowId || entry.event?.correlation?.flowId;
    const trace = entry.details?.traceId || entry.event?.correlation?.traceId;
    return explicit || (trace ? `trace:${trace}` : '');
}

function correlationId(entry) {
    return entry.details?.correlationId || '';
}

function describeGroupTitle(group) {
    const entry = group.primaryRequest || group.entries[0] || {};
    const operationEntry = group.entries.find(candidate => candidate.details?.operation);
    if (operationEntry?.details?.operation) {
        return `${group.component}: ${operationLabel(operationEntry.details.operation)}`;
    }

    const method = requestMethod(entry);
    const url = parseEntryUrl(entry);
    const target = hostLabel(url);
    const path = operationPath(url) || String(entry.message || 'operation');
    const operation = `${method ? `${method} ` : ''}${path}`;

    if (target && target !== entry.component) return `${entry.component} -> ${target}: ${operation}`;
    return `${entry.component}: ${operation}`;
}

function describeGroupSubtitle(group) {
    const parts = [];
    const participants = [...(group.components || new Set())];
    const entry = group.primaryRequest || group.entries[0] || {};
    const method = requestMethod(entry);
    const url = parseEntryUrl(entry);
    const path = operationPath(url);
    if (participants.length > 2) parts.push(participants.join(' -> '));
    if (group.entries.some(candidate => candidate.details?.operation) && path) {
        parts.push(`${method ? `${method} ` : ''}${path}`);
    }
    if (group.flags?.authRefresh) parts.push(group.flags.authRetry ? '401 -> token refresh -> retry' : '401 -> token refresh');
    parts.push(`${group.entries.length} ${group.entries.length === 1 ? 'entry' : 'entries'}`);
    return parts.join(' · ');
}

/**
 * Add deterministic metadata used by non-legacy ordering modes.
 * @param {object[]} entries
 * @returns {object[]}
 */
function decorateLogEntries(entries) {
    return entries.map((entry, index) => ({
        ...entry,
        order: {
            originalIndex: index,
            componentIndex: COMPONENT_INDEX[entry.component] ?? COMPONENTS.length,
            componentLine: Number(entry.componentLine) || 0,
            timestampMs: timestampMs(entry)
        }
    }));
}

function statusCode(entry) {
    const value = entry.details?.statusCode ?? entry.details?.status;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function isGatewayFailure(entry) {
    return (entry.details?.role === 'gateway' || isGatewaySource(entry.component) || entry.component === 'DS Gateway')
        && entry.details?.type === 'GATEWAY_RESPONSE'
        && statusCode(entry) >= 500;
}

function sameGatewayRequest(error, response) {
    const errorMethod = requestMethod(error);
    const responseMethod = requestMethod(response);
    if (errorMethod && responseMethod && errorMethod !== responseMethod) return false;

    const errorUrl = error.details?.url || '';
    const responseUrl = response.details?.url || response.details?.originalUrl || '';
    if (errorUrl && responseUrl && errorUrl !== responseUrl) return false;

    const errorUpstream = error.details?.upstreamAddr || '';
    const responseUpstream = response.details?.upstreamAddr || '';
    if (errorUpstream && responseUpstream && errorUpstream !== responseUpstream) return false;

    return true;
}

function correlateGatewayErrors(entries) {
    const gatewayFailures = entries.filter(isGatewayFailure);
    if (!gatewayFailures.length) return entries;

    return entries.map(entry => {
        if (!(entry.details?.role === 'gateway' || isGatewaySource(entry.component) || entry.component === 'DS Gateway') || entry.details?.type !== 'GATEWAY_ERROR') return entry;
        if (flowId(entry) || correlationId(entry)) return entry;

        const entryTime = timestampMs(entry);
        const match = gatewayFailures
            .filter(candidate => candidate.component === entry.component
                && candidate.details?.healthOrganizationId === entry.details?.healthOrganizationId
                && sameGatewayRequest(entry, candidate))
            .map(candidate => ({
                entry: candidate,
                distanceMs: Math.abs(timestampMs(candidate) - entryTime)
            }))
            .filter(candidate => candidate.distanceMs <= 5000)
            .sort((a, b) => a.distanceMs - b.distanceMs)[0]?.entry;

        if (!match) return entry;

        return {
            ...entry,
            details: {
                ...entry.details,
                correlationMethod: 'inferred-time-url',
                requestId: entry.details.requestId || match.details?.requestId,
                correlationId: entry.details.correlationId || match.details?.correlationId,
                flowId: entry.details.flowId || match.details?.flowId,
                method: entry.details.method || match.details?.method,
                url: entry.details.url || match.details?.url,
                originalUrl: entry.details.originalUrl || match.details?.originalUrl,
                status: entry.details.status || match.details?.status,
                statusCode: entry.details.statusCode || match.details?.statusCode,
                upstreamStatus: entry.details.upstreamStatus || match.details?.upstreamStatus,
                upstreamAddr: entry.details.upstreamAddr || match.details?.upstreamAddr
            }
        };
    });
}

/**
 * Preserve the current unified-log sort exactly for the legacy view.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareLegacyLogs(a, b) {
    if (a.tick && b.tick) {
        if (b.tick.length !== a.tick.length) return b.tick.length - a.tick.length;
        return b.tick.localeCompare(a.tick);
    }
    return new Date(b.timestamp) - new Date(a.timestamp);
}

function gatewayRequestTieBreaker(a, b) {
    if (a.component !== b.component || !(a.details?.role === 'gateway' || isGatewaySource(a.component) || a.component === 'DS Gateway')) return 0;
    if (a.details?.type !== 'GATEWAY_REQUEST' || b.details?.type !== 'GATEWAY_REQUEST') return 0;
    if (correlationId(a) && correlationId(b) && correlationId(a) !== correlationId(b)) return 0;

    const aUrl = parseEntryUrl(a);
    const bUrl = parseEntryUrl(b);
    const aOriginal = a.details?.originalUrl || '';
    const bOriginal = b.details?.originalUrl || '';
    const aIsParent = aOriginal && aUrl === aOriginal;
    const bIsParent = bOriginal && bUrl === bOriginal;

    if (aIsParent && !bIsParent) return -1;
    if (bIsParent && !aIsParent) return 1;
    return 0;
}

function compareRawTimeline(a, b) {
    const timeDelta = a.order.timestampMs - b.order.timestampMs;
    if (timeDelta !== 0) return timeDelta;

    if (a.component === b.component) {
        const gatewayDelta = gatewayRequestTieBreaker(a, b);
        if (gatewayDelta !== 0) return gatewayDelta;

        const lineDelta = a.order.componentLine - b.order.componentLine;
        if (lineDelta !== 0) return lineDelta;

        const sequenceDelta = (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
        if (sequenceDelta !== 0) return sequenceDelta;

        const aTick = numericTick(a);
        const bTick = numericTick(b);
        if (aTick !== null && bTick !== null && aTick !== bTick) return aTick < bTick ? -1 : 1;
        if (aTick !== null && bTick === null) return 1;
        if (aTick === null && bTick !== null) return -1;
    }

    const eventDelta = eventWeight(a) - eventWeight(b);
    if (eventDelta !== 0) return eventDelta;

    const componentDelta = a.order.componentIndex - b.order.componentIndex;
    if (componentDelta !== 0) return componentDelta;

    const lineDelta = a.order.componentLine - b.order.componentLine;
    if (lineDelta !== 0) return lineDelta;

    return a.order.originalIndex - b.order.originalIndex;
}

function compareFlowChronological(a, b, group) {
    const primaryComponent = group.component;
    const aType = a.details?.type;
    const bType = b.details?.type;
    const closeInTime = Math.abs(a.order.timestampMs - b.order.timestampMs) <= 250;

    if (closeInTime) {
        const aIsPrimaryRequest = a.component === primaryComponent && aType === 'OUTGOING_REQUEST';
        const bIsPrimaryRequest = b.component === primaryComponent && bType === 'OUTGOING_REQUEST';
        const aIsDownstreamRequest = a.component !== primaryComponent && ['REQUEST', 'GATEWAY_REQUEST'].includes(aType);
        const bIsDownstreamRequest = b.component !== primaryComponent && ['REQUEST', 'GATEWAY_REQUEST'].includes(bType);
        if (aIsPrimaryRequest && bIsDownstreamRequest) return -1;
        if (bIsPrimaryRequest && aIsDownstreamRequest) return 1;

        const aIsPrimaryReceived = a.component === primaryComponent && ['OUTGOING_RESPONSE', 'OUTGOING_ERROR'].includes(aType);
        const bIsPrimaryReceived = b.component === primaryComponent && ['OUTGOING_RESPONSE', 'OUTGOING_ERROR'].includes(bType);
        const aIsDownstreamResponse = a.component !== primaryComponent && ['RESPONSE', 'GATEWAY_RESPONSE', 'GATEWAY_ERROR'].includes(aType);
        const bIsDownstreamResponse = b.component !== primaryComponent && ['RESPONSE', 'GATEWAY_RESPONSE', 'GATEWAY_ERROR'].includes(bType);
        if (aIsDownstreamResponse && bIsPrimaryReceived) return -1;
        if (bIsDownstreamResponse && aIsPrimaryReceived) return 1;
    }

    return compareRawTimeline(a, b);
}

function orderFlowGroupEntries(group, tailPosition) {
    const ordered = [...group.entries].sort((a, b) => compareFlowChronological(a, b, group));
    return tailPosition === 'bottom' ? ordered : ordered.reverse();
}

function groupFlowEntries(entries, tailPosition = 'top') {
    const chronological = [...entries].sort(compareRawTimeline);
    const groups = [];
    const activeOutgoing = [];
    const activeInbound = new Map();
    const pendingStandalone = new Map();
    const groupsByFlow = new Map();

    function startGroup(entry, key) {
        const flow = flowId(entry);
        const group = {
            key: flow ? `flow:${flow}` : key,
            component: entry.component,
            components: new Set(),
            flows: new Set(),
            correlations: new Set(),
            flags: {},
            primaryRequest: null,
            entries: []
        };
        groups.push(group);
        return group;
    }

    function append(group, entry) {
        group.entries.push(entry);
        group.components.add(entry.component);
        const flow = flowId(entry);
        if (flow) group.flows.add(flow);
        if (flow && !groupsByFlow.has(flow)) groupsByFlow.set(flow, group);
        const correlation = correlationId(entry);
        if (correlation) group.correlations.add(correlation);
        if (!group.primaryRequest && ['OUTGOING_REQUEST', 'REQUEST', 'GATEWAY_REQUEST'].includes(entry.details?.type)) {
            group.primaryRequest = entry;
            group.primaryOperationKey = operationKey(entry);
        }
        group.endMs = Math.max(group.endMs || 0, entry.order.timestampMs);
        group.startMs = Math.min(group.startMs ?? entry.order.timestampMs, entry.order.timestampMs);
        group.firstOriginalIndex = Math.min(group.firstOriginalIndex ?? entry.order.originalIndex, entry.order.originalIndex);
    }

    function outgoingKey(entry) {
        const details = entry.details || {};
        return `${entry.component}:${details.url || entry.message}`;
    }

    function findActiveOutgoing(entry = null, includeClosedGrace = false) {
        const timestamp = entry?.order?.timestampMs || 0;
        const entryFlow = entry ? flowId(entry) : '';
        const entryCorrelation = entry ? correlationId(entry) : '';
        const active = activeOutgoing.findLast(candidate => {
            if (entryFlow) {
                if (candidate.group.flows.size && !candidate.group.flows.has(entryFlow)) return false;
                if (!candidate.group.flows.size) {
                    if (!entryCorrelation || !candidate.group.correlations.has(entryCorrelation)) return false;
                }
            } else if (entryCorrelation) {
                if (candidate.group.flows.size && !candidate.group.correlations.has(entryCorrelation)) return false;
                if (candidate.group.correlations.size && !candidate.group.correlations.has(entryCorrelation)) return false;
            } else if (candidate.group.flows.size) {
                return false;
            }
            if (!candidate.closed) return true;
            return includeClosedGrace && timestamp - candidate.closedAt <= 250;
        });
        return active?.group;
    }

    function findFlowGroup(entry) {
        const flow = flowId(entry);
        return flow ? groupsByFlow.get(flow) : null;
    }

    for (const entry of chronological) {
        const details = entry.details || {};

        if (details.type === 'OUTGOING_REQUEST') {
            const group = findActiveOutgoing(entry, false) || findFlowGroup(entry) || startGroup(entry, `outgoing:${groups.length}:${outgoingKey(entry)}`);
            if (group.entries.length === 0) {
                const pending = pendingStandalone.get(entry.component) || [];
                const retained = [];
                const entryFlow = flowId(entry);
                for (const pendingEntry of pending) {
                    const pendingFlow = flowId(pendingEntry);
                    const close = entry.order.timestampMs - pendingEntry.order.timestampMs <= 2000;
                    const sameFlow = !entryFlow || pendingFlow === entryFlow;
                    if (close && sameFlow) append(group, pendingEntry);
                    else retained.push(pendingEntry);
                }
                pendingStandalone.set(entry.component, retained);
            }
            append(group, entry);
            activeOutgoing.push({
                key: outgoingKey(entry),
                group,
                method: requestMethod(entry),
                correlationId: correlationId(entry),
                flowId: flowId(entry)
            });
            continue;
        }

        if (details.type === 'OUTGOING_RESPONSE' || details.type === 'OUTGOING_ERROR') {
            const key = outgoingKey(entry);
            const entryCorrelation = correlationId(entry);
            const entryFlow = flowId(entry);
            const index = activeOutgoing.findLastIndex(active => !active.closed
                && active.key === key
                && (!entryCorrelation || !active.correlationId || active.correlationId === entryCorrelation)
                && (!entryFlow || !active.flowId || active.flowId === entryFlow));
            const active = index >= 0 ? activeOutgoing[index] : null;
            const group = active?.group || startGroup(entry, `outgoing-fallback:${groups.length}:${key}`);
            const responseEntry = active?.method && !details.method
                ? { ...entry, details: { ...details, method: active.method } }
                : entry;
            append(group, responseEntry);
            if (active) {
                active.closed = true;
                active.closedAt = entry.order.timestampMs;
            }
            continue;
        }

        if (details.type === 'REQUEST' && details.requestId) {
            const group = findActiveOutgoing(entry, true) || findFlowGroup(entry) || startGroup(entry, `request:${groups.length}:${entry.component}:${details.requestId}`);
            append(group, entry);
            activeInbound.set(`${entry.component}:${details.requestId}`, group);
            continue;
        }

        if (details.type === 'RESPONSE' && details.requestId) {
            const key = `${entry.component}:${details.requestId}`;
            const group = activeInbound.get(key) || findActiveOutgoing(entry, true) || findFlowGroup(entry) || startGroup(entry, `response:${groups.length}:${key}`);
            append(group, entry);
            activeInbound.delete(key);
            continue;
        }

        const group = findActiveOutgoing(entry, true) || findFlowGroup(entry);
        if (group) append(group, entry);
        else if (flowId(entry)) append(startGroup(entry, `flow:${flowId(entry)}`), entry);
        else {
            const pending = pendingStandalone.get(entry.component) || [];
            pending.push(entry);
            pendingStandalone.set(entry.component, pending);
        }
    }

    for (const pending of pendingStandalone.values()) {
        for (const entry of pending) {
            const group = startGroup(entry, `standalone:${groups.length}:${entry.component}:${entry.id || entry.order.originalIndex}`);
            append(group, entry);
        }
    }

    function isUnauthorizedGroup(group) {
        return group.entries.some(entry => {
            const details = entry.details || {};
            return details.status === 401 || details.statusCode === 401 || /\b401\b/.test(String(entry.message || ''));
        });
    }

    function isTokenGroup(group) {
        const entry = group.primaryRequest;
        return entry?.component === group.component
            && requestMethod(entry) === 'POST'
            && operationPath(parseEntryUrl(entry)) === '/token';
    }

    function closeEnough(first, second) {
        return (second.startMs || 0) - (first.endMs || 0) <= 2000;
    }

    function mergeInto(base, extra) {
        base.entries.push(...extra.entries);
        for (const component of extra.components) base.components.add(component);
        for (const flow of extra.flows || []) base.flows.add(flow);
        for (const correlation of extra.correlations || []) base.correlations.add(correlation);
        base.endMs = Math.max(base.endMs || 0, extra.endMs || 0);
        base.startMs = Math.min(base.startMs ?? 0, extra.startMs ?? 0);
        base.firstOriginalIndex = Math.min(base.firstOriginalIndex ?? 0, extra.firstOriginalIndex ?? 0);
    }

    function mergeAuthRetryGroups(sourceGroups) {
        const merged = [];
        for (let index = 0; index < sourceGroups.length; index += 1) {
            const group = sourceGroups[index];
            const tokenGroup = sourceGroups[index + 1];
            const retryGroup = sourceGroups[index + 2];
            const canMergeRefresh = tokenGroup
                && group.component === tokenGroup.component
                && isUnauthorizedGroup(group)
                && isTokenGroup(tokenGroup)
                && closeEnough(group, tokenGroup);

            if (canMergeRefresh) {
                group.flags.authRefresh = true;
                mergeInto(group, tokenGroup);
                index += 1;

                if (retryGroup
                    && retryGroup.component === group.component
                    && retryGroup.primaryOperationKey === group.primaryOperationKey
                    && closeEnough(tokenGroup, retryGroup)) {
                    group.flags.authRetry = true;
                    mergeInto(group, retryGroup);
                    index += 1;
                }
            }

            merged.push(group);
        }
        return merged;
    }

    const displayGroups = mergeAuthRetryGroups(groups);

    for (const group of displayGroups) {
        group.entries = orderFlowGroupEntries(group, tailPosition);
        group.title = describeGroupTitle(group);
        group.subtitle = describeGroupSubtitle(group);
    }

    displayGroups.sort((a, b) => {
        const timeDelta = (b.endMs || 0) - (a.endMs || 0);
        if (timeDelta !== 0) return timeDelta;
        return (b.firstOriginalIndex || 0) - (a.firstOriginalIndex || 0);
    });

    if (tailPosition === 'bottom') displayGroups.reverse();

    return displayGroups.flatMap((group, groupIndex) => group.entries.map((entry, entryIndex) => ({
        ...entry,
        flowGroup: {
            id: group.key,
            index: groupIndex,
            component: group.component,
            title: group.title,
            subtitle: group.subtitle,
            start: entryIndex === 0
        }
    })));
}

/**
 * Order unified log entries for a viewer mode.
 * @param {object[]} entries
 * @param {string} order
 * @param {string} tailPosition
 * @returns {object[]}
 */
function orderUnifiedLogs(entries, order = 'legacy', tailPosition = 'top') {
    if (order === 'timeline') {
        const sorted = decorateLogEntries(correlateGatewayErrors(entries)).sort(compareRawTimeline);
        return tailPosition === 'bottom' ? sorted : sorted.reverse();
    }
    if (order === 'flow') return groupFlowEntries(decorateLogEntries(correlateGatewayErrors(entries)), tailPosition);
    return [...entries].sort(compareLegacyLogs);
}

module.exports = {
    COMPONENTS,
    configuredLogComponents,
    compareLegacyLogs,
    compareRawTimeline,
    decorateLogEntries,
    groupFlowEntries,
    orderUnifiedLogs
};
