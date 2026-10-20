import { describe, expect, it } from 'vitest';

import {
  canDeleteEtpAlternative,
  createEtpAlternative,
  diffEtpAlternative,
  isNameTaken,
  money,
  patchEtpAlternative,
  planDecision,
  setRecommendedAlternative,
  touchEtpAlternative,
} from './etp-alternative.js';
import type { EtpAlternative } from './etp-alternative.js';
import { createEtp } from './etp.js';

const NOW = new Date('2026-10-18T10:00:00.000Z');
const LATER = new Date('2026-10-18T11:00:00.000Z');
const ETP = { id: 'etp-1', tenantId: 'tenant-a', processId: 'process-1' };
const USER = 'user-carla';
const JUSTIFICATION = 'A locação reduz o custo total em 30% no período.';

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function alternative(id: string, overrides: Partial<EtpAlternative> = {}): EtpAlternative {
  return {
    ...createEtpAlternative(
      { name: `Alternativa ${id}`, description: doc('Descrição da alternativa.') },
      { id, etp: ETP, sortOrder: 0, now: NOW, userId: USER },
    ),
    ...overrides,
  };
}

describe('createEtpAlternative (RN-ETP-18/19)', () => {
  it('nasce UNDER_ANALYSIS, sem justificativa, versão 1, no tenant/processo do ETP', () => {
    const created = createEtpAlternative(
      {
        name: 'Locação de equipamentos',
        description: doc('Locação mensal.'),
        estimatedCost: '15000',
        riskLevel: 'LOW',
        observations: 'Cotação informal.',
      },
      { id: 'alt-1', etp: ETP, sortOrder: 3, now: NOW, userId: USER },
    );
    expect(created).toMatchObject({
      id: 'alt-1',
      tenantId: 'tenant-a',
      etpId: 'etp-1',
      processId: 'process-1',
      decision: 'UNDER_ANALYSIS',
      decisionJustification: null,
      estimatedCost: '15000.00',
      riskLevel: 'LOW',
      advantages: null,
      disadvantages: null,
      sortOrder: 3,
      version: 1,
      createdById: USER,
    });
  });

  it('money normaliza para 2 casas', () => {
    expect(money('15000')).toBe('15000.00');
    expect(money('12.5')).toBe('12.50');
    expect(money('0.99')).toBe('0.99');
    expect(money(null)).toBeNull();
    expect(money(undefined)).toBeNull();
  });
});

describe('patch/diff/touch (ETP-07)', () => {
  it('aplica só os campos informados; null limpa os opcionais', () => {
    const current = alternative('a', {
      estimatedCost: '100.00',
      riskLevel: 'HIGH',
      advantages: doc('Vantagem'),
    });
    const next = patchEtpAlternative(current, {
      estimatedCost: null,
      advantages: null,
      sortOrder: 4,
      name: 'Novo nome',
    });
    expect(next).toMatchObject({
      name: 'Novo nome',
      estimatedCost: null,
      advantages: null,
      riskLevel: 'HIGH',
      sortOrder: 4,
    });
    expect(diffEtpAlternative(current, next).map((change) => change.field)).toEqual([
      'name',
      'advantages',
      'estimatedCost',
      'sortOrder',
    ]);
  });

  it('o mesmo valor (inclusive "100" = "100.00" e rich text igual) não é mudança', () => {
    const current = alternative('a', { estimatedCost: '100.00' });
    const next = patchEtpAlternative(current, {
      estimatedCost: '100',
      description: doc('Descrição da alternativa.'),
      disadvantages: null,
      riskLevel: null,
      observations: null,
    });
    expect(diffEtpAlternative(current, next)).toEqual([]);
  });

  it('touch muda autor e momento, não a versão', () => {
    const touched = touchEtpAlternative(alternative('a'), LATER, 'user-ana');
    expect(touched).toMatchObject({ updatedAt: LATER, updatedById: 'user-ana', version: 1 });
  });
});

describe('isNameTaken (V-03 · RN-ETP-18)', () => {
  const siblings = [alternative('a', { name: 'Locação de equipamentos' }), alternative('b')];

  it('sem diferenciar maiúsculas nem espaços nas pontas', () => {
    expect(isNameTaken(siblings, '  LOCAÇÃO de equipamentos ')).toBe(true);
    expect(isNameTaken(siblings, 'Aquisição direta')).toBe(false);
  });

  it('a própria alternativa não conta (renomear para a mesma grafia)', () => {
    expect(isNameTaken(siblings, 'locação de equipamentos', 'a')).toBe(false);
    expect(isNameTaken(siblings, 'locação de equipamentos', 'b')).toBe(true);
  });
});

