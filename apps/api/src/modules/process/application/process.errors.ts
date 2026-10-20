import {
  PARTICIPANT_MESSAGES,
  PROCESS_ASSIGN_MESSAGES,
  PROCESS_CLAIM_MESSAGES,
  PROCESS_FORWARD_MESSAGES,
  PROCESS_ITEM_MESSAGES,
  PROCESS_RETURN_MESSAGES,
  PROCESS_CANCELLATION_MESSAGES,
  PROCESS_COMPLETION_MESSAGES,
  PROCESS_SUSPENSION_MESSAGES,
  PROCESS_UPDATE_MESSAGES,
  TAG_MESSAGES,
  estimatedValueFromSourceMessage,
} from '@contrataflow/validation';
import type {
  ChecklistViolation,
  DuplicateCandidate,
  ParticipantRole,
  ProcessItemReference,
  EstimatedValueSource,
  FieldError,
  ProcessConflictCurrent,
  ProcessStatus,
} from '@contrataflow/validation';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import { notForwardableMessage } from '../domain/process-forward.js';
import { itemsNotEditableMessage } from '../domain/process-items.js';
import type { GrantRefusal } from '../domain/process-participants.js';
import { notEditableStatusMessage } from '../domain/process-update.js';
import type { ProcessIssue } from '../domain/process.js';
import { tagsNotEditableMessage } from '../domain/tag.js';

/*
 * Erros e telemetria do módulo `process` (US-001 · api.md §2.2 · "Casos de erro" e "Logs" da story).
 */

/** 422 `VALIDATION_ERROR` com os campos de RN-PROC-01..12 (V-01..V-09). */
export function processValidationError(issues: readonly ProcessIssue[]): ApiError {
  return validationError(issues.map((issue): FieldError => ({ ...issue })));
}

/** 409 `DUPLICATE_INTERNAL_CODE` (V-10). */
export function duplicateInternalCode(internalCode: string): ApiError {
  return new ApiError('DUPLICATE_INTERNAL_CODE', {
    detail: `Já existe um processo com o código interno ${internalCode}.`,
    errors: [
      {
        field: 'internalCode',
        code: 'NOT_ALLOWED',
        message: `Já existe um processo com o código interno ${internalCode}.`,
      },
    ],
  });
}

/** 409 `POSSIBLE_DUPLICATE_PROCESS` (V-11 · FA-02) com os candidatos no corpo. */
export function possibleDuplicate(candidates: readonly DuplicateCandidate[]): ApiError {
  return new ApiError('POSSIBLE_DUPLICATE_PROCESS', { extensions: { candidates } });
}

/** 404 `PROCESS_NOT_FOUND`: inexistente, de outro tenant ou não visível (permissions.md §5). */
export function processNotFoundError(): ApiError {
  return new ApiError('PROCESS_NOT_FOUND');
}

/** 412 `VERSION_CONFLICT` do PRC-05 (RN-PROC-66 · FA-05): versão atual e o processo atual. */
export function processVersionConflict(
  sentVersion: number,
  current: ProcessConflictCurrent,
): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    title: 'Este processo foi alterado por outra pessoa',
    detail: `A versão enviada (${String(sentVersion)}) é diferente da atual (${String(current.version)}).`,
    extensions: { currentVersion: current.version, meta: { current } },
  });
}

/** 409 `INVALID_PROCESS_STATUS`: processo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` (RN-PROC-59). */
export function processNotEditable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: notEditableStatusMessage(status),
    extensions: { processStatus: status },
  });
}

/** 403 `NOT_PROCESS_CUSTODIAN` (POL-01), auditado como `access.denied` com o mesmo `reasonCode`. */
export function notProcessCustodian(): ApiError {
  return new ApiError('NOT_PROCESS_CUSTODIAN', {
    detail: PROCESS_UPDATE_MESSAGES.notCustodian,
    auditDenial: true,
  });
}

/** 422 `BUSINESS_RULE_VIOLATION`: valor estimado com fonte de maior precedência (V-07 · DEC-032). */
export function estimatedValueFromSource(source: EstimatedValueSource): ApiError {
  const message = estimatedValueFromSourceMessage(source);
  return new ApiError('BUSINESS_RULE_VIOLATION', {
    status: 422,
    detail: message,
    violations: [
      {
        code: 'ESTIMATED_VALUE_FROM_SOURCE',
        severity: 'BLOCKING',
        message,
        ruleId: 'RN-PROC-63',
        sectionKey: null,
        field: 'estimatedValue',
        itemId: null,
        params: { estimatedValueSource: source },
      },
    ],
    extensions: { estimatedValueSource: source },
  });
}

