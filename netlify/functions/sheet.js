// The private savings Google Sheet, behind the passcode. Its published CSV URL
// lives in the SHEET_CSV_URL env var instead of in the public page source.
const { requireKey } = require('./_core');

exports.handler = async (event) => {
  const denied = requireKey(event); if (denied) return denied;
  const url = process.env.SHEET_CSV_URL;
  if (!url) return { statusCode: 503, body: 'SHEET_CSV_URL not set' };
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now());
  return { statusCode: r.ok ? 200 : 502, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' }, body: await r.text() };
};
