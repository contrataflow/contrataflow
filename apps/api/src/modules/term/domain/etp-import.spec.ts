import { DEFAULT_TR_IMPORT_MAPPINGS } from '@contrataflow/validation';
import type { DraftSection, ImportMappings } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  applyEtpFields,
  etpChangedSinceImport,
  importFingerprint,
  importTokenExpiry,
  planEtpImport,
  selectImport,
  signImportToken,
  verifyImportToken,
} from './etp-import.js';
import type { EtpImportSource, ImportSelection, TermImportTarget } from './etp-import.js';
import { createTermOfReference } from './term-of-reference.js';
import type { TermOfReference } from './term-of-reference.js';

/*
 * US-037 — importação do ETP para o TR (RN-TR-16..24): `importMappings` (REPLACE × APPEND, com a
 * referência à origem e a proveniência de IA), POL-09 nos campos, itens especificados (FA-04),
 * impressão digital (RN-TR-19), `importToken` (assinatura, outro TR/tenant, vencimento),
 * seleção (V-01, V-05, NOT_ALLOWED) e a precedência da origem do valor (RN-TR-22).
 */

const NOW = new Date('2026-10-20T12:00:00.000Z');
const CARLA = '0192d037-0000-7000-8000-0000000000c1';
const ETP = '0192d037-0000-7000-8000-0000000000e1';
const ETP_V2 = '0192d037-0000-7000-8000-0000000000e2';
const RESEARCH = '0192d037-0000-7000-8000-0000000000b1';
const OTHER_RESEARCH = '0192d037-0000-7000-8000-0000000000b2';
const P1 = '0192d037-0000-7000-8000-0000000000f1';
const P2 = '0192d037-0000-7000-8000-0000000000f2';
const KEY = Buffer.alloc(32, 7);

function section(text: string, overrides: Partial<DraftSection> = {}): DraftSection {
  return {
    state: 'FILLED',
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    justification: null,
    revision: 1,
    updatedAt: NOW.toISOString(),
    updatedById: CARLA,
    ...overrides,
  };
}

const PENDING_AI = {
  generationId: '0192d037-0000-7000-8000-0000000000a1',
  appliedAt: NOW.toISOString(),
  appliedById: CARLA,
  reviewedAt: null,
  reviewedById: null,
};
const REVIEWED_AI = { ...PENDING_AI, reviewedAt: NOW.toISOString(), reviewedById: CARLA };

function term(overrides: Partial<TermOfReference> = {}): TermOfReference {
  return {
    ...createTermOfReference({
      documentId: 'tr-1',
      tenantId: 'tenant-a',
      processId: 'p-1',
      processObject: 'Aquisição de notebooks para as escolas',
      fieldConfig: {},
      completedResearch: null,
      creatorId: CARLA,
      now: NOW,
    }),
    ...overrides,
  };
}

function source(overrides: Partial<EtpImportSource> = {}): EtpImportSource {
  return {
    etpId: ETP,
    code: 'ETP 0001/2026',
    status: 'FINALIZED',
    versionId: ETP_V2,
    versionNumber: 2,
    documentVersion: 7,
    draftRevision: 12,
    sections: {
      RECOMMENDED_SOLUTION: section('Solução recomendada'),
      NEED_DESCRIPTION: section('Necessidade', { ai: PENDING_AI }),
      PROBLEM: section('Problema'),
      OBJECTIVE: { ...section(''), state: 'NOT_APPLICABLE', content: null },
      REQUIREMENTS: section('Requisitos', { ai: REVIEWED_AI }),
    },
    header: { estimatedTotalValue: '125000.00', priceResearchId: RESEARCH, version: 3 },
    items: [
      {
        processItemId: P1,
        sequence: 1,
        description: 'Notebook',
        quantity: '8.0000',
        calculationMemo: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '8 escolas × 1' }] }],
        },
      },
      {
        processItemId: P2,
        sequence: 2,
        description: 'Mouse',
        quantity: '16.0000',
        calculationMemo: null,
      },
    ],
    ...overrides,
  };
}

function target(overrides: Partial<TermImportTarget> = {}): TermImportTarget {
  return {
    term: term(),
    templateVersionId: 'tpl-v1',
    templateSectionKeys: new Set(['OBJECT', 'JUSTIFICATION', 'SPECIFICATIONS', 'DEADLINES']),
    documentVersion: 3,
    draftRevision: 5,
    sections: { JUSTIFICATION: section('Justificativa do TR', { ai: REVIEWED_AI }) },
    items: [{ processItemId: P1, quantity: '1.0000', notes: null }],
    specified: new Set<string>(),
    masked: false,
    ...overrides,
  };
}

