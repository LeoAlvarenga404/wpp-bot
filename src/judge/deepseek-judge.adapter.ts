import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DealJudge, JudgeInput, JudgeVerdict } from './judge.port';

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

/**
 * Gray-zone curation judge on DeepSeek's OpenAI-compatible API.
 * Throws on ANY failure (HTTP, timeout, bad JSON, bad shape) — the gate is
 * fail-closed and records `judge_error` without posting.
 */
@Injectable()
export class DeepSeekJudgeAdapter implements DealJudge {
  private readonly logger = new Logger(DeepSeekJudgeAdapter.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('DEEPSEEK_API_KEY') ?? '';
    this.model = this.config.get<string>('DEEPSEEK_MODEL') ?? 'deepseek-chat';
    this.endpoint =
      this.config.get<string>('DEEPSEEK_ENDPOINT') ??
      'https://api.deepseek.com/chat/completions';
    this.timeoutMs = Number(
      this.config.get<string>('DEEPSEEK_TIMEOUT_MS') ?? '8000',
    );
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
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
            { role: 'user', content: JSON.stringify(input) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 200,
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

    const parsed = JSON.parse(content) as Partial<JudgeVerdict>;
    if (
      typeof parsed.approve !== 'boolean' ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.reason !== 'string'
    ) {
      throw new Error(`invalid verdict shape: ${content.slice(0, 120)}`);
    }
    return {
      approve: parsed.approve,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reason: parsed.reason.slice(0, 300),
    };
  }

  private systemPrompt(): string {
    return [
      'Você é um curador cético de ofertas de e-commerce no Brasil.',
      'Recebe um JSON com sinais de um deal (preço, histórico, vendedor,',
      'score heurístico) e decide se ele é uma oferta REAL que vale publicar',
      'num grupo de promoções, ou provável fake/armadilha.',
      'Rejeite quando: desconto ancorado só num "preço original" sem apoio',
      'do histórico; indício de preço inflado antes do desconto; vendedor',
      'de reputação baixa ou desconhecida em item caro; produto usado ou',
      'recondicionado sem desconto excepcional; qualquer sinal incoerente.',
      'Aprove quando o preço atual é claramente bom contra mediana/mínimos',
      'e o vendedor é confiável.',
      'Responda APENAS JSON: {"approve": boolean, "confidence": number',
      'entre 0 e 1, "reason": "uma frase curta em pt-BR"}.',
    ].join(' ');
  }
}
