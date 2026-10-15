import type { TemplateVersionStatus, Violation } from '@contrataflow/validation';

import { ApiError } from '#shared/errors/api-error.js';

/** 404 de template inexistente ou de outro tenant (indistinguíveis — RN-TEN). */
export function templateNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Template não encontrado.' });
}

export function templateVersionNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Versão do template não encontrada.' });
}

/** 409 `TEMPLATE_NAME_TAKEN` (V-02). */
export function templateNameTaken(name: string): ApiError {
  return new ApiError('TEMPLATE_NAME_TAKEN', {
    detail: `Já existe um template chamado "${name}" para este tipo de documento.`,
    extensions: { conflictField: 'name' },
  });
}

/** 409 `TEMPLATE_VERSION_NOT_DRAFT` (RN-TPL-03 · V-08). */
export function templateVersionNotDraft(
  versionId: string,
  status: TemplateVersionStatus,
): ApiError {
  return new ApiError('TEMPLATE_VERSION_NOT_DRAFT', {
    extensions: { templateVersionId: versionId, status },
  });
}

/** 409 `TEMPLATE_DRAFT_EXISTS` com `meta.draftVersionId` (RN-TPL-10 · US-108). */
export function templateDraftExists(draftVersionId: string | null): ApiError {
  return new ApiError('TEMPLATE_DRAFT_EXISTS', { extensions: { meta: { draftVersionId } } });
}

/** 422 `TEMPLATE_INVALID` com os achados em `violations[]` (RN-TPL-09 · api.md §2.1.2). */
export function templateInvalid(violations: readonly Violation[]): ApiError {
  const count = violations.length;
  return new ApiError('TEMPLATE_INVALID', {
    detail:
      count === 1
        ? (violations[0]?.message ?? 'O template tem um problema de conteúdo.')
        : `O template tem ${count} problemas de conteúdo. Revise as seções destacadas.`,
    violations,
  });
}

/** 412 `VERSION_CONFLICT` com a versão atual (`currentVersion`) para o cliente recarregar (V-09). */
export function templateVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Este template foi alterado por outra pessoa. Recarregue para continuar.',
    extensions: { currentVersion },
  });
}
