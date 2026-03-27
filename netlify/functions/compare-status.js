// Polling endpoint — reads the job result from Netlify Blobs.
// The frontend calls this every 2 seconds with ?id=<jobId> until status is 'done' or 'error'.
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  const jobId = event.queryStringParameters && event.queryStringParameters.id;
  if (!jobId) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing id parameter' }) };
  }
  try {
    const store = getStore('compare-jobs');
    const data = await store.getJSON(jobId);
    if (!data) {
      return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ status: 'not_found' }) };
    }
    return { statusCode: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  } catch (err) {
    console.error('Status check error:', err);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
}
