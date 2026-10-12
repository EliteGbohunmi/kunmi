import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

// Only these statuses are allowed now (plus null to clear)
const VALID = new Set(['accepted', 'rejected', null]);

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const password = req.headers.get('x-admin-password');
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid body' }, 400); }

  const id = parseInt(body.id, 10);
  const status = body.status === null || body.status === '' ? null : String(body.status);

  if (!Number.isFinite(id)) return json({ error: 'Invalid id' }, 400);
  if (!VALID.has(status)) return json({ error: 'Invalid status' }, 400);

  try {
    await sql`
      UPDATE applications
      SET status = ${status}
      WHERE id = ${id}
    `;
    return json({ success: true, id, status }, 200);
  } catch (err) {
    console.error('[status] DB error:', err);
    return json({ error: 'Could not update status' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}