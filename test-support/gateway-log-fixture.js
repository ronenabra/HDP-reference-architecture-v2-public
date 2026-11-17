'use strict';

/** Synthetic gateway completion records shared by API and owned browser fixtures. */

/** Build a completion covering all levels and both public and internal request paths.
 * @param {number} index Unique record sequence, also determining level and path.
 * @returns {object} Fabricated legacy-compatible gateway completion.
 */
function gatewayCompletion(index) {
    const level = ['INFO', 'WARN', 'ERROR'][index % 3];
    const status = { INFO: 200, WARN: 401, ERROR: 502 }[level];
    return {
        timestamp: new Date(Date.UTC(2026, 10, 4, 10) + index * 1000).toISOString(),
        level, message: `Synthetic gateway completion ${index}`,
        details: {
            type: 'GATEWAY_RESPONSE', method: 'GET', url: index % 2 ? '/auth' : '/fhir/Observation?_count=10',
            originalUrl: '/fhir/Observation?_count=10', status, statusCode: status, upstreamStatus: status,
            upstreamAddr: 'synthetic-adapter:9443', upstreamResponseTime: '0.013', authStatus: '', bytesSent: 123,
            requestTime: '0.013', requestId: `gateway-request-${index}`, correlationId: `gateway-request-${index}`,
            flowId: `gateway-flow-${Math.floor(index / 2)}`, traceId: index.toString(16).padStart(32, 'a'),
            token: 'synthetic-non-AWS-token', patient: 'Patient/synthetic-gateway'
        }
    };
}

/** Preserve conspicuous whitespace so raw-fidelity assertions exercise source bytes.
 * @param {number} index Completion sequence.
 * @returns {string} Exact fabricated JSONL payload, excluding its LF delimiter.
 */
function gatewayRaw(index) { return ` \t${JSON.stringify(gatewayCompletion(index))} \r`; }

module.exports = { gatewayCompletion, gatewayRaw };
