// Serve the freshest data.json the backend can reach, same-origin and uncached.
//
// The dashboard used to read raw.githubusercontent.com directly, and that CDN
// sends `Cache-Control: max-age=300` — so a sync that finished seconds ago
// stayed invisible for up to five minutes. That is why pressing Sync appeared
// to do nothing and the numbers only changed if you came back later.
//
// Sources, in order of freshness:
//   1. Netlify Blobs, written by every sync. Needs NETLIFY_BLOBS_SITE_ID +
//      NETLIFY_BLOBS_TOKEN on a zip/API-deployed site (see _core.js); without
//      them this throws and we fall through.
//   2. The GitHub contents API with GITHUB_TOKEN. Unlike the raw CDN it
//      reflects a commit immediately, and authenticated calls get 5,000/hour
//      rather than 60. Requested as raw media so the 1 MB base64 ceiling on
//      the JSON representation does not apply.
const { dataStore } = require('./_core');

const REPO = process.env.GITHUB_REPO || 'VIMALZ1312/ledgr-realtime-app';
const FILE = process.env.GITHUB_FILE_PATH || 'data.json';

async function fromGitHubApi() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'ledgr-bot',
      Accept: 'application/vnd.github.raw',
    },
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
  return resp.text();
}

exports.handler = async () => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  // Report which sources were tried when all of them fail — a 503 whose body
  // says "blobs not configured, GITHUB_TOKEN missing" is debuggable; a bare
  // 500 is what sent this endpoint unused for months.
  const tried = [];
  try {
    const cached = await dataStore().get('data.json');
    if (cached) return { statusCode: 200, headers, body: cached };
    tried.push('blobs: empty');
  } catch (err) {
    tried.push('blobs: ' + err.message);
  }
  try {
    const fresh = await fromGitHubApi();
    if (fresh) return { statusCode: 200, headers, body: fresh };
    tried.push('github: no GITHUB_TOKEN set');
  } catch (err) {
    tried.push('github: ' + err.message);
  }
  return { statusCode: 503, headers, body: JSON.stringify({ error: 'No current data available', tried }) };
};
