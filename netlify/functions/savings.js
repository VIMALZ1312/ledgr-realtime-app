// Shared private savings store (the "My Net Worth" tab).
// Single shared record in Netlify Blobs: { hash, entries:[{id,desc,amount}] }.
// Anyone with the shared password (e.g. spouse, any device) can read/edit.
// `total` action needs no password (the sum feeds the public Net Worth KPI);
// everything else requires the password to match the stored hash.
const crypto = require('crypto');
const { savingsStore } = require('./_core');

const KEY = 'store';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sum = (d) => (d.entries || []).reduce((a, x) => a + (Number(x.amount) || 0), 0);
const newId = () => Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const J = (obj) => ({ statusCode: 200, headers, body: JSON.stringify(obj) });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const { action } = body;

  let store, data;
  try {
    store = savingsStore();
    const raw = await store.get(KEY);
    data = raw ? JSON.parse(raw) : { hash: null, entries: [] };
  } catch (e) {
    // Blobs not configured (needs NETLIFY_BLOBS_SITE_ID + NETLIFY_BLOBS_TOKEN)
    return J({ ok: false, error: 'blobs_unconfigured', detail: e.message });
  }

  // Public: total only (no descriptions) — feeds the Net Worth KPI.
  if (action === 'total') return J({ ok: true, total: sum(data), configured: !!data.hash });

  const h = sha256(body.password || '');

  if (action === 'unlock') {
    if (!data.hash) { data.hash = h; await store.set(KEY, JSON.stringify(data)); return J({ ok: true, entries: data.entries, total: sum(data), firstSet: true }); }
    if (h !== data.hash) return J({ ok: false, error: 'wrong_password' });
    return J({ ok: true, entries: data.entries, total: sum(data) });
  }

  // All mutations require the password (and set it if this is the first write).
  if (data.hash && h !== data.hash) return J({ ok: false, error: 'wrong_password' });
  if (!data.hash) data.hash = h;

  if (action === 'add') {
    const desc = String(body.desc || '').trim();
    const amount = Number(body.amount);
    if (!desc || isNaN(amount)) return J({ ok: false, error: 'invalid' });
    data.entries.push({ id: newId(), desc, amount });
    await store.set(KEY, JSON.stringify(data));
    return J({ ok: true, entries: data.entries, total: sum(data) });
  }

  if (action === 'delete') {
    data.entries = (data.entries || []).filter((x) => String(x.id) !== String(body.id));
    await store.set(KEY, JSON.stringify(data));
    return J({ ok: true, entries: data.entries, total: sum(data) });
  }

  if (action === 'import') {
    (Array.isArray(body.entries) ? body.entries : []).forEach((e) => {
      const desc = String(e.desc || '').trim();
      const amount = Number(e.amount);
      if (desc && !isNaN(amount)) data.entries.push({ id: newId(), desc, amount });
    });
    await store.set(KEY, JSON.stringify(data));
    return J({ ok: true, entries: data.entries, total: sum(data) });
  }

  return J({ ok: false, error: 'unknown_action' });
};