const ALL: ImportSelection = {
  sections: ['OBJECT', 'JUSTIFICATION', 'SPECIFICATIONS'],
  fields: ['estimatedTotalValue', 'priceResearchId'],
  copyItems: true,
  overwriteExisting: false,
  confirmReplaceValueSource: false,
};

describe('planEtpImport (RN-TR-17 · §5.8)', () => {
  it('mapeamento padrão: REPLACE, APPEND com a referência ao ETP, campos e itens', () => {
    const plan = planEtpImport(DEFAULT_TR_IMPORT_MAPPINGS, source(), target(), {
      localDate: '2026-10-20',
    });
    // ESTIMATED_VALUE fica de fora: não está no template do teste e ESTIMATES não tem conteúdo.
    expect(plan.sections.map((planned) => planned.target)).toEqual([
      'OBJECT',
      'JUSTIFICATION',
      'SPECIFICATIONS',
    ]);
    const [object, justification, specifications] = plan.sections;
    expect(object).toMatchObject({ mode: 'REPLACE', before: '', preview: 'Solução recomendada' });
    expect(object?.ai).toBeNull();
    expect(justification).toMatchObject({
      mode: 'APPEND',
      sources: ['NEED_DESCRIPTION', 'PROBLEM', 'OBJECTIVE'],
      before: 'Justificativa do TR',
      preview: 'Justificativa do TR\nImportado do ETP v2 em 20/10/2026\nNecessidade\nProblema',
    });
    // APPEND: mantém a proveniência do destino e a deixa pendente (origem pendente).
    expect(justification?.ai).toMatchObject({
      generationId: REVIEWED_AI.generationId,
      reviewedAt: null,
      reviewedById: null,
    });
    // REPLACE de origem revisada chega sem pendência.
    expect(specifications?.ai).toBeNull();
    expect(plan.fields).toEqual([
      {
        target: 'estimatedTotalValue',
        source: 'estimatedTotalValue',
        value: '125000.00',
        valueMasked: false,
        current: null,
      },
      {
        target: 'priceResearchId',
        source: 'priceResearchId',
        value: RESEARCH,
        valueMasked: false,
        current: null,
      },
    ]);
    expect(plan.items).toEqual([
      expect.objectContaining({
        processItemId: P1,
        etpQuantity: '8.0000',
        trCurrentQuantity: '1.0000',
      }),
      expect.objectContaining({
        processItemId: P2,
        etpQuantity: '16.0000',
        trCurrentQuantity: null,
      }),
    ]);
    expect(plan.items[0]?.notes).toBeUndefined();
    expect(plan.copyQuantities).toBe(true);
    expect(plan.replacesPriceResearchValue).toBe(false);
  });

  it('REPLACE com origem pendente leva a proveniência; ETP sem versão marca a data só', () => {
    const plan = planEtpImport(
      {
        ...DEFAULT_TR_IMPORT_MAPPINGS,
        sections: [
          { target: 'OBJECT', sources: ['NEED_DESCRIPTION'], mode: 'REPLACE' },
          { target: 'DEADLINES', sources: ['PROBLEM'], mode: 'APPEND' },
        ],
      },
      source({ versionNumber: null, versionId: null }),
      target(),
      { localDate: '2026-10-20' },
    );
    expect(plan.sections[0]?.ai).toEqual(PENDING_AI);
    // APPEND num destino vazio: sem proveniência a manter, a origem revisada não traz nenhuma.
    expect(plan.sections[1]).toMatchObject({
      preview: 'Importado do ETP em 20/10/2026\nProblema',
      ai: null,
    });
  });

  it('POL-09: valor mascarado; FA-04: item especificado; memória nas observações', () => {
    const mappings: ImportMappings = {
      ...DEFAULT_TR_IMPORT_MAPPINGS,
      items: { copyQuantities: false, copyCalculationMemoToNotes: true },
    };
    const plan = planEtpImport(
      mappings,
      source(),
      target({
        masked: true,
        specified: new Set([P1, P2]),
        term: term({
          estimatedTotalValue: '98000.00',
          estimatedValueSource: 'PRICE_RESEARCH',
          priceResearchId: OTHER_RESEARCH,
        }),
      }),
      { localDate: '2026-10-20' },
    );
    expect(plan.fields[0]).toMatchObject({ value: null, valueMasked: true, current: null });
    expect(plan.fields[1]).toMatchObject({ value: RESEARCH, current: OTHER_RESEARCH });
    // Só P1 está no TR: P2 especificado "sem linha" não conta.
    expect(plan.items.map((item) => item.specified)).toEqual([true, false]);
    expect(plan.items[0]?.notes).toBe('8 escolas × 1');
    expect(plan.copyQuantities).toBe(false);
    // Mascarado: a prévia não oferece o valor, então não há troca de origem a confirmar.
    expect(plan.replacesPriceResearchValue).toBe(false);
  });

  it('sem mapeamento: só os itens; sem cabeçalho: sem campos; destino repetido uma vez', () => {
    const plan = planEtpImport(null, source({ header: null }), target(), {
      localDate: '2026-10-20',
    });
    expect(plan.sections).toEqual([]);
    expect(plan.fields).toEqual([]);
    expect(plan.items).toHaveLength(2);
    const twice = planEtpImport(
      {
        ...DEFAULT_TR_IMPORT_MAPPINGS,
        sections: [
          { target: 'OBJECT', sources: ['RECOMMENDED_SOLUTION'], mode: 'REPLACE' },
          { target: 'OBJECT', sources: ['PROBLEM'], mode: 'REPLACE' },
        ],
        fields: [
          { target: 'estimatedTotalValue', source: 'estimatedTotalValue' },
          { target: 'estimatedTotalValue', source: 'estimatedTotalValue' },
          { target: 'objectDefinition', source: 'estimatedTotalValue' },
        ],
      },
      source({ header: { estimatedTotalValue: null, priceResearchId: null, version: 1 } }),
      target(),
      { localDate: '2026-10-20' },
    );
    expect(twice.sections).toHaveLength(1);
    // Valor nulo na origem não é oferecido.
    expect(twice.fields).toEqual([]);
  });
});

