// Create a Plaid Link token so the frontend can open Plaid Link to add a bank.
const { plaid, Products, CountryCode } = require('./_core');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: 'vimal-raj' },
      client_name: 'LEDGR Realtime',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    return { statusCode: 200, headers, body: JSON.stringify({ link_token: response.data.link_token }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.response?.data || err.message }) };
  }
};
