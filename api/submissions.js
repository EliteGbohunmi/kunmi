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
    if (count === 1) await redis.expire(key, 300);
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
  const view = url.searchParams.get('view'); // 'inbox' | 'accepted' | 'rejected' | 'table' | null
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10), 1), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  try {
    // Counts for the three tabs, always returned
    const countsRes = await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE seen = false)::int AS unseen,
        COUNT(*) FILTER (WHERE status IS NULL)::int AS unreviewed,
        COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
      FROM applications
    `;

    const c = countsRes[0];
    const counts = {
      inbox: c.unreviewed || 0,
      accepted: c.accepted || 0,
      rejected: c.rejected || 0,
      unseen: c.unseen || 0,
      total: c.total || 0,
    };

    let rows;
    let totalForView;

    if (view === 'table') {
      rows = await sql`
        SELECT
          id, name, email, whatsapp, country,
          age_range, role, what_building, current_challenge,
          final_response, submitted_at, seen, status,
          submission_count, last_submitted_at
        FROM applications
        ORDER BY COALESCE(last_submitted_at, submitted_at) DESC, id DESC
      `;
      totalForView = rows.length;
    } else if (view === 'inbox') {
      totalForView = counts.inbox;
      rows = await sql`
        SELECT
          id, name, email, whatsapp, country,
          age_range, role, what_building, current_challenge,
          final_response, submitted_at, seen, status,
          submission_count, last_submitted_at
        FROM applications
        WHERE status IS NULL
        ORDER BY COALESCE(last_submitted_at, submitted_at) DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (view === 'accepted' || view === 'rejected') {
      totalForView = counts[view];
      rows = await sql`
        SELECT
          id, name, email, whatsapp, country,
          age_range, role, what_building, current_challenge,
          final_response, submitted_at, seen, status,
          submission_count, last_submitted_at
        FROM applications
        WHERE status = ${view}
        ORDER BY COALESCE(last_submitted_at, submitted_at) DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      totalForView = counts.total;
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
      total: totalForView,
      counts,
      limit,
      offset,
      hasMore: offset + rows.length < totalForView,
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