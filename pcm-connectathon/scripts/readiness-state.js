'use strict';

/** Keep the durable Compose health grace and the start command's budget consistent. */
const { readinessWaitTimeout, readinessEnvironment } = require('./lifecycle');

/** Plan a health-only .env update without changing any credentials or runtime settings. */
function planReadinessState(environmentText, requested) {
    const stored = environmentText.match(/^PCM_HAPI_HEALTH_START_PERIOD=(\d+)s\s*$/m)?.[1];
    const hasStored = /^PCM_HAPI_HEALTH_START_PERIOD=/m.test(environmentText);
    if (hasStored && !stored) throw new Error('PCM_HAPI_HEALTH_START_PERIOD must be an unquoted bounded integer in seconds, such as 600s');
    const defaultTimeout = readinessWaitTimeout();
    const previous = stored ? readinessWaitTimeout(stored) : defaultTimeout;
    const waitTimeout = readinessWaitTimeout(requested === undefined ? Math.max(defaultTimeout, previous) : requested);
    const grace = readinessEnvironment({}, waitTimeout).PCM_HAPI_HEALTH_START_PERIOD;
    const line = `PCM_HAPI_HEALTH_START_PERIOD=${grace}`;
    const environment = hasStored ? environmentText.replace(/^PCM_HAPI_HEALTH_START_PERIOD=.*$/m, line)
        : `${environmentText.trimEnd()}\n${line}\n`;
    return { waitTimeout, environment };
}
module.exports = { planReadinessState };
