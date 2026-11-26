import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
let server, directory, url;

before(async () => {
  directory = await mkdtemp(resolve(root, 'data-test-'));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, CEZEOS_DATA_DIR: directory, CEZEOS_PORT: '0', CEZEOS_ALLOW_DEMO: '1' }
  });
  const failed = once(server, 'exit').then(([code]) => { throw new Error('Server exited before ready: ' + code); });
  const received = once(server.stdout, 'data').then(([chunk]) => String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]);
  url = await Promise.race([received, failed]);
  assert.ok(url);
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function call(path, { method = 'GET', cookie, data, status = 200, headers = {} } = {}) {
  const response = await fetch(url + path, {
    method, headers: { ...(data ? {'Content-Type':'application/json'} : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(data ? { body: JSON.stringify(data) } : {})
  });
  assert.equal(response.status, status, method + ' ' + path);
  return response;
}

async function asUser(name) {
  const response = await call('api/session/demo', { method: 'POST', data: { name }, status: 201 });
  return { user: (await response.json()).profile, cookie: response.headers.get('set-cookie').split(';')[0] };
}

test('shell, demo sessions, media visibility, friends, reactions, and comments', async () => {
  assert.match(await (await call('')).text(), /CeZeOs/);
  const seeded = await (await call('api/posts')).json();
  assert.equal(seeded.length, 3);
  for (const asset of ['assets/after-rain.png', 'assets/between-stations.wav', 'manifest.webmanifest']) {
    const response = await call(asset);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  await call('api/posts', { method: 'POST', data: { body: 'guest' }, status: 401 });
  const a = await asUser('Первый автор'), b = await asUser('Второй автор');
  const response = await call('api/posts', {
    method: 'POST', cookie: a.cookie, status: 201,
    data: { body: 'закрытое вложение', title: 'Запись', visibility: 'friends', media: { mime: 'audio/mpeg', data: 'AQIDBA==' } }
  });
  const { id } = await response.json();
  await call('api/posts/' + id, { status: 404 });
  await call('api/media/' + id, { cookie: b.cookie, status: 404 });
  const ownerMedia = await call('api/media/' + id, { cookie: a.cookie, headers: { Range: 'bytes=1-2' }, status: 206 });
  assert.deepEqual([...new Uint8Array(await ownerMedia.arrayBuffer())], [2, 3]);
  await call('api/profiles/' + b.user.id + '/friend', { method: 'POST', cookie: a.cookie, data: { command: 'request' } });
  await call('api/profiles/' + a.user.id + '/friend', { method: 'POST', cookie: b.cookie, data: { command: 'accept' } });
  const post = await (await call('api/posts/' + id, { cookie: b.cookie })).json();
  assert.equal(post.body, 'закрытое вложение');
  for (let repeat = 0; repeat < 2; repeat++) {
    const liked = await (await call('api/posts/' + id + '/like', { method: 'POST', cookie: b.cookie, data: { active: true } })).json();
    assert.equal(liked.likes, 1);
  }
  await call('api/posts/' + id + '/comments', { method: 'POST', cookie: b.cookie, data: { body: 'проверено' }, status: 201 });
  assert.equal((await (await call('api/posts/' + id + '/comments', { cookie: a.cookie })).json()).length, 1);
  await call('api/posts/' + id, { method: 'PATCH', cookie: b.cookie, status: 403, data: { pinned: true } });
  await call('api/posts/' + id, { method: 'DELETE', cookie: a.cookie, data: {} });
  await call('api/media/' + id, { cookie: a.cookie, status: 404 });
});

test('closed group approval and conflicting wiki revisions', async () => {
  const a = await asUser('Администратор'), b = await asUser('Участник');
  const add = await call('api/groups', { method: 'POST', cookie: a.cookie, data: {name:'Круг',closed:true}, status: 201 });
  const { id } = await add.json();
  const created = await call('api/posts', { method: 'POST', cookie: a.cookie, data: { body:'Только для группы',group:id }, status: 201 });
  const post = (await created.json()).id;
  await call('api/groups/' + id + '/join', { method: 'POST', cookie: b.cookie, data: { active:true } });
  await call('api/posts/' + post, { cookie: b.cookie, status: 404 });
  await call('api/groups/' + id + '/members', { method: 'POST', cookie: a.cookie, data: { member:b.user.id,accept:true } });
  await call('api/posts/' + post, { cookie: b.cookie });
  const addArticle = await call('api/wiki', { method: 'POST', cookie: a.cookie, data: { title:'Архив',body:'Версия первая' }, status: 201 });
  const article = (await addArticle.json()).id;
  await call('api/wiki/' + article, { method: 'POST', cookie: b.cookie, data: { title:'Архив',body:'Версия вторая',revision:1 }, status: 201 });
  await call('api/wiki/' + article, { method: 'POST', cookie: a.cookie, data: { title:'Архив',body:'Устаревшее изменение',revision:1 }, status: 409 });
  const history = await (await call('api/wiki/' + article)).json();
  assert.deepEqual(history.versions.map(version => version.revision), [2, 1]);
});

// Wiki rights (owner, 26.11): four modes per community and per page,
// protected pages, suggestions, diff, rollback and a log — all on the server.
async function community(owner, ...members) {
  const { id } = await (await call('api/groups', { method: 'POST', cookie: owner.cookie, data: { name: 'Вики-круг' }, status: 201 })).json();
  for (const m of members) await call('api/groups/' + id + '/join', { method: 'POST', cookie: m.cookie, data: { active: true } });
  return id;
}
const page = (cookie, id) => call('api/wiki/' + id, { cookie }).then(r => r.json());
const edit = (who, id, revision, body, status = 201) =>
  call('api/wiki/' + id, { method: 'POST', cookie: who.cookie, data: { title: 'Статья', body, revision }, status });

test('wiki: the four modes, checked on the server', async () => {
  const owner = await asUser('Владелец вики'), m = await asUser('Участник вики'), e = await asUser('Редактор вики');
  const outsider = await asUser('Посторонний');
  const g = await community(owner, m, e);
  const { id } = await (await call('api/wiki', { method: 'POST', cookie: m.cookie, data: { title: 'Статья', body: 'v1', group: g }, status: 201 })).json();
  // open: every member of the community; not someone outside it; not a guest.
  await edit(owner, id, 1, 'v2');
  await edit(outsider, id, 2, 'чужая', 403);
  await call('api/wiki/' + id, { method: 'POST', data: { title: 'x', body: 'x', revision: 2 }, status: 401 });
  // trusted: only editors and moderators.
  await call('api/groups/' + g + '/wiki', { method: 'POST', cookie: m.cookie, data: { mode: 'trusted' }, status: 403 });
  await call('api/groups/' + g + '/wiki', { method: 'POST', cookie: owner.cookie, data: { mode: 'trusted' } });
  await edit(m, id, 2, 'без права', 403);
  await edit(e, id, 2, 'тоже без права', 403);
  await call('api/groups/' + g + '/wiki', { method: 'POST', cookie: owner.cookie, data: { member: e.user.id, role: 'editor', add: true } });
  await edit(e, id, 2, 'v3 редактора');
  await call('api/groups/' + g + '/wiki', { method: 'POST', cookie: owner.cookie, data: { member: e.user.id, role: 'editor', add: false } });
  await edit(e, id, 3, 'право снято', 403);
  await call('api/groups/' + g + '/wiki', { method: 'POST', cookie: m.cookie, data: { member: m.user.id, role: 'moderator', add: true }, status: 403 });
  // closed: the page's author and moderators.
  await call('api/groups/' + g + '/wiki', { method: 'POST', cookie: owner.cookie, data: { mode: 'closed' } });
  await edit(e, id, 3, 'не автор', 403);
  await edit(m, id, 3, 'v4 автора');
  await edit(owner, id, 4, 'v5 модератора');
  // A page's own mode wins over the community's: open for this page only.
  await call('api/wiki/' + id + '/settings', { method: 'POST', cookie: m.cookie, data: { mode: 'open' }, status: 403 });
  await call('api/wiki/' + id + '/settings', { method: 'POST', cookie: owner.cookie, data: { mode: 'open' } });
  await edit(e, id, 5, 'v6 открыто');
  // Protected: moderators only, whatever the mode.
  await call('api/wiki/' + id + '/settings', { method: 'POST', cookie: owner.cookie, data: { protected: true } });
  await edit(m, id, 6, 'защищено', 403);
  await edit(owner, id, 6, 'v7');
  const view = await page(m.cookie, id);
  assert.equal(view.page.protected, true);
  assert.equal(view.rights.edit, false);
  assert.deepEqual(view.versions.map(v => v.revision), [7, 6, 5, 4, 3, 2, 1]);
});

test('wiki: suggestions, conflicts, diff, rollback and the log', async () => {
  const owner = await asUser('Модератор предложений'), m = await asUser('Предлагающий'), e = await asUser('Принимающий');
  const g = await community(owner, m, e);
  await call('api/groups/' + g + '/wiki', { method: 'POST', cookie: owner.cookie, data: { mode: 'suggest' } });
  // In "suggest", members don't create pages; editors and moderators do.
  await call('api/wiki', { method: 'POST', cookie: m.cookie, data: { title: 'Нет', body: 'нет', group: g }, status: 403 });
  const { id } = await (await call('api/wiki', { method: 'POST', cookie: owner.cookie, data: { title: 'Статья', body: 'строка 1\nстрока 2', group: g }, status: 201 })).json();
  await call('api/groups/' + g + '/wiki', { method: 'POST', cookie: owner.cookie, data: { member: e.user.id, role: 'editor', add: true } });
  await edit(m, id, 1, 'прямо', 403);
  const s1 = (await (await call('api/wiki/' + id + '/suggest', { method: 'POST', cookie: m.cookie, data: { title: 'Статья', body: 'строка 1\nстрока 2 исправлена', revision: 1 }, status: 201 })).json()).id;
  const s2 = (await (await call('api/wiki/' + id + '/suggest', { method: 'POST', cookie: m.cookie, data: { title: 'Статья', body: 'другое', revision: 1 }, status: 201 })).json()).id;
  // The suggester can't accept; an outsider can't even see it.
  await call('api/wiki/' + id + '/suggestions/' + s1, { method: 'POST', cookie: m.cookie, data: { accept: true }, status: 403 });
  const outsider = await asUser('Чужой');
  await call('api/wiki/' + id + '/suggestions/' + s1, { cookie: outsider.cookie, status: 404 });
  const seen = await (await call('api/wiki/' + id + '/suggestions/' + s1, { cookie: e.cookie })).json();
  assert.deepEqual(seen.diff.filter(d => d.op !== ' ').map(d => d.op + d.line), ['-строка 2', '+строка 2 исправлена']);
  const accepted = await (await call('api/wiki/' + id + '/suggestions/' + s1, { method: 'POST', cookie: e.cookie, data: { accept: true } })).json();
  assert.equal(accepted.revision, 2);
  const after = await page(e.cookie, id);
  assert.equal(after.versions[0].author, m.user.id, 'credited to the one who suggested');
  // The second one was made against revision 1: accepting it would overwrite silently.
  await call('api/wiki/' + id + '/suggestions/' + s2, { method: 'POST', cookie: e.cookie, data: { accept: true }, status: 409 });
  await call('api/wiki/' + id + '/suggestions/' + s2, { method: 'POST', cookie: e.cookie, data: { accept: false } });
  await call('api/wiki/' + id + '/suggestions/' + s2, { method: 'POST', cookie: e.cookie, data: { accept: true }, status: 404 });
  // Diff between versions; rollback = a new revision with the old text.
  const diff = await (await call('api/wiki/' + id + '/diff?from=1&to=2', { cookie: m.cookie })).json();
  assert.equal(diff.diff.length, 3);
  await call('api/wiki/' + id + '/rollback', { method: 'POST', cookie: m.cookie, data: { revision: 1, current: 2 }, status: 403 });
  await call('api/wiki/' + id + '/rollback', { method: 'POST', cookie: e.cookie, data: { revision: 1, current: 1 }, status: 409 });
  const rolled = await (await call('api/wiki/' + id + '/rollback', { method: 'POST', cookie: e.cookie, data: { revision: 1, current: 2 }, status: 201 })).json();
  assert.equal(rolled.revision, 3);
  const last = await page(m.cookie, id);
  assert.equal(last.versions[0].body, 'строка 1\nстрока 2');
  assert.equal(last.versions.length, 3, 'history keeps every revision');
  // The log: who did what, newest first.
  const log = await (await call('api/wiki/' + id + '/log', { cookie: m.cookie })).json();
  assert.deepEqual(log.map(x => x.action), ['rollback', 'reject', 'accept', 'suggest', 'suggest', 'create']);
  await call('api/groups/' + g + '/wiki-log', { cookie: m.cookie, status: 403 });
  assert.ok((await (await call('api/groups/' + g + '/wiki-log', { cookie: owner.cookie })).json()).some(x => x.action === 'group-mode'));
});

test('wiki: a closed community\'s pages stay inside it; old articles keep working', async () => {
  const owner = await asUser('Закрытый владелец'), outsider = await asUser('Снаружи');
  const { id: g } = await (await call('api/groups', { method: 'POST', cookie: owner.cookie, data: { name: 'Тайный круг', closed: true }, status: 201 })).json();
  const { id } = await (await call('api/wiki', { method: 'POST', cookie: owner.cookie, data: { title: 'Внутри', body: 'секрет', group: g }, status: 201 })).json();
  await call('api/wiki/' + id, { cookie: outsider.cookie, status: 404 });
  await call('api/wiki/' + id + '/diff?from=1&to=1', { cookie: outsider.cookie, status: 404 });
  assert.ok(!(await (await call('api/wiki', { cookie: outsider.cookie })).json()).some(x => x.id === id));
  await call('api/wiki', { method: 'POST', cookie: outsider.cookie, data: { title: 'x', body: 'x', group: g }, status: 403 });
  // The sample article from before (no community): still open to everyone signed in.
  const old = await page(outsider.cookie, 'cezeos');
  assert.equal(old.rights.edit, true);
  assert.equal(old.page.group, null);
});

test('bookmarks are private, idempotent, and respect current visibility', async () => {
  const a = await asUser('Автор закладки'), b = await asUser('Другой читатель');
  const created = await call('api/posts', {
    method: 'POST', cookie: a.cookie, status: 201, data: { body: 'Для друзей', visibility: 'friends' }
  });
  const { id } = await created.json();
  const path = 'api/posts/' + id + '/bookmark';
  await call('api/bookmarks', { status: 401 });
  await call(path, { method: 'POST', cookie: b.cookie, status: 404, data: { active: true } });
  await call('api/profiles/' + b.user.id + '/friend', { method: 'POST', cookie: a.cookie, data: { command: 'request' } });
  await call('api/profiles/' + a.user.id + '/friend', { method: 'POST', cookie: b.cookie, data: { command: 'accept' } });
  for (let i = 0; i < 2; i++) {
    await call(path, { method: 'POST', cookie: b.cookie, data: { active: true } });
  }
  const list = async user => (await (await call('api/bookmarks', { cookie: user.cookie })).json());
  assert.deepEqual((await list(b)).map(item => item.id), [id]);
  assert.deepEqual(await list(a), []);
  assert.equal((await (await call('api/posts/' + id, { cookie: a.cookie })).json()).bookmarked, false);
  await call('api/profiles/' + b.user.id + '/friend', { method: 'POST', cookie: a.cookie, data: { command: 'remove' } });
  assert.deepEqual(await list(b), []);
  await call('api/posts/after-rain/bookmark', { method: 'POST', cookie: b.cookie, data: { active: true } });
  await call('api/posts/after-rain/bookmark', { method: 'POST', cookie: b.cookie, data: { active: false } });
  assert.deepEqual(await list(b), []);
});
