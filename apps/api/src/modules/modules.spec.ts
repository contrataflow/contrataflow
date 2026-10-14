import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { API_MODULES } from './index.js';

const MODULES_DIR = fileURLToPath(new URL('.', import.meta.url));
const LEVELS_FILE = fileURLToPath(new URL('../../../../tools/module-levels.json', import.meta.url));

const declared = (
  JSON.parse(readFileSync(LEVELS_FILE, 'utf8')) as { levels: { modules: string[] }[] }
).levels.flatMap((level) => level.modules);

const pascal = (name: string) =>
  name
    .split('-')
    .map((part) => (part[0] ?? '').toUpperCase() + part.slice(1))
    .join('');

describe('módulos de DEC-040 (RN-FND-29)', () => {
  it('as pastas de src/modules são exatamente os módulos declarados em tools/module-levels.json', () => {
    const folders = readdirSync(MODULES_DIR).filter((entry) =>
      statSync(`${MODULES_DIR}/${entry}`).isDirectory(),
    );
    expect(folders.sort()).toEqual([...declared].sort());
  });

  it('todos estão registrados em API_MODULES (importado pelo AppModule)', () => {
    expect(API_MODULES.map((module) => module.name).sort()).toEqual(
      declared.map((name) => `${pascal(name)}Module`).sort(),
    );
  });

  it.each(declared)('%s tem as quatro camadas de DEC-041, o módulo Nest e o README', (name) => {
    for (const layer of ['domain', 'application', 'infrastructure', 'presentation']) {
      expect(statSync(`${MODULES_DIR}/${name}/${layer}`).isDirectory()).toBe(true);
    }
    expect(existsSync(`${MODULES_DIR}/${name}/${name}.module.ts`)).toBe(true);
    expect(readFileSync(`${MODULES_DIR}/${name}/README.md`, 'utf8')).toMatch(/DEC-040/);
  });
});
