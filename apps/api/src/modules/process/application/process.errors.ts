import {
  PARTICIPANT_MESSAGES,
  PROCESS_ITEM_MESSAGES,
  PROCESS_UPDATE_MESSAGES,
  estimatedValueFromSourceMessage,
} from '@contrataflow/validation';
import type {
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

import { itemsNotEditableMessage } from '../domain/process-items.js';
import type { GrantRefusal } from '../domain/process-participants.js';
import { notEditableStatusMessage } from '../domain/process-update.js';
import type { ProcessIssue } from '../domain/process.js';

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
