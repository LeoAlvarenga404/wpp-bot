/** Calendar day (YYYY-MM-DD) of `d` in timezone `tz`. 'en-CA' locale emits ISO order. */
export function dayString(d: Date, tz: string): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}
