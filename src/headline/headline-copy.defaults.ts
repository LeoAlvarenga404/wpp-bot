import { HEADLINE_FRAMES, HeadlineFrame } from './headline-frames';

/**
 * Configuração de copy do gerador de headline. Tudo aqui é "editável por
 * não-dev": o {@link HeadlineConfigService} carrega estes campos de
 * `config/headline/persona.md` + `config/headline/copy.json` em runtime e cai
 * para estes defaults quando o arquivo falta ou está inválido.
 */
export interface HeadlineCopyConfig {
  /** Prompt de sistema — a "voz" do admin. Trocar = trocar de persona (#3). */
  persona: string;
  /** Palavras de marketing chato que reprovam o hook. */
  forbiddenWords: string[];
  /** Contra-exemplos globais injetados no prompt (#1). */
  antiExamples: string[];
  /** Estilos de hook + pesos de amostragem (#4 tuning por arquivo). */
  frames: HeadlineFrame[];
}

/**
 * Persona default: admin de grupo de ofertas, gíria zona norte SP.
 * Editar `config/headline/persona.md` sobrescreve isto sem rebuild.
 */
export const PERSONA_DEFAULT = [
  'Você é admin veterano de um grupo de WhatsApp de ofertas no Brasil.',
  'Idade ~30, fala como cria da quebrada/zona norte de SP: gíria,',
  'humor seco, intimidade com a galera. NÃO é vendedor corporativo.',
  'NÃO usa palavras de marketing chato como "OFERTA", "OFERTÃO",',
  '"PROMOÇÃO", "IMPERDÍVEL", "DESCONTÃO", "ALERTA".',
  'Cada hook que escreve soa como mensagem real de um amigo zoando.',
  'Resposta SEMPRE em uma linha só, CAPS LOCK, com 2-3 emojis no fim.',
].join(' ');

export const FORBIDDEN_WORDS_DEFAULT = [
  'OFERTA',
  'OFERTÃO',
  'PROMOÇÃO',
  'IMPERDÍVEL',
  'IMPERDIVEL',
  'DESCONTÃO',
  'DESCONTAO',
  'ALERTA',
];

/**
 * Contra-exemplos globais (#1). Independem do frame: mostram os modos de
 * falha mais comuns (marketing chato, corporativo, spam de link, título
 * copiado, minúsculo/sem vibe). Ancorar no "NÃO faça" corta esses erros.
 */
export const ANTI_EXAMPLES_DEFAULT = [
  'OFERTA IMPERDÍVEL! COMPRE JÁ! 🔥 (marketing chato + palavra proibida)',
  'aproveite essa promoção incrível 😊 (minúsculo, sem vibe, corporativo)',
  '🔥🔥🔥 CLIQUE NO LINK AGORA 🔥🔥🔥 (spam, manda clicar no link)',
  'Produto X por R$ 89,90 com 40% de desconto (frio, cita preço/desconto)',
  'AIR FRYER MONDIAL 5L PRETA 127V INMETRO (copiou o título inteiro)',
];

export const COPY_CONFIG_DEFAULT: HeadlineCopyConfig = {
  persona: PERSONA_DEFAULT,
  forbiddenWords: FORBIDDEN_WORDS_DEFAULT,
  antiExamples: ANTI_EXAMPLES_DEFAULT,
  frames: HEADLINE_FRAMES,
};
