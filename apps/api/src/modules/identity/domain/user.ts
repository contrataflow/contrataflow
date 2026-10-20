import { isPreferenceKey, isPreferenceValue } from '@contrataflow/validation';
import type { UpdateMyProfile } from '@contrataflow/validation';

import type { UserStatus } from '#shared/auth/ports.js';

/**
 * `User` — identidade global (entities.md §4.2 · DEC-012). O `sub` do Authentik
 * (`externalSubject`) é vinculado no primeiro login e nunca muda depois (RN-IAM-06).
 */
export interface User {
  readonly id: string;
  /** `sub` do IdP; `null` até o primeiro login. */
  readonly externalSubject: string | null;
  /** PK do usuário no Authentik (convite/provisionamento). */
  readonly authentikUserId: string | null;
  readonly email: string;
  readonly name: string;
  /** Nome social (Decreto 8.727/2016): quando presente, é o nome exibido. */
  readonly socialName: string | null;
  readonly phone: string | null;
  readonly status: UserStatus;
  readonly preferences: Readonly<Record<string, unknown>>;
  readonly version: number;
}

/** O `sub` já pertence a outra identidade: o vínculo nunca é refeito (RN-IAM-06). */
export class SubjectAlreadyBoundError extends Error {
  constructor() {
    super('O usuário já está vinculado a outra identidade do provedor.');
    this.name = 'SubjectAlreadyBoundError';
  }
}

/** Nome exibido no cabeçalho e na sessão: nome social, se houver; senão o civil. */
export function displayName(user: Pick<User, 'name' | 'socialName'>): string {
  const social = user.socialName?.trim();
  if (social) return social;
  return user.name;
}

/**
 * Vincula o `sub` ao usuário (idempotente). Devolve `true` quando o vínculo é novo (primeiro
 * login) e `false` quando o mesmo `sub` já estava vinculado.
 * @throws SubjectAlreadyBoundError se o usuário já tem outro `sub`.
 */
export function bindExternalSubject(user: Pick<User, 'externalSubject'>, subject: string): boolean {
  if (user.externalSubject === null) return true;
  if (user.externalSubject === subject) return false;
  throw new SubjectAlreadyBoundError();
}

/** Só `ACTIVE` abre sessão; `BLOCKED`/`DEACTIVATED` são recusados (RN-IAM-07). */
export function canSignIn(user: Pick<User, 'status'>): boolean {
  return user.status === 'ACTIVE';
}

/** Preferências de interface de ME-01 com os padrões do registro (RN-IAM-111 — US-098). */
export function interfacePreferences(user: Pick<User, 'preferences'>): {
  density: string;
  theme: string;
} {
  const { density, theme } = user.preferences;
  return {
    density: typeof density === 'string' ? density : 'comfortable',
    theme: typeof theme === 'string' ? theme : 'system',
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Instituição padrão (`preferences.defaultTenantId` — RN-IAM-09 · FA-04 da US-093): pré-seleciona
 * a instituição nos próximos logins. Valor ausente ou malformado → nenhuma.
 */
export function defaultTenantOf(user: Pick<User, 'preferences'>): string | null {
  const { defaultTenantId } = user.preferences;
  return typeof defaultTenantId === 'string' && UUID_PATTERN.test(defaultTenantId)
    ? defaultTenantId.toLowerCase()
    : null;
}

/** E-mail mascarado para logs (DEC-138): `c***@saojose.sp.gov.br`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** Chave fora do registro de preferências (RN-IAM-111 → 422 `SETTING_KEY_UNKNOWN`). */
export class UnknownPreferenceKeysError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Preferência não reconhecida: ${keys.join(', ')}.`);
    this.name = 'UnknownPreferenceKeysError';
  }
}

/** Valor de preferência conhecida fora do registro (→ 422 `VALIDATION_ERROR`). */
export class InvalidPreferenceValueError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Valor de preferência inválido: ${keys.join(', ')}.`);
    this.name = 'InvalidPreferenceValueError';
  }
}

/** Campo alterado por `updateProfile`; o telefone já sai mascarado (nunca completo em trilha). */
export interface ProfileChange {
  readonly path: string;
  readonly old: unknown;
  readonly new: unknown;
}

export interface ProfileUpdate {
  readonly name: string;
  readonly socialName: string | null;
  readonly phone: string | null;
  /** `User.preferences` completo: as chaves enviadas sobre as já gravadas (merge raso). */
  readonly preferences: Readonly<Record<string, unknown>>;
  readonly changes: readonly ProfileChange[];
}

/** `***5678`: só os 4 últimos dígitos (RN-IAM-113 · Logs da US-098). */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length < 4 ? '***' : `***${digits.slice(-4)}`;
}

/**
 * `User.updateProfile` (RN-IAM-109..111): aplica `name`, `socialName`, `phone` e `preferences`
 * sobre o estado atual. Só o que difere entra em `changes` (RN-IAM-113); `changes` vazio = nada a
 * gravar. As demais chaves de `preferences` (ex.: `defaultTenantId`, da US-093) são preservadas.
 * @throws UnknownPreferenceKeysError chave fora do registro (nenhuma é aplicada).
 * @throws InvalidPreferenceValueError valor fora do registro.
 */
export function updateProfile(
  user: Pick<User, 'name' | 'socialName' | 'phone' | 'preferences'>,
  patch: UpdateMyProfile,
): ProfileUpdate {
  const unknown = Object.keys(patch.preferences ?? {}).filter((key) => !isPreferenceKey(key));
  if (unknown.length > 0) throw new UnknownPreferenceKeysError(unknown);
  const invalid = Object.entries(patch.preferences ?? {})
    .filter(([key, value]) => !isPreferenceValue(key, value))
    .map(([key]) => key);
  if (invalid.length > 0) throw new InvalidPreferenceValueError(invalid);

  const changes: ProfileChange[] = [];
  const name = patch.name ?? user.name;
  if (name !== user.name) changes.push({ path: 'name', old: user.name, new: name });
  const socialName = patch.socialName === undefined ? user.socialName : patch.socialName;
  if (socialName !== user.socialName) {
    changes.push({ path: 'socialName', old: user.socialName, new: socialName });
  }
  const phone = patch.phone === undefined ? user.phone : patch.phone;
  if (phone !== user.phone) {
    changes.push({ path: 'phone', old: maskPhone(user.phone), new: maskPhone(phone) });
  }

  const current = interfacePreferences(user);
  const preferences: Record<string, unknown> = { ...user.preferences };
  for (const [key, value] of Object.entries(patch.preferences ?? {})) {
    preferences[key] = value;
    const before = current[key as keyof typeof current];
    if (before !== value) changes.push({ path: `preferences.${key}`, old: before, new: value });
  }
  return { name, socialName, phone, preferences, changes };
}
