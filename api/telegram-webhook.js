import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

// Persistent keyboard shown at the bottom of the chat
const MAIN_KEYBOARD = {
  keyboard: [
    [
      { text: 'Stats' },
      { text: 'Today' },
      { text: 'Week' },
      { text: 'Help' },
    ],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

async function sendMessage(token, chatId, text, replyToMessageId) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: MAIN_KEYBOARD,
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
    WHERE COALESCE(last_submitted_at, submitted_at) >= CURRENT_DATE
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
  const lines = [];
  lines.push('*Application snapshot*');
  lines.push('');
  lines.push(`Total · ${s.total}`);
  lines.push(`Today · ${todayN}`);
  lines.push(`This week · ${weekN}`);
  lines.push('');
  lines.push('*By status*');
  lines.push(`Inbox ${s.inbox} · Accepted ${s.accepted} · Rejected ${s.rejected}`);
  lines.push('');

  if (s.unseen > 0) {
    lines.push(`${s.unseen} unseen — open the admin page to review.`);
  } else {
    lines.push('All seen. Nothing waiting.');
  }

  return lines.join('\n');
}

function formatToday(n) {
  if (n === 0) {
    return [
      '*Today · nothing yet.*',
      '',
      "I'll let you know the moment one comes in.",
    ].join('\n');
  }
  const word = n === 1 ? 'new application' : 'new applications';
  return [
    `*Today · ${n} ${word}.*`,
    '',
    'Take a look when you have a moment.',
  ].join('\n');
}

function formatWeek(n) {
  if (n === 0) {
    return [
      '*Last 7 days · nothing.*',
      '',
      'Quiet week. Hope you enjoyed it.',
    ].join('\n');
  }
  const word = n === 1 ? 'application' : 'applications';
  return [
    `*Last 7 days · ${n} ${word}.*`,
    '',
    'Good pace. Keep an eye on the Inbox.',
  ].join('\n');
}

function helpText() {
  return [
    '*Commands*',
    '',
    'Tap the buttons below, or type any of these:',
    '',
    '/stats — full snapshot',
    "/today — today's count",
    '/week — last 7 days',
    '/help — this list',
  ].join('\n');
}

function startText() {
  return [
    '*Welcome to the Start With Kunmi bot.*',
    '',
    "I'll ping you when someone applies. Use the buttons below for stats.",
  ].join('\n');
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

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

  const allowed = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
    .split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(String(chatId))) {
    console.log('[webhook] ignored message from', chatId);
    return new Response('OK', { status: 200 });
  }

  // Normalize: strip /command@botname suffixes, lowercase, and treat
  // button labels ("Stats", "Today", etc.) the same as commands.
  const raw = (text.split(/\s+/)[0] || '');
  const base = raw.split('@')[0].toLowerCase();
  const lower = text.toLowerCase();

  let command = base;
  if (command === 'stats' || lower === 'stats') command = '/stats';
  else if (command === 'today' || lower === 'today') command = '/today';
  else if (command === 'week' || lower === 'week') command = '/week';
  else if (command === 'help' || lower === 'help') command = '/help';
  else if (command === 'start' || lower === 'start') command = '/start';

  try {
    if (command === '/start') {
      await sendMessage(botToken, chatId, startText(), messageId);
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
      await sendMessage(botToken, chatId, formatToday(n), messageId);
      return new Response('OK', { status: 200 });
    }

    if (command === '/week') {
      const n = await getWeekCount();
      await sendMessage(botToken, chatId, formatWeek(n), messageId);
      return new Response('OK', { status: 200 });
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('[webhook] error:', err);
    await sendMessage(botToken, chatId, 'Something went wrong. Try again in a moment.', messageId);
    return new Response('OK', { status: 200 });
  }
}