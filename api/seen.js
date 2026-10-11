import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const password = req.headers.get('x-admin-password');
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid body' }, 400); }

  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id)) return json({ error: 'Invalid id' }, 400);

  const seen = body.seen === false ? false : true;

  try {
    await sql`
      UPDATE applications
      SET seen = ${seen}
      WHERE id = ${id}
    `;
    return json({ success: true, id, seen }, 200);
  } catch (err) {
    console.error('[seen] DB error:', err);
    return json({ error: 'Could not update' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}