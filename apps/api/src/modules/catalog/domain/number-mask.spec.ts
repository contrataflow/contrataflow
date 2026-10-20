import { describe, expect, it } from 'vitest';

import {
  documentSequenceKey,
  effectiveProcessScope,
  formatNumberMask,
  InvalidNumberMaskError,
  NumberMask,
  numberingYear,
  processSequenceKey,
  resolveDocumentMask,
  scopeOfProcessKey,
} from './number-mask.js';

const ORG = '0192c000-0000-7000-8000-0000000105a1';

describe('NumberMask (RN-TEN-67)', () => {
  it.each([
    ['{seq:4}/{year}', 'PROCESS', 'TENANT'],
    ['{org}-{seq:5}/{year}', 'PROCESS', 'ORGANIZATION'],
    ['{org}-{seq:4}/{year}', 'PROCESS', 'TENANT'],
    ['{type} {seq:4}/{year}', 'DOCUMENT', 'TENANT'],
    ['{type} {seq:8}/{year}', 'DOCUMENT_TYPE', 'TENANT'],
  ] as const)('aceita %s (%s, %s)', (mask, kind, scope) => {
    expect(NumberMask.problemOf(mask, kind, scope)).toBeNull();
    expect(NumberMask.parse(mask, kind, scope).value).toBe(mask);
  });

  it.each([
    ['{seq:4}', 'PROCESS', 'TENANT', 'MISSING_YEAR'],
    ['{year}', 'PROCESS', 'TENANT', 'MISSING_SEQ'],
    ['{seq}/{year}', 'PROCESS', 'TENANT', 'UNKNOWN_TOKEN'],
    ['{seq:7}/{year}', 'PROCESS', 'TENANT', 'UNKNOWN_TOKEN'],
    ['{seq:4}/{year}/{dia}', 'PROCESS', 'TENANT', 'UNKNOWN_TOKEN'],
    ['{type} {seq:4}/{year}', 'PROCESS', 'TENANT', 'TYPE_NOT_ALLOWED'],
    ['{seq:4}/{year}', 'PROCESS', 'ORGANIZATION', 'MISSING_ORG'],
    ['{type} {seq:8}/{year}', 'DOCUMENT', 'TENANT', 'UNKNOWN_TOKEN'],
  ] as const)('recusa %s (%s, %s): %s', (mask, kind, scope, problem) => {
    expect(NumberMask.problemOf(mask, kind, scope)).toBe(problem);
    let caught: unknown;
    try {
      NumberMask.parse(mask, kind, scope);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidNumberMaskError);
    expect(caught).toMatchObject({ mask, problem });
  });

  it('documento não exige {org} mesmo com escopo ORGANIZATION', () => {
    expect(NumberMask.problemOf('MR {seq:4}/{year}', 'DOCUMENT', 'ORGANIZATION')).toBeNull();
  });

  it('formata os tokens e informa se usa {org}', () => {
    const mask = NumberMask.parse('{org}-{seq:4}/{year}', 'PROCESS', 'ORGANIZATION');
    expect(mask.usesOrganization).toBe(true);
    expect(mask.format({ sequence: 12, year: 2026, organization: 'SEMED' })).toBe(
      'SEMED-0012/2026',
    );
    expect(NumberMask.parse('{seq:4}/{year}', 'PROCESS').usesOrganization).toBe(false);
    expect(formatNumberMask('{seq:4}/{year}', { sequence: 12, year: 2026 })).toBe('0012/2026');
    expect(
      formatNumberMask('{type} {seq:4}/{year}', { sequence: 5, year: 2026, type: 'DFD' }),
    ).toBe('DFD 0005/2026');
    expect(formatNumberMask('{org}/{seq:3}/{year}', { sequence: 1, year: 2026 })).toBe('/001/2026');
  });
});

describe('chaves de sequência e escopo do exercício (RN-TEN-68/70)', () => {
  it('processo: tenant (*) ou órgão; documento: por tipo no tenant', () => {
    expect(processSequenceKey('TENANT', ORG, 2026)).toBe('PROCESS:*:2026');
    expect(processSequenceKey('ORGANIZATION', ORG, 2026)).toBe(`PROCESS:${ORG}:2026`);
    expect(documentSequenceKey('RISK_MAP', 2027)).toBe('DOCUMENT:RISK_MAP:*:2027');
    expect(scopeOfProcessKey('PROCESS:*:2026')).toBe('TENANT');
    expect(scopeOfProcessKey(`PROCESS:${ORG}:2026`)).toBe('ORGANIZATION');
  });

  it('a mudança de escopo só vale no próximo exercício: o ano já aberto mantém o seu escopo', () => {
    expect(effectiveProcessScope('ORGANIZATION', null)).toBe('ORGANIZATION');
    expect(effectiveProcessScope('ORGANIZATION', 'PROCESS:*:2026')).toBe('TENANT');
    expect(effectiveProcessScope('TENANT', `PROCESS:${ORG}:2026`)).toBe('ORGANIZATION');
    expect(effectiveProcessScope('TENANT', 'PROCESS:*:2026')).toBe('TENANT');
  });

  it('ano no fuso do tenant (FA-01: virada do ano à meia-noite local)', () => {
    // 31/12/2026 23:30 em São Paulo = 01/01/2027 02:30 UTC.
    const instant = new Date('2027-01-01T02:30:00.000Z');
    expect(numberingYear(instant, 'America/Sao_Paulo')).toBe(2026);
    expect(numberingYear(instant, 'UTC')).toBe(2027);
    expect(numberingYear(new Date('2027-01-01T03:00:00.000Z'), 'America/Sao_Paulo')).toBe(2027);
  });
});

describe('resolveDocumentMask (RN-TEN-72)', () => {
  it('máscara do tipo > override da configuração > padrão', () => {
    expect(
      resolveDocumentMask({
        typeMask: 'MR {seq:4}/{year}',
        settingMask: 'X {seq:4}/{year}',
        defaultMask: '{type} {seq:4}/{year}',
      }),
    ).toEqual({ mask: 'MR {seq:4}/{year}', kind: 'DOCUMENT_TYPE' });
    expect(
      resolveDocumentMask({
        typeMask: null,
        settingMask: 'X {seq:4}/{year}',
        defaultMask: '{type} {seq:4}/{year}',
      }),
    ).toEqual({ mask: 'X {seq:4}/{year}', kind: 'DOCUMENT' });
    expect(
      resolveDocumentMask({
        typeMask: null,
        settingMask: null,
        defaultMask: '{type} {seq:4}/{year}',
      }),
    ).toEqual({ mask: '{type} {seq:4}/{year}', kind: 'DOCUMENT' });
  });
});
