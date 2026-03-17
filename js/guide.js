// js/guide.js — Main volunteer guide logic

import { CONFIG } from '../config.js';
import { fetchSchedule, fetchLocations, parseCSV, parseScheduleRows } from './sheets.js';
import {
  filterByLetters, filterByDay, dedup, findCurrentBlock, findNextBlock,
  getAvailableDays, detectDay, getCurrentTimeStr, minutesUntil, resolveLocation
} from './schedule.js';

// --- State ---
let allSchedule = [];
let locations = {};
let currentDay = null;
let selectedLetters = [];
let viewMode = 'now';
let lastFetchTime = null;
let pollTimer = null;
let previousDataHash = '';

// --- DOM refs ---
const letterInput = document.getElementById('letterInput');
const selectedDisplay = document.getElementById('selectedDisplay');
const letterPicker = document.getElementById('letterPicker');
const syncStatus = document.getElementById('syncStatus');
const btnRefresh = document.getElementById('btnRefresh');
const btnPrint = document.getElementById('btnPrint');
const bannerArea = document.getElementById('bannerArea');
const dayToggle = document.getElementById('dayToggle');
const heroSection = document.getElementById('heroSection');
const viewToggleEl = document.getElementById('viewToggle');
const lookupToggle = document.getElementById('lookupToggle');
const lookupPanel = document.getElementById('lookupPanel');
const lookupInput = document.getElementById('lookupInput');
const lookupResult = document.getElementById('lookupResult');
const timeline = document.getElementById('timeline');
const clockBar = document.getElementById('clockBar');

// --- Init ---
async function init() {
  updateClock();
  setInterval(updateClock, 1000);

  const saved = localStorage.getItem('rca_letters');
  if (saved) {
    letterInput.value = saved;
    selectedLetters = saved.toUpperCase().split('').filter(c => c >= 'A' && c <= 'L');
    selectedDisplay.textContent = saved;
    // Restore button states
    selectedLetters.forEach(letter => {
      const btn = letterPicker.querySelector(`[data-letter="${letter}"]`);
      if (btn) btn.classList.add('selected');
    });
  }

  await loadData();
  startPolling();
  setInterval(updateTimeDisplay, 15000);
}

async function loadData() {
  // Demo mode: generate schedule relative to current time
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('demo') === 'true') {
    const demo = generateDemoData();
    allSchedule = demo.schedule;
    locations = demo.locations;
    lastFetchTime = Date.now();
    previousDataHash = JSON.stringify(allSchedule);
    const days = getAvailableDays(allSchedule);
    currentDay = days[0];
    setupDayToggle(days);
    render();
    updateSyncStatus();
    return;
  }

  try {
    bannerArea.innerHTML = '';
    const [scheduleRows, locs] = await Promise.all([
      fetchAllDayTabs(),
      fetchLocations()
    ]);

    allSchedule = scheduleRows;
    locations = locs;
    lastFetchTime = Date.now();
    previousDataHash = JSON.stringify(allSchedule);

    localStorage.setItem('rca_schedule', JSON.stringify(allSchedule));
    localStorage.setItem('rca_locations', JSON.stringify(locations));
    localStorage.setItem('rca_fetch_time', String(lastFetchTime));

    const days = getAvailableDays(allSchedule);
    currentDay = detectDay(days);
    setupDayToggle(days);
    render();
    updateSyncStatus();
  } catch (err) {
    console.error('Load failed:', err);
    const cached = localStorage.getItem('rca_schedule');
    if (cached) {
      allSchedule = JSON.parse(cached);
      locations = JSON.parse(localStorage.getItem('rca_locations') || '{}');
      lastFetchTime = parseInt(localStorage.getItem('rca_fetch_time') || '0', 10);
      const days = getAvailableDays(allSchedule);
      currentDay = detectDay(days);
      setupDayToggle(days);
      showBanner('stale', `Showing cached schedule from ${new Date(lastFetchTime).toLocaleTimeString()}. Reconnect for updates.`);
      render();
    } else if (err.code === 'EMPTY_SCHEDULE') {
      showBanner('warning', err.message);
    } else {
      showBanner('error', 'Unable to load schedule. Check your connection and try again.');
    }
  }
}

