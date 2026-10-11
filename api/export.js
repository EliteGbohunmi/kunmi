import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const expected = process.env.ADMIN_PASSWORD;

  if (!code || code !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const rows = await sql`
      SELECT
        id, name, email, whatsapp, country,
        age_range, role, what_building, current_challenge,
        final_response, submitted_at, seen, status,
        submission_count
      FROM applications
      ORDER BY COALESCE(submitted_at) DESC, id DESC
    `;

    const headers = [
      'id','name','email','whatsapp','country','age_range','role',
      'what_building','current_challenge','final_response',
      'submitted_at','seen','status','submission_count'
    ];

    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => csvCell(r[h])).join(','))
    ].join('\n');

    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="swk-applications-${new Date().toISOString().slice(0,10)}.csv"`,
      },
    });
  } catch (err) {
    console.error('[export] DB error:', err);
    return new Response('Server error', { status: 500 });
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}