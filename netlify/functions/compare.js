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