async function fetchAllDayTabs() {
  // Check for ?tab= URL parameter to force specific tab(s)
  const urlParams = new URLSearchParams(window.location.search);
  const forcedTabs = urlParams.get('tab');

  const now = new Date();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const candidates = [];

  if (forcedTabs) {
    // Support comma-separated tab names: ?tab=Thu Mar 12,Fri Mar 13
    forcedTabs.split(',').forEach(t => candidates.push(t.trim()));
  } else {
    for (let offset = -3; offset <= 7; offset++) {
      const d = new Date(now);
      d.setDate(d.getDate() + offset);
      const dayOfWeek = d.getDay();
      if (dayOfWeek === 4 || dayOfWeek === 5) {
        const tabName = `${dayNames[dayOfWeek]} ${monthNames[d.getMonth()]} ${d.getDate()}`;
        candidates.push(tabName);
      }
    }
  }

  const results = [];
  for (const tab of candidates) {
    try {
      const rows = await fetchSchedule(tab);
      if (rows.length > 0) results.push(...rows);
    } catch {
      // Tab doesn't exist, skip
    }
  }

  if (results.length === 0) {
    const err = new Error('No schedule data found for today. Contact the mastermind.');
    err.code = 'EMPTY_SCHEDULE';
    throw err;
  }

  return results;
}

// --- Rendering ---
function render() {
  if (selectedLetters.length === 0) {
    heroSection.innerHTML = `
      <div class="hero-card now">
        <div class="hero-label">Welcome</div>
        <div class="hero-location">Enter your letter assignment above</div>
        <div class="hero-hint">Type the letter(s) on your badge (A-L)</div>
      </div>`;
    timeline.innerHTML = '';
    viewToggleEl.style.display = 'none';
    return;
  }

  const daySchedule = filterByDay(allSchedule, currentDay);
  let mySchedule = filterByLetters(daySchedule, selectedLetters);
  mySchedule = dedup(mySchedule);

  mySchedule.sort((a, b) => {
    const ta = a.timeStart.split(':').map(Number);
    const tb = b.timeStart.split(':').map(Number);
    return (ta[0] * 60 + (ta[1] || 0)) - (tb[0] * 60 + (tb[1] || 0));
  });

  if (mySchedule.length === 0) {
    heroSection.innerHTML = `
      <div class="hero-card now">
        <div class="hero-label">Not found</div>
        <div class="hero-location">No schedule found for group ${selectedLetters.join('')}</div>
        <div class="hero-hint">Check your letter assignment.</div>
      </div>`;
    timeline.innerHTML = '';
    viewToggleEl.style.display = 'none';
    return;
  }

  viewToggleEl.style.display = 'flex';

  if (viewMode === 'now') {
    renderNowView(mySchedule);
  }
  renderTimeline(mySchedule);
  timeline.style.display = viewMode === 'timeline' ? 'block' : 'none';
}

function renderNowView(mySchedule) {
  const nowStr = getCurrentTimeStr();
  const current = findCurrentBlock(mySchedule, currentDay, nowStr);
  const next = findNextBlock(mySchedule, currentDay, nowStr);

  let html = '';

  if (current) {
    const loc = resolveLocation(current.location, locations);
    html += `
      <div class="hero-card now">
        <div class="hero-label">Now ${current.timeStart} - ${current.timeEnd}</div>
        <div class="hero-location">${loc.display_name}${renderFlag(current.flag)}</div>
        ${loc.hint ? `<div class="hero-hint">${loc.hint}</div>` : ''}
        ${current.note ? `<div class="hero-hint" style="font-style:italic">${current.note}</div>` : ''}
      </div>`;
  } else {
    html += `
      <div class="hero-card now">
        <div class="hero-label">Now</div>
        <div class="hero-location">No active session</div>
        <div class="hero-hint">Check the full timeline for today's schedule</div>
      </div>`;
  }

  if (next) {
    const loc = resolveLocation(next.location, locations);
    const mins = minutesUntil(next.timeStart, nowStr);
    html += `
      <div class="hero-card next">
        <div class="hero-label">Next ${mins > 0 ? `in ${mins} min` : 'up'}</div>
        <div class="hero-location">${loc.display_name}${renderFlag(next.flag)}</div>
        ${loc.hint ? `<div class="hero-hint">${loc.hint}</div>` : ''}
        <div class="hero-time">${next.timeStart} - ${next.timeEnd}</div>
      </div>`;
  }

  heroSection.innerHTML = html;
}