describe('importFingerprint (RN-TR-19)', () => {
  it('muda quando o ETP ou o TR mudam; igual para o mesmo estado', () => {
    const base = importFingerprint(source(), target());
    expect(importFingerprint(source(), target())).toBe(base);
    expect(importFingerprint(source({ draftRevision: 13 }), target())).not.toBe(base);
    expect(importFingerprint(source({ versionId: P1 }), target())).not.toBe(base);
    expect(importFingerprint(source(), target({ draftRevision: 6 }))).not.toBe(base);
    expect(importFingerprint(source(), target({ term: term({ version: 2 }) }))).not.toBe(base);
    expect(
      importFingerprint(
        source(),
        target({ items: [{ processItemId: P1, quantity: '2.0000', notes: null }] }),
      ),
    ).not.toBe(base);
  });
});

describe('importToken (RN-TR-18)', () => {
  const claims = {
    tenantId: 'tenant-a',
    termId: 'tr-1',
    etpId: ETP,
    etpVersionId: ETP_V2,
    fingerprint: 'abc',
    expiresAt: importTokenExpiry(NOW),
  };
  const expected = { tenantId: 'tenant-a', termId: 'tr-1', now: NOW };

  it('válido por 15 minutos', () => {
    expect(claims.expiresAt.toISOString()).toBe('2026-10-20T12:15:00.000Z');
    const token = signImportToken(claims, KEY);
    expect(verifyImportToken(token, KEY, expected)).toEqual({ kind: 'VALID', claims });
    expect(
      verifyImportToken(token, KEY, { ...expected, now: new Date('2026-10-20T12:15:00.000Z') }),
    ).toEqual({ kind: 'EXPIRED' });
  });

  it('adulterado, de outra chave, de outro TR/tenant ou malformado = inválido', () => {
    const token = signImportToken(claims, KEY);
    const [prefix, body, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ n: 'tenant-a', t: 'tr-1', e: ETP, v: null, f: 'zzz', x: 9e15 }),
    ).toString('base64url');
    expect(
      verifyImportToken(`${String(prefix)}.${forged}.${String(signature)}`, KEY, expected),
    ).toEqual({
      kind: 'INVALID',
    });
    expect(verifyImportToken(token, Buffer.alloc(32, 8), expected).kind).toBe('INVALID');
    expect(verifyImportToken(token, KEY, { ...expected, termId: 'tr-2' }).kind).toBe('INVALID');
    expect(verifyImportToken(token, KEY, { ...expected, tenantId: 'tenant-b' }).kind).toBe(
      'INVALID',
    );
    expect(verifyImportToken('lixo', KEY, expected).kind).toBe('INVALID');
    expect(verifyImportToken(`v1.${String(body)}`, KEY, expected).kind).toBe('INVALID');
    const notJson = Buffer.from('não é json').toString('base64url');
    const signed = signImportToken(claims, KEY).split('.')[2];
    expect(verifyImportToken(`v1.${notJson}.${String(signed)}`, KEY, expected).kind).toBe(
      'INVALID',
    );
  });
});

