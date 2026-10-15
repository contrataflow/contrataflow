import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthentikAdminClient, DisabledAuthentikDirectory } from './authentik-admin.client.js';

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
