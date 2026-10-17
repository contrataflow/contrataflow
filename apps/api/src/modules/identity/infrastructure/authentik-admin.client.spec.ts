import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthentikAdminClient, DisabledAuthentikDirectory } from './authentik-admin.client.js';
import { AuthentikUnavailableError } from '../application/invitation-ports.js';

/* RN-IAM-06: confirmação, na API do Authentik, do usuário dono do `sub` (primeiro login). */

const SUB = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b';

function client(fetchMock: typeof fetch) {
  return new AuthentikAdminClient({
    apiUrl: 'http://localhost:9080/api/v3',
    apiToken: 'token-de-teste-123',
    fetch: fetchMock,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthentikAdminClient', () => {
  it('busca o usuário pelo UUID (sub) e devolve a PK como texto', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ results: [{ pk: 42, uuid: SUB }] })),
    );
    await expect(client(fetchMock).findUserPkBySubject(SUB)).resolves.toBe('42');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(`http://localhost:9080/api/v3/core/users/?uuid=${SUB}`));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-de-teste-123');
  });

  it('resultado de outro UUID, vazio ou sub que não é UUID → null (sem chamada no último caso)', async () => {
    const other = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ results: [{ pk: 7, uuid: 'outro' }] })),
    );
    await expect(client(other).findUserPkBySubject(SUB)).resolves.toBeNull();
    const empty = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ results: [] })));
    await expect(client(empty).findUserPkBySubject(SUB)).resolves.toBeNull();
    const never = vi.fn<typeof fetch>();
    await expect(client(never).findUserPkBySubject('sub-ana')).resolves.toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it('[Falha de integração] erro HTTP ou de rede não impede o login: null + warn', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const forbidden = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{}', { status: 403 })),
    );
    await expect(client(forbidden).findUserPkBySubject(SUB)).resolves.toBeNull();
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    await expect(client(down).findUserPkBySubject(SUB)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'identity.authentik_lookup_failed', status: 403 }),
      'identity.authentik_lookup_failed',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'identity.authentik_lookup_failed',
        errorName: 'TypeError',
      }),
      'identity.authentik_lookup_failed',
    );
  });

  it('sem integração configurada, nunca encontra', async () => {
    await expect(new DisabledAuthentikDirectory().findUserPkBySubject()).resolves.toBeNull();
  });
});

/* US-091 · RN-IAM-46 · DEC-130: conta do convite criada sem senha; compensação melhor esforço. */
describe('AuthentikAdminClient — provisionamento do convite', () => {
  const person = { email: 'bruno@pmsj.gov.br', name: 'Bruno Alves' };

  it('cria a conta sem senha quando o e-mail não existe no Authentik', async () => {
    const fetchMock = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? Response.json({ pk: 77 }, { status: 201 })
          : Response.json({ results: [] }),
      ),
    );
    await expect(client(fetchMock).provisionUser(person)).resolves.toEqual({
      pk: '77',
      created: true,
    });
    const [lookupUrl] = fetchMock.mock.calls[0] ?? [];
    expect(lookupUrl).toEqual(
      new URL('http://localhost:9080/api/v3/core/users/?email=bruno%40pmsj.gov.br'),
    );
    const [createUrl, init] = fetchMock.mock.calls[1] ?? [];
    expect(createUrl).toEqual(new URL('http://localhost:9080/api/v3/core/users/'));
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ username: person.email, email: person.email, name: person.name });
    expect(body).not.toHaveProperty('password');
  });

  it('e-mail já cadastrado no Authentik: reaproveita a conta (created = false)', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ results: [{ pk: 9, email: 'BRUNO@pmsj.gov.br' }] })),
    );
    await expect(client(fetchMock).provisionUser(person)).resolves.toEqual({
      pk: '9',
      created: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[Falha de integração] HTTP 5xx, rede ou resposta sem pk → AuthentikUnavailableError', async () => {
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    await expect(client(down).provisionUser(person)).rejects.toBeInstanceOf(
      AuthentikUnavailableError,
    );
    const error = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? new Response('{}', { status: 500 })
          : Response.json({ results: [] }),
      ),
    );
    await expect(client(error).provisionUser(person)).rejects.toBeInstanceOf(
      AuthentikUnavailableError,
    );
    const noPk = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve(init?.method === 'POST' ? Response.json({}) : Response.json({ results: [] })),
    );
    await expect(client(noPk).provisionUser(person)).rejects.toBeInstanceOf(
      AuthentikUnavailableError,
    );
    await expect(new DisabledAuthentikDirectory().provisionUser()).rejects.toBeInstanceOf(
      AuthentikUnavailableError,
    );
  });

  it('compensação: DELETE da conta; falha só é registrada (nunca lança)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ok = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    await client(ok).removeUser('77');
    const [url, init] = ok.mock.calls[0] ?? [];
    expect(url).toEqual(new URL('http://localhost:9080/api/v3/core/users/77/'));
    expect(init?.method).toBe('DELETE');
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    await expect(client(down).removeUser('77')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'identity.authentik_compensation_failed', alert: true }),
      'identity.authentik_compensation_failed',
    );
    const never = vi.fn<typeof fetch>();
    await client(never).removeUser('../x');
    expect(never).not.toHaveBeenCalled();
    await expect(new DisabledAuthentikDirectory().removeUser()).resolves.toBeUndefined();
  });
});

