// One-shot Mercado Livre affiliate login.
//
// Opens a HEADED Chromium at the ML linkbuilder so you can log in manually.
// When you close the window, the authenticated storage state is written to
// auth_info/playwright-state.json — the file the Playwright affiliate adapter
// reuses (headless) to mint meli.la short links.
//
// Standalone on purpose: it does NOT boot Nest or Baileys, so it never fights
// the running container for the WhatsApp session.
//
// Usage (host, needs a display):
//   node scripts/ml-login.mjs
// Then: curl -X POST http://localhost:3001/affiliate/reload -H "x-api-key: <API_KEY>"

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const LINKBUILDER_URL =
  'https://www.mercadolivre.com.br/afiliados/linkbuilder';
const STATE_PATH = path.resolve(
  process.env.PLAYWRIGHT_STATE_PATH ?? './auth_info/playwright-state.json',
);

const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
});
const context = await browser.newContext({
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
  viewport: { width: 1366, height: 768 },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});

const page = await context.newPage();
await page.goto(LINKBUILDER_URL);

console.log(
  '\n>>> Faça login no Mercado Livre nesta janela.\n' +
    '>>> Quando o linkbuilder abrir logado, FECHE a janela para salvar a sessão.\n',
);

await new Promise((resolve) => {
  page.on('close', resolve);
  browser.on('disconnected', resolve);
});

try {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await context.storageState({ path: STATE_PATH });
  console.log(`\nOK — sessão salva em ${STATE_PATH}`);
} catch (err) {
  console.error('Falha ao salvar storage state:', err);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
