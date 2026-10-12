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

// Reads TELEGRAM_CHAT_IDS (comma-separated). Falls back to TELEGRAM_CHAT_ID (single) if needed.
function getRecipientIds() {
  const multi = process.env.TELEGRAM_CHAT_IDS;
  if (multi && multi.trim() !== '') {
    return multi.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  }
  const single = process.env.TELEGRAM_CHAT_ID;
  if (single && single.trim() !== '') return [single.trim()];
  return [];
}

async function notifyTelegram(payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const recipients = getRecipientIds();

  if (!token || recipients.length === 0) {
    console.log('[TG SKIP] missing token or recipients');
    return;
  }

  const lines = [
    '🎉 *New application — Start With Kunmi*',
    '',
    `*Name:* ${escapeMd(payload.name)}`,
    `*Country:* ${escapeMd(payload.country || '—')}`,
    `*Age:* ${escapeMd(payload.ageRange || '—')}`,
    `*Role:* ${escapeMd(payload.role || '—')}`,
    '',
    `*Working on:* ${truncate(payload.whatBuilding, 200)}`,
    `*Stuck on:* ${escapeMd(payload.currentChallenge || '—')}`,
    '',
    `_Open the admin page to review._`
  ];

  const text = lines.join('\n');

  // Send to every recipient, in parallel. Each can fail independently.
  await Promise.all(recipients.map(async function(chatId){
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });
      const body = await res.text();
      console.log('[TG RESULT]', chatId, res.status, body.slice(0, 200));
    } catch (err) {
      console.error('[TG FAIL]', chatId, err);
    }
  }));
}

function escapeMd(s) {
  if (!s) return '';
  return String(s).replace(/([_*`\[\]])/g, '\\$1');
}

function truncate(s, n) {
  if (!s) return '';
  const clean = escapeMd(s);
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

async function checkRateLimit(ip) {
  if (!redis) return { limited: false };
  const key = `ratelimit:submit:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    return { limited: count > 5 };
  } catch {
    return { limited: false };
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const { limited } = await checkRateLimit(ip);
  if (limited) return json({ error: 'Too many submissions. Please try again in a minute.' }, 429);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request body' }, 400); }

  if (body.website && String(body.website).trim() !== '') {
    return json({ success: true, id: null });
  }

  const required = ['name', 'email', 'whatsapp', 'country', 'whatBuilding', 'finalResponse'];
  for (const key of required) {
    if (!body[key] || String(body[key]).trim() === '') {
      return json({ error: `Missing required field: ${key}` }, 400);
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return json({ error: 'Invalid email address' }, 400);
  }

  const emailNorm = String(body.email).trim();
  const name = String(body.name).trim();
  const whatsapp = String(body.whatsapp).trim();
  const country = String(body.country).trim();
  const ageRange = body.ageRange || null;
  const role = body.role || null;
  const whatBuilding = String(body.whatBuilding).trim();
  const currentChallenge = body.currentChallenge || null;
  const finalResponse = String(body.finalResponse).trim();
  const source = body.source || 'website';

  try {
    const existing = await sql`
      SELECT id, submission_count FROM applications
      WHERE LOWER(email) = LOWER(${emailNorm})
      LIMIT 1
    `;

    let resultId;
    let wasDuplicate = false;

    if (existing.length > 0) {
      wasDuplicate = true;
      const prevCount = existing[0].submission_count || 1;
      await sql`
        UPDATE applications SET
          name = ${name}, whatsapp = ${whatsapp}, country = ${country},
          age_range = ${ageRange}, role = ${role},
          what_building = ${whatBuilding}, current_challenge = ${currentChallenge},
          final_response = ${finalResponse}, source = ${source},
          submission_count = ${prevCount + 1}, last_submitted_at = NOW()
        WHERE id = ${existing[0].id}
      `;
      resultId = existing[0].id;
    } else {
      const inserted = await sql`
        INSERT INTO applications (
          name, email, whatsapp, country, age_range, role,
          what_building, current_challenge, final_response, source,
          submission_count, last_submitted_at
        ) VALUES (
          ${name}, ${emailNorm}, ${whatsapp}, ${country}, ${ageRange}, ${role},
          ${whatBuilding}, ${currentChallenge}, ${finalResponse}, ${source},
          1, NOW()
        ) RETURNING id
      `;
      resultId = inserted[0].id;
    }

    if (!wasDuplicate) {
      await notifyTelegram({
        name, country, ageRange, role, whatBuilding, currentChallenge
      });
    }

    return json({ success: true, id: resultId, duplicate: wasDuplicate }, 200);
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