import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import { execFile,spawn } from 'node:child_process';
import { createPublicKey,generateKeyPairSync,randomBytes,sign,verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve,dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile=promisify(execFile);
const root=dirname(fileURLToPath(import.meta.url));
const aqua=generateKeyPairSync('ed25519');
const issuer='https://aquamarine.example';
const certificate=Array(32).fill('AB').join(':');
const hosts=[];
let north,south;

async function port() {
  const listener=createServer().listen(0,'127.0.0.1');
  await once(listener,'listening');
  const {port}=listener.address();
  await new Promise((done,error)=>listener.close(e=>e?error(e):done()));
  return port;
}

async function launch(name,peers=[],governanceId=''){
  const directory=await mkdtemp(resolve(root,'data-test-regions-'));
  const address=await port();
  const origin='http://127.0.0.1:'+address;
  const env={...process.env,CEZEOS_DATA_DIR:directory,CEZEOS_PORT:String(address),CEZEOS_PUBLIC_ORIGIN:origin,CEZEOS_REGION_NAME:name,
    CEZEOS_ALLOW_DEMO:'1', CEZEOS_GOVERNANCE_HOME:governanceId?'0':'1', CEZEOS_GOVERNANCE_REGION_ID:governanceId, CEZEOS_PEERS:JSON.stringify(peers),CEZEOS_TELEGRAM_CLIENT_ID:'',CEZEOS_TELEGRAM_CLIENT_SECRET:'',
    CEZEOS_ANDROID_SHA256:certificate,CEZEOS_AQUAMARINE_ISSUER:issuer,CEZEOS_AQUAMARINE_PUBLIC_KEY:JSON.stringify(aqua.publicKey.export({format:'jwk'}))};
  const processHandle=spawn(process.execPath,['server.mjs'],{cwd:root,env});
  hosts.push({directory,processHandle});
  let stderr='';
  processHandle.stderr.on('data',chunk=>{stderr+=chunk;});
  await Promise.race([once(processHandle.stdout,'data'),once(processHandle,'exit').then(()=>{throw new Error(stderr);})]);
  const info=await (await fetch(origin+'/.well-known/cezeos-region.json')).json();
  return {directory,origin,info,env};
}

async function call(host,path,{method='GET',cookie,data,status=200}={}){
  const result=await fetch(host.origin+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},
    ...(data?{body:JSON.stringify(data)}:{})});
  assert.equal(result.status,status,method+' '+path);
  return {body:await result.json(),cookie:result.headers.get('set-cookie')?.split(';')[0]};
}

async function account(name,host=north){
  const result=await call(host,'/api/session/demo',{method:'POST',data:{name},status:201});
  return {profile:result.body.profile,cookie:result.cookie};
}

before(async()=>{
  north=await launch('Север');
  await runFile(process.execPath,['operator.mjs','set-triumvirs','@Aqua_First','aqua.second','aqua_third'],{cwd:root,env:north.env});
  south=await launch('Юг',[{origin:north.origin,id:north.info.id},{origin:north.origin,id:'A'.repeat(43)}],north.info.id);
});

after(async()=>{
  for(const {directory,processHandle} of hosts){
    if(processHandle.exitCode===null && processHandle.signalCode===null){
      const exit=once(processHandle,'exit');
      processHandle.kill();
      await exit;
    }
    if(dirname(directory)===root) await rm(directory,{recursive:true,force:true});
  }
});

test('A Region trusts only pinned keys and exposes only public posts and Android fingerprint',async()=>{
  const health=(await call(north,'/healthz')).body;
  assert.equal(health.region,north.info.id);
  assert.notEqual(north.info.id,south.info.id);
  const dal=(await call(north,'/.well-known/assetlinks.json')).body;
  assert.deepEqual(dal[0].target.sha256_cert_fingerprints,[certificate]);
  const {cookie}=await account('Публикатор');
  for (const visibility of ['public','private']) {
    await call(north,'/api/posts',{method:'POST',cookie,status:201,data:{body:'Материал '+visibility,visibility}});
  }
  const closed=(await call(north,'/api/groups',{method:'POST',cookie,status:201,data:{name:'Закрытый круг',closed:true}})).body;
  await call(north,'/api/posts',{method:'POST',cookie,status:201,data:{body:'Закрытое сообщество',group:closed.id}});
  const network=(await call(south,'/api/regions')).body;
  assert.deepEqual(network.peers.map(peer=>peer.available),[true,false]);
  const feed=(await call(south,'/api/regions/'+north.info.id)).body.posts;
  assert.ok(feed.some(post=>post.body==='Материал public'));
  assert.ok(!feed.some(post=>['Материал private','Закрытое сообщество'].includes(post.body)));
  await call(south,'/api/regions/'+'A'.repeat(43),{status:503});
  const mirror=(await call(south,'/api/governance')).body;
  assert.equal(mirror.home,north.origin);
  assert.equal(mirror.local,false);
  assert.deepEqual(mirror.triumvirs.map(seat=>seat.nickname),['aqua_first','aqua.second','aqua_third']);
  assert.equal(mirror.applications,undefined);
  const regional=await account('Участник южного региона',south);
  await call(south,'/api/governance/applications',{method:'POST',cookie:regional.cookie,status:403,data:{body:'Заявка'}});
  await assert.rejects(runFile(process.execPath,['operator.mjs','set-triumvirs','unapproved'],{cwd:root,env:south.env}));
});

