// Small POSIX cron reader for GitHub Actions schedules (5 fields, UTC): counts real run times over a week.
// Supports *, lists, ranges, steps (*/n, a-b/n, a/n) and month/day names. Day-of-month and day-of-week follow cron's
// rule: when both are restricted, a day matches if either matches.
const NAMES = { month: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], dow: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] };
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(text, i) {
  const [lo, hi] = RANGES[i];
  const names = i === 3 ? NAMES.month : i === 4 ? NAMES.dow : null;
  const num = (s) => {
    const u = s.toUpperCase();
    if (names && names.includes(u)) return names.indexOf(u) + (i === 3 ? 1 : 0);
    if (!/^\d+$/.test(s)) throw new Error(`bad value "${s}"`);
    return Number(s);
  };
  const set = new Set();
  for (const part of text.split(",")) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad field "${text}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error("step must be 1 or more");
    let a, b;
    if (m[1] === "*") { a = lo; b = hi; }
    else if (m[1].includes("-")) { const [x, y] = m[1].split("-"); a = num(x); b = num(y); }
    else { a = num(m[1]); b = m[2] ? hi : a; }
    if (a < lo || b > hi || a > b) throw new Error(`"${part}" is out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
  }
  return set;
}

export function parseCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) throw new Error("a cron schedule has 5 fields (minute hour day-of-month month day-of-week)");
  const sets = f.map(field);
  return { min: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domStar: f[2] === "*", dowStar: f[4] === "*" };
}

// Runs in the 7 days starting from a fixed Monday (2025-01-06 UTC), plus the busiest single day.
export function cronRuns(expr, start = Date.UTC(2025, 0, 6)) {
  const c = parseCron(expr);
  const dayRuns = [];
  for (let d = 0; d < 7; d++) {
    const t = new Date(start + d * 86400000);
    const domOk = c.dom.has(t.getUTCDate()), dowOk = c.dow.has(t.getUTCDay());
    const dayOk = c.month.has(t.getUTCMonth() + 1) && (c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk);
    dayRuns.push(dayOk ? c.min.size * c.hour.size : 0);
  }
  return { perWeek: dayRuns.reduce((a, b) => a + b, 0), maxPerDay: Math.max(...dayRuns) };
}
