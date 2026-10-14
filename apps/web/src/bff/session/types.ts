import 'server-only';

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
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
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
  /** Grava um registro existente (atualização). */
  save(record: SessionRecord): Promise<void>;
  /**
   * Grava uma sessão nova e a inclui no índice do usuário; acima de `maxPerUser`, encerra as mais
   * antigas (RN-IAM-10) e devolve as chaves removidas.
   */
  create(record: SessionRecord, maxPerUser: number): Promise<readonly string[]>;
  delete(key: string): Promise<void>;
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

export interface IdentityProvider {
  readonly kind: 'fake' | 'oidc';
  beginLogin(input: {
    readonly appOrigin: string;
    readonly stepUp: boolean;
    readonly hint: string | null;
  }): Promise<LoginStart>;
  completeLogin(params: URLSearchParams, secrets: LoginSecrets): Promise<LoginCompletion>;
  refresh(record: SessionRecord): Promise<RefreshResult>;
  /** URL de *end-session* do IdP (RP-initiated logout); `null` quando não há. */
  endSessionUrl(record: SessionRecord | null): string | null;
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
  } | null;
}

export type DirectoryResult =
  | ({ readonly kind: 'ok' } & DirectoryIdentity)
  /** `User.status` `BLOCKED`/`DEACTIVATED` (403 `PERMISSION_DENIED` — V-05). */
  | { readonly kind: 'blocked' }
  /** Sem usuário ou sem vínculo com a instituição pedida (403 `MEMBERSHIP_INACTIVE`). */
  | { readonly kind: 'no_membership' }
  /** Instituição indisponível (403 `TENANT_SUSPENDED`). */
  | { readonly kind: 'tenant_unavailable' }
  /** Token recusado pela API (401). */
  | { readonly kind: 'unauthenticated' }
  /** API, banco ou JWKS indisponíveis (503/timeout). */
  | { readonly kind: 'unavailable' };

export interface DirectoryContext {
  readonly accessToken: string;
  readonly sessionIdHash: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
}

export type TenantActivation = DirectoryContext & {
  readonly tenantId: string;
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
