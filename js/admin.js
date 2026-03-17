// js/admin.js — Admin hub logic

import { CONFIG } from '../config.js';

let password = '';
let parsedSchedule = [];
let parsedDuties = [];
let knownLocations = {};

// --- Load known locations for highlighting ---
async function loadKnownLocations() {
  try {
    const { fetchLocations } = await import('./sheets.js');
    knownLocations = await fetchLocations();
  } catch { /* skip if fetch fails */ }
}
loadKnownLocations();

// --- DOM refs ---
const passwordGate = document.getElementById('passwordGate');
const passwordInput = document.getElementById('passwordInput');
const passwordSubmit = document.getElementById('passwordSubmit');
const passwordError = document.getElementById('passwordError');
const adminHub = document.getElementById('adminHub');
const sheetLink = document.getElementById('sheetLink');

const hubCards = document.querySelectorAll('.hub-card');
const sections = {
  pdf: document.getElementById('sectionPdf'),
  excel: document.getElementById('sectionExcel'),
  template: document.getElementById('sectionTemplate'),
  preview: document.getElementById('sectionPreview'),
};

// --- Password Gate ---
passwordSubmit.addEventListener('click', authenticate);
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') authenticate(); });

function authenticate() {
  password = passwordInput.value;
  if (!password) { passwordError.textContent = 'Enter a password'; return; }
  sessionStorage.setItem('rca_admin_pw', password);
  showHub();
}

function showHub() {
  passwordGate.style.display = 'none';
  adminHub.style.display = 'block';
  sheetLink.href = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}`;
}

const savedPw = sessionStorage.getItem('rca_admin_pw');
if (savedPw) { password = savedPw; showHub(); }

// --- Navigation ---
hubCards.forEach(card => {
  card.addEventListener('click', () => {
    const action = card.dataset.action;
    Object.values(sections).forEach(s => s.classList.remove('active'));
    document.querySelector('.hub-grid').style.display = 'none';
    document.querySelector('.sheet-link').style.display = 'none';
    if (sections[action]) sections[action].classList.add('active');
  });
});

document.querySelectorAll('[data-back]').forEach(el => {
  el.addEventListener('click', () => {
    Object.values(sections).forEach(s => s.classList.remove('active'));
    document.querySelector('.hub-grid').style.display = 'grid';
    document.querySelector('.sheet-link').style.display = 'block';
  });
});

// --- PDF Upload ---
const pdfDropZone = document.getElementById('pdfDropZone');
const pdfFileInput = document.getElementById('pdfFileInput');
const pdfStatus = document.getElementById('pdfStatus');

pdfDropZone.addEventListener('click', () => pdfFileInput.click());
pdfDropZone.addEventListener('dragover', (e) => { e.preventDefault(); pdfDropZone.classList.add('dragover'); });
pdfDropZone.addEventListener('dragleave', () => pdfDropZone.classList.remove('dragover'));
pdfDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  pdfDropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') handlePDFUpload(file);
});
pdfFileInput.addEventListener('change', () => {
  if (pdfFileInput.files[0]) handlePDFUpload(pdfFileInput.files[0]);
});

async function handlePDFUpload(file) {
  pdfStatus.innerHTML = '<div class="status-msg"><span class="spinner"></span> Reading schedule... this may take 30-60 seconds</div>';

  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    try {
      const resp = await fetch(`${CONFIG.WORKER_URL}/parse-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, pdfBase64: base64 })
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Parse failed');
      }

      const data = await resp.json();
      parsedSchedule = data.schedule || [];
      parsedDuties = data.duties || [];

      pdfStatus.innerHTML = `<div class="status-msg status-success">Parsed ${parsedSchedule.length} schedule rows and ${parsedDuties.length} duty rows</div>`;

      if (parsedSchedule.length > 0) {
        const day = parsedSchedule[0].day || '';
        const parts = day.split(' ');
        if (parts.length >= 3) {
          document.getElementById('targetTabName').value = `${parts[0].substring(0, 3)} ${parts[1]} ${parts[2]}`;
        }
      }

      showPreview(parsedSchedule);
    } catch (err) {
      pdfStatus.innerHTML = `<div class="status-msg status-error">Error: ${err.message}</div>`;
    }
  };
  reader.readAsDataURL(file);
}

