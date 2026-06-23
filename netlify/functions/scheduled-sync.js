// Scheduled sync — replaces the Replit node-cron 6-hour job. The schedule is
// declared in netlify.toml ([functions."scheduled-sync"] schedule = "0 */6 * * *").
// Scheduled functions run in the background (up to 15 min), so the full
// per-bank transaction paging completes safely.
const { buildDataJson } = require('./_core');

exports.handler = async () => {
  console.log('⏰ Scheduled sync starting...');
  try {
    const result = await buildDataJson();
    console.log('✓ Scheduled sync complete:', result);
  } catch (err) {
    console.error('✗ Scheduled sync failed:', err.message);
  }
  return { statusCode: 200 };
};
