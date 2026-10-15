import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { SettingsMapDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  buildPatchBody,
  evaluateDrafts,
  fieldKindOf,
  groupSettings,
  hasFutureEffect,
  maskNeedsOrganization,
  parseDraft,
  toDraft,
} from './settings-model';

const settings: SettingsMapDto = Object.fromEntries(
  SETTING_DEFINITIONS.map((definition) => [
    definition.key,
    { value: definition.defaultValue, version: 1 },
  ]),
);

describe('modelo da SCR-041', () => {
  it('agrupa pelo prefixo na ordem da tela e ignora grupos sem chaves', () => {
    const groups = groupSettings({
      'security.mfaPolicy': { value: 'ADMINS', version: 1 },
      'labels.department': { value: 'Setor', version: 1 },
      'features.beta': { value: true, version: 1 },
    });
    expect(groups.map((group) => [group.group, group.keys])).toEqual([
      ['labels', ['labels.department']],
      ['security', ['security.mfaPolicy']],
      ['features', ['features.beta']],
    ]);
    expect(groupSettings(settings)).toHaveLength(13);
  });

  it('escolhe o editor pelo tipo da chave', () => {
    expect(fieldKindOf('labels.secretariat')).toBe('text');
    expect(fieldKindOf('branding.primaryColor')).toBe('color');
    expect(fieldKindOf('branding.logoAttachmentId')).toBe('readonly');
    expect(fieldKindOf('numbering.process.mask')).toBe('mask');
    expect(fieldKindOf('security.mfaPolicy')).toBe('select');
    expect(fieldKindOf('priceResearch.unitPriceDecimals')).toBe('select');
    expect(fieldKindOf('security.sessionIdleMinutes')).toBe('integer');
    expect(fieldKindOf('priceResearch.cvThresholdPercent')).toBe('number');
    expect(fieldKindOf('process.requireInternalCode')).toBe('boolean');
    expect(fieldKindOf('features.beta')).toBe('boolean');
    expect(fieldKindOf('uploads.allowedExtensions')).toBe('extensions');
    expect(fieldKindOf('risk.scale')).toBe('json');
    expect(hasFutureEffect('numbering.process.scope')).toBe(true);
    expect(hasFutureEffect('labels.secretariat')).toBe(false);
  });

  it('rascunho ↔ valor: números, JSON, seleção numérica e extensões', () => {
    expect(toDraft('security.sessionIdleMinutes', 30)).toBe('30');
    expect(toDraft('priceResearch.unitPriceDecimals', 2)).toBe('2');
    expect(parseDraft('priceResearch.unitPriceDecimals', '4')).toEqual({ ok: true, value: 4 });
    expect(parseDraft('priceResearch.cvThresholdPercent', '12,5')).toEqual({
      ok: true,
      value: 12.5,
    });
    expect(parseDraft('security.sessionIdleMinutes', '')).toEqual({ ok: false, reason: 'number' });
    expect(parseDraft('security.sessionIdleMinutes', '3')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(parseDraft('risk.scale', '{')).toEqual({ ok: false, reason: 'json' });
    expect(parseDraft('uploads.allowedExtensions', ['pdf'])).toEqual({ ok: true, value: ['pdf'] });
    expect(parseDraft('uploads.allowedExtensions', [])).toMatchObject({ ok: false });
    expect(parseDraft('branding.primaryColor', '#1d4ed8')).toEqual({ ok: true, value: '#1D4ED8' });
    expect(parseDraft('branding.primaryColor', '#FFFF00')).toEqual({
      ok: false,
      reason: 'contrast',
    });
    expect(parseDraft('features.beta', true)).toEqual({ ok: true, value: true });
  });

  it('avalia só o que mudou e monta o corpo do PATCH com a versão de cada chave', () => {
    const evaluation = evaluateDrafts(
      { ...settings, 'labels.secretariat': { value: 'Secretaria', version: 4 } },
      {
        'labels.secretariat': 'Diretoria',
        'labels.department': 'Setor',
        'security.sessionIdleMinutes': 'abc',
        'nao.existe': 'x',
      },
    );
    expect(evaluation.changes).toEqual([
      { key: 'labels.secretariat', value: 'Diretoria', version: 4 },
    ]);
    expect(evaluation.errors).toEqual({ 'security.sessionIdleMinutes': 'number' });
    expect(buildPatchBody(evaluation.changes)).toEqual({
      values: { 'labels.secretariat': 'Diretoria' },
      expectedVersions: { 'labels.secretariat': 4 },
    });
  });

  it('escopo por órgão exige {org} só quando o formulário mexe em máscara ou escopo', () => {
    expect(maskNeedsOrganization(settings, {})).toBe(false);
    expect(maskNeedsOrganization(settings, { 'numbering.process.scope': 'ORGANIZATION' })).toBe(
      true,
    );
    expect(
      maskNeedsOrganization(settings, {
        'numbering.process.scope': 'ORGANIZATION',
        'numbering.process.mask': '{org}-{seq:4}/{year}',
      }),
    ).toBe(false);
    expect(maskNeedsOrganization(settings, { 'numbering.process.mask': '{seq:4}/{year}' })).toBe(
      false,
    );
  });
});
