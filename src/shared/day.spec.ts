import { dayString } from './day';

describe('dayString', () => {
  it('formats YYYY-MM-DD in the given timezone', () => {
    // 2026-07-15T01:30Z = 2026-07-14 22:30 em São Paulo (UTC-3)
    const d = new Date('2026-07-15T01:30:00Z');
    expect(dayString(d, 'America/Sao_Paulo')).toBe('2026-07-14');
    expect(dayString(d, 'UTC')).toBe('2026-07-15');
  });
});
