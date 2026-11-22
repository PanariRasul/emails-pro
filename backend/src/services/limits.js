// Effective sending limits. The lowest applicable limit always wins:
// system default/max -> employee policy -> account admin cap -> warm-up -> account health -> campaign speed.

const DAY_MS = 86_400_000;

export function employeeLimits(user, settings) {
  const hourly = Math.max(0, user.hourlyLimit ?? settings.defaultHourlyLimit);
  const daily = Math.max(0, Math.min(user.dailyLimit ?? settings.defaultDailyLimit, settings.maxEmployeeDailyLimit));
  const accounts = Math.max(0, Math.min(user.accountLimit ?? settings.defaultAccountLimit, settings.maxAccountLimit));
  return { hourly, daily, accounts };
}

/**
 * Warm-up as a share of the account's normal limits. Day 1 = start % (default 20%), rising evenly
 * to 100% on the last day (default day 10). Returns null when warm-up is off or finished.
 *   e.g. normal limit 500/day, 20% over 10 days → 100, 144, 189, 233, 278, 322, 367, 411, 456, 500
 */
export function warmupProgress(account, settings, now = new Date()) {
  if (!account.warmupEnabled || !account.warmupStartedAt) return null;
  const totalDays = Math.min(90, Math.max(1, account.warmupDays ?? settings.warmupDays ?? 10));
  const startPct = Math.min(100, Math.max(1, account.warmupStartPercent ?? settings.warmupStartPercent ?? 20));
  const day = Math.max(0, Math.floor((now - new Date(account.warmupStartedAt)) / DAY_MS)); // 0 = first day
  if (day >= totalDays - 1 || startPct >= 100) return null; // finished: full limits apply
  const factor = (startPct + (100 - startPct) * (day / (totalDays - 1))) / 100;
  return { factor, day: day + 1, totalDays, percent: Math.round(factor * 100) };
}

export function accountLimits(account, owner, settings, now = new Date()) {
  const emp = employeeLimits(owner, settings);
  let hourly = Math.min(account.maxHourly ?? emp.hourly, emp.hourly);
  let daily = Math.min(account.maxDaily ?? emp.daily, emp.daily);
  const fullDaily = daily;
  const warm = warmupProgress(account, settings, now);
  if (warm) {
    // Both the daily and the hourly limit are scaled down while warming up.
    daily = Math.max(1, Math.floor(daily * warm.factor));
    hourly = Math.max(1, Math.floor(hourly * warm.factor));
  }
  // Degrade speed for accounts showing repeated connection problems.
  if (account.consecutiveFailures >= 3) hourly = Math.max(1, Math.floor(hourly / 2));
  // Hourly can never exceed daily.
  hourly = Math.min(hourly, daily);
  return {
    hourly, daily, fullDaily, employeeDaily: emp.daily,
    warmupActive: Boolean(warm), // false once warm-up has finished (fixes the badge staying on)
    warmup: warm ? { day: warm.day, totalDays: warm.totalDays, percent: warm.percent } : null,
  };
}

/** Milliseconds between sends for a given hourly rate. */
export function intervalMs(perHour) {
  if (!perHour || perHour <= 0) return Infinity;
  return Math.ceil(3_600_000 / perHour);
}

export function hourWindow(now = new Date()) {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function dayWindow(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function speedOptions(maxHourly) {
  const opts = [5, 10, 20, 30, 60, 90, 120, 180, 240].filter((n) => n <= maxHourly);
  if (!opts.includes(maxHourly) && maxHourly > 0) opts.push(maxHourly);
  return opts.map((n) => ({ perHour: n, everySeconds: Math.round(3600 / n) }));
}