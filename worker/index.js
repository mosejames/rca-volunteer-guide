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
      model: 'claude-haiku-4-5-20251001',
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

  // Strip markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  }

  // If still not valid JSON, try to find the first { and last }
  jsonStr = jsonStr.trim();
  if (!jsonStr.startsWith('{')) {
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }
  }

  const parsed = JSON.parse(jsonStr);
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

IMPORTANT - KEEP OUTPUT COMPACT:
- ONLY include rows where letter groups appear (ABCDEFGH, IJKL, ABCD, EFGH, AB, CD, ALL, etc.)
- SKIP rows that are staff-only (no letter group assignment)
- SKIP LUNCH rows unless ALL groups are at lunch
- Combine consecutive time blocks with the same group+location into one row
- For the duties array, include only 5-10 key entries (morning duties and carpool). Skip the detailed station list.
- The "location" should be the classroom/area name (5a, 5aa, Great Hall, Courtyard, etc.)
- Set flag to "all" when groups is "ALL"
- Set flag to "split" when a group divides
- Leave flag empty for normal assignments

The day name should match the PDF header (e.g., "Friday March 13").

Return ONLY the JSON object. No markdown, no explanation, no code blocks.`;

// --- Apps Script caller (handles Google's redirect chain) ---
async function callAppsScript(url, payload) {
  // Step 1: POST to Apps Script, get the 302 redirect URL
  const postResp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual'
  });

  // Step 2: Follow the redirect with a GET (Google switches POST to GET)
  const location = postResp.headers.get('Location');
  if (!location) {
    const text = await postResp.text();
    throw new Error(`No redirect from Apps Script: ${text.substring(0, 300)}`);
  }

  const resp = await fetch(location, { redirect: 'follow' });
  const text = await resp.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned non-JSON: ${text.substring(0, 300)}`);
  }
}

// --- Sheet Write Handler (via Google Apps Script) ---
async function handleWriteSheet(body, env) {
  const { tabName, rows, mode } = body;
  const customHeaders = body.headers || ['day', 'time_start', 'time_end', 'groups', 'location', 'note', 'flag'];
  if (!tabName || !rows) {
    return jsonResponse({ error: 'Missing tabName or rows' }, 400, env);
  }

  const result = await callAppsScript(env.APPS_SCRIPT_URL, {
    action: 'write',
    tabName,
    rows,
    headers: customHeaders,
    mode: mode || 'replace'
  });

  if (result.error) throw new Error(result.error);
  return jsonResponse(result, 200, env);
}

// --- Template Duplication Handler (via Google Apps Script) ---
async function handleDuplicateTemplate(body, env) {
  const { newTabName } = body;
  if (!newTabName) {
    return jsonResponse({ error: 'Missing newTabName' }, 400, env);
  }

  const result = await callAppsScript(env.APPS_SCRIPT_URL, {
    action: 'duplicate-template',
    newTabName
  });

  if (result.error) throw new Error(result.error);
  return jsonResponse(result, 200, env);
}
