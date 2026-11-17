'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { equivalentTokens, authorityKey } = require('./equivalent-page-authority');
function token(scope, value) { return { status: 200, json: { access_token: value, scope, authorization_details: [{ patient: 'p', source: 'ho-a' }] } }; }
test('distinct issued opaque tokens with identical complete returned authority qualify', async () => {
    let n=0; const pair=await equivalentTokens(async()=>token('scope',String(++n)));
    assert.equal(n,2);assert.notEqual(pair[0].json.access_token,pair[1].json.access_token);
    assert.equal(authorityKey(pair[0].json),authorityKey(pair[1].json));
});
test('a rolling history boundary is skipped only after two genuinely equal returned authorities exist', async () => {
    const issued=[token('old','1'),token('new','2'),token('new','3')];
    const pair=await equivalentTokens(async()=>issued.shift());assert.equal(pair[0].json.scope,'new');assert.equal(pair[1].json.scope,'new');
});
test('different grants or reusing one credential cannot fabricate fresh equivalent authority', async () => {
    let n=0;await assert.rejects(equivalentTokens(async()=>token(String(++n),String(n))),/four issuance/);assert.equal(n,4);
    n=0;await assert.rejects(equivalentTokens(async()=>{n++;return token('same','one-credential');}),/four issuance/);assert.equal(n,4);
    assert.notEqual(authorityKey(token('scope','1').json),authorityKey({ ...token('scope','2').json, patient: 'other' }));
});