function renderTimeline(mySchedule) {
  const nowStr = getCurrentTimeStr();
  const nowMins = nowStr.split(':').map(Number);
  const nowTotal = nowMins[0] * 60 + (nowMins[1] || 0);

  let html = '';
  for (const entry of mySchedule) {
    const startMins = entry.timeStart.split(':').map(Number);
    const startTotal = startMins[0] * 60 + (startMins[1] || 0);
    const endMins = entry.timeEnd.split(':').map(Number);
    const endTotal = endMins[0] * 60 + (endMins[1] || 0);

    let stateClass = '';
    if (nowTotal >= endTotal) stateClass = 'past';
    else if (nowTotal >= startTotal && nowTotal < endTotal) stateClass = 'current';

    const loc = resolveLocation(entry.location, locations);

    html += `
      <div class="timeline-block ${stateClass}" data-key="${entry.timeStart}-${entry.location}">
        <div class="timeline-time">${entry.timeStart} - ${entry.timeEnd}</div>
        <div style="flex:1">
          <div class="timeline-location">${loc.display_name}${renderFlag(entry.flag)}</div>
          ${loc.hint ? `<div class="timeline-hint">${loc.hint}</div>` : ''}
          ${entry.note ? `<div class="timeline-note">${entry.note}</div>` : ''}
        </div>
      </div>`;
  }
  timeline.innerHTML = html;
}

function renderFlag(flag) {
  if (!flag) return '';
  const labels = { split: 'Split', merge: 'Merge', all: 'All groups' };
  return `<span class="flag flag-${flag}">${labels[flag] || flag}</span>`;
}

// --- Day Toggle ---
function setupDayToggle(days) {
  if (days.length <= 1) {
    dayToggle.style.display = 'none';
    return;
  }
  dayToggle.style.display = 'flex';
  dayToggle.innerHTML = days.map(d =>
    `<button class="day-btn ${d === currentDay ? 'active' : ''}" data-day="${d}">${d}</button>`
  ).join('');

  dayToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.day-btn');
    if (!btn) return;
    currentDay = btn.dataset.day;
    dayToggle.querySelectorAll('.day-btn').forEach(b => b.classList.toggle('active', b.dataset.day === currentDay));
    render();
  });
}

// --- Sync / Polling ---
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const rows = await fetchAllDayTabs();
      const newHash = JSON.stringify(rows);
      if (newHash !== previousDataHash) {
        allSchedule = rows;
        previousDataHash = newHash;
        localStorage.setItem('rca_schedule', JSON.stringify(allSchedule));
      }
      lastFetchTime = Date.now();
      localStorage.setItem('rca_fetch_time', String(lastFetchTime));
      bannerArea.innerHTML = '';
      render();
      updateSyncStatus();
    } catch {
      updateSyncStatus();
    }
  }, CONFIG.POLL_INTERVAL);
}

