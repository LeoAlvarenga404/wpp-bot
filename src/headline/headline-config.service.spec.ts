import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HeadlineConfigService } from './headline-config.service';
import { COPY_CONFIG_DEFAULT } from './headline-copy.defaults';

function configWithDir(dir?: string) {
  return {
    get: (k: string) => (k === 'HEADLINE_CONFIG_DIR' ? dir : undefined),
  } as any;
}

async function loadFrom(dir?: string): Promise<HeadlineConfigService> {
  const svc = new HeadlineConfigService(configWithDir(dir));
  await svc.onModuleInit();
  return svc;
}

describe('HeadlineConfigService', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headline-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to embedded defaults when the dir is empty', async () => {
    const svc = await loadFrom(dir);
    const cfg = svc.get();

    expect(cfg.persona).toBe(COPY_CONFIG_DEFAULT.persona);
    expect(cfg.frames).toHaveLength(COPY_CONFIG_DEFAULT.frames.length);
    expect(cfg.forbiddenWords).toEqual(COPY_CONFIG_DEFAULT.forbiddenWords);
  });

  it('loads persona.md and copy.json from disk', async () => {
    await fsp.writeFile(
      path.join(dir, 'persona.md'),
      '  Voz nordestina, arretado.  ',
    );
    await fsp.writeFile(
      path.join(dir, 'copy.json'),
      JSON.stringify({
        forbiddenWords: ['XABLAU'],
        antiExamples: ['nao faça isso'],
        frames: [
          {
            name: 'CUSTOM',
            weight: 3,
            guide: 'guia',
            examples: ['EXEMPLO BOM 🔥'],
            avoid: ['exemplo ruim'],
          },
        ],
      }),
    );

    const cfg = (await loadFrom(dir)).get();

    expect(cfg.persona).toBe('Voz nordestina, arretado.');
    expect(cfg.forbiddenWords).toEqual(['XABLAU']);
    expect(cfg.antiExamples).toEqual(['nao faça isso']);
    expect(cfg.frames).toEqual([
      {
        name: 'CUSTOM',
        weight: 3,
        guide: 'guia',
        examples: ['EXEMPLO BOM 🔥'],
        avoid: ['exemplo ruim'],
      },
    ]);
  });

  it('keeps default frames when copy.json is malformed but loads persona', async () => {
    await fsp.writeFile(path.join(dir, 'persona.md'), 'Persona custom.');
    await fsp.writeFile(path.join(dir, 'copy.json'), '{ not json ]');

    const cfg = (await loadFrom(dir)).get();

    expect(cfg.persona).toBe('Persona custom.');
    expect(cfg.frames).toHaveLength(COPY_CONFIG_DEFAULT.frames.length);
  });

  it('drops individual invalid frames and keeps valid ones', async () => {
    await fsp.writeFile(
      path.join(dir, 'copy.json'),
      JSON.stringify({
        frames: [
          { name: 'OK', weight: 1, guide: 'g', examples: ['UM HOOK 🔥'] },
          { name: 'BAD_NO_EXAMPLES', weight: 1, guide: 'g', examples: [] },
          { name: 'BAD_WEIGHT', weight: -1, guide: 'g', examples: ['x'] },
          { weight: 1, guide: 'g', examples: ['x'] }, // no name
        ],
      }),
    );

    const cfg = (await loadFrom(dir)).get();

    expect(cfg.frames.map((f) => f.name)).toEqual(['OK']);
  });

  it('uses default frames when copy.json has no valid frame', async () => {
    await fsp.writeFile(
      path.join(dir, 'copy.json'),
      JSON.stringify({
        frames: [{ name: 'BAD', weight: 1, guide: 'g', examples: [] }],
      }),
    );

    const cfg = (await loadFrom(dir)).get();

    expect(cfg.frames).toHaveLength(COPY_CONFIG_DEFAULT.frames.length);
  });
});
