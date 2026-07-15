Fiz uma análise de arquitetura e produção. Não alterei arquivos.

Veredito Curto

Seu sistema é um bom MVP avançado para Mercado Livre + WhatsApp, mas ainda não está pronto para operar como bot multicanal/multi-marketplace em produção. Ele já tem partes bem pensadas: score de oferta, histórico de preço, deduplicação, scheduler, retry, OAuth do Mercado Livre, templates, Baileys, métricas e uma abstração inicial de fontes.

Mas hoje ele ainda é, na prática: Mercado Livre-first, WhatsApp-first, single-target e file-backed.

Eu daria:

Área	Nota
MVP Mercado Livre	7/10
Produção 24/7	5/10
Multi-marketplace	3/10
WhatsApp em escala	4/10
Telegram	1/10
Compliance afiliado	3/10
Qualidade de curadoria	7/10

O Que Está Bom

A melhor parte é a curadoria. Você não está só pegando “maior desconto”. O sistema registra histórico, calcula mediana, menor preço, penaliza histórico insuficiente, avalia reputação do vendedor, frete, parcelamento e score da oferta em deal-score.service.ts (line 100).

Também gostei da separação por módulos: sources, pipeline, curation, dedup, scheduler, affiliate, whatsapp, metrics. Isso é a direção certa para crescer.

Você já começou a abstração de marketplace com DealSourcePort, RawDeal e EnrichedDeal em source.port.ts (line 3). Esse é o caminho certo para plugar Shopee, Amazon, AliExpress, Magalu etc.

O scheduler também está num bom caminho: tem modo legacy e batch, quiet hours e ranking global em scheduler.service.ts (line 19).

O Que Ainda Não Está Pronto

A abstração ainda não está realmente multi-marketplace. SourceId hoje só aceita 'ml' em source.port.ts (line 3), e o SourcesModule registra somente Mercado Livre em sources.module.ts (line 11). Então Amazon/Shopee ainda exigem mudança estrutural.

O envio ainda é single-target. Mesmo existindo TargetsService, o pipeline ignora isso e envia somente para WA_TARGET_JID em pipeline.service.ts (line 116). Para grupos, canais, Telegram e segmentação, isso precisa virar um PublisherPort.

O banco está desenhado, mas não ligado. O próprio app.module.ts (line 15) diz que DbModule/Prisma não está registrado. Hoje dedup, histórico, rate-limit, targets e links ainda dependem de JSON local. Isso quebra fácil com múltiplas instâncias, deploy em container e concorrência.

O disclaimer de afiliado está faltando. Pior: existe teste garantindo que ele não apareça em formatter.service.spec.ts (line 54). Para afiliados, isso é prioridade alta.

Os endpoints /wa/targets estão sem ApiKeyGuard em wa-health.controller.ts (line 8). Isso permite listar/adicionar/remover destinos se o app ficar exposto. É crítico.

As métricas existem, mas não são incrementadas fora de counters.service.ts (line 27). Ou seja: o /metrics está mais esqueleto do que observabilidade real.

Marketplaces

Mercado Livre: é o mais adiantado. OAuth, refresh token e /highlights fazem sentido. A própria documentação do ML indica OAuth, access token por header e refresh token de uso único, que seu sistema já trata. Fonte: Mercado Livre Developers . Falta melhorar cupons, estoque, validade de oferta, comissão, deep link oficial e persistência em banco.

Amazon: não construa em cima da PA-API antiga. A documentação da Amazon agora alerta migração para Creators API e diz que PA-API está deprecada/sem manutenção em páginas atuais . Amazon também exige PartnerTag/tracking ID para atribuição  e disclosure claro de associado . Você precisa de um AmazonSource separado e um AmazonAffiliateAdapter, não reaproveitar o adapter do ML.

Shopee: dá para entrar, mas provavelmente começa via portal/link conversion ou automação controlada. A própria ajuda da Shopee fala de link em massa, Sub IDs e links de afiliado pela plataforma , além de rastreio por Sub ID . Para produção, eu faria adapter próprio com cache, sub IDs por canal/campanha e cuidado com termos.

Telegram: é o canal mais fácil para escalar promoções. A Bot API permite enviar para chat/canal via chat_id/username de canal , e a FAQ fala em limites de broadcast e 429 acima de volume livre . Eu colocaria Telegram antes de tentar escalar WhatsApp.

WhatsApp: Baileys serve para MVP/teste/grupo pequeno, mas é arriscado para disparo comercial. A política oficial exige opt-in, opt-out e uso de templates aprovados fora da janela de 24h . A Cloud API é o caminho de produção; ela foi feita para escala, templates, webhooks e limites formais .

Problemas Técnicos Encontrados

Validações/build/testes:

npm run build passou.

npm test -- --runInBand passou: 19 suites, 143 testes.

Coverage geral: 44.34% statements. Baixo para produção. WhatsApp, affiliate, auth, metrics e controllers quase não têm cobertura.

npx eslint "{src,apps,libs,test}/**/*.ts" falhou com 349 problemas: 147 errors e 202 warnings, muitos Prettier/TypeScript.

npm audit --omit=dev encontrou 5 vulnerabilidades, incluindo crítica em protobufjs via @whiskeysockets/libsignal-node.

Também tem um detalhe ruim no CI: npm run lint usa --fix em package.json (line 15), e o GitHub Actions roda esse comando em ci.yml (line 28). CI não deveria autoformatar; deveria falhar limpo.

O Que Eu Faria Agora

Corrigir segurança imediata: proteger /wa/*, exigir API_KEY em produção, remover modo “dev aberto” em deploy e validar DTOs globalmente.
Adicionar disclaimer de afiliado obrigatório em todo template.
Migrar estado para Postgres/Prisma: dedup, preço, envios, targets, opt-out, affiliate links.
Criar PublisherPort: whatsapp-baileys, whatsapp-cloud-api, telegram, futuro site.
Criar AffiliateResolver por marketplace: ML, Shopee, Amazon, AliExpress, Magalu.
Expandir SourceId e registrar fontes por env de verdade: ml,shopee,amazon.
Trocar disparo direto por fila BullMQ/Redis com retries, rate limit por canal e idempotência.
Instrumentar métricas reais: enviados, falhas, CTR, cache hit, score médio, motivo de rejeição.
Adicionar modelo de cupom: código, validade, marketplace, restrições, preço com cupom, preço sem cupom.
Criar um painel/admin simples para aprovar ofertas antes de disparar no começo.

Minha Recomendação Estratégica

Comece com Telegram + Mercado Livre + Shopee. Use WhatsApp com cuidado, volume baixo e opt-in claro. Amazon entra depois, já pensando em Creators API e regras de disclosure.

O próximo salto técnico mais importante é transformar o projeto de “bot que envia ofertas” em uma plataforma com três camadas: fontes de oferta, curadoria/score, publicadores. Seu código já aponta nessa direção; agora precisa completar essa separação e tirar o estado crítico dos arquivos JSON.