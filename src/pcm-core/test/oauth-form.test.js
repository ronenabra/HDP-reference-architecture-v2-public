'use strict';

/** Exercise real HTTP decoding and prove invalid bodies never reach authentication. */
const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createOAuthFormParser } = require('../src/oauth-form');
const { FORM_BYTES, RAW_BYTES } = require('../src/rar-request');

test('OAuth HTTP parser bounds decoded and raw bodies before authentication', async t => {
    let authenticationCalls = 0;
    const app = express();
    app.post('/token', createOAuthFormParser());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.post('/token', (req, res) => { authenticationCalls++; res.json(req.body); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const send = (body, type = 'application/x-www-form-urlencoded') => fetch(`http://127.0.0.1:${server.address().port}/token`, {
        method: 'POST', headers: { 'content-type': type }, body
    });
    for (const [body, type, error] of [
        ['resource=a&resource=b', undefined, 'invalid_target'],
        ['scope=a&scope=b', undefined, 'invalid_request'],
        ['scope=%FF', undefined, 'invalid_request'],
        ['scope=x&&resource=y', undefined, 'invalid_request'],
        ['x=' + 'a'.repeat(FORM_BYTES - 1), undefined, 'invalid_request'],
        ['x=' + '%61'.repeat(RAW_BYTES), undefined, 'invalid_request'],
        ['{}', 'application/json', 'invalid_request']
    ]) {
        const response = await send(body, type);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, error);
    }
    assert.equal(authenticationCalls, 0);
    const response = await send('x=' + 'a'.repeat(FORM_BYTES - 2));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).x.length, FORM_BYTES - 2);
    const once = await send('scope=patient%2FPatient.s&authorization_details=%255B');
    assert.deepEqual(await once.json(), { scope: 'patient/Patient.s', authorization_details: '%5B' });
    assert.equal(authenticationCalls, 2);
});

test('HTTP source-specific exact UTF-8/encoded/RAR budgets reject before assertion replay', async t => {
    const { grantHarness, requested } = require('../../../test-support/pcm-042-grants');
    const f = grantHarness(); t.after(f.close);
    const identity = { system: 'http://fhir.health.gov.il/identifier/pna-national-id', value: 'é' };
    f.config.systemAuthorization.presenceEligiblePatients = [identity];
    const body = { ...f.body, scope: 'system/Patient.s', authorization_details: requested('Contract', 'PCM-POLICY-PRESENCE-001', [identity]) };
    const encoded = new URLSearchParams(body).toString();
    const decodedBytes = Object.entries(body).reduce((bytes, [name, value], index) => bytes + Buffer.byteLength(name) + Buffer.byteLength(value) + 1 + (index ? 1 : 0), 0);
    const budget = { maxRarBytes: Buffer.byteLength(body.authorization_details), maxFormBytes: decodedBytes, maxEncodedFormBytes: Buffer.byteLength(encoded) };
    f.config.presence.sources = { 'ho-a': budget, 'ho-b': { maxRarBytes: budget.maxRarBytes - 1 } };
    const app = express();
    app.post('/token', createOAuthFormParser(() => f.config), (req, res) => {
        req.clientId = f.config.oauthClients.presenceOrchestrator.clientId;
        const result = f.service(req); res.status(result.status).json(result.body);
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const send = value => fetch(`http://127.0.0.1:${server.address().port}/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: value
    });
    assert.equal((await send(encoded)).status, 200);
    const before = f.counters();
    for (const [wire, error] of [
        [encoded + '%20', 'invalid_request'],
        [new URLSearchParams({ ...body, resource: f.config.healthOrganizations[1].endpoint }).toString(), 'invalid_request'],
        [encoded + '&scope=system%2FPatient.s', 'invalid_request'],
        [encoded + '&res%6furce=other', 'invalid_target']
    ]) {
        const response = await send(wire); assert.equal(response.status, 400); assert.equal((await response.json()).error, error);
        assert.deepEqual(f.counters(), before);
    }
});

test('new pre-target envelopes reload independently and an in-progress UTF-8 body retains its captured ceiling', async t => {
    const http = require('node:http');
    const { buildTeamConfig } = require('../../../test-support/team-config');
    const config = buildTeamConfig();
    config.presence.batch.maxFormBytes = 5; config.presence.batch.maxEncodedFormBytes = 8;
    config.presence.sources = { 'ho-b': { maxFormBytes:6, maxEncodedFormBytes:12 } };
    let capture; const captured = new Promise(resolve => { capture = resolve; });
    let handled = 0;
    const parser = createOAuthFormParser(() => { capture(); return config; });
    const app = express(); app.post('/token', parser, (req,res) => { handled++; res.json(req.body); });
    const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
    t.after(()=>{server.closeAllConnections();server.close();});
    const root = `http://127.0.0.1:${server.address().port}/token`;
    const request = http.request(root,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','content-length':12}});
    const result = new Promise((resolve,reject)=>{request.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);});
    request.write('x='); await captured;
    // The active body keeps the old largest envelope. New requests see the reduction.
    delete config.presence.sources['ho-b'];
    request.end('%C3%A9%61a'); assert.equal(await result,200);
    const send = body => fetch(root,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
    assert.equal((await send('x=%C3%A9a')).status,400);
    config.presence.sources['ho-b'] = {maxEncodedFormBytes:12,maxFormBytes:6};
    assert.equal((await send('x=%C3%A9%61a')).status,200);
    assert.equal((await send('x=%C3%A9%61aa')).status,400);
    assert.equal(handled,2);
});

test('HTTP token/introspection response budgets adopt edited source values without consuming rejected one-time lifecycle', async t => {
    const { grantHarness, requested } = require('../../../test-support/pcm-042-grants');
    const f=grantHarness();t.after(f.close);
    const app=express();app.post(['/token','/introspect'],createOAuthFormParser(()=>f.config));
    app.post('/token',(req,res)=>{const result=f.service(req);res.status(result.status).json(result.body);});
    app.post('/introspect',(req,res)=>{const result=f.inspect(req.body.token,f.source.clientId,{oauthFormBytes:req.oauthFormBytes});res.status(result.status).json(result.body);});
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close();});
    const send=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});return {status:response.status,body:await response.json()};};
    const issued=await send('/token',f.body);assert.equal(issued.status,200);
    const exact=Buffer.byteLength(JSON.stringify(issued.body));
    f.config.presence.sources={'ho-a':{maxResponseBytes:exact},'ho-b':{maxResponseBytes:exact+1}};
    assert.equal((await send('/token',f.body)).status,200);
    f.config.presence.sources['ho-a'].maxResponseBytes--;
    const before=f.counters().replays,records=f.tokenStore.size;
    assert.equal((await send('/token',f.body)).status,400);assert.equal(f.counters().replays,before);assert.equal(f.tokenStore.size,records);
    delete f.config.presence.sources;
    const decision=f.newDecision({mode:'one-time'});f.body.authorization_details=requested('Consent',decision.identifier[0].value);
    const one=await send('/token',f.body);assert.equal(one.status,200);
    f.config.presence.sources={'ho-a':{maxResponseBytes:Buffer.byteLength(JSON.stringify(one.body))}};
    const inspect={token:one.body.access_token,client_assertion_type:f.body.client_assertion_type,client_assertion:f.body.client_assertion};
    assert.equal(f.windows.size,0);assert.deepEqual((await send('/introspect',inspect)).body,{active:false});assert.equal(f.windows.size,0);
    delete f.config.presence.sources;assert.equal((await send('/introspect',inspect)).body.active,true);assert.equal(f.windows.size,1);
});
