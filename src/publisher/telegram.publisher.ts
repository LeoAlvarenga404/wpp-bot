import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { PublisherPort, RenderedPost } from './publisher.port';

/**
 * Publishes via the official Telegram Bot API. Stateless HTTP — no session,
 * no ban risk. `parse_mode: 'Markdown'` (legacy) matches WhatsApp caption
 * syntax (*bold*, _italic_), so captions render the same on both channels.
 * If Telegram rejects the entities (400) we resend as plain text instead of
 * dropping the deal. 429 surfaces as `throttled:telegram` so the BullMQ
 * worker's retry/backoff and failure metrics treat it as a rate limit.
 */
@Injectable()
export class TelegramPublisher implements PublisherPort {
  readonly channel = 'telegram' as const;
  private readonly logger = new Logger(TelegramPublisher.name);

  constructor(private readonly config: ConfigService) {}

  async publish(post: RenderedPost, targetId: string): Promise<void> {
    try {
      await this.send(post, targetId, 'Markdown');
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        throw new Error('throttled:telegram');
      }
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        this.logger.warn(
          `telegram 400 (likely markdown entities) — resending plain, chat=${targetId}`,
        );
        await this.send(post, targetId, undefined);
        return;
      }
      throw err;
    }
  }

  private async send(
    post: RenderedPost,
    chatId: string,
    parseMode?: 'Markdown',
  ): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
    if (!token) throw new Error('telegram_token_missing');
    const base = `https://api.telegram.org/bot${token}`;
    const modeField = parseMode ? { parse_mode: parseMode } : {};
    if (post.imageUrl) {
      await axios.post(`${base}/sendPhoto`, {
        chat_id: chatId,
        photo: post.imageUrl,
        caption: post.caption,
        ...modeField,
      });
    } else {
      await axios.post(`${base}/sendMessage`, {
        chat_id: chatId,
        text: post.caption,
        ...modeField,
      });
    }
  }
}
