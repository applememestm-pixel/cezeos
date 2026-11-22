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
    cwd: root, env: { ...process.env, CEZEOS_DATA_DIR: directory, CEZEOS_PORT: '0' }
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
  assert.deepEqual(history.map(version => version.revision), [2, 1]);
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
