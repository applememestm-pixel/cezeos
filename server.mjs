import { createServer } from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { telegramSettings, telegramLogin } from './telegram.mjs';
import { openRegion } from './region.mjs';
import { createGovernance } from './governance.mjs';
import { createEcosystem } from './ecosystem.mjs';
import { createWiki } from './wiki.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const data = resolve(process.env.CEZEOS_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)));
const maxMedia = 24 * 1024 * 1024;
const telegramConfig = telegramSettings(process.env);
const sessionAge = 30 * 24 * 60 * 60;
const loopbackHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const demoAllowed = process.env.CEZEOS_ALLOW_DEMO === '1';
const loopbackPeer = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
const assets = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};
const formats = {
  'image/jpeg': 'photo', 'image/png': 'photo', 'image/webp': 'photo',
  'audio/mpeg': 'audio', 'audio/ogg': 'audio', 'audio/wav': 'audio', 'audio/x-wav': 'audio',
  'video/mp4': 'video', 'video/webm': 'video'
};
const workTypes = new Set(['Оригинал', 'Чужая запись', 'Кавер', 'Ремикс', 'Сэмпл', 'Совместная работа']);

mkdirSync(data, { recursive: true });
const region = openRegion(data, process.env);
const db = openStore(resolve(data, 'cezeos.sqlite'));
const governanceHome = process.env.CEZEOS_GOVERNANCE_HOME === '1';
const governanceRegion = process.env.CEZEOS_GOVERNANCE_REGION_ID || null;
if (governanceRegion && (governanceHome || !region.hasPeer(governanceRegion))) {
  throw new Error('Укажите один источник управления: этот сервер или ID известного Региона.');
}
const governance = governanceHome ? createGovernance(db,process.env.CEZEOS_AQUAMARINE_ISSUER) : null;
const ecosystem = createEcosystem(db, region, process.env, governance?.claim);
const wiki = createWiki(db, { getGroup: id => getGroup(id), membership: (m, g) => membership(m, g), profile: id => profile(id) });
const release = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
const androidCertificates = (process.env.CEZEOS_ANDROID_SHA256 || '').split(',').map(value=>value.trim().toUpperCase()).filter(Boolean);
if (androidCertificates.some(value=>!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))) throw new Error('Некорректный SHA-256 сертификата Android.');
db.exec(`
  CREATE TABLE IF NOT EXISTS attachments (post TEXT PRIMARY KEY REFERENCES posts ON DELETE CASCADE, bytes BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS telegram_accounts (
    client_id TEXT NOT NULL, subject TEXT NOT NULL, profile TEXT NOT NULL REFERENCES profiles,
    PRIMARY KEY (client_id, subject)
  );
`);

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  if (result.length > limit) throw problem(400, 'Текст превышает допустимую длину.');
  return result;
}

async function payload(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw problem(413, 'Файл слишком большой.');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw problem(400, 'Некорректный формат запроса.');
  }
}

function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function sessionCookie(value, age, secure = false) {
  return `cezeos=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}` + (secure ? '; Secure' : '');
}

function issueSession(member, secure = false) {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash, member, Date.now() + sessionAge * 1000);
  return sessionCookie(token, sessionAge, secure);
}

const handleTelegram = telegramLogin(telegramConfig, account => transaction(() => {
  let member = db.prepare('SELECT profile FROM telegram_accounts WHERE client_id = ? AND subject = ?')
    .get(telegramConfig.clientId, account.subject)?.profile;
  if (!member) {
    member = randomUUID();
    db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?)').run(member, account.name, 'author.' + member, '', 'mint');
    db.prepare('INSERT INTO telegram_accounts VALUES (?, ?, ?)').run(telegramConfig.clientId, account.subject, member);
  }
  return issueSession(member, telegramConfig.secure);
}));

