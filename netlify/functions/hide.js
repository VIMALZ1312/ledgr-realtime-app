// Delete (hide) or restore one transaction, for good.
//
// POST /api/hide  { "id": "<plaid transaction_id>", "hide": true | false }
//
// The hidden list lives in Netlify Blobs and is applied to the raw bank data
// before anything is totalled (see applyHidden in _core.js), so a deleted
// transaction drops out of every tab and never comes back on a later sync.
// data.json is rebuilt right away from the last cached bank download — no bank
// calls — so the app shows the change within a few seconds.
const { connectBlobs, setHidden } = require('./_core');

exports.handler = async (event) => {
  connectBlobs(event);
  const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  try {
    const { id, hide } = JSON.parse(event.body || '{}');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(id)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid transaction id is required.' }) };
    }
    const count = await setHidden(id, hide !== false);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, hidden_count: count }) };
  } catch (err) {
    console.error('hide failed:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