let createdCounter: Counter | undefined;
let createDuration: Histogram | undefined;

/** `cf_process_created_total{channel}` e `cf_process_create_duration_ms` (DoD da US-001). */
export function recordProcessCreated(channel: string, durationMs: number): void {
  const meter = metrics.getMeter('contrataflow-api');
  createdCounter ??= meter.createCounter('cf_process_created_total', {
    description: 'Processos de contratação criados (commit da criação), por canal.',
  });
  createDuration ??= meter.createHistogram('cf_process_create_duration_ms', {
    description: 'Duração da criação de processo (validação, numeração e gravação).',
    unit: 'ms',
  });
  createdCounter.add(1, { channel });
  createDuration.record(durationMs, { channel });
}

let updatedCounter: Counter | undefined;
let updateDuration: Histogram | undefined;
let conflictCounter: Counter | undefined;

/** `cf_process_updated_total` e `cf_process_update_duration_ms` (commit de alteração efetiva). */
export function recordProcessUpdated(durationMs: number): void {
  const meter = metrics.getMeter('contrataflow-api');
  updatedCounter ??= meter.createCounter('cf_process_updated_total', {
    description: 'Edições efetivas dos dados do processo (commit do PRC-05).',
  });
  updateDuration ??= meter.createHistogram('cf_process_update_duration_ms', {
    description: 'Duração da edição dos dados do processo (PRC-05).',
    unit: 'ms',
  });
  updatedCounter.add(1);
  updateDuration.record(durationMs);
}

/** `cf_process_update_conflict_total` — 412 `VERSION_CONFLICT` do PRC-05 (DoD da US-005). */
export function recordProcessUpdateConflict(): void {
  conflictCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_process_update_conflict_total', {
      description: 'Edições do processo recusadas por conflito de versão (412).',
    });
  conflictCounter.add(1);
}

/* US-006 — itens da contratação (api/02-processes.md PRC-13..17 · "Casos de erro" da story). */

/** 404 `NOT_FOUND` de PRC-15/16: item inexistente, excluído, de outro tenant ou não visível. */
export function processItemNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Item não encontrado.' });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-PROC-71 · FA-07) com a mensagem dos itens. */
export function processItemsNotEditable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: itemsNotEditableMessage(status),
    extensions: { processStatus: status },
  });
}

/** 403 `NOT_PROCESS_CUSTODIAN` (POL-01 · FA-07), auditado como `access.denied`. */
export function processItemsNotCustodian(): ApiError {
  return new ApiError('NOT_PROCESS_CUSTODIAN', {
    detail: PROCESS_ITEM_MESSAGES.notCustodian,
    auditDenial: true,
  });
}

/** 412 `VERSION_CONFLICT` (RN-PROC-81 · FA-08): a lista de itens mudou. */
export function processItemsVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    title: 'Lista de itens desatualizada',
    detail: PROCESS_ITEM_MESSAGES.stale,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `ITEM_IN_USE` (RN-PROC-76/79 · FA-01/FA-04) com os documentos em `meta.references`. */
export function processItemInUse(
  sequence: number,
  references: readonly ProcessItemReference[],
): ApiError {
  return new ApiError('ITEM_IN_USE', {
    detail: `O item ${String(sequence)} está em documentos do processo.`,
    extensions: { meta: { references } },
  });
}

/* US-012 — participantes do processo (api/02-processes.md PRC-28..32 · "Casos de erro" da story). */

const NOT_ELIGIBLE_DETAIL: Readonly<Record<string, string>> = {
  CONSULTANT_DEPARTMENT: PARTICIPANT_MESSAGES.notEligibleConsultant,
  NOT_EXTERNAL: PARTICIPANT_MESSAGES.notEligibleConsultant,
  EXPIRES_AFTER_MEMBERSHIP: PARTICIPANT_MESSAGES.expiresAfterMembership,
  SELF: PARTICIPANT_MESSAGES.notEligibleSelf,
};

