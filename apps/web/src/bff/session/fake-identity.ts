import 'server-only';

import { createHmac } from 'node:crypto';

import type {
  DirectoryContext,
  DirectoryResult,
  IdentityProvider,
  LoginCompletion,
  LoginSecrets,
  LoginStart,
  MembershipSummary,
  RefreshResult,
  RevocationResult,
  SessionDirectory,
  SessionRecord,
  SessionTokens,
  TenantActivation,
  TenantSummary,
} from './types';
import { newLoginSecrets } from '../auth/pkce';

/*
 * Identidade fake (FA-06 da US-086): provedor que emite access tokens HS256 com a mesma chave do
 * `FakeJwksProvider` da API e um diretório com pessoas fixas — para testes e desenvolvimento sem
 * Authentik. Só existe com `OIDC_FAKE_SIGNING_KEY` em local/dev/test (a configuração recusa nos
 * demais ambientes). O fluxo do BFF (transação cifrada, sessão, seleção de instituição) é o mesmo
 * do OIDC real (US-087).
 *
 * As pessoas e ids espelham o diretório em memória da API (apps/api/src/shared/testing/
 * fake-directory.ts), para que os guards de lá reconheçam os tokens daqui.
 */

const TENANTS = {
  prefeituraA: {
    id: '0192a000-0000-7000-8000-00000000000a',
    name: 'Prefeitura A',
    status: 'ACTIVE',
    timezone: 'America/Sao_Paulo',
    primaryColor: null,
  },
  prefeituraB: {
    id: '0192a000-0000-7000-8000-00000000000b',
    name: 'Prefeitura B',
    status: 'ACTIVE',
    timezone: 'America/Manaus',
    primaryColor: '#0f766e',
  },
  prefeituraSuspensa: {
    id: '0192a000-0000-7000-8000-00000000000c',
    name: 'Prefeitura Suspensa',
    status: 'SUSPENDED',
    timezone: 'America/Sao_Paulo',
    primaryColor: null,
  },
} as const satisfies Record<string, TenantSummary>;

function membership(membershipId: string, tenant: TenantSummary): MembershipSummary {
  return {
    membershipId,
    tenant,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    usable: true,
    readOnly: false,
  };
}

export interface FakePersona {
  readonly userId: string;
  readonly subject: string;
  readonly displayName: string;
  readonly memberships: readonly MembershipSummary[];
  /** Instituição padrão (RN-IAM-09: com vários vínculos, entra direto nela). */
  readonly defaultTenantId: string | null;
  /** Usuário bloqueado pela plataforma (RN-IAM-07). */
  readonly blocked?: boolean;
}

export const FAKE_PERSONAS = {
  /** Ana: Prefeitura A (padrão) e, só no BFF, a B — para exercitar a troca de tenant. */
  ana: {
    userId: '0192a000-0000-7000-8000-0000000000a1',
    subject: 'sub-ana',
    displayName: 'Ana Souza',
    memberships: [
      membership('0192a000-0000-7000-8000-0000000001a1', TENANTS.prefeituraA),
      membership('0192a000-0000-7000-8000-0000000002a1', TENANTS.prefeituraB),
    ],
    defaultTenantId: TENANTS.prefeituraA.id,
  },
  /** Bruno: vínculo suspenso na Prefeitura A (a API responde 403 `MEMBERSHIP_INACTIVE`). */
  bruno: {
    userId: '0192a000-0000-7000-8000-0000000000b1',
    subject: 'sub-bruno',
    displayName: 'Bruno Lima',
    memberships: [membership('0192a000-0000-7000-8000-0000000001b1', TENANTS.prefeituraA)],
    defaultTenantId: null,
  },
  /** Davi: vínculo na prefeitura suspensa (a API responde 403 `TENANT_SUSPENDED`). */
  davi: {
    userId: '0192a000-0000-7000-8000-0000000000d1',
    subject: 'sub-davi',
    displayName: 'Davi Rocha',
    memberships: [membership('0192a000-0000-7000-8000-0000000001d1', TENANTS.prefeituraSuspensa)],
    defaultTenantId: null,
  },
  /** Eva: bloqueada pela plataforma — nenhuma sessão (SCR-111 403). */
  eva: {
    userId: '0192a000-0000-7000-8000-0000000000e1',
    subject: 'sub-eva',
    displayName: 'Eva Prado',
    memberships: [membership('0192a000-0000-7000-8000-0000000001e1', TENANTS.prefeituraA)],
    defaultTenantId: null,
    blocked: true,
  },
  /** Gil: sem nenhum vínculo (sessão sem tenant → "sem vínculo"). */
  gil: {
    userId: '0192a000-0000-7000-8000-0000000000f1',
    subject: 'sub-gil',
    displayName: 'Gil Prado',
    memberships: [],
    defaultTenantId: null,
  },
} as const satisfies Record<string, FakePersona>;

export type FakePersonaName = keyof typeof FAKE_PERSONAS;

export const DEFAULT_FAKE_PERSONA: FakePersonaName = 'ana';

