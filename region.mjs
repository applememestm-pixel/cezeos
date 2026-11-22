import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fingerprint(publicKey) {
  return createHash('sha256').update(publicKey.export({ format:'der', type:'spki' })).digest('base64url');
}

function endpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1','localhost','host.docker.internal'].includes(url.hostname)))) {
    throw new Error('Адрес Региона должен быть HTTPS либо локальным HTTP.');
  }
  return url.origin;
}

function keyFor(folder) {
  const file = join(folder, 'region-key.pem');
  try { return readFileSync(file,'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { privateKey } = generateKeyPairSync('ed25519');
  const text = privateKey.export({ format:'pem', type:'pkcs8' });
  try { writeFileSync(file,text,{flag:'wx',mode:0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return readFileSync(file,'utf8'); }
  return text;
}

function message(body) {
  return Buffer.from('cezeos-region-v1.'+body);
}

export function openRegion(folder, env) {
  const origin = env.CEZEOS_PUBLIC_ORIGIN ? endpoint(env.CEZEOS_PUBLIC_ORIGIN) : null;
  const key = keyFor(folder);
  const publicKey = createPublicKey(key);
  const id = fingerprint(publicKey);
  const name = (env.CEZEOS_REGION_NAME || 'CeZeOs · Локальный регион').trim().slice(0,80);
  const descriptor = { id, name, origin, protocol:1, key:publicKey.export({ format:'jwk' }) };
  const configured = JSON.parse(env.CEZEOS_PEERS || '[]');
  if (!Array.isArray(configured) || configured.length > 8) throw new Error('CEZEOS_PEERS допускает до восьми Регионов.');
  const peers = configured.map(item=>{
    if (!/^[A-Za-z0-9_-]{43}$/.test(item.id)) throw new Error('Укажите ID доверенного Региона.');
    return { origin:endpoint(item.origin), id:item.id };
  });
  if (new Set(peers.map(item=>item.id)).size !== peers.length) throw new Error('Регион указан несколько раз.');
  const cache = new Map();
  const pending = new Map();

  async function read(peer) {
    const hit=cache.get(peer.id);
    if (hit && hit.expires>Date.now()) return hit.data;
    if (pending.has(peer.id)) return pending.get(peer.id);
    const load=readPeer(peer).catch(()=>({origin:peer.origin,id:peer.id,available:false})).then(data=>{
      cache.set(peer.id,{data,expires:Date.now()+15000});
      return data;
    }).finally(()=>pending.delete(peer.id));
    pending.set(peer.id,load);
    return load;
  }

  return {
    descriptor,
    host: origin && new URL(origin).host,
    hasPeer(id) { return peers.some(peer=>peer.id===id); },
    publicFeed(posts,governance) {
      const body = Buffer.from(JSON.stringify({type:'public-feed',region:descriptor,time:Date.now(),posts,governance})).toString('base64url');
      return { body, signature:sign(null,message(body),key).toString('base64url') };
    },
    ecosystemGrant(claims) {
      const id = 'cezeos:' + descriptor.id + ':' + claims.sub;
      const body=Buffer.from(JSON.stringify({...claims,sub:id,region:descriptor.id})).toString('base64url');
      return {proof: body+'.'+sign(null,Buffer.from('cezeos-aquamarine-grant-v1.'+body),key).toString('base64url')};
    },
    async list() {
      const trusted=await Promise.all(peers.map(read));
      return { local:descriptor, peers:trusted.map(({posts,...peer})=>peer) };
    },
    async feed(id) {
      const peer=peers.find(item=>item.id===id);
      return peer ? read(peer) : null;
    }
  };
}

async function readPeer(peer) {
  const response=await fetch(peer.origin+'/api/federation/public-feed',{redirect:'error',signal:AbortSignal.timeout(3500)});
  if (!response.ok || !response.body) throw new Error('Регион недоступен.');
  const chunks=[];
  let length=0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length>512000) throw new Error('Ответ Региона слишком большой.');
    chunks.push(chunk);
  }
  const {body,signature}=JSON.parse(Buffer.concat(chunks));
  if (typeof body!=='string' || !/^[\w-]+$/.test(body) || !/^[\w-]{86}$/.test(signature)) throw new Error('Некорректная подпись.');
  const data=JSON.parse(Buffer.from(body,'base64url'));
  const {region,time}=data;
  if (data.type!=='public-feed' || region.id!==peer.id || region.origin!==peer.origin || region.protocol!==1 ||
      region.key?.kty!=='OKP' || region.key.crv!=='Ed25519' || !Number.isSafeInteger(time) || Math.abs(Date.now()-time)>120000 ||
      typeof region.name!=='string' || !Array.isArray(data.posts) || data.posts.length>30) throw new Error('Несовместимый Регион.');
  const key=createPublicKey({key:region.key,format:'jwk'});
  if (fingerprint(key)!==peer.id || !verify(null,message(body),key,Buffer.from(signature,'base64url'))) throw new Error('Подпись Региона не совпала.');
  const posts=data.posts.filter(post=>post && typeof post.id==='string' && /^[a-z0-9-]{1,80}$/.test(post.id) &&
    typeof post.body==='string' && post.body.length<=4000 && typeof post.title==='string' && post.title.length<=120 &&
    typeof post.author==='string' && post.author.length<=100 && Number.isSafeInteger(post.created) && post.created>=0 && post.created<=Date.now()+120000)
    .map(({id,body,title,author,created})=>({id,body,title,author,created}));
  const governance=data.governance;
  const globalBody=governance && Array.isArray(governance.triumvirs) && governance.triumvirs.length<=3 &&
    governance.triumvirs.every(seat=>seat && typeof seat.nickname==='string' && /^[a-z0-9_.]{3,32}$/.test(seat.nickname) && typeof seat.verified==='boolean') &&
    Number.isSafeInteger(governance.members) && governance.members>=0
      ? {triumvirs:governance.triumvirs.map(({nickname,verified})=>({nickname,verified})),members:governance.members} : null;
  return {id:peer.id,origin:peer.origin,name:region.name,available:true,posts,governance:globalBody};
}
