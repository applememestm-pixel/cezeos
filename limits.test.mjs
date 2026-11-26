// CZ-SEC-003: limits.mjs on its own and through a running server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimiter, uploadSlots, clientAddress, matchesType } from './limits.mjs';

const root = dirname(fileURLToPath(import.meta.url));

test('a bucket allows a burst, refills, and keeps keys apart', () => {
  let time = 0;
  const take = rateLimiter({ burst: 3, perSecond: 1, now: () => time });
  take('a'); take('a'); take('a');
  assert.throws(() => take('a'), (error) => error.status === 429 && error.retryAfter === 1);
  take('b');
  time = 1000;
  take('a');
  assert.throws(() => take('a'));
});

test('a full table drops idle keys first', () => {
  let time = 0;
  const take = rateLimiter({ burst: 1, perSecond: 1, max: 2, now: () => time });
  take('old');
  time = 5000;
  take('busy');
  take('new');
  assert.throws(() => take('busy'), 'the busy key is still counted');
});

test('upload slots are limited in total and per person', () => {
  const enter = uploadSlots({ total: 2, each: 1 });
  const first = enter('a');
  assert.throws(() => enter('a'), (error) => error.status === 429);
  enter('b');
  assert.throws(() => enter('c'));
  first();
  enter('c');
});

test('X-Forwarded-For counts only from a private peer, and only its last entry', () => {
  assert.equal(clientAddress('203.0.113.7', '1.2.3.4'), '203.0.113.7');
  assert.equal(clientAddress('127.0.0.1', '1.2.3.4, 198.51.100.2'), '198.51.100.2');
  assert.equal(clientAddress('::ffff:172.18.0.3', '198.51.100.2'), '198.51.100.2');
  assert.equal(clientAddress('127.0.0.1', undefined), '127.0.0.1');
});

test('a file must begin like its declared type', () => {
  assert.ok(matchesType('audio/mpeg', Buffer.from('ID3\u0004')));
  assert.ok(matchesType('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.ok(matchesType('video/mp4', Buffer.from('\0\0\0\u0018ftypisom', 'latin1')));
  assert.ok(!matchesType('image/png', Buffer.from('<html><script>')));
  assert.ok(!matchesType('image/webp', Buffer.from('RIFF0000WAVE')));
  assert.ok(!matchesType('text/html', Buffer.from('<html>')));
});

test('the server refuses a disguised file and a flood of writes', async () => {
  const directory = await mkdtemp(resolve(root, 'data-test-'));
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, CEZEOS_DATA_DIR: directory, CEZEOS_PORT: '0', CEZEOS_ALLOW_DEMO: '1' }
  });
  try {
    const [chunk] = await once(server.stdout, 'data');
    const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)[0];
    const send = (path, data, headers = {}) => fetch(url + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data)
    });
    const login = await send('api/session/demo', { name: 'Проверка' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const fake = await send('api/posts', {
      title: 'не картинка', media: { mime: 'image/png', data: Buffer.from('<script>').toString('base64') }
    }, { Cookie: cookie });
    assert.equal(fake.status, 400);

    let limited;
    for (let i = 0; i < 80 && !limited; i++) {
      const response = await send('api/posts', { body: 'запись ' + i }, { Cookie: cookie });
      if (response.status === 429) limited = response;
      else assert.equal(response.status, 201);
      await response.arrayBuffer();
    }
    assert.ok(limited, 'the 80th write in a row is not accepted');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    // Reading is not limited.
    assert.equal((await fetch(url + 'api/posts')).status, 200);
  } finally {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
