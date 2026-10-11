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

async function checkAuthAttempts(ip) {
  if (!redis) return { blocked: false };
  const key = `ratelimit:admin:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 300); // 5 min window
    return { blocked: count > 20 };
  } catch {
    return { blocked: false };
  }
}

export default async function handler(req) {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const { blocked } = await checkAuthAttempts(ip);
  if (blocked) return json({ error: 'Too many attempts. Try again later.' }, 429);

  const password = req.headers.get('x-admin-password');
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    console.error('[submissions] ADMIN_PASSWORD not set');
    return json({ error: 'Server not configured' }, 500);
  }
  if (!password || password !== expected) {
    return json({ error: 'Wrong password' }, 401);
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10), 1), 100);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
  const statusFilter = url.searchParams.get('status'); // 'accepted' | 'maybe' | 'rejected' | null

  try {
    // Total count (with the same filter applied, so the admin UI can say "X of Y")
    let totalCount;
    if (statusFilter) {
      const r = await sql`SELECT COUNT(*)::int AS n FROM applications WHERE status = ${statusFilter}`;
      totalCount = r[0].n;
    } else {
      const r = await sql`SELECT COUNT(*)::int AS n FROM applications`;
      totalCount = r[0].n;
    }

    // Unseen count (for the "N new" badge)
    const unseenRes = await sql`SELECT COUNT(*)::int AS n FROM applications WHERE seen = false`;
    const unseenCount = unseenRes[0].n;

    // Page of rows
    let rows;
    if (statusFilter) {
      rows = await sql`
        SELECT
          id, name, email, whatsapp, country,
          age_range, role, what_building, current_challenge,
          final_response, submitted_at, seen, status,
          submission_count, last_submitted_at
        FROM applications
        WHERE status = ${statusFilter}
        ORDER BY COALESCE(last_submitted_at, submitted_at) DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT
          id, name, email, whatsapp, country,
          age_range, role, what_building, current_challenge,
          final_response, submitted_at, seen, status,
          submission_count, last_submitted_at
        FROM applications
        ORDER BY COALESCE(last_submitted_at, submitted_at) DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    return json({
      total: totalCount,
      unseenCount,
      limit,
      offset,
      hasMore: offset + rows.length < totalCount,
      applications: rows,
    }, 200);
  } catch (err) {
    console.error('[submissions] DB error:', err);
    return json({ error: 'Could not load applications' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}