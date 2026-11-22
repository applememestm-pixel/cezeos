import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

const issuer = 'https://oauth.telegram.org';
const timeout = 5000;
const transactionAge = 300;
const base64url = /^[A-Za-z0-9_-]+$/;

function secret() {
  return randomBytes(32).toString('base64url');
}

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function equalSecret(left, right) {
  return typeof left === 'string' && left.length === right.length &&
    Buffer.byteLength(left) === Buffer.byteLength(right) &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function parsePart(part) {
  if (!base64url.test(part)) throw new Error('Invalid Telegram token encoding');
  const object = JSON.parse(Buffer.from(part, 'base64url'));
  if (!object || Array.isArray(object) || typeof object !== 'object') throw new Error('Invalid Telegram token data');
  return object;
}

export function telegramSettings(env) {
  const { CEZEOS_TELEGRAM_CLIENT_ID: clientId, CEZEOS_TELEGRAM_CLIENT_SECRET: clientSecret,
    CEZEOS_PUBLIC_ORIGIN: url } = env;
  if (!clientId || !clientSecret || !url) return null;
  const publicUrl = new URL(url);
  const loopback = ['127.0.0.1','localhost'].includes(publicUrl.hostname);
  if (!/^\d+$/.test(clientId) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' ||
      publicUrl.search || publicUrl.hash || !(publicUrl.protocol === 'https:' || loopback && publicUrl.protocol === 'http:')) {
    throw new Error('Проверьте PUBLIC_ORIGIN и Client ID для Telegram.');
  }
  return {
    clientId, clientSecret, origin: publicUrl.origin, host: publicUrl.host,
    redirectUri: publicUrl.origin + '/api/auth/telegram/callback', secure: publicUrl.protocol === 'https:'
  };
}

export function validateTelegramToken(token, keys, config, attempt, now) {
  if (typeof token !== 'string' || token.length > 16384) throw new Error('Invalid Telegram ID token');
  const parts = token.split('.');
  if (parts.length !== 3 || !base64url.test(parts[2])) throw new Error('Malformed Telegram ID token');
  const header = parsePart(parts[0]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined || header.b64 !== undefined) {
    throw new Error('Unexpected Telegram signing algorithm');
  }
  const jwk = keys.find(key => key?.kid === header.kid && key.kty === 'RSA' &&
    (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (!jwk || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
    createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) {
    throw new Error('Invalid Telegram signature');
  }
  const claims = parsePart(parts[1]);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || audience.length !== 1 ||
      String(audience[0]) !== config.clientId || (claims.azp !== undefined && String(claims.azp) !== config.clientId) ||
      !Number.isInteger(claims.iat) || claims.iat > now + 60 || claims.iat < attempt.created - 60 ||
      !Number.isInteger(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now + 60)) ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
      !equalSecret(claims.nonce, attempt.nonce)) {
    throw new Error('Invalid Telegram identity claims');
  }
  const name = typeof claims.name === 'string' ? [...claims.name.trim()].slice(0, 45).join('') : '';
  return { subject: claims.sub, name: name || 'Участник CeZeOs' };
}

async function telegramJson(path, init) {
  const response = await fetch(issuer + path, { ...init, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (!response.ok) throw new Error('Telegram login service returned ' + response.status);
  return response.json();
}

function redirect(res, location, cookies = []) {
  res.writeHead(303, {
    Location: location, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {})
  });
  res.end();
}

export function telegramLogin(config, authenticate) {
  const attempts = new Map();
  const callbackPath = '/api/auth/telegram/callback';
  const callbackCookie = (value, age) => 'cezeos_telegram=' + value + '; Path=' + callbackPath +
    '; HttpOnly; SameSite=Lax; Max-Age=' + age + (config.secure ? '; Secure' : '');
  return async (req,res,url) => {
    const available = config && req.headers.host === config.host;
    if (!available) return redirect(res, '/?auth=failed#login');
    const now = Math.floor(Date.now()/1000);
    if (url.pathname === '/api/auth/telegram/start') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return redirect(res, '/?auth=failed#login');
      for (const [id,attempt] of attempts) if (attempt.created + transactionAge <= now) attempts.delete(id);
      if (attempts.size >= 1000) return redirect(res, '/?auth=failed#login');
      const state = secret();
      const cookie = secret();
      const attempt = { browser: sha256(cookie).toString('hex'), codeVerifier: secret(), nonce: secret(), created: now };
      attempts.set(state, attempt);
      const query = new URLSearchParams({
        redirect_uri: config.redirectUri, client_id: config.clientId, response_type: 'code',
        scope: 'openid profile', state, nonce: attempt.nonce, code_challenge_method: 'S256',
        code_challenge: sha256(attempt.codeVerifier).toString('base64url')
      });
      return redirect(res, issuer + '/auth?' + query, [callbackCookie(cookie, transactionAge)]);
    }
    const state = url.searchParams.get('state');
    const attempt = attempts.get(state);
    const browser = req.headers.cookie?.match(/(?:^|;\s*)cezeos_telegram=([-\w]{43})(?:;|$)/)?.[1];
    if (!attempt || attempt.created + transactionAge <= now || !browser ||
        !equalSecret(sha256(browser).toString('hex'), attempt.browser)) {
      return redirect(res, '/?auth=failed#login');
    }

    attempts.delete(state);
    const expiredCookie = callbackCookie('',0);
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') === 'access_denied') return redirect(res, '/?auth=cancelled#login', [expiredCookie]);
    if (!code || code.length > 2048) return redirect(res, '/?auth=failed#login', [expiredCookie]);

    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: config.clientId,
        redirect_uri: config.redirectUri, code_verifier: attempt.codeVerifier
      });
      const authorization = Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64');
      const [token, jwks] = await Promise.all([
        telegramJson('/token', { method:'POST', body, headers:{ Authorization: 'Basic ' + authorization } }),
        telegramJson('/.well-known/jwks.json')
      ]);
      const profile = validateTelegramToken(token.id_token, jwks.keys, config, attempt, Math.floor(Date.now()/1000));
      const session = authenticate(profile);
      return redirect(res, '/#feed', [expiredCookie, session]);
    } catch {
      return redirect(res, '/?auth=failed#login', [expiredCookie]);
    }
  };
}
