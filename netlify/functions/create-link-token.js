// Create a Plaid Link token, in one of two modes.
//
// create mode (no nickname, or a nickname with no token yet): adds a brand new
// bank, and the public_token it produces must be exchanged for an access token.
//
// update mode (nickname that already has a token): re-authenticates the Item
// that token belongs to, which is what ITEM_LOGIN_REQUIRED asks for. The
// existing access token stays valid and keeps working after the bank login, so
// there is nothing to exchange, nothing to paste into an env var and no
// redeploy — which matters here because Netlify Blobs is not configured on this
// site, so a fresh link cannot save its own token (see saveToken in _core.js).
// Re-linking in create mode instead would mint a *second* Item for the same
// bank: double Plaid billing, duplicate transactions, and the old dead token
// still sitting in the env var.
const { plaid, Products, CountryCode, getTokens } = require('./_core');

const BASE = {
  user: { client_user_id: 'vimal-raj' },
  client_name: 'LEDGR Realtime',
  country_codes: [CountryCode.Us],
  language: 'en',
};

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    let nickname = '';
    try { nickname = String(JSON.parse(event.body || '{}').nickname || '').trim().toLowerCase(); } catch { /* no body: create mode */ }

    if (nickname) {
      const tokens = await getTokens();
      const access_token = tokens[nickname];
      if (access_token) {
        // products must be omitted in update mode — Plaid rejects the pair.
        //
        // account_selection_enabled is what lets a re-auth ADD an account that
        // was left unshared when the Item was first linked. Without it, the
        // first wifebofa re-link came back with three of four accounts (BofA
        // ...2776 absent) and no way to correct it from this flow. Plaid only
        // shows its own Account Select for institutions that don't run one
        // inside their OAuth flow; where the bank has its own (BofA usually
        // does), the account still has to be ticked on the bank's page.
        const response = await plaid.linkTokenCreate({
          ...BASE,
          access_token,
          update: { account_selection_enabled: true },
        });
        return { statusCode: 200, headers, body: JSON.stringify({
          link_token: response.data.link_token, mode: 'update', nickname,
        })};
      }
      // Fall through to create mode, but say so: a typo'd nickname silently
      // adding a duplicate Item is exactly the outcome this guards against.
      const response = await plaid.linkTokenCreate({ ...BASE, products: [Products.Transactions] });
      return { statusCode: 200, headers, body: JSON.stringify({
        link_token: response.data.link_token, mode: 'create', nickname,
        note: `No existing token for "${nickname}" — this will add a new bank. Known: ${Object.keys(tokens).join(', ')}`,
      })};
    }

    const response = await plaid.linkTokenCreate({ ...BASE, products: [Products.Transactions] });
    return { statusCode: 200, headers, body: JSON.stringify({ link_token: response.data.link_token, mode: 'create' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.response?.data || err.message }) };
  }
};
