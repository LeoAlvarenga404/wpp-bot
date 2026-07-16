/**
 * Frame sampling for hook variety. Each call to the LLM gets exactly one
 * frame as a constraint, so consecutive headlines vary structurally even
 * with identical model + temperature. This is more reliable than telling
 * the model "varie" (which it ignores once it locks onto a pattern).
 */
export interface HeadlineFrame {
  name: string;
  weight: number;
  guide: string;
  examples: string[];
  /**
   * Contra-exemplos: hooks que parecem certos mas violam o estilo/persona.
   * Ancorar o modelo no "NÃO faça assim" reduz erro mais que só mostrar
   * exemplos bons. Opcional por frame.
   */
  avoid?: string[];
}

export const HEADLINE_FRAMES: HeadlineFrame[] = [
  {
    name: 'CENA_COTIDIANA',
    weight: 2,
    guide:
      'Pinta uma cena do dia-a-dia onde o produto entra. Tipo: domingo, ' +
      'churras, faxina, viagem, treino, café da manhã, role. Frase começa ' +
      'descrevendo a situação, não o produto.',
    examples: [
      'DOMINGO DE CHURRA COM ESSE BICHÃO 🥩🔥🔥',
      'PARCELADA!! ESSA PRO DIA DE FAXINA 🔥🔥🔥',
      'ROLE NA PRAIA COM ESSE SOM AÍ 🌊🎵🔥',
      'CAFÉ DA MANHÃ DE REI COM ESSA MARAVILHA ☕☕☕',
    ],
    avoid: [
      // copia o título inteiro em vez de pintar a cena
      'AIR FRYER MONDIAL 5L PRETA 127V PRA SUA COZINHA 🔥',
      // frio/corporativo, sem cena do dia-a-dia
      'ADQUIRA JÁ ESSE PRODUTO DE QUALIDADE 😊',
    ],
  },
  {
    name: 'IMPERATIVO_GALERA',
    weight: 2,
    guide:
      'Manda a galera AGIR. Verbo no imperativo (LEVA, BORA, CORRE, GARANTE, ' +
      'PEGA, FECHA). Geralmente tom de urgência amiga.',
    examples: [
      'LEVA SEU SOM PRA ONDE FOR!! 🔥🔥🔥',
      'BORA TROCAR O VELHINHO, MEU CHAPA!! 📱🔥🔥',
      'CORRE QUE TÁ POR UM PRECINHO BÁSICO 🏃‍♂️💨💨',
      'FECHA ESSA AÍ ANTES QUE ACABE! ⚡⚡⚡',
    ],
    avoid: [
      // manda clicar no link (spam) — o link vem depois, no bloco de preço
      'CLICA NO LINK AGORA E APROVEITE 🔥🔥🔥',
      // marketing chato com palavra proibida
      'CORRE PRA ESSA OFERTA IMPERDÍVEL ⚡',
    ],
  },
  {
    name: 'BENEFICIO_USO',
    weight: 2,
    guide:
      'Foca no QUE O PRODUTO PERMITE — espaço, autonomia, performance, ' +
      'conforto. Cita a feature mais marcante (RAM, litros, polegadas, ' +
      'mAh, etc) e o efeito prático.',
    examples: [
      '512 GB PRA ENCHER DE FOTO!! 😍😍😍',
      '5200 mAh DE BATERIA PRA NÃO MORRER NA RUA! 🔋🔋',
      '10 LITROS DE AIR FRYER PRA ALIMENTAR O BATALHÃO 🍗🔥🔥',
      '12 GB DE RAM PRA RODAR ATÉ CHAMADO! 🚀🔥',
    ],
  },
  {
    name: 'COMENTARIO_PROVOCACAO',
    weight: 1,
    guide:
      'Comentário esperto, irônico ou provocando o leitor. Pode ser uma ' +
      'afirmação sarcástica sobre a vida dele.',
    examples: [
      'VOCÊ MAL TEM COMIDA AÍ PRA ENCHER ESSES POTES! 🔥🔥🔥',
      'TUA COZINHA TÁ PEDINDO ESSA AÍ HEIN 👀👀',
      'AINDA TÁ USANDO ESSE TIJOLÃO COMO CELULAR? 😂📱',
      'TEU FONE TÁ ZUANDO MAIS QUE TU FALANDO 🎧😂',
    ],
  },
  {
    name: 'REFERENCIA_PESSOA',
    weight: 1,
    guide:
      'Identifica um tipo de pessoa que precisa do produto (viciado em X, ' +
      'fã de Y, quem trabalha com Z). Sempre começa em "TODO" ou "QUEM".',
    examples: [
      'TODO VICIADO EM CAFEZINHO DEVERIA TER UM DESSE ☕☕☕',
      'QUEM AÍ TIRA FOTO DEMAIS PRECISA DESSA AQUI 📸🔥',
      'TODO FÃ DE SOM BOM JÁ PEGA ESSA AÍ 🎵🎵🔥',
      'QUEM NÃO AGUENTA MAIS LAVAR LOUÇA, TOMA 🍽️🤯',
    ],
  },
  {
    name: 'METAFORA_EXAGERO',
    weight: 1,
    guide:
      'Metáfora curta ou exagero descontraído. "BICHÃO", "PARRUDO", ' +
      '"MONSTRO", "BÁSICO QUE VAI COM TUDO".',
    examples: [
      'BASICÃO QUE VAI COM TUDO 🔥🔥🔥',
      'BICHÃO PARRUDO POR PRECINHO BÁSICO 💪🔥🔥',
      'MONSTRINHO PRA QUEM ENTENDE DO JOGO 🦖🔥',
      'BICHO POSSESSO POR ESSE VALOR 🤯🤯🤯',
    ],
  },
  {
    name: 'PRECO_CONTO',
    weight: 1,
    guide:
      'Cita explicitamente o valor usando "CONTO" no lugar de "REAIS". ' +
      'Formato: [PRODUTO/USO] POR [PREÇO] CONTO!',
    examples: [
      'AIR FRYER 10 LITROS POR 250 CONTO! 😱😱😱',
      'SMARTPHONE PARRUDO POR 599 CONTO 🤯🤯🤯',
      'FONE TOP POR 39 CONTO, BORA! 🎧🔥🔥',
      'CHALEIRA ELÉTRICA POR 53 CONTO 😍😍😍',
    ],
  },
  {
    name: 'PERGUNTA_RETORICA',
    weight: 1,
    guide:
      'Pergunta retórica que assume o leitor já tá interessado. ' +
      'Termina com interrogação + emoji surpresa.',
    examples: [
      'JÁ VIU ESSE BICHO NESSE PREÇO? 😱😱😱',
      'QUEM AÍ NUNCA QUIS UM DESSE? 👀👀',
      'ACHOU QUE NUNCA IA BAIXAR? POIS É! 🤯🔥',
      'TU AINDA TÁ NO 64 GB EM 2026? 😬📱',
    ],
  },
  {
    name: 'TROCA_UPGRADE',
    weight: 1,
    guide:
      'Cutuca o leitor a substituir algo velho. Menção a "VELHINHO", ' +
      '"ANTIGO", "BATIDO", "DA ÉPOCA".',
    examples: [
      'TÁ NA HORA DE TROCAR O TEU VELHINHO 📱🔥🔥',
      'CHEGA DAQUELE TIJOLINHO ARRANHADO 😂🔥',
      'TUA AVÓ JÁ TEM UM MELHOR QUE O TEU 👀😂',
      'APOSENTA ESSE FRITADOR ANTIGO HEIN 🍳🔥',
    ],
  },
  {
    name: 'TROCADILHO_LEVE',
    weight: 1,
    guide:
      'Trocadilho ou jogo de palavras com nome/uso do produto. Ex: ' +
      '"esfriou" para ar-condicionado, "fritou" para air fryer.',
    examples: [
      'CUPOM ESFRIOU PRA QUEM QUER ESFRIAR A CASA 🥶❄️',
      'ESSE FRITOU A CONCORRÊNCIA 🍟🔥🔥',
      'TÁ NA HORA DE DAR UM RESET NA TUA VIDA 💻🔄',
      'ESQUENTOU A PROMO!! 🔥🔥🔥',
    ],
  },
  {
    name: 'COMPARACAO_VALOR',
    weight: 1,
    guide:
      'Compara o preço com algo mundano (lanche, gasolina, pizza, ifood). ' +
      'Faz parecer absurdamente barato.',
    examples: [
      'MAIS BARATO QUE UM IFOOD DA SEXTA 🍔🤯',
      'PREÇO DE LANCHINHO POR ESSE BICHÃO 🍟🔥',
      'CUSTA MENOS QUE TEU ROLÊ DE SÁBADO 🍺💸',
      'POR ESSE VALOR ATÉ TUA TIA COMPRA 😂🔥',
    ],
  },
  {
    name: 'ELOGIO_DIRETO',
    weight: 1,
    guide:
      'Elogio direto e curto pra qualidade ou preço. Sem rodeio. ' +
      'Tom de "olha que coisa boa".',
    examples: [
      'ESSA AÍ TÁ NO PRECINHO BÁSICO!! 😍😍😍',
      'BICHO BOM POR UM VALOR DESSE 💎🔥',
      'TÁ DE GRAÇA QUASE!! 🤯🤯🤯',
      'PRESENTÃO PRA SI MESMO 🎁🔥🔥',
    ],
  },
];

export function pickFrame(
  frames: HeadlineFrame[] = HEADLINE_FRAMES,
): HeadlineFrame {
  const pool = frames.length ? frames : HEADLINE_FRAMES;
  const total = pool.reduce((s, f) => s + Math.max(0, f.weight), 0);
  if (total <= 0) return pool[0];
  let roll = Math.random() * total;
  for (const f of pool) {
    roll -= Math.max(0, f.weight);
    if (roll <= 0) return f;
  }
  return pool[0];
}
