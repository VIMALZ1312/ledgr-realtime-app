const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
}));

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const { public_token, nickname } = JSON.parse(event.body || '{}');
    if (!public_token || !nickname) return { statusCode: 400, headers, body: JSON.stringify({ error: 'public_token and nickname required' }) };
    const response = await plaid.itemPublicTokenExchange({ public_token });
    return { statusCode: 200, headers, body: JSON.stringify({
      success: true,
      nickname: nickname.toUpperCase(),
      access_token: response.data.access_token,
      instruction: `Add to Netlify Environment Variables: PLAID_TOKEN_${nickname.toUpperCase()} = ${response.data.access_token}`
    })};
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.response?.data || err.message }) };
  }
};
