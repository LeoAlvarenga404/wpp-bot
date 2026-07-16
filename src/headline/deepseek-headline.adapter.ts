import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DealItem } from '../mercado-livre/types';
import { CountersService } from '../metrics/counters.service';
import { HeadlineCacheService } from './headline-cache.service';
import { HeadlineConfigService } from './headline-config.service';
import { HeadlineCopyConfig } from './headline-copy.defaults';
import { HeadlineFrame, pickFrame } from './headline-frames';
import { HeadlineGenerator } from './headline.port';
import { NoopHeadlineAdapter } from './noop-headline.adapter';

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

@Injectable()
export class DeepSeekHeadlineAdapter implements HeadlineGenerator {
  private readonly logger = new Logger(DeepSeekHeadlineAdapter.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly presencePenalty: number;
  private readonly frequencyPenalty: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: HeadlineCacheService,
    private readonly fallback: NoopHeadlineAdapter,
    private readonly copy: HeadlineConfigService,
    private readonly counters: CountersService,
  ) {
    this.apiKey = this.config.get<string>('DEEPSEEK_API_KEY') ?? '';
    this.model = this.config.get<string>('HEADLINE_MODEL') ?? 'deepseek-chat';
    this.endpoint =
      this.config.get<string>('DEEPSEEK_ENDPOINT') ??
      'https://api.deepseek.com/chat/completions';
    this.temperature = Number(
      this.config.get<string>('HEADLINE_TEMPERATURE') ?? '1.0',
    );
    this.topP = Number(this.config.get<string>('HEADLINE_TOP_P') ?? '0.95');
    this.presencePenalty = Number(
      this.config.get<string>('HEADLINE_PRESENCE_PENALTY') ?? '0.6',
    );
    this.frequencyPenalty = Number(
      this.config.get<string>('HEADLINE_FREQUENCY_PENALTY') ?? '0.5',
    );
    this.maxTokens = Number(
      this.config.get<string>('HEADLINE_MAX_TOKENS') ?? '80',
    );
    this.timeoutMs = Number(
      this.config.get<string>('HEADLINE_TIMEOUT_MS') ?? '8000',
    );
  }

