# Copy do gerador de headline

Estes arquivos controlam **como o bot escreve os hooks** (a frase de chamada que
vai antes do bloco de preço). São lidos em runtime pelo `HeadlineConfigService`.
**Editar aqui muda a copy sem rebuild/deploy do código.** Só reiniciar o
processo (o load acontece no boot).

## Arquivos

- **`persona.md`** — o prompt de sistema, a "voz" do admin. Trocar este texto
  troca a persona inteira (#3). Ex: versão nordestina, versão mais família,
  versão mais agressiva.
- **`copy.json`** — dados estruturados:
  - `forbiddenWords` — palavras que reprovam o hook (marketing chato).
  - `antiExamples` — contra-exemplos globais injetados no prompt ("NÃO faça
    assim"). Ancorar no erro reduz erro mais que só exemplo bom.
  - `frames[]` — os estilos de hook. Cada um:
    - `name` — id do estilo (aparece na métrica `headline_frame_used_total`).
    - `weight` — peso de amostragem. **Aumentar = estilo aparece mais.** Use a
      métrica pra ver a distribuição real e tunar (#4).
    - `guide` — instrução do estilo.
    - `examples[]` — exemplos que o modelo copia a estrutura.
    - `avoid[]` — (opcional) contra-exemplos específicos desse estilo.

## Fail-safe

Arquivo faltando ou inválido → o bot usa o default embutido **daquele campo** e
loga um warning. Nunca derruba. Frame inválido no `copy.json` é ignorado
individualmente; se sobrar zero frame válido, cai para os defaults.

## Trocar de persona por deploy/audiência

Aponte `HEADLINE_CONFIG_DIR` para outra pasta com seu próprio `persona.md` +
`copy.json`. Default: `./config/headline`.

## Observabilidade

Cada headline gerada incrementa `headline_frame_used_total{frame="..."}` no
`/metrics` (Prometheus). Use pra ver qual estilo domina e ajustar os `weight`.
