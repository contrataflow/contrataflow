import 'server-only';

import type { SessionEndReason, SessionPolicy } from '@contrataflow/types';
import type { SessionTombstone } from '@contrataflow/validation';

/*
 * Portas da sessão do BFF (authentication.md §3/§4 · DEC-131). Adaptadores (US-087): Redis de
 * sessões com tokens cifrados (`RedisSessionStore`), OIDC do Authentik com PKCE
 * (`OidcIdentityProvider`) e a API como diretório de identidade (`ApiSessionDirectory` —
 * `POST /internal/session-events`). Em memória/fake só em local/dev/test.
 */

export interface TenantSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  /** IANA (`Tenant.timezone` — DEC-003). */
  readonly timezone: string;
  /** `branding.primaryColor` (tema restrito, contraste validado no shell). */
  readonly primaryColor: string | null;
}

export interface MembershipSummary {
  readonly membershipId: string;
  readonly tenant: TenantSummary;
  /** `INTERNAL` | `EXTERNAL` | `SERVICE`. */
  readonly type: string;
  readonly status: string;
  /** Fim do vínculo (ISO 8601) — externos; `null` = sem prazo. */
  readonly expiresAt: string | null;
  /** Vínculo `ACTIVE`, não expirado e instituição disponível (ME-04 · RN-IAM-08). */
  readonly usable: boolean;
  /** Instituição em encerramento: somente leitura e exportação (DEC-132). */
  readonly readOnly: boolean;
}

export interface SessionTokens {
  readonly accessToken: string;
  /** Epoch em ms. */
  readonly accessTokenExpiresAt: number;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
}

/**
 * Troca de instituição suspensa pelo MFA do destino (RN-IAM-69 · US-093): guardada na sessão pelo
 * `POST /api/auth/switch-tenant` (com CSRF) e concluída no retorno do *step-up* — nunca por um
 * parâmetro de URL. Vale por 10 min (`PENDING_SWITCH_TTL_MS`), o prazo da transação do *step-up*.
 */
export interface PendingTenantSwitch {
  readonly membershipId: string;
  /** `null` quando o vínculo não estava na lista da sessão (a API resolve pelo vínculo). */
  readonly tenantId: string | null;
  readonly setAsDefault: boolean;
  /** Epoch em ms. */
  readonly requestedAt: number;
}

export interface SessionRecord {
  /** SHA-256 do id do cookie — nunca o valor em claro. */
  readonly key: string;
  readonly userId: string;
  readonly subject: string;
  readonly displayName: string;
  readonly activeTenantId: string | null;
  readonly membershipId: string | null;
  readonly memberships: readonly MembershipSummary[];
  readonly tokens: SessionTokens;
  readonly amr: readonly string[];
  /** `auth_time` do IdP (epoch ms); `null` se não informado. */
  readonly authTime: number | null;
  /** O `sub` foi vinculado nesta sessão (primeiro login) — vai para `auth.session_start`. */
  readonly firstLogin: boolean;
  /** IP do cliente (cadeia confiável) e hash do user-agent na criação. */
  readonly ip: string | null;
  readonly userAgentHash: string | null;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  /** Ociosidade da instituição ativa (`security.sessionIdleMinutes` — RN-IAM-21). */
  readonly idleMinutes: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  /** Troca à espera do *step-up* (US-093); ausente nos registros anteriores a ela. */
  readonly pendingTenantSwitch?: PendingTenantSwitch | null;
}

/** Cliente da requisição que encerra a sessão (vai para a auditoria do encerramento). */
export interface ClientDetails {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** Encerramento: motivo, horário real do fato e cliente (RN-IAM-24/28). */
export interface SessionEnding extends ClientDetails {
  readonly reason: SessionEndReason;
  readonly occurredAt: number;
}

/** Redis de sessões (ou o store) fora do ar: o BFF responde 503 — nunca "sessão expirada". */
export class SessionStoreUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Armazenamento de sessões indisponível.', options);
    this.name = 'SessionStoreUnavailableError';
  }
}

