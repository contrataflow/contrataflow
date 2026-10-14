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

/** E-mail mascarado para logs (DEC-138): `c***@saojose.sp.gov.br`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
