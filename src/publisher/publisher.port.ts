import type { Channel } from '../whatsapp/targets.service';

export const PUBLISHERS = Symbol('PUBLISHERS');

export interface RenderedPost {
  caption: string;
  imageUrl?: string;
}

export interface PublisherPort {
  readonly channel: Channel;
  /** Throws on failure — BullMQ retry semantics ride on exceptions. */
  publish(post: RenderedPost, targetId: string): Promise<void>;
}
