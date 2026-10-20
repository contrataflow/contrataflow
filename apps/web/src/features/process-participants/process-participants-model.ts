import { PARTICIPANT_LIMITS, PARTICIPANT_MESSAGES } from '@contrataflow/validation';
import type {
  AddProcessParticipantInput,
  DepartmentLookupItem,
  ParticipantRole,
  ProcessParticipantsMeta,
  UserLookupItem,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras do diálogo "Adicionar participante" e do botão "Seguir" (US-012 · SCR-112 · DEC-180):
 * valores do formulário, sugestão do papel Consultor para vínculo externo (fluxo principal, passo
 * 3), validação local (V-01..V-04 — a API confere de novo), o corpo do PRC-29 e a tradução dos
 * erros da API para campos.
 */

export type TargetType = 'USER' | 'DEPARTMENT';

export interface ParticipantFormValues {
  readonly targetType: TargetType;
  readonly user: UserLookupItem | null;
  readonly department: DepartmentLookupItem | null;
  readonly role: ParticipantRole;
  /** `datetime-local` (`AAAA-MM-DDTHH:mm`, hora local); só para Consultor. */
  readonly expiresAt: string;
  readonly notify: boolean;
  readonly reason: string;
}

export type ParticipantField = 'target' | 'role' | 'expiresAt' | 'reason';
export type ParticipantFieldMessages = Partial<Record<ParticipantField, string>>;

export const EMPTY_PARTICIPANT_FORM: ParticipantFormValues = {
  targetType: 'USER',
  user: null,
  department: null,
  role: 'OBSERVER',
  expiresAt: '',
  notify: true,
  reason: '',
};

/** Passo 3: vínculo `EXTERNAL` sugere o papel Consultor (e passa a exigir a validade). */
export function withUser(
  values: ParticipantFormValues,
  user: UserLookupItem | null,
): ParticipantFormValues {
  const suggested: ParticipantRole =
    user?.membershipType === 'EXTERNAL'
      ? 'CONSULTANT'
      : values.role === 'CONSULTANT'
        ? 'OBSERVER'
        : values.role;
  return { ...values, user, role: suggested };
}

/** Troca do tipo de alvo: limpa a seleção do outro tipo; unidade nunca é Consultor (RN-PROC-126). */
export function withTargetType(
  values: ParticipantFormValues,
  targetType: TargetType,
): ParticipantFormValues {
  return {
    ...values,
    targetType,
    user: null,
    department: null,
    role: targetType === 'DEPARTMENT' && values.role === 'CONSULTANT' ? 'OBSERVER' : values.role,
  };
}

/** Validade em `Date` (`null` = vazia ou inválida). */
function expiryOf(values: ParticipantFormValues): Date | null {
  if (values.expiresAt.trim() === '') return null;
  const date = new Date(values.expiresAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** V-01..V-04 no cliente (a API confere de novo, inclusive POL-10). */
export function validateParticipant(
  values: ParticipantFormValues,
  now: Date,
): ParticipantFieldMessages {
  const errors: ParticipantFieldMessages = {};
  const target = values.targetType === 'USER' ? values.user : values.department;
  if (target === null) errors.target = PARTICIPANT_MESSAGES.target;
  if (values.role === 'CONSULTANT') {
    if (values.targetType === 'DEPARTMENT') {
      errors.role = PARTICIPANT_MESSAGES.notEligibleConsultant;
    } else if (values.user !== null && values.user.membershipType !== 'EXTERNAL') {
      errors.role = PARTICIPANT_MESSAGES.notEligibleConsultant;
    }
    const expiresAt = expiryOf(values);
    if (values.expiresAt.trim() === '') {
      errors.expiresAt = PARTICIPANT_MESSAGES.expiresAtRequired;
    } else if (expiresAt === null) {
      errors.expiresAt = PARTICIPANT_MESSAGES.expiresAtFormat;
    } else if (expiresAt.getTime() <= now.getTime()) {
      errors.expiresAt = PARTICIPANT_MESSAGES.expiresAtFuture;
    } else if (
      values.user?.membershipExpiresAt &&
      expiresAt.getTime() > new Date(values.user.membershipExpiresAt).getTime()
    ) {
      errors.expiresAt = PARTICIPANT_MESSAGES.expiresAfterMembership;
    }
  }
  if (values.reason.trim().length > PARTICIPANT_LIMITS.reasonMax) {
    errors.reason = PARTICIPANT_MESSAGES.reasonLength;
  }
  return errors;
}

/** Corpo do PRC-29 (validade em ISO só para Consultor; motivo vazio não vai). */
export function participantBodyOf(values: ParticipantFormValues): AddProcessParticipantInput {
  const expiresAt = values.role === 'CONSULTANT' ? expiryOf(values) : null;
  const reason = values.reason.trim();
  return {
    ...(values.targetType === 'USER'
      ? { userId: values.user?.id ?? '' }
      : { departmentId: values.department?.id ?? '' }),
    role: values.role,
    notify: values.notify,
    ...(expiresAt === null ? {} : { expiresAt: expiresAt.toISOString() }),
    ...(reason === '' ? {} : { reason }),
  };
}

const FIELD_OF: Readonly<Record<string, ParticipantField>> = {
  userId: 'target',
  departmentId: 'target',
  role: 'role',
  expiresAt: 'expiresAt',
  reason: 'reason',
};

/** Recusa da API traduzida para o diálogo: erro por campo, papel atual (409) ou mensagem geral. */
export type ParticipantProblem =
  | { readonly kind: 'fields'; readonly fields: ParticipantFieldMessages }
  | { readonly kind: 'exists'; readonly currentRole: ParticipantRole | null }
  | { readonly kind: 'message'; readonly message: string }
  | { readonly kind: 'unavailable' };

export function participantProblemOf(error: unknown): ParticipantProblem {
  if (!isApiError(error)) return { kind: 'unavailable' };
  if (error.code === 'VALIDATION_ERROR') {
    const fields: ParticipantFieldMessages = {};
    for (const entry of error.problem?.errors ?? []) {
      const field = FIELD_OF[entry.field];
      if (field === undefined) continue;
      fields[field] =
        entry.code === 'REFERENCE_NOT_FOUND' || entry.code === 'REFERENCE_INACTIVE'
          ? PARTICIPANT_MESSAGES.invalidReference
          : entry.message;
    }
    return { kind: 'fields', fields };
  }
  if (error.code === 'PARTICIPANT_NOT_ELIGIBLE') {
    return {
      kind: 'fields',
      fields: { role: error.problem?.detail ?? PARTICIPANT_MESSAGES.notEligibleConsultant },
    };
  }
  if (error.code === 'PARTICIPANT_ALREADY_EXISTS') {
    const meta = error.problem?.meta as { currentRole?: ParticipantRole | null } | undefined;
    return { kind: 'exists', currentRole: meta?.currentRole ?? null };
  }
  if (error.status === 403) {
    return { kind: 'message', message: PARTICIPANT_MESSAGES.permissionDenied };
  }
  if (error.status === 429) {
    return { kind: 'message', message: error.problem?.detail ?? error.message };
  }
  return { kind: 'unavailable' };
}

/**
 * Estado do botão "Seguir" (FA-01 · RN-PROC-133): sem participação = "Seguir"; `OBSERVER` =
 * "Seguindo" (clicar deixa de seguir); outro papel = o papel atual, desabilitado.
 */
export type FollowState =
  | { readonly kind: 'FOLLOW' }
  | { readonly kind: 'FOLLOWING' }
  | { readonly kind: 'PARTICIPATING'; readonly role: ParticipantRole };

export function followStateOf(meta: ProcessParticipantsMeta): FollowState {
  if (meta.me === null) return { kind: 'FOLLOW' };
  return meta.me.role === 'OBSERVER'
    ? { kind: 'FOLLOWING' }
    : { kind: 'PARTICIPATING', role: meta.me.role };
}
