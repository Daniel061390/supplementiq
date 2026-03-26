// Netlify serverless function — proxies requests to the Anthropic API
// The API key lives in Netlify's environment variables, never in your code.

const https = require('https');

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
- flags: strategic issues worth raising in a supplement demand (e.g. OEM vs aftermarket substitution, zero paint hours on LKQ doors, missing R&I operations, deductible status, ADAS calibration disputes)
- gap = shop_total - insurer_total
- All monetary values must be numbers, not strings
- Extract claim_info from the text of the estimates; use null if not found
- Be thorough — missing one underpaid item costs real money`;

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable is not set in Netlify.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { estimate1, estimate2 } = body;
  if (!estimate1 || !estimate2) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Both estimate1 and estimate2 are required' }) };
  }

  // Build message content — handles both text and image inputs
  const content = [];

  content.push({ type: 'text', text: '=== ESTIMATE 1: Shop / Repair Facility ===\n' });
  addEstimate(content, estimate1);

  content.push({ type: 'text', text: '\n\n=== ESTIMATE 2: Insurance / Payout ===\n' });
  addEstimate(content, estimate2);

  content.push({ type: 'text', text: '\n\nNow analyze these two estimates and return the JSON object as instructed.' });

  const payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }]
  };

  try {
    const apiResponse = await callAnthropic(apiKey, payload);
    const text = apiResponse.content[0].text.trim();

    // Strip any accidental markdown fences
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      // Try to extract a JSON object from the response
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('AI returned non-JSON response: ' + text.slice(0, 200));
      result = JSON.parse(match[0]);
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };

  } catch (err) {
    console.error('Comparison error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message })
    };
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function addEstimate(content, est) {
  if (est.type === 'image') {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: est.mediaType || 'image/jpeg',
        data: est.content
      }
    });
    if (est.extra) {
      content.push({ type: 'text', text: '\nAdditional notes: ' + est.extra });
    }
  } else {
    content.push({ type: 'text', text: est.content || '' });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

function callAnthropic(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error?.message || `API error ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Failed to parse API response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timed out after 120s')); });
    req.write(body);
    req.end();
  });
}