function memberFor(req) {
  const token = req.headers.cookie?.match(/(?:^|;\s*)cezeos=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return {};
  const key = createHash('sha256').update(token).digest('hex');
  const session = db.prepare('SELECT member FROM sessions WHERE token = ? AND expires > ?').get(key, Date.now());
  return { member: session?.member, key };
}

function profile(id) {
  const user = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  return user && {...user, aquamarine:ecosystem.view(id).linked};
}

function friendship(viewer, target) {
  return db.prepare(`SELECT * FROM friendships WHERE (requester = ? AND recipient = ?) OR
    (requester = ? AND recipient = ?)`).get(viewer, target, target, viewer);
}

function membership(member, group) {
  return db.prepare('SELECT status FROM memberships WHERE member = ? AND group_id = ?').get(member, group)?.status;
}

function getGroup(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

function canRead(post, member) {
  if (!post) return false;
  if (post.author === member) return true;
  const group = post.group_id && getGroup(post.group_id);
  if (group?.closed && (!member || membership(member, group.id) !== 'member')) return false;
  if (post.visibility === 'public') return true;
  if (!member) return false;
  return post.visibility === 'members' || (post.visibility === 'friends' && friendship(member, post.author)?.status === 'accepted');
}

function serializePost(post, member) {
  const { media_path, media_mime, ...entry } = post;
  return {
    ...entry,
    media: media_path ?? (media_mime ? '/api/media/' + post.id : null),
    profile: profile(post.author),
    group: post.group_id ? getGroup(post.group_id) : null,
    likes: db.prepare('SELECT count(*) AS n FROM reactions WHERE post = ?').get(post.id).n,
    liked: Boolean(member && db.prepare('SELECT 1 FROM reactions WHERE post = ? AND member = ?').get(post.id, member)),
    bookmarked: Boolean(member && db.prepare('SELECT 1 FROM bookmarks WHERE member = ? AND post = ?').get(member,post.id)),
    comments: db.prepare('SELECT count(*) AS n FROM comments WHERE post = ?').get(post.id).n
  };
}

function groupSummary(group, member) {
  const size = db.prepare("SELECT count(*) AS n FROM memberships WHERE group_id = ? AND status = 'member'").get(group.id).n;
  const summary = { ...group, size, membership: member ? membership(member, group.id) : null };
  if (group.closed && member === group.owner) {
    summary.requests = db.prepare(`SELECT p.* FROM profiles p JOIN memberships m ON p.id = m.member
      WHERE m.group_id = ? AND m.status = 'pending'`).all(group.id);
  }
  return summary;
}

function needMember(member) {
  if (!member) throw problem(401, 'Войдите, чтобы выполнить это действие.');
  return member;
}

function mediaResponse(req, res, bytes, mime) {
  const size = bytes.length;
  const range = req.headers.range;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match && (match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2])));
    const end = match && (match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1);
    if (!match || (!match[1] && !match[2]) || start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
    return res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Length': size });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

async function api(req, res, url) {
  const method = req.method;
  const path = url.pathname.split('/').slice(2);
  const [resource, id, action] = path;
  const { member, key } = memberFor(req);
  const publicOrigin = req.headers.host === region.host ? region.descriptor.origin : null;
  const providerOrigin = telegramConfig && req.headers.host === telegramConfig.host ? telegramConfig.origin : null;
  const secureSession = publicOrigin?.startsWith('https:') ?? false;
  // CZ-SEC-001: demo sign-in (an account with no login at all) only when the
  // operator turned it on explicitly AND the connection really comes from this
  // machine. The Host header alone was spoofable: `Host: localhost` from any
  // address opened it on a bare `node server.mjs` bound to 0.0.0.0.
  const demo = demoAllowed && loopbackHost.test(req.headers.host || '') && loopbackPeer(req.socket.remoteAddress);
  if (method === 'GET' && resource === 'auth' && id === 'telegram' && ['start','callback'].includes(action) && path.length === 3) {
    return handleTelegram(req, res, url);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin !== (publicOrigin || `http://${req.headers.host}`)) throw problem(403, 'Недопустимый источник запроса.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw problem(403, 'Недопустимый источник запроса.');
    if (!req.headers['content-type']?.startsWith('application/json')) throw problem(415, 'Ожидается JSON.');
  }

  if (method === 'GET' && resource === 'regions' && path.length <= 2) {
    if (!id) return json(res, await region.list());
    const remote = await region.feed(id);
    if (!remote) throw problem(404, 'Регион не настроен.');
    if (!remote.available) throw problem(503, 'Регион недоступен или его подпись не прошла проверку.');
    return json(res, remote);
  }
  if (method === 'GET' && resource === 'federation' && id === 'public-feed' && path.length === 2) {
    const posts=db.prepare(`SELECT p.id,p.body,p.title,p.created,u.name AS author
      FROM posts p JOIN profiles u ON u.id=p.author LEFT JOIN groups g ON g.id=p.group_id
      WHERE p.visibility='public' AND (g.id IS NULL OR g.closed=0) ORDER BY p.created DESC LIMIT 30`).all();
    return json(res,region.publicFeed(posts,governance?.publicSummary()));
  }
  if (resource === 'governance') {
    if (!id && method==='GET') {
      if(governance) return json(res,{available:true,local:true,...governance.summary(member)});
      const remote=governanceRegion ? await region.feed(governanceRegion) : null;
      return json(res,{available:Boolean(remote?.available && remote.governance),local:false,home:remote?.origin||null,...remote?.governance});
    }
    if (method==='POST') {
      if(!governance) throw problem(403,'Заявки и голосования принимает общий сервер управления.');
      needMember(member);
      const input=await payload(req);
      if (id==='applications' && !action) return json(res,transaction(()=>governance.apply(member,clean(input.body,2000))),201);
      if (id==='withdraw' && action) return json(res,transaction(()=>governance.withdraw(member,action)));
      if (id==='cases' && !action) return json(res,transaction(()=>governance.propose(member,clean(input.title,140),clean(input.body,4000))),201);
      if (id==='vote-application' && action) return json(res,transaction(()=>governance.vote(member,'application',action,input.approve)));
      if (id==='vote' && action) return json(res,transaction(()=>governance.vote(member,'case',action,input.approve)));
    }
  }
  if (resource==='ecosystem' && id==='aquamarine') {
    if (!action && method==='GET') return json(res,ecosystem.view(member));
    if (method==='POST') {
      needMember(member);
      const input=await payload(req);
      if (action==='start') return json(res,ecosystem.start(member));
      if (action==='finish') return json(res,transaction(()=>ecosystem.finish(member,input.proof)));
      if (action==='unlink') return json(res,transaction(()=>ecosystem.unlink(member)));
      if (action==='grant') return json(res,ecosystem.grant(member,input.challenge));
    }
  }

  if (resource === 'session' && !id && method === 'GET') {
    return json(res, { profile: member ? profile(member) : null, providers: { telegram: Boolean(providerOrigin), aquamarine: false, demo } });
  }
  if (resource === 'session' && id === 'demo' && method === 'POST') {
    if (!demo) throw problem(404, 'Деморежим доступен только локально.');
    if (member) return json(res, { profile: profile(member) });
    const body = await payload(req);
    const name = clean(body.name, 45);
    if (!name) throw problem(400, 'Укажите имя.');
    const user = randomUUID();
    const cookie = transaction(() => {
      db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?)').run(user, name, 'author.' + user.slice(0, 8), '', 'mint');
      return issueSession(user, secureSession);
    });
    res.setHeader('Set-Cookie', cookie);
    return json(res, { profile: profile(user) }, 201);
  }
  if (resource === 'session' && !id && method === 'DELETE') {
    if (key) db.prepare('DELETE FROM sessions WHERE token = ?').run(key);
    res.setHeader('Set-Cookie', sessionCookie('', 0, secureSession));
    return json(res, { profile: null });
  }

  if (resource === 'bookmarks' && !id && method === 'GET') {
    needMember(member);
    const saved = db.prepare(`SELECT p.* FROM bookmarks b JOIN posts p ON p.id=b.post
      WHERE b.member=? ORDER BY b.saved DESC,p.id DESC`).iterate(member);
    const result=[];
    for (const entry of saved) {
      if (!canRead(entry,member)) continue;
      result.push(serializePost(entry,member));
      if (result.length===60) break;
    }
    return json(res,result);
  }

  if (resource === 'posts' && !id && method === 'GET') {
    const mode = url.searchParams.get('mode');
    const kind = url.searchParams.get('kind');
    const group = url.searchParams.get('group');
    const author = url.searchParams.get('author');
    const query = url.searchParams.get('q')?.toLocaleLowerCase('ru') || '';
    const filters = [], values = [];
    for (const [column, value] of [['kind', kind], ['group_id', group], ['author', author]]) {
      if (value) { filters.push(column + ' = ?'); values.push(value); }
    }
    if (mode === 'work') filters.push("kind != 'text'");
    if (mode === 'groups') filters.push('group_id IS NOT NULL');
    const order = author || group ? 'pinned DESC, created DESC' : 'created DESC';
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const rows = db.prepare('SELECT * FROM posts' + where + ' ORDER BY ' + order).iterate(...values);
    const result = [];
    for (const row of rows) {
      if (!canRead(row, member)) continue;
      if (mode === 'social' && (!member || (row.author !== member &&
          !db.prepare('SELECT 1 FROM follows WHERE member = ? AND target = ?').get(member, row.author) &&
          friendship(member, row.author)?.status !== 'accepted'))) continue;
      if (query && ![row.body, row.title, row.credit].some(field => field.toLocaleLowerCase('ru').includes(query))) continue;
      result.push(serializePost(row, member));
      if (result.length === 60) break;
    }
    return json(res, result);
  }
  if (resource === 'posts' && !id && method === 'POST') {
    needMember(member);
    const input = await payload(req, Math.ceil(maxMedia / 3) * 4 + 65536);
    const body = clean(input.body, 4000);
    const title = clean(input.title, 120);
    const credit = clean(input.credit, 150);
    const group = input.group || null;
    if (group && (typeof group !== 'string' || membership(member, group) !== 'member')) {
      throw problem(403, 'Для публикации нужно вступить в сообщество.');
    }
    const visibility = input.visibility || 'public';
    if (!['public', 'members', 'friends', 'private'].includes(visibility)) throw problem(400, 'Неизвестный режим видимости.');
    const mime = input.media?.mime;
    const kind = mime ? (typeof mime === 'string' && Object.hasOwn(formats, mime) ? formats[mime] : null) : input.article === true ? 'article' : 'text';
    if ((input.media && !mime) || !kind) throw problem(400, 'Формат вложения не поддерживается.');
    if (!body && !mime) throw problem(400, 'Введите текст или добавьте вложение.');
    if ((mime || kind === 'article') && !title) throw problem(400, 'Укажите название.');
    const workType = workTypes.has(input.workType) ? input.workType : 'Оригинал';
    const id = randomUUID();
    const bytes = mime && typeof input.media.data === 'string' ? Buffer.from(input.media.data, 'base64') : null;
    if (mime && (!bytes?.length || bytes.length > maxMedia)) throw problem(413, 'Размер вложения должен быть до 24 МиБ.');
    transaction(() => {
      db.prepare(`INSERT INTO posts (id, author, group_id, body, kind, title, credit, work_type, media_mime, visibility, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, member, group, body, kind, title, credit || (mime ? 'Автор неизвестен' : ''), workType, mime || null, visibility, Date.now());
      if (bytes) db.prepare('INSERT INTO attachments VALUES (?, ?)').run(id, bytes);
    });
    return json(res, { id }, 201);
  }
  if ((resource === 'posts' || resource === 'media') && id) {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    if (!canRead(post, member)) throw problem(404, 'Публикация недоступна.');
    if (resource === 'media' && ['GET', 'HEAD'].includes(method)) {
      const attachment = db.prepare('SELECT bytes FROM attachments WHERE post = ?').get(id);
      if (!attachment) throw problem(404, 'Файл недоступен.');
      return mediaResponse(req, res, attachment.bytes, post.media_mime);
    }
    if (resource === 'posts' && !action && method === 'GET') return json(res, serializePost(post, member));
    if (resource === 'posts' && action === 'comments' && method === 'GET') {
      const comments = db.prepare('SELECT * FROM comments WHERE post = ? ORDER BY created LIMIT 200').all(id);
      return json(res, comments.map(comment => ({ ...comment, profile: profile(comment.author) })));
    }
    if (resource === 'posts' && method !== 'GET') {
      needMember(member);
      if (action === 'bookmark' && method === 'POST') {
        const { active }=await payload(req);
        if (typeof active!=='boolean') throw problem(400,'Укажите состояние закладки.');
        const latest=db.prepare('SELECT * FROM posts WHERE id=?').get(id);
        if (!canRead(latest,member)) throw problem(404,'Публикация недоступна.');
        if (active) db.prepare('INSERT OR IGNORE INTO bookmarks VALUES (?,?,?)').run(member,id,Date.now());
        else db.prepare('DELETE FROM bookmarks WHERE member=? AND post=?').run(member,id);
        return json(res,{bookmarked:active});
      }
      if (action === 'like' && method === 'POST') {
        const input = await payload(req);
        if (input.active === true) db.prepare('INSERT OR IGNORE INTO reactions VALUES (?, ?)').run(member, id);
        if (input.active === false) db.prepare('DELETE FROM reactions WHERE member = ? AND post = ?').run(member, id);
        return json(res, serializePost(post, member));
      }
      if (action === 'comments' && method === 'POST') {
        const body = clean((await payload(req)).body, 1000);
        if (!body) throw problem(400, 'Введите комментарий.');
        db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?)').run(randomUUID(), id, member, body, Date.now());
        return json(res, { ok: true }, 201);
      }
      if (!action && ['PATCH', 'DELETE'].includes(method)) {
        if (post.author !== member) throw problem(403, 'Изменения доступны автору.');
        if (method === 'DELETE') {
          db.prepare('DELETE FROM posts WHERE id = ?').run(id);
        } else {
          const input = await payload(req);
          const body = input.body === undefined ? post.body : clean(input.body, 4000);
          if (!body && !post.media_path && !post.media_mime) throw problem(400, 'Введите текст записи.');
          db.prepare('UPDATE posts SET body = ?, pinned = ? WHERE id = ?').run(body, typeof input.pinned === 'boolean' ? Number(input.pinned) : post.pinned, id);
        }
        return json(res, { ok: true });
      }
    }
  }

  if (resource === 'profiles' && !id && method === 'GET') {
    const query = url.searchParams.get('q')?.toLocaleLowerCase('ru') || '';
    return json(res, db.prepare('SELECT * FROM profiles ORDER BY name').all()
      .filter(person => [person.name, person.handle].some(value => value.toLocaleLowerCase('ru').includes(query)))
      .slice(0, 60).map(person => ({
        ...person, following: Boolean(member && db.prepare('SELECT 1 FROM follows WHERE member = ? AND target = ?').get(member, person.id)),
        friendship: member ? friendship(member, person.id) : null
      })));
  }
  if (resource === 'profiles' && id) {
    const target = profile(id);
    if (!target) throw problem(404, 'Профиль не найден.');
    if (!action && method === 'GET') {
      const following = Boolean(member && db.prepare('SELECT 1 FROM follows WHERE member = ? AND target = ?').get(member, id));
      return json(res, { ...target, following, friendship: member ? friendship(member, id) : null });
    }
    needMember(member);
    if (!action && method === 'PATCH' && id === member) {
      const input = await payload(req);
      const name = clean(input.name, 45);
      if (!name) throw problem(400, 'Укажите имя.');
      db.prepare('UPDATE profiles SET name = ?, bio = ? WHERE id = ?').run(name, clean(input.bio, 350), id);
      return json(res, profile(id));
    }
    if (action === 'follow' && method === 'POST' && id !== member) {
      const input = await payload(req);
      if (input.active) db.prepare('INSERT OR IGNORE INTO follows VALUES (?, ?)').run(member, id);
      else db.prepare('DELETE FROM follows WHERE member = ? AND target = ?').run(member, id);
      return json(res, { ok: true });
    }
    if (action === 'friend' && method === 'POST' && id !== member) {
      const input = await payload(req);
      const old = friendship(member, id);
      if (!old && input.command === 'request') {
        db.prepare("INSERT INTO friendships VALUES (?, ?, 'pending')").run(member, id);
      }
      if (old?.recipient === member && old.status === 'pending' && input.command === 'accept') {
        db.prepare("UPDATE friendships SET status = 'accepted' WHERE requester = ? AND recipient = ?").run(id, member);
      }
      if (old && input.command === 'remove') db.prepare('DELETE FROM friendships WHERE requester = ? AND recipient = ?').run(old.requester, old.recipient);
      return json(res, { ok: true });
    }
  }

  if (resource === 'groups' && !id && method === 'GET') {
    return json(res, db.prepare('SELECT * FROM groups ORDER BY rowid DESC LIMIT 60').all().map(group => groupSummary(group, member)));
  }
  if (resource === 'groups' && !id && method === 'POST') {
    needMember(member);
    const input = await payload(req);
    const name = clean(input.name, 65);
    if (!name) throw problem(400, 'Введите название сообщества.');
    const group = randomUUID();
    transaction(() => {
      db.prepare('INSERT INTO groups VALUES (?, ?, ?, ?, ?, ?)').run(group, member, name, clean(input.bio, 400), 'mint', Number(input.closed === true));
      db.prepare('INSERT INTO memberships (member, group_id) VALUES (?, ?)').run(member, group);
    });
    return json(res, { id: group }, 201);
  }
  if (resource === 'groups' && id) {
    const group = getGroup(id);
    if (!group) throw problem(404, 'Сообщество не найдено.');
    if (!action && method === 'GET') return json(res, groupSummary(group, member));
    if (action === 'wiki' && method === 'GET') return json(res, wiki.groupView(member, id));
    if (action === 'wiki' && method === 'POST') { const input = await payload(req); return json(res, transaction(() => wiki.groupSettings(member, id, input))); }
    if (action === 'wiki-log' && method === 'GET') return json(res, wiki.groupLog(member, id));
    if (action === 'join' && method === 'POST') {
      needMember(member);
      const input = await payload(req);
      if (input.active) {
        db.prepare('INSERT OR IGNORE INTO memberships VALUES (?, ?, ?)').run(member, id, group.closed ? 'pending' : 'member');
      } else if (group.owner !== member) {
        transaction(() => {
          db.prepare('DELETE FROM memberships WHERE member = ? AND group_id = ?').run(member, id);
          wiki.left(member, id);
        });
      }
      return json(res, groupSummary(group, member));
    }
    if (action === 'members' && method === 'POST' && member === group.owner) {
      const input = await payload(req);
      if (typeof input.member !== 'string') throw problem(400, 'Требуется участник.');
      if (input.accept) {
        db.prepare("UPDATE memberships SET status = 'member' WHERE member = ? AND group_id = ? AND status = 'pending'").run(input.member, id);
      } else {
        db.prepare("DELETE FROM memberships WHERE member = ? AND group_id = ? AND status = 'pending'").run(input.member, id);
      }
      return json(res, groupSummary(group, member));
    }
  }

  // Wiki (wiki.mjs): every right is checked there, on the server.
  if (resource === 'wiki') {
    const sub = path[3];
    if (!id && method === 'GET') return json(res, wiki.list(member, url.searchParams.get('group')));
    if (!id && method === 'POST') { const input = await payload(req); return json(res, transaction(() => wiki.create(member, input)), 201); }
    if (id && !action && method === 'GET') return json(res, wiki.page(member, id));
    if (id && !action && method === 'POST') { const input = await payload(req); return json(res, transaction(() => wiki.edit(member, id, input)), 201); }
    if (action === 'suggest' && method === 'POST') { const input = await payload(req); return json(res, transaction(() => wiki.suggest(member, id, input)), 201); }
    if (action === 'suggestions' && sub && method === 'GET') return json(res, wiki.suggestion(member, id, sub));
    if (action === 'suggestions' && sub && method === 'POST') { const input = await payload(req); return json(res, transaction(() => wiki.decide(member, id, sub, input.accept === true))); }
    if (action === 'history' && method === 'GET') return json(res, wiki.history(member, id, { before: Number(url.searchParams.get('before')) }));
    if (action === 'versions' && sub && method === 'GET') return json(res, wiki.version(member, id, Number(sub)));
    if (action === 'diff' && method === 'GET') return json(res, wiki.diff(member, id, Number(url.searchParams.get('from')), Number(url.searchParams.get('to'))));
    if (action === 'rollback' && method === 'POST') { const input = await payload(req); return json(res, transaction(() => wiki.rollback(member, id, input)), 201); }
    if (action === 'settings' && method === 'POST') { const input = await payload(req); return json(res, transaction(() => wiki.settings(member, id, input))); }
    if (action === 'log' && method === 'GET') return json(res, wiki.log(member, id));
  }
  throw problem(404, 'Запрос не найден.');
}

function staticFile(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) throw problem(405, 'Метод не поддерживается.');
  const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!path.startsWith(resolve(root) + sep)) throw problem(404, 'Страница не найдена.');
  const mime = assets[extname(path)];
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!mime || !stat?.isFile()) throw problem(404, 'Файл не найден.');
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).on('error', () => res.destroy()).pipe(res);
}

const requestedPort = Number(process.env.CEZEOS_PORT || 4173);
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    if (!loopbackHost.test(req.headers.host || '') && req.headers.host !== region.host) throw problem(403, 'Используйте адрес этого Региона.');
    const url = new URL(req.url, 'http://localhost');
    if (req.method==='GET' && url.pathname==='/healthz') {
      db.prepare('SELECT 1').get();
      return json(res,{status:'ok',version:release,region:region.descriptor.id});
    }
    if (req.method==='GET' && url.pathname==='/.well-known/cezeos-region.json') return json(res,region.descriptor);
    if (req.method==='GET' && url.pathname==='/.well-known/assetlinks.json' && androidCertificates.length) {
      return json(res,[{relation:['delegate_permission/common.handle_all_urls'],target:{
        namespace:'android_app',package_name:'org.cezeos.app',sha256_cert_fingerprints:androidCertificates
      }}]);
    }
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else staticFile(req, res, url);
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) json(res, { error: error.status ? error.message : 'Не удалось выполнить запрос.' }, error.status || 500);
    else res.destroy();
  }
});

const bind = process.env.CEZEOS_BIND || '127.0.0.1';
server.listen(requestedPort, bind, () => console.log(`CeZeOs · http://127.0.0.1:${server.address().port}/`));
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => server.closeAllConnections(), 8000).unref();
  server.close(() => {
    clearTimeout(deadline);
    db.close();
  });
}
for (const signal of ['SIGTERM','SIGINT']) process.once(signal,shutdown);
