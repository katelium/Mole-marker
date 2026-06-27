// MoleMark — Gemini API proxy
// API key is stored as Netlify environment variable GEMINI_API_KEY
// Students never see this file or the key.
// Uses Node.js built-in https so no npm install needed.

const https = require('https');

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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
  'gemini-2.5-flash-lite',  // fastest — try first
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

const PROMPT = `You are a Singapore O-Level Chemistry (6092) marker. Your job is to mark mole calculation working strictly and consistently using the rules below. Apply these rules the same way every time — do not vary your judgement between attempts.

MARKING RULES (apply exactly):
1. n = m / Mr — correct only if Mr is the correct molecular/formula mass for that substance.
2. n = c × V — V must be in dm³. If student uses cm³ without dividing by 1000, mark WRONG.
3. n = V / 24 (r.t.p.) or n = V / 22.4 (s.t.p.) — must match the conditions stated in the question.
4. Mole ratio — must match the balanced equation given or implied. Wrong ratio = WRONG step.
5. Limiting reagent — must correctly identify which reagent runs out first.
6. % yield = (actual / theoretical) × 100% — both values must be correct.
7. Arithmetic — check every calculation. A correct method with wrong arithmetic = WRONG step.
8. Units — missing or wrong units on a final answer = WRONG step.
9. A step is CORRECT only if BOTH the method and the arithmetic are right.
10. Do not award marks for the right answer if the working shown is wrong.
11. Use whole number for molar mass or Mr except for chlorine 35.5
12. Allow error carry forward for calculation 

STEP IDENTIFICATION:
Read the image top to bottom. Number every distinct line of working as a separate step:
- Stating a formula
- Substituting values into a formula
- A calculation result
- A mole ratio conversion
- A final answer

OUTPUT FORMAT — return ONLY this JSON, no markdown fences, no extra text:
{
  "studentWork": "<one sentence: what substance/reaction this question is about>",
  "steps": [
    {
      "stepNumber": 1,
      "studentWork": "<copy exactly what the student wrote>",
      "isCorrect": true,
      "xFraction": 0.08,
      "yFraction": 0.10,
      "explanation": "<correct: one sentence why it is right | wrong: state exactly what the error is and what the correct value/method should be>",
      "correctedWork": "<include only if isCorrect is false: the correct version of this step>"
    }
  ],
  "totalSteps": 5,
  "correctSteps": 4,
  "overallFeedback": "<1–2 sentences of encouragement directly to the student>",
  "finalAnswerCorrect": true
}

xFraction: place near left margin, between 0.05 and 0.12.
yFraction: match the vertical position of each line in the image (0.0 = top, 1.0 = bottom).`;

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
    base64 = body.base64;
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
    generationConfig: { temperature: 0, maxOutputTokens: 8192 }
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
      respBody = r.body;
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
      const end = text.lastIndexOf('}');
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
