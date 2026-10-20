import { MEMBERSHIP_SELF_PROTECTION_MESSAGE } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/**
 * Como o detalhe do usuário reage a cada erro das mutações USR-08..12 (Casos de erro da US-092):
 * - `stale`: o dado em tela ficou velho (412, 409 `INVALID_STATE`) — recarrega o detalhe;
 * - `notFound`: 404 — volta à lista;
 * - `unavailable`: 503 — mantém os dados e oferece "Tentar novamente";
 * - `mfa`: 403 `MFA_REQUIRED` — link de *step-up*;
 * - `lastAdmin`: 409 `LAST_ADMIN_REQUIRED` — sugere promover outro administrador antes;
 * - `validation`: 422 — erros por campo;
 * - `plain`: demais (403 incluindo POL-16, 5xx).
 */
export type UserErrorKind =
  'stale' | 'notFound' | 'unavailable' | 'mfa' | 'lastAdmin' | 'validation' | 'plain';

export interface UserFeedback {
  readonly message: string;
  /** Orientação complementar (ex.: promover outro administrador antes). */
  readonly hint?: string | undefined;
  readonly kind: UserErrorKind;
}

/** Tradutor de `users.detail.errors.*` (`useTranslations('users.detail.errors')`). */
export type ErrorKey =
  | 'generic'
  | 'permission'
  | 'selfProtected'
  | 'mfa'
  | 'notFound'
  | 'lastAdmin'
  | 'lastAdminHint'
  | 'invalidState'
  | 'invalidStateHint'
  | 'conflict'
  | 'conflictHint'
  | 'unavailable';
export type ErrorTranslator = (key: ErrorKey) => string;

export function describeUserError(error: unknown, t: ErrorTranslator): UserFeedback {
  if (!isApiError(error)) return { kind: 'plain', message: t('generic') };
  if (error.code === 'MFA_REQUIRED') return { kind: 'mfa', message: t('mfa') };
  if (error.status === 404) return { kind: 'notFound', message: t('notFound') };
  if (error.code === 'LAST_ADMIN_REQUIRED') {
    return { kind: 'lastAdmin', message: t('lastAdmin'), hint: t('lastAdminHint') };
  }
  if (error.code === 'INVALID_STATE') {
    return { kind: 'stale', message: t('invalidState'), hint: t('invalidStateHint') };
  }
  if (error.status === 412) {
    return { kind: 'stale', message: t('conflict'), hint: t('conflictHint') };
  }
  if (error.status === 403) {
    // POL-16 também é 403 `PERMISSION_DENIED`; a API distingue pela mensagem.
    return {
      kind: 'plain',
      message:
        error.message === MEMBERSHIP_SELF_PROTECTION_MESSAGE ? t('selfProtected') : t('permission'),
    };
  }
  if (error.status === 503) return { kind: 'unavailable', message: t('unavailable') };
  if (error.status === 422) return { kind: 'validation', message: error.message || t('generic') };
  return { kind: 'plain', message: error.message || t('generic') };
}
