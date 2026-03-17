// worker/index.js — Cloudflare Worker API proxy for RCA Volunteer Guide

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, env);
    }

    if (body.password !== env.ADMIN_PASSWORD) {
      return jsonResponse({ error: 'Unauthorized' }, 401, env);
    }

    try {
      switch (path) {
        case '/parse-pdf':
          return await handleParsePDF(body, env);
        case '/write-sheet':
          return await handleWriteSheet(body, env);
        case '/duplicate-template':
          return await handleDuplicateTemplate(body, env);
        default:
          return jsonResponse({ error: 'Not found' }, 404, env);
      }
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, env);
    }
  }
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, env = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env),
    }
  });
}

// --- PDF Parse Handler ---
async function handleParsePDF(body, env) {
  const { pdfBase64 } = body;
  if (!pdfBase64) return jsonResponse({ error: 'Missing pdfBase64' }, 400, env);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text: PARSE_PROMPT,
          }
        ]
      }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${errText}`);
  }

  const result = await response.json();
  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent) throw new Error('No text response from API');

  let jsonStr = textContent.text;
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1];

  const parsed = JSON.parse(jsonStr.trim());
  return jsonResponse(parsed, 200, env);
}

const PARSE_PROMPT = `You are parsing an RCA (Ron Clark Academy) visitation day schedule PDF into structured JSON.

The PDF contains:
1. A MAIN SCHEDULE GRID at the top with:
   - Time blocks as rows (left column)
   - Staff/teacher names as column headers
   - Cell contents showing grade groups (4th, 5a, 5aa, 6th, 7a, 7aa, 8th, 8a, 8aa) and letter groups (ABCDEFGH, IJKL, ABCD, EFGH, AB, CD, etc.)
   - Special entries: ALL, LUNCH, SLIDE, CHEERS/SPIN, Houses, Courtyard, etc.

2. DUTY NOTES at the bottom with morning duties, station assignments, slide certify roles, etc.

IMPORTANT RULES:
- The column headers are STAFF NAMES (Clark, Bearden, etc.), NOT locations
- The CELL CONTENTS tell you what group is in that teacher's room/area at that time
- Grade groups (4th, 5a, 5aa, etc.) are LOCATIONS (classrooms)
- Letter groups (ABCDEFGH, IJKL, etc.) are VOLUNTEER GROUP ASSIGNMENTS
- A cell might contain both: the grade group IS the location, the letter group is who goes there
- When a cell just says a grade group with no letter group, it means all groups go there (or it's a staff-only entry)
- "ALL" means all volunteer groups
- Ignore cells with just "x" (staff absent) or "Break"

Extract into this EXACT JSON format:

{
  "schedule": [
    {
      "day": "Thursday March 12",
      "time_start": "8:15",
      "time_end": "8:45",
      "groups": "ALL",
      "location": "Houses",
      "note": "",
      "flag": "all"
    }
  ],
  "duties": [
    {
      "day": "Thursday March 12",
      "time_block": "7:00-8:00",
      "zone": "Rotunda",
      "staff_assigned": "Clark, Bearden, Vazquez",
      "notes": ""
    }
  ]
}

For the schedule array:
- Create one row per TIME BLOCK per LETTER GROUP ASSIGNMENT
- If ABCDEFGH is in 5aa and IJKL is in 7a at the same time, that's TWO rows
- The "location" should be the classroom/area name (5a, 5aa, Great Hall, Courtyard, etc.)
- Set flag to "all" when groups is "ALL"
- Set flag to "split" when a larger group divides (e.g., ABCD splits from ABCDEFGH)
- Set flag to "merge" when groups combine
- Leave flag empty for normal assignments
- LUNCH blocks: include them with location "LUNCH"
- ALL blocks (Cheers, Slide, Rotunda, etc.): include with the actual location

For the duties array:
- Extract all morning duties, station assignments, slide certify roles, carpool duties
- These are from the section BELOW the main schedule grid

The day name should match what's shown in the PDF header (e.g., "Friday March 13" or "Thursday March 12").

Return ONLY the JSON object. No explanation.`;

// --- Sheet Write Handler ---
async function handleWriteSheet(body, env) {
  const { sheetId, tabName, rows, mode } = body;
  const customHeaders = body.headers || ['day', 'time_start', 'time_end', 'groups', 'location', 'note', 'flag'];
  if (!sheetId || !tabName || !rows) {
    return jsonResponse({ error: 'Missing sheetId, tabName, or rows' }, 400, env);
  }

  const token = await getGoogleToken(env);

  if (mode === 'replace') {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}:clear`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      }
    ).catch(() => {});
  }

  if (mode === 'append') {
    const values = rows.map(r => customHeaders.map(h => r[h] || ''));
    const writeResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values })
      }
    );
    if (!writeResp.ok) {
      const err = await writeResp.text();
      throw new Error(`Sheets API error: ${writeResp.status} ${err}`);
    }
    return jsonResponse({ success: true, tabName }, 200, env);
  }

  const values = [customHeaders, ...rows.map(r => customHeaders.map(h => r[h] || ''))];

  const writeResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    }
  );

  if (!writeResp.ok) {
    const err = await writeResp.text();
    throw new Error(`Sheets API error: ${writeResp.status} ${err}`);
  }

  return jsonResponse({ success: true, tabName }, 200, env);
}

// --- Template Duplication Handler ---
async function handleDuplicateTemplate(body, env) {
  const { sheetId, newTabName } = body;
  if (!sheetId || !newTabName) {
    return jsonResponse({ error: 'Missing sheetId or newTabName' }, 400, env);
  }

  const token = await getGoogleToken(env);

  const metaResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const meta = await metaResp.json();
  const templateSheet = meta.sheets?.find(s => s.properties.title === 'TEMPLATE');

  if (!templateSheet) {
    return jsonResponse({ error: 'TEMPLATE tab not found in sheet' }, 404, env);
  }

  const dupResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [{
          duplicateSheet: {
            sourceSheetId: templateSheet.properties.sheetId,
            newSheetName: newTabName,
            insertSheetIndex: meta.sheets.length,
          }
        }]
      })
    }
  );

  if (!dupResp.ok) {
    const err = await dupResp.text();
    throw new Error(`Sheets API error: ${dupResp.status} ${err}`);
  }

  return jsonResponse({ success: true, tabName: newTabName }, 200, env);
}

// --- Google Auth (Service Account JWT) ---
async function getGoogleToken(env) {
  const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);

  const toBase64Url = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = toBase64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const unsignedToken = `${header}.${claim}`;

  const pemContents = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');

  const keyData = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${header}.${claim}.${sig}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Failed to get Google token');
  return tokenData.access_token;
}
