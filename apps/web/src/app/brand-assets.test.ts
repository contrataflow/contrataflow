import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { viewport } from './layout';

const APP_DIR = import.meta.dirname;

describe('identidade visual no documento (DEC-185)', () => {
  it('icon.svg é o ícone vetorial com as cores da marca', () => {
    const svg = readFileSync(path.join(APP_DIR, 'icon.svg'), 'utf8');
    expect(svg).toMatch(/^<svg [^>]*viewBox="126 141 1031 1031"/);
    expect(svg).toContain('#141E2B');
    expect(svg).toContain('#005BF9');
    expect(svg.match(/<path /g)).toHaveLength(3);
  });

  it('apple-icon.png é um PNG de 180×180', () => {
    const png = readFileSync(path.join(APP_DIR, 'apple-icon.png'));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    // Cabeçalho IHDR: largura e altura nos bytes 16–23.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });

  it('a barra do navegador usa o navy da marca', () => {
    expect(viewport.themeColor).toBe('#141E2B');
  });
});
