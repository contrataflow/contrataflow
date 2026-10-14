import { describe, expect, it, vi } from 'vitest';

import { ApiSessionDirectory, SESSION_EVENTS_PATH } from '@/bff/auth/api-session-directory';
import { API_URL } from '@test/support/bff';

/* Contrato BFF → API de sessão (US-087 · Lacuna 1): POST /internal/session-events. */

const CONTEXT = {
  accessToken: 'token-do-usuario',
  sessionIdHash: 'a'.repeat(64),
  ip: '203.0.113.7',
  userAgent: 'Vitest',
  correlationId: 'c-0001',
};

const TENANT = '0192a000-0000-7000-8000-00000000000a';

const RESULT = {
  user: { id: '0192a000-0000-7000-8000-0000000000a1', displayName: 'Cláudia Ferreira' },
  firstLogin: true,
  memberships: [
    {
      membershipId: '0192a000-0000-7000-8000-0000000001a1',
      tenant: {
        id: TENANT,
        name: 'Prefeitura de São José',
        status: 'ACTIVE',
        timezone: 'America/Sao_Paulo',
      },
      type: 'EXTERNAL',
      status: 'ACTIVE',
      expiresAt: '2026-12-31T23:59:59.000Z',
      usable: true,
      readOnly: false,
    },
  ],
  activeMembership: null,
  mfaRequired: false,
};

function directory(
  response: () => Promise<Response>,
  serviceToken: string | null = 's'.repeat(32),
) {
  const fetchMock = vi.fn<typeof fetch>(response);
  return {
    fetchMock,
    subject: new ApiSessionDirectory({ apiInternalUrl: API_URL, serviceToken, fetch: fetchMock }),
  };
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return () => Promise.resolve(Response.json({ code, ...extra }, { status }));
}

describe('ApiSessionDirectory', () => {
  it('[Sucesso] envia o access token, a credencial de serviço e o correlationId; mapeia vínculos', async () => {
    const { subject, fetchMock } = directory(() =>
      Promise.resolve(Response.json({ data: RESULT })),
    );
    const result = await subject.startSession(CONTEXT);
    expect(result).toEqual({
      kind: 'ok',
      user: RESULT.user,
      firstLogin: true,
      memberships: [
        {
          ...RESULT.memberships[0],
          tenant: { ...RESULT.memberships[0]?.tenant, primaryColor: null },
        },
      ],
      active: null,
      defaultTenantId: null,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${API_URL}${SESSION_EVENTS_PATH}`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer token-do-usuario');
    expect(headers.get('x-cf-service-token')).toBe('s'.repeat(32));
    expect(headers.get('x-correlation-id')).toBe('c-0001');
    expect(JSON.parse(init?.body as string)).toEqual({
      type: 'SESSION_STARTED',
      sessionIdHash: CONTEXT.sessionIdHash,
      ip: '203.0.113.7',
      userAgent: 'Vitest',
    });
  });

  it('ativação: SESSION_STARTED (primeira instituição) ou TENANT_SWITCHED, com a seleção', async () => {
    const active = {
      membershipId: RESULT.memberships[0]?.membershipId,
      tenantId: TENANT,
      readOnly: false,
    };
    const { subject, fetchMock } = directory(
      () => Promise.resolve(Response.json({ data: { ...RESULT, activeMembership: active } })),
      null,
    );
    const activation = {
      ...CONTEXT,
      tenantId: TENANT,
      selection: 'AUTO' as const,
      firstLogin: true,
      fromTenantId: null,
    };
    expect(await subject.activateTenant({ ...activation, kind: 'start' })).toMatchObject({
      kind: 'ok',
      active,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      type: 'SESSION_STARTED',
      tenantId: TENANT,
      selection: 'AUTO',
      firstLogin: true,
      fromTenantId: null,
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('x-cf-service-token')).toBe(
      false,
    );
    await subject.activateTenant({ ...activation, kind: 'switch', selection: 'MANUAL' });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      type: 'TENANT_SWITCHED',
    });
  });

  it.each([
    ['401', problem(401, 'UNAUTHENTICATED'), 'unauthenticated'],
    ['403 bloqueado', problem(403, 'PERMISSION_DENIED', { reason: 'USER_BLOCKED' }), 'blocked'],
    ['403 credencial de serviço', problem(403, 'PERMISSION_DENIED'), 'unavailable'],
    ['403 sem vínculo', problem(403, 'MEMBERSHIP_INACTIVE'), 'no_membership'],
    ['403 instituição', problem(403, 'TENANT_SUSPENDED'), 'tenant_unavailable'],
    ['403 sem corpo', () => Promise.resolve(new Response('x', { status: 403 })), 'unavailable'],
    ['503 (banco fora)', problem(503, 'DEPENDENCY_UNAVAILABLE'), 'unavailable'],
    [
      '200 fora do contrato',
      () => Promise.resolve(Response.json({ data: { x: 1 } })),
      'unavailable',
    ],
    ['rede', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
  ])('%s → %s', async (_case, response, kind) => {
    const { subject } = directory(response);
    expect(await subject.startSession(CONTEXT)).toEqual({ kind });
  });
});
