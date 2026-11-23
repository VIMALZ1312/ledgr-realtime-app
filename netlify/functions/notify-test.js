// Send one test push to the phone, to confirm the ntfy subscription works.
// POST /api/notify-test
const { ntfy } = require('./_core');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  if (!process.env.NTFY_TOPIC) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Alerts are not set up yet (NTFY_TOPIC is missing).' }) };
  try {
    await ntfy('Ledgr alerts are on', 'You will get a push when a fee or interest is charged, and before each card payment is due.', { tags: 'white_check_mark', click: process.env.URL });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
