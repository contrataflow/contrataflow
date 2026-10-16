// Publicar, versionar e aposentar workflow sobre PostgreSQL real (US-045 · Tenant incorreto,
// Concorrência, Falha de integração, RN-WF-64..67): versão de outro tenant → 404 sem tocar nas
// linhas, duas publicações simultâneas com o mesmo If-Match (um 200, outro 412) e duas criações de
// rascunho (um 201, outro 409), `WorkflowVersionPublished` PENDING no outbox sem relay, snapshot e
// `current_published_version_id` gravados juntos, gatilho de imutabilidade pós-publicação e a
// aposentadoria (WORKFLOW_IN_USE; fora de uso, a última sai e o workflow fica sem publicada).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c045-0000-7000-8000-00000000000a';
const B = '0192c045-0000-7000-8000-00000000000b';
const CARLA = '0192c045-0000-7000-8000-0000000000a1';
const DIEGO = '0192c045-0000-7000-8000-0000000000a2';
const BETO = '0192c045-0000-7000-8000-0000000000b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CARLA]: ['ADMIN_ORGAO'],
  // Segundo administrador, para a publicação simultânea.
  [DIEGO]: ['ADMIN_ORGAO'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-wf-publish', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-wf-publish', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla', 'carla@a.test', true, 'Carla Mendes'),
  ('${DIEGO}', 'sub-diego', 'diego@a.test', true, 'Diego Lima'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c045-0000-7000-8000-0000000001a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c045-0000-7000-8000-0000000001a2', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c045-0000-7000-8000-0000000001b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real. */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: publicação de workflow isolada por tenant sobre PostgreSQL (US-045)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const tenantOf = (subject: string) => (subject === 'sub-beto' ? B : A);
  const as = (test: request.Test, subject: string) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const get = (subject: string, path: string) =>
    as(request(api.server).get(`/api/v1${path}`), subject);
  const post = (subject: string, path: string, body: object) =>
    as(request(api.server).post(`/api/v1${path}`), subject)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const postIfMatch = (subject: string, path: string, body: object, version: number) =>
    as(request(api.server).post(`/api/v1${path}`), subject)
      .set('If-Match', `"${version}"`)
      .send(body);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;
  const etagOf = async (subject: string, versionId: string) =>
    Number(
      String((await get(subject, `/workflow-versions/${versionId}`)).headers.etag).replaceAll(
        '"',
        '',
      ),
    );

  const createWorkflow = async (subject: string, key: string, name: string) => {
    const response = await post(subject, '/workflows', { key, name });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowDto>(response);
  };
  const addStage = async (subject: string, versionId: string, body: object) => {
    const response = await post(subject, `/workflow-versions/${versionId}/stages`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowStageDto>(response);
  };
  const buildValidDraft = async (subject: string, versionId: string) => {
    const abertura = await addStage(subject, versionId, {
      key: 'ABERTURA',
      name: 'Abertura',
      type: 'START',
    });
    const analise = await addStage(subject, versionId, {
      key: 'ANALISE',
      name: 'Análise',
      type: 'TASK',
    });
    const fim = await addStage(subject, versionId, { key: 'FIM', name: 'Fim', type: 'END' });
    for (const [key, from, to, action] of [
      ['ENVIAR_ANALISE', abertura.id, analise.id, 'FORWARD'],
      ['CONCLUIR', analise.id, fim.id, 'COMPLETE'],
    ] as const) {
      const response = await post(subject, `/workflow-versions/${versionId}/transitions`, {
        key,
        name: `Transição ${key}`,
        fromStageId: from,
        toStageId: to,
        action,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
  };

  let fase: WorkflowDto;
  let v1: string;
  let v2: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        {
          token: TOKEN_VERIFIER,
          value: new FakeJwksProvider({
            signingKey: TEST_SIGNING_KEY,
            issuer: TEST_ISSUER,
            audiences: config.oidc.audiences,
            clockToleranceSeconds: 30,
          }),
        },
      ],
    });
    membership.inner = api.app.get(PrismaIdentityRepository);

    fase = await createWorkflow('sub-carla', 'FASE_PREPARATORIA', 'Fase preparatória');
    v1 = fase.draftVersion?.id ?? '';
    await buildValidDraft('sub-carla', v1);
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Concorrência] duas publicações simultâneas da mesma versão: uma 200, outra 412; uma só publicação', async () => {
    const etag = await etagOf('sub-carla', v1);
    const results = await Promise.all([
      postIfMatch('sub-carla', `/workflow-versions/${v1}/publish`, {}, etag),
      postIfMatch('sub-diego', `/workflow-versions/${v1}/publish`, {}, etag),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const loser = results.find((result) => result.status === 412);
    expect(problemCode(loser as request.Response)).toBe('VERSION_CONFLICT');
    expect(
      await db.admin<Row>(
        `SELECT id FROM audit_logs WHERE tenant_id = $1 AND action = 'workflow.version_publish' AND entity_id = $2`,
        [A, v1],
      ),
    ).toHaveLength(1);
  });

  it('[Falha de integração] publicar grava snapshot, hash e a corrente juntos; o evento fica PENDING sem relay', async () => {
    const [version] = await db.admin<Row>(
      'SELECT status, definition_snapshot, definition_hash FROM workflow_versions WHERE id = $1',
      [v1],
    );
    expect(version?.status).toBe('PUBLISHED');
    expect(version?.definition_hash).toBe(sha256Hex(canonicalJson(version?.definition_snapshot)));
    const [workflow] = await db.admin<Row>(
      'SELECT current_published_version_id FROM workflows WHERE id = $1',
      [fase.id],
    );
    expect(workflow?.current_published_version_id).toBe(v1);
    expect(
      await db.admin<Row>(
        `SELECT routing_key, status, payload FROM outbox_events
          WHERE tenant_id = $1 AND event_type = 'WorkflowVersionPublished'`,
        [A],
      ),
    ).toEqual([
      expect.objectContaining({
        routing_key: 'workflow.version_published',
        status: 'PENDING',
        payload: expect.objectContaining({ workflowVersionId: v1, versionNumber: 1 }) as unknown,
      }),
    ]);
    // RN-WF-65: o gatilho barra qualquer escrita na definição publicada, mesmo por SQL direto.
    await expect(
      db.admin(`UPDATE workflow_stages SET name = 'Alterada' WHERE workflow_version_id = $1`, [v1]),
    ).rejects.toThrow(/cf_wf_version_not_draft/);
  });

  it('[Duplicidade] duas criações de rascunho simultâneas: uma 201, outra 409 WORKFLOW_DRAFT_EXISTS', async () => {
    const results = await Promise.all([
      post('sub-carla', `/workflows/${fase.id}/versions`, {}),
      post('sub-diego', `/workflows/${fase.id}/versions`, {}),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const loser = results.find((result) => result.status === 409);
    expect(problemCode(loser as request.Response)).toBe('WORKFLOW_DRAFT_EXISTS');
    v2 = data<WorkflowVersionDetailDto>(
      results.find((result) => result.status === 201) as request.Response,
    ).id;
  });

  it('[Tenant incorreto] validar, publicar e aposentar versão de outro tenant → 404 sem alterar nada', async () => {
    const other = await createWorkflow('sub-beto', 'FLUXO_B', 'Fluxo LEAK-B');
    const otherDraft = other.draftVersion?.id ?? '';
    await buildValidDraft('sub-beto', otherDraft);

    for (const response of [
      await post('sub-carla', `/workflow-versions/${otherDraft}/validate`, {}),
      await postIfMatch('sub-carla', `/workflow-versions/${otherDraft}/publish`, {}, 6),
      await postIfMatch('sub-carla', `/workflow-versions/${otherDraft}/retire`, {}, 6),
      await get('sub-carla', `/workflows/${other.id}/versions`),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemCode(response)).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }
    const [row] = await db.admin<Row>(
      'SELECT status, definition_hash FROM workflow_versions WHERE id = $1',
      [otherDraft],
    );
    expect(row).toMatchObject({ status: 'DRAFT', definition_hash: null });
  });

  it('[Aposentar] v2 publicada supersede a v1; a corrente única de workflow ativo → 409 WORKFLOW_IN_USE', async () => {
    const published = await postIfMatch(
      'sub-carla',
      `/workflow-versions/${v2}/publish`,
      { changeNotes: 'Revisão do fluxo.' },
      await etagOf('sub-carla', v2),
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(data<WorkflowVersionSummaryDto>(published)).toMatchObject({
      status: 'PUBLISHED',
      changeNotes: 'Revisão do fluxo.',
    });
    const [old] = await db.admin<Row>('SELECT status FROM workflow_versions WHERE id = $1', [v1]);
    expect(old?.status).toBe('RETIRED');

    const blocked = await postIfMatch(
      'sub-carla',
      `/workflow-versions/${v2}/retire`,
      {},
      await etagOf('sub-carla', v2),
    );
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(problemCode(blocked)).toBe('WORKFLOW_IN_USE');
  });

  it('[Aposentar] workflow inativo (FA-04): a última publicada sai e o workflow fica sem publicada', async () => {
    await db.admin('UPDATE workflows SET is_active = false WHERE id = $1', [fase.id]);
    const response = await postIfMatch(
      'sub-carla',
      `/workflow-versions/${v2}/retire`,
      {},
      await etagOf('sub-carla', v2),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [version] = await db.admin<Row>(
      'SELECT status, retired_at, retired_by_id FROM workflow_versions WHERE id = $1',
      [v2],
    );
    expect(version).toMatchObject({ status: 'RETIRED', retired_by_id: CARLA });
    expect(version?.retired_at).not.toBeNull();
    const [workflow] = await db.admin<Row>(
      'SELECT current_published_version_id FROM workflows WHERE id = $1',
      [fase.id],
    );
    expect(workflow?.current_published_version_id).toBeNull();
    expect(
      await db.admin<Row>(
        `SELECT status FROM outbox_events
          WHERE tenant_id = $1 AND event_type = 'WorkflowVersionRetired' AND payload->>'workflowVersionId' = $2`,
        [A, v2],
      ),
    ).toEqual([{ status: 'PENDING' }]);
  });
});
