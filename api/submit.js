import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

// Simple in-memory rate limit (per warm function instance)
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 5;
  const record = hits.get(ip) || { count: 0, start: now };
  if (now - record.start > windowMs) {
    record.count = 0;
    record.start = now;
  }
  record.count++;
  hits.set(ip, record);
  return record.count > max;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (rateLimited(ip)) {
    return json({ error: 'Too many submissions. Please try again in a minute.' }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  // Honeypot check — bots fill hidden fields
  if (body.website && body.website.trim() !== '') {
    return json({ success: true, id: null }); // silently ignore bots
  }

  // Validate required fields
  const required = ['name', 'email', 'whatsapp', 'country', 'whatBuilding', 'finalResponse'];
  for (const key of required) {
    if (!body[key] || String(body[key]).trim() === '') {
      return json({ error: `Missing required field: ${key}` }, 400);
    }
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return json({ error: 'Invalid email address' }, 400);
  }

  try {
    const result = await sql`
      INSERT INTO applications (
        name, email, whatsapp, country, age_range, role,
        what_building, current_challenge, final_response, source
      ) VALUES (
        ${String(body.name).trim()},
        ${String(body.email).trim()},
        ${String(body.whatsapp).trim()},
        ${String(body.country).trim()},
        ${body.ageRange || null},
        ${body.role || null},
        ${String(body.whatBuilding).trim()},
        ${body.currentChallenge || null},
        ${String(body.finalResponse).trim()},
        ${body.source || 'website'}
      )
      RETURNING id
    `;

    return json({ success: true, id: result[0].id }, 200);
  } catch (err) {
    console.error('[submit] DB error:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  });
}