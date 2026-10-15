/*
 * Sessão do BFF compartilhada entre web, api e worker (authentication.md §4/§7 · DEC-131 · US-088):
 * motivos de encerramento, limites configuráveis e o layout das chaves do Redis de sessões. O BFF
 * grava; a varredura (api) e o consumidor de eventos de vínculo (worker) leem e encerram.
 */

/** Motivos de encerramento de sessão (`endReason` — RN-IAM-28). */
export const SESSION_END_REASONS = [
  'LOGOUT',
  'SESSION_LIMIT',
  'MEMBERSHIP_SUSPENDED',
  'MEMBERSHIP_REVOKED',
  'MEMBERSHIP_EXPIRED',
  'IDLE',
  'ABSOLUTE',
  'REFRESH_FAILED',
] as const;

export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** Motivos que são expiração (`auth.session_expired`); os demais são `auth.session_end`. */
export const SESSION_EXPIRY_REASONS = ['IDLE', 'ABSOLUTE', 'REFRESH_FAILED'] as const;

export type SessionExpiryReason = (typeof SESSION_EXPIRY_REASONS)[number];

/** Encerramentos por mudança de vínculo (RN-IAM-27). */
export const MEMBERSHIP_END_REASONS = [
  'MEMBERSHIP_SUSPENDED',
  'MEMBERSHIP_REVOKED',
  'MEMBERSHIP_EXPIRED',
] as const;

export type MembershipEndReason = (typeof MEMBERSHIP_END_REASONS)[number];

export function isSessionEndReason(value: unknown): value is SessionEndReason {
  return typeof value === 'string' && (SESSION_END_REASONS as readonly string[]).includes(value);
}

export function isSessionExpiryReason(value: unknown): value is SessionExpiryReason {
  return typeof value === 'string' && (SESSION_EXPIRY_REASONS as readonly string[]).includes(value);
}

export function isMembershipEndReason(value: unknown): value is MembershipEndReason {
  return typeof value === 'string' && (MEMBERSHIP_END_REASONS as readonly string[]).includes(value);
}

/** Ação de auditoria do encerramento (events.md §7 · RN-IAM-28). */
export function sessionEndAuditAction(
  reason: SessionEndReason,
): 'auth.session_end' | 'auth.session_expired' {
  return isSessionExpiryReason(reason) ? 'auth.session_expired' : 'auth.session_end';
}

/**
 * Limites da plataforma para `security.sessionIdleMinutes` e `security.sessionAbsoluteHours`
 * (entities.md §6 · DEC-131): padrão 30 min / 12 h; o teto absoluto (24 h) também limita a sessão
 * do Authentik e a validade do refresh token (RN-IAM-32).
 */
export const SESSION_POLICY_LIMITS = {
  idleMinutes: { min: 5, max: 120, default: 30 },
  absoluteHours: { min: 1, max: 24, default: 12 },
} as const;

export interface SessionPolicy {
  readonly idleMinutes: number;
  readonly absoluteHours: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleMinutes: SESSION_POLICY_LIMITS.idleMinutes.default,
  absoluteHours: SESSION_POLICY_LIMITS.absoluteHours.default,
};

function withinLimits(
  value: unknown,
  limits: { readonly min: number; readonly max: number; readonly default: number },
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= limits.min &&
    value <= limits.max
    ? value
    : limits.default;
}

/**
 * Limites efetivos da instituição ativa: valor fora da faixa (ou ausente) cai no padrão da
 * plataforma — a sessão nunca fica sem limite nem acima do teto.
 */
export function resolveSessionPolicy(input?: Partial<SessionPolicy> | null): SessionPolicy {
  return {
    idleMinutes: withinLimits(input?.idleMinutes, SESSION_POLICY_LIMITS.idleMinutes),
    absoluteHours: withinLimits(input?.absoluteHours, SESSION_POLICY_LIMITS.absoluteHours),
  };
}

/**
 * Retenção dos registros de encerramento (sem tokens) e da sessão viva depois do fim absoluto:
 * a varredura tem até 24 h para gravar a auditoria antes de o Redis apagar a chave (RN-IAM-28).
 */
export const SESSION_ENDED_RETENTION_MS = 24 * 3_600_000;

/** Chaves do Redis de sessões (chaves de plataforma — nunca pelo `TenantCache`). */
export interface SessionKeyspace {
  /** `cf:{env}:sess:` — prefixo de todas as chaves. */
  readonly prefix: string;
  /** Registro vivo da sessão (tokens cifrados): `cf:{env}:sess:{sha256(sid)}`. */
  record(sessionKey: string): string;
  /** Registro de encerramento, sem tokens, até a varredura auditar (no máx. 24 h). */
  ended(sessionKey: string): string;
  /** Índice por usuário (sorted set por criação — RN-IAM-10). */
  user(userId: string): string;
  /** Índice por vínculo ativo (conjunto) — encerramento pelos eventos de vínculo (RN-IAM-27). */
  membership(membershipId: string): string;
  /** Prazos (sorted set por limite) — base da varredura (RN-IAM-28). */
  readonly expiry: string;
  /** Trava de renovação do access token por sessão (RN-IAM-25). */
  refreshLock(sessionKey: string): string;
  /** Trava da varredura (uma réplica por ciclo). */
  readonly sweepLock: string;
}

export function sessionKeyspace(appEnv: string): SessionKeyspace {
  const prefix = `cf:${appEnv}:sess:`;
  return {
    prefix,
    record: (sessionKey) => `${prefix}${sessionKey}`,
    ended: (sessionKey) => `${prefix}end:${sessionKey}`,
    user: (userId) => `${prefix}user:${userId}`,
    membership: (membershipId) => `${prefix}membership:${membershipId}`,
    expiry: `${prefix}expiry`,
    refreshLock: (sessionKey) => `${prefix}lock:${sessionKey}`,
    sweepLock: `${prefix}sweep:lock`,
  };
}
