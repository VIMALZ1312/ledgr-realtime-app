// Optional: serve the latest data.json from the Netlify Blobs cache.
// The frontend currently reads data.json from GitHub raw; this is a same-origin
// fallback (/api/data) that doesn't depend on GitHub.
const { dataStore } = require('./_core');

exports.handler = async () => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  try {
    const v = await dataStore().get('data.json');
    if (!v) return { statusCode: 404, headers, body: JSON.stringify({ error: 'No data cached yet — run a sync.' }) };
    return { statusCode: 200, headers, body: v };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