export interface SessionStore {
  get(key: string): Promise<SessionRecord | null>;
  /**
   * Atualiza um registro vivo. Nunca recria uma sessão já encerrada (Redis: `SET XX`) — uma
   * requisição em voo durante o logout não ressuscita a sessão.
   */
  save(record: SessionRecord): Promise<void>;
  /**
   * Leitura-modificação-gravação atômica sobre o registro MAIS RECENTE (Redis: *compare-and-set*
   * por script Lua, refeito se outra gravação chegou no meio): cada escrita muda só os seus campos
   * — a troca de instituição não desfaz a renovação de token feita em paralelo, e o `touch` de uma
   * requisição em voo não desfaz a troca (US-093 · Concorrência). `null` = sessão encerrada.
   */
  update(
    key: string,
    mutate: (current: SessionRecord) => SessionRecord,
  ): Promise<SessionRecord | null>;
  /**
   * Grava uma sessão nova e a inclui no índice do usuário; acima de `maxPerUser`, encerra as mais
   * antigas (`SESSION_LIMIT` — RN-IAM-10) e devolve as chaves encerradas.
   */
  create(record: SessionRecord, maxPerUser: number): Promise<readonly string[]>;
  /** Instituição ou limites mudaram: índice por vínculo e prazo da varredura (RN-IAM-27/28). */
  reindex(record: SessionRecord, previousMembershipId: string | null): Promise<void>;
  /**
   * Encerra: apaga os tokens e deixa o registro de encerramento para a auditoria da varredura.
   * `true` só para quem de fato encerrou (concorrentes recebem `false`).
   */
  end(record: SessionRecord, ending: SessionEnding): Promise<boolean>;
  /** Registro de encerramento ainda não auditado (no máximo 24 h). */
  getEnded(key: string): Promise<SessionTombstone | null>;
  /** Trava de renovação por sessão (`SET NX PX`); devolve o dono da trava ou `null`. */
  acquireRefreshLock(key: string, ttlMs: number): Promise<string | null>;
  releaseRefreshLock(key: string, owner: string): Promise<void>;
}

/** Login concluído no IdP: identidade do provedor e tokens (sem dados da aplicação). */
export interface ProviderLogin {
  readonly subject: string;
  readonly tokens: SessionTokens;
  readonly amr: readonly string[];
  readonly authTime: number | null;
}

/** Segredos de uma transação de login (guardados só no cookie cifrado — RN-IAM-02). */
export interface LoginSecrets {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface LoginStart extends LoginSecrets {
  /** Para onde o browser vai (IdP, ou o próprio callback no provedor fake). */
  readonly redirectUrl: string;
}

export type LoginFailureReason =
  | 'STATE_MISMATCH'
  | 'NONCE_MISMATCH'
  | 'TOKEN_INVALID'
  | 'PROVIDER_ERROR'
  /** IdP fora do ar ou `temporarily_unavailable`: "serviço de autenticação indisponível". */
  | 'PROVIDER_UNAVAILABLE';

export type LoginCompletion =
  | { readonly ok: true; readonly login: ProviderLogin }
  | { readonly ok: false; readonly reason: LoginFailureReason };

export type RefreshResult =
  | { readonly kind: 'ok'; readonly tokens: SessionTokens }
  /** Falha definitiva (`invalid_grant`, revogado): encerra a sessão (RN-IAM-26). */
  | { readonly kind: 'invalid_grant' }
  /** Falha transitória do IdP: segue com o token se ainda válido; senão 503. */
  | { readonly kind: 'transient' };

/** Revogação do refresh token (RFC 7009, melhor esforço — RN-IAM-20). */
export type RevocationResult =
  | 'revoked'
  /** Nada a revogar (sem refresh token, provedor sem endpoint de revogação, fake). */
  | 'skipped'
  /** IdP fora do ar ou lento (> 2 s): o logout local segue (FA-06). */
  | 'unavailable';

/** O IdP não respondeu ao montar o *RP-initiated logout* (FA-06). */
export class IdentityProviderUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Provedor de identidade indisponível.', options);
    this.name = 'IdentityProviderUnavailableError';
  }
}

export interface IdentityProvider {
  readonly kind: 'fake' | 'oidc';
  beginLogin(input: {
    readonly appOrigin: string;
    readonly stepUp: boolean;
    readonly hint: string | null;
    /** Após expiração: reautenticação no IdP, sem reaproveitar a sessão dele (RN-IAM-32). */
    readonly reauthenticate?: boolean;
  }): Promise<LoginStart>;
  completeLogin(params: URLSearchParams, secrets: LoginSecrets): Promise<LoginCompletion>;
  refresh(record: SessionRecord): Promise<RefreshResult>;
  revokeRefreshToken(record: SessionRecord): Promise<RevocationResult>;
  /**
   * URL de *end-session* do IdP (RP-initiated logout); `null` quando não há.
   * @throws IdentityProviderUnavailableError IdP fora do ar (descoberta)
   */
  endSessionUrl(): Promise<string | null>;
}

