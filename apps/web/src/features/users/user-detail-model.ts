import {
  MEMBERSHIP_DEPARTMENTS_REQUIRED_MESSAGE,
  updateMembershipDepartmentsSchema,
  updateMembershipSchema,
} from '@contrataflow/validation';
import type {
  TenantMembershipDetailDto,
  UpdateMembership,
  UpdateMembershipDepartments,
} from '@contrataflow/validation';

import { endOfLocalDayIso } from './invite-form-model';

/*
 * Modelo dos formulários do detalhe do usuário (SCR-029 · US-092): estado inicial a partir do
 * vínculo, "só o que mudou" para o PATCH e validação com os mesmos schemas da API (RN-IAM-55/56).
 */

export type ProfileField = 'jobTitle' | 'registrationNumber' | 'expiresAt';
export const PROFILE_FIELDS: readonly ProfileField[] = [
  'jobTitle',
  'registrationNumber',
  'expiresAt',
];
export type ProfileErrors = Partial<Record<ProfileField, string>>;

export interface ProfileFormState {
  readonly jobTitle: string;
  readonly registrationNumber: string;
  /** Valor do `<input type="date">` (`AAAA-MM-DD`, dia local); vazio fora de vínculos externos. */
  readonly expiresDate: string;
}

export const EXPIRES_REQUIRED_MESSAGE = 'Informe a validade do vínculo externo.';

/** ISO UTC → `AAAA-MM-DD` do dia local. */
export function localDateOf(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export function profileStateOf(
  membership: Pick<TenantMembershipDetailDto, 'jobTitle' | 'registrationNumber' | 'expiresAt'>,
): ProfileFormState {
  return {
    jobTitle: membership.jobTitle ?? '',
    registrationNumber: membership.registrationNumber ?? '',
    expiresDate: localDateOf(membership.expiresAt),
  };
}

/** Só os campos alterados; texto vazio limpa (`null`); a validade só vale para `EXTERNAL`. */
export function profilePatch(
  membership: Pick<
    TenantMembershipDetailDto,
    'type' | 'jobTitle' | 'registrationNumber' | 'expiresAt'
  >,
  state: ProfileFormState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const initial = profileStateOf(membership);
  for (const field of ['jobTitle', 'registrationNumber'] as const) {
    const value = state[field].trim();
    if (value !== initial[field].trim()) patch[field] = value === '' ? null : value;
  }
  if (membership.type === 'EXTERNAL' && state.expiresDate !== initial.expiresDate) {
    const iso = endOfLocalDayIso(state.expiresDate);
    if (iso) patch.expiresAt = iso;
  }
  return patch;
}

export type ProfileValidation =
  | { readonly ok: true; readonly data: UpdateMembership }
  | { readonly ok: false; readonly errors: ProfileErrors };

export function validateProfile(
  membership: Pick<
    TenantMembershipDetailDto,
    'type' | 'jobTitle' | 'registrationNumber' | 'expiresAt'
  >,
  state: ProfileFormState,
): ProfileValidation {
  // Não dá para apagar a validade de um vínculo externo que já tem uma.
  if (
    membership.type === 'EXTERNAL' &&
    state.expiresDate === '' &&
    localDateOf(membership.expiresAt) !== ''
  ) {
    return { ok: false, errors: { expiresAt: EXPIRES_REQUIRED_MESSAGE } };
  }
  const parsed = updateMembershipSchema.safeParse(profilePatch(membership, state));
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: ProfileErrors = {};
  for (const issue of parsed.error.issues) {
    const field = profileFieldOf(issue.path[0]);
    if (field) errors[field] ??= issue.message;
  }
  return { ok: false, errors };
}

/** Campo da tela a partir do caminho/nome de um erro (front ou `errors[].field` da API). */
export function profileFieldOf(path: unknown): ProfileField | null {
  const name = typeof path === 'string' ? path.split(/[.[]/)[0] : undefined;
  return PROFILE_FIELDS.find((field) => field === name) ?? null;
}

export function firstProfileErrorField(errors: ProfileErrors): ProfileField | null {
  return PROFILE_FIELDS.find((field) => errors[field] !== undefined) ?? null;
}

export function hasProfileChanges(
  membership: Pick<
    TenantMembershipDetailDto,
    'type' | 'jobTitle' | 'registrationNumber' | 'expiresAt'
  >,
  state: ProfileFormState,
): boolean {
  return Object.keys(profilePatch(membership, state)).length > 0;
}

/* ---------- Lotações (USR-09 · RN-IAM-56) ---------- */

export type DepartmentField = 'departmentIds' | 'primaryDepartmentId';
export type DepartmentErrors = Partial<Record<DepartmentField, string>>;

export interface DepartmentsState {
  readonly ids: readonly string[];
  readonly primary: string | null;
}

export function departmentsStateOf(
  membership: Pick<TenantMembershipDetailDto, 'departments'>,
): DepartmentsState {
  const ids = membership.departments.map((department) => department.id);
  const primary = membership.departments.find((department) => department.isPrimary)?.id;
  return { ids, primary: primary ?? ids[0] ?? null };
}

export function hasDepartmentChanges(
  membership: Pick<TenantMembershipDetailDto, 'departments'>,
  state: DepartmentsState,
): boolean {
  const initial = departmentsStateOf(membership);
  if (initial.primary !== state.primary || initial.ids.length !== state.ids.length) return true;
  const current = new Set(state.ids);
  return initial.ids.some((id) => !current.has(id));
}

export type DepartmentsValidation =
  | { readonly ok: true; readonly data: UpdateMembershipDepartments }
  | { readonly ok: false; readonly errors: DepartmentErrors };

/** FA-04: lista vazia é bloqueada aqui, antes de enviar. */
export function validateDepartments(state: DepartmentsState): DepartmentsValidation {
  if (state.ids.length === 0) {
    return { ok: false, errors: { departmentIds: MEMBERSHIP_DEPARTMENTS_REQUIRED_MESSAGE } };
  }
  const parsed = updateMembershipDepartmentsSchema.safeParse({
    departmentIds: [...state.ids],
    primaryDepartmentId: state.primary ?? '',
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: DepartmentErrors = {};
  for (const issue of parsed.error.issues) {
    const field = departmentFieldOf(issue.path[0]);
    if (field) errors[field] ??= issue.message;
  }
  return { ok: false, errors };
}

export function departmentFieldOf(path: unknown): DepartmentField | null {
  const name = typeof path === 'string' ? path.split(/[.[]/)[0] : undefined;
  return name === 'departmentIds' || name === 'primaryDepartmentId' ? name : null;
}
