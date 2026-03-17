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

// --- Init ---
async function init() {
  const saved = localStorage.getItem('rca_letters');
  if (saved) {
    letterInput.value = saved;
    selectedLetters = saved.toUpperCase().split('').filter(c => c >= 'A' && c <= 'L');
  }

  await loadData();
  startPolling();
  setInterval(updateTimeDisplay, 15000);
}

async function loadData() {
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
  const now = new Date();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const candidates = [];
  for (let offset = -3; offset <= 7; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const dayOfWeek = d.getDay();
    if (dayOfWeek === 4 || dayOfWeek === 5) {
      const tabName = `${dayNames[dayOfWeek]} ${monthNames[d.getMonth()]} ${d.getDate()}`;
      candidates.push(tabName);
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
letterInput.addEventListener('input', () => {
  const val = letterInput.value.toUpperCase().replace(/[^A-L]/g, '');
  letterInput.value = val;
  selectedLetters = val.split('').filter(c => c >= 'A' && c <= 'L');
  localStorage.setItem('rca_letters', val);
  render();
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

// --- Start ---
init();
