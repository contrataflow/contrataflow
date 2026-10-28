import { describe, expect, it } from 'vitest';

import {
  DARK_TEXT,
  LIGHT_TEXT,
  brandingTheme,
  contrastRatio,
  parseHexColor,
  relativeLuminance,
} from './contrast.js';

describe('contraste (WCAG 2.1)', () => {
  it('interpreta #rrggbb e recusa outros formatos', () => {
    expect(parseHexColor('#1D4ED8')).toEqual([29, 78, 216]);
    expect(parseHexColor(' #ffffff ')).toEqual([255, 255, 255]);
    expect(parseHexColor('#fff')).toBeNull();
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('#gggggg')).toBeNull();
  });

  it('calcula luminância e razão de contraste de referência', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // A ordem dos argumentos não importa.
    expect(contrastRatio('#ffffff', '#1d4ed8')).toBeCloseTo(
      contrastRatio('#1d4ed8', '#ffffff') ?? 0,
    );
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('x', '#ffffff')).toBeNull();
  });
});

describe('brandingTheme (tema por tenant — RN-FND-91)', () => {
  it('usa texto claro sobre cor escura', () => {
    expect(brandingTheme('#1D4ED8')).toEqual({
      '--color-primary': '#1d4ed8',
      '--color-primary-foreground': LIGHT_TEXT,
      '--color-primary-hover': '#1d4ed8',
    });
  });

  it('usa texto escuro sobre cor clara', () => {
    expect(brandingTheme('#fbbf24')).toEqual({
      '--color-primary': '#fbbf24',
      '--color-primary-foreground': DARK_TEXT,
      '--color-primary-hover': '#fbbf24',
    });
  });

  it('descarta cor sem contraste suficiente com qualquer texto', () => {
    // #767676: 4,54:1 com branco (passa); #7a7a7a: ~4,3:1 com branco e ~4,2:1 com o texto escuro.
    expect(brandingTheme('#767676')?.['--color-primary-foreground']).toBe(LIGHT_TEXT);
    expect(brandingTheme('#7a7a7a')).toBeNull();
  });

  it('descarta valor ausente ou inválido', () => {
    expect(brandingTheme(null)).toBeNull();
    expect(brandingTheme(undefined)).toBeNull();
    expect(brandingTheme('')).toBeNull();
    expect(brandingTheme('azul')).toBeNull();
  });
});
