/**
 * ML thumbnails come as low-res variants (-I/-O). Swap for the full-size -F
 * variant and force https. Non-ML URLs pass through untouched (minus the
 * protocol upgrade).
 */
export function toHiResImage(original: string): string {
  if (!original) return original;
  const transformed = original
    .replace('-I.jpg', '-F.jpg')
    .replace('-O.jpg', '-F.jpg')
    .replace('http://', 'https://');
  if (!transformed || transformed === original) {
    const httpsOnly = original.replace('http://', 'https://');
    return httpsOnly || original;
  }
  return transformed;
}
