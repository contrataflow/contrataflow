import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { SettingDefinition } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SettingsRegistry, SettingsRegistryError } from './settings-registry.js';

const registry = new SettingsRegistry([SETTING_DEFINITIONS]);

function definition(overrides: Partial<SettingDefinition> = {}): SettingDefinition {
  return {
    key: 'labels.extra',
    group: 'labels',
    module: 'organization',
    schema: z.string(),
    defaultValue: 'x',
    isPublic: false,
    ...overrides,
  };
}

describe('SettingsRegistry (RN-TEN-52/53)', () => {
  it('contém as chaves de entities.md §6, todas com padrão válido no próprio schema', () => {
    expect(registry.definitions()).toHaveLength(32);
    for (const item of registry.definitions()) {
      expect(item.schema.safeParse(item.defaultValue).success, item.key).toBe(true);
    }
  });

  it('só labels.* e branding.* são públicas (RN-TEN-56)', () => {
    const publicKeys = registry.publicDefinitions().map((item) => item.key);
    expect(publicKeys).toEqual([
      'labels.secretariat',
      'labels.department',
      'branding.primaryColor',
      'branding.logoAttachmentId',
    ]);
    expect(registry.definitions().filter((item) => !item.isPublic)).toHaveLength(28);
  });

  it('chave duplicada entre módulos impede o boot', () => {
    expect(
      () => new SettingsRegistry([[definition()], [definition({ module: 'process' })]]),
    ).toThrow(SettingsRegistryError);
  });

  it('chave fora do grupo ou com padrão que não passa no schema impede o boot', () => {
    expect(() => new SettingsRegistry([[definition({ group: 'branding' })]])).toThrow(
      /não pertence ao grupo/,
    );
    expect(() => new SettingsRegistry([[definition({ defaultValue: 42 })]])).toThrow(
      /próprio schema/,
    );
  });

  it('chave desconhecida não existe; features.<flag> é booleana e nunca pública (DEC-059)', () => {
    expect(registry.definition('labels.nada')).toBeNull();
    expect(registry.definition('features')).toBeNull();
    expect(registry.definition('features.1invalida')).toBeNull();
    const flag = registry.definition('features.novaTela');
    expect(flag).toMatchObject({ group: 'features', defaultValue: false, isPublic: false });
    expect(registry.parse('features.novaTela', true)).toEqual({ ok: true, value: true });
    expect(registry.parse('features.novaTela', 'sim')).toMatchObject({ ok: false });
    expect(registry.parse('nao.existe', 1)).toBeNull();
  });

  describe('limites de entities.md §6', () => {
    const valid = (key: string, value: unknown) => registry.parse(key, value)?.ok === true;

    it('inteiros com intervalo', () => {
      expect(valid('security.sessionIdleMinutes', 5)).toBe(true);
      expect(valid('security.sessionIdleMinutes', 120)).toBe(true);
      expect(valid('security.sessionIdleMinutes', 4)).toBe(false);
      expect(valid('security.sessionIdleMinutes', 30.5)).toBe(false);
      expect(valid('security.sessionAbsoluteHours', 25)).toBe(false);
      expect(valid('security.externalMembershipMaxDays', 365)).toBe(true);
      expect(valid('security.externalMembershipMaxDays', 0)).toBe(false);
      expect(valid('deadlines.warnBeforeBusinessDays', 0)).toBe(true);
      expect(valid('deadlines.warnBeforeBusinessDays', 11)).toBe(false);
      expect(valid('priceResearch.minQuotations', 11)).toBe(false);
      expect(valid('process.duplicateDetectionWindowMinutes', 0)).toBe(true);
      expect(valid('uploads.maxFileSizeMb', 100)).toBe(true);
      expect(valid('uploads.maxFileSizeMb', 101)).toBe(false);
    });

    it('enums e literais', () => {
      expect(valid('security.mfaPolicy', 'ALL')).toBe(true);
      expect(valid('security.mfaPolicy', 'MAYBE')).toBe(false);
      expect(valid('priceResearch.defaultMethod', 'MEDIAN')).toBe(true);
      expect(valid('priceResearch.defaultMethod', 'MODE')).toBe(false);
      expect(valid('priceResearch.unitPriceDecimals', 4)).toBe(true);
      expect(valid('priceResearch.unitPriceDecimals', 3)).toBe(false);
      expect(valid('priceResearch.roundingMode', 'HALF_EVEN')).toBe(true);
      expect(valid('numbering.process.scope', 'ORGANIZATION')).toBe(true);
      expect(valid('numbering.process.assignOn', 'END')).toBe(false);
    });

    it('cor da marca: #RRGGBB com contraste AA contra branco; logotipo uuid ou nulo', () => {
      expect(valid('branding.primaryColor', '#1D4ED8')).toBe(true);
      expect(valid('branding.primaryColor', '#ffff00')).toBe(false);
      expect(valid('branding.primaryColor', '#FFF')).toBe(false);
      expect(registry.parse('branding.primaryColor', '#1d4ed8')).toEqual({
        ok: true,
        value: '#1D4ED8',
      });
      expect(valid('branding.logoAttachmentId', null)).toBe(true);
      expect(valid('branding.logoAttachmentId', 'nao-e-uuid')).toBe(false);
    });

    it('máscaras de numeração exigem {seq:N} e {year}', () => {
      expect(valid('numbering.process.mask', '{seq:4}/{year}')).toBe(true);
      expect(valid('numbering.process.mask', 'PROC-{seq:4}')).toBe(false);
      expect(valid('numbering.document.defaultMask', '{type} {seq:4}/{year}')).toBe(true);
      expect(valid('numbering.document.defaultMask', '{year}')).toBe(false);
    });

    it('extensões de upload: subconjunto da allowlist da plataforma, sem repetição', () => {
      expect(valid('uploads.allowedExtensions', ['pdf', 'png'])).toBe(true);
      expect(valid('uploads.allowedExtensions', [])).toBe(false);
      expect(valid('uploads.allowedExtensions', ['pdf', 'pdf'])).toBe(false);
      expect(valid('uploads.allowedExtensions', ['exe'])).toBe(false);
    });

    it('escala e faixas de risco: rótulos por nível, faixas contíguas sem lacunas', () => {
      const scale = { max: 3, probabilityLabels: ['A', 'B', 'C'], impactLabels: ['X', 'Y', 'Z'] };
      expect(valid('risk.scale', scale)).toBe(true);
      expect(valid('risk.scale', { ...scale, max: 4 })).toBe(false);
      expect(valid('risk.scale', { ...scale, max: 6 })).toBe(false);

      const band = (level: string, minScore: number, maxScore: number) => ({
        level,
        minScore,
        maxScore,
      });
      expect(valid('risk.levelThresholds', [band('LOW', 1, 3), band('HIGH', 4, 9)])).toBe(true);
      expect(valid('risk.levelThresholds', [band('LOW', 1, 3), band('HIGH', 5, 9)])).toBe(false);
      expect(valid('risk.levelThresholds', [band('LOW', 2, 3)])).toBe(false);
      expect(valid('risk.levelThresholds', [band('LOW', 1, 3), band('LOW', 4, 9)])).toBe(false);
      expect(valid('risk.levelThresholds', [band('LOW', 1, 4), band('HIGH', 4, 9)])).toBe(false);
    });
  });
});