describe('selectImport (RN-TR-20..23 · V-01/V-05)', () => {
  const plan = planEtpImport(DEFAULT_TR_IMPORT_MAPPINGS, source(), target(), {
    localDate: '2026-10-20',
  });

  it('tudo marcado: seções, campos e itens', () => {
    const result = selectImport(plan, term(), ALL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selected.sections).toHaveLength(3);
    expect(result.selected.fields).toHaveLength(2);
    expect(result.selected.items).toHaveLength(2);
  });

  it('seção fora da prévia = NOT_ALLOWED; nada efetivo = V-01', () => {
    expect(selectImport(plan, term(), { ...ALL, sections: ['SANCTIONS'] })).toEqual({
      ok: false,
      errors: [expect.objectContaining({ field: 'sections', code: 'NOT_ALLOWED' })],
    });
    expect(
      selectImport(plan, term(), { ...ALL, sections: [], fields: [], copyItems: false }),
    ).toEqual({
      ok: false,
      errors: [expect.objectContaining({ field: 'sections', code: 'REQUIRED' })],
    });
  });

  it('PRICE_RESEARCH: substituir o valor exige confirmação; a pesquisa sozinha não troca', () => {
    const linked = term({
      estimatedTotalValue: '98000.00',
      estimatedValueSource: 'PRICE_RESEARCH',
      priceResearchId: OTHER_RESEARCH,
    });
    expect(selectImport(plan, linked, ALL)).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          field: 'confirmReplaceValueSource',
          code: 'CONDITIONAL_REQUIRED',
        }),
      ],
    });
    expect(selectImport(plan, linked, { ...ALL, confirmReplaceValueSource: true }).ok).toBe(true);
    expect(selectImport(plan, linked, { ...ALL, fields: ['priceResearchId'] })).toEqual({
      ok: false,
      errors: [expect.objectContaining({ field: 'fields', code: 'NOT_ALLOWED' })],
    });
    // A mesma pesquisa do ETP: nada muda, é aceito.
    expect(
      selectImport(
        plan,
        { ...linked, priceResearchId: RESEARCH },
        {
          ...ALL,
          fields: ['priceResearchId'],
        },
      ).ok,
    ).toBe(true);
  });

  it('FA-04: item especificado só com overwriteExisting; FA-05: valor mascarado é ignorado', () => {
    const specified = planEtpImport(
      DEFAULT_TR_IMPORT_MAPPINGS,
      source(),
      target({ specified: new Set([P1]), masked: true }),
      { localDate: '2026-10-20' },
    );
    const without = selectImport(specified, term(), ALL);
    expect(without.ok && without.selected.items.map((item) => item.processItemId)).toEqual([P2]);
    expect(without.ok && without.selected.fields.map((field) => field.target)).toEqual([
      'priceResearchId',
    ]);
    const overwrite = selectImport(specified, term(), { ...ALL, overwriteExisting: true });
    expect(overwrite.ok && overwrite.selected.items).toHaveLength(2);
  });
});

describe('applyEtpFields (RN-TR-22/24)', () => {
  const plan = planEtpImport(DEFAULT_TR_IMPORT_MAPPINGS, source(), target(), {
    localDate: '2026-10-20',
  });
  const stamp = { etpId: ETP, etpVersionId: ETP_V2, actorId: CARLA, now: NOW };

  it('valor importado: origem ETP, pesquisa do ETP e a rastreabilidade', () => {
    const { term: next, changes } = applyEtpFields(term(), plan.fields, stamp);
    expect(next).toMatchObject({
      estimatedTotalValue: '125000.00',
      estimatedValueSource: 'ETP',
      priceResearchId: RESEARCH,
      importedFromEtpId: ETP,
      importedFromEtpVersionId: ETP_V2,
      importedAt: NOW,
      importedById: CARLA,
    });
    expect(changes.map((change) => change.field)).toEqual([
      'estimatedTotalValue',
      'estimatedValueSource',
      'priceResearchId',
      'importedFromEtpId',
      'importedFromEtpVersionId',
    ]);
  });

  it('sem campos: só a rastreabilidade; o valor fica como estava', () => {
    const current = term({ estimatedTotalValue: '10.00', estimatedValueSource: 'MANUAL' });
    const { term: next, changes } = applyEtpFields(current, [], stamp);
    expect(next).toMatchObject({ estimatedTotalValue: '10.00', estimatedValueSource: 'MANUAL' });
    expect(changes.map((change) => change.field)).toEqual([
      'importedFromEtpId',
      'importedFromEtpVersionId',
    ]);
  });
});

describe('etpChangedSinceImport (RN-TR-24)', () => {
  it('só depois de importar e com outra versão vigente', () => {
    const imported = { importedFromEtpId: ETP, importedFromEtpVersionId: ETP_V2 };
    expect(etpChangedSinceImport(imported, { currentVersionId: ETP_V2 })).toBe(false);
    expect(etpChangedSinceImport(imported, { currentVersionId: P1 })).toBe(true);
    expect(etpChangedSinceImport(imported, null)).toBe(false);
    expect(etpChangedSinceImport(imported, { currentVersionId: null })).toBe(false);
    expect(
      etpChangedSinceImport(
        { importedFromEtpId: null, importedFromEtpVersionId: null },
        { currentVersionId: P1 },
      ),
    ).toBe(false);
  });
});
