import 'server-only';

import { createHmac } from 'node:crypto';

import type {
  AuthenticatedIdentity,
  IdentityProvider,
  LoginCompletion,
  LoginStart,
  MembershipSummary,
  RefreshResult,
  SessionRecord,
  SessionTokens,
  TenantSummary,
} from './types';

/*
 * Provedor de identidade fake (FA-06): emite access tokens HS256 com a mesma chave do
 * `FakeJwksProvider` da API (US-080), por trás da mesma sessão do BFF. Só existe com
 * `OIDC_FAKE_SIGNING_KEY` em local/dev/test (a configuração recusa nos demais ambientes) e é
 * substituído pelo OIDC do Authentik na US-087 sem mudar rotas, shell ou proxy.
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

export interface FakePersona {
  readonly userId: string;
  readonly subject: string;
  readonly displayName: string;
  readonly memberships: readonly MembershipSummary[];
}

export const FAKE_PERSONAS = {
  /** Ana: vínculo ativo na Prefeitura A (e, só no BFF, na B — para exercitar a troca de tenant). */
  ana: {
    userId: '0192a000-0000-7000-8000-0000000000a1',
    subject: 'sub-ana',
    displayName: 'Ana Souza',
    memberships: [
      {
        membershipId: '0192a000-0000-7000-8000-0000000001a1',
        tenant: TENANTS.prefeituraA,
        usable: true,
      },
      {
        membershipId: '0192a000-0000-7000-8000-0000000002a1',
        tenant: TENANTS.prefeituraB,
        usable: true,
      },
    ],
  },
  /** Bruno: vínculo suspenso na Prefeitura A (a API responde 403 `MEMBERSHIP_INACTIVE`). */
  bruno: {
    userId: '0192a000-0000-7000-8000-0000000000b1',
    subject: 'sub-bruno',
    displayName: 'Bruno Lima',
    memberships: [
      {
        membershipId: '0192a000-0000-7000-8000-0000000001b1',
        tenant: TENANTS.prefeituraA,
        usable: true,
      },
    ],
  },
  /** Davi: vínculo na prefeitura suspensa (a API responde 403 `TENANT_SUSPENDED`). */
  davi: {
    userId: '0192a000-0000-7000-8000-0000000000d1',
    subject: 'sub-davi',
    displayName: 'Davi Rocha',
    memberships: [
      {
        membershipId: '0192a000-0000-7000-8000-0000000001d1',
        tenant: TENANTS.prefeituraSuspensa,
        usable: true,
      },
    ],
  },
  /** Gil: sem nenhum vínculo (sessão sem tenant → seleção de órgão / "sem vínculo"). */
  gil: {
    userId: '0192a000-0000-7000-8000-0000000000f1',
    subject: 'sub-gil',
    displayName: 'Gil Prado',
    memberships: [],
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
    };
  }

  beginLogin(input: {
    readonly appOrigin: string;
    readonly state: string;
    readonly stepUp: boolean;
    readonly hint: string | null;
  }): Promise<LoginStart> {
    const persona = findFakePersona(input.hint) ?? DEFAULT_FAKE_PERSONA;
    const callback = new URL('/api/auth/callback', input.appOrigin);
    callback.searchParams.set('code', input.stepUp ? `${persona}:mfa` : persona);
    callback.searchParams.set('state', input.state);
    return Promise.resolve({ redirectUrl: callback.toString(), transaction: input.state });
  }

  completeLogin(params: URLSearchParams, transaction: string | null): Promise<LoginCompletion> {
    const state = params.get('state');
    if (!transaction || !state || state !== transaction) {
      return Promise.resolve({ ok: false, reason: 'STATE_MISMATCH' });
    }
    const [name, factor] = (params.get('code') ?? '').split(':');
    if (!isFakePersona(name) || (factor !== undefined && factor !== 'mfa')) {
      return Promise.resolve({ ok: false, reason: 'TOKEN_INVALID' });
    }
    const persona: FakePersona = FAKE_PERSONAS[name];
    const amr = factor === 'mfa' ? ['pwd', 'otp'] : ['pwd'];
    const identity: AuthenticatedIdentity = {
      userId: persona.userId,
      subject: persona.subject,
      displayName: persona.displayName,
      memberships: persona.memberships,
      tokens: this.signAccessToken(persona.subject, amr),
      amr,
    };
    return Promise.resolve({ ok: true, identity });
  }

  refresh(record: SessionRecord): Promise<RefreshResult> {
    return Promise.resolve({
      kind: 'ok',
      tokens: this.signAccessToken(record.subject, record.amr),
    });
  }

  endSessionUrl(): string | null {
    return null;
  }
}
