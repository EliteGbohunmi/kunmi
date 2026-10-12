import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

// Loose rate limit so people can't hammer this to find who applied
async function checkRateLimit(ip) {
  if (!redis) return { limited: false };
  const key = `ratelimit:checkemail:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    return { limited: count > 10 };
  } catch {
    return { limited: false };
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const { limited } = await checkRateLimit(ip);
  if (limited) return json({ error: 'Too many requests' }, 429);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid body' }, 400); }

  const email = String(body.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ exists: false });
  }

  try {
    const rows = await sql`
      SELECT 1 FROM applications
      WHERE LOWER(email) = LOWER(${email})
      LIMIT 1
    `;
    return json({ exists: rows.length > 0 }, 200);
  } catch (err) {
    console.error('[check-email] DB error:', err);
    // Fail open — return false so we don't block submission if the DB hiccups
    return json({ exists: false }, 200);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}