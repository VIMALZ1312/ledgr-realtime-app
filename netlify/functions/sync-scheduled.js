// Automatic sync on a cron (schedule lives in netlify.toml).
//
// Netlify caps a scheduled function at 30 seconds — nowhere near enough to
// force-refresh eight Plaid Items and page every transaction — so this function
// syncs nothing itself. It POSTs the background function, which has a 15 minute
// budget, and returns immediately.
//
// Why have this at all: the on-open pull in index.html only fires when someone
// actually opens the dashboard, so data.json can sit stale for weeks of not
// looking. This keeps it current either way. Data commits carry [skip ci] and
// match the `ignore` command in netlify.toml, so a scheduled sync costs
// function invocations and Plaid calls but never a site build.
exports.handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) {
    console.error('Scheduled sync: no site URL in env, cannot reach sync-background');
    return { statusCode: 500 };
  }
  try {
    const resp = await fetch(`${base}/.netlify/functions/sync-background`, { method: 'POST', headers: { 'x-ledgr-key': process.env.APP_KEY || '' } });
    console.log(`Scheduled sync handed off to sync-background: HTTP ${resp.status}`);
    return { statusCode: 202 };
  } catch (err) {
    console.error('Scheduled sync could not start:', err.message);
    return { statusCode: 500 };
  }
};