/**
 * Recusa da concessão (RN-PROC-126..128 · POL-10): 422 `PARTICIPANT_NOT_ELIGIBLE` com o motivo em
 * `meta.reason`, ou 422 `VALIDATION_ERROR` (referência inválida/inativa — sem revelar se o alvo
 * existe em outro tenant — e validade no passado).
 */
export function participantGrantRefused(refusal: GrantRefusal): ApiError {
  switch (refusal.kind) {
    case 'NOT_ELIGIBLE':
      return new ApiError('PARTICIPANT_NOT_ELIGIBLE', {
        detail: NOT_ELIGIBLE_DETAIL[refusal.reason] ?? PARTICIPANT_MESSAGES.notEligibleConsultant,
        extensions: { meta: { reason: refusal.reason } },
      });
    case 'INVALID_REFERENCE':
      return validationError([
        {
          field: refusal.field,
          code: refusal.code,
          message: PARTICIPANT_MESSAGES.invalidReference,
        },
      ]);
    case 'EXPIRES_IN_PAST':
      return validationError([
        { field: 'expiresAt', code: 'DATE_IN_PAST', message: PARTICIPANT_MESSAGES.expiresAtFuture },
      ]);
  }
}

/** 409 `PARTICIPANT_ALREADY_EXISTS` (V-07 · RN-PROC-129) com o papel atual quando conhecido. */
export function participantAlreadyExists(currentRole: ParticipantRole | null): ApiError {
  return new ApiError('PARTICIPANT_ALREADY_EXISTS', {
    detail: PARTICIPANT_MESSAGES.alreadyExists,
    extensions: { meta: { currentRole } },
  });
}

/** 404 `PARTICIPANT_NOT_FOUND` (V-08): inexistente, já revogado, de outro tenant ou não visível. */
export function participantNotFound(): ApiError {
  return new ApiError('PARTICIPANT_NOT_FOUND', { detail: PARTICIPANT_MESSAGES.notFound });
}

/**
 * 403 `PERMISSION_DENIED` do PRC-32 (RN-PROC-133): só o papel `OBSERVER` sai por "Deixar de
 * seguir"; auditado como `access.denied` com `reasonCode = PROCESS_FOLLOW`.
 */
export function unfollowNotObserver(): ApiError {
  return new ApiError('PERMISSION_DENIED', {
    detail: PARTICIPANT_MESSAGES.unfollowNotObserver,
    auditReasonCode: 'PROCESS_FOLLOW',
  });
}

let participantAddedCounter: Counter | undefined;
let participantRemovedCounter: Counter | undefined;

/** `cf_process_participant_added_total{role,granted_via}` (DoD da US-012: métricas). */
export function recordParticipantAdded(role: string, grantedVia: string): void {
  participantAddedCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_process_participant_added_total', {
      description: 'Participações concedidas em processos (PRC-29 e "seguir").',
    });
  participantAddedCounter.add(1, { role, granted_via: grantedVia });
}

/** `cf_process_participant_removed_total{reason}` (revogação manual ou "deixar de seguir"). */
export function recordParticipantRemoved(reason: string): void {
  participantRemovedCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_process_participant_removed_total', {
      description: 'Participações revogadas em processos (PRC-30 e "deixar de seguir").',
    });
  participantRemovedCounter.add(1, { reason });
}

/* US-007 — etiquetas do processo (api/02-processes.md PRC-18 e TAG-01..03 · "Casos de erro"). */

/** 404 `NOT_FOUND` de TAG-03: etiqueta inexistente ou de outro tenant. */
export function tagNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: TAG_MESSAGES.notFound });
}

/** 409 `CONFLICT` (RN-PROC-85 · V-03): nome repetido no tenant. */
export function tagNameTaken(): ApiError {
  return new ApiError('CONFLICT', { detail: TAG_MESSAGES.nameTaken });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-PROC-87 · "Casos de erro"). */
export function processTagsNotEditable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: tagsNotEditableMessage(status),
    extensions: { processStatus: status },
  });
}

/** 403 `NOT_PROCESS_CUSTODIAN` (POL-01 · FA-04), auditado como `access.denied`. */
export function processTagsNotCustodian(): ApiError {
  return new ApiError('NOT_PROCESS_CUSTODIAN', {
    detail: TAG_MESSAGES.forbidden,
    auditDenial: true,
  });
}