  async generate(item: DealItem): Promise<string> {
    const cached = this.cache.get(item.catalogId);
    if (cached) return cached;

    if (!this.apiKey) {
      this.logger.warn('DEEPSEEK_API_KEY missing — using static hook pool');
      return this.fallback.generate(item);
    }

    const cfg = this.copy.get();
    const frame = pickFrame(cfg.frames);
    this.counters.headlineFrameUsed.inc({ frame: frame.name });

    try {
      let clean = this.sanitize(await this.callDeepSeek(item, frame, cfg));
      let issue = this.qualityIssue(clean, item, cfg);
      if (issue) {
        this.logger.warn(
          `headline rejected (${issue}), retrying once: "${clean}"`,
        );
        clean = this.sanitize(await this.callDeepSeek(item, frame, cfg));
        issue = this.qualityIssue(clean, item, cfg);
      }
      if (issue) throw new Error(`quality gate failed: ${issue}`);

      await this.cache.set(item.catalogId, clean);
      return clean;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`DeepSeek failed (${msg}) — using static hook pool`);
      return this.fallback.generate(item);
    }
  }

  private async callDeepSeek(
    item: DealItem,
    frame: HeadlineFrame,
    cfg: HeadlineCopyConfig,
  ): Promise<string> {
    const userPrompt = this.buildPrompt(item, frame, cfg);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: cfg.persona },
            { role: 'user', content: userPrompt },
          ],
          temperature: this.temperature,
          top_p: this.topP,
          presence_penalty: this.presencePenalty,
          frequency_penalty: this.frequencyPenalty,
          max_tokens: this.maxTokens,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`status=${res.status} body=${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as ChatResponse;
    if (data.error?.message) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('no content in response');
    return content;
  }

  private buildPrompt(
    item: DealItem,
    frame: HeadlineFrame,
    cfg: HeadlineCopyConfig,
  ): string {
    const priceBRL = item.price.toLocaleString('pt-BR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const originalBRL = item.originalPrice.toLocaleString('pt-BR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const otherFrames = cfg.frames
      .filter((f) => f.name !== frame.name)
      .map((f) => f.name)
      .join(', ');
    const forbiddenList = cfg.forbiddenWords.join(', ');

    const lines = [
      'TAREFA: criar UMA frase de chamada (hook) pra anunciar esse produto',
      'num grupo de WhatsApp. Vai aparecer ANTES do bloco de preço/link,',
      'então NÃO repita preço/link/cupom — só vibra.',
      '',
      `PRODUTO: ${item.title}`,
      `PREÇO ATUAL: R$ ${priceBRL}`,
      `PREÇO ANTIGO: R$ ${originalBRL}`,
      `DESCONTO: ${item.discountPercent}% OFF`,
      '',
      `ESTILO OBRIGATÓRIO (1 de ${cfg.frames.length}): ${frame.name}`,
      `Descrição do estilo: ${frame.guide}`,
      '',
      'Exemplos APENAS desse estilo (siga exatamente essa estrutura):',
      ...frame.examples.map((e) => `- ${e}`),
    ];

    if (frame.avoid?.length) {
      lines.push(
        '',
        `NÃO faça assim nesse estilo "${frame.name}":`,
        ...frame.avoid.map((e) => `- ${e}`),
      );
    }

    if (cfg.antiExamples.length) {
      lines.push(
        '',
        'NUNCA escreva nada parecido com isso (erros comuns):',
        ...cfg.antiExamples.map((e) => `- ${e}`),
      );
    }

    lines.push(
      '',
      'RESTRIÇÕES:',
      `- USE o estilo "${frame.name}". NÃO use os outros estilos (${otherFrames}).`,
      '- TUDO em CAPS LOCK.',
      '- Termina com 2 ou 3 emojis (😍 / 🔥 / 😱 / 💸 / 🤯 / 💪 / 👀 / ☕ / 🥩 / 🎧 / 📱 etc).',
      '- 4 a 12 palavras. Máximo 70 caracteres.',
      `- NÃO escreva: ${forbiddenList}.`,
      '- NÃO use aspas, hashtag (#), link, markdown (* ou ~), nem dois-pontos no começo.',
      '- NÃO inclua preço nem cupom dentro do hook (a não ser que o estilo seja PRECO_CONTO).',
      '- NÃO copie o título inteiro do produto. Resume na vibe.',
      '- Refira-se ao produto pela categoria/uso, não pela marca completa.',
      '',
      'Devolve APENAS a frase. Sem prefixo, sem aspas, sem explicação.',
    );

    return lines.join('\n');
  }

  private sanitize(raw: string): string {
    let s = raw.trim();
    s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
    s = s.replace(/^[-*•]\s*/, '').trim();
    s = s.replace(/^(headline|hook|frase|resposta)\s*:\s*/i, '').trim();
    s = s.split('\n')[0].trim();
    s = s.replace(/^:+\s*/, '').trim();
    if (s.length > 100) s = s.slice(0, 100).trim();
    return s;
  }

  /**
   * Gate determinístico de qualidade (#5). Grátis — sem LLM extra. Devolve o
   * motivo da reprova (string) ou null quando o hook passa. Cobre os modos de
   * falha checáveis: vazio, palavra proibida, sem emoji, tamanho fora, char
   * banido e cópia do título do produto.
   */
  private qualityIssue(
    clean: string,
    item: DealItem,
    cfg: HeadlineCopyConfig,
  ): string | null {
    if (!clean) return 'empty';

    const forbidden = this.forbiddenHit(clean, cfg.forbiddenWords);
    if (forbidden) return `forbidden:${forbidden}`;

    if (!/\p{Extended_Pictographic}/u.test(clean)) return 'no-emoji';
    if (/[#*~`]/.test(clean)) return 'banned-char';
    if (/https?:\/\//i.test(clean)) return 'has-link';

    const words = clean.trim().split(/\s+/);
    if (words.length < 3) return 'too-short';
    if (clean.length > 90) return 'too-long';

    if (this.copiesTitle(clean, item.title)) return 'title-copy';

    return null;
  }

  private forbiddenHit(s: string, words: string[]): string | null {
    const upper = s.toUpperCase();
    return words.find((w) => upper.includes(w.toUpperCase())) ?? null;
  }

  /**
   * Detecta hook que só repete o título do produto. Normaliza (sem acento,
   * minúsculo, só alfanumérico) e mede a fração de palavras do hook que também
   * estão no título. >=60% de sobreposição com >=4 palavras = cópia.
   */
  private copiesTitle(hook: string, title: string): boolean {
    const titleSet = new Set(this.tokens(title, 3));
    if (titleSet.size === 0) return false;
    const hookWords = this.tokens(hook, 3);
    if (hookWords.length < 4) return false;
    const matched = hookWords.filter((w) => titleSet.has(w)).length;
    return matched / hookWords.length >= 0.6;
  }

  private tokens(s: string, minLen: number): string[] {
    return s
      .normalize('NFD')
      .replace(/[0300-036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= minLen);
  }
}
