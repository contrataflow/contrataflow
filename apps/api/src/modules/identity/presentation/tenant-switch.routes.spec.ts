import { problemDetailsSchema, sessionEventResponseSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, TEST_SERVICE_TOKEN } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { IDENTITY_REPOSITORY, TENANT_MFA_POLICY } from '../application/ports.js';
import type { InMemoryIdentityRepository } from '../infrastructure/in-memory-identity.repositories.js';
import { InMemoryTenantMfaPolicy } from '../infrastructure/tenant-mfa-policy.js';

/*
 * US-093 — `POST /internal/session-events` com `TENANT_SWITCHED` (contrato BFF → API), pelo
 * pipeline completo: revalidação do vínculo, auditoria `auth.tenant_switch` real (US-073), MFA da
 * instituição de destino e instituição padrão. "Helena" = Fábio (vínculos em A e B).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const HELENA_A = '0192a000-0000-7000-8000-0000000001f1';
const HELENA_B = '0192a000-0000-7000-8000-0000000002f1';
const SESSION_HASH = 'c'.repeat(64);
const HELENA = FAKE_USERS.fabio;

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Selecionar órgão ativo — contrato interno (US-093)', () => {
  let api: TestApi;
  const mfa = new InMemoryTenantMfaPolicy();

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: TENANT_MFA_POLICY, value: mfa }] });
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    mfa.set(B, 'ADMINS');
    vi.restoreAllMocks();
  });

  const switchTo = (body: Record<string, unknown>, amr: readonly string[] = ['pwd']) =>
    request(api.server)
      .post('/internal/session-events')
      .set('Authorization', api.bearer(HELENA.subject, { amr }))
      .set('X-CF-Service-Token', TEST_SERVICE_TOKEN)
      .send({
        type: 'TENANT_SWITCHED',
        sessionIdHash: SESSION_HASH,
        selection: 'MANUAL',
        fromTenantId: A,
        ip: '198.51.100.20',
        userAgent: 'Vitest/Helena',
        ...body,
      });

  const switchRecords = () =>
    api.auditRecords().filter((record) => record.action === 'auth.tenant_switch');

  it('[Sucesso] troca para a Prefeitura B e grava auth.tenant_switch com toTenantId', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const before = switchRecords().length;
    const response = await switchTo({ membershipId: HELENA_B });
    expect(response.status).toBe(200);
    const data = sessionEventResponseSchema.parse((response.body as { data: unknown }).data);
    expect(data).toMatchObject({
      user: { id: HELENA.id },
      activeMembership: { membershipId: HELENA_B, tenantId: B, readOnly: false },
      defaultTenantId: null,
      mfaRequired: false,
    });
    const records = switchRecords();
    expect(records).toHaveLength(before + 1);
    expect(records.at(-1)).toMatchObject({
      tenantId: B,
      category: 'ACCESS',
      result: 'SUCCESS',
      actorUserId: HELENA.id,
      actorMembershipId: HELENA_B,
      sessionIdHash: SESSION_HASH,
      ip: '198.51.100.20',
      userAgent: 'Vitest/Helena',
      metadata: { fromTenantId: A, toTenantId: B, selection: 'MANUAL' },
    });
  });

  it('[Validação] vínculo que não pertence a Helena → 422 VALIDATION_ERROR (REFERENCE_NOT_FOUND)', async () => {
    const body = expectProblem(
      await switchTo({ membershipId: '0192a000-0000-7000-8000-0000000001a1' }),
      422,
      'VALIDATION_ERROR',
    );
    expect(body.errors).toEqual([
      {
        field: 'membershipId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione uma instituição válida.',
      },
    ]);
    const missing = expectProblem(await switchTo({}), 422, 'VALIDATION_ERROR');
    expect(missing.errors[0]).toMatchObject({ field: 'membershipId', code: 'REQUIRED' });
  });

  it('[Permissão] vínculo suspenso → 403 MEMBERSHIP_INACTIVE, com access.denied na trilha', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const response = await request(api.server)
      .post('/internal/session-events')
      .set('Authorization', api.bearer(FAKE_USERS.bruno.subject))
      .set('X-CF-Service-Token', TEST_SERVICE_TOKEN)
      .send({
        type: 'TENANT_SWITCHED',
        sessionIdHash: SESSION_HASH,
        membershipId: '0192a000-0000-7000-8000-0000000001b1',
        ip: null,
        userAgent: null,
      });
    expectProblem(response, 403, 'MEMBERSHIP_INACTIVE');
    expect(api.auditRecords().some((record) => record.action === 'access.denied')).toBe(true);
  });

  it('[Tenant incorreto] instituição suspensa pela plataforma → 403 TENANT_SUSPENDED', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const response = await request(api.server)
      .post('/internal/session-events')
      .set('Authorization', api.bearer(FAKE_USERS.davi.subject))
      .set('X-CF-Service-Token', TEST_SERVICE_TOKEN)
      .send({
        type: 'TENANT_SWITCHED',
        sessionIdHash: SESSION_HASH,
        membershipId: '0192a000-0000-7000-8000-0000000001d1',
        ip: null,
        userAgent: null,
      });
    expectProblem(response, 403, 'TENANT_SUSPENDED');
  });

  it('[Duplicidade] trocar para a instituição já ativa: 200 sem novo auth.tenant_switch', async () => {
    const before = switchRecords().length;
    const response = await switchTo({ membershipId: HELENA_A });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: { activeMembership: { membershipId: HELENA_A, tenantId: A }, mfaRequired: false },
    });
    expect(switchRecords()).toHaveLength(before);
  });

  it('FA-04 "Usar como padrão": o próximo início de sessão devolve a instituição padrão', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const switched = await switchTo({ membershipId: HELENA_B, setAsDefault: true });
    expect(switched.body).toMatchObject({ data: { defaultTenantId: B } });
    const login = await request(api.server)
      .post('/internal/session-events')
      .set('Authorization', api.bearer(HELENA.subject))
      .set('X-CF-Service-Token', TEST_SERVICE_TOKEN)
      .send({ type: 'SESSION_STARTED', sessionIdHash: SESSION_HASH, ip: null, userAgent: null });
    expect(login.body).toMatchObject({ data: { activeMembership: null, defaultTenantId: B } });
  });

  it('[Falha de integração] mfaPolicy ALL no destino e sessão sem MFA: mfaRequired, nada gravado', async () => {
    mfa.set(B, 'ALL');
    const before = switchRecords().length;
    const suspended = await switchTo({ membershipId: HELENA_B });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({
      data: { activeMembership: null, mfaRequired: true },
    });
    expect(switchRecords()).toHaveLength(before);
    // Concluído o step-up (amr com segundo fator), a troca se completa.
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const completed = await switchTo({ membershipId: HELENA_B }, ['pwd', 'otp']);
    expect(completed.body).toMatchObject({
      data: { activeMembership: { tenantId: B }, mfaRequired: false },
    });
    expect(switchRecords()).toHaveLength(before + 1);
  });

  it('[Falha de banco] banco indisponível ao revalidar o vínculo → 503 DEPENDENCY_UNAVAILABLE', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const repository = api.app.get<InMemoryIdentityRepository>(IDENTITY_REPOSITORY);
    vi.spyOn(repository, 'listMemberships').mockRejectedValue(
      new DatabaseUnavailableError(new Error('connection refused')),
    );
    expectProblem(await switchTo({ membershipId: HELENA_B }), 503, 'DEPENDENCY_UNAVAILABLE');
  });
});
