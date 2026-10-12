import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

async function sendMessage(token, chatId, text, replyToMessageId) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const resBody = await res.text();
    console.log('[webhook] sent to', chatId, res.status, resBody.slice(0, 150));
  } catch (err) {
    console.error('[webhook] send failed:', err);
  }
}

async function getStats() {
  const rows = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE seen = false)::int AS unseen,
      COUNT(*) FILTER (WHERE status IS NULL)::int AS inbox,
      COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
      COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
    FROM applications
  `;
  return rows[0];
}

async function getTodayCount() {
  const rows = await sql`
    SELECT COUNT(*)::int AS n
    FROM applications
    WHERE (last_submitted_at >= CURRENT_DATE OR submitted_at >= CURRENT_DATE)
  `;
  return rows[0].n;
}

async function getWeekCount() {
  const rows = await sql`
    SELECT COUNT(*)::int AS n
    FROM applications
    WHERE COALESCE(last_submitted_at, submitted_at) >= NOW() - INTERVAL '7 days'
  `;
  return rows[0].n;
}

function formatStats(s, todayN, weekN) {
  return [
    '*📊 Start With Kunmi — Stats*',
    '',
    `*Total applications:* ${s.total}`,
    `*Today:* ${todayN}`,
    `*This week:* ${weekN}`,
    '',
    '*By status:*',
    `• Inbox (unreviewed): ${s.inbox}`,
    `• Accepted: ${s.accepted}`,
    `• Rejected: ${s.rejected}`,
    '',
    `*Unseen:* ${s.unseen}`,
  ].join('\n');
}

function helpText() {
  return [
    '*📋 Available commands*',
    '',
    '/stats — full snapshot of applications',
    '/today — how many applied today',
    '/week — how many applied in the last 7 days',
    '/help — this message',
    '',
    '_More commands coming soon._',
  ].join('\n');
}

export default async function handler(req) {
  // Telegram only sends POSTs to this endpoint
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Verify the secret header that Telegram sends on every call
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || secret !== expected) {
    console.warn('[webhook] unauthorized request');
    return new Response('Unauthorized', { status: 401 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('[webhook] TELEGRAM_BOT_TOKEN not set');
    return new Response('Server not configured', { status: 500 });
  }

  let update;
  try { update = await req.json(); } catch {
    return new Response('Bad request', { status: 400 });
  }

  const message = update.message || update.edited_message;
  if (!message || !message.text) {
    return new Response('OK', { status: 200 });
  }

  const chatId = message.chat.id;
  const text = message.text.trim();
  const messageId = message.message_id;

  // Only allow registered recipients (safety measure — a stranger could
  // theoretically reach the bot if BotFather restriction isn't enforced)
  const allowed = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
    .split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(String(chatId))) {
    console.log('[webhook] ignored message from', chatId);
    return new Response('OK', { status: 200 });
  }

  // Match the command (ignore any /command@botname suffix)
  const command = (text.split(/\s+/)[0] || '').split('@')[0].toLowerCase();

  try {
    if (command === '/start') {
      await sendMessage(botToken, chatId,
        '*Welcome to the Start With Kunmi bot.*\n\nUse /help to see what I can do.',
        messageId);
      return new Response('OK', { status: 200 });
    }

    if (command === '/help') {
      await sendMessage(botToken, chatId, helpText(), messageId);
      return new Response('OK', { status: 200 });
    }

    if (command === '/stats') {
      const [s, todayN, weekN] = await Promise.all([getStats(), getTodayCount(), getWeekCount()]);
      await sendMessage(botToken, chatId, formatStats(s, todayN, weekN), messageId);
      return new Response('OK', { status: 200 });
    }

    if (command === '/today') {
      const n = await getTodayCount();
      await sendMessage(botToken, chatId,
        `*Today:* ${n} application${n === 1 ? '' : 's'} received.`,
        messageId);
      return new Response('OK', { status: 200 });
    }

    if (command === '/week') {
      const n = await getWeekCount();
      await sendMessage(botToken, chatId,
        `*This week:* ${n} application${n === 1 ? '' : 's'} received in the last 7 days.`,
        messageId);
      return new Response('OK', { status: 200 });
    }

    // Unknown command — ignore silently. Nothing worse than an error reply.
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('[webhook] error:', err);
    await sendMessage(botToken, chatId, 'Something went wrong. Try again in a moment.', messageId);
    return new Response('OK', { status: 200 });
  }
}