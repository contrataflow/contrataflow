import { HEAD_DEPUTY_DISTINCT_MESSAGE } from '@contrataflow/validation';
import type { FieldError } from '@contrataflow/validation';
import type { Logger } from '@nestjs/common';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type { DepartmentReferenceKind } from './department-ports.js';

/** 404 de unidade inexistente ou de outro tenant (indistinguíveis — RN-TEN). */
export function departmentNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Unidade não encontrada.' });
}

/** Órgão inexistente/de outro tenant (`REFERENCE_NOT_FOUND`) ou inativo (`REFERENCE_INACTIVE`). */
export function organizationRejected(kind: 'NOT_FOUND' | 'INACTIVE'): FieldError {
  return kind === 'INACTIVE'
    ? {
        field: 'organizationId',
        code: 'REFERENCE_INACTIVE',
        message: 'O órgão desta unidade está inativo.',
      }
    : {
        field: 'organizationId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione um órgão válido.',
      };
}

/** V-02: unidade superior inexistente, de outro tenant ou de outro órgão (ou inativa). */
export function parentRejected(kind: 'NOT_FOUND' | 'INACTIVE'): FieldError {
  return kind === 'INACTIVE'
    ? {
        field: 'parentId',
        code: 'REFERENCE_INACTIVE',
        message: 'A unidade superior está inativa. Selecione uma unidade ativa.',
      }
    : {
        field: 'parentId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione uma unidade superior válida.',
      };
}

/** V-03: nome repetido entre irmãos. */
export function nameTaken(): ApiError {
  return validationError([
    {
      field: 'name',
      code: 'INVALID_FORMAT',
      message: 'Já existe uma unidade com este nome no mesmo nível.',
    },
  ]);
}

/** V-04: sigla repetida no órgão. */
export function acronymTaken(): ApiError {
  return validationError([
    { field: 'acronym', code: 'INVALID_FORMAT', message: 'Esta sigla já está em uso no órgão.' },
  ]);
}

/** V-07. */
export function headEqualsDeputy(): ApiError {
  return validationError([
    { field: 'deputyUserId', code: 'NOT_ALLOWED', message: HEAD_DEPUTY_DISTINCT_MESSAGE },
  ]);
}

/** DEP-05 com `organizationId`/`parentId` diferentes do atual. */
export function fieldNotAllowed(field: 'organizationId' | 'parentId'): ApiError {
  return validationError([
    {
      field,
      code: 'NOT_ALLOWED',
      message:
        field === 'parentId'
          ? 'Use "Mover para…" para trocar a unidade superior.'
          : 'A unidade não muda de órgão.',
    },
  ]);
}

/** V-05 · RN-TEN-46. */
export function departmentCycle(): ApiError {
  return new ApiError('DEPARTMENT_CYCLE');
}

/** V-08 · RN-TEN-51: a UI oferece "Desativar". */
export function departmentHasReferences(references: readonly DepartmentReferenceKind[]): ApiError {
  return new ApiError('DEPARTMENT_HAS_REFERENCES', { extensions: { references: [...references] } });
}

/** 412 `VERSION_CONFLICT` com a versão atual da unidade (`currentVersion`) para o cliente recarregar. */
export function versionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', { extensions: { currentVersion } });
}

/**
 * `error` `department.save_failed`: só falha de gravação (erro inesperado ou dependência fora);
 * regra de negócio e validação (4xx) não entram. Sem dados da unidade (e-mail/telefone) no log.
 */
export function logSaveFailure(logger: Logger, error: unknown, correlationId: string): void {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && code !== 'DEPENDENCY_UNAVAILABLE' && code !== 'INTERNAL_ERROR') return;
  logger.error(
    { event: 'department.save_failed', errorCode: code ?? 'INTERNAL_ERROR', correlationId },
    'department.save_failed',
  );
}
