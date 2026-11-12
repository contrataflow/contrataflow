import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { STAGE_ABERTURA, returnEntry } from '@test/support/return-fixtures';

import { buildReturnBody, describeReturnError, returnTargets } from './return-model';

/* US-124 — ramos paralelos na devolução (PRC-20): erros novos, etapa do ramo e confirmação. */

const BRANCH_STAGE = '0192a000-0000-7000-8000-000000000777';
const REASON = 'Faltou detalhar a justificativa da contratação no DFD';

const apiError = (status: number, code: string) =>
  new ApiError({ status, code, correlationId: 'c-1' });

describe('ramos paralelos na devolução (US-124)', () => {
  it('describeReturnError: confirmação do cancelamento e os códigos de etapa', () => {
    expect(describeReturnError(apiError(422, 'BRANCH_CANCELLATION_NOT_CONFIRMED')).kind).toBe(
      'branchCancellation',
    );
    expect(describeReturnError(apiError(422, 'PROCESS_STAGE_REQUIRED')).kind).toBe('stageRequired');
    expect(describeReturnError(apiError(422, 'PROCESS_STAGE_INVALID')).kind).toBe('stageInvalid');
    expect(describeReturnError(apiError(409, 'STAGE_CHANGED'))).toEqual({
      kind: 'stale',
      code: 'STAGE_CHANGED',
    });
  });

  it('returnTargets e buildReturnBody carregam o processStageId do ramo e a confirmação', () => {
    const [target] = returnTargets([
      returnEntry({ processStageId: BRANCH_STAGE, branchKey: 'JURIDICO' }),
    ]);
    expect(target).toMatchObject({ processStageId: BRANCH_STAGE, branchKey: 'JURIDICO' });
    if (target === undefined) throw new Error('sem destino');
    const draft = { target, comment: REASON, dueAt: '' };
    expect(buildReturnBody(draft, 'etapa-split')).toEqual({
      targetStageId: STAGE_ABERTURA,
      comment: REASON,
      expectedStageId: BRANCH_STAGE,
      processStageId: BRANCH_STAGE,
    });
    expect(buildReturnBody(draft, 'etapa-split', true)).toMatchObject({
      confirmBranchCancellation: true,
    });
  });
});
