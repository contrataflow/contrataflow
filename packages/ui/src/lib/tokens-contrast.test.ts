// Contraste dos tokens de cor do design system nos dois temas (RN-FND-96 · DEC-185): lê os blocos
// de `styles.css` (claro em `@theme`, escuro em `data-theme='dark'` e em `system` escuro) e confere
// cada par texto/fundo usado pelos componentes com `contrastRatio`, que reprova abaixo de 4,5:1.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIN_TEXT_CONTRAST, contrastRatio } from './contrast.js';

/** Contraste mínimo de ícones e outros elementos gráficos (WCAG 2.1 — 1.4.11). */
const MIN_GRAPHIC_CONTRAST = 3;

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

/**
 * Pares [texto, fundo] em uso: conteúdo, primária, estados (chips, alertas, KPIs), marca, menu
 * lateral e superfície invertida dos toasts.
 */
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
  ['primary-foreground', 'primary-hover'],
  ['primary-soft-foreground', 'primary-soft'],
  ['ring', 'surface'],
  ['destructive', 'surface'],
  ['destructive', 'destructive-soft'],
  ['destructive-foreground', 'destructive'],
  ['destructive-soft-foreground', 'destructive-soft'],
  ['warning', 'surface'],
  ['warning', 'warning-soft'],
  ['warning-soft-foreground', 'warning-soft'],
  ['success', 'surface'],
  ['success', 'success-soft'],
  ['success-soft-foreground', 'success-soft'],
  ['approval', 'surface'],
  ['approval', 'approval-soft'],
  ['approval-foreground', 'approval'],
  ['approval-soft-foreground', 'approval-soft'],
  ['neutral-soft-foreground', 'neutral-soft'],
  ['neutral-soft-foreground', 'surface'],
  ['brand-ink', 'background'],
  ['brand-ink', 'surface'],
  ['brand-accent', 'background'],
  ['brand-accent', 'surface'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-muted', 'sidebar'],
  ['sidebar-accent', 'sidebar'],
  ['on-navy', 'brand-navy'],
  ['on-navy-muted', 'brand-navy'],
  ['on-navy-accent', 'brand-navy'],
  ['inverse-foreground', 'inverse'],
  ['inverse-muted', 'inverse'],
] as const;

/** Pares [ícone, fundo]: ícones de estado dos toasts sobre a superfície invertida. */
const GRAPHIC_PAIRS = [
  ['inverse-accent', 'inverse'],
  ['inverse-success', 'inverse'],
  ['inverse-destructive', 'inverse'],
] as const;

/** Tokens do design system v1 mantidos como aliases até a segunda leva da repaginação (prd-4). */
const V1_TOKENS = [
  'background',
  'foreground',
  'surface',
  'muted',
  'muted-foreground',
  'border',
  'ring',
  'primary',
  'primary-foreground',
  'primary-soft',
  'brand-navy',
  'brand-blue',
  'brand-blue-deep',
  'brand-ink',
  'brand-accent',
  'sidebar',
  'sidebar-foreground',
  'sidebar-muted',
  'sidebar-accent',
  'destructive',
  'destructive-foreground',
  'destructive-soft',
  'warning',
  'warning-soft',
  'success',
  'success-soft',
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

  it.each(GRAPHIC_PAIRS)('ícone %s sobre %s ≥ 3:1', (graphic, background) => {
    const ratio = contrastRatio(tokens[graphic] ?? '', tokens[background] ?? '');
    expect(ratio, `--color-${graphic} / --color-${background}`).not.toBeNull();
    expect(ratio).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
  });
});

describe('tokens', () => {
  it('o tema escuro só redefine tokens que existem no claro', () => {
    expect(
      Object.keys(colorTokens(":root[data-theme='dark']")).filter((name) => !(name in light)),
    ).toEqual([]);
  });

  it('os nomes do design system v1 continuam definidos (aliases)', () => {
    expect(V1_TOKENS.filter((name) => !(name in light))).toEqual([]);
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
