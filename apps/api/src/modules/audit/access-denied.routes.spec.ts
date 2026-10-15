// Negações de autorização auditadas no pipeline HTTP (US-073 · RN-AUD-10 · RN-AUD-05): pipeline
// real com identidade fake e trilha em memória (os mesmos cenários contra o PostgreSQL estão em
// test/audit/audit-trail.spec.ts).
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { AUDIT_LOG_STORE } from './application/ports.js';
import type { InMemoryAuditLogStore } from './infrastructure/in-memory-audit.store.js';
import { createTestApi, testConfig } from '../../../test/support/api-test-app.js';
import type { TestApi } from '../../../test/support/api-test-app.js';
import { AuditProbeController } from '../../../test/support/audit-probe.controller.js';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const SESSION = 'c'.repeat(64);

describe('access.denied no pipeline (RN-AUD-10)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi({
      // O BFF (aqui, o próprio teste em 127.0.0.1) é proxy confiável: IP e sessão do navegador.
      config: testConfig({ TRUSTED_PROXY_CIDRS: '127.0.0.1,::1' }),
      controllers: [AuditProbeController],
    });
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const denials = () => api.auditRecords().filter((record) => record.action === 'access.denied');
  const lastDenial = () => denials().at(-1);

  const asBrowser = (test: request.Test, subject: string, tenantId: string | null = A) => {
    const withAuth = test
      .set('Authorization', api.bearer(subject))
      .set('X-Forwarded-For', '203.0.113.9')
      .set('User-Agent', 'Navegador/1.0')
      .set('X-CF-Session-Id-Hash', SESSION);
    return tenantId ? withAuth.set('X-Tenant-Id', tenantId) : withAuth;
  };

  it('[Permissão] PERMISSION_DENIED grava access.denied com a permissão ausente em reasonCode', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const response = await asBrowser(
      request(api.server).post('/api/v1/_test/audit/forbidden'),
      FAKE_USERS.ana.subject,
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(JSON.stringify(response.body)).not.toContain('PROCESS_CREATE');
    expect(lastDenial()).toMatchObject({
      tenantId: A,
      actorType: 'USER',
      actorUserId: FAKE_USERS.ana.id,
      actorName: 'Ana Souza',
      actorMembershipId: '0192a000-0000-7000-8000-0000000001a1',
      category: 'ACCESS',
      result: 'DENIED',
      reasonCode: 'PROCESS_CREATE',
      ip: '203.0.113.9',
      userAgent: 'Navegador/1.0',
      sessionIdHash: SESSION,
      metadata: {
        code: 'PERMISSION_DENIED',
        method: 'POST',
        route: '/api/v1/_test/audit/forbidden',
      },
    });
    expect(lastDenial()?.correlationId).toBe(response.headers['x-correlation-id']);
  });

  it('vínculo suspenso → MEMBERSHIP_INACTIVE gravado no tenant já validado', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const response = await asBrowser(
      request(api.server).get('/api/v1/_internal/ping'),
      FAKE_USERS.bruno.subject,
    );
    expect(response.status).toBe(403);
    expect(lastDenial()).toMatchObject({
      tenantId: A,
      actorUserId: FAKE_USERS.bruno.id,
      reasonCode: 'MEMBERSHIP_INACTIVE',
      metadata: { code: 'MEMBERSHIP_INACTIVE', method: 'GET' },
    });
  });

  it('[Tenant incorreto] sem vínculo no tenant pedido → registro de plataforma, nunca na trilha do tenant', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const response = await asBrowser(
      request(api.server).get('/api/v1/_internal/ping'),
      FAKE_USERS.ana.subject,
      B,
    );
    expect(response.status).toBe(403);
    expect(lastDenial()).toMatchObject({
      tenantId: null,
      actorUserId: FAKE_USERS.ana.id,
      reasonCode: 'MEMBERSHIP_INACTIVE',
      metadata: { requestedTenantId: B },
    });
    expect(denials().filter((record) => record.tenantId === B)).toEqual([]);
  });

  it('instituição suspensa → TENANT_SUSPENDED; cabeçalho de tenant inválido não vai para o metadata', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await asBrowser(
      request(api.server).get('/api/v1/_internal/ping'),
      FAKE_USERS.davi.subject,
      FAKE_TENANTS.prefeituraSuspensa.id,
    ).expect(403);
    expect(lastDenial()).toMatchObject({ tenantId: null, reasonCode: 'TENANT_SUSPENDED' });

    await asBrowser(
      request(api.server).get('/api/v1/_internal/ping'),
      FAKE_USERS.ana.subject,
      'nao-e-uuid',
    ).expect(403);
    expect(lastDenial()?.metadata).not.toHaveProperty('requestedTenantId');
  });

  it('401 não é negação de autorização: não grava access.denied', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const before = denials().length;
    await request(api.server).get('/api/v1/_internal/ping').set('X-Tenant-Id', A).expect(401);
    expect(denials()).toHaveLength(before);
  });

  it('falha ao gravar a negação fica no log e não muda a resposta 403', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const store = api.app.get<InMemoryAuditLogStore>(AUDIT_LOG_STORE);
    vi.spyOn(store, 'insert').mockRejectedValueOnce(new Error('falha induzida'));
    const response = await asBrowser(
      request(api.server).post('/api/v1/_test/audit/forbidden'),
      FAKE_USERS.ana.subject,
    );
    expect(response.status).toBe(403);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.write_failed', action: 'access.denied' }),
      'audit.write_failed',
    );
  });
});

describe('endereço do cliente sem proxy confiável (RN-AUD-05 · security.md §8)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi({ controllers: [AuditProbeController] });
  });

  afterAll(async () => {
    await api.close();
  });

  it('X-Forwarded-For e X-CF-Session-Id-Hash de origem não confiável são ignorados', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await request(api.server)
      .post('/api/v1/_test/audit/forbidden')
      .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
      .set('X-Tenant-Id', A)
      .set('X-Forwarded-For', '203.0.113.9')
      .set('X-CF-Session-Id-Hash', SESSION)
      .expect(403);
    const [record] = api.auditRecords();
    expect(record?.ip).toBe('127.0.0.1');
    expect(record?.sessionIdHash).toBeNull();
    vi.restoreAllMocks();
  });
});
