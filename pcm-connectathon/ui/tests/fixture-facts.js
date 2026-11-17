'use strict';
/** Browser tests receive bounded setup facts; maintenance transport and credentials stay in the backend. */
const fs = require('fs');

/** Reject stale or mismatched setup; application requests must still prove current PCM authorization. */
function selectedFixtureFacts() {
    if (!process.env.PCM_UI_FIXTURE_FACTS) {
        if (process.env.PCM_UI_REQUIRE_CLINICAL === 'true') throw new Error('required private fixture inspection is missing');
        return { patients: [] };
    }
    const facts = JSON.parse(fs.readFileSync(process.env.PCM_UI_FIXTURE_FACTS, 'utf8'));
    const age = Date.now() - Date.parse(facts.observedAt);
    if (facts.method !== 'private-named-fixture-read' || facts.teamId !== process.env.PCM_UI_TEAM_ID
        || !Number.isFinite(age) || age < 0 || age > 30 * 60 * 1000
        || facts.sources.some(source => source.state === 'failed') || facts.patients.length > 30) throw new Error('fixture inspection is stale, failed or belongs to another team');
    return facts;
}
module.exports = { selectedFixtureFacts };
