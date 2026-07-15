import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DealItem } from '../mercado-livre/types';
import { HeadlineCacheService } from './headline-cache.service';
import { HEADLINE_FRAMES, HeadlineFrame, pickFrame } from './headline-frames';
import { HeadlineGenerator } from './headline.port';
import { NoopHeadlineAdapter } from './noop-headline.adapter';

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const FORBIDDEN_WORDS = [
  'OFERTA',
  'OFERTÃO',
  'PROMOÇÃO',
  'IMPERDÍVEL',
  'IMPERDIVEL',
  'DESCONTÃO',
  'DESCONTAO',
  'ALERTA',
];

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

    const frame = pickFrame();
    try {
      const headline = await this.callDeepSeek(item, frame);
      let clean = this.sanitize(headline);
      if (!clean) throw new Error('empty headline');
      if (this.hasForbiddenWord(clean)) {
        this.logger.warn(
          `headline contained forbidden word, retrying once: "${clean}"`,
        );
        const retry = await this.callDeepSeek(item, frame);
        clean = this.sanitize(retry);
      }
      if (!clean) throw new Error('empty headline after retry');
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
  ): Promise<string> {
    const userPrompt = this.buildPrompt(item, frame);

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
            { role: 'system', content: this.systemPrompt() },
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

  private systemPrompt(): string {
    return [
      'Você é admin veterano de um grupo de WhatsApp de ofertas no Brasil.',
      'Idade ~30, fala como cria da quebrada/zona norte de SP: gíria,',
      'humor seco, intimidade com a galera. NÃO é vendedor corporativo.',
      'NÃO usa palavras de marketing chato como "OFERTA", "OFERTÃO",',
      '"PROMOÇÃO", "IMPERDÍVEL", "DESCONTÃO", "ALERTA".',
      'Cada hook que escreve soa como mensagem real de um amigo zoando.',
      'Resposta SEMPRE em uma linha só, CAPS LOCK, com 2-3 emojis no fim.',
    ].join(' ');
  }

  private buildPrompt(item: DealItem, frame: HeadlineFrame): string {
    const priceBRL = item.price.toLocaleString('pt-BR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const originalBRL = item.originalPrice.toLocaleString('pt-BR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const totalFrames = HEADLINE_FRAMES.length;
    const otherFrames = HEADLINE_FRAMES.filter((f) => f.name !== frame.name)
      .map((f) => f.name)
      .join(', ');

    return [
      'TAREFA: criar UMA frase de chamada (hook) pra anunciar esse produto',
      'num grupo de WhatsApp. Vai aparecer ANTES do bloco de preço/link,',
      'então NÃO repita preço/link/cupom — só vibra.',
      '',
      `PRODUTO: ${item.title}`,
      `PREÇO ATUAL: R$ ${priceBRL}`,
      `PREÇO ANTIGO: R$ ${originalBRL}`,
      `DESCONTO: ${item.discountPercent}% OFF`,
      '',
      `ESTILO OBRIGATÓRIO (1 de ${totalFrames}): ${frame.name}`,
      `Descrição do estilo: ${frame.guide}`,
      '',
      'Exemplos APENAS desse estilo (siga exatamente essa estrutura):',
      ...frame.examples.map((e) => `- ${e}`),
      '',
      'RESTRIÇÕES:',
      `- USE o estilo "${frame.name}". NÃO use os outros estilos (${otherFrames}).`,
      '- TUDO em CAPS LOCK.',
      '- Termina com 2 ou 3 emojis (😍 / 🔥 / 😱 / 💸 / 🤯 / 💪 / 👀 / ☕ / 🥩 / 🎧 / 📱 etc).',
      '- 4 a 12 palavras. Máximo 70 caracteres.',
      '- NÃO escreva: OFERTA, OFERTÃO, PROMOÇÃO, IMPERDÍVEL, DESCONTÃO, ALERTA.',
      '- NÃO use aspas, hashtag (#), link, markdown (* ou ~), nem dois-pontos no começo.',
      '- NÃO inclua preço nem cupom dentro do hook (a não ser que o estilo seja PRECO_CONTO).',
      '- NÃO copie o título inteiro do produto. Resume na vibe.',
      '- Refira-se ao produto pela categoria/uso, não pela marca completa.',
      '',
      'Devolve APENAS a frase. Sem prefixo, sem aspas, sem explicação.',
    ].join('\n');
  }

  private sanitize(raw: string): string {
    let s = raw.trim();
    s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
    s = s.replace(/^[-*•]\s*/, '').trim();
    s = s.replace(/^(headline|hook|frase|resposta)\s*:\s*/i, '').trim();
    s = s.split('\n')[0].trim();
    if (s.length > 100) s = s.slice(0, 100).trim();
    return s;
  }

  private hasForbiddenWord(s: string): boolean {
    const upper = s.toUpperCase();
    return FORBIDDEN_WORDS.some((w) => upper.includes(w));
  }
}
