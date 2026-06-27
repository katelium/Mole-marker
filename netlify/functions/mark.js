// MoleMark — Gemini API proxy
// API key is stored as Netlify environment variable GEMINI_API_KEY
// Students never see this file or the key.
// Uses Node.js built-in https so no npm install needed.

const https = require('https');

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
];

const PROMPT = `You are an expert Singapore O-Level Chemistry (6092) marker specialising in mole calculations.

Carefully examine this student's handwritten or printed mole calculation work. Identify EVERY distinct step or line of working, including:
- Writing or stating a formula
- Substituting values
- Arithmetic / unit conversion
- Final answer with units

Mark each step against these 6092 mole concepts:
• n = m / Mr  (moles from mass and relative molecular mass)
• n = c × V   (moles from concentration × volume in dm³; if V given in cm³ divide by 1000)
• n = V / 24  at r.t.p.  OR  n = V / 22.4  at s.t.p. (molar gas volume)
• Stoichiometric ratios from a balanced equation (mole ratio approach)
• Limiting reagent identification and theoretical yield
• Percentage yield = (actual / theoretical) × 100%
• Any correct algebraic rearrangement of the above

Return ONLY a valid JSON object — no markdown fences, no extra text — exactly matching this schema:
{
  "studentWork": "<brief description of what the full question/working is about>",
  "steps": [
    {
      "stepNumber": 1,
      "studentWork": "<exactly what the student wrote for this step>",
      "isCorrect": true,
      "xFraction": 0.08,
      "yFraction": 0.10,
      "explanation": "<If correct: one short sentence confirming why. If wrong: explain the specific error and the correct approach.>",
      "correctedWork": "<only include if isCorrect is false — the correct version of this step>"
    }
  ],
  "totalSteps": 5,
  "correctSteps": 4,
  "overallFeedback": "<1–2 encouraging sentences addressed directly to the student>",
  "finalAnswerCorrect": true
}

xFraction and yFraction are the FRACTIONAL POSITION (0.0 = top/left edge, 1.0 = bottom/right edge) of this step in the IMAGE.
Place xFraction near the LEFT MARGIN (around 0.05–0.15) so ticks/crosses appear at the start of each line.
Vary yFraction to match the vertical position of each line in the image.

Be thorough and strict — flag any arithmetic error, wrong formula, incorrect unit conversion, or missing step.`;

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'GEMINI_API_KEY is not set. Go to Netlify → Site Settings → Environment Variables and add it.'
      }),
    };
  }

  let base64, mimeType;
  try {
    const body = JSON.parse(event.body);
    base64   = body.base64;
    mimeType = body.mimeType || 'image/jpeg';
    if (!base64) throw new Error('Missing image data');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request: ' + e.message }) };
  }

  const requestBody = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: base64 } }
      ]
    }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 8192 }
  };

  let lastErr = 'Unknown error';

  for (const model of GEMINI_MODELS) {
    let respStatus, respBody;
    try {
      const r = await httpsPost(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        requestBody
      );
      respStatus = r.status;
      respBody   = r.body;
    } catch (networkErr) {
      lastErr = 'Network error reaching Gemini: ' + networkErr.message;
      continue;
    }

    if (respStatus >= 200 && respStatus < 300) {
      const data = JSON.parse(respBody);

      const finishReason = data?.candidates?.[0]?.finishReason;
      if (finishReason === 'MAX_TOKENS') {
        return {
          statusCode: 422,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Response cut off — try an image with fewer steps.' }),
        };
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) {
        return {
          statusCode: 422,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Gemini returned an empty response. Please try again.' }),
        };
      }

      const start = text.indexOf('{');
      const end   = text.lastIndexOf('}');
      if (start === -1 || end === -1) {
        return {
          statusCode: 422,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Could not parse response. Raw: ' + text.substring(0, 300) }),
        };
      }

      try {
        const result = JSON.parse(text.substring(start, end + 1));
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        };
      } catch (parseErr) {
        return {
          statusCode: 422,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'JSON parse error: ' + parseErr.message }),
        };
      }
    }

    // Non-OK response
    const errData = JSON.parse(respBody || '{}');
    lastErr = errData.error?.message || `API error ${respStatus}`;
    if (respStatus === 401 || respStatus === 403) break; // bad key, stop trying
  }

  return {
    statusCode: 502,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: lastErr }),
  };
};
