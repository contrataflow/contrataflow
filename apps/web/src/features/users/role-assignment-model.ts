import {
  ROLE_ASSIGNMENT_VALIDITY_MESSAGE,
  SUBTREE_SCOPE_TYPES,
  assignRoleSchema,
} from '@contrataflow/validation';
import type {
  AssignRole,
  RoleAssignmentDto,
  ScopeTypeValue,
  TenantMembershipDetailDto,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { endOfLocalDayIso, todayLocalDate } from './invite-form-model';

/*
 * Formulário "Atribuir perfil" (US-096 · SCR-029): estado, corpo de ROL-11 e validação no cliente
 * com o mesmo `assignRoleSchema` da API (V-01/V-02/V-04), mais a validade do vínculo externo.
 */

export interface AssignFormState {
  readonly roleId: string;
  readonly scopeType: ScopeTypeValue;
  readonly scopeOrganizationId: string;
  readonly scopeDepartmentId: string;
  readonly includeSubtree: boolean;
  /** `AAAA-MM-DD` (dia local); vazio ou hoje = agora. */
  readonly validFromDate: string;
  /** `AAAA-MM-DD` (dia local); vazio = sem término. */
  readonly validUntilDate: string;
}

export const EMPTY_ASSIGN_FORM: AssignFormState = {
  roleId: '',
  scopeType: 'TENANT',
  scopeOrganizationId: '',
  scopeDepartmentId: '',
  includeSubtree: true,
  validFromDate: '',
  validUntilDate: '',
};

export type AssignField =
  'roleId' | 'scopeType' | 'scopeOrganizationId' | 'scopeDepartmentId' | 'validFrom' | 'validUntil';

export type AssignErrors = Partial<Record<AssignField, string>>;

const FIELDS: readonly AssignField[] = [
  'roleId',
  'scopeType',
  'scopeOrganizationId',
  'scopeDepartmentId',
  'validFrom',
  'validUntil',
];

const isField = (value: unknown): value is AssignField =>
  typeof value === 'string' && (FIELDS as readonly string[]).includes(value);

/** `AAAA-MM-DD` → ISO UTC do início do dia local; `undefined` se vazio ou inválido. */
function startOfLocalDayIso(date: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const local = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(local.getTime()) ? undefined : local.toISOString();
}

/** Corpo de ROL-11: só o que vale para o escopo; início hoje (ou vazio) fica a cargo da API. */
export function toAssignInput(
  state: AssignFormState,
  now: Date = new Date(),
): Record<string, unknown> {
  const validFrom =
    state.validFromDate === '' || state.validFromDate <= todayLocalDate(now)
      ? undefined
      : startOfLocalDayIso(state.validFromDate);
  const validUntil = endOfLocalDayIso(state.validUntilDate);
  return {
    roleId: state.roleId === '' ? undefined : state.roleId,
    scopeType: state.scopeType,
    ...(state.scopeType === 'ORGANIZATION'
      ? { scopeOrganizationId: state.scopeOrganizationId || null }
      : {}),
    ...(state.scopeType === 'DEPARTMENT'
      ? { scopeDepartmentId: state.scopeDepartmentId || null }
      : {}),
    ...(SUBTREE_SCOPE_TYPES.includes(state.scopeType)
      ? { includeSubtree: state.includeSubtree }
      : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
  };
}

/**
 * V-01/V-02/V-04 no cliente: o schema da API, o término depois de hoje/início e — vínculo externo —
 * não depois da validade do vínculo (RN-IAM-93).
 */
export function validateAssign(
  state: AssignFormState,
  membership: Pick<TenantMembershipDetailDto, 'type' | 'expiresAt'>,
  now: Date = new Date(),
):
  | { readonly body: AssignRole; readonly errors: null }
  | { readonly body: null; readonly errors: AssignErrors } {
  const errors: AssignErrors = {};
  const parsed = assignRoleSchema.safeParse(toAssignInput(state, now));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [field] = issue.path;
      if (isField(field) && errors[field] === undefined) errors[field] = issue.message;
    }
  }
  const until = endOfLocalDayIso(state.validUntilDate);
  if (until !== undefined && errors.validUntil === undefined) {
    const from = startOfLocalDayIso(state.validFromDate) ?? now.toISOString();
    const limit = membership.type === 'EXTERNAL' ? membership.expiresAt : null;
    if (
      Date.parse(until) <= Math.max(Date.parse(from), now.getTime()) ||
      (limit !== null && Date.parse(until) > Date.parse(limit))
    ) {
      errors.validUntil = ROLE_ASSIGNMENT_VALIDITY_MESSAGE;
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { body: null, errors };
  return { body: parsed.data, errors: null };
}

/** Erros por campo de um 422 `VALIDATION_ERROR` de ROL-11. */
export function apiFieldErrors(error: unknown): AssignErrors {
  if (!isApiError(error)) return {};
  const errors: AssignErrors = {};
  for (const item of error.errors) {
    if (isField(item.field) && errors[item.field] === undefined) errors[item.field] = item.message;
  }
  return errors;
}

/** "Agendada", "Encerrada" ou vigente — status derivado das datas (o contrato só tem ACTIVE/REVOKED). */
export type AssignmentPhase = 'SCHEDULED' | 'ENDED' | 'EFFECTIVE';

export function assignmentPhase(
  assignment: Pick<RoleAssignmentDto, 'validFrom' | 'validUntil'>,
  now: Date = new Date(),
): AssignmentPhase {
  if (Date.parse(assignment.validFrom) > now.getTime()) return 'SCHEDULED';
  if (assignment.validUntil !== null && Date.parse(assignment.validUntil) <= now.getTime()) {
    return 'ENDED';
  }
  return 'EFFECTIVE';
}
