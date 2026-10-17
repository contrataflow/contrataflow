import { DOCUMENT_MESSAGES } from '@contrataflow/validation';
import type { DocumentStatus, ProcessStatus, Violation } from '@contrataflow/validation';

import { ApiError } from '#shared/errors/api-error.js';

import type { DocumentTransitionError } from '../domain/document.js';

/*
 * Erros HTTP do ciclo de vida do documento (US-065 · "Casos de erro" · V-01..V-09 · api.md §2).
 * Nenhuma mensagem leva conteúdo do documento nem justificativa.
 */

/** 404 de documento inexistente, excluído, de outro tenant ou de processo não visível (RN-TEN). */
export function documentNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Documento não encontrado.' });
}

/** 404 do processo na criação (DOC-02): inexistente, de outro tenant ou não visível (DEC-024). */
export function processNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Processo não encontrado.' });
}

/** 412 `VERSION_CONFLICT` com a versão atual para o cliente recarregar (V-09). */
export function documentVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: DOCUMENT_MESSAGES.versionConflict,
    extensions: { currentVersion },
  });
}

/** 422 `DOCUMENT_INCOMPLETE` com as pendências em `violations[]` (V-01). */
export function documentIncomplete(violations: readonly Violation[]): ApiError {
  return new ApiError('DOCUMENT_INCOMPLETE', {
    detail: DOCUMENT_MESSAGES.incomplete,
    violations,
  });
}

/** 422 `WARNINGS_NOT_ACKNOWLEDGED` com os avisos que faltam reconhecer (V-02). */
export function warningsNotAcknowledged(violations: readonly Violation[]): ApiError {
  return new ApiError('WARNINGS_NOT_ACKNOWLEDGED', {
    detail: DOCUMENT_MESSAGES.warningsNotAcknowledged,
    violations,
  });
}

/** 403 `NOT_PROCESS_CUSTODIAN` (POL-01/POL-11 · V-06), auditada como `access.denied`. */
export function notProcessCustodian(policy: 'POL-01' | 'POL-11', detail: string): ApiError {
  return new ApiError('NOT_PROCESS_CUSTODIAN', {
    detail,
    auditReasonCode: policy,
    auditDenial: true,
  });
}

/** 403 `PERMISSION_DENIED`: sem custódia nem participação `COLLABORATOR`/`CONSULTANT` (POL-02). */
export function notCustodianNorCollaborator(): ApiError {
  return new ApiError('PERMISSION_DENIED', {
    detail: 'Apenas quem tem a custódia do processo ou colabora nele pode realizar esta ação.',
    auditReasonCode: 'POL-02',
    auditDenial: true,
  });
}

/** 409 `INVALID_PROCESS_STATUS`: processo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` (POL-02/11). */
export function invalidProcessStatus(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: 'O processo não admite alterações de documentos no status atual.',
    extensions: { processStatus: status },
  });
}

/** 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (POL-02). */
export function typeNotAllowedInStage(): ApiError {
  return new ApiError('DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE');
}

/** 409 `DOCUMENT_ALREADY_EXISTS` (RN-DOC-50 · V-08). */
export function documentAlreadyExists(existingDocumentId: string | null): ApiError {
  return new ApiError('DOCUMENT_ALREADY_EXISTS', {
    detail: DOCUMENT_MESSAGES.alreadyExists,
    extensions: existingDocumentId === null ? {} : { meta: { existingDocumentId } },
  });
}

const TRANSITION_DETAIL: Readonly<Record<DocumentTransitionError['failure'], string>> = {
  STATUS: DOCUMENT_MESSAGES.invalidState,
  PENDING_APPROVAL: DOCUMENT_MESSAGES.pendingApproval,
  ALREADY_SUBMITTED: DOCUMENT_MESSAGES.alreadySubmitted,
  APPROVAL_MODE: DOCUMENT_MESSAGES.invalidState,
  NOT_EDITABLE: DOCUMENT_MESSAGES.notEditable,
};

/** Transição recusada pelo domínio → 409 `INVALID_STATE` (V-04/V-05/V-07) ou `DOCUMENT_NOT_EDITABLE`. */
export function transitionRefused(error: DocumentTransitionError): ApiError {
  const status: DocumentStatus = error.status;
  return new ApiError(
    error.failure === 'NOT_EDITABLE' ? 'DOCUMENT_NOT_EDITABLE' : 'INVALID_STATE',
    {
      detail: TRANSITION_DETAIL[error.failure],
      extensions: { status },
    },
  );
}

/**
 * 404 `PROCESS_NOT_FOUND` do painel (DOC-01 · V-03): o mesmo corpo do guard de `PROCESS_VIEW` —
 * inexistente, de outro tenant e não visível são indistinguíveis (DEC-024), auditado como negação.
 */
export function panelProcessNotFound(): ApiError {
  return new ApiError('PROCESS_NOT_FOUND', {
    detail: 'Não encontramos o recurso solicitado.',
    auditReasonCode: 'PROCESS_VIEW',
    auditDenial: true,
  });
}