// --- Excel/CSV Upload ---
const excelDropZone = document.getElementById('excelDropZone');
const excelFileInput = document.getElementById('excelFileInput');
const excelStatus = document.getElementById('excelStatus');

excelDropZone.addEventListener('click', () => excelFileInput.click());
excelDropZone.addEventListener('dragover', (e) => { e.preventDefault(); excelDropZone.classList.add('dragover'); });
excelDropZone.addEventListener('dragleave', () => excelDropZone.classList.remove('dragover'));
excelDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  excelDropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleExcelUpload(file);
});
excelFileInput.addEventListener('change', () => {
  if (excelFileInput.files[0]) handleExcelUpload(excelFileInput.files[0]);
});

async function handleExcelUpload(file) {
  excelStatus.innerHTML = '<div class="status-msg"><span class="spinner"></span> Parsing file...</div>';

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = new Uint8Array(reader.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet);

      parsedSchedule = rows.map(r => ({
        day: r.day || r.Day || '',
        time_start: r.time_start || r.TimeStart || r['Time Start'] || '',
        time_end: r.time_end || r.TimeEnd || r['Time End'] || '',
        groups: r.groups || r.Groups || '',
        location: r.location || r.Location || '',
        note: r.note || r.Note || '',
        flag: r.flag || r.Flag || '',
      }));
      parsedDuties = [];

      excelStatus.innerHTML = `<div class="status-msg status-success">Parsed ${parsedSchedule.length} rows</div>`;
      showPreview(parsedSchedule);
    } catch (err) {
      excelStatus.innerHTML = `<div class="status-msg status-error">Error: ${err.message}</div>`;
    }
  };
  reader.readAsArrayBuffer(file);
}