/** Identidade da aplicação resolvida pela API (`POST /internal/session-events`). */
export interface DirectoryIdentity {
  readonly user: { readonly id: string; readonly displayName: string };
  readonly firstLogin: boolean;
  readonly memberships: readonly MembershipSummary[];
  /** Instituição padrão do usuário, se houver (RN-IAM-09 — US-093). */
  readonly defaultTenantId: string | null;
  /** Instituição ativada pela chamada (com `tenantId`). */
  readonly active: {
    readonly membershipId: string;
    readonly tenantId: string;
    readonly readOnly: boolean;
    /**
     * Limites de sessão da instituição (`security.sessionIdleMinutes`/`sessionAbsoluteHours`);
     * ausente → padrão da plataforma, até a API expô-los com as configurações (US-103).
     */
    readonly sessionPolicy?: Partial<SessionPolicy> | null;
  } | null;
}

export type DirectoryResult =
  | ({ readonly kind: 'ok' } & DirectoryIdentity)
  /** A instituição de destino exige MFA que a sessão não tem: troca suspensa (RN-IAM-69). */
  | { readonly kind: 'mfa_required' }
  /** Vínculo que não é do usuário (422 `VALIDATION_ERROR` · `REFERENCE_NOT_FOUND` — V-01). */
  | { readonly kind: 'invalid_reference' }
  /** `User.status` `BLOCKED`/`DEACTIVATED` (403 `PERMISSION_DENIED` — V-05). */
  | { readonly kind: 'blocked' }
  /** Sem usuário ou sem vínculo com a instituição pedida (403 `MEMBERSHIP_INACTIVE`). */
  | { readonly kind: 'no_membership' }
  /** Instituição indisponível (403 `TENANT_SUSPENDED`). */
  | { readonly kind: 'tenant_unavailable' }
  /** Token recusado pela API (401). */
  | { readonly kind: 'unauthenticated' }
  /** API, banco ou JWKS indisponíveis (503/timeout); `cause` vai para o log do BFF. */
  | { readonly kind: 'unavailable'; readonly cause?: DirectoryFailureCause };

/** Por que o diretório ficou indisponível — só escalares, sem corpo de resposta (spec-486). */
export interface DirectoryFailureCause {
  /** Endereço interno da API usado na chamada. */
  readonly apiInternalUrl: string;
  /** Status HTTP da API; `null` quando não houve resposta (rede/timeout). */
  readonly status: number | null;
  /** `code` do problem details, código de rede (`ECONNREFUSED`), `TIMEOUT` ou `CONTRACT_MISMATCH`. */
  readonly code: string | null;
  /** Mensagem do erro de rede, quando houve. */
  readonly error: string | null;
  /** Tentativas feitas (conexão recusada é repetida — API reiniciando). */
  readonly attempts: number;
}

export interface DirectoryContext {
  readonly accessToken: string;
  readonly sessionIdHash: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
}

export type TenantActivation = DirectoryContext & {
  /** Instituição pedida; `null` quando o vínculo escolhido não está na lista da sessão. */
  readonly tenantId: string | null;
  /** Vínculo escolhido em SCR-101 (US-093) — conferido pela API contra os do usuário. */
  readonly membershipId?: string | null;
  /** "Usar como padrão" (FA-04 da US-093). */
  readonly setAsDefault?: boolean;
  /** `start`: primeira instituição da sessão (`auth.session_start`); `switch`: troca. */
  readonly kind: 'start' | 'switch';
  readonly selection: 'AUTO' | 'DEFAULT' | 'MANUAL';
  readonly firstLogin: boolean;
  readonly fromTenantId: string | null;
};

/** Contrato de sessão BFF → API (US-087 Lacuna 1). */
export interface SessionDirectory {
  /** Resolve o usuário pelo `sub` (vínculo do primeiro login, `lastLoginAt`) e lista os vínculos. */
  startSession(input: DirectoryContext): Promise<DirectoryResult>;
  /** Confere o vínculo e ativa a instituição (grava `auth.session_start`/`auth.tenant_switch`). */
  activateTenant(input: TenantActivation): Promise<DirectoryResult>;
}