/** 412 `VERSION_CONFLICT` (RN-PROC-87): o processo mudou desde que o seletor foi aberto. */
export function processTagsVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    title: 'Processo desatualizado',
    detail: TAG_MESSAGES.stale,
    extensions: { currentVersion, sentVersion },
  });
}

/* US-047 — encaminhamento (api/02-processes.md PRC-19 · "Casos de erro" da story). */

/** 409 `STAGE_CHANGED` (RN-TRAM-03 · FA-08): outra pessoa tramitou — conferido antes do `If-Match`. */
export function stageChanged(
  currentStageId: string | null,
  movedBy: { readonly id: string; readonly name: string } | null,
  detail: string = PROCESS_FORWARD_MESSAGES.stageChanged,
): ApiError {
  return new ApiError('STAGE_CHANGED', {
    detail,
    extensions: { currentStageId, movedBy },
  });
}

/** 412 `VERSION_CONFLICT` (RN-TRAM-03 · V-06). */
export function forwardVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PROCESS_FORWARD_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-TRAM-02). */
export function processNotForwardable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: notForwardableMessage(status),
    extensions: { processStatus: status },
  });
}

/** 403 `NOT_PROCESS_CUSTODIAN` (RN-TRAM-01 · POL-01), auditado como `access.denied`. */
export function forwardNotCustodian(): ApiError {
  return new ApiError('NOT_PROCESS_CUSTODIAN', {
    detail: PROCESS_FORWARD_MESSAGES.notCustodian,
    auditDenial: true,
  });
}

/** 422 `TRANSITION_NOT_AVAILABLE` (RN-TRAM-04 · V-07; unidade de destino inativa — lacuna 3). */
export function transitionNotAvailable(
  detail: string = PROCESS_FORWARD_MESSAGES.transitionNotAvailable,
): ApiError {
  return new ApiError('TRANSITION_NOT_AVAILABLE', { detail });
}

/** 422 `TRANSITION_BLOCKED` (RN-TRAM-05 · V-08): TODAS as violações, inclusive os avisos. */
export function transitionBlocked(
  violations: readonly ChecklistViolation[],
  blockingCount: number,
): ApiError {
  return new ApiError('TRANSITION_BLOCKED', {
    detail: PROCESS_FORWARD_MESSAGES.blocked(blockingCount),
    violations,
  });
}

/** 422 `WARNINGS_NOT_ACKNOWLEDGED` (RN-TRAM-06 · V-09): os avisos que faltam reconhecer. */
export function warningsNotAcknowledged(warnings: readonly ChecklistViolation[]): ApiError {
  return new ApiError('WARNINGS_NOT_ACKNOWLEDGED', {
    detail: PROCESS_FORWARD_MESSAGES.warningsNotAcknowledged,
    violations: warnings,
  });
}

/** 422 `DEPARTMENT_REQUIRED` (RN-TRAM-07 · V-10). */
export function departmentRequired(): ApiError {
  return new ApiError('DEPARTMENT_REQUIRED', {
    detail: PROCESS_FORWARD_MESSAGES.departmentRequired,
    errors: [
      {
        field: 'toDepartmentId',
        code: 'REQUIRED',
        message: PROCESS_FORWARD_MESSAGES.departmentRequired,
      },
    ],
  });
}

/** 422 `ASSIGNEE_NOT_ELIGIBLE` (RN-TRAM-08 · V-12). */
export function assigneeNotEligible(): ApiError {
  return new ApiError('ASSIGNEE_NOT_ELIGIBLE', {
    detail: PROCESS_FORWARD_MESSAGES.assigneeNotEligible,
    errors: [
      {
        field: 'toUserId',
        code: 'NOT_ALLOWED',
        message: PROCESS_FORWARD_MESSAGES.assigneeNotEligible,
      },
    ],
  });
}

/** 422 `DUE_DATE_OVERRIDE_NOT_ALLOWED` (RN-TRAM-10 · V-13). */
export function dueDateOverrideNotAllowed(): ApiError {
  return new ApiError('DUE_DATE_OVERRIDE_NOT_ALLOWED', {
    detail: PROCESS_FORWARD_MESSAGES.dueDateNotAllowed,
  });
}

let forwardedCounter: Counter | undefined;
let forwardDuration: Histogram | undefined;

