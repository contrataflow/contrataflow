// Contraste dos tokens de cor do design system nos dois temas (RN-FND-96 · DEC-185): lê os blocos
// de `styles.css` (claro em `@theme`, escuro em `data-theme='dark'` e em `system` escuro) e confere
// cada par texto/fundo usado pelos componentes com `contrastRatio`, que reprova abaixo de 4,5:1.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIN_TEXT_CONTRAST, contrastRatio } from './contrast.js';

const CSS = readFileSync(path.join(import.meta.dirname, '..', 'styles.css'), 'utf8');

/** Variáveis `--color-*` do primeiro bloco `{…}` que segue o seletor. */
function colorTokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`Bloco ${selector} não encontrado em styles.css`);
  const open = CSS.indexOf('{', start);
  const body = CSS.slice(open + 1, CSS.indexOf('}', open));
  return Object.fromEntries(
    [...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(
      ([, name = '', value = '']) => [name, value.toLowerCase()] as const,
    ),
  );
}

const light = colorTokens('@theme');
/** O tema escuro sobrescreve só parte dos tokens; o restante vem de `@theme`. */
const dark = { ...light, ...colorTokens(":root[data-theme='dark']") };
const system = { ...light, ...colorTokens(":root[data-theme='system']") };

/** Pares [texto, fundo] em uso: conteúdo, primária, estados, marca e menu lateral. */
const PAIRS = [
  ['foreground', 'background'],
  ['foreground', 'surface'],
  ['foreground', 'muted'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'surface'],
  ['muted-foreground', 'muted'],
  ['primary', 'background'],
  ['primary', 'surface'],
  ['primary', 'muted'],
  ['primary', 'primary-soft'],
  ['primary-foreground', 'primary'],
  ['ring', 'surface'],
  ['destructive', 'surface'],
  ['destructive', 'destructive-soft'],
  ['destructive-foreground', 'destructive'],
  ['warning', 'surface'],
  ['warning', 'warning-soft'],
  ['success', 'surface'],
  ['success', 'success-soft'],
  ['brand-ink', 'background'],
  ['brand-ink', 'surface'],
  ['brand-accent', 'background'],
  ['brand-accent', 'surface'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-muted', 'sidebar'],
  ['sidebar-accent', 'sidebar'],
] as const;

describe.each([
  ['claro', light],
  ['escuro', dark],
])('tokens do tema %s', (_theme, tokens) => {
  it.each(PAIRS)('%s sobre %s ≥ 4,5:1', (text, background) => {
    const ratio = contrastRatio(tokens[text] ?? '', tokens[background] ?? '');
    expect(ratio, `--color-${text} / --color-${background}`).not.toBeNull();
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});

describe('tema escuro por preferência do sistema', () => {
  it('repete os tokens de data-theme=dark', () => {
    expect(system).toEqual(dark);
  });
});

describe('marca', () => {
  it('navy e azul oficiais não mudam com o tema', () => {
    expect([light['brand-navy'], light['brand-blue'], light['brand-blue-deep']]).toEqual([
      '#141e2b',
      '#005bf9',
      '#004be3',
    ]);
    expect(colorTokens(":root[data-theme='dark']")).not.toHaveProperty('brand-blue');
  });

  it('botões de e-mail em azul profundo têm texto branco legível', () => {
    expect(contrastRatio('#ffffff', light['brand-blue-deep'] ?? '')).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST,
    );
  });
});
