import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { SettingsMapDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  buildPatchBody,
  documentMaskTypeOf,
  evaluateDrafts,
  fieldKindOf,
  groupSettings,
  hasFutureEffect,
  maskNeedsOrganization,
  maskPreviewRequest,
  parseDraft,
  scopeChanged,
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
    // 13 grupos da US-103 + "Inteligência artificial" (US-116).
    expect(groupSettings(settings)).toHaveLength(14);
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

describe('numeração da SCR-041 (US-105)', () => {
  it('máscaras (inclusive numbering.document.<TYPE>.mask) usam o editor de máscara', () => {
    expect(fieldKindOf('numbering.process.mask')).toBe('mask');
    expect(fieldKindOf('numbering.document.defaultMask')).toBe('mask');
    expect(fieldKindOf('numbering.document.RISK_MAP.mask')).toBe('mask');
    expect(documentMaskTypeOf('numbering.document.RISK_MAP.mask')).toBe('RISK_MAP');
    expect(documentMaskTypeOf('numbering.process.mask')).toBeNull();
  });

  it('corpo de SET-04: rascunho válido com escopo em edição; documento com o tipo', () => {
    expect(maskPreviewRequest('numbering.process.mask', settings, {})).toEqual({
      mask: '{seq:4}/{year}',
      scope: 'TENANT',
    });
    expect(
      maskPreviewRequest('numbering.process.mask', settings, {
        'numbering.process.mask': '{org}/{seq:4}/{year}',
        'numbering.process.scope': 'ORGANIZATION',
      }),
    ).toEqual({ mask: '{org}/{seq:4}/{year}', scope: 'ORGANIZATION' });
    expect(maskPreviewRequest('numbering.document.defaultMask', settings, {})).toEqual({
      mask: '{type} {seq:4}/{year}',
      documentTypeCode: 'DFD',
    });
    const withOverride: SettingsMapDto = {
      ...settings,
      'numbering.document.OFICIO.mask': { value: 'OF {seq:3}/{year}', version: 1 },
    };
    expect(maskPreviewRequest('numbering.document.OFICIO.mask', withOverride, {})).toEqual({
      mask: 'OF {seq:3}/{year}',
      documentTypeCode: 'OFICIO',
    });
  });

  it('rascunho inválido (ou escopo por órgão sem {org}) não gera prévia', () => {
    const mask = 'numbering.process.mask';
    expect(maskPreviewRequest(mask, settings, { [mask]: '{seq:4}' })).toBeNull();
    expect(maskPreviewRequest(mask, settings, { [mask]: '{type} {seq:4}/{year}' })).toBeNull();
    expect(
      maskPreviewRequest(mask, settings, { 'numbering.process.scope': 'ORGANIZATION' }),
    ).toBeNull();
    expect(maskPreviewRequest('labels.department', settings, {})).toBeNull();
  });

  it('aviso de escopo só quando o escopo em edição difere do gravado', () => {
    expect(scopeChanged(settings, {})).toBe(false);
    expect(scopeChanged(settings, { 'numbering.process.scope': 'TENANT' })).toBe(false);
    expect(scopeChanged(settings, { 'numbering.process.scope': 'ORGANIZATION' })).toBe(true);
  });
});