/** `cf_process_forwarded_total{to_stage_type}` e `cf_process_forward_duration_ms` (DoD da US-047). */
export function recordProcessForwarded(toStageType: string, durationMs: number): void {
  const meter = metrics.getMeter('contrataflow-api');
  forwardedCounter ??= meter.createCounter('cf_process_forwarded_total', {
    description: 'Processos encaminhados (commit do PRC-19), por tipo da etapa de destino.',
  });
  forwardDuration ??= meter.createHistogram('cf_process_forward_duration_ms', {
    description: 'Duração do encaminhamento (bloqueio, regras, numeração, aprovação e gravação).',
    unit: 'ms',
  });
  forwardedCounter.add(1, { to_stage_type: toStageType });
  forwardDuration.record(durationMs, { to_stage_type: toStageType });
}

/* US-048 — devolução (api/02-processes.md PRC-20 · "Casos de erro" da story). */

/** 412 `VERSION_CONFLICT` (V-08 · DEC-104). */
export function returnVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PROCESS_RETURN_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-TRAM-23 · V-05): só `IN_PROGRESS`. */
export function processNotReturnable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: PROCESS_RETURN_MESSAGES.invalidStatus,
    extensions: { processStatus: status },
  });
}

/** 403 `NOT_PROCESS_CUSTODIAN` (RN-TRAM-23 · POL-01 · V-06), auditado como `access.denied`. */
export function returnNotCustodian(): ApiError {
  return new ApiError('NOT_PROCESS_CUSTODIAN', {
    detail: PROCESS_RETURN_MESSAGES.notCustodian,
    auditDenial: true,
  });
}

/** 422 `TRANSITION_NOT_AVAILABLE` (RN-TRAM-24 · V-03): sem revelar se a etapa existe em outro lugar. */
export function returnTargetNotAvailable(): ApiError {
  return transitionNotAvailable(PROCESS_RETURN_MESSAGES.targetNotAvailable);
}

/** 422 `DUE_DATE_OVERRIDE_NOT_ALLOWED` (RN-TRAM-26 · V-04). */
export function returnDueDateNotAllowed(): ApiError {
  return new ApiError('DUE_DATE_OVERRIDE_NOT_ALLOWED', {
    detail: PROCESS_RETURN_MESSAGES.dueDateNotAllowed,
  });
}

/** 412 `VERSION_CONFLICT` (V-04 · FA-03 · DEC-104): o front trata como sucesso já aplicado. */
export function claimVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PROCESS_CLAIM_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-TRAM-32 · V-03): status ou etapa não elegíveis. */
export function processNotClaimable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: PROCESS_CLAIM_MESSAGES.invalidStatus,
    extensions: { processStatus: status },
  });
}

/**
 * 409 `PROCESS_ALREADY_ASSIGNED` (RN-TRAM-31 · V-01 · POL-04): com o responsável atual para a tela
 * mostrar quem assumiu (FA-01).
 */
export function processAlreadyAssigned(responsible: {
  readonly id: string;
  readonly name: string | null;
}): ApiError {
  return new ApiError('PROCESS_ALREADY_ASSIGNED', {
    detail:
      responsible.name === null
        ? PROCESS_CLAIM_MESSAGES.alreadyAssigned
        : PROCESS_CLAIM_MESSAGES.alreadyAssignedBy(responsible.name),
    extensions: { currentResponsible: responsible },
  });
}

/** 403 `PERMISSION_DENIED` (RN-TRAM-31 · V-02 · POL-04), auditado como `access.denied`. */
export function claimNotInDepartment(): ApiError {
  return new ApiError('PERMISSION_DENIED', {
    detail: PROCESS_CLAIM_MESSAGES.notInDepartment,
    auditReasonCode: 'PROCESS_CLAIM',
  });
}

let claimedCounter: Counter | undefined;
let claimDuration: Histogram | undefined;
let claimConflictCounter: Counter | undefined;

/** `cf_process_claimed_total` e `cf_process_claim_duration_ms` (DoD da US-049). */
export function recordProcessClaimed(durationMs: number): void {
  const meter = metrics.getMeter('contrataflow-api');
  claimedCounter ??= meter.createCounter('cf_process_claimed_total', {
    description: 'Processos assumidos pela unidade (commit do PRC-21).',
  });
  claimDuration ??= meter.createHistogram('cf_process_claim_duration_ms', {
    description: 'Duração do "assumir" (bloqueio, validações e gravação).',
    unit: 'ms',
  });
  claimedCounter.add(1);
  claimDuration.record(durationMs);
}

