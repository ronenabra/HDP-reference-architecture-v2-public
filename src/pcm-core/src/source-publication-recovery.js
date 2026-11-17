'use strict';
/** Exact source artifact rollback under the existing private configuration mutex/journal. */
const fs=require('node:fs'),path=require('node:path');
const checkpoint=require('./migration-checkpoint'),maintenance=require('../../shared/migration-maintenance');
const digest=require('../../shared/migration-hash').hash;
const bytes=file=>fs.existsSync(file)?fs.readFileSync(file):null;
const encoded=value=>value===null?null:value.toString('base64');
const same=(left,right)=>left===null?right===null:right!==null&&left.equals(right);
const ownPartial=(current,candidate)=>current!==null&&candidate!==null&&current.length<candidate.length&&candidate.subarray(0,current.length).equals(current);

/** Capture selected files before the first write; never accept browser paths.
 * @param {object} options Existing mutex and backend-owned config/certificate/checkpoint paths.
 * @returns {{file:string,journal:object}} Private journal path and detached recovery envelope.
 */
function begin({lock,configPath,directory,stateDirectory,material,nextConfig,sourceId}) {
    const files=Object.fromEntries(Object.entries(material).map(([name,after])=>{
        if(!/^custom\/[A-Za-z0-9._-]+\.(?:crt|key)$/.test(name))throw new Error('Source credential destination is not managed');
        const target=path.join(directory,name);
        if(fs.existsSync(target)&&(!fs.lstatSync(target).isFile()||fs.lstatSync(target).nlink!==1||fs.realpathSync(target)!==target))throw new Error('Source credential destination must be a regular managed file');
        const parent=fs.existsSync(path.dirname(target))?fs.realpathSync(path.dirname(target)):fs.realpathSync(directory);
        if(parent!==fs.realpathSync(directory)&&!parent.startsWith(fs.realpathSync(directory)+path.sep))throw new Error('Source credential destination leaves its managed directory');
        return [name,{before:encoded(bytes(target)),after:encoded(Buffer.from(after)),mode:fs.existsSync(target)?fs.statSync(target).mode&0o777:0o600}];
    }));
    const root=path.join(stateDirectory,'pcm-ig-041');
    const journal={schema:'pcm-source-publication/1',sourceId,stateDirectory:path.resolve(stateDirectory),configPath:path.resolve(configPath),certsDirectory:path.resolve(directory),
        configMode:fs.statSync(configPath).mode&0o777,config:{before:encoded(bytes(configPath)),after:encoded(Buffer.from(`${JSON.stringify(nextConfig,null,2)}\n`))},files,
        checkpoint:encoded(bytes(path.join(root,'checkpoint.json'))),manifest:encoded(bytes(path.join(root,'manifest.json')))};
    const file=path.join(lock,'source-publication.json');checkpoint.atomicWrite(file,checkpoint.encode(journal));
    return {file,journal};
}

/** Roll back only exact reviewed source artifacts with every worker stopped.
 * The old checkpoint and authority generations are restored only for this uncommitted,
 * fenced publication; later unrelated state is refused rather than overwritten.
 * @param {object} options Stopped-worker acknowledgment, exact reviewed digest and owner paths.
 * @returns {{status:string,sourceId:string}} Non-secret rollback receipt after durable restoration.
 */
