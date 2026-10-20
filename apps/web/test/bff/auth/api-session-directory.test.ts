import { describe, expect, it, vi } from 'vitest';

import { ApiSessionDirectory, SESSION_EVENTS_PATH } from '@/bff/auth/api-session-directory';
import type { DirectoryFailureCause } from '@/bff/session/types';
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

/** Indisponível com a causa registrada no log (spec-486). */
function unavailable(cause: Partial<DirectoryFailureCause>) {
  return {
    kind: 'unavailable',
    cause: {
      apiInternalUrl: API_URL,
      status: null,
      code: null,
      error: null,
      attempts: 1,
      ...cause,
    },
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
    // Endereço do navegador também nos cabeçalhos: a API audita as negações pelo contexto (US-073).
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(headers.get('user-agent')).toBe('Vitest');
    expect(headers.get('x-cf-session-id-hash')).toBe('a'.repeat(64));
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

  it('troca pelo vínculo (US-093): membershipId, setAsDefault e a instituição padrão devolvida', async () => {
    const membershipId = RESULT.memberships[0]?.membershipId ?? '';
    const active = { membershipId, tenantId: TENANT, readOnly: false };
    const { subject, fetchMock } = directory(() =>
      Promise.resolve(
        Response.json({ data: { ...RESULT, activeMembership: active, defaultTenantId: TENANT } }),
      ),
    );
    const switched = await subject.activateTenant({
      ...CONTEXT,
      kind: 'switch',
      selection: 'MANUAL',
      firstLogin: false,
      fromTenantId: '0192a000-0000-7000-8000-00000000000b',
      tenantId: null,
      membershipId,
      setAsDefault: true,
    });
    expect(switched).toMatchObject({ kind: 'ok', active, defaultTenantId: TENANT });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ type: 'TENANT_SWITCHED', membershipId, setAsDefault: true });
    // Vínculo fora da lista da sessão: a API resolve a instituição pelo vínculo.
    expect(body).not.toHaveProperty('tenantId');
  });

  it.each([
    [
      '200 com mfaRequired',
      () => Promise.resolve(Response.json({ data: { ...RESULT, mfaRequired: true } })),
      { kind: 'mfa_required' },
    ],
    [
      '422 REFERENCE_NOT_FOUND',
      problem(422, 'VALIDATION_ERROR', {
        errors: [{ field: 'membershipId', code: 'REFERENCE_NOT_FOUND', message: 'x' }],
      }),
      { kind: 'invalid_reference' },
    ],
    [
      '422 de outro campo',
      problem(422, 'VALIDATION_ERROR', { errors: [{ field: 'ip', code: 'TOO_LONG' }] }),
      unavailable({ status: 422, code: 'VALIDATION_ERROR' }),
    ],
    [
      '422 sem corpo',
      () => Promise.resolve(new Response('x', { status: 422 })),
      unavailable({ status: 422 }),
    ],
  ])('troca: %s → %o', async (_case, response, expected) => {
    const { subject } = directory(response);
    expect(
      await subject.activateTenant({
        ...CONTEXT,
        kind: 'switch',
        selection: 'MANUAL',
        firstLogin: false,
        fromTenantId: null,
        tenantId: TENANT,
        membershipId: RESULT.memberships[0]?.membershipId ?? null,
      }),
    ).toEqual(expected);
  });

  it.each([
    ['401', problem(401, 'UNAUTHENTICATED'), { kind: 'unauthenticated' }],
    [
      '403 bloqueado',
      problem(403, 'PERMISSION_DENIED', { reason: 'USER_BLOCKED' }),
      { kind: 'blocked' },
    ],
    [
      '403 credencial de serviço',
      problem(403, 'PERMISSION_DENIED'),
      unavailable({ status: 403, code: 'PERMISSION_DENIED' }),
    ],
    ['403 sem vínculo', problem(403, 'MEMBERSHIP_INACTIVE'), { kind: 'no_membership' }],
    ['403 instituição', problem(403, 'TENANT_SUSPENDED'), { kind: 'tenant_unavailable' }],
    [
      '403 sem corpo',
      () => Promise.resolve(new Response('x', { status: 403 })),
      unavailable({ status: 403 }),
    ],
    [
      '503 (banco fora)',
      problem(503, 'DEPENDENCY_UNAVAILABLE'),
      unavailable({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' }),
    ],
    [
      '200 fora do contrato',
      () => Promise.resolve(Response.json({ data: { x: 1 } })),
      unavailable({ status: 200, code: 'CONTRACT_MISMATCH' }),
    ],
    [
      'rede',
      () => Promise.reject(new TypeError('fetch failed')),
      unavailable({ error: 'fetch failed' }),
    ],
    [
      'timeout',
      () =>
        Promise.reject(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
      unavailable({ code: 'TIMEOUT', error: 'The operation was aborted due to timeout' }),
    ],
  ])('%s → %o', async (_case, response, expected) => {
    const { subject } = directory(response);
    expect(await subject.startSession(CONTEXT)).toEqual(expected);
  });
});

/* spec-486: API reiniciando (porta fechada) — a conexão recusada é repetida com espera curta. */
describe('ApiSessionDirectory — conexão recusada', () => {
  function refused(viaAggregate = false) {
    const socket = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4000'), {
      code: 'ECONNREFUSED',
    });
    const cause = viaAggregate
      ? Object.assign(new AggregateError([socket], ''), { code: undefined })
      : socket;
    return Promise.reject(new TypeError('fetch failed', { cause }));
  }

  function retrying(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const subject = new ApiSessionDirectory({
      apiInternalUrl: API_URL,
      serviceToken: null,
      fetch: fetchMock,
      retryDelaysMs: [10, 20],
      sleep,
    });
    return { subject, sleep };
  }

  it('repete enquanto a porta está fechada e segue quando a API volta', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => refused())
      .mockImplementationOnce(() => refused(true))
      .mockImplementationOnce(() => Promise.resolve(Response.json({ data: RESULT })));
    const { subject, sleep } = retrying(fetchMock);
    expect(await subject.startSession(CONTEXT)).toMatchObject({ kind: 'ok', user: RESULT.user });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it('esgotadas as tentativas, devolve a causa de rede e o endereço usado', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => refused());
    const { subject } = retrying(fetchMock);
    expect(await subject.startSession(CONTEXT)).toEqual(
      unavailable({
        code: 'ECONNREFUSED',
        error: 'connect ECONNREFUSED 127.0.0.1:4000',
        attempts: 3,
      }),
    );
  });

  it('não repete timeout nem resposta HTTP (a requisição pode ter chegado)', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.reject(new DOMException('timeout', 'TimeoutError')),
    );
    const { subject, sleep } = retrying(fetchMock);
    expect(await subject.startSession(CONTEXT)).toMatchObject({ kind: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
