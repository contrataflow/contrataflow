import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { MANUTENCAO, PREGAO, processDto } from '@test/support/process-fixtures';

import {
  buildUpdatePatch,
  conflictCurrentOf,
  editValuesOf,
  estimatedValueLock,
  isProcessEditable,
  lockedFieldsOf,
  resolveConflict,
  typedTexts,
  validateEdit,
} from './edit-process-model';

/*
 * US-005 — modelo do painel "Editar dados": PATCH só com as diferenças efetivas (FA-08), campos
 * bloqueados (RN-PROC-60/61/63), validação dos campos enviados (RN-PROC-64) e reaplicação seletiva
 * depois do 412 (FA-05).
 */

const CONTEXT = { today: '2026-10-05', currentYear: 2026, requireInternalCode: false };

describe('buildUpdatePatch (só o que mudou, normalizado como a API)', () => {
  const base = editValuesOf(processDto({ status: 'IN_PROGRESS', version: 8 }));

  it('sem alteração efetiva → corpo vazio (espaços e decimal equivalentes não contam)', () => {
    expect(buildUpdatePatch(base, { ...base, title: `  ${base.title} ` })).toEqual({});
    const valued = editValuesOf(processDto({ estimatedValue: '85000.00' }));
    expect(valued.estimatedValue).toBe('85.000,00');
    expect(buildUpdatePatch(valued, { ...valued, estimatedValue: '85000' })).toEqual({});
  });

  it('título, prioridade, prazo, modalidade e valor estimado alterados', () => {
    expect(
      buildUpdatePatch(base, {
        ...base,
        title: 'Aquisição de cimento CP-II para manutenção de vias ',
        priority: 'HIGH',
        targetDate: '2026-11-30',
        modalityId: PREGAO.id,
        estimatedValue: '85.000,5',
        notes: '   ',
      }),
    ).toEqual({
      title: 'Aquisição de cimento CP-II para manutenção de vias',
      priority: 'HIGH',
      targetDate: '2026-11-30',
      modalityId: PREGAO.id,
      estimatedValue: '85000.50',
    });
  });

  it('limpar campos opcionais envia null; campos bloqueados nunca vão no corpo', () => {
    const filled = editValuesOf(processDto({ notes: 'Antiga', targetDate: '2026-12-01' }));
    expect(
      buildUpdatePatch(filled, { ...filled, notes: '', targetDate: '' }, new Set(['notes'])),
    ).toEqual({ targetDate: null });
  });

  it('situação no PCA vai inteira quando muda (RN-PROC-12)', () => {
    expect(
      buildUpdatePatch(base, {
        ...base,
        pcaStatus: 'PLANNED',
        pcaYear: '2026',
        pcaItemCode: ' ITEM-7 ',
      }),
    ).toEqual({
      pcaStatus: 'PLANNED',
      pcaYear: 2026,
      pcaItemCode: 'ITEM-7',
      pcaJustification: null,
    });
  });
});

describe('bloqueios (RN-PROC-59/60/61/63)', () => {
  it('fora de DRAFT: órgão e unidade solicitante somente leitura', () => {
    expect(
      lockedFieldsOf(processDto({ status: 'IN_PROGRESS' }), { numberingByOrganization: false }),
    ).toEqual({
      organizationId: 'DRAFT_ONLY',
      requestingSecretariatId: 'DRAFT_ONLY',
      requestingDepartmentId: 'DRAFT_ONLY',
    });
    expect(lockedFieldsOf(processDto(), { numberingByOrganization: false })).toEqual({});
    expect(lockedFieldsOf(processDto(), { numberingByOrganization: true })).toEqual({
      organizationId: 'NUMBERING',
    });
    expect(
      lockedFieldsOf(processDto({ code: null, number: null }), { numberingByOrganization: true }),
    ).toEqual({});
  });

  it('valor estimado com fonte superior é somente leitura; manual não', () => {
    expect(estimatedValueLock(processDto({ estimatedValueSource: 'PRICE_RESEARCH' }))).toBe(
      'PRICE_RESEARCH',
    );
    expect(estimatedValueLock(processDto({ estimatedValueSource: 'MANUAL' }))).toBeNull();
    expect(estimatedValueLock(processDto())).toBeNull();
  });

  it.each([
    ['DRAFT', true],
    ['IN_PROGRESS', true],
    ['RETURNED', true],
    ['AWAITING_APPROVAL', false],
    ['SUSPENDED', false],
    ['COMPLETED', false],
  ] as const)('%s editável = %s', (status, editable) => {
    expect(isProcessEditable({ status })).toBe(editable);
  });
});

