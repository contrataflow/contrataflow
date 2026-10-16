import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, sessionEventResponseSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TOKEN_VERIFIER, TokenVerifierUnavailableError } from '#shared/auth/ports.js';
import type { TokenVerifierPort } from '#shared/auth/ports.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, TEST_SERVICE_TOKEN } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { AUTHENTIK_DIRECTORY } from '../application/ports.js';
import { InMemoryAuthentikDirectory } from '../infrastructure/in-memory-identity.repositories.js';

/* US-087 — rotas ME-01, ME-04 e o contrato interno de sessão, pelo pipeline completo da API. */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const ENCERRANDO = FAKE_TENANTS.prefeituraEncerrando.id;
const RAFAEL_SUB = '0192f000-0000-7000-8000-00000000aa01';
const SESSION_HASH = 'b'.repeat(64);

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Login OIDC — API (US-087)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        {
          token: AUTHENTIK_DIRECTORY,
          value: new InMemoryAuthentikDirectory({
            [RAFAEL_SUB]: FAKE_USERS.rafael.authentikUserId,
          }),
        },
      ],
    });
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const sessionEvent = (subject: string, body: Record<string, unknown>) =>
    request(api.server)
      .post('/internal/session-events')
      .set('Authorization', api.bearer(subject))
      .set('X-CF-Service-Token', TEST_SERVICE_TOKEN)
      .send({ sessionIdHash: SESSION_HASH, ip: '203.0.113.7', userAgent: 'Vitest', ...body });

  describe('ME-01 e ME-04', () => {
    it('[Sucesso] A API valida token e contexto: GET /me responde 200 com ETag da versão', async () => {
      const response = await request(api.server)
        .get('/api/v1/me')
        .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A);
      expect(response.status).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      expect(response.body).toEqual({
        data: {
          id: FAKE_USERS.ana.id,
          name: 'Ana Souza',
          socialName: null,
          email: FAKE_USERS.ana.email,
          phone: null,
          preferences: { density: 'comfortable', theme: 'system' },
          membership: { jobTitle: null, departments: [] },
          version: 1,
        },
      });
    });

    it('[Validação] GET /me sem token → 401; sem instituição ativa → 400 MALFORMED_REQUEST', async () => {
      expectProblem(await request(api.server).get('/api/v1/me'), 401, 'UNAUTHENTICATED');
      // US-100 · RN-TEN-19: rota TENANT sem X-Tenant-Id é requisição malformada.
      expectProblem(
        await request(api.server)
          .get('/api/v1/me')
          .set('Authorization', api.bearer(FAKE_USERS.ana.subject)),
        400,
        'MALFORMED_REQUEST',
      );
    });

    it('[Sucesso] GET /me/memberships responde sem X-Tenant-Id, com usable por vínculo', async () => {
      const response = await request(api.server)
        .get('/api/v1/me/memberships')
        .set('Authorization', api.bearer(FAKE_USERS.fabio.subject));
      expect(response.status).toBe(200);
      expect(
        (response.body as { data: { tenant: { id: string }; usable: boolean }[] }).data.map(
          (item) => [item.tenant.id, item.usable],
        ),
      ).toEqual([
        [A, true],
        [B, true],
      ]);
    });

    it('[Tenant incorreto] X-Tenant-Id de instituição sem vínculo → 403 MEMBERSHIP_INACTIVE (sem dados)', async () => {
      const body = expectProblem(
        await request(api.server)
          .get('/api/v1/me')
          .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
          .set('X-Tenant-Id', B),
        403,
        'MEMBERSHIP_INACTIVE',
      );
      expect(JSON.stringify(body)).not.toContain('Prefeitura B');
    });

    it('[Permissão] vínculo suspenso: qualquer rota de negócio → 403 MEMBERSHIP_INACTIVE', async () => {
      expectProblem(
        await request(api.server)
          .get('/api/v1/_internal/ping')
          .set('Authorization', api.bearer(FAKE_USERS.bruno.subject))
          .set('X-Tenant-Id', A),
        403,
        'MEMBERSHIP_INACTIVE',
      );
    });

    it('[Tenant incorreto] Instituição em encerramento: AUDITOR lê; comando → 403 TENANT_SUSPENDED', async () => {
      const paulo = api.bearer(FAKE_USERS.paulo.subject);
      const read = await request(api.server)
        .get('/api/v1/_internal/ping')
        .set('Authorization', paulo)
        .set('X-Tenant-Id', ENCERRANDO);
      expect(read.status).toBe(200);
      expectProblem(
        await request(api.server)
          .post('/api/v1/_internal/echo')
          .set('Authorization', paulo)
          .set('X-Tenant-Id', ENCERRANDO)
          .set('Idempotency-Key', randomUUID())
          .send({ name: 'comando' }),
        403,
        'TENANT_SUSPENDED',
      );
      // Quem não tem vínculo lá não descobre nada sobre a instituição.
      expectProblem(
        await request(api.server)
          .get('/api/v1/_internal/ping')
          .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
          .set('X-Tenant-Id', ENCERRANDO),
        403,
        'MEMBERSHIP_INACTIVE',
      );
    });
  });

  describe('POST /internal/session-events (contrato BFF → API)', () => {
    it('[Sucesso] SESSION_STARTED sem instituição resolve a identidade e lista os vínculos', async () => {
      const response = await sessionEvent(FAKE_USERS.fabio.subject, { type: 'SESSION_STARTED' });
      expect(response.status).toBe(200);
      const data = sessionEventResponseSchema.parse((response.body as { data: unknown }).data);
      expect(data).toMatchObject({
        user: { id: FAKE_USERS.fabio.id, displayName: 'Fabi Nunes' },
        firstLogin: false,
        activeMembership: null,
        mfaRequired: false,
      });
      expect(data.memberships.map((membership) => membership.tenant.timezone)).toEqual([
        'America/Sao_Paulo',
        'America/Manaus',
      ]);
    });

    it('[Sucesso] Primeiro login vincula o sub ao convidado e marca firstLogin', async () => {
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const first = await sessionEvent(RAFAEL_SUB, { type: 'SESSION_STARTED' });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        data: { firstLogin: true, user: { id: FAKE_USERS.rafael.id } },
      });
      const again = await sessionEvent(RAFAEL_SUB, { type: 'SESSION_STARTED' });
      expect(again.body).toMatchObject({ data: { firstLogin: false } });
    });

    it('[Sucesso] com tenantId ativa a instituição e grava auth.session_start', async () => {
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const response = await sessionEvent(FAKE_USERS.ana.subject, {
        type: 'SESSION_STARTED',
        tenantId: A,
        selection: 'AUTO',
        firstLogin: false,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        data: {
          activeMembership: {
            membershipId: '0192a000-0000-7000-8000-0000000001a1',
            tenantId: A,
            readOnly: false,
          },
        },
      });
      // Trilha real (US-073), com o IP, o user-agent e a sessão do navegador informados pelo BFF.
      const record = api.auditRecords().find((entry) => entry.action === 'auth.session_start');
      expect(record).toMatchObject({
        tenantId: A,
        category: 'SECURITY',
        result: 'SUCCESS',
        actorType: 'USER',
        actorUserId: FAKE_USERS.ana.id,
        actorMembershipId: '0192a000-0000-7000-8000-0000000001a1',
        actorName: 'Ana Souza',
        sessionIdHash: SESSION_HASH,
        ip: '203.0.113.7',
        userAgent: 'Vitest',
        metadata: { selection: 'AUTO', firstLogin: false, amr: [] },
      });
      expect(record?.rowHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('[Permissão] usuário bloqueado → 403 PERMISSION_DENIED com reason USER_BLOCKED', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const body = expectProblem(
        await sessionEvent(FAKE_USERS.eva.subject, { type: 'SESSION_STARTED' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(body).toMatchObject({
        reason: 'USER_BLOCKED',
        detail: 'Seu acesso ao ContrataFlow está bloqueado. Procure o suporte da sua instituição.',
      });
    });

    it('[Validação] sub sem usuário → 403 MEMBERSHIP_INACTIVE ("sem vínculo")', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expectProblem(
        await sessionEvent('sub-sem-cadastro', { type: 'SESSION_STARTED' }),
        403,
        'MEMBERSHIP_INACTIVE',
      );
    });

    it('[Tenant incorreto] ativar instituição sem vínculo → 403 MEMBERSHIP_INACTIVE', async () => {
      expectProblem(
        await sessionEvent(FAKE_USERS.ana.subject, { type: 'SESSION_STARTED', tenantId: B }),
        403,
        'MEMBERSHIP_INACTIVE',
      );
    });

    it('[Validação] TENANT_SWITCHED sem tenantId e corpo fora do contrato → 422', async () => {
      expectProblem(
        await sessionEvent(FAKE_USERS.ana.subject, { type: 'TENANT_SWITCHED' }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await sessionEvent(FAKE_USERS.ana.subject, {
          type: 'SESSION_STARTED',
          sessionIdHash: 'curto',
        }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('[Permissão] sem a credencial de serviço do BFF → 403, mesmo com token válido', async () => {
      const response = await request(api.server)
        .post('/internal/session-events')
        .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
        .set('X-CF-Service-Token', 'credencial-errada-com-tamanho-suficiente')
        .send({ type: 'SESSION_STARTED', sessionIdHash: SESSION_HASH, ip: null, userAgent: null });
      expectProblem(response, 403, 'PERMISSION_DENIED');
    });

    it('[Validação] sem token do usuário → 401; rota inexistente em /api/v1', async () => {
      const anonymous = await request(api.server)
        .post('/internal/session-events')
        .set('X-CF-Service-Token', TEST_SERVICE_TOKEN)
        .send({ type: 'SESSION_STARTED', sessionIdHash: SESSION_HASH, ip: null, userAgent: null });
      expectProblem(anonymous, 401, 'UNAUTHENTICATED');
      const prefixed = await request(api.server)
        .post('/api/v1/internal/session-events')
        .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
        .set('X-CF-Service-Token', TEST_SERVICE_TOKEN)
        .send({ type: 'SESSION_STARTED', sessionIdHash: SESSION_HASH, ip: null, userAgent: null });
      expect(prefixed.status).not.toBe(200);
    });
  });
});

describe('[Falha de integração] JWKS fora do ar com kid desconhecido (RN-IAM-05)', () => {
  it('a API responde 503 DEPENDENCY_UNAVAILABLE com Retry-After, nunca 401', async () => {
    const unavailable: TokenVerifierPort = {
      verify: () => Promise.reject(new TokenVerifierUnavailableError()),
    };
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const api = await createTestApi({ providers: [{ token: TOKEN_VERIFIER, value: unavailable }] });
    try {
      const response = await request(api.server)
        .get('/api/v1/me')
        .set('Authorization', 'Bearer a.b.c')
        .set('X-Tenant-Id', A);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBe('30');
    } finally {
      await api.close();
      vi.restoreAllMocks();
    }
  });
});
