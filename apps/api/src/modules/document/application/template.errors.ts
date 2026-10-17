import { LAYOUT_MESSAGES } from '@contrataflow/validation';
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

/** 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`): logo inexistente, de outro tenant ou de outro alvo (V-05). */
export function templateLogoNotFound(): ApiError {
  return validationError([
    {
      field: 'layout.logo.attachmentId',
      code: 'REFERENCE_NOT_FOUND',
      message: LAYOUT_MESSAGES.logoInvalid,
    },
  ]);
}

/** 422 `VALIDATION_ERROR` (`INVALID_FORMAT`): o anexo não é uma imagem aceita como logo (RN-TPL-23). */
export function templateLogoNotImage(): ApiError {
  return validationError([
    {
      field: 'layout.logo.attachmentId',
      code: 'INVALID_FORMAT',
      message: 'O logo deve ser uma imagem PNG, JPEG ou SVG.',
    },
  ]);
}

/** 409 `ATTACHMENT_NOT_AVAILABLE`: o logo existe mas ainda não está `AVAILABLE` (V-05). */
export function templateLogoNotAvailable(): ApiError {
  return new ApiError('ATTACHMENT_NOT_AVAILABLE', {
    detail: LAYOUT_MESSAGES.logoInvalid,
    extensions: { field: 'layout.logo.attachmentId' },
  });
}

/** 404 da prévia efêmera inexistente, vencida (24 h) ou de outro tenant (TPL-12/13). */
export function templatePreviewNotFound(): ApiError {
  return new ApiError('NOT_FOUND', {
    detail: 'Prévia não encontrada ou expirada. Gere novamente.',
  });
}

/** 409 `RENDITION_NOT_READY`: download da prévia antes de pronta (TPL-13). */
export function templatePreviewNotReady(): ApiError {
  return new ApiError('RENDITION_NOT_READY', {
    detail: 'A prévia ainda está sendo gerada. Aguarde.',
  });
}

/** 503 `DEPENDENCY_UNAVAILABLE`: Redis/storage da prévia fora do ar. */
export function templatePreviewUnavailable(cause: unknown): ApiError {
  return new ApiError('DEPENDENCY_UNAVAILABLE', {
    detail: 'Não foi possível processar a prévia agora. Tente novamente.',
    cause,
  });
}