/** `cf_process_claim_conflicts_total`: corrida de fila (o processo já tinha responsável). */
export function recordClaimConflict(): void {
  claimConflictCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_process_claim_conflicts_total', {
      description: 'Tentativas de assumir um processo que já tinha responsável (corrida de fila).',
    });
  claimConflictCounter.add(1);
}

/** 412 `VERSION_CONFLICT` (V-07 · FA-04 · DEC-104): o reenvio já aplicado também cai aqui. */
export function assignVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PROCESS_ASSIGN_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-TRAM-37 · V-06): status ou etapa não elegíveis. */
export function processNotAssignable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: PROCESS_ASSIGN_MESSAGES.invalidStatus,
    extensions: { processStatus: status },
  });
}

/** 403 `PERMISSION_DENIED` (RN-TRAM-36 · V-05 · POL-05), auditado como `access.denied`. */
export function assignNotAllowed(): ApiError {
  return new ApiError('PERMISSION_DENIED', {
    detail: PROCESS_ASSIGN_MESSAGES.permissionDenied,
    auditReasonCode: 'PROCESS_ASSIGN',
  });
}

/** 422 `ASSIGNEE_NOT_ELIGIBLE` (RN-TRAM-38 · V-04) no campo `assigneeId`. */
export function assignAssigneeNotEligible(): ApiError {
  return new ApiError('ASSIGNEE_NOT_ELIGIBLE', {
    detail: PROCESS_ASSIGN_MESSAGES.assigneeNotEligible,
    errors: [
      {
        field: 'assigneeId',
        code: 'NOT_ALLOWED',
        message: PROCESS_ASSIGN_MESSAGES.assigneeNotEligible,
      },
    ],
  });
}

/** 422 `VALIDATION_ERROR` com `REFERENCE_NOT_FOUND`: pessoa sem vínculo no tenant (não revela outro). */
export function assignAssigneeNotFound(): ApiError {
  return validationError([
    {
      field: 'assigneeId',
      code: 'REFERENCE_NOT_FOUND',
      message: PROCESS_ASSIGN_MESSAGES.assigneeNotFound,
    },
  ]);
}

/** 422 `VALIDATION_ERROR` no campo `reason` (RN-TRAM-39 · V-02). */
export function assignReasonRequiredError(): ApiError {
  return validationError([
    { field: 'reason', code: 'REQUIRED', message: PROCESS_ASSIGN_MESSAGES.reasonRequired },
  ]);
}

let assignedCounter: Counter | undefined;
let assignDuration: Histogram | undefined;

/** `cf_process_assigned_total` e `cf_process_assign_duration_ms` (DoD da US-050). */
export function recordProcessAssigned(durationMs: number, viaHeadOrDeputy: boolean): void {
  const meter = metrics.getMeter('contrataflow-api');
  assignedCounter ??= meter.createCounter('cf_process_assigned_total', {
    description: 'Responsáveis atribuídos/reatribuídos (commit do PRC-22).',
  });
  assignDuration ??= meter.createHistogram('cf_process_assign_duration_ms', {
    description: 'Duração da atribuição (bloqueio, validações e gravação).',
    unit: 'ms',
  });
  assignedCounter.add(1, { via_head_or_deputy: viaHeadOrDeputy });
  assignDuration.record(durationMs);
}

let returnedCounter: Counter | undefined;
let returnDuration: Histogram | undefined;

/** `cf_process_returned_total{assignee_resolved}` e `cf_process_return_duration_ms` (DoD da US-048). */
export function recordProcessReturned(assigneeResolved: boolean, durationMs: number): void {
  const meter = metrics.getMeter('contrataflow-api');
  returnedCounter ??= meter.createCounter('cf_process_returned_total', {
    description: 'Processos devolvidos (commit do PRC-20), por resolução do responsável anterior.',
  });
  returnDuration ??= meter.createHistogram('cf_process_return_duration_ms', {
    description: 'Duração da devolução (bloqueio, destino, responsável, prazo e gravação).',
    unit: 'ms',
  });
  const attributes = { assignee_resolved: String(assigneeResolved) };
  returnedCounter.add(1, attributes);
  returnDuration.record(durationMs, attributes);
}

