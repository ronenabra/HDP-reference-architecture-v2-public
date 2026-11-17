'use strict';
/** Source publication, private authority, rollback and historical identity boundaries. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { FHIRStore } = require('../src/fhir/store');
const { newDataSourceConfig } = require('../src/data-sources');
const { validateSource, publishSource, customSource, managedCertificate } = require('../src/source-registration-command');

/** Own every filesystem mutation and keep config publication injectable for failure tests. */
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'pcm-source24-'));
    t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
    const config = buildTeamConfig(); config.runtime.revision = 0; config.runtime.stateDir = directory; config.runtime.certsDir = directory; config.organizations.dataSources = [];
    const configPath = path.join(directory,'team.json'); fs.writeFileSync(configPath,JSON.stringify(config));
    const store = new FHIRStore({getConfigRevision:()=>config.runtime.revision});
    const source = newDataSourceConfig('Owned custom source','https://owned.example.test/fhir',{clientId:'pcm-owned-source24'});
    source.pcmClientAuth.certThumbprint = 'A'.repeat(43);
    const saveConfig = value => { fs.writeFileSync(configPath,`${JSON.stringify(value,null,2)}\n`); store.authorityState.observeConfig(value); require('../src/migration-checkpoint').recordConfig(directory,configPath); };
    return {directory,configPath,store,source,config,saveConfig};
}
/** Validate the candidate and invoke the actual synchronous publication command. */
function publish(f, options={}) {
    const config = JSON.parse(fs.readFileSync(f.configPath)), source = options.source || f.source;
    const args = {...f,config,source,expectedRevision:config.runtime.revision,...options};
    validateSource(args); return publishSource(args);
}

test('custom publication is private, source-bound and revision checked; long identities remain valid',t=>{
    const f=fixture(t); const before=fs.readFileSync(f.configPath);
    assert.throws(()=>publish(f,{expectedRevision:-1}),/changed/); assert.deepEqual(fs.readFileSync(f.configPath),before);
    const result=publish(f,{material:{'custom/owned.key':'owned-test-key'}});
    assert.equal(result.revision,f.config.runtime.revision+1);
    const org=f.store.get('Organization',f.source.id); assert.equal(org.active,true);
    assert.equal(f.store.get('Endpoint',f.source.endpointId).address,f.source.endpoint);
    assert.doesNotMatch(JSON.stringify(f.store.getAll('Endpoint')),/serverTrust|pcmClientAuth|owned-test-key/);
    assert.equal(f.store.privateRecords.provisioning.get('Organization',f.source.id).sourceRegistration.clientId,f.source.clientId);
    assert.ok(newDataSourceConfig('long'.repeat(60),f.source.endpoint).parentId.length<=64);
});

test('failed publication restores exact prior config, credentials, public/private records and generations',t=>{
    const f=fixture(t); publish(f,{material:{'custom/owned.key':'previous-private-bytes'}});
    const config=fs.readFileSync(f.configPath), graph=require('../src/migration-checkpoint').snapshot(f.store,{privateState:true});
    const source={...f.source,name:'Changed display',endpoint:'https://next.example.test/fhir'};
    assert.throws(()=>publish(f,{source,previous:f.source,material:{'custom/owned.key':'replacement-private-bytes','custom/new.crt':'new'},saveConfig:value=>{ f.saveConfig(value); throw new Error('injected config publication failure'); }}),/injected/);
    assert.deepEqual(fs.readFileSync(f.configPath),config); assert.equal(fs.readFileSync(path.join(f.directory,'custom/owned.key'),'utf8'),'previous-private-bytes');
    assert.equal(fs.existsSync(path.join(f.directory,'custom/new.crt')),false);
    assert.deepEqual(require('../src/migration-checkpoint').snapshot(f.store,{privateState:true}),graph);
});

