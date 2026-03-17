import { CONFIG } from '../config.js';

export function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip \r
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (values[i] || '').trim();
    });
    return obj;
  });
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

export function expandGroups(groupStr) {
  if (!groupStr) return [];
  const upper = groupStr.trim().toUpperCase();
  if (upper === 'ALL') return ['ALL'];
  return upper.split('').filter(ch => ch >= 'A' && ch <= 'Z');
}

export function parseScheduleRows(rows) {
  return rows.map(row => ({
    day: row.day || '',
    timeStart: row.time_start || '',
    timeEnd: row.time_end || '',
    groups: row.groups || '',
    groupList: expandGroups(row.groups),
    location: row.location || '',
    note: row.note || '',
    flag: row.flag || ''
  }));
}

export function parseLocations(rows) {
  const map = {};
  rows.forEach(row => {
    if (row.location_key) {
      map[row.location_key] = {
        display_name: row.display_name || row.location_key,
        hint: row.hint || ''
      };
    }
  });
  return map;
}

export async function fetchSheet(tabName) {
  const url = CONFIG.CSV_BASE + encodeURIComponent(tabName);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Sheet fetch failed: ${resp.status}`);
  const text = await resp.text();
  return parseCSV(text);
}

export async function fetchSchedule(tabName) {
  const rows = await fetchSheet(tabName);
  return parseScheduleRows(rows);
}

export async function fetchLocations() {
  const rows = await fetchSheet('Locations');
  return parseLocations(rows);
}
