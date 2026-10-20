import { randomUUID } from 'node:crypto';

import { captureLogs } from '@contrataflow/observability/testing';
import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApiLogger } from '#shared/observability/observability.module.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, testConfig } from '../test/support/api-test-app.js';
import type { TestApi } from '../test/support/api-test-app.js';
import { PipelineTestController } from '../test/support/test-controllers.js';
import { installHttpTestTracing } from '../test/support/tracing.js';
import type { HttpTestTracing } from '../test/support/tracing.js';

/*
 * Feature: Contexto de tenant e isolamento de dados (US-100) — barreira 1 no pipeline HTTP, com o
 * diretório em memória (os cenários de banco ficam em test/database e test/tenant-leak).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const ENCERRANDO = FAKE_TENANTS.prefeituraEncerrando.id;
const PING = '/api/v1/_internal/ping';

function problem(response: request.Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Contexto de tenant e isolamento de dados (US-100)', () => {
  const logs = captureLogs();
  let api: TestApi;
  let tracing: HttpTestTracing;
  const bearer = (user: keyof typeof FAKE_USERS) => api.bearer(String(FAKE_USERS[user].subject));

  beforeAll(async () => {
    tracing = installHttpTestTracing();
    const config = testConfig();
    api = await createTestApi({
      config,
      controllers: [PipelineTestController],
      logger: createApiLogger(config, logs.destination),
    });
  });
  afterAll(async () => {
    await api.close();
    await tracing.uninstall();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    logs.clear();
    tracing.reset();
    vi.restoreAllMocks();
  });

  it('[Sucesso] a requisição executa no contexto do tenant ativo, com tenantId nos logs e no span', async () => {
    const response = await request(api.server)
      .get(PING)
      .set('Authorization', bearer('ana'))
      .set('X-Tenant-Id', A.toUpperCase());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: { tenantId: A, userId: FAKE_USERS.ana.id } });

    const opened = logs.lines().find((line) => line.event === 'tenant.context_opened');
    expect(opened).toMatchObject({
      tenantId: A,
      userId: FAKE_USERS.ana.id,
      route: '/api/v1/_internal/ping',
      accessMode: 'FULL',
    });
    const completed = logs.lines().find((line) => line.event === 'http.request.completed');
    expect(completed).toMatchObject({ tenantId: A, userId: FAKE_USERS.ana.id });
    const server = tracing.spans().find((span) => span.kind === SpanKind.SERVER);
    expect(server?.attributes['cf.tenant.id']).toBe(A);
  });

  it.each([
    ['ausente', undefined, 'REQUIRED'],
    ['malformado ("abc")', 'abc', 'INVALID_FORMAT'],
  ] as const)(
    '[Validação] X-Tenant-Id %s → 400 MALFORMED_REQUEST (V-01)',
    async (_name, header, fieldCode) => {
      let call = request(api.server)
        .get('/api/v1/_test/context')
        .set('Authorization', bearer('ana'));
      if (header !== undefined) call = call.set('X-Tenant-Id', header);
      const body = problem(await call, 400, 'MALFORMED_REQUEST');
      expect(body.detail).toBe(
        'Não foi possível identificar a instituição ativa. Entre novamente.',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'X-Tenant-Id', code: fieldCode }),
      ]);
    },
  );

  it('[Permissão] sem vínculo e tenant inexistente respondem igual, exceto o correlationId (V-02)', async () => {
    const withoutMembership = await request(api.server)
      .get(PING)
      .set('Authorization', bearer('ana'))
      .set('X-Tenant-Id', B);
    const nonexistent = await request(api.server)
      .get(PING)
      .set('Authorization', bearer('ana'))
      .set('X-Tenant-Id', randomUUID());
    const first = problem(withoutMembership, 403, 'MEMBERSHIP_INACTIVE');
    const second = problem(nonexistent, 403, 'MEMBERSHIP_INACTIVE');
    expect(first.detail).toBe('Você não tem acesso ativo a esta instituição.');
    expect({ ...first, correlationId: null }).toEqual({ ...second, correlationId: null });
    expect(first.correlationId).not.toBe(second.correlationId);
    expect(Object.keys(withoutMembership.headers).sort()).toEqual(
      Object.keys(nonexistent.headers).sort(),
    );

    // O log de negação não registra o tenant pedido por quem não tem vínculo nele.
    const denied = logs.lines().filter((line) => line.event === 'tenant.access_denied');
    expect(denied).toHaveLength(2);
    for (const line of denied) {
      expect(line).toMatchObject({ reason: 'MEMBERSHIP_INACTIVE', userId: FAKE_USERS.ana.id });
      expect(line).not.toHaveProperty('requestedTenantId');
      expect(JSON.stringify(line)).not.toContain(B);
    }
  });

  it('[Permissão] com vínculo, tenant suspenso → 403 TENANT_SUSPENDED (V-03)', async () => {
    const body = problem(
      await request(api.server)
        .get(PING)
        .set('Authorization', bearer('davi'))
        .set('X-Tenant-Id', FAKE_TENANTS.prefeituraSuspensa.id),
      403,
      'TENANT_SUSPENDED',
    );
    expect(body.detail).toBe('O acesso a esta instituição está indisponível no momento.');
    expect(logs.lines().find((line) => line.event === 'tenant.access_denied')).toMatchObject({
      reason: 'TENANT_SUSPENDED',
      requestedTenantId: FAKE_TENANTS.prefeituraSuspensa.id,
    });
  });

  it('[Permissão] OFFBOARDING: AUDITOR lê e exporta (READ_EXPORT); demais comandos → TENANT_SUSPENDED', async () => {
    const auditor = () => bearer('paulo');
    const read = await request(api.server)
      .get('/api/v1/_test/context')
      .set('Authorization', auditor())
      .set('X-Tenant-Id', ENCERRANDO);
    expect(read.status).toBe(200);

    const exported = await request(api.server)
      .post('/api/v1/_test/offboarding-export')
      .set('Authorization', auditor())
      .set('X-Tenant-Id', ENCERRANDO);
    expect(exported.status).toBe(202);
    expect(exported.body).toEqual({ data: { accessMode: 'READ_EXPORT' } });

    problem(
      await request(api.server)
        .patch('/api/v1/_test/versioned')
        .set('Authorization', auditor())
        .set('X-Tenant-Id', ENCERRANDO)
        .set('If-Match', '"1"'),
      403,
      'TENANT_SUSPENDED',
    );

    // Em tenant ACTIVE, a mesma rota de exportação roda em modo FULL.
    const active = await request(api.server)
      .post('/api/v1/_test/offboarding-export')
      .set('Authorization', bearer('ana'))
      .set('X-Tenant-Id', A);
    expect(active.body).toEqual({ data: { accessMode: 'FULL' } });
  });

  it('[Duplicidade] a chave de idempotência não atravessa tenants (Fábio em A e em B com "K9")', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const key = randomUUID();
    const send = (tenantId: string) =>
      request(api.server)
        .post('/api/v1/_internal/echo')
        .set('Authorization', bearer('fabio'))
        .set('X-Tenant-Id', tenantId)
        .set('Idempotency-Key', key)
        .send({ name: 'Comentário' });
    const inA = await send(A);
    const replayInA = await send(A);
    const inB = await send(B);
    expect(inA.status).toBe(201);
    expect(replayInA.headers['idempotent-replayed']).toBe('true');
    expect(inB.status).toBe(201);
    expect(inB.headers['idempotent-replayed']).toBeUndefined();
    expect((inB.body as { data: { id: string } }).data.id).not.toBe(
      (inA.body as { data: { id: string } }).data.id,
    );
  });

  it('rotas sem tenant ativo (CROSS_TENANT_LOOKUP, PLATFORM) ignoram o X-Tenant-Id', async () => {
    const memberships = await request(api.server)
      .get('/api/v1/me/memberships')
      .set('Authorization', bearer('fabio'))
      .set('X-Tenant-Id', 'abc');
    expect(memberships.status).toBe(200);
    const platform = await request(api.server)
      .get('/api/v1/_test/without-tenant')
      .set('Authorization', api.bearer('sub-operadora', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', B);
    expect(platform.body).toEqual({ data: { tenantId: null, userId: FAKE_USERS.operadora.id } });
  });
});
