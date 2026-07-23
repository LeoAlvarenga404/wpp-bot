import type { Channel } from '../whatsapp/targets.service';

export const PUBLISHERS = Symbol('PUBLISHERS');

export interface RenderedPost {
  caption: string;
  imageUrl?: string;
  /**
   * Destination URL for a clickable link-preview card (WA externalAdReply).
   * When present alongside `imageUrl`, the WA publisher renders a large
   * clickable thumbnail whose tap opens this URL. Absent (e.g. digests with
   * many links) → plain image + caption.
   */
  linkUrl?: string;
}

export interface PublisherPort {
  readonly channel: Channel;
  /** Throws on failure — BullMQ retry semantics ride on exceptions. */
  publish(post: RenderedPost, targetId: string): Promise<void>;
}
