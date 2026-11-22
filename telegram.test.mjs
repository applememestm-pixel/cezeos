import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { telegramLogin, telegramSettings } from './telegram.mjs';

test('Telegram sign-in binds a one-time authorization code to its browser and validates the signed identity', async t => {
  const config = telegramSettings({
    CEZEOS_TELEGRAM_CLIENT_ID: '12345',
    CEZEOS_TELEGRAM_CLIENT_SECRET: 'test-only',
    CEZEOS_PUBLIC_ORIGIN: 'https://cezeos.example'
  });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'RS256' };
  const seen = [];
  const handle = telegramLogin(config, account => {
    seen.push(account);
    return 'cezeos=test-session; Secure';
  });
  let exchange = new URL('/auth', 'https://oauth.telegram.org');
  let validNonce = true;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [key] });
    assert.equal(url, 'https://oauth.telegram.org/token');
    assert.equal(options.body.get('code'), 'valid-code');
    assert.equal(options.body.get('redirect_uri'), config.redirectUri);
    const challenge = createHash('sha256').update(options.body.get('code_verifier')).digest('base64url');
    assert.equal(challenge, exchange.searchParams.get('code_challenge'));
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: 'https://oauth.telegram.org', aud: config.clientId, sub: 'stable-subject',
      nonce: validNonce ? exchange.searchParams.get('nonce') : 'other', iat: now, exp: now + 90, name: 'Автор' };
    const unsigned = encode({ alg: 'RS256', kid: key.kid }) + '.' + encode(claims);
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
    return Response.json({ id_token: unsigned + '.' + signature });
  });

  async function request(path, cookie) {
    let result;
    const req = { headers: { host: config.host, cookie } };
    const res = { writeHead(status, headers) { result = { status, ...headers }; }, end() {} };
    await handle(req, res, new URL(path, config.origin));
    assert.equal(result.status, 303);
    assert.equal(result['Cache-Control'], 'no-store');
    return result;
  }

  async function start() {
    const data = await request('/api/auth/telegram/start');
    exchange = new URL(data.Location);
    assert.equal(exchange.origin, 'https://oauth.telegram.org');
    assert.equal(exchange.searchParams.get('code_challenge_method'), 'S256');
    assert.match(data['Set-Cookie'][0], /SameSite=Lax/);
    assert.match(data['Set-Cookie'][0], /Secure/);
    return {
      cookie: data['Set-Cookie'][0].split(';')[0],
      path: '/api/auth/telegram/callback?code=valid-code&state=' + exchange.searchParams.get('state')
    };
  }

  const first = await start();
  assert.equal((await request(first.path, 'cezeos_telegram=' + 'a'.repeat(43))).Location, '/?auth=failed#login');
  assert.equal(fetch.mock.callCount(), 0);
  const success = await request(first.path, first.cookie);
  assert.equal(success.Location, '/#feed');
  assert.equal(success['Set-Cookie'][1], 'cezeos=test-session; Secure');
  assert.deepEqual(seen, [{ subject:'stable-subject', name:'Автор' }]);
  assert.equal((await request(first.path, first.cookie)).Location, '/?auth=failed#login');
  assert.equal(fetch.mock.callCount(), 2);

  validNonce = false;
  const next = await start();
  assert.equal((await request(next.path, next.cookie)).Location, '/?auth=failed#login');
  assert.equal(seen.length, 1);
});
