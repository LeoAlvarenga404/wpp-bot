import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OptoutService } from './optout.service';

/**
 * P2-26. In-group command parser.
 *
 * Supports:
 *   /ofertas [categoria] — stub reply (no pipeline cross-dep)
 *   /ajuda               — list commands
 *   /sair                — opt-out caller
 *
 * Throttle: 1 command per minute per user (in-memory).
 * Optional admin allowlist via WA_CMD_ADMIN_JIDS (comma-separated). If empty,
 * open to all.
 */

const THROTTLE_MS = 60 * 1000;

export interface CommandContext {
  /** Group or DM JID (where to reply). */
  chatJid: string;
  /** Participant JID who sent the command (for groups) or chat JID for DMs. */
  senderJid: string;
  /** Raw text of the message. */
  text: string;
}

export interface CommandResult {
  /** Reply text to send back, or null to stay silent. */
  reply: string | null;
}

@Injectable()
export class CommandHandler {
  private readonly logger = new Logger(CommandHandler.name);
  private readonly lastCommandAt = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly optout: OptoutService,
  ) {}

  /** Cheap check before parsing. */
  isCommand(text: string): boolean {
    return typeof text === 'string' && text.trim().startsWith('/');
  }

  private adminJids(): string[] {
    const raw = this.config.get<string>('WA_CMD_ADMIN_JIDS', '') ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private isAllowed(senderJid: string): boolean {
    const admins = this.adminJids();
    if (admins.length === 0) return true; // open
    return admins.includes(senderJid);
  }

  private isThrottled(senderJid: string): boolean {
    const last = this.lastCommandAt.get(senderJid) ?? 0;
    return Date.now() - last < THROTTLE_MS;
  }

  async handle(ctx: CommandContext): Promise<CommandResult> {
    const text = (ctx.text || '').trim();
    if (!text.startsWith('/')) return { reply: null };

    if (!this.isAllowed(ctx.senderJid)) {
      this.logger.debug(`cmd denied for ${ctx.senderJid}`);
      return { reply: null };
    }

    if (this.isThrottled(ctx.senderJid)) {
      this.logger.debug(`cmd throttled for ${ctx.senderJid}`);
      return { reply: null };
    }

    this.lastCommandAt.set(ctx.senderJid, Date.now());

    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();

    switch ((cmd || '').toLowerCase()) {
      case 'ofertas':
        return { reply: this.replyOfertas(arg) };
      case 'ajuda':
      case 'help':
        return { reply: this.replyAjuda() };
      case 'sair':
      case 'stop':
        await this.optout.add(ctx.senderJid);
        return {
          reply:
            'Tudo certo — você foi removido da lista. Não receberá mais ofertas.',
        };
      default:
        return { reply: null };
    }
  }

  private replyOfertas(categoria: string): string {
    if (categoria) {
      return `Ofertas de "${categoria}" em breve. (comando reconhecido)`;
    }
    return 'Ofertas em breve. Use /ajuda para ver comandos disponíveis.';
  }

  private replyAjuda(): string {
    return [
      'Comandos disponíveis:',
      '  /ofertas [categoria] — listar ofertas',
      '  /ajuda — esta mensagem',
      '  /sair — parar de receber ofertas',
    ].join('\n');
  }
}
