import { isQuietHours, msUntilQuietEnd } from './quiet-hours';

/**
 * Build a Date that yields the desired hour when formatted as
 * 'America/Sao_Paulo' (UTC-3 year round, no DST).
 */
function spDateAtHour(hour: number, minute = 0): Date {
  // São Paulo is UTC-3. So local hour H == UTC hour H+3.
  const utcHour = (hour + 3) % 24;
  return new Date(Date.UTC(2026, 4, 13, utcHour, minute, 0));
}

describe('isQuietHours (wrap-around 23 -> 7)', () => {
  it('23:30 is quiet (start of window)', () => {
    expect(isQuietHours(spDateAtHour(23, 30), 23, 7)).toBe(true);
  });

  it('06:59 is quiet (just before end)', () => {
    expect(isQuietHours(spDateAtHour(6, 59), 23, 7)).toBe(true);
  });

  it('07:00 is not quiet (window end is exclusive)', () => {
    expect(isQuietHours(spDateAtHour(7, 0), 23, 7)).toBe(false);
  });

  it('10:00 is not quiet (midday)', () => {
    expect(isQuietHours(spDateAtHour(10, 0), 23, 7)).toBe(false);
  });

  it('00:00 is quiet (inside wrap window)', () => {
    expect(isQuietHours(spDateAtHour(0, 0), 23, 7)).toBe(true);
  });

  it('22:59 is not quiet (just before window starts)', () => {
    expect(isQuietHours(spDateAtHour(22, 59), 23, 7)).toBe(false);
  });
});

describe('isQuietHours (non-wrapping window)', () => {
  it('start < end: hour in range is quiet', () => {
    expect(isQuietHours(spDateAtHour(3, 0), 1, 5)).toBe(true);
  });

  it('start < end: hour at end is not quiet', () => {
    expect(isQuietHours(spDateAtHour(5, 0), 1, 5)).toBe(false);
  });

  it('start < end: hour outside range is not quiet', () => {
    expect(isQuietHours(spDateAtHour(12, 0), 1, 5)).toBe(false);
  });
});

describe('isQuietHours (edge cases)', () => {
  it('start === end means always quiet', () => {
    expect(isQuietHours(spDateAtHour(3, 0), 5, 5)).toBe(true);
    expect(isQuietHours(spDateAtHour(15, 0), 5, 5)).toBe(true);
  });

  it('normalizes negative / >24 hours via modulo', () => {
    // -1 mod 24 = 23, 31 mod 24 = 7 → behaves like (23, 7) wrap-around.
    expect(isQuietHours(spDateAtHour(23, 30), -1, 31)).toBe(true);
    expect(isQuietHours(spDateAtHour(10, 0), -1, 31)).toBe(false);
  });
});

describe('msUntilQuietEnd', () => {
  it('returns 0 outside the quiet window', () => {
    expect(msUntilQuietEnd(spDateAtHour(10, 0), 23, 7)).toBe(0);
  });

  it('counts down to the window end inside a wrap-around window', () => {
    // 23:30 local, window 23 -> 7: 7h30min left.
    expect(msUntilQuietEnd(spDateAtHour(23, 30), 23, 7)).toBe(7.5 * 3_600_000);
    // 06:59 local: one minute left.
    expect(msUntilQuietEnd(spDateAtHour(6, 59), 23, 7)).toBe(60_000);
  });

  it('counts down inside a non-wrapping window', () => {
    // 02:00 local, window 1 -> 5: 3h left.
    expect(msUntilQuietEnd(spDateAtHour(2, 0), 1, 5)).toBe(3 * 3_600_000);
  });

  it('start === end (always quiet) delays to the next endHour boundary', () => {
    // 03:00 local, end 5 -> 2h.
    expect(msUntilQuietEnd(spDateAtHour(3, 0), 5, 5)).toBe(2 * 3_600_000);
    // 05:00 local exactly: full 24h until the next boundary.
    expect(msUntilQuietEnd(spDateAtHour(5, 0), 5, 5)).toBe(24 * 3_600_000);
  });
});
