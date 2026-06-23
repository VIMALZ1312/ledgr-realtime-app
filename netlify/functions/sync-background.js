// Manual sync (triggered by the dashboard Sync button via /api/sync redirect).
// The `-background` suffix makes this a Netlify Background Function: it returns
// 202 immediately and may run up to 15 min — enough to page every bank's
// transactions without hitting the 26s synchronous-function timeout.
const { buildDataJson } = require('./_core');

exports.handler = async () => {
  try {
    const result = await buildDataJson();
    console.log('✓ Manual sync complete:', result);
  } catch (err) {
    console.error('✗ Manual sync failed:', err.message);
  }
  // Background functions ignore the body; result is observed via data.json/Blobs.
  return { statusCode: 202 };
};
