'use strict';
/** Synthetic gateway records for identity/provenance boundary tests. */
function arrival(index, extra = {}) {
    return { level: 'INFO', message: 'Gateway Request', details: { type: 'GATEWAY_REQUEST',
        timestampEpoch: String(1793872800 + index / 1000), arrivalProtocol: 'nginx-early/1',
        arrivalId: index.toString(16).padStart(32, '0'), requestId: `request-${index}`,
        correlationId: 'reused-correlation', flowId: 'arrival-flow', method: 'GET',
        url: '/fhir/Observation?_count=10', originalUrl: '/fhir/Observation?_count=10', ...extra } };
}
/** Source completions explicitly reference only arrivals successfully appended. */
function completion(index, extra = {}) {
    const record = arrival(index, extra);
    return { ...record, level: 'ERROR', message: 'Gateway Response: 502 GET /fhir/Observation',
        details: { ...record.details, type: 'GATEWAY_RESPONSE', status: '502', statusCode: '502', requestTime: '1.5' } };
}
module.exports = { arrival, completion };
