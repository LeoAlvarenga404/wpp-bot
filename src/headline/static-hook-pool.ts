/**
 * Fallback estático quando o gerador LLM falha ou está desligado.
 * Regra: NADA aqui pode conter palavra proibida da persona
 * (OFERTA, PROMOÇÃO, IMPERDÍVEL, DESCONTÃO, ALERTA...). Esse pool é a última
 * linha — precisa soar como o admin, não como panfleto de marketing.
 */
export const STATIC_HOOKS: string[] = [
  'OLHA ESSE PREÇO AÍ! 😱😱',
  'BAIXOU DEMAIS ESSA! 📉🔥',
  'CORRE QUE TÁ ACABANDO! 🏃‍♂️💨',
  'NÃO PERDE ESSA AÍ! 👀👀',
  'PRECINHO PARRUDO ESSE! 💪💪',
  'TÁ DE GRAÇA QUASE! 🤯🤯',
  'BICHO BOM POR ESSE VALOR! 💎🔥',
  'FECHA ESSA ANTES QUE SUBA! ⚡⚡',
  'PRECINHO BÁSICO, BORA! 🔥🔥',
  'ACHADO DO DIA CHEGOU! 💸💸',
  'ESSA TÁ VALENDO MUITO! 🤑🔥',
  'BORA GARANTIR A TUA! 🛒🔥',
  'TÁ SAINDO POR NADA! 😍😍',
  'PRESENTÃO PRA SI MESMO! 🎁🔥',
  'DESSE PREÇO NÃO PASSA! 👊🔥',
];
