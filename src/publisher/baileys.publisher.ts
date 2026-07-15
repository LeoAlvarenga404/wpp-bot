import { Injectable } from '@nestjs/common';
import { WhatsappService } from '../whatsapp/wa.service';
import type { PublisherPort, RenderedPost } from './publisher.port';

@Injectable()
export class BaileysPublisher implements PublisherPort {
  readonly channel = 'wa' as const;

  constructor(private readonly wa: WhatsappService) {}

  async publish(post: RenderedPost, targetId: string): Promise<void> {
    if (!this.wa.isReady()) {
      throw new Error('whatsapp_not_ready');
    }
    if (post.imageUrl) {
      await this.wa.sendImage(targetId, post.imageUrl, post.caption);
    } else {
      await this.wa.sendText(targetId, post.caption);
    }
  }
}
