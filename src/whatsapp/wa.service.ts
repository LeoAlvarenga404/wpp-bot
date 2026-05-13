import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: WASocket | null = null;
  private ready = false;
  private authDir!: string;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService) {}

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
      logger: pino({ level: 'warn' }) as any,
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
        this.logger.log('WhatsApp connected.');
        void this.listGroups();
      }

      if (connection === 'close') {
        this.ready = false;
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        this.logger.warn(
          `WA disconnected (code=${code}). Reconnect=${shouldReconnect}`,
        );
        if (shouldReconnect) {
          this.reconnectTimer = setTimeout(() => void this.connect(), 3000);
        }
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

  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock || !this.ready) throw new Error('WhatsApp not ready');
    await this.sock.sendMessage(jid, { text });
  }

  async sendImage(jid: string, imageUrl: string, caption?: string): Promise<void> {
    if (!this.sock || !this.ready) throw new Error('WhatsApp not ready');
    await this.sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption,
    });
  }
}