/** 412 `VERSION_CONFLICT` da suspensão/retomada (V-05). */
export function suspensionVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PROCESS_SUSPENSION_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-PROC-93 · V-02): suspender fora dos status de origem. */
export function processNotSuspendable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: PROCESS_SUSPENSION_MESSAGES.notSuspendable,
    extensions: { processStatus: status },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-PROC-97 · V-03): retomar processo que não está suspenso. */
export function processNotSuspended(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: PROCESS_SUSPENSION_MESSAGES.notSuspended,
    extensions: { processStatus: status },
  });
}

/** 412 `VERSION_CONFLICT` do cancelamento/descarte (V-05). */
export function cancellationVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PROCESS_CANCELLATION_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-PROC-103 · V-02): cancelar processo já encerrado. */
export function processAlreadyFinal(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: PROCESS_CANCELLATION_MESSAGES.finalStatus,
    extensions: { processStatus: status },
  });
}

/** 409 `INVALID_PROCESS_STATUS`: descartar o que não é rascunho (RN-PROC-105). */
export function processNotDraft(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: PROCESS_CANCELLATION_MESSAGES.notDraft,
    extensions: { processStatus: status },
  });
}

/** 409 `CANNOT_DISCARD_NUMBERED_PROCESS` (RN-PROC-105 · V-03 · FA-01). */
export function processAlreadyNumbered(): ApiError {
  return new ApiError('CANNOT_DISCARD_NUMBERED_PROCESS', {
    detail: PROCESS_CANCELLATION_MESSAGES.numbered,
    extensions: { processStatus: 'DRAFT' },
  });
}

/** 412 `VERSION_CONFLICT` da conclusão (V-06). */
export function completionVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PROCESS_COMPLETION_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (RN-PROC-111/114 · V-03): concluir fora de `IN_PROGRESS`. */
export function processNotCompletable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: PROCESS_COMPLETION_MESSAGES.invalidStatus,
    extensions: { processStatus: status },
  });
}

/** 403 `NOT_PROCESS_CUSTODIAN` (POL-01 · V-01), auditado como `access.denied`. */
export function completeNotCustodian(): ApiError {
  return new ApiError('NOT_PROCESS_CUSTODIAN', {
    detail: PROCESS_COMPLETION_MESSAGES.notCustodian,
    auditDenial: true,
  });
}

/** 422 `TRANSITION_BLOCKED` (RN-PROC-113 · V-04): TODAS as violações, inclusive os avisos. */
export function completionBlocked(violations: readonly ChecklistViolation[]): ApiError {
  return new ApiError('TRANSITION_BLOCKED', {
    detail: PROCESS_COMPLETION_MESSAGES.blocked,
    violations,
  });
}

/** 422 `WARNINGS_NOT_ACKNOWLEDGED` (RN-PROC-113 · V-05): os avisos que faltam reconhecer. */
export function completionWarningsNotAcknowledged(
  warnings: readonly ChecklistViolation[],
): ApiError {
  return new ApiError('WARNINGS_NOT_ACKNOWLEDGED', {
    detail: PROCESS_COMPLETION_MESSAGES.warningsNotAcknowledged,
    violations: warnings,
  });
}

let suspensionCounter: Counter | undefined;
let suspensionDuration: Histogram | undefined;

/** `cf_process_lifecycle_total{action}` e `cf_process_lifecycle_duration_ms` (US-008/US-009). */
export function recordProcessLifecycle(
  action: 'SUSPEND' | 'RESUME' | 'CANCEL' | 'DISCARD' | 'COMPLETE',
  durationMs: number,
): void {
  const meter = metrics.getMeter('contrataflow-api');
  suspensionCounter ??= meter.createCounter('cf_process_lifecycle_total', {
    description:
      'Suspensões, retomadas, cancelamentos, descartes e conclusões de processo (commit do PRC-23/24/25/06/26 e da aprovação final).',
  });
  suspensionDuration ??= meter.createHistogram('cf_process_lifecycle_duration_ms', {
    description: 'Duração do comando de ciclo de vida (bloqueio, efeitos e gravação).',
    unit: 'ms',
  });
  suspensionCounter.add(1, { action });
  suspensionDuration.record(durationMs, { action });
}
