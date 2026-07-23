import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WASocket,
} from '@whiskeysockets/baileys';
import * as Sentry from '@sentry/node';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';
import { CountersService } from '../metrics/counters.service';
import { CommandHandler } from './command.handler';
import { RateLimiterService } from './rate-limiter.service';

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: WASocket | null = null;
  private ready = false;
  private authDir!: string;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // P0-6 health tracking
  private reconnectAttempts = 0;
  private lastSeen: Date | null = null;
  private lastDisconnectReason: string | null = null;
  private reconnectExhausted = false;

  constructor(
    private readonly config: ConfigService,
    private readonly rateLimiter: RateLimiterService,
    private readonly commandHandler: CommandHandler,
    private readonly counters: CountersService,
  ) {}

  async onModuleInit() {
    this.authDir = this.config.get<string>('WA_AUTH_DIR', './auth_info');
    await this.connect();
  }

  async onModuleDestroy() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
  }

  private async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    this.logger.log(`Baileys WA v${version.join('.')}`);

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'warn' }),
      printQRInTerminal: false,
      browser: ['wpp-bot', 'Chrome', '1.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.warn('Scan QR code in WhatsApp:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.ready = true;
        this.reconnectAttempts = 0;
        this.reconnectExhausted = false;
        this.lastSeen = new Date();
        this.lastDisconnectReason = null;
        this.counters.baileysConnected.set(1);
        this.logger.log('WhatsApp connected.');
        void this.listGroups();
      }

      if (connection === 'close') {
        this.ready = false;
        this.counters.baileysConnected.set(0);
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        this.lastDisconnectReason = String(code ?? 'unknown');

        if (code === DisconnectReason.loggedOut) {
          this.logger.warn(
            'WA loggedOut — need to scan QR again. Will NOT auto-reconnect.',
          );
          return;
        }

        this.reconnectAttempts += 1;
        const max = Number(this.config.get<string>('WA_MAX_RECONNECTS', '10'));

        if (this.reconnectAttempts >= max) {
          this.reconnectExhausted = true;
          this.logger.error(
            `WA reconnect exhausted after ${this.reconnectAttempts} attempts (code=${code}). Stopping.`,
          );
          try {
            Sentry.captureMessage('WA reconnect exhausted', 'error');
          } catch {
            // Sentry may not be initialised in dev — swallow.
          }
          return;
        }

        const delay = Math.min(
          60_000,
          1000 * Math.pow(2, this.reconnectAttempts - 1),
        );
        this.logger.warn(
          `WA disconnected (code=${code}). Reconnect attempt ${this.reconnectAttempts}/${max} in ${delay}ms`,
        );
        this.reconnectTimer = setTimeout(() => void this.connect(), delay);
      }
    });

    // P0-6: update lastSeen on every incoming message.
    // P2-26: dispatch group commands prefixed with '/'.
    this.sock.ev.on('messages.upsert', async (evt) => {
      this.lastSeen = new Date();
      try {
        const messages = evt.messages ?? [];
        for (const m of messages) {
          if (!m || !m.message) continue;
          if (m.key?.fromMe) continue;
          const chatJid = m.key?.remoteJid ?? '';
          if (!chatJid) continue;
          const isGroup = chatJid.endsWith('@g.us');
          if (!isGroup) continue; // commands only in groups per spec

          const text =
            m.message.conversation ??
            m.message.extendedTextMessage?.text ??
            m.message.imageMessage?.caption ??
            '';
          if (!text || !this.commandHandler.isCommand(text)) continue;

          const senderJid = m.key?.participant ?? chatJid;
          const result = await this.commandHandler.handle({
            chatJid,
            senderJid,
            text,
          });
          if (result.reply && this.sock && this.ready) {
            try {
              await this.sock.sendMessage(chatJid, { text: result.reply });
            } catch (err) {
              this.logger.error('Failed to reply to command', err as Error);
            }
          }
        }
      } catch (err) {
        this.logger.error('messages.upsert handler failed', err as Error);
      }
    });
  }

  async listGroups(): Promise<void> {
    if (!this.sock) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const list = Object.values(groups).map((g) => ({
        jid: g.id,
        subject: g.subject,
        size: g.participants.length,
      }));
      this.logger.log('Groups:\n' + JSON.stringify(list, null, 2));
    } catch (err) {
      this.logger.error('listGroups failed', err as Error);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** P0-6 public health view. */
  getHealth(): {
    connected: boolean;
    lastSeen: string | null;
    reconnectAttempts: number;
    lastDisconnectReason: string | null;
    reconnectExhausted: boolean;
  } {
    return {
      connected: this.ready,
      lastSeen: this.lastSeen ? this.lastSeen.toISOString() : null,
      reconnectAttempts: this.reconnectAttempts,
      lastDisconnectReason: this.lastDisconnectReason,
      reconnectExhausted: this.reconnectExhausted,
    };
  }

  /** P1-13 pre-check helper for callers that want to avoid the throw path. */
  canSend(): boolean {
    return this.rateLimiter.canSend().allowed;
  }

  /** P1-13 rate limiter status passthrough. */
  getRateLimiterStatus() {
    return this.rateLimiter.getStatus();
  }

  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock || !this.ready) throw new Error('WhatsApp not ready');
    const check = this.rateLimiter.canSend();
    if (!check.allowed) {
      throw new Error(`throttled:${check.reason ?? 'warmup_cap'}`);
    }
    await this.sock.sendMessage(jid, { text });
    await this.rateLimiter.recordSend();
  }

  async sendImage(
    jid: string,
    imageUrl: string,
    caption?: string,
  ): Promise<void> {
    if (!this.sock || !this.ready) throw new Error('WhatsApp not ready');
    const check = this.rateLimiter.canSend();
    if (!check.allowed) {
      throw new Error(`throttled:${check.reason ?? 'warmup_cap'}`);
    }
    await this.sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption,
    });
    await this.rateLimiter.recordSend();
  }

  /**
   * Clickable link-preview card (externalAdReply): a large thumbnail plus the
   * caption text, where tapping anywhere on the card opens `sourceUrl`. Unlike
   * {@link sendImage} the picture is a preview thumbnail (lower res), not full
   * media — the trade-off for making the image itself redirect.
   *
   * The thumbnail is fetched to a Buffer for reliable rendering across WA
   * clients; if the fetch fails we still send the card with `thumbnailUrl` so
   * the message is never lost. If the whole card send throws, the error
   * propagates (BullMQ retry) — same contract as sendImage.
   */
  async sendImageCard(
    jid: string,
    opts: { imageUrl: string; caption: string; sourceUrl: string },
  ): Promise<void> {
    if (!this.sock || !this.ready) throw new Error('WhatsApp not ready');
    const check = this.rateLimiter.canSend();
    if (!check.allowed) {
      throw new Error(`throttled:${check.reason ?? 'warmup_cap'}`);
    }

    const thumbnail = await this.fetchThumbnail(opts.imageUrl);
    const host = this.hostLabel(opts.sourceUrl);

    await this.sock.sendMessage(jid, {
      text: opts.caption,
      contextInfo: {
        externalAdReply: {
          title: host,
          mediaType: 1,
          sourceUrl: opts.sourceUrl,
          renderLargerThumbnail: true,
          showAdAttribution: false,
          ...(thumbnail ? { thumbnail } : { thumbnailUrl: opts.imageUrl }),
        },
      },
    });
    await this.rateLimiter.recordSend();
  }

  /** Fetch an image into a Buffer for use as an externalAdReply thumbnail.
   * Returns undefined on any failure (caller falls back to thumbnailUrl). */
  private async fetchThumbnail(url: string): Promise<Buffer | undefined> {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(`link-card thumbnail fetch ${res.status} for ${url}`);
        return undefined;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      this.logger.warn(
        `link-card thumbnail fetch failed (${(err as Error).message}); using thumbnailUrl`,
      );
      return undefined;
    }
  }

  /** Bare host for the card label: "https://meli.la/x" -> "meli.la". */
  private hostLabel(url: string): string {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch {
      return 'oferta';
    }
  }
}
