// Netlify Background Function — runs asynchronously up to 15 minutes.
// Netlify returns 202 immediately to the client; this handler runs in the background.
// The client passes a jobId it generated; results are stored in Netlify Blobs.
const https = require('https');
const { getStore } = require('@netlify/blobs');

const MAX_TEXT_CHARS = 15000;

const SYSTEM_PROMPT = `You are an expert collision repair estimate analyst. Your job is to compare two estimates — one from a repair shop and one from an insurance company — and identify every discrepancy.

You will return ONLY a valid JSON object. No prose, no markdown fences, just the raw JSON.

The JSON structure must be exactly:
{
  "claim_info": {
    "insured_name": "string or null",
    "claim_number": "string or null",
    "vehicle": "string or null",
    "date_of_loss": "string or null",
    "shop_name": "string or null",
    "insurer_name": "string or null"
  },
  "shop_total": number,
  "insurer_total": number,
  "gap": number,
  "not_paid": [
    { "description": "string", "shop_amount": number, "notes": "string" }
  ],
  "underpaid": [
    { "description": "string", "shop_amount": number, "insurer_amount": number, "difference": number, "notes": "string" }
  ],
  "pending": [
    { "description": "string", "shop_amount": number, "insurer_status": "string" }
  ],
  "fully_paid": [
    { "description": "string", "amount": number }
  ],
  "flags": [
    { "issue": "string", "detail": "string" }
  ]
}

Definitions:
- not_paid: line items on the shop estimate completely absent from the insurer estimate
- underpaid: items present on both estimates but insurer paid less than shop billed
- pending: items the insurer acknowledged but wrote as "open", "TBD", or assigned $0 pending invoice
- fully_paid: items where both estimates agree and amounts match within $1
- flags: strategic issues worth raising in a supplement demand
- gap = shop_total - insurer_total
- All monetary values must be numbers, not strings
- Extract claim_info from the text of the estimates; use null if not found
- Be thorough — missing one underpaid item costs real money`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'API key not set' }) };
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { jobId, estimate1, estimate2 } = body;
  if (!jobId || !estimate1 || !estimate2) return { statusCode: 400, body: JSON.stringify({ error: 'Missing fields' }) };
  const store = getStore('compare-jobs');
  await store.setJSON(jobId, { status: 'processing' }, { ttl: 3600 });
  try {
    const content = [];
    content.push({ type: 'text', text: '=== ESTIMATE 1: Shop / Repair Facility ===\n' });
    addEstimate(content, estimate1);
    content.push({ type: 'text', text: '\n\n=== ESTIMATE 2: Insurance / Payout ===\n' });
    addEstimate(content, estimate2);
    content.push({ type: 'text', text: '\n\nNow analyze these two estimates and return the JSON object as instructed.' });
    const payload = { model: 'claude-sonnet-4-6', max_tokens: 4096, temperature: 0, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] };
    const apiResponse = await callAnthropic(apiKey, payload);
    const text = apiResponse.content[0].text.trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let result;
    try { result = JSON.parse(cleaned); } catch {
      const repaired = repairJson(cleaned);
      try { result = JSON.parse(repaired); } catch {
        const match = repaired.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('AI returned non-JSON');
        result = JSON.parse(match[0]);
      }
    }
    await store.setJSON(jobId, { status: 'done', result }, { ttl: 3600 });
  } catch (err) {
    console.error('Background error:', err);
    await store.setJSON(jobId, { status: 'error', error: err.message }, { ttl: 3600 });
  }
  return { statusCode: 202, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
};

function addEstimate(content, est) {
  if (est.type === 'image') {
    content.push({ type: 'image', source: { type: 'base64', media_type: est.mediaType || 'image/jpeg', data: est.content } });
    if (est.extra) content.push({ type: 'text', text: '\nAdditional notes: ' + est.extra });
  } else {
    let text = est.content || '';
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[truncated]';
    content.push({ type: 'text', text });
  }
}

function repairJson(str) {
  let inString = false, escaped = false, result = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

function callAnthropic(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.statusCode >= 400 ? reject(new Error(parsed.error?.message || 'API error ' + res.statusCode)) : resolve(parsed);
        } catch { reject(new Error('Failed to parse response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error('Timed out')); });
    req.write(body);
    req.end();
  });
}