export function isFakePersona(value: string | null | undefined): value is FakePersonaName {
  return typeof value === 'string' && Object.hasOwn(FAKE_PERSONAS, value);
}

/** Pessoa pelo nome (`?as=` no login de desenvolvimento) ou pelo `sub` (step-up). */
export function findFakePersona(hint: string | null): FakePersonaName | null {
  if (isFakePersona(hint)) return hint;
  const entry = Object.entries(FAKE_PERSONAS).find(([, persona]) => persona.subject === hint);
  return entry ? (entry[0] as FakePersonaName) : null;
}

/** Validade do access token fake (igual ao padrão do `FakeJwksProvider`). */
export const FAKE_TOKEN_TTL_SECONDS = 300;

export interface FakeIdentityOptions {
  readonly signingKey: string;
  readonly issuer: string;
  readonly audience: string;
  readonly now?: (() => number) | undefined;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** `sub` de um token fake (sem verificar: o diretório fake só roda em local/dev/test). */
function subjectOf(accessToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export class FakeIdentityProvider implements IdentityProvider {
  readonly kind = 'fake' as const;
  private readonly now: () => number;

  constructor(private readonly options: FakeIdentityOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Access token HS256 aceito pelo `FakeJwksProvider` da API. */
  signAccessToken(subject: string, amr: readonly string[]): SessionTokens {
    const nowSeconds = Math.floor(this.now() / 1000);
    const exp = nowSeconds + FAKE_TOKEN_TTL_SECONDS;
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        iss: this.options.issuer,
        aud: this.options.audience,
        sub: subject,
        iat: nowSeconds,
        auth_time: nowSeconds,
        exp,
        amr,
      }),
    );
    const signature = createHmac('sha256', Buffer.from(this.options.signingKey, 'utf8'))
      .update(`${header}.${payload}`)
      .digest('base64url');
    return {
      accessToken: `${header}.${payload}.${signature}`,
      accessTokenExpiresAt: exp * 1000,
      refreshToken: `fake-refresh:${subject}`,
      idToken: null,
    };
  }

  beginLogin(input: {
    readonly appOrigin: string;
    readonly stepUp: boolean;
    readonly hint: string | null;
  }): Promise<LoginStart> {
    const persona = findFakePersona(input.hint) ?? DEFAULT_FAKE_PERSONA;
    const secrets = newLoginSecrets();
    const callback = new URL('/api/auth/callback', input.appOrigin);
    callback.searchParams.set('code', input.stepUp ? `${persona}:mfa` : persona);
    callback.searchParams.set('state', secrets.state);
    return Promise.resolve({ ...secrets, redirectUrl: callback.toString() });
  }

  completeLogin(params: URLSearchParams, _secrets: LoginSecrets): Promise<LoginCompletion> {
    if (params.get('error') !== null) {
      return Promise.resolve({ ok: false, reason: 'PROVIDER_ERROR' });
    }
    const [name, factor] = (params.get('code') ?? '').split(':');
    if (!isFakePersona(name) || (factor !== undefined && factor !== 'mfa')) {
      return Promise.resolve({ ok: false, reason: 'TOKEN_INVALID' });
    }
    const persona: FakePersona = FAKE_PERSONAS[name];
    const amr = factor === 'mfa' ? ['pwd', 'otp'] : ['pwd'];
    return Promise.resolve({
      ok: true,
      login: {
        subject: persona.subject,
        tokens: this.signAccessToken(persona.subject, amr),
        amr,
        authTime: this.now(),
      },
    });
  }

  refresh(record: SessionRecord): Promise<RefreshResult> {
    return Promise.resolve({
      kind: 'ok',
      tokens: this.signAccessToken(record.subject, record.amr),
    });
  }

  /** Nada a revogar: o provedor fake não emite refresh token real. */
  revokeRefreshToken(): Promise<RevocationResult> {
    return Promise.resolve('skipped');
  }

  endSessionUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/** Diretório fake: as pessoas acima no lugar de `POST /internal/session-events` da API. */
export class FakeSessionDirectory implements SessionDirectory {
  startSession(input: DirectoryContext): Promise<DirectoryResult> {
    const name = findFakePersona(subjectOf(input.accessToken));
    if (!name) return Promise.resolve({ kind: 'no_membership' });
    const persona: FakePersona = FAKE_PERSONAS[name];
    if (persona.blocked) return Promise.resolve({ kind: 'blocked' });
    return Promise.resolve({
      kind: 'ok',
      user: { id: persona.userId, displayName: persona.displayName },
      firstLogin: false,
      memberships: persona.memberships,
      defaultTenantId: persona.defaultTenantId,
      active: null,
    });
  }

  async activateTenant(input: TenantActivation): Promise<DirectoryResult> {
    const result = await this.startSession(input);
    if (result.kind !== 'ok') return result;
    const target = result.memberships.find(
      (candidate) => candidate.tenant.id === input.tenantId && candidate.usable,
    );
    if (!target) return { kind: 'no_membership' };
    return {
      ...result,
      firstLogin: input.firstLogin,
      active: { membershipId: target.membershipId, tenantId: target.tenant.id, readOnly: false },
    };
  }
}