test('disable, re-enable and guarded remove preserve references, stale authority and nonreusable identity across restart',t=>{
    const f=fixture(t);publish(f);
    f.store.add({resourceType:'Consent',id:'historical-source24',status:'proposed',provision:{actor:[{role:{coding:[{code:'CST'}]},reference:{reference:`Organization/${f.source.id}`}}]}});
    const grant={scenario:'consent-access',dataSourceOrganizationId:f.source.id,endpointId:f.source.endpointId,consentId:'historical-source24'},client={organizationId:f.config.organizations.serviceProvider.id};
    const configNow=()=>JSON.parse(fs.readFileSync(f.configPath));
    const stamp=()=>f.store.authorityState.stamp(f.store,configNow(),grant,client,{});
    const issued=stamp();
    const callers=require('../src/grant-authority-state');
    const caller={client_id:f.source.clientId,organization_id:f.source.id,source_registration_authority:callers.sourceClientAuthority(f.store,configNow(),{clientId:f.source.clientId,organizationId:f.source.id})};
    assert.equal(callers.sourceClientCredentialStillAllowed(caller,f.store,configNow()),true);
    assert.equal(callers.sourceClientCredentialStillAllowed({...caller,source_registration_authority:undefined},f.store,configNow()),false);
    assert.equal(callers.sourceClientCredentialStillAllowed({client_id:f.config.organizations.serviceProvider.clientId,organization_id:f.config.organizations.serviceProvider.id},f.store,configNow()),true);
    const before=f.store.get('Consent','historical-source24'), generation=f.store.authorityState.generations.get(`Organization/${f.source.id}`);
    assert.throws(()=>publish(f,{previous:f.source,action:'remove'}),/Disable/);
    const disabled={...f.source,enabled:false}; publish(f,{source:disabled,previous:f.source,action:'disable'});
    assert.equal(f.store.get('Organization',f.source.id).active,false);
    const retired=f.store.authorityState.generations.get(`Organization/${f.source.id}`); assert.ok(retired>generation);
    assert.equal(require('../src/grant-authority-state').authorityStillAllowed(issued,stamp()),false);assert.equal(callers.sourceClientCredentialStillAllowed(caller,f.store,configNow()),false);
    publish(f,{previous:disabled,action:'enable'}); assert.equal(require('../src/grant-authority-state').authorityStillAllowed(issued,stamp()),false);assert.equal(callers.sourceClientCredentialStillAllowed(caller,f.store,configNow()),false); assert.ok(f.store.authorityState.generations.get(`Organization/${f.source.id}`)>retired);
    publish(f,{source:disabled,previous:f.source,action:'disable'});publish(f,{source:disabled,previous:disabled,action:'remove'});
    assert.deepEqual(f.store.get('Consent','historical-source24'),before); assert.equal(f.store.get('Organization',f.source.id).active,false);
    const config=JSON.parse(fs.readFileSync(f.configPath)); assert.equal(config.organizations.dataSources.length,0);
    const restored=new FHIRStore({getConfigRevision:()=>config.runtime.revision});
    require('../src/migration-checkpoint').hydrate(restored,require('../src/migration-checkpoint').snapshot(f.store,{privateState:true}),{rollback:true});
    require('../src/data-sources').syncDataSourcesToStore(restored,config,null,{preserveExisting:true});
    assert.equal(restored.get('Organization',f.source.id).active,false);
    assert.throws(()=>restored.update({...restored.get('Organization',f.source.id),active:true}),/cannot be revived/);
    assert.throws(()=>require('../../shared/source-registration-history').validateSourceRegistrationHistory({...config,organizations:{...config.organizations,removedDataSourceRegistrations:[]}},config),/discard/);
    assert.throws(()=>require('../../shared/source-registration-history').validateSourceRegistrationHistory({...config,organizations:{...config.organizations,dataSources:[f.source]}}),/cannot be revived/);
    assert.throws(()=>validateSource({...f,config,store:restored}),/Historical/);
});