function updateClock() {
  const now = new Date();
  const h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const timeStr = `${h12}:${m} ${ampm}`;

  // Find next block for countdown
  const nowTimeStr = getCurrentTimeStr(now);
  let countdownHtml = '';

  if (selectedLetters.length > 0 && currentDay && allSchedule.length > 0) {
    const daySchedule = filterByDay(allSchedule, currentDay);
    let mySchedule = filterByLetters(daySchedule, selectedLetters);
    mySchedule = dedup(mySchedule);

    const current = findCurrentBlock(mySchedule, currentDay, nowTimeStr);
    const next = findNextBlock(mySchedule, currentDay, nowTimeStr);

    if (current && next) {
      const mins = minutesUntil(next.timeStart, nowTimeStr);
      const loc = resolveLocation(next.location, locations);
      countdownHtml = `
        <div style="text-align:center;">
          <div class="clock-countdown-label">Next up in</div>
          <div class="clock-countdown">${mins} min — ${loc.display_name}</div>
        </div>`;
    } else if (next && !current) {
      const mins = minutesUntil(next.timeStart, nowTimeStr);
      const loc = resolveLocation(next.location, locations);
      countdownHtml = `
        <div style="text-align:center;">
          <div class="clock-countdown-label">Starting in</div>
          <div class="clock-countdown">${mins} min — ${loc.display_name}</div>
        </div>`;
    } else if (current && !next) {
      countdownHtml = `
        <div style="text-align:center;">
          <div class="clock-countdown-label">Last session</div>
          <div class="clock-countdown">Ends at ${current.timeEnd}</div>
        </div>`;
    }
  }

  clockBar.innerHTML = `
    <div style="text-align:center;">
      <div class="clock-time">${timeStr}</div>
    </div>
    ${countdownHtml}`;
}

function updateSyncStatus() {
  if (!lastFetchTime) { syncStatus.textContent = 'Loading...'; return; }
  const ago = Math.round((Date.now() - lastFetchTime) / 1000);
  syncStatus.textContent = `Updated ${ago}s ago`;
  syncStatus.className = ago > 120 ? 'sync-status stale' : 'sync-status';
}

function updateTimeDisplay() {
  updateSyncStatus();
  if (viewMode === 'now' && selectedLetters.length > 0) render();
}

function showBanner(type, message) {
  const retryBtn = type === 'error' ? ' <button onclick="location.reload()" style="background:var(--error-red);color:white;border:none;border-radius:4px;padding:6px 12px;margin-left:8px;cursor:pointer;min-height:44px;">Retry</button>' : '';
  bannerArea.innerHTML = `<div class="banner banner-${type}">${message}${retryBtn}</div>`;
}

// --- Event Listeners ---

// Letter picker buttons
letterPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('.letter-btn');
  if (!btn) return;
  const letter = btn.dataset.letter;

  btn.classList.toggle('selected');

  // Rebuild selected letters from active buttons
  selectedLetters = [];
  letterPicker.querySelectorAll('.letter-btn.selected').forEach(b => {
    selectedLetters.push(b.dataset.letter);
  });

  const val = selectedLetters.join('');
  letterInput.value = val;
  selectedDisplay.textContent = val || '';
  localStorage.setItem('rca_letters', val);
  render();
  updateClock();
});

// Clear button
document.getElementById('letterClear').addEventListener('click', () => {
  letterPicker.querySelectorAll('.letter-btn.selected').forEach(b => b.classList.remove('selected'));
  selectedLetters = [];
  letterInput.value = '';
  selectedDisplay.textContent = '';
  localStorage.removeItem('rca_letters');
  render();
  updateClock();
});

viewToggleEl.addEventListener('click', () => {
  viewMode = viewMode === 'now' ? 'timeline' : 'now';
  viewToggleEl.textContent = viewMode === 'now' ? 'View full timeline' : 'Back to now view';
  heroSection.style.display = viewMode === 'now' ? 'block' : 'none';
  timeline.style.display = viewMode === 'timeline' ? 'block' : 'none';
  render();
});

btnRefresh.addEventListener('click', () => {
  syncStatus.textContent = 'Refreshing...';
  loadData();
});

btnPrint.addEventListener('click', () => {
  const wasMode = viewMode;
  viewMode = 'timeline';
  render();
  timeline.style.display = 'block';
  heroSection.style.display = 'none';
  window.print();
  viewMode = wasMode;
  heroSection.style.display = viewMode === 'now' ? 'block' : 'none';
  timeline.style.display = viewMode === 'timeline' ? 'block' : 'none';
});

