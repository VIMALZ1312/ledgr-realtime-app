// Exchange a Plaid public_token for an access_token AND persist it to Netlify
// Blobs automatically — no manual env-var paste (the key Option A improvement).
const { plaid, saveToken } = require('./_core');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const { public_token, nickname } = JSON.parse(event.body || '{}');
    if (!public_token || !nickname) return { statusCode: 400, headers, body: JSON.stringify({ error: 'public_token and nickname required' }) };
    const response = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const { canonical, saved } = await saveToken(nickname, access_token);
    if (saved) {
      return { statusCode: 200, headers, body: JSON.stringify({
        success: true, nickname: canonical, saved: true,
        message: `Bank "${canonical}" linked and saved. Run a sync to pull its data.`,
      })};
    }
    // Blobs unavailable — fall back to a one-time manual env-var paste.
    return { statusCode: 200, headers, body: JSON.stringify({
      success: true, nickname: canonical, saved: false, access_token,
      instruction: `Blobs storage is off. Add this Netlify env var, then redeploy: PLAID_TOKEN_${canonical.toUpperCase()} = ${access_token}`,
    })};
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.response?.data || err.message }) };
  }
};
