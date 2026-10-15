import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import {
  DEFAULT_SESSION_POLICY,
  isMembershipEndReason,
  isSessionExpiryReason,
  resolveSessionPolicy,
} from '@contrataflow/types';
import type {
  MembershipEndReason,
  SessionEndReason,
  SessionExpiryReason,
  SessionPolicy,
} from '@contrataflow/types';
import { sessionExpiry } from '@contrataflow/validation';

import { log } from '../logger';
import { recordRefresh } from '../metrics';
import type {
  ClientDetails,
  IdentityProvider,
  MembershipSummary,
  PendingTenantSwitch,
  ProviderLogin,
  SessionRecord,
  SessionStore,
} from './types';

/*
 * Ciclo de vida da sessão do BFF (authentication.md §4/§6/§7 · US-087/US-088): criação, expiração
 * por ociosidade (deslizante) e absoluta conforme a instituição ativa, renovação de token com trava
 * por sessão (no processo e entre réplicas), troca de tenant e encerramento. Todo encerramento
 * deixa no store um registro sem tokens com o motivo e o horário real do fato, que a varredura da
 * API transforma em `auth.session_end`/`auth.session_expired` (RN-IAM-28).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Renova o access token quando faltam ≤ 60 s (RN-IAM-25). */
export const REFRESH_WINDOW_MS = 60_000;
/** Validade da trava de renovação (`SET NX PX 10000` — Impacto técnico da US-088). */
export const REFRESH_LOCK_TTL_MS = 10_000;
/** Espera máxima de quem não obteve a trava (RN-IAM-25). */
export const REFRESH_WAIT_MS = 5_000;
export const REFRESH_POLL_MS = 100;
/** Sessões simultâneas por usuário; a mais antiga é encerrada (RN-IAM-10). */
export const MAX_SESSIONS_PER_USER = 10;
/** Validade da troca suspensa pelo MFA: o prazo da transação de login do *step-up* (US-093). */
export const PENDING_SWITCH_TTL_MS = 10 * MINUTE_MS;

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
  /** Ociosidade, duração absoluta ou renovação recusada → 401 `SESSION_EXPIRED` (V-03). */
  | { readonly status: 'expired'; readonly reason: SessionExpiryReason }
  /** Encerrada pelo worker (vínculo suspenso/revogado/expirado) → 403 `MEMBERSHIP_INACTIVE`. */
  | { readonly status: 'membership_ended'; readonly reason: MembershipEndReason }
  | { readonly status: 'active'; readonly record: SessionRecord };

export type FreshToken =
  | { readonly status: 'ok'; readonly record: SessionRecord }
  /** Renovação definitiva falhou: sessão encerrada (`REFRESH_FAILED` → 401 `SESSION_EXPIRED`). */
  | { readonly status: 'expired' }
  /** A sessão foi encerrada por outra requisição (logout em outra aba) → 401 `UNAUTHENTICATED`. */
  | { readonly status: 'ended' }
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

