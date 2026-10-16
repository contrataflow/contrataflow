import type { TemplateVersionStatus, Violation } from '@contrataflow/validation';

import { ApiError, businessRuleViolation, validationError } from '#shared/errors/api-error.js';

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

/** 409 `INVALID_STATE`: aposentar versão que não está publicada (RN-TPL-17 · V-03). */
export function templateVersionNotPublished(
  versionId: string,
  status: TemplateVersionStatus,
): ApiError {
  return new ApiError('INVALID_STATE', {
    detail: 'Só é possível aposentar uma versão publicada.',
    extensions: { templateVersionId: versionId, status },
  });
}

/** 409 `INVALID_STATE`: publicar versão de template inativo (RN-TPL-14). */
export function templateInactive(templateId: string): ApiError {
  return new ApiError('INVALID_STATE', {
    detail: 'Ative o template antes de publicar uma versão.',
    extensions: { templateId },
  });
}

/** 409 `TEMPLATE_IN_USE`: versão corrente sem substituta e padrão de tipo ativo (RN-TPL-18 · V-04). */
export function templateInUse(documentTypeName: string): ApiError {
  return new ApiError('TEMPLATE_IN_USE', {
    detail: `Publique outra versão antes de aposentar esta, pois ela é a padrão de "${documentTypeName}".`,
  });
}

/** 422 `BUSINESS_RULE_VIOLATION` (`TEMPLATE_NOT_PUBLISHED`): padrão sem versão publicada (V-05). */
export function templateNotPublished(): ApiError {
  return businessRuleViolation([
    {
      code: 'TEMPLATE_NOT_PUBLISHED',
      severity: 'BLOCKING',
      message: 'Este template ainda não tem uma versão publicada.',
      ruleId: 'RN-TPL-19',
      sectionKey: null,
      field: 'templateId',
      itemId: null,
      params: {},
    },
  ]);
}

/** 422 `VALIDATION_ERROR`: template de outro tipo de documento como padrão (V-06). */
export function templateOfOtherType(): ApiError {
  return validationError([
    {
      field: 'templateId',
      code: 'NOT_ALLOWED',
      message: 'Este template não pertence ao tipo selecionado.',
    },
  ]);
}
