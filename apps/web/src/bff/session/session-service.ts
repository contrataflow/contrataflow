import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type {
  IdentityProvider,
  MembershipSummary,
  ProviderLogin,
  SessionRecord,
  SessionStore,
} from './types';

/*
 * Ciclo de vida da sessão do BFF (authentication.md §4/§6): criação, expiração por ociosidade
 * (deslizante) e absoluta, renovação de token com trava por sessão, troca de tenant e
 * encerramento. Valores padrão de `security.sessionIdleMinutes`/`sessionAbsoluteHours`; a leitura
 * por tenant entra com a US-088.
 */

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;
/** Renova o access token quando faltam ≤ 60 s (RN-IAM-25). */
export const REFRESH_WINDOW_MS = 60_000;
/** Sessões simultâneas por usuário; a mais antiga é encerrada (RN-IAM-10). */
export const MAX_SESSIONS_PER_USER = 10;

/** `sid` aleatório de 256 bits, sempre novo a cada login (anti-fixação — RN-IAM-10). */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** Chave do registro: SHA-256 do id do cookie (o valor em claro nunca é armazenado). */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

/** Hash do user-agent guardado na sessão (o texto completo só vai para a auditoria). */
export function hashUserAgent(userAgent: string | null): string | null {
  return userAgent ? createHash('sha256').update(userAgent).digest('hex').slice(0, 32) : null;
}

export type SessionLookup =
  | { readonly status: 'none' }
  | { readonly status: 'expired'; readonly reason: 'IDLE' | 'ABSOLUTE' }
  | { readonly status: 'active'; readonly record: SessionRecord };

export type FreshToken =
  | { readonly status: 'ok'; readonly record: SessionRecord }
  /** Renovação definitiva falhou: sessão destruída (401 `SESSION_EXPIRED`). */
  | { readonly status: 'expired' }
  /** IdP indisponível e sem token válido: 503, sessão preservada (RN-IAM-26). */
  | { readonly status: 'unavailable' };

/** Dados da sessão nova, resolvidos pelo IdP (`login`) e pela API (usuário e vínculos). */
export interface NewSession {
  readonly login: ProviderLogin;
  readonly user: { readonly id: string; readonly displayName: string };
  readonly firstLogin: boolean;
  readonly memberships: readonly MembershipSummary[];
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export class SessionService {
  private readonly refreshing = new Map<string, Promise<FreshToken>>();

  constructor(
    private readonly store: SessionStore,
    private readonly identity: IdentityProvider,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Grava a sessão nova, ainda sem instituição ativa, com a chave = SHA-256 do `sessionId`.
   * Sessões além do limite por usuário são encerradas (devolvidas em `evicted`).
   */
  async create(
    sessionId: string,
    session: NewSession,
  ): Promise<{ record: SessionRecord; evicted: readonly string[] }> {
    const now = this.now();
    const absoluteExpiresAt = now + SESSION_ABSOLUTE_MS;
    const record: SessionRecord = {
      key: hashSessionId(sessionId),
      userId: session.user.id,
      subject: session.login.subject,
      displayName: session.user.displayName,
      activeTenantId: null,
      membershipId: null,
      memberships: session.memberships,
      tokens: session.login.tokens,
      amr: session.login.amr,
      authTime: session.login.authTime,
      firstLogin: session.firstLogin,
      ip: session.ip,
      userAgentHash: hashUserAgent(session.userAgent),
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: Math.min(now + SESSION_IDLE_MS, absoluteExpiresAt),
      absoluteExpiresAt,
    };
    const evicted = await this.store.create(record, MAX_SESSIONS_PER_USER);
    return { record, evicted };
  }

  async lookup(sessionId: string | null | undefined): Promise<SessionLookup> {
    if (!sessionId) return { status: 'none' };
    const key = hashSessionId(sessionId);
    const record = await this.store.get(key);
    if (!record) return { status: 'none' };
    const now = this.now();
    const reason =
      now >= record.absoluteExpiresAt ? 'ABSOLUTE' : now >= record.idleExpiresAt ? 'IDLE' : null;
    if (reason) {
      await this.store.delete(key);
      return { status: 'expired', reason };
    }
    return { status: 'active', record };
  }

  /** Requisição iniciada pelo usuário: renova a ociosidade (nunca além da absoluta). */
  async touch(record: SessionRecord): Promise<SessionRecord> {
    const now = this.now();
    const touched: SessionRecord = {
      ...record,
      lastSeenAt: now,
      idleExpiresAt: Math.min(now + SESSION_IDLE_MS, record.absoluteExpiresAt),
    };
    await this.store.save(touched);
    return touched;
  }

  /**
   * Garante access token válido, renovando perto do vencimento (ou sempre, com `force` — após 401
   * da API). Uma renovação por sessão por vez; requisições concorrentes aguardam a mesma.
   */
  ensureFreshToken(
    record: SessionRecord,
    options: { readonly force?: boolean } = {},
  ): Promise<FreshToken> {
    if (!options.force && record.tokens.accessTokenExpiresAt - this.now() > REFRESH_WINDOW_MS) {
      return Promise.resolve({ status: 'ok', record });
    }
    const inFlight = this.refreshing.get(record.key);
    if (inFlight) return inFlight;
    const refresh = this.refresh(record, options.force === true).finally(() => {
      this.refreshing.delete(record.key);
    });
    this.refreshing.set(record.key, refresh);
    return refresh;
  }

  private async refresh(record: SessionRecord, forced: boolean): Promise<FreshToken> {
    const result = await this.identity.refresh(record);
    if (result.kind === 'ok') {
      const current = (await this.store.get(record.key)) ?? record;
      const updated: SessionRecord = { ...current, tokens: result.tokens };
      await this.store.save(updated);
      return { status: 'ok', record: updated };
    }
    if (result.kind === 'invalid_grant') {
      await this.store.delete(record.key);
      return { status: 'expired' };
    }
    const stillValid = !forced && record.tokens.accessTokenExpiresAt > this.now();
    return stillValid ? { status: 'ok', record } : { status: 'unavailable' };
  }

  /**
   * Registra a instituição ativa, conferida pela API (RN-IAM-09/17), e a lista de vínculos mais
   * recente. Reaproveita a sessão (`sid`) — sem novo cookie (RN-IAM-66).
   */
  async activateTenant(
    record: SessionRecord,
    active: { readonly tenantId: string; readonly membershipId: string },
    memberships: readonly MembershipSummary[] = record.memberships,
  ): Promise<SessionRecord> {
    const updated: SessionRecord = {
      ...record,
      activeTenantId: active.tenantId,
      membershipId: active.membershipId,
      memberships,
    };
    await this.store.save(updated);
    return updated;
  }

  /** Step-up: substitui os tokens da sessão existente, sem novo login completo (RN-IAM-41). */
  async replaceTokens(record: SessionRecord, login: ProviderLogin): Promise<SessionRecord> {
    const updated: SessionRecord = {
      ...record,
      tokens: login.tokens,
      amr: login.amr,
      authTime: login.authTime,
    };
    await this.store.save(updated);
    return updated;
  }

  async destroy(key: string): Promise<void> {
    await this.store.delete(key);
  }
}