export interface SessionServiceOptions {
  readonly now?: () => number;
  /** Espera entre as conferências de quem aguarda a renovação de outra réplica (testes). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const NO_CLIENT: ClientDetails = { ip: null, userAgent: null };

function minutesBetween(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / MINUTE_MS));
}

export class SessionService {
  private readonly refreshing = new Map<string, Promise<FreshToken>>();
  /** Fim da fila de operações exclusivas de cada sessão neste processo. */
  private readonly exclusiveTails = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: SessionStore,
    private readonly identity: IdentityProvider,
    options: SessionServiceOptions | (() => number) = {},
  ) {
    const resolved = typeof options === 'function' ? { now: options } : options;
    this.now = resolved.now ?? Date.now;
    this.sleep =
      resolved.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /**
   * Grava a sessão nova, ainda sem instituição ativa (limites padrão da plataforma — FA-07), com
   * a chave = SHA-256 do `sessionId`. Sessões além do limite por usuário são encerradas.
   */
  async create(
    sessionId: string,
    session: NewSession,
  ): Promise<{ record: SessionRecord; evicted: readonly string[] }> {
    const now = this.now();
    const absoluteExpiresAt = now + DEFAULT_SESSION_POLICY.absoluteHours * HOUR_MS;
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
      idleMinutes: DEFAULT_SESSION_POLICY.idleMinutes,
      idleExpiresAt: Math.min(
        now + DEFAULT_SESSION_POLICY.idleMinutes * MINUTE_MS,
        absoluteExpiresAt,
      ),
      absoluteExpiresAt,
      pendingTenantSwitch: null,
    };
    const evicted = await this.store.create(record, MAX_SESSIONS_PER_USER);
    return { record, evicted };
  }

  /**
   * Sessão do cookie. Vencida → encerrada aqui mesmo, com o limite atingido como horário do fato
   * (RN-IAM-24); já encerrada → o motivo decide a resposta (expirada, vínculo ou nenhuma).
   */
  async lookup(
    sessionId: string | null | undefined,
    client: ClientDetails = NO_CLIENT,
  ): Promise<SessionLookup> {
    if (!sessionId) return { status: 'none' };
    const key = hashSessionId(sessionId);
    const record = await this.store.get(key);
    if (record) {
      const expiry = sessionExpiry(record, this.now());
      if (!expiry) return { status: 'active', record };
      await this.end(record, expiry.reason, { occurredAt: expiry.occurredAt, client });
      return { status: 'expired', reason: expiry.reason };
    }
    const ended = await this.store.getEnded(key);
    if (ended && isSessionExpiryReason(ended.reason)) {
      return { status: 'expired', reason: ended.reason };
    }
    if (ended && isMembershipEndReason(ended.reason)) {
      return { status: 'membership_ended', reason: ended.reason };
    }
    return { status: 'none' };
  }

  /**
   * Requisição iniciada pelo usuário (ou "Continuar conectado"): renova a ociosidade, nunca além
   * da duração absoluta (RN-IAM-21/22).
   */
  async touch(record: SessionRecord): Promise<SessionRecord> {
    const now = this.now();
    // Sobre o registro mais recente: o `touch` de uma requisição em voo não desfaz uma troca de
    // instituição nem uma renovação de token gravadas no meio (US-093).
    const apply = (current: SessionRecord): SessionRecord => ({
      ...current,
      lastSeenAt: now,
      idleExpiresAt: Math.min(now + current.idleMinutes * MINUTE_MS, current.absoluteExpiresAt),
    });
    return (await this.store.update(record.key, apply)) ?? apply(record);
  }

  /**
   * Executa `work` depois das demais operações exclusivas da mesma sessão neste processo — dois
   * cliques de troca de instituição não correm em paralelo (US-093 · Concorrência). Entre
   * réplicas, a gravação atômica do store mantém o registro íntegro.
   */
  async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveTails.get(key) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.exclusiveTails.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.exclusiveTails.get(key) === tail) this.exclusiveTails.delete(key);
    }
  }

  /**
   * Encerra a sessão (logout, expiração, renovação recusada, novo login no mesmo navegador):
   * tokens apagados, motivo e horário do fato guardados para a auditoria. `true` só para quem de
   * fato encerrou — o logout repetido não gera segundo registro.
   */
  async end(
    record: SessionRecord,
    reason: SessionEndReason,
    options: { readonly occurredAt?: number; readonly client?: ClientDetails } = {},
  ): Promise<boolean> {
    const client = options.client ?? NO_CLIENT;
    const occurredAt = options.occurredAt ?? this.now();
    const ended = await this.store.end(record, {
      reason,
      occurredAt,
      ip: client.ip,
      userAgent: client.userAgent,
    });
    if (ended && isSessionExpiryReason(reason)) {
      log('info', 'auth.session_expired', {
        reason,
        idleMinutes: record.idleMinutes,
        sessionAgeMinutes: minutesBetween(record.createdAt, occurredAt),
        tenantId: record.activeTenantId,
      });
    }
    return ended;
  }

  /**
   * Garante access token válido, renovando perto do vencimento (ou sempre, com `force` — após 401
   * da API). Uma renovação por sessão por vez: no processo, as requisições concorrentes aguardam a
   * mesma promessa; entre réplicas, a trava do store decide quem chama o IdP e as demais esperam
   * até 5 s pelo token novo (RN-IAM-25).
   */
  ensureFreshToken(
    record: SessionRecord,
    options: { readonly force?: boolean; readonly client?: ClientDetails } = {},
  ): Promise<FreshToken> {
    if (!options.force && record.tokens.accessTokenExpiresAt - this.now() > REFRESH_WINDOW_MS) {
      return Promise.resolve({ status: 'ok', record });
    }
    const inFlight = this.refreshing.get(record.key);
    if (inFlight) return inFlight;
    const refresh = this.refreshWithLock(
      record,
      options.force === true,
      options.client ?? NO_CLIENT,
    ).finally(() => {
      this.refreshing.delete(record.key);
    });
    this.refreshing.set(record.key, refresh);
    return refresh;
  }

  private async refreshWithLock(
    record: SessionRecord,
    forced: boolean,
    client: ClientDetails,
  ): Promise<FreshToken> {
    const owner = await this.store.acquireRefreshLock(record.key, REFRESH_LOCK_TTL_MS);
    if (owner === null) return this.awaitOtherRefresh(record, forced);
    try {
      // Outra réplica pode ter renovado (ou alguém encerrado) entre a leitura e a trava.
      const current = await this.store.get(record.key);
      if (!current) return await this.endedOutcome(record.key);
      if (current.tokens.accessToken !== record.tokens.accessToken) {
        return { status: 'ok', record: current };
      }
      return await this.refresh(current, forced, client);
    } finally {
      await this.store.releaseRefreshLock(record.key, owner);
    }
  }

  private async refresh(
    record: SessionRecord,
    forced: boolean,
    client: ClientDetails,
  ): Promise<FreshToken> {
    const started = this.now();
    const result = await this.identity.refresh(record);
    const latencyMs = this.now() - started;
    if (result.kind === 'ok') {
      // Rotação gravada de uma vez (tokens novos juntos), só nos tokens do registro mais recente:
      // uma troca de instituição feita durante a chamada ao IdP continua valendo.
      const withTokens = (current: SessionRecord): SessionRecord => ({
        ...current,
        tokens: result.tokens,
      });
      const updated = (await this.store.update(record.key, withTokens)) ?? withTokens(record);
      recordRefresh('ok');
      return { status: 'ok', record: updated };
    }
    if (result.kind === 'invalid_grant') {
      log('warn', 'auth.refresh_failed', { type: 'INVALID_GRANT', latencyMs });
      recordRefresh('invalid_grant');
      await this.end(record, 'REFRESH_FAILED', { client });
      return { status: 'expired' };
    }
    log('warn', 'auth.refresh_failed', { type: 'TRANSIENT', latencyMs });
    recordRefresh('transient');
    const stillValid = !forced && record.tokens.accessTokenExpiresAt > this.now();
    return stillValid ? { status: 'ok', record } : { status: 'unavailable' };
  }

  /** Outra réplica está renovando: espera o token novo (máx. 5 s) sem chamar o IdP. */
  private async awaitOtherRefresh(record: SessionRecord, forced: boolean): Promise<FreshToken> {
    for (let waited = 0; waited < REFRESH_WAIT_MS; waited += REFRESH_POLL_MS) {
      await this.sleep(REFRESH_POLL_MS);
      const current = await this.store.get(record.key);
      if (!current) return this.endedOutcome(record.key);
      if (current.tokens.accessToken !== record.tokens.accessToken) {
        return { status: 'ok', record: current };
      }
    }
    recordRefresh('lock_timeout');
    const stillValid = !forced && record.tokens.accessTokenExpiresAt > this.now();
    return stillValid ? { status: 'ok', record } : { status: 'unavailable' };
  }

  private async endedOutcome(key: string): Promise<FreshToken> {
    const ended = await this.store.getEnded(key);
    return ended?.reason === 'REFRESH_FAILED' ? { status: 'expired' } : { status: 'ended' };
  }

  /**
   * Registra a instituição ativa, conferida pela API (RN-IAM-09/17), a lista de vínculos mais
   * recente e os limites de sessão da instituição: a ociosidade conta do último uso e a duração
   * absoluta, da criação da sessão. Reaproveita a sessão (`sid`) — sem novo cookie (RN-IAM-66) — e
   * grava `activeTenantId`/`membershipId` juntos, numa única escrita atômica sobre o registro mais
   * recente (US-093 · Concorrência). Descarta uma troca pendente de *step-up*.
   */
  async activateTenant(
    record: SessionRecord,
    active: {
      readonly tenantId: string;
      readonly membershipId: string;
      readonly sessionPolicy?: Partial<SessionPolicy> | null;
    },
    memberships?: readonly MembershipSummary[],
  ): Promise<SessionRecord> {
    const policy = resolveSessionPolicy(active.sessionPolicy);
    let previousMembershipId = record.membershipId;
    const apply = (current: SessionRecord): SessionRecord => {
      previousMembershipId = current.membershipId;
      const absoluteExpiresAt = current.createdAt + policy.absoluteHours * HOUR_MS;
      return {
        ...current,
        activeTenantId: active.tenantId,
        membershipId: active.membershipId,
        memberships: memberships ?? current.memberships,
        idleMinutes: policy.idleMinutes,
        idleExpiresAt: Math.min(
          current.lastSeenAt + policy.idleMinutes * MINUTE_MS,
          absoluteExpiresAt,
        ),
        absoluteExpiresAt,
        pendingTenantSwitch: null,
      };
    };
    const updated = await this.store.update(record.key, apply);
    // Sessão encerrada no meio (logout em outra aba): nada a reindexar.
    if (!updated) return apply(record);
    await this.store.reindex(updated, previousMembershipId);
    return updated;
  }

  /**
   * Troca suspensa pelo MFA do destino (RN-IAM-69): guardada até o *step-up* voltar. Uma nova
   * escolha substitui a anterior.
   */
  async suspendTenantSwitch(
    record: SessionRecord,
    pending: Omit<PendingTenantSwitch, 'requestedAt'>,
  ): Promise<SessionRecord> {
    const apply = (current: SessionRecord): SessionRecord => ({
      ...current,
      pendingTenantSwitch: { ...pending, requestedAt: this.now() },
    });
    return (await this.store.update(record.key, apply)) ?? apply(record);
  }

  /** Troca pendente ainda válida (no máximo `PENDING_SWITCH_TTL_MS`); senão `null`. */
  pendingTenantSwitch(record: SessionRecord): PendingTenantSwitch | null {
    const pending = record.pendingTenantSwitch ?? null;
    if (!pending) return null;
    return this.now() - pending.requestedAt < PENDING_SWITCH_TTL_MS ? pending : null;
  }

  /** Abandona a troca pendente (recusada ou vencida no retorno do *step-up*). */
  async clearPendingTenantSwitch(record: SessionRecord): Promise<SessionRecord> {
    const apply = (current: SessionRecord): SessionRecord => ({
      ...current,
      pendingTenantSwitch: null,
    });
    return (await this.store.update(record.key, apply)) ?? apply(record);
  }

  /** Step-up: substitui os tokens da sessão existente, sem novo login completo (RN-IAM-41). */
  async replaceTokens(record: SessionRecord, login: ProviderLogin): Promise<SessionRecord> {
    const apply = (current: SessionRecord): SessionRecord => ({
      ...current,
      tokens: login.tokens,
      amr: login.amr,
      authTime: login.authTime,
    });
    return (await this.store.update(record.key, apply)) ?? apply(record);
  }
}
