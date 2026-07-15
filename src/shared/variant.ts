export type CopyVariant = 'A' | 'B';

/** Deterministic split: same deal gets the same copy on WA and Telegram. */
export function pickVariant(catalogId: string): CopyVariant {
  let h = 0;
  for (let i = 0; i < catalogId.length; i++) {
    h = (h * 31 + catalogId.charCodeAt(i)) | 0;
  }
  return (h & 1) === 0 ? 'A' : 'B';
}