describe('validateEdit (RN-PROC-64 — só os campos enviados)', () => {
  const base = editValuesOf(processDto());

  it('título curto, prazo no passado e justificativa do PCA', () => {
    const values = {
      ...base,
      title: 'abc',
      targetDate: '2026-10-01',
      pcaStatus: 'NOT_PLANNED' as const,
    };
    const messages = validateEdit(buildUpdatePatch(base, values), values, CONTEXT);
    expect(messages.title).toBe('O título deve ter entre 5 e 200 caracteres.');
    expect(messages.targetDate).toBe('O prazo alvo não pode ser anterior a hoje.');
    expect(messages.pcaJustification).toBe(
      'Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres).',
    );
  });

  it('prazo vencido NÃO alterado não é revalidado; código interno obrigatório por configuração', () => {
    const late = editValuesOf(processDto({ targetDate: '2026-09-01', internalCode: 'PROT-1' }));
    const values = { ...late, internalCode: '' };
    expect(
      validateEdit(buildUpdatePatch(late, values), values, {
        ...CONTEXT,
        requireInternalCode: true,
      }),
    ).toEqual({ internalCode: 'O código interno é obrigatório neste órgão.' });
  });
});

describe('conflito de edição (FA-05)', () => {
  const base = processDto({ status: 'IN_PROGRESS', version: 8, priority: 'MEDIUM' });
  const current = processDto({
    status: 'IN_PROGRESS',
    version: 9,
    estimatedValue: '92450.00',
    estimatedValueSource: 'PRICE_RESEARCH',
    notes: 'Alterada pela Juliana',
  });

  it('separa os campos que a outra pessoa também alterou dos reaplicáveis', () => {
    const { conflicts, reapply } = resolveConflict(base, current, {
      priority: 'HIGH',
      notes: 'Minha observação',
    });
    expect(conflicts).toEqual([
      { field: 'notes', mine: 'Minha observação', current: 'Alterada pela Juliana' },
    ]);
    expect(reapply).toEqual({ priority: 'HIGH' });
    expect(resolveConflict(base, current, { estimatedValue: '1.00' }).conflicts).toHaveLength(1);
  });

  it('meta.current do 412', () => {
    const error = new ApiError({
      status: 412,
      code: 'VERSION_CONFLICT',
      problem: {
        type: 'https://docs.contrataflow.com.br/errors/version-conflict',
        title: 'Conflito',
        status: 412,
        detail: 'A versão enviada (8) é diferente da atual (9).',
        instance: '/api/v1/processes/x',
        code: 'VERSION_CONFLICT',
        correlationId: 'c',
        errors: [],
        violations: [],
        meta: { current: { ...current, updatedBy: { id: MANUTENCAO.id, name: 'Juliana Costa' } } },
      },
    });
    expect(conflictCurrentOf(error)).toMatchObject({
      version: 9,
      updatedBy: { name: 'Juliana Costa' },
    });
    expect(conflictCurrentOf(new ApiError({ status: 412, code: 'VERSION_CONFLICT' }))).toBeNull();
  });

  it('textos digitados para copiar (FA-06)', () => {
    const values = { ...editValuesOf(base), notes: 'Observação', description: ' ' };
    expect(typedTexts(values)).toBe(`${base.title}\n\n${base.object}\n\nObservação`);
  });
});