/* US-090 · USR-13: remoção dos dispositivos de MFA pela API administrativa (RN-IAM-43/44). */
describe('AuthentikAdminClient.resetMfa', () => {
  /** API simulada: dispositivos por tipo; registra as remoções. */
  function authentikWith(devices: Record<string, { pk: number | string }[]>, deleteStatus = 204) {
    const deleted: string[] = [];
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/api/v3/core/users/') {
        return Promise.resolve(Response.json({ results: [{ pk: 42, uuid: SUB }] }));
      }
      const match = /^\/api\/v3\/authenticators\/admin\/([a-z]+)\/(?:([^/]+)\/)?$/.exec(
        url.pathname,
      );
      if (!match) return Promise.resolve(new Response('{}', { status: 404 }));
      const [, type = '', id] = match;
      if (init?.method === 'DELETE') {
        deleted.push(`${type}:${id ?? ''}`);
        return Promise.resolve(new Response(null, { status: deleteStatus }));
      }
      expect(url.searchParams.get('user')).toBe('42');
      return Promise.resolve(Response.json({ results: devices[type] ?? [] }));
    });
    return { fetchMock, deleted };
  }

  it('remove TOTP e WebAuthn (e os de recuperação) da conta pelo PK do provisionamento', async () => {
    const { fetchMock, deleted } = authentikWith({
      totp: [{ pk: 1 }],
      webauthn: [{ pk: 'a1' }, { pk: 2 }],
      static: [{ pk: 3 }],
    });
    await expect(
      client(fetchMock).resetMfa({ authentikUserId: '42', externalSubject: null }),
    ).resolves.toEqual({ removedDevices: 4 });
    expect(deleted).toEqual(['totp:1', 'webauthn:a1', 'webauthn:2', 'static:3']);
  });

  it('sem PK, encontra a conta pelo sub; sem conta nenhuma não chama a API', async () => {
    const { fetchMock, deleted } = authentikWith({ totp: [{ pk: 9 }] });
    await expect(
      client(fetchMock).resetMfa({ authentikUserId: null, externalSubject: SUB }),
    ).resolves.toEqual({ removedDevices: 1 });
    expect(deleted).toEqual(['totp:9']);
    const never = vi.fn<typeof fetch>();
    await expect(
      client(never).resetMfa({ authentikUserId: null, externalSubject: null }),
    ).resolves.toEqual({ removedDevices: 0 });
    expect(never).not.toHaveBeenCalled();
  });

  it('[Duplicidade] 404 na remoção = já removido; conta sem dispositivo conclui sem erro', async () => {
    const gone = authentikWith({ totp: [{ pk: 1 }] }, 404);
    await expect(
      client(gone.fetchMock).resetMfa({ authentikUserId: '42', externalSubject: null }),
    ).resolves.toEqual({ removedDevices: 0 });
    const empty = authentikWith({});
    await expect(
      client(empty.fetchMock).resetMfa({ authentikUserId: '42', externalSubject: null }),
    ).resolves.toEqual({ removedDevices: 0 });
  });

  it('[Falha de integração] erro HTTP ou de rede → AuthentikUnavailableError; sem API → também', async () => {
    const forbidden = authentikWith({ totp: [{ pk: 1 }] }, 500);
    await expect(
      client(forbidden.fetchMock).resetMfa({ authentikUserId: '42', externalSubject: null }),
    ).rejects.toBeInstanceOf(AuthentikUnavailableError);
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    await expect(
      client(down).resetMfa({ authentikUserId: '42', externalSubject: null }),
    ).rejects.toBeInstanceOf(AuthentikUnavailableError);
    await expect(new DisabledAuthentikDirectory().resetMfa()).rejects.toBeInstanceOf(
      AuthentikUnavailableError,
    );
  });
});