lookupToggle.addEventListener('click', () => {
  lookupPanel.classList.toggle('open');
  if (lookupPanel.classList.contains('open')) lookupInput.focus();
});

lookupInput.addEventListener('input', () => {
  const letter = lookupInput.value.toUpperCase().replace(/[^A-L]/g, '');
  lookupInput.value = letter;
  if (!letter) { lookupResult.innerHTML = ''; return; }

  const nowStr = getCurrentTimeStr();
  const daySchedule = filterByDay(allSchedule, currentDay);
  const forLetter = filterByLetters(daySchedule, [letter]);
  const current = findCurrentBlock(forLetter, currentDay, nowStr);
  const next = findNextBlock(forLetter, currentDay, nowStr);

  let html = '';
  if (current) {
    const loc = resolveLocation(current.location, locations);
    html += `<div style="margin-top:8px;"><strong>NOW:</strong> ${loc.display_name}${loc.hint ? ` <span style="color:var(--text-secondary)">(${loc.hint})</span>` : ''}</div>`;
  } else {
    html += `<div style="margin-top:8px;color:var(--text-muted)">No active session for group ${letter}</div>`;
  }
  if (next) {
    const loc = resolveLocation(next.location, locations);
    const mins = minutesUntil(next.timeStart, nowStr);
    html += `<div style="margin-top:4px;"><strong>NEXT:</strong> ${loc.display_name} ${mins > 0 ? `(in ${mins} min)` : ''}</div>`;
  }
  lookupResult.innerHTML = html;
});

