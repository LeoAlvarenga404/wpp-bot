import { isQuietHours } from './quiet-hours';

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
