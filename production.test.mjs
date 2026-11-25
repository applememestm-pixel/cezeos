// CZ-SEC-001: a server started without CEZEOS_ALLOW_DEMO=1 (production) has
// no demo sign-in — not even with a spoofed `Host: localhost` — and no sample
// people, groups or posts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

async function start(env) {
  const directory = await mkdtemp(resolve(root, 'data-test-'));
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, CEZEOS_ALLOW_DEMO: '', CEZEOS_SAMPLE_DATA: '', ...env, CEZEOS_DATA_DIR: directory, CEZEOS_PORT: '0' }
  });
  const failed = once(server, 'exit').then(([code]) => { throw new Error('Server exited before ready: ' + code); });
  const received = once(server.stdout, 'data').then(([chunk]) => String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]);
  const url = await Promise.race([received, failed]);
  assert.ok(url);
  return { url, async stop() { const exited = once(server, 'exit'); server.kill(); await exited; await rm(directory, { recursive: true, force: true }); } };
}

test('production: no demo sign-in and no sample data', async () => {
  const s = await start({});
  try {
    const session = await (await fetch(s.url + 'api/session')).json();
    assert.equal(session.providers.demo, false);
    for (const host of [undefined, 'localhost', '127.0.0.1']) {
      const r = await fetch(s.url + 'api/session/demo', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(host ? { Host: host } : {}) }, body: JSON.stringify({ name: 'Intruder' })
      });
      assert.equal(r.status, 404, 'demo sign-in refused with Host ' + host);
      assert.equal(r.headers.get('set-cookie'), null);
    }
    const feed = await (await fetch(s.url + 'api/posts')).json();
    assert.equal(feed.length, 0, 'no sample posts in a new database');
  } finally { await s.stop(); }
});

test('demo stays available when explicitly allowed, from this machine', async () => {
  const s = await start({ CEZEOS_ALLOW_DEMO: '1' });
  try {
    const r = await fetch(s.url + 'api/session/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Local' })
    });
    assert.equal(r.status, 201);
  } finally { await s.stop(); }
});

test('a spoofed Host: localhost from another address gets no demo session', async (t) => {
  const { networkInterfaces } = await import('node:os');
  const { request } = await import('node:http');
  const external = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!external) return t.skip('no non-loopback IPv4 address on this machine');
  const s = await start({ CEZEOS_ALLOW_DEMO: '1', CEZEOS_BIND: '0.0.0.0' });
  try {
    const port = new URL(s.url).port;
    const status = await new Promise((done, fail) => {
      const body = JSON.stringify({ name: 'Intruder' });
      const req = request({ host: external, port, path: '/api/session/demo', method: 'POST',
        headers: { Host: 'localhost:' + port, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        res => { res.resume(); done(res.statusCode); });
      req.on('error', fail);
      req.end(body);
    });
    assert.equal(status, 404, 'demo sign-in must need a real loopback peer');
  } finally { await s.stop(); }
});
