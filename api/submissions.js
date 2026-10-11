import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

// Simple in-memory rate limit for wrong-password attempts
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000; // 5 minutes
  const max = 10;
  const record = attempts.get(ip) || { count: 0, start: now };
  if (now - record.start > windowMs) {
    record.count = 0;
    record.start = now;
  }
  record.count++;
  attempts.set(ip, record);
  return record.count > max;
}

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (tooManyAttempts(ip)) {
    return json({ error: 'Too many attempts. Try again later.' }, 429);
  }

  // Password comes in a custom header, never in the URL
  const password = req.headers.get('x-admin-password');
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    console.error('[submissions] ADMIN_PASSWORD not set');
    return json({ error: 'Server not configured' }, 500);
  }

  if (!password || password !== expected) {
    return json({ error: 'Wrong password' }, 401);
  }

  try {
    const rows = await sql`
      SELECT
        id, name, email, whatsapp, country,
        age_range, role, what_building, current_challenge,
        final_response, submitted_at
      FROM applications
      ORDER BY submitted_at DESC
    `;

    return json({ count: rows.length, applications: rows }, 200);
  } catch (err) {
    console.error('[submissions] DB error:', err);
    return json({ error: 'Could not load applications' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}