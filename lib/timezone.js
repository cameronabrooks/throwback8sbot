// Pure-JS timezone math (no moment/luxon dependency) used by match scheduling.
// Handles DST correctly by asking Intl what a zone's offset actually is on a given date.

const TZ_ALIASES = {
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles'
};

const LEAGUE_TZ = 'America/New_York';

function resolveTimezone(input) {
  if (!input) return LEAGUE_TZ;
  const key = input.trim().toLowerCase();
  return TZ_ALIASES[key] || (key.includes('/') ? input.trim() : LEAGUE_TZ);
}

// Offset in minutes EAST of UTC for `ianaZone` at the instant `utcGuessMs` (approx).
function offsetMinutesAt(ianaZone, utcGuessMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = dtf.formatToParts(new Date(utcGuessMs));
  const get = type => Number(parts.find(p => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (asUtc - utcGuessMs) / 60000;
}

// Converts a local wall-clock time in `ianaZone` to a UTC epoch (ms).
function zonedTimeToUtc(year, month, day, hour, minute, ianaZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const offset = offsetMinutesAt(ianaZone, guess);
    guess = Date.UTC(year, month - 1, day, hour, minute, 0) - offset * 60000;
  }
  return guess;
}

// Next occurrence (>= fromMs) of `weekday` (0=Sun..6=Sat) at hour:minute local time in `ianaZone`.
function nextWeekdayAt(weekday, hour, minute, ianaZone, fromMs = Date.now()) {
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const candidateUtcGuess = fromMs + dayOffset * 86400000;
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: ianaZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = dtf.formatToParts(candidateUtcGuess);
    const get = type => parts.find(p => p.type === type).value;
    const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    if (wdMap[get('weekday')] !== weekday) continue;
    const y = Number(get('year')), m = Number(get('month')), d = Number(get('day'));
    const candidate = zonedTimeToUtc(y, m, d, hour, minute, ianaZone);
    if (candidate >= fromMs) return candidate;
  }
  throw new Error('nextWeekdayAt: could not resolve a matching day within 8 days');
}

module.exports = { LEAGUE_TZ, resolveTimezone, zonedTimeToUtc, nextWeekdayAt, offsetMinutesAt };
