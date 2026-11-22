import { aquaNickname, validAquaNickname } from './governance.mjs';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

function fail(status,message) { throw Object.assign(new Error(message),{status}); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function createEcosystem(db, region, env, onLink = () => {}) {
  const issuer=env.CEZEOS_AQUAMARINE_ISSUER;
  const encodedKey=env.CEZEOS_AQUAMARINE_PUBLIC_KEY;
  const active=Boolean(issuer && encodedKey && region.descriptor.origin);
  let key;
  if (active) {
    const url=new URL(issuer);
    if (url.protocol!=='https:' || url.origin!==issuer) throw new Error('CEZEOS_AQUAMARINE_ISSUER должен быть HTTPS origin.');
    key=createPublicKey({key:JSON.parse(encodedKey),format:'jwk'});
    if (key.asymmetricKeyType!=='ed25519') throw new Error('Требуется публичный ключ Ed25519 Aquamarine.');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS aquamarine_links (
      member TEXT PRIMARY KEY REFERENCES profiles, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      linked_at INTEGER NOT NULL, UNIQUE(issuer,subject)
    );
    CREATE TABLE IF NOT EXISTS aquamarine_link_requests (
      member TEXT PRIMARY KEY REFERENCES profiles, challenge TEXT NOT NULL, expires INTEGER NOT NULL
    );
  `);

  function linkFor(member) {
    return member ? db.prepare('SELECT issuer,subject,linked_at FROM aquamarine_links WHERE member=?').get(member) : null;
  }

  return {
    view(member) { return {available:active, issuer:active?issuer:null, linked:Boolean(linkFor(member))}; },
    start(member) {
      if(!active) fail(503,'Подтверждение Aquamarine не настроено.');
      const challenge=randomBytes(32).toString('base64url');
      db.prepare(`INSERT INTO aquamarine_link_requests VALUES (?,?,?) ON CONFLICT(member)
        DO UPDATE SET challenge=excluded.challenge,expires=excluded.expires`).run(member,hash(challenge),Date.now()+300000);
      return {challenge,audience:region.descriptor.origin,issuer,expiresIn:300};
    },
    finish(member, proof) {
      if(!active) fail(503,'Подтверждение Aquamarine не настроено.');
      if(typeof proof!=='string' || proof.length>8192) fail(400,'Требуется подписанное подтверждение.');
      let claims;
      try {
        const parts=proof.split('.');
        if(parts.length!==2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]{86}$/.test(parts[1]) ||
          !verify(null,Buffer.from('aquamarine-cezeos-link-v1.'+parts[0]),key,Buffer.from(parts[1],'base64url'))) throw new Error();
        claims=JSON.parse(Buffer.from(parts[0],'base64url'));
      } catch { fail(400,'Подпись Aquamarine не прошла проверку.'); }
      const request=db.prepare('SELECT challenge,expires FROM aquamarine_link_requests WHERE member=?').get(member);
      const now=Date.now();
      if(!claims || claims.iss!==issuer || claims.aud!==region.descriptor.origin || claims.purpose!=='link' ||
        typeof claims.sub!=='string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(claims.sub) ||
        !Number.isSafeInteger(claims.exp) || claims.exp<=now || claims.exp>now+300000 ||
        typeof claims.challenge!=='string' || !/^[\w-]{43}$/.test(claims.challenge) ||
        !request || request.expires<=now || request.challenge!==hash(claims.challenge)) fail(400,'Подтверждение не подходит к текущему запросу.');
      const nickname=aquaNickname(claims.handle);
      if (claims.handle!==undefined && !validAquaNickname(nickname)) fail(400,'Некорректный ник Aquamarine.');
      const existing=linkFor(member);
      const owner=db.prepare('SELECT member FROM aquamarine_links WHERE issuer=? AND subject=?').get(issuer,claims.sub);
      if ((existing && (existing.issuer!==issuer || existing.subject!==claims.sub)) || (owner && owner.member!==member)) {
        fail(409,'Этот аккаунт уже подключён к другому профилю или требуется отключить предыдущую привязку.');
      }
      if (!existing) db.prepare('INSERT INTO aquamarine_links VALUES (?,?,?,?)').run(member,issuer,claims.sub,now);
      onLink(issuer,claims.sub,nickname);
      db.prepare('DELETE FROM aquamarine_link_requests WHERE member=?').run(member);
      return {linked:true};
    },
    unlink(member) {
      db.prepare('DELETE FROM aquamarine_links WHERE member=?').run(member);
      db.prepare('DELETE FROM aquamarine_link_requests WHERE member=?').run(member);
      return {linked:false};
    },
    grant(member, challenge) {
      const link=linkFor(member);
      if(!active || !link || link.issuer!==issuer) fail(403,'Сначала подключите Aquamarine.');
      if(typeof challenge!=='string' || !/^[\w-]{43}$/.test(challenge)) fail(400,'Требуется запрос от Aquamarine.');
      return region.ecosystemGrant({
        iss:region.descriptor.origin, aud:issuer, sub:member, aquamarineSubject:link.subject,
        challenge, exp:Date.now()+60000, permissions:['cezeos.badge','cezeos.profile'],
        profile:region.descriptor.origin+'/#profile/'+encodeURIComponent(member)
      });
    }
  };
}
