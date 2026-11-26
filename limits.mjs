// CZ-SEC-003: request limits and upload checks. In memory, per process: a
// restart forgets the counters.

const busy = (seconds) => Object.assign(
  new Error('Слишком много запросов. Попробуйте немного позже.'),
  { status: 429, retryAfter: seconds });

/** A token bucket per key: `burst` requests at once, then `perSecond`.
 *  Throws 429 when the key has none left. */
export function rateLimiter({ burst, perSecond, max = 10000, now = Date.now }) {
  const buckets = new Map();
  return (key) => {
    const time = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= max) {
        // Full buckets carry no information; drop them first, then the oldest.
        for (const [other, b] of buckets) {
          if (b.tokens + (time - b.time) / 1000 * perSecond >= burst) buckets.delete(other);
        }
        if (buckets.size >= max) buckets.delete(buckets.keys().next().value);
      }
      bucket = { tokens: burst, time };
      buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(burst, bucket.tokens + (time - bucket.time) / 1000 * perSecond);
    bucket.time = time;
    if (bucket.tokens < 1) throw busy(Math.ceil((1 - bucket.tokens) / perSecond));
    bucket.tokens -= 1;
  };
}

/** How many large bodies may be held in memory at once. Returns `release`. */
export function uploadSlots({ total, each }) {
  const held = new Map();
  let count = 0;
  return (key) => {
    const mine = held.get(key) || 0;
    if (count >= total || mine >= each) throw busy(5);
    held.set(key, mine + 1);
    count += 1;
    return () => {
      count -= 1;
      const left = held.get(key) - 1;
      if (left) held.set(key, left);
      else held.delete(key);
    };
  };
}

const privatePeer = (address) => address === '::1' ||
  /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || /^f[cd][0-9a-f]{2}:/i.test(address);

/** Who is asking. A reverse proxy on this machine or in its private network
 *  appends the real address to X-Forwarded-For (the last entry is the one it
 *  saw); from anyone else the header is ignored. */
export function clientAddress(peer = '', forwarded) {
  if (privatePeer(peer)) {
    const last = String(forwarded || '').split(',').pop().trim();
    if (last) return last;
  }
  return peer;
}

const ascii = (bytes, at, text) => bytes.length >= at + text.length &&
  bytes.toString('latin1', at, at + text.length) === text;
const starts = (bytes, ...head) => head.every((value, index) => bytes[index] === value);

const signatures = {
  'image/jpeg': (b) => starts(b, 0xff, 0xd8, 0xff),
  'image/png': (b) => starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  'image/webp': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  // An ID3 tag, or straight into an MPEG audio frame.
  'audio/mpeg': (b) => ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/ogg': (b) => ascii(b, 0, 'OggS'),
  'audio/wav': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'),
  'audio/x-wav': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'),
  'video/mp4': (b) => ascii(b, 4, 'ftyp'),
  'video/webm': (b) => starts(b, 0x1a, 0x45, 0xdf, 0xa3),
};

/** The file begins the way its declared type does. */
export function matchesType(mime, bytes) {
  return Object.hasOwn(signatures, mime) && signatures[mime](bytes);
}