// --- Template ---
document.getElementById('templateCreate').addEventListener('click', async () => {
  const tabName = document.getElementById('templateTabName').value.trim();
  const status = document.getElementById('templateStatus');

  if (!tabName) {
    status.innerHTML = '<div class="status-msg status-error">Enter a tab name</div>';
    return;
  }

  status.innerHTML = '<div class="status-msg"><span class="spinner"></span> Creating tab...</div>';

  try {
    const resp = await fetch(`${CONFIG.WORKER_URL}/duplicate-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, sheetId: CONFIG.SHEET_ID, newTabName: tabName })
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Failed');
    }

    status.innerHTML = `<div class="status-msg status-success">Tab "${tabName}" created! <a href="https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}" target="_blank" style="color:var(--gold);">Open Sheet</a></div>`;
  } catch (err) {
    status.innerHTML = `<div class="status-msg status-error">Error: ${err.message}</div>`;
  }
});

// --- Preview Table ---
function showPreview(rows) {
  Object.values(sections).forEach(s => s.classList.remove('active'));
  sections.preview.classList.add('active');

  const headers = ['day', 'time_start', 'time_end', 'groups', 'location', 'note', 'flag'];
  const headerLabels = ['Day', 'Start', 'End', 'Groups', 'Location', 'Note', 'Flag'];

  let html = '<div class="preview-table-wrap"><table class="preview-table"><thead><tr>';
  headerLabels.forEach(h => { html += `<th>${h}</th>`; });
  html += '<th></th></tr></thead><tbody>';

  rows.forEach((row, i) => {
    const loc = (row.location || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
    const isUnrecognized = row.location && !knownLocations[loc] && !knownLocations[row.location];
    html += `<tr data-idx="${i}" class="${isUnrecognized ? 'row-unrecognized' : ''}">`;
    headers.forEach(h => {
      html += `<td contenteditable="true" data-field="${h}">${row[h] || ''}</td>`;
    });
    html += `<td style="white-space:nowrap;"><button class="btn-secondary" style="font-size:11px;padding:4px 8px;min-height:auto;" onclick="this.closest('tr').remove()">&#x2715;</button></td>`;
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  html += '<button class="btn-secondary" id="btnAddRow" style="margin-top:8px;">+ Add Row</button>';

  if (parsedDuties.length > 0) {
    html += `
      <details style="margin-top:20px;">
        <summary style="cursor:pointer;color:var(--text-secondary);font-size:14px;padding:8px 0;">
          Staff Duties (${parsedDuties.length} rows) — click to expand
        </summary>
        <div class="preview-table-wrap" style="margin-top:8px;">
          <table class="preview-table">
            <thead><tr><th>Day</th><th>Time Block</th><th>Zone</th><th>Staff</th><th>Notes</th></tr></thead>
            <tbody>
              ${parsedDuties.map(d => `
                <tr>
                  <td>${d.day || ''}</td>
                  <td>${d.time_block || ''}</td>
                  <td>${d.zone || ''}</td>
                  <td>${d.staff_assigned || ''}</td>
                  <td>${d.notes || ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </details>`;
  }

  document.getElementById('previewTableWrap').innerHTML = html;

  document.getElementById('btnAddRow').addEventListener('click', () => {
    const tbody = document.querySelector('.preview-table tbody');
    const tr = document.createElement('tr');
    headers.forEach(h => {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.dataset.field = h;
      tr.appendChild(td);
    });
    const actionTd = document.createElement('td');
    actionTd.style.whiteSpace = 'nowrap';
    actionTd.innerHTML = '<button class="btn-secondary" style="font-size:11px;padding:4px 8px;min-height:auto;" onclick="this.closest(\'tr\').remove()">&#x2715;</button>';
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
    tr.querySelector('td').focus();
  });
}

// --- Push to Sheet ---
document.getElementById('btnPushToSheet').addEventListener('click', async () => {
  const tabName = document.getElementById('targetTabName').value.trim();
  const status = document.getElementById('pushStatus');

  if (!tabName) {
    status.innerHTML = '<div class="status-msg status-error">Enter a tab name</div>';
    return;
  }

  const tableRows = document.querySelectorAll('.preview-table tbody tr');
  const rows = [];
  tableRows.forEach(tr => {
    const row = {};
    tr.querySelectorAll('td[data-field]').forEach(td => {
      row[td.dataset.field] = td.textContent.trim();
    });
    if (Object.values(row).some(v => v)) rows.push(row);
  });

  if (rows.length === 0) {
    status.innerHTML = '<div class="status-msg status-error">No data to push</div>';
    return;
  }

  const mode = confirm(`Replace existing "${tabName}" data?\n\nOK = Replace\nCancel = Create new tab`) ? 'replace' : 'new';
  const finalTabName = mode === 'new' ? `${tabName} (new)` : tabName;

  status.innerHTML = '<div class="status-msg"><span class="spinner"></span> Writing to Google Sheet...</div>';

  try {
    const resp = await fetch(`${CONFIG.WORKER_URL}/write-sheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, sheetId: CONFIG.SHEET_ID, tabName: finalTabName, rows, mode })
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Write failed');
    }

    if (parsedDuties.length > 0) {
      await fetch(`${CONFIG.WORKER_URL}/write-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          sheetId: CONFIG.SHEET_ID,
          tabName: 'Duties',
          rows: parsedDuties,
          mode: 'append',
          headers: ['day', 'time_block', 'zone', 'staff_assigned', 'notes']
        })
      });
    }

    status.innerHTML = `<div class="status-msg status-success">Schedule written to "${finalTabName}"!${parsedDuties.length > 0 ? ' Duties updated.' : ''} <a href="https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}" target="_blank" style="color:var(--gold);">Open Sheet</a></div>`;
  } catch (err) {
    status.innerHTML = `<div class="status-msg status-error">Error: ${err.message}</div>`;
  }
});
