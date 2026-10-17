import { describe, expect, it } from 'vitest';

import {
  AiGenerationTransitionError,
  addUsage,
  canApply,
  cancelGeneration,
  claimGeneration,
  completeGeneration,
  discardGeneration,
  expireGeneration,
  failGeneration,
  isActive,
  isExpired,
  markApplied,
  requestGeneration,
} from './ai-generation.js';
import type { AiGeneration, CompletedResult } from './ai-generation.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const LATER = new Date('2026-10-16T12:01:00.000Z');
const USER = '0192d115-0000-7000-8000-0000000000c1';

function queued(overrides: Partial<Parameters<typeof requestGeneration>[0]> = {}): AiGeneration {
  return requestGeneration({
    id: '0192d115-0000-7000-8000-000000000001',
    tenantId: '0192d115-0000-7000-8000-00000000000a',
    processId: '0192d115-0000-7000-8000-000000000002',
    documentId: '0192d115-0000-7000-8000-000000000003',
    targetModule: 'DFD',
    kind: 'DRAFT',
    action: null,
    sectionKey: null,
    baseRevision: null,
    needSummary: 'Resumo da necessidade com vinte caracteres.',
    instruction: null,
    provider: 'fake',
    promptKey: 'draft.dfd',
    promptVersion: '1.0.0',
    reservedTokens: 15_000,
    createdById: USER,
    now: NOW,
    ...overrides,
  });
}

const RESULT: CompletedResult = {
  model: 'fake-draft-1',
  inputRefs: [],
  contextHash: 'a'.repeat(64),
  output: { sections: [], warnings: [] },
  outputHash: 'b'.repeat(64),
  placeholdersCount: 2,
  groundingReplacements: 1,
  usage: { inputTokens: 100, outputTokens: 40 },
  costUsd: '0.000000',
  pricingVersion: '2026-10-16.1',
  latencyMs: 1_200,
  providerRequestId: 'req-1',
};

function running(): AiGeneration {
  const claimed = claimGeneration(queued(), 1, NOW);
  if (claimed === null) throw new Error('claim recusado');
  return claimed;
}

