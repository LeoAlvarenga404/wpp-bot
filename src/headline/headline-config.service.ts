import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { HeadlineFrame } from './headline-frames';
import {
  COPY_CONFIG_DEFAULT,
  HeadlineCopyConfig,
} from './headline-copy.defaults';

/**
 * Carrega a copy do gerador de headline de arquivos editáveis em disco, com
 * fallback fail-safe para os defaults embutidos ({@link COPY_CONFIG_DEFAULT}).
 *
 * Fonte da verdade quando presente:
 *   - `${dir}/persona.md`   → texto do prompt de sistema (a "voz").
 *   - `${dir}/copy.json`    → { forbiddenWords?, antiExamples?, frames? }.
 *
 * `dir` = env HEADLINE_CONFIG_DIR (default `./config/headline`). Trocar o dir
 * por audiência/deploy troca toda a persona sem rebuild (#3). Qualquer arquivo
 * faltando ou malformado → usa o default DAQUELE campo e loga; nunca derruba.
 */
@Injectable()
export class HeadlineConfigService implements OnModuleInit {
  private readonly logger = new Logger(HeadlineConfigService.name);
  private readonly dir: string;
  private config: HeadlineCopyConfig = COPY_CONFIG_DEFAULT;

  constructor(private readonly configService: ConfigService) {
    this.dir = path.resolve(
      this.configService.get<string>('HEADLINE_CONFIG_DIR') ??
        './config/headline',
    );
  }

  async onModuleInit(): Promise<void> {
    this.config = await this.load();
    const nFrames = this.config.frames.length;
    this.logger.log(
      `Headline copy loaded from ${this.dir} ` +
        `(persona ${this.config.persona.length} chars, ${nFrames} frames, ` +
        `${this.config.forbiddenWords.length} forbidden words)`,
    );
  }

  /** Config atual. Válido após onModuleInit; antes disso, retorna defaults. */
  get(): HeadlineCopyConfig {
    return this.config;
  }

  private async load(): Promise<HeadlineCopyConfig> {
    const persona = await this.loadPersona();
    const { forbiddenWords, antiExamples, frames } = await this.loadCopyJson();
    return { persona, forbiddenWords, antiExamples, frames };
  }

  private async loadPersona(): Promise<string> {
    const file = path.join(this.dir, 'persona.md');
    try {
      const raw = (await fs.readFile(file, 'utf-8')).trim();
      if (!raw) {
        this.logger.warn(`${file} vazio — usando persona default`);
        return COPY_CONFIG_DEFAULT.persona;
      }
      return raw;
    } catch (err) {
      this.logMissing(file, err, 'persona');
      return COPY_CONFIG_DEFAULT.persona;
    }
  }

  private async loadCopyJson(): Promise<{
    forbiddenWords: string[];
    antiExamples: string[];
    frames: HeadlineFrame[];
  }> {
    const file = path.join(this.dir, 'copy.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
    } catch (err) {
      this.logMissing(file, err, 'copy.json');
      return {
        forbiddenWords: COPY_CONFIG_DEFAULT.forbiddenWords,
        antiExamples: COPY_CONFIG_DEFAULT.antiExamples,
        frames: COPY_CONFIG_DEFAULT.frames,
      };
    }

    const obj = (parsed ?? {}) as Record<string, unknown>;
    return {
      forbiddenWords: this.stringList(
        obj.forbiddenWords,
        COPY_CONFIG_DEFAULT.forbiddenWords,
      ),
      antiExamples: this.stringList(
        obj.antiExamples,
        COPY_CONFIG_DEFAULT.antiExamples,
      ),
      frames: this.validFrames(obj.frames),
    };
  }

  private stringList(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return fallback;
    const clean = value.filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0,
    );
    return clean.length ? clean : fallback;
  }

  private validFrames(value: unknown): HeadlineFrame[] {
    if (!Array.isArray(value)) return COPY_CONFIG_DEFAULT.frames;
    const frames: HeadlineFrame[] = [];
    for (const raw of value) {
      const f = raw as Partial<HeadlineFrame>;
      const examples = Array.isArray(f.examples)
        ? f.examples.filter((e): e is string => typeof e === 'string' && !!e)
        : [];
      const ok =
        typeof f.name === 'string' &&
        f.name.trim().length > 0 &&
        typeof f.weight === 'number' &&
        Number.isFinite(f.weight) &&
        f.weight >= 0 &&
        typeof f.guide === 'string' &&
        examples.length > 0;
      if (!ok) {
        this.logger.warn(
          `Frame inválido ignorado: ${JSON.stringify(raw).slice(0, 80)}`,
        );
        continue;
      }
      const avoid = Array.isArray(f.avoid)
        ? f.avoid.filter((a): a is string => typeof a === 'string' && !!a)
        : undefined;
      frames.push({
        name: f.name as string,
        weight: f.weight as number,
        guide: f.guide as string,
        examples,
        ...(avoid && avoid.length ? { avoid } : {}),
      });
    }
    if (!frames.length) {
      this.logger.warn('Nenhum frame válido no copy.json — usando defaults');
      return COPY_CONFIG_DEFAULT.frames;
    }
    return frames;
  }

  private logMissing(file: string, err: unknown, what: string): void {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') {
      this.logger.log(`${file} ausente — usando ${what} default`);
    } else {
      this.logger.warn(
        `Falha ao ler ${file} (${e?.message ?? String(err)}) — usando ${what} default`,
      );
    }
  }
}
