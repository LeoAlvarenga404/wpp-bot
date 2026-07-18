/**
 * Pure helper: returns true when `now` falls within the quiet-hours window
 * [startHour, endHour) interpreted in the given IANA timezone.
 *
 * Supports wrap-around windows (e.g. 23 -> 7 = 23:00 .. 06:59 local).
 * Equal startHour and endHour means "always quiet".
 */
export function isQuietHours(
  now: Date,
  startHour: number,
  endHour: number,
  tz: string = 'America/Sao_Paulo',
): boolean {
  const hourStr = now.toLocaleString('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: tz,
  });
  // 'en-US' returns "24" at midnight in some Node/ICU builds — normalize to 0.
  let hour = Number(hourStr);
  if (!Number.isFinite(hour)) return false;
  if (hour === 24) hour = 0;

  const start = ((startHour % 24) + 24) % 24;
  const end = ((endHour % 24) + 24) % 24;

  if (start === end) return true;

  // Non-wrapping window, e.g. start=1, end=5 -> quiet at 1,2,3,4
  if (start < end) {
    return hour >= start && hour < end;
  }

  // Wrap-around, e.g. start=23, end=7 -> quiet at 23,0,1,2,3,4,5,6
  return hour >= start || hour < end;
}

/**
 * Milliseconds from `now` until the quiet window ends (the first instant of
 * `endHour` local time). 0 when `now` is not inside the window. Used by the
 * send worker to park non-urgent jobs during quiet hours (issue #7).
 */
export function msUntilQuietEnd(
  now: Date,
  startHour: number,
  endHour: number,
  tz: string = 'America/Sao_Paulo',
): number {
  if (!isQuietHours(now, startHour, endHour, tz)) return 0;

  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
    timeZone: tz,
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0; // same ICU quirk isQuietHours normalizes

  const end = ((endHour % 24) + 24) % 24;
  let hoursAhead = end - hour;
  if (hoursAhead <= 0) hoursAhead += 24;
  return hoursAhead * 3_600_000 - get('minute') * 60_000 - get('second') * 1000;
}