test('invalid opaque IDs, duplicate clients, unsafe destinations and identity replacement fail before publication',t=>{
    const f=fixture(t); const before=fs.readFileSync(f.configPath);
    for(const [patch,pattern] of [[{clientId:'https://client.example.test'},/opaque/],[{endpoint:'http://source.example.test/fhir'},/HTTPS/],[{endpoint:'https://169.254.169.254/latest'},/blocked|metadata|destination|prohibited/i],[{endpoint:'https://source.example.test/fhir?secret=1'},/without/],[{clientId:f.config.organizations.serviceProvider.clientId},/already/]]) assert.throws(()=>publish(f,{source:{...f.source,...patch}}),pattern);
    assert.throws(()=>publish(f,{source:{...f.source,clientId:'replacement-owned'},previous:f.source}),/identities/);
    fs.mkdirSync(path.join(f.directory,'custom'));fs.writeFileSync(path.join(f.directory,'owned-marker'),'original-marker');fs.linkSync(path.join(f.directory,'owned-marker'),path.join(f.directory,'custom/hardlink.key'));
    assert.throws(()=>publish(f,{material:{'custom/hardlink.key':'replacement'}}),/regular managed/);assert.equal(fs.readFileSync(path.join(f.directory,'owned-marker'),'utf8'),'original-marker');
    assert.deepEqual(fs.readFileSync(f.configPath),before); assert.equal(f.store.getAll('Organization').length,0);
    assert.throws(()=>customSource({...f.config,organizations:{...f.config.organizations,dataSources:[f.source],teamDataSource:{id:f.source.id}}},f.source.id),/seed-backed/);
});

test('server trust refuses unsafe references, bad pins and preset-gated skip without changing registration',t=>{
    const f=fixture(t);
    for (const name of ['../rootCA.crt','/etc/ssl/cert.pem','custom/../rootCA.crt']) assert.throws(()=>managedCertificate(f.directory,name),/managed/);
    fs.symlinkSync('/etc/hosts',path.join(f.directory,'outside.crt')); assert.throws(()=>managedCertificate(f.directory,'outside.crt'),/managed/);
    assert.throws(()=>publish(f,{source:{...f.source,serverTrust:{mode:'pinned-thumbprint',certThumbprint:'wrong'}}}),/43-character/);
    assert.throws(()=>publish(f,{config:{...f.config,conformance:{preset:'strict'}},source:{...f.source,serverTrust:{mode:'insecure-skip-verify'}}}),/preset/);
    assert.throws(()=>publish(f,{source:{...f.source,serverTrust:{mode:'unknown'}}}),/Unsupported/);
    for(const mode of ['team-root-ca','system-ca','pinned-thumbprint'])assert.throws(()=>publish(f,{source:{...f.source,serverTrust:{mode,caCert:'rootCA.key',certThumbprint:'A'.repeat(43)}}}),/managed CA/);
    for(const preset of ['connectathon-easy','connectathon-balanced','connectathon-mtls','strict']) {
        const config=buildTeamConfig({},preset);config.organizations.dataSources=[{...f.source,serverTrust:{mode:'insecure-skip-verify'}}];
        assert.equal(require('../../shared/team-config-validator').semanticErrors(config).some(error=>error.includes('Source skip verification')),['strict','connectathon-mtls'].includes(preset));
    }
});

/** Arm the real attached-checkpoint publisher and fail after its durable mutation journal. */
function attachFailingCheckpoint(f) {
    const checkpoint=require('../src/migration-checkpoint'),root=path.join(f.directory,'pcm-ig-041');fs.mkdirSync(root);
    fs.writeFileSync(path.join(root,'checkpoint.json'),checkpoint.encode(checkpoint.snapshot(f.store,{privateState:true})));
    fs.writeFileSync(path.join(root,'manifest.json'),checkpoint.encode({schema:'pcm-migration/1',phase:'applied',runtimeId:`sha256:${'b'.repeat(64)}`,configHash:checkpoint.sha256(fs.readFileSync(f.configPath)),checkpointHash:checkpoint.sha256(fs.readFileSync(path.join(root,'checkpoint.json')))}));
    checkpoint.attach(f.store,f.directory);
    const rename=fs.renameSync;
    return {root,fail(action){fs.renameSync=(from,to)=>{if(to===path.join(root,'checkpoint.json'))throw new Error('injected attached checkpoint publication failure');return rename(from,to);};try{return action();}finally{fs.renameSync=rename;}}};
}

