import { inviteUserSchema } from '@contrataflow/validation';
import type { InviteUser, InvitationMembershipType } from '@contrataflow/validation';

/** Campos do `InviteUserForm`, na ordem da tela (o foco vai ao primeiro com erro). */
export const INVITE_FIELDS = [
  'email',
  'name',
  'type',
  'jobTitle',
  'expiresAt',
  'departmentIds',
  'roleId',
] as const;
export type InviteField = (typeof INVITE_FIELDS)[number];

export type InviteFieldErrors = Partial<Record<InviteField, string>>;

export interface InviteFormState {
  readonly email: string;
  readonly name: string;
  readonly type: InvitationMembershipType;
  readonly jobTitle: string;
  /** Valor do seletor de data (`AAAA-MM-DD`, dia local). */
  readonly expiresDate: string;
  readonly departmentIds: readonly string[];
  readonly roleId: string;
}

export const EMPTY_INVITE_FORM: InviteFormState = {
  email: '',
  name: '',
  type: 'INTERNAL',
  jobTitle: '',
  expiresDate: '',
  departmentIds: [],
  roleId: '',
};

/** `AAAA-MM-DD` → ISO UTC do fim do dia local (23:59:59.999); `undefined` se vazio ou inválido. */
export function endOfLocalDayIso(date: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const local = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(local.getTime()) ? undefined : local.toISOString();
}

/** Hoje (dia local) como `AAAA-MM-DD`, para o limite mínimo do seletor de data. */
export function todayLocalDate(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

/** Corpo cru de USR-03: só o que foi preenchido; a validade só vale para vínculo externo. */
export function toInviteInput(state: InviteFormState): Record<string, unknown> {
  const expiresAt = state.type === 'EXTERNAL' ? endOfLocalDayIso(state.expiresDate) : undefined;
  const jobTitle = state.jobTitle.trim();
  return {
    email: state.email,
    name: state.name,
    type: state.type,
    ...(jobTitle === '' ? {} : { jobTitle }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(state.departmentIds.length === 0 ? {} : { departmentIds: [...state.departmentIds] }),
    ...(state.roleId === '' ? {} : { roleId: state.roleId }),
  };
}

/** `departmentIds[0]` / `departmentIds.0` → `departmentIds`; campo desconhecido → `null`. */
export function inviteFieldOf(path: string | readonly PropertyKey[]): InviteField | null {
  const first =
    typeof path === 'string' ? (/^[^.[]+/.exec(path)?.[0] ?? '') : String(path[0] ?? '');
  return (INVITE_FIELDS as readonly string[]).includes(first) ? (first as InviteField) : null;
}

export type InviteValidation =
  | { readonly ok: true; readonly data: InviteUser }
  | { readonly ok: false; readonly errors: InviteFieldErrors; readonly formError: string | null };

/** Valida com o mesmo schema da API (RN-IAM-52); mensagens já vêm em pt-BR. */
export function validateInvite(state: InviteFormState): InviteValidation {
  const parsed = inviteUserSchema.safeParse(toInviteInput(state));
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: InviteFieldErrors = {};
  let formError: string | null = null;
  for (const issue of parsed.error.issues) {
    const field = inviteFieldOf(issue.path);
    if (field === null) formError ??= issue.message;
    else errors[field] ??= issue.message;
  }
  return { ok: false, errors, formError };
}

export function firstInviteErrorField(errors: InviteFieldErrors): InviteField | null {
  return INVITE_FIELDS.find((field) => errors[field] !== undefined) ?? null;
}
