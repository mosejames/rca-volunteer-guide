// js/schedule.js — Schedule filtering, dedup, and time logic

export function filterByLetters(schedule, letters) {
  const upperLetters = letters.map(l => l.toUpperCase());
  return schedule.filter(entry => {
    if (entry.groupList.includes('ALL')) return true;
    return entry.groupList.some(g => upperLetters.includes(g));
  });
}

export function filterByDay(schedule, day) {
  return schedule.filter(entry => entry.day === day);
}

export function dedup(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const key = `${entry.day}|${entry.timeStart}|${entry.timeEnd}|${entry.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getAvailableDays(schedule) {
  return [...new Set(schedule.map(e => e.day))];
}

export function parseTime(timeStr) {
  if (!timeStr) return -1;
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0], 10);
  const mins = parseInt(parts[1], 10) || 0;
  return hours * 60 + mins;
}

export function findCurrentBlock(schedule, day, nowTimeStr) {
  const now = parseTime(nowTimeStr);
  const dayEntries = schedule.filter(e => e.day === day);

  for (const entry of dayEntries) {
    const start = parseTime(entry.timeStart);
    const end = parseTime(entry.timeEnd);
    if (now >= start && now < end) return entry;
  }
  return null;
}

export function findNextBlock(schedule, day, nowTimeStr) {
  const now = parseTime(nowTimeStr);
  const dayEntries = schedule.filter(e => e.day === day);

  let next = null;
  let nextStart = Infinity;

  for (const entry of dayEntries) {
    const start = parseTime(entry.timeStart);
    if (start > now && start < nextStart) {
      next = entry;
      nextStart = start;
    }
  }
  return next;
}

export function getCurrentTimeStr(date = new Date()) {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function minutesUntil(timeStr, nowTimeStr) {
  return parseTime(timeStr) - parseTime(nowTimeStr);
}

export function detectDay(availableDays, now = new Date()) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const todayStr = `${dayNames[now.getDay()]} ${monthNames[now.getMonth()]} ${now.getDate()}`;

  if (availableDays.includes(todayStr)) return todayStr;
  return availableDays[0] || null;
}

export function resolveLocation(locationKey, locations) {
  if (locations[locationKey]) return locations[locationKey];

  const normalized = locationKey.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  if (locations[normalized]) return locations[normalized];

  return { display_name: locationKey, hint: '' };
}