// --- Demo Mode ---
function generateDemoData() {
  const now = new Date();
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const day = `${dayNames[now.getDay()]} ${monthNames[now.getMonth()]} ${now.getDate()}`;

  // Start 15 minutes ago so there's always an active block
  const startMin = now.getHours() * 60 + now.getMinutes() - 15;

  const fmt = (totalMin) => {
    const hh = Math.floor(totalMin / 60) % 24;
    const mm = totalMin % 60;
    return `${hh}:${String(mm).padStart(2, '0')}`;
  };

  const blocks = [
    // Opening - everyone together
    { offset: 0,   dur: 15, groups: 'ALL',  location: 'Courtyard',  note: 'Arrivals',  flag: 'all' },
    { offset: 15,  dur: 15, groups: 'ALL',  location: 'Houses',     note: '',          flag: 'all' },
    { offset: 30,  dur: 20, groups: 'ALL',  location: 'Auditorium', note: 'Cheers',    flag: 'all' },

    // First rotation - 4 groups in different rooms
    { offset: 50,  dur: 25, groups: 'AB',   location: '5a',         note: '',          flag: '' },
    { offset: 50,  dur: 25, groups: 'CD',   location: '4th',        note: '',          flag: '' },
    { offset: 50,  dur: 25, groups: 'EFGH', location: '5aa',        note: '',          flag: '' },
    { offset: 50,  dur: 25, groups: 'IJKL', location: '7a',         note: '',          flag: '' },

    // Second rotation - groups swap rooms
    { offset: 75,  dur: 25, groups: 'AB',   location: '4th',        note: '',          flag: '' },
    { offset: 75,  dur: 25, groups: 'CD',   location: '6th',        note: '',          flag: '' },
    { offset: 75,  dur: 25, groups: 'EFGH', location: '7a',         note: '',          flag: '' },
    { offset: 75,  dur: 25, groups: 'IJKL', location: '8th',        note: '',          flag: '' },

    // Third rotation - different split
    { offset: 100, dur: 20, groups: 'ABCD', location: '5aa',        note: '',          flag: '' },
    { offset: 100, dur: 20, groups: 'EF',   location: '8th',        note: '',          flag: '' },
    { offset: 100, dur: 20, groups: 'GH',   location: 'Great Hall', note: '',          flag: '' },
    { offset: 100, dur: 20, groups: 'IJ',   location: '7aa',        note: '',          flag: '' },
    { offset: 100, dur: 20, groups: 'KL',   location: '6th',        note: '',          flag: '' },

    // Split within groups
    { offset: 120, dur: 20, groups: 'AB',   location: '6th',        note: 'AB splits from ABCD', flag: 'split' },
    { offset: 120, dur: 20, groups: 'CD',   location: '5a',         note: 'CD splits from ABCD', flag: 'split' },
    { offset: 120, dur: 20, groups: 'EFGH', location: '4th',        note: '',          flag: '' },
    { offset: 120, dur: 20, groups: 'IJ',   location: 'Great Hall', note: '',          flag: '' },
    { offset: 120, dur: 20, groups: 'KL',   location: 'Rotunda',    note: '',          flag: '' },

    // All together - midday
    { offset: 140, dur: 25, groups: 'ALL',  location: 'Auditorium', note: '',          flag: 'all' },
    { offset: 165, dur: 30, groups: 'ALL',  location: 'LUNCH',      note: '',          flag: 'all' },

    // Afternoon - different combos
    { offset: 195, dur: 25, groups: 'ABEF', location: '5aa',        note: '',          flag: '' },
    { offset: 195, dur: 25, groups: 'CDGH', location: '8a',         note: '',          flag: '' },
    { offset: 195, dur: 25, groups: 'IJKL', location: '7th',        note: '',          flag: '' },

    { offset: 220, dur: 25, groups: 'ABEF', location: '7th',        note: '',          flag: '' },
    { offset: 220, dur: 25, groups: 'CDGH', location: '5aa',        note: '',          flag: '' },
    { offset: 220, dur: 25, groups: 'IJ',   location: '4th',        note: '',          flag: '' },
    { offset: 220, dur: 25, groups: 'KL',   location: '8a',         note: '',          flag: '' },

    // Closing - everyone together
    { offset: 245, dur: 20, groups: 'ALL',  location: 'Rotunda',    note: 'Slide Certify', flag: 'all' },
    { offset: 265, dur: 30, groups: 'ALL',  location: 'Courtyard',  note: 'Cheers/Spin',   flag: 'all' },
  ];

  const schedule = [];
  const { expandGroups } = { expandGroups: (g) => {
    if (!g) return [];
    if (g === 'ALL') return ['ALL'];
    return g.split('').filter(c => c >= 'A' && c <= 'Z');
  }};

  blocks.forEach(b => {
    schedule.push({
      day,
      timeStart: fmt(startMin + b.offset),
      timeEnd: fmt(startMin + b.offset + b.dur),
      groups: b.groups,
      groupList: expandGroups(b.groups),
      location: b.location,
      note: b.note,
      flag: b.flag,
    });
  });

  const locations = {
    courtyard:    { display_name: 'Courtyard',       hint: 'outside, main entrance' },
    great_hall:   { display_name: 'Great Hall',      hint: '1st floor, main building' },
    rotunda:      { display_name: 'Rotunda',         hint: 'center of building' },
    auditorium:   { display_name: 'Auditorium',      hint: 'main building' },
    houses:       { display_name: 'Houses',          hint: 'homeroom classrooms' },
    '4th':        { display_name: '4th Grade Room',  hint: 'classroom' },
    '5a':         { display_name: '5a Classroom',    hint: 'classroom' },
    '5aa':        { display_name: '5aa Classroom',   hint: 'classroom' },
    '6th':        { display_name: '6th Grade Room',  hint: 'classroom' },
    '7a':         { display_name: '7a Classroom',    hint: 'classroom' },
    '7aa':        { display_name: '7aa Classroom',   hint: 'classroom' },
    '7th':        { display_name: '7th Grade Room',  hint: 'classroom' },
    '8a':         { display_name: '8a Classroom',    hint: 'classroom' },
    '8th':        { display_name: '8th Grade Room',  hint: 'classroom' },
  };

  return { schedule, locations };
}

// --- Start ---
init();