describe('planDecision (ETP-09 · RN-ETP-19..21)', () => {
  it('recomendar sem outra recomendada: atualiza o ETP e publica sem previousAlternativeId', () => {
    const target = alternative('a');
    const plan = planDecision(target, [target, alternative('b')], {
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
      replaceRecommended: false,
    });
    expect(plan).toMatchObject({
      ok: true,
      demoted: null,
      recommendedAlternativeId: 'a',
      recommended: { previousAlternativeId: null },
    });
    if (!plan.ok) throw new Error('esperado ok');
    expect(plan.next).toMatchObject({
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
    });
    expect(plan.changes.map((change) => change.field)).toEqual([
      'decision',
      'decisionJustification',
    ]);
  });

  it('V-05: outra recomendada sem replaceRecommended → RECOMMENDED_EXISTS', () => {
    const recommended = alternative('b', {
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
    });
    const target = alternative('a');
    expect(
      planDecision(target, [target, recommended], {
        decision: 'RECOMMENDED',
        decisionJustification: JUSTIFICATION,
        replaceRecommended: false,
      }),
    ).toEqual({ ok: false, reason: 'RECOMMENDED_EXISTS', recommendedAlternativeId: 'b' });
  });

  it('FA-01: com replaceRecommended, a antiga volta a UNDER_ANALYSIS (justificativa preservada)', () => {
    const recommended = alternative('b', {
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
    });
    const target = alternative('a');
    const plan = planDecision(target, [target, recommended], {
      decision: 'RECOMMENDED',
      decisionJustification: 'Melhor custo-benefício entre as levantadas.',
      replaceRecommended: true,
    });
    expect(plan).toMatchObject({
      ok: true,
      demoted: { id: 'b', decision: 'UNDER_ANALYSIS', decisionJustification: JUSTIFICATION },
      recommendedAlternativeId: 'a',
      recommended: { previousAlternativeId: 'b' },
    });
  });

  it('descartar ou voltar a UNDER_ANALYSIS não toca outras; sair de RECOMMENDED limpa o ETP', () => {
    const recommended = alternative('a', {
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
    });
    const discarded = planDecision(recommended, [recommended], {
      decision: 'DISCARDED',
      decisionJustification: 'Custo de manutenção alto demais.',
      replaceRecommended: false,
    });
    expect(discarded).toMatchObject({
      ok: true,
      demoted: null,
      recommendedAlternativeId: null,
      recommended: null,
    });
    const back = planDecision(
      alternative('b', { decision: 'DISCARDED', decisionJustification: JUSTIFICATION }),
      [],
      {
        decision: 'UNDER_ANALYSIS',
        decisionJustification: null,
        replaceRecommended: false,
      },
    );
    expect(back).toMatchObject({
      ok: true,
      recommendedAlternativeId: undefined,
      recommended: null,
    });
  });

  it('repetir a mesma decisão com a mesma justificativa não muda nada (sem novo evento)', () => {
    const recommended = alternative('a', {
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
    });
    const plan = planDecision(recommended, [recommended], {
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
      replaceRecommended: false,
    });
    expect(plan).toMatchObject({ ok: true, changes: [], recommended: null });
  });
});

describe('exclusão e cabeçalho (RN-ETP-21/22)', () => {
  it('a recomendada corrente não pode ser excluída', () => {
    expect(canDeleteEtpAlternative({ decision: 'RECOMMENDED' })).toBe(false);
    expect(canDeleteEtpAlternative({ decision: 'UNDER_ANALYSIS' })).toBe(true);
    expect(canDeleteEtpAlternative({ decision: 'DISCARDED' })).toBe(true);
  });

  it('setRecommendedAlternative grava a recomendada e sobe a versão do ETP', () => {
    const etp = createEtp({
      documentId: 'etp-1',
      tenantId: 'tenant-a',
      processId: 'process-1',
      importedFromDfdVersionId: null,
      creatorId: USER,
      now: NOW,
    });
    expect(setRecommendedAlternative(etp, 'a', { at: LATER, userId: 'user-ana' })).toMatchObject({
      recommendedAlternativeId: 'a',
      updatedAt: LATER,
      updatedById: 'user-ana',
      version: 2,
    });
  });
});
