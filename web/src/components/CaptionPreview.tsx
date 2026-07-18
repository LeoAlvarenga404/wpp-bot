import type { ReactNode } from 'react';

/**
 * Renders the WA caption exactly as the group would read it, inside a
 * WhatsApp-style bubble. The only WA markup the ofertas template emits is
 * ~strikethrough~ (the "De" price) — parse just that.
 */
function renderLine(line: string, key: number): ReactNode {
  const parts: ReactNode[] = [];
  const regex = /~([^~]+)~/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    parts.push(<s key={`${key}-${match.index}`}>{match[1]}</s>);
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return (
    <p key={key} className="min-h-4 break-words">
      {parts}
    </p>
  );
}

export function CaptionPreview({
  caption,
  imageUrl,
}: {
  caption: string;
  imageUrl: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg bg-[#1f2c34]">
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          className="max-h-64 w-full bg-black/30 object-contain"
        />
      )}
      <div className="px-3 py-2 text-[13px] leading-snug text-gray-100">
        {caption.split('\n').map((line, i) => renderLine(line, i))}
      </div>
    </div>
  );
}
