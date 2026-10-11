import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

// --- Redis client for rate limiting (works across all function instances) ---
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

// --- Telegram helper ---
async function notifyTelegram(payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

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

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[submit] Telegram notify failed:', err);
  }
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

// --- Rate limit via Upstash ---
async function checkRateLimit(ip) {
  if (!redis) return { limited: false }; // fail-open if Redis isn't configured
  const key = `ratelimit:submit:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // First request in this window — set it to expire in 60s
      await redis.expire(key, 60);
    }
    return { limited: count > 5 };
  } catch (err) {
    console.error('[submit] Rate limit check failed:', err);
    return { limited: false }; // fail-open
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const { limited } = await checkRateLimit(ip);
  if (limited) {
    return json({ error: 'Too many submissions. Please try again in a minute.' }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  // Honeypot check — bots fill hidden fields
  if (body.website && String(body.website).trim() !== '') {
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
    // Check for an existing row with this email (case-insensitive)
    const existing = await sql`
      SELECT id, submission_count
      FROM applications
      WHERE LOWER(email) = LOWER(${emailNorm})
      LIMIT 1
    `;

    let resultId;
    let wasDuplicate = false;

    if (existing.length > 0) {
      // Duplicate — update the existing row, bump the count and timestamp.
      wasDuplicate = true;
      const prevCount = existing[0].submission_count || 1;

      await sql`
        UPDATE applications
        SET
          name = ${name},
          whatsapp = ${whatsapp},
          country = ${country},
          age_range = ${ageRange},
          role = ${role},
          what_building = ${whatBuilding},
          current_challenge = ${currentChallenge},
          final_response = ${finalResponse},
          source = ${source},
          submission_count = ${prevCount + 1},
          last_submitted_at = NOW()
        WHERE id = ${existing[0].id}
      `;

      resultId = existing[0].id;
    } else {
      // New submission
      const inserted = await sql`
        INSERT INTO applications (
          name, email, whatsapp, country, age_range, role,
          what_building, current_challenge, final_response, source,
          submission_count, last_submitted_at
        ) VALUES (
          ${name}, ${emailNorm}, ${whatsapp}, ${country}, ${ageRange}, ${role},
          ${whatBuilding}, ${currentChallenge}, ${finalResponse}, ${source},
          1, NOW()
        )
        RETURNING id
      `;
      resultId = inserted[0].id;
    }

    // Notify on Telegram (only for new submissions, not duplicates — we don't
    // want the founder to get pinged twice for the same person editing their answers)
    if (!wasDuplicate) {
      // Fire-and-forget; don't block the response
      notifyTelegram({
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