async function signedLink(account,subject,handle) {
  const begin=(await call(north,'/api/ecosystem/aquamarine/start',{method:'POST',cookie:account.cookie,data:{}})).body;
  const payload=Buffer.from(JSON.stringify({iss:issuer,aud:north.origin,sub:subject,handle,purpose:'link',
    exp:Date.now()+120000,challenge:begin.challenge})).toString('base64url');
  const proof=payload+'.'+sign(null,Buffer.from('aquamarine-cezeos-link-v1.'+payload),aqua.privateKey).toString('base64url');
  await call(north,'/api/ecosystem/aquamarine/finish',{method:'POST',cookie:account.cookie,data:{proof}});
}

test('One Synclit recruits via applications reviewed by the verified Triumvirate',async()=>{
  const a=await account('Первый'),b=await account('Второй'),d=await account('Советник');
  const initial=(await call(north,'/api/governance',{cookie:a.cookie})).body;
  assert.equal(initial.triumvirs.length,3);
  assert.equal(initial.roles.triumvir,false);
  await signedLink(a,'alpha','Aqua_First');
  await signedLink(b,'beta','aqua.second');
  assert.equal((await call(north,'/api/governance',{cookie:a.cookie})).body.roles.triumvir,true);
  await call(north,'/api/governance/cases',{method:'POST',cookie:d.cookie,status:403,data:{title:'Нет доступа',body:'Текст'}});
  const first=(await call(north,'/api/governance/applications',{method:'POST',cookie:d.cookie,status:201,data:{body:'Старая заявка'}})).body;
  await call(north,'/api/governance/withdraw/'+first.id,{method:'POST',cookie:d.cookie,data:{}});
  const application=(await call(north,'/api/governance/applications',{method:'POST',cookie:d.cookie,status:201,data:{body:'Хочу участвовать'}})).body;
  await call(north,'/api/governance/applications',{method:'POST',cookie:d.cookie,status:409,data:{body:'Дубликат'}});
  assert.equal((await call(north,'/api/governance',{cookie:d.cookie})).body.application.status,'pending');
  assert.deepEqual((await call(north,'/api/governance')).body.applications,[]);
  assert.equal((await call(north,'/api/governance',{cookie:a.cookie})).body.applications[0].body,'Хочу участвовать');
  await call(north,'/api/governance/vote-application/'+application.id,{method:'POST',cookie:d.cookie,status:403,data:{approve:true}});
  for(const [who,status] of [[a,'pending'],[a,'pending'],[b,'approved']]){
    const vote=await call(north,'/api/governance/vote-application/'+application.id,{method:'POST',cookie:who.cookie,data:{approve:true}});
    assert.equal(vote.body.status,status);
  }
  const accepted=(await call(north,'/api/governance',{cookie:d.cookie})).body;
  assert.equal(accepted.application.status,'approved');
  assert.equal(accepted.roles.synclit,true);
  assert.equal(accepted.members,1);
  const item=(await call(north,'/api/governance/cases',{method:'POST',cookie:d.cookie,status:201,data:{title:'Дело Синклита',body:'Предложение'}})).body;
  assert.deepEqual((await call(north,'/api/governance')).body.cases,[]);
  for(const who of [a,b]) await call(north,'/api/governance/vote/'+item.id,{method:'POST',cookie:who.cookie,data:{approve:true}});

  const imposter=await account('Другая учётная запись');
  await signedLink(imposter,'different-stable-id','aqua_first');
  assert.equal((await call(north,'/api/governance',{cookie:imposter.cookie})).body.roles.triumvir,false);

  const destination=resolve(north.directory,'backup.sqlite');
  await runFile(process.execPath,['operator.mjs','backup',destination],{cwd:root,env:north.env});
  const snapshot=new DatabaseSync(destination,{readOnly:true});
  try{
    assert.equal(snapshot.prepare('SELECT status FROM synclit_cases WHERE id=?').get(item.id).status,'approved');
    assert.equal(snapshot.prepare('SELECT count(*) count FROM governance_audit WHERE kind=?').get('case-approved').count,1);
  }finally{snapshot.close();}
});
test('Aquamarine proof is one-time and both directions bind the recipient',async()=>{
  const {cookie,profile}=await account('Связанный аккаунт');
  const begin=(await call(north,'/api/ecosystem/aquamarine/start',{method:'POST',cookie,data:{}})).body;
  const payload=Buffer.from(JSON.stringify({iss:issuer,aud:north.origin,sub:'aqua-stable-id',purpose:'link',
    exp:Date.now()+120000,challenge:begin.challenge})).toString('base64url');
  const proof=payload+'.'+sign(null,Buffer.from('aquamarine-cezeos-link-v1.'+payload),aqua.privateKey).toString('base64url');
  await call(north,'/api/ecosystem/aquamarine/finish',{method:'POST',cookie,data:{proof},status:200});
  await call(north,'/api/ecosystem/aquamarine/finish',{method:'POST',cookie,data:{proof},status:400});
  assert.equal((await call(north,'/api/profiles/'+profile.id)).body.aquamarine,true);
  const challenge=randomBytes(32).toString('base64url');
  const grant=(await call(north,'/api/ecosystem/aquamarine/grant',{method:'POST',cookie,data:{challenge}})).body;
  const [body,signature]=grant.proof.split('.');
  const regionKey=createPublicKey({key:north.info.key,format:'jwk'});
  assert.ok(verify(null,Buffer.from('cezeos-aquamarine-grant-v1.'+body),regionKey,Buffer.from(signature,'base64url')));
  const claims=JSON.parse(Buffer.from(body,'base64url'));
  assert.equal(claims.aud,issuer);
  assert.equal(claims.challenge,challenge);
  assert.equal(claims.sub,'cezeos:'+north.info.id+':'+profile.id);
  await call(north,'/api/ecosystem/aquamarine/unlink',{method:'POST',cookie,data:{}});
  await call(north,'/api/ecosystem/aquamarine/grant',{method:'POST',cookie,data:{challenge},status:403});
});
