import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { forwardedDto } from '@test/support/forward-fixtures';
import { ID } from '@test/support/process-fixtures';

import { buildForwardBody, describeForwardError, forwardedToast } from './forward-model';
import type { ForwardDraft } from './forward-model';

/* US-124 — ramos paralelos no encaminhamento (PRC-19): corpo, toast e erros novos. */

const BRANCH_STAGE = ID(777);
const STAGE = ID(302);
const TRANSITION = ID(901);

const apiError = (status: number, code: string) =>
  new ApiError({ status, code, correlationId: 'c-1' });

const draftOf = (entry: ForwardDraft['entry']): ForwardDraft => ({
  entry,
  department: null,
  assignee: null,
  dueOverride: { enabled: false, date: '', reason: '' },
  comment: '',
  documentSelection: null,
  documentCount: 0,
  warnings: [],
  acknowledged: [],
});

const entryOf = (extra: Record<string, unknown> = {}): ForwardDraft['entry'] => ({
  action: 'FORWARD',
  transitionId: TRANSITION,
  transitionKey: 'ANALISE_FORWARD_JOIN',
  label: 'Encaminhar',
  enabled: true,
  reasons: [],
  ...extra,
});

describe('ramos paralelos no encaminhamento (US-124)', () => {
  it('buildForwardBody: no ramo envia processStageId e usa a etapa do ramo como etapa esperada', () => {
    const body = buildForwardBody(
      draftOf(entryOf({ processStageId: BRANCH_STAGE, branchKey: 'JURIDICO' })),
      STAGE,
    );
    expect(body).toMatchObject({
      transitionId: TRANSITION,
      processStageId: BRANCH_STAGE,
      expectedStageId: BRANCH_STAGE,
    });
  });

  it('buildForwardBody: fora do paralelismo o corpo é o do MVP 1', () => {
    const body = buildForwardBody(draftOf(entryOf()), STAGE);
    expect(body).toEqual({ transitionId: TRANSITION, expectedStageId: STAGE });
  });

  it('forwardedToast: com ramo diz qual ramo foi encaminhado; sem ramo mantém o texto do MVP 1', () => {
    const base = forwardedDto();
    expect(
      forwardedToast({ ...base, movement: { ...base.movement, branchKey: 'JURIDICO' } }),
    ).toEqual({ key: 'toast.branchForwarded', values: { branch: 'JURIDICO' } });
    expect(forwardedToast(base).key).toBe('toast.forwarded');
  });

  it('describeForwardError: os códigos novos do paralelismo', () => {
    expect(describeForwardError(apiError(422, 'PROCESS_STAGE_REQUIRED')).kind).toBe(
      'stageRequired',
    );
    expect(describeForwardError(apiError(422, 'PROCESS_STAGE_INVALID')).kind).toBe('stageInvalid');
    expect(describeForwardError(apiError(409, 'STAGE_CHANGED')).kind).toBe('stageChanged');
  });
});
