'use strict';
/** Actual authenticated Admin source registration and public mTLS/OAuth credential use. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), https = require('node:https');
const { generateCertificates } = require('../../../test-support/certificates');
const { createClientAssertion } = require('../../sp-client/src/oauth');
const { certToX5tS256 } = require('../src/crypto');

/** Send source OAuth calls with the exact exported transport and signing roles. */
function sourceCall(runtime, bundle, endpoint, fields) {
    const source = bundle.dataSource, certs = bundle.certificates;
    const transport = source.pcmClientAuth.mtlsCert || source.pcmClientAuth.cert;
    const transportKey = source.pcmClientAuth.mtlsKey || source.pcmClientAuth.key;
    const assertion = createClientAssertion({ clientId: source.clientId, audience: `${runtime.endpoints.fhirBase}${endpoint}`,
        privateKey: certs[source.pcmClientAuth.key], cnfThumbprint: certToX5tS256(certs[transport]) });
    const body = new URLSearchParams({ ...fields, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }).toString();
    return new Promise((resolve, reject) => {
        const req = https.request(`${runtime.apiBase}${endpoint}`, { method: 'POST', agent: false,
            ca: certs['rootCA.crt'], cert: certs[transport], key: certs[transportKey],
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => {
            let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        }); req.on('error', reject); req.end(body);
    });
}

/** Use the issued opaque caller credential with this source's actual PCM transport pair. */
function bearerIntrospection(runtime, bundle, credential) {
    const source=bundle.dataSource,certs=bundle.certificates;
    const body=new URLSearchParams({token:'unknown-subject'}).toString();
    return new Promise((resolve,reject)=>{
        const req=https.request(`${runtime.apiBase}/introspect`,{method:'POST',agent:false,ca:certs['rootCA.crt'],
            cert:certs[source.pcmClientAuth.mtlsCert||source.pcmClientAuth.cert],key:certs[source.pcmClientAuth.mtlsKey||source.pcmClientAuth.key],
            headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},res=>{
            let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
        });req.on('error',reject);req.end(body);
    });
}

/** Read this source's public registration with its ordinary management bearer and transport. */
function sourceManagementRead(runtime,bundle,credential) {
    const source=bundle.dataSource,certs=bundle.certificates;
    return new Promise((resolve,reject)=>{
        const req=https.get(`${runtime.apiBase}/Organization/${source.id}`,{agent:false,ca:certs['rootCA.crt'],
            cert:certs[source.pcmClientAuth.mtlsCert||source.pcmClientAuth.cert],key:certs[source.pcmClientAuth.mtlsKey||source.pcmClientAuth.key],
            headers:{Authorization:`Bearer ${credential}`,Accept:'application/fhir+json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);
    });
}

test('Admin-generated shared ES256 and configured separate ES384 sources use exported roles for token and direct introspection', async t => {
    const fixture = generateCertificates();
    process.env.PCM_TEST_CERTIFICATES = fixture.directory;
    const runtime = await require('../../../test-support/pcm-042-runtime').startRuntime();
    t.after(async () => { await runtime.close(); fixture.cleanup(); });
    const ui = runtime.config.publicBaseUrls.pcmUi;
    const headers = { 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD, Accept: 'application/json' };
    const revision = () => Number(require('../src/team-config').loadTeamConfig().runtime.revision) || 0;
    const add = body => fetch(`${ui}/admin/config/data-sources/add`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision(), ...body }) });
    const denied = await fetch(`${ui}/admin/config/data-sources/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    const rootBefore = fs.readFileSync(path.join(fixture.directory, 'rootCA.crt'));
    const renewalHandoff = await fetch(`${ui}/admin/certs/regenerate`, { method: 'POST', headers });
    assert.equal(renewalHandoff.status, 409);
    assert.equal((await renewalHandoff.json()).code, 'certificate-recreation-required');
    assert.deepEqual(fs.readFileSync(path.join(fixture.directory, 'rootCA.crt')), rootBefore);

    const created = await add({ name: 'Owned custom source', endpoint: 'https://owned-source.example.test/fhir', generateCertificate: true, serverTrustMode: 'custom-ca', serverTrustCaCert: 'untrustedCA.crt' });
    assert.equal(created.status, 201); const saved = (await created.json()).dataSource;
    assert.doesNotMatch(JSON.stringify(saved), /BEGIN.*PRIVATE KEY/);
    async function bundle() { const response = await fetch(`${ui}/admin/config/data-sources/${saved.id}/client-bundle`, { headers }); assert.equal(response.status, 200); return response.json(); }
    async function useExported() {
        const exported = await bundle();
        const acquired = await sourceCall(runtime, exported, '/token', { grant_type: 'client_credentials', scope: 'system/*.crus', resource: `${runtime.endpoints.fhirBase}/introspect` });
        assert.equal(acquired.status, 200, JSON.stringify({ status: acquired.status, error: acquired.body.error_description }));
        assert.equal(acquired.body.token_type, 'Bearer');
        const introspection = await sourceCall(runtime, exported, '/introspect', { token: 'unknown-subject' });
        assert.deepEqual(introspection, { status: 200, body: { active: false } });
        return exported;
    }
    const first = await useExported();
    assert.equal(require('../../shared/assertion-keys').signingAlgorithm(first.certificates[saved.pcmClientAuth.cert]), 'ES256');
    const config = require('../src/team-config').loadTeamConfig();
    const source = config.organizations.dataSources.find(item => item.id === saved.id);
    source.pcmClientAuth.assertionCertificates = { ES384: source.pcmClientAuth.cert };
    source.pcmClientAuth.mtlsCert = `custom/${source.id}-mtls.crt`; source.pcmClientAuth.mtlsKey = `custom/${source.id}-mtls.key`;
    require('../src/team-config').saveTeamConfig(config);
    const regenerated = await fetch(`${ui}/admin/config/data-sources/${saved.id}/cert/generate`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision(), credentialProfile: 'separate-es384' }) });
    assert.equal(regenerated.status, 200); const second = await useExported();
    assert.equal(require('../../shared/assertion-keys').signingAlgorithm(second.certificates[saved.pcmClientAuth.cert]), 'ES384');
    assert.notEqual(second.dataSource.pcmClientAuth.certThumbprint, certToX5tS256(second.certificates[saved.pcmClientAuth.cert]));
    assert.deepEqual(second.dataSource.serverTrust, first.dataSource.serverTrust, 'client regeneration preserves independent source HTTPS trust');
    const beforeConfig = fs.readFileSync(process.env.TEAM_CONFIG_PATH), beforeFiles = fs.readdirSync(path.join(fixture.directory, 'custom')).sort();
    const form = new FormData(); form.set('name', 'Mismatched upload'); form.set('endpoint', 'https://invalid-source.example.test/fhir'); form.set('generateCertificate', 'false');
    form.set('pcmClientAuthCertFile', new Blob([first.certificates[saved.pcmClientAuth.cert]]), 'client.crt');
    form.set('pcmClientAuthKeyFile', new Blob([fs.readFileSync(path.join(fixture.directory, 'hospital-b-sp.key'))]), 'client.key');
    const rejected = await fetch(`${ui}/admin/config/data-sources/add`, { method: 'POST', headers, body: form });
    assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /do not match/);
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), beforeConfig);
    assert.deepEqual(fs.readdirSync(path.join(fixture.directory, 'custom')).sort(), beforeFiles);
    const unchecked = new FormData(); unchecked.set('name', 'Unchecked generation'); unchecked.set('endpoint', 'https://unchecked.example.test/fhir');
    const missing = await fetch(`${ui}/admin/config/data-sources/add`, { method: 'POST', headers, body: unchecked });
    assert.equal(missing.status, 400);
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), beforeConfig);
    const invalidCa = await fetch(`${ui}/admin/config/data-sources/${saved.id}/server-trust/ca`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ serverTrustCa: 'invalid-ca' }) });
    assert.equal(invalidCa.status, 400);
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), beforeConfig);
    assert.deepEqual(fs.readdirSync(path.join(fixture.directory, 'custom')).sort(), beforeFiles);

    const unsafeReference=await add({name:'Unsafe unused CA reference',endpoint:'https://unsafe-reference.example.test/fhir',serverTrustMode:'system-ca',serverTrustCaCert:'rootCA.key'});
    assert.equal(unsafeReference.status,400,'inactive trust fields must not smuggle the root signing key into a source export');
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH),beforeConfig);
    const retainedInvalid=JSON.parse(beforeConfig);retainedInvalid.organizations.dataSources.find(item=>item.id===saved.id).serverTrust={mode:'system-ca',caCert:'rootCA.key'};
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH,JSON.stringify(retainedInvalid));
    try { const refusedExport=await fetch(`${ui}/admin/config/data-sources/${saved.id}/client-bundle`,{headers});assert.equal(refusedExport.status,400);assert.doesNotMatch(await refusedExport.text(),/BEGIN.*PRIVATE KEY/); }
    finally { fs.writeFileSync(process.env.TEAM_CONFIG_PATH,beforeConfig); }
    // A separately uploaded registration must use its own exported client identity.
    const upload = new FormData(); upload.set('name','Uploaded owned source'); upload.set('endpoint','https://uploaded.example.test/fhir');
    upload.set('credentialMode','upload'); upload.set('credentialProfile','shared-es256'); upload.set('expectedRevision',String(revision()));
    upload.set('pcmClientAuthCertFile',new Blob([first.certificates[saved.pcmClientAuth.cert]]),'assertion.crt');
    upload.set('pcmClientAuthKeyFile',new Blob([first.certificates[saved.pcmClientAuth.key]]),'assertion.key');
    const uploadedResponse=await fetch(`${ui}/admin/config/data-sources/add`,{method:'POST',headers,body:upload});
    assert.equal(uploadedResponse.status,201,await uploadedResponse.clone().text()); const uploaded=(await uploadedResponse.json()).dataSource;
    const uploadedBundle=await (await fetch(`${ui}/admin/config/data-sources/${uploaded.id}/client-bundle`,{headers})).json();
    const uploadedToken=await sourceCall(runtime,uploadedBundle,'/token',{grant_type:'client_credentials',scope:'system/*.crus',resource:`${runtime.endpoints.fhirBase}/introspect`}); assert.equal(uploadedToken.status,200);
    const duplicate=await add({name:'Duplicate client',endpoint:'https://duplicate.example.test/fhir',clientId:uploaded.clientId}); assert.equal(duplicate.status,400);
    const jsonPost=(route,body)=>fetch(`${ui}${route}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision(),...body})});
    const remote=https.createServer({cert:first.certificates[saved.pcmClientAuth.cert],key:first.certificates[saved.pcmClientAuth.key]},(req,res)=>{
        res.setHeader('Content-Type','application/fhir+json');
        if(req.url.endsWith('/metadata')) res.end(JSON.stringify({resourceType:'CapabilityStatement'}));
        else if(req.url.includes('/Patient')){res.statusCode=401;res.end('{}');}
        else res.end(JSON.stringify({resourceType:'OperationOutcome'}));
    });
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>remote.close(resolve)));
    const changed=await jsonPost(`/admin/config/data-sources/${saved.id}/institution`,{adminForm:'source-registration',name:saved.name,institutionType:'other',endpoint:`https://127.0.0.1:${remote.address().port}/fhir`}); assert.equal(changed.status,200);
    const wrongTrust=await jsonPost(`/admin/config/data-sources/${saved.id}/test`,{}); assert.equal(wrongTrust.status,502); assert.equal((await wrongTrust.json()).phases.at(-1).classification,'tls-trust');
    const correctTrust=await jsonPost(`/admin/config/data-sources/${saved.id}/server-trust/ca`,{adminForm:'source-trust',serverTrustMode:'team-root-ca'}); assert.equal(correctTrust.status,200);
    const ready=await jsonPost(`/admin/config/data-sources/${saved.id}/test`,{}); assert.equal(ready.status,200); const observed=await ready.json();
    assert.equal(observed.status,'partial'); assert.equal(observed.coverage.authenticatedClinical,false); assert.ok(observed.phases.some(phase=>phase.phase==='connectivity-tls'&&phase.status==='pass'));
    const correctPin=await jsonPost(`/admin/config/data-sources/${saved.id}/server-trust/thumbprint`,{thumbprint:certToX5tS256(first.certificates[saved.pcmClientAuth.cert])});assert.equal(correctPin.status,200);
    assert.equal((await jsonPost(`/admin/config/data-sources/${saved.id}/test`,{})).status,200);
    const wrongPin=await jsonPost(`/admin/config/data-sources/${saved.id}/server-trust/thumbprint`,{thumbprint:'A'.repeat(43)});assert.equal(wrongPin.status,200);
    const pinnedDenied=await jsonPost(`/admin/config/data-sources/${saved.id}/test`,{});assert.equal(pinnedDenied.status,502);assert.equal((await pinnedDenied.json()).phases.at(-1).classification,'tls-trust');
    assert.equal((await jsonPost(`/admin/config/data-sources/${saved.id}/server-trust/ca`,{adminForm:'source-trust',serverTrustMode:'team-root-ca'})).status,200);
    const managementConfig=require('../src/team-config').loadTeamConfig();managementConfig.organizations.dataSources.find(item=>item.id===saved.id).scopes=['introspection','system/*.crus'];require('../src/team-config').saveTeamConfig(require('../src/team-config').markRuntimeChange(managementConfig,'owned-source-management-fixture'));
    const preDisableBundle=await bundle();const preDisableCredential=await sourceCall(runtime,preDisableBundle,'/token',{grant_type:'client_credentials',scope:'system/*.crus',resource:`${runtime.endpoints.fhirBase}/introspect`});assert.equal(preDisableCredential.status,200);
    assert.equal((await bearerIntrospection(runtime,preDisableBundle,preDisableCredential.body.access_token)).status,200);
    const preDisableManagement=await sourceCall(runtime,preDisableBundle,'/token',{grant_type:'client_credentials',scope:'system/*.crus',resource:runtime.endpoints.fhirBase});assert.equal(preDisableManagement.status,200);assert.equal(await sourceManagementRead(runtime,preDisableBundle,preDisableManagement.body.access_token),200);
    assert.doesNotMatch(JSON.stringify(preDisableManagement.body),/source_registration_authority/);
    const priorId=saved.clientId;
    const disable=await jsonPost('/admin/config/data-sources/remove',{id:saved.id,action:'disable'}); assert.equal(disable.status,200);
    assert.equal((await sourceCall(runtime,second,'/token',{grant_type:'client_credentials',scope:'system/*.crus',resource:`${runtime.endpoints.fhirBase}/introspect`})).status,401);
    const enable=await jsonPost('/admin/config/data-sources/remove',{id:saved.id,action:'enable'}); assert.equal(enable.status,200);
    const restored=await bundle();assert.equal(restored.dataSource.clientId,priorId);
    assert.equal((await bearerIntrospection(runtime,restored,preDisableCredential.body.access_token)).status,401,'pre-disable caller credential must not revive after re-enable');
    assert.equal(await sourceManagementRead(runtime,restored,preDisableManagement.body.access_token),401,'pre-disable management credential must not revive after re-enable');
    const freshManagement=await sourceCall(runtime,restored,'/token',{grant_type:'client_credentials',scope:'system/*.crus',resource:runtime.endpoints.fhirBase});assert.equal(freshManagement.status,200);assert.equal(await sourceManagementRead(runtime,restored,freshManagement.body.access_token),200);
    assert.equal((await sourceCall(runtime,restored,'/token',{grant_type:'client_credentials',scope:'system/*.crus',resource:`${runtime.endpoints.fhirBase}/introspect`})).status,200);
    assert.equal((await jsonPost('/admin/config/data-sources/remove',{id:saved.id})).status,409);
    assert.equal((await jsonPost('/admin/config/data-sources/remove',{id:saved.id,action:'disable'})).status,200);
    assert.equal((await jsonPost('/admin/config/data-sources/remove',{id:saved.id})).status,200);
    assert.equal((await add({name:'Reuse forbidden',endpoint:'https://new.example.test/fhir',clientId:priorId})).status,400);

    if (process.env.PCM_SOURCE24_LIVE_EVIDENCE) fs.writeFileSync(process.env.PCM_SOURCE24_LIVE_EVIDENCE, JSON.stringify({
        schema:'pcm-source24-credential-proof/1',capturedUtc:new Date().toISOString(),node:process.version,openssl:process.versions.openssl,pcmCaFingerprint:certToX5tS256(first.certificates['rootCA.crt']), generatedShared:{clientId:saved.clientId,algorithm:'ES256',assertionFingerprint:certToX5tS256(first.certificates[saved.pcmClientAuth.cert]),token:200,introspection:200},
        generatedSeparate:{clientId:saved.clientId,algorithm:'ES384',assertionFingerprint:certToX5tS256(second.certificates[second.dataSource.pcmClientAuth.cert]),transportFingerprint:certToX5tS256(second.certificates[second.dataSource.pcmClientAuth.mtlsCert]),distinctTransport:true,token:200,introspection:200},
        uploadedShared:{clientId:uploaded.clientId,token:uploadedToken.status}, sourceHttps:{wrongTrust:wrongTrust.status,correctTrust:ready.status,status:observed.status,authenticatedClinical:observed.coverage.authenticatedClinical,correctTeamCaPin:200,wrongPin:pinnedDenied.status},
        lifecycle:{disabledOwnAuthentication:401,reenabledOwnAuthentication:200,stableClientId:true,staleIntrospectionBearerAfterReenable:401,staleManagementBearerAfterReenable:401,freshManagementBearer:200,enabledRemoval:409,disabledRemoval:200,identityReuse:400},
        unsafeInactiveCaReference:400,unsafeStoredCaExport:400,privateKeysOrTokensInReceipt:false,readinessIsClinicalProof:false},null,2)+'\n');

});
