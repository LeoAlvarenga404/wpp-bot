import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappService } from '../whatsapp/wa.service';
import type { PublisherPort, RenderedPost } from './publisher.port';

@Injectable()
export class BaileysPublisher implements PublisherPort {
  readonly channel = 'wa' as const;

  constructor(
    private readonly wa: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  async publish(post: RenderedPost, targetId: string): Promise<void> {
    if (!this.wa.isReady()) {
      throw new Error('whatsapp_not_ready');
    }
    // Clickable link-preview card: large thumbnail whose tap opens linkUrl
    // (externalAdReply). Only when we have both an image and a single link
    // (digests carry many links, so they fall through to a plain image).
    // WA_LINK_CARD=false rolls back to the plain image+caption send.
    const cardEnabled =
      this.config.get<string>('WA_LINK_CARD', 'true') !== 'false';
    if (post.imageUrl && post.linkUrl && cardEnabled) {
      await this.wa.sendImageCard(targetId, {
        imageUrl: post.imageUrl,
        caption: post.caption,
        sourceUrl: post.linkUrl,
      });
    } else if (post.imageUrl) {
      await this.wa.sendImage(targetId, post.imageUrl, post.caption);
    } else {
      await this.wa.sendText(targetId, post.caption);
    }
  }
}
