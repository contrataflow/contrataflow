import type { ActionEntry } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { checklistRule, violation } from '@test/support/forward-fixtures';

import {
  completionEntry,
  completionRules,
  describeCompletionError,
  pendingWarnings,
  validateCompletionComment,
} from './completion-model';

/*
 * US-010 — regras puras do diálogo "Concluir processo" (SCR-116): a ação, as pendências que valem
 * para a conclusão, os avisos a reconhecer, a observação e os erros da API.
 */

const T_COMPLETE = '0192f010-0000-7000-8000-000000000901';
const T_OTHER = '0192f010-0000-7000-8000-000000000902';
const RULE_ETP = '0192f010-0000-7000-8000-000000000611';
const RULE_RISK = '0192f010-0000-7000-8000-000000000612';
const RULE_OTHER = '0192f010-0000-7000-8000-000000000613';

const completeEntry = (extra: Partial<ActionEntry> = {}): ActionEntry => ({
  action: 'COMPLETE',
  label: 'Concluir planejamento',
  enabled: true,
  reasons: [],
  transitionId: T_COMPLETE,
  transitionKey: 'PLANEJAMENTO_COMPLETE_CONCLUSAO',
  toStageKey: 'CONCLUSAO',
  toStageName: 'Planejamento da contratação concluído',
  toStageType: 'END',
  primary: true,
  ...extra,
});

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError({ status, code, correlationId: 'corr-010', ...extra });

describe('completion-model (US-010)', () => {
  it('completionEntry: a ação COMPLETE principal; sem ela, nada', () => {
    const secondary = completeEntry({ primary: false, transitionId: T_OTHER });
    expect(completionEntry([secondary, completeEntry()])?.transitionId).toBe(T_COMPLETE);
    expect(completionEntry([secondary])?.transitionId).toBe(T_OTHER);
    expect(
      completionEntry([{ action: 'FORWARD', label: 'Encaminhar', enabled: true, reasons: [] }]),
    ).toBeUndefined();
    expect(completionEntry(undefined)).toBeUndefined();
  });

  it('RN-PROC-113: STAGE_EXIT e a TRANSITION da conclusão valem; a de outra transição não', () => {
    const checklist = [
      checklistRule(RULE_RISK, 'WARNING', 'Recomenda-se elaborar o mapa de riscos.'),
      checklistRule(RULE_ETP, 'BLOCKING', 'O ETP deve estar completo.', {
        scope: 'TRANSITION',
        transitionId: T_COMPLETE,
      }),
      checklistRule(RULE_OTHER, 'BLOCKING', 'Outra regra.', {
        scope: 'TRANSITION',
        transitionId: T_OTHER,
      }),
    ];
    expect(completionRules(checklist, completeEntry()).map((rule) => rule.ruleId)).toEqual([
      RULE_ETP,
      RULE_RISK,
    ]);
    // FA-03: na etapa END (sem transição) só as regras de saída da etapa.
    const atEnd = completeEntry({ transitionId: undefined, transitionKey: undefined });
    expect(completionRules(checklist, atEnd).map((rule) => rule.ruleId)).toEqual([RULE_RISK]);
  });

  it('V-05: avisos não reconhecidos', () => {
    const rules = completionRules(
      [
        checklistRule(RULE_RISK, 'WARNING', 'Aviso'),
        checklistRule(RULE_ETP, 'BLOCKING', 'Bloqueio'),
      ],
      completeEntry(),
    );
    expect(pendingWarnings(rules, []).map((rule) => rule.ruleId)).toEqual([RULE_RISK]);
    expect(pendingWarnings(rules, [RULE_RISK])).toEqual([]);
  });

  it('observação até 5.000 caracteres', () => {
    expect(validateCompletionComment('x'.repeat(5000))).toBeUndefined();
    expect(validateCompletionComment('x'.repeat(5001))).toBe(
      'A observação pode ter até 5.000 caracteres.',
    );
  });

  it.each([
    [apiError(412, 'VERSION_CONFLICT'), 'stale'],
    [apiError(428, 'PRECONDITION_REQUIRED'), 'stale'],
    [apiError(409, 'INVALID_PROCESS_STATUS'), 'status'],
    [apiError(403, 'NOT_PROCESS_CUSTODIAN'), 'notCustodian'],
    [apiError(403, 'PERMISSION_DENIED'), 'permission'],
    [apiError(403, 'TENANT_SUSPENDED'), 'access'],
    [apiError(404, 'PROCESS_NOT_FOUND'), 'notFound'],
    [apiError(422, 'TRANSITION_NOT_AVAILABLE'), 'transition'],
    [apiError(422, 'IDEMPOTENCY_KEY_REUSED'), 'reused'],
    [apiError(503, 'DEPENDENCY_UNAVAILABLE'), 'unavailable'],
    [apiError(500, 'INTERNAL_ERROR'), 'unexpected'],
    [new Error('rede'), 'unexpected'],
  ] as const)('describeCompletionError(%o) → %s', (error, kind) => {
    expect(describeCompletionError(error).kind).toBe(kind);
  });

  it('TRANSITION_BLOCKED/WARNINGS_NOT_ACKNOWLEDGED trazem as regras; VALIDATION_ERROR a mensagem do campo', () => {
    const blocked = describeCompletionError(
      apiError(422, 'TRANSITION_BLOCKED', {
        violations: [violation(RULE_ETP, 'BLOCKING', 'O ETP deve estar completo.')],
      }),
    );
    expect(blocked).toMatchObject({ kind: 'blocked', rules: [{ ruleId: RULE_ETP }] });
    const warnings = describeCompletionError(
      apiError(422, 'WARNINGS_NOT_ACKNOWLEDGED', {
        violations: [violation(RULE_RISK, 'WARNING', 'Aviso')],
      }),
    );
    expect(warnings).toMatchObject({ kind: 'warnings', rules: [{ ruleId: RULE_RISK }] });
    expect(
      describeCompletionError(
        apiError(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'comment', code: 'TOO_LONG', message: 'Longa demais.' }],
        }),
      ),
    ).toEqual({ kind: 'field', message: 'Longa demais.' });
    expect(describeCompletionError(apiError(422, 'VALIDATION_ERROR'))).toEqual({
      kind: 'field',
      message: 'A observação pode ter até 5.000 caracteres.',
    });
  });
});