test('original checkpoint/config-file recovery conflict is reproduced; reviewed source rollback restores exact old artifacts and restart authority',t=>{
    const original=fixture(t);publish(original,{material:{'custom/owned.key':'old-owned-test-key'}});const old=fs.readFileSync(original.configPath);
    const legacy=attachFailingCheckpoint(original),checkpoint=require('../src/migration-checkpoint'),{hash}=require('../../shared/migration-hash');
    const candidate=JSON.parse(old);candidate.runtime.revision++;
    assert.throws(()=>legacy.fail(()=>require('../../shared/role-credentials').publishFiles(original.directory,{'custom/owned.key':'candidate-owned-test-key'},()=>original.store.transaction(()=>{
        original.store.update({...original.store.get('Organization',original.source.id),active:false});original.saveConfig(candidate);checkpoint.recordConfig(original.directory,original.configPath);
    }))),/injected/);
    fs.writeFileSync(original.configPath,old);
    const mutation=JSON.parse(fs.readFileSync(path.join(legacy.root,'checkpoint-mutation.json')));
    const generic=require('../../../pcm-connectathon/scripts/reconcile-pcm-handoff');
    assert.throws(()=>generic.recoverMutation({stateDirectory:original.directory,configPath:original.configPath,runtimeId:mutation.manifest.runtimeId,workersStopped:true,expectedDigest:hash(mutation)}),/Conflicting uncertain publication/);

    const f=fixture(t);publish(f,{material:{'custom/owned.key':'old-owned-test-key'}});
    const attached=attachFailingCheckpoint(f),configBefore=fs.readFileSync(f.configPath),checkpointBefore=fs.readFileSync(path.join(attached.root,'checkpoint.json')),manifestBefore=fs.readFileSync(path.join(attached.root,'manifest.json'));
    const graphBefore=checkpoint.snapshot(f.store,{privateState:true});
    assert.throws(()=>attached.fail(()=>publish(f,{source:{...f.source,name:'Candidate failed source'},previous:f.source,material:{'custom/owned.key':'candidate-owned-test-key'}})),/uncertain and fenced/);
    assert.deepEqual(fs.readFileSync(f.configPath),configBefore);assert.equal(fs.readFileSync(path.join(f.directory,'custom/owned.key'),'utf8'),'old-owned-test-key');assert.deepEqual(checkpoint.snapshot(f.store,{privateState:true}),graphBefore);
    assert.throws(()=>require('../../shared/migration-maintenance').assertAvailable(f.directory),/maintenance/);
    const journalPath=path.join(f.directory,'configuration-mutation/source-publication.json'),journal=JSON.parse(fs.readFileSync(journalPath));
    const options={stateDirectory:f.directory,configPath:f.configPath,certsDirectory:f.directory,workersStopped:true,expectedDigest:hash(journal)};
    assert.throws(()=>generic.recoverMutation({...options,workersStopped:false}),/Stop workers/);assert.throws(()=>generic.recoverMutation({...options,expectedDigest:'wrong'}),/exact source/);
    assert.throws(()=>generic.recoverMutation({...options,certsDirectory:os.tmpdir()}),/managed destinations/);
    assert.throws(()=>generic.recoverMutation({...options,configPath:path.join(f.directory,'different.json')}),/managed destinations/);
    const result=generic.recoverMutation(options);assert.equal(result.status,'rolled-back-reviewed-source-publication');
    assert.deepEqual(fs.readFileSync(path.join(attached.root,'checkpoint.json')),checkpointBefore);assert.deepEqual(fs.readFileSync(path.join(attached.root,'manifest.json')),manifestBefore);assert.deepEqual(fs.readFileSync(f.configPath),configBefore);
    assert.equal(fs.existsSync(path.join(f.directory,'configuration-mutation')),false);assert.equal(fs.existsSync(path.join(attached.root,'checkpoint-mutation.json')),false);
    const restarted=new FHIRStore();checkpoint.hydrate(restarted,JSON.parse(checkpointBefore));assert.deepEqual(checkpoint.snapshot(restarted,{privateState:true}),graphBefore);
    if(process.env.PCM_SOURCE24_RECOVERY_EVIDENCE)fs.writeFileSync(process.env.PCM_SOURCE24_RECOVERY_EVIDENCE,JSON.stringify({original:{status:'reproduced-conflicting-uncertain-publication',journalDigest:hash(mutation)},repaired:{status:result.status,sourceJournalDigest:hash(journal),configHash:checkpoint.sha256(configBefore),checkpointHash:checkpoint.sha256(checkpointBefore),manifestHash:checkpoint.sha256(manifestBefore),restartAuthority:'exact',privateKeysInReceipt:false}},null,2)+'\n');
});