function recover({stateDirectory,configPath,certsDirectory,workersStopped,expectedDigest,retainLock=false}) {
    const lock=path.join(stateDirectory,'configuration-mutation'),file=path.join(lock,'source-publication.json');
    const journal=JSON.parse(fs.readFileSync(file)),decode=value=>value===null?null:Buffer.from(value,'base64');
    if(!workersStopped||journal.schema!=='pcm-source-publication/1'||digest(journal)!==expectedDigest
        ||path.resolve(stateDirectory)!==journal.stateDirectory||path.resolve(configPath)!==journal.configPath||path.resolve(certsDirectory)!==journal.certsDirectory)throw new Error('Stop workers and review the exact source publication journal digest and managed destinations before rollback');
    maintenance.assertOperationsIdle(stateDirectory);
    if(fs.readdirSync(lock).some(name=>name!=='source-publication.json'))throw new Error('Conflicting configuration publication; preserve all journals');
    const currentConfig=bytes(configPath),beforeConfig=decode(journal.config.before),afterConfig=decode(journal.config.after);
    if(![beforeConfig,afterConfig].some(value=>same(value,currentConfig))&&!ownPartial(currentConfig,afterConfig))throw new Error('Conflicting source configuration; preserve all bytes');
    for(const [name,value] of Object.entries(journal.files)) {
        if(!/^custom\/[A-Za-z0-9._-]+\.(?:crt|key)$/.test(name))throw new Error('Unsafe source journal destination');
        const target=path.join(certsDirectory,name),current=bytes(target);
        const parent=fs.existsSync(path.dirname(target))?fs.realpathSync(path.dirname(target)):fs.realpathSync(certsDirectory);
        if(parent!==fs.realpathSync(certsDirectory)&&!parent.startsWith(fs.realpathSync(certsDirectory)+path.sep))throw new Error('Unsafe source journal parent alias');
        if(fs.existsSync(target)&&(!fs.lstatSync(target).isFile()||fs.lstatSync(target).nlink!==1||fs.realpathSync(target)!==target))throw new Error('Unsafe source journal alias');
        if(![decode(value.before),decode(value.after)].some(candidate=>same(candidate,current))&&!ownPartial(current,decode(value.after)))throw new Error('Conflicting source credential files; preserve all bytes');
    }
    const root=path.join(stateDirectory,'pcm-ig-041'),mutationFile=path.join(root,'checkpoint-mutation.json');
    const beforeCheckpoint=decode(journal.checkpoint),beforeManifest=decode(journal.manifest);
    const mutation=fs.existsSync(mutationFile)?JSON.parse(fs.readFileSync(mutationFile)):null;
    if(mutation&&(mutation.schema!=='pcm-checkpoint-mutation/1'||!same(beforeCheckpoint,Buffer.from(mutation.before,'base64'))))throw new Error('Conflicting checkpoint journal; preserve all bytes');
    const allowedCheckpoints=[beforeCheckpoint,...(mutation?[Buffer.from(mutation.after,'base64')]:[])];
    if(!allowedCheckpoints.some(value=>same(value,bytes(path.join(root,'checkpoint.json')))))throw new Error('Conflicting source checkpoint; preserve all bytes');
    const allowedManifests=[beforeManifest];
    if(beforeManifest){const parsed=JSON.parse(beforeManifest);allowedManifests.push(checkpoint.encode({...parsed,configHash:checkpoint.sha256(afterConfig)}));}
    if(mutation){
        if(mutation.manifest.configHash!==checkpoint.sha256(afterConfig))throw new Error('Conflicting source checkpoint configuration');
        allowedManifests.push(checkpoint.encode(mutation.manifest),checkpoint.encode({...mutation.manifest,checkpointHash:checkpoint.sha256(Buffer.from(mutation.after,'base64'))}));
    }
    if(!allowedManifests.some(value=>same(value,bytes(path.join(root,'manifest.json')))))throw new Error('Conflicting source manifest; preserve all bytes');
    const fence=maintenance.fencePath(stateDirectory);
    if(fs.existsSync(fence)&&!fs.readFileSync(fence,'utf8').startsWith('Checkpoint mutation uncertain'))throw new Error('Unrelated maintenance fence; preserve all bytes');
    const restore=(target,value,mode=0o600)=>{if(value===null)fs.rmSync(target,{force:true});else{try{checkpoint.atomicWrite(target,value);}catch(error){if(target!==configPath||!['EBUSY','EPERM','EXDEV'].includes(error.code))throw error;fs.writeFileSync(target,value);}fs.chmodSync(target,mode);}};
    // Keep the mutex/journals until every exact byte has been restored successfully.
    for(const [name,value]of Object.entries(journal.files))restore(path.join(certsDirectory,name),decode(value.before),value.mode);
    restore(configPath,beforeConfig,journal.configMode);restore(path.join(root,'checkpoint.json'),beforeCheckpoint);restore(path.join(root,'manifest.json'),beforeManifest);
    if(mutation)fs.rmSync(mutationFile);if(fs.existsSync(fence))fs.rmSync(fence);
    fs.rmSync(file);if(!retainLock)fs.rmdirSync(lock);
    return {status:'rolled-back-reviewed-source-publication',sourceId:journal.sourceId};
}
module.exports={begin,recover};