describe('AiGeneration — máquina de estados (RN-AI-01/03/11)', () => {
  it('nasce QUEUED, sem modelo, saída nem consumo (registro antes do provedor)', () => {
    expect(queued()).toMatchObject({
      status: 'QUEUED',
      model: null,
      output: null,
      inputTokens: null,
      attempts: 0,
      createdAt: NOW,
    });
    expect(isActive(queued())).toBe(true);
  });

  it('claim: QUEUED → RUNNING; retentativa do próprio job retoma; outra entrega não executa', () => {
    const first = running();
    expect(first).toMatchObject({ status: 'RUNNING', attempts: 1, startedAt: NOW });
    expect(claimGeneration(first, 1, LATER)).toBeNull();
    const retry = claimGeneration(first, 2, LATER);
    expect(retry).toMatchObject({ attempts: 2, startedAt: NOW });
    expect(claimGeneration({ ...first, status: 'SUCCEEDED' }, 2, LATER)).toBeNull();
  });

  it('conclusão: SUCCEEDED com proposta, consumo somado e expiresAt = +7 dias', () => {
    const done = completeGeneration(
      addUsage(running(), { inputTokens: 10, outputTokens: 5 }, NOW),
      RESULT,
      LATER,
    );
    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      inputTokens: 110,
      outputTokens: 45,
      totalTokens: 155,
      completedAt: LATER,
      groundingReplacements: 1,
    });
    expect(done.expiresAt?.toISOString()).toBe('2026-10-23T12:01:00.000Z');
    expect(isExpired(done, new Date('2026-10-23T12:00:59.000Z'))).toBe(false);
    expect(isExpired(done, new Date('2026-10-23T12:01:00.000Z'))).toBe(true);
    expect(() => completeGeneration(queued(), RESULT, LATER)).toThrow(AiGenerationTransitionError);
  });

  it('falha: FAILED com errorCode (inclusive direto de QUEUED); estados finais recusam', () => {
    const failed = failGeneration(
      running(),
      {
        errorCode: 'TIMEOUT',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: null,
        costUsd: null,
        pricingVersion: null,
        latencyMs: null,
      },
      LATER,
    );
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT', totalTokens: 0 });
    expect(() =>
      failGeneration(
        failed,
        {
          errorCode: 'TIMEOUT',
          usage: RESULT.usage,
          model: null,
          costUsd: null,
          pricingVersion: null,
          latencyMs: null,
        },
        LATER,
      ),
    ).toThrow(AiGenerationTransitionError);
  });

  it('cancelamento pelo solicitante (FA-02) e por política (FA-06)', () => {
    expect(cancelGeneration(running(), { byPolicy: false, userId: USER }, LATER)).toMatchObject({
      status: 'CANCELED',
      errorCode: null,
      discardedById: USER,
    });
    expect(cancelGeneration(queued(), { byPolicy: true, userId: null }, LATER)).toMatchObject({
      status: 'CANCELED',
      errorCode: 'CANCELED_BY_POLICY',
      discardedById: null,
    });
    const done = completeGeneration(running(), RESULT, LATER);
    expect(() => cancelGeneration(done, { byPolicy: false, userId: USER }, LATER)).toThrow(
      AiGenerationTransitionError,
    );
  });

  it('SUCCEEDED → DISCARDED / EXPIRED; nada sai de DISCARDED', () => {
    const done = completeGeneration(running(), RESULT, NOW);
    const discarded = discardGeneration(done, USER, LATER);
    expect(discarded).toMatchObject({
      status: 'DISCARDED',
      discardedAt: LATER,
      output: done.output,
    });
    expect(expireGeneration(done, LATER)).toMatchObject({ status: 'EXPIRED', output: done.output });
    expect(() => expireGeneration(discarded, LATER)).toThrow(AiGenerationTransitionError);
    expect(() => discardGeneration(queued(), USER, LATER)).toThrow(AiGenerationTransitionError);
  });

  it('aplicação: uma vez; mapa de riscos acumula riscos e seções, cada parte uma vez', () => {
    const none = { sectionKeys: [], riskIds: [] };
    const done = completeGeneration(running(), RESULT, NOW);
    const applied = markApplied(
      done,
      { userId: USER, targets: { sectionKeys: ['A'], riskIds: [] } },
      LATER,
    );
    expect(applied).toMatchObject({ status: 'APPLIED', appliedById: USER, appliedAt: LATER });
    expect(applied && markApplied(applied, { userId: USER, targets: none }, LATER)).toBeNull();
    expect(
      markApplied({ ...done, expiresAt: NOW }, { userId: USER, targets: none }, LATER),
    ).toBeNull();
    expect(markApplied(queued(), { userId: USER, targets: none }, LATER)).toBeNull();

    const claimedRisks = claimGeneration(
      queued({ targetModule: 'RISK_MAP', documentId: null }),
      1,
      NOW,
    );
    if (claimedRisks === null) throw new Error('claim recusado');
    const risks = completeGeneration(claimedRisks, RESULT, NOW);
    const withRisks = markApplied(
      risks,
      { userId: USER, targets: { sectionKeys: [], riskIds: ['r1'] } },
      LATER,
    );
    if (withRisks === null) throw new Error('aplicação recusada');
    expect(canApply(withRisks, { sectionKeys: [], riskIds: ['r2'] }, LATER)).toBe(false);
    expect(canApply(withRisks, { sectionKeys: ['S'], riskIds: [] }, LATER)).toBe(true);
    expect(
      markApplied(withRisks, { userId: USER, targets: { sectionKeys: ['S'], riskIds: [] } }, LATER)
        ?.appliedTargets,
    ).toEqual({ sectionKeys: ['S'], riskIds: ['r1'] });
  });
});
