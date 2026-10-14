import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type {
  AuthenticatedIdentity,
  IdentityProvider,
  MembershipSummary,
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

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** Chave do registro: SHA-256 do id do cookie (o valor em claro nunca é armazenado). */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
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

export type TenantSwitch =
  | { readonly status: 'switched' | 'noop'; readonly record: SessionRecord }
  | { readonly status: 'not_usable' };

/** Instituição ativa ao criar a sessão: o único vínculo usável ou o primeiro (padrão). */
export function defaultMembership(
  memberships: readonly MembershipSummary[],
): MembershipSummary | null {
  return memberships.find((membership) => membership.usable) ?? null;
}

export class SessionService {
  private readonly refreshing = new Map<string, Promise<FreshToken>>();

  constructor(
    private readonly store: SessionStore,
    private readonly identity: IdentityProvider,
    private readonly now: () => number = Date.now,
  ) {}

  async create(
    identity: AuthenticatedIdentity,
  ): Promise<{ sessionId: string; record: SessionRecord }> {
    const sessionId = newSessionId();
    const now = this.now();
    const absoluteExpiresAt = now + SESSION_ABSOLUTE_MS;
    const active = defaultMembership(identity.memberships);
    const record: SessionRecord = {
      key: hashSessionId(sessionId),
      userId: identity.userId,
      subject: identity.subject,
      displayName: identity.displayName,
      activeTenantId: active?.tenant.id ?? null,
      membershipId: active?.membershipId ?? null,
      memberships: identity.memberships,
      tokens: identity.tokens,
      amr: identity.amr,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: Math.min(now + SESSION_IDLE_MS, absoluteExpiresAt),
      absoluteExpiresAt,
    };
    await this.store.save(record);
    return { sessionId, record };
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

  /** Troca a instituição ativa reaproveitando a sessão (RN-IAM-66/70). */
  async switchTenant(record: SessionRecord, tenantId: string): Promise<TenantSwitch> {
    if (record.activeTenantId === tenantId) return { status: 'noop', record };
    const target = record.memberships.find(
      (membership) => membership.tenant.id === tenantId && membership.usable,
    );
    if (!target) return { status: 'not_usable' };
    const updated: SessionRecord = {
      ...record,
      activeTenantId: target.tenant.id,
      membershipId: target.membershipId,
    };
    await this.store.save(updated);
    return { status: 'switched', record: updated };
  }

  /** Step-up: substitui os tokens da sessão existente, sem novo login completo (RN-IAM-41). */
  async replaceTokens(
    record: SessionRecord,
    identity: AuthenticatedIdentity,
  ): Promise<SessionRecord> {
    const updated: SessionRecord = { ...record, tokens: identity.tokens, amr: identity.amr };
    await this.store.save(updated);
    return updated;
  }

  async destroy(key: string): Promise<void> {
    await this.store.delete(key);
  }
}