test('abrupt source-file publication leaves the existing mutex fenced until exact reviewed rollback',t=>{
    const f=fixture(t);publish(f,{material:{'custom/owned.key':'old-owned-test-key'}});
    const before=fs.readFileSync(f.configPath),next=JSON.parse(before);next.runtime.revision++;
    const lock=path.join(f.directory,'configuration-mutation');fs.mkdirSync(lock);
    const staged=require('../src/source-publication-recovery').begin({lock,configPath:f.configPath,directory:f.directory,stateDirectory:f.directory,material:{'custom/owned.key':'crashed-owned-test-key','custom/new.crt':'new'},nextConfig:next,sourceId:f.source.id});
    const child=require('node:child_process').spawnSync(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'crashed-owned-test-key');process.exit(87)",path.join(f.directory,'custom/owned.key')]);assert.equal(child.status,87);
    assert.throws(()=>require('../../shared/migration-maintenance').assertAvailable(f.directory),/uncertain/);
    const recover=require('../../../pcm-connectathon/scripts/reconcile-pcm-handoff').recoverMutation;
    const options={stateDirectory:f.directory,configPath:f.configPath,certsDirectory:f.directory,workersStopped:true,expectedDigest:require('../../shared/migration-hash').hash(staged.journal)};
    fs.writeFileSync(path.join(f.directory,'custom/owned.key'),'conflicting-later-bytes');assert.throws(()=>recover(options),/Conflicting source credential/);
    fs.writeFileSync(path.join(f.directory,'custom/owned.key'),'crashed-owned');assert.equal(recover(options).status,'rolled-back-reviewed-source-publication');
    assert.equal(fs.readFileSync(path.join(f.directory,'custom/owned.key'),'utf8'),'old-owned-test-key');assert.deepEqual(fs.readFileSync(f.configPath),before);assert.equal(fs.existsSync(path.join(f.directory,'custom/new.crt')),false);
});

test('custom-source caller credentials retain parent availability and irreversible hierarchy generations',t=>{
    const f=fixture(t);publish(f);const config=JSON.parse(fs.readFileSync(f.configPath));
    const {sourceClientAuthority,sourceClientCredentialStillAllowed}=require('../src/grant-authority-state');
    const client={clientId:f.source.clientId,organizationId:f.source.id};
    const credential={client_id:client.clientId,organization_id:client.organizationId,source_registration_authority:sourceClientAuthority(f.store,config,client)};
    assert.equal(sourceClientCredentialStillAllowed(credential,f.store,config),true);
    const parent=f.store.get('Organization',f.source.parentId);f.store.update({...parent,active:false});
    assert.equal(sourceClientCredentialStillAllowed({...credential,source_registration_authority:null},f.store,config),false);
    assert.equal(sourceClientCredentialStillAllowed(credential,f.store,config),false);
    f.store.update({...f.store.get('Organization',parent.id),active:true});
    assert.equal(sourceClientCredentialStillAllowed(credential,f.store,config),false);
    const fresh={...credential,source_registration_authority:sourceClientAuthority(f.store,config,client)};
    assert.equal(sourceClientCredentialStillAllowed(fresh,f.store,config),true);
});
