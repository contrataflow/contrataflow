import 'server-only';

/*
 * Portas da sessão do BFF (authentication.md §4 · DEC-131). Nesta story os adaptadores são o
 * store em memória e o provedor de identidade fake (FA-06); a US-087 liga o Redis de sessões
 * (tokens cifrados) e o OIDC do Authentik atrás das mesmas portas, sem mudar rotas nem shell.
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
  /** Vínculo `ACTIVE`, não expirado e tenant disponível (ME-04). */
  readonly usable: boolean;
}

export interface SessionTokens {
  readonly accessToken: string;
  /** Epoch em ms. */
  readonly accessTokenExpiresAt: number;
  readonly refreshToken: string | null;
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
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface SessionStore {
  get(key: string): Promise<SessionRecord | null>;
  save(record: SessionRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Identidade autenticada devolvida pelo provedor ao concluir o login. */
export interface AuthenticatedIdentity {
  readonly userId: string;
  readonly subject: string;
  readonly displayName: string;
  readonly memberships: readonly MembershipSummary[];
  readonly tokens: SessionTokens;
  readonly amr: readonly string[];
}

export interface LoginStart {
  /** Para onde o browser vai (IdP, ou o próprio callback no provedor fake). */
  readonly redirectUrl: string;
  /** Valor do cookie de transação (`state` vinculado ao browser — login CSRF). */
  readonly transaction: string;
}

export type LoginCompletion =
  | { readonly ok: true; readonly identity: AuthenticatedIdentity }
  | { readonly ok: false; readonly reason: 'STATE_MISMATCH' | 'TOKEN_INVALID' | 'PROVIDER_ERROR' };

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
    readonly state: string;
    readonly stepUp: boolean;
    readonly hint: string | null;
  }): Promise<LoginStart>;
  completeLogin(params: URLSearchParams, transaction: string | null): Promise<LoginCompletion>;
  refresh(record: SessionRecord): Promise<RefreshResult>;
  /** URL de *end-session* do IdP (RP-initiated logout); `null` quando não há. */
  endSessionUrl(record: SessionRecord | null): string | null;
}
