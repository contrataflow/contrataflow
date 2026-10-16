// Editor de workflow sobre PostgreSQL real (US-043 · Tenant incorreto, Concorrência, Falha de
// integração, RN-WF-50): workflow de outro tenant → 404 sem vazar nada, dois PATCH simultâneos com o
// mesmo If-Match (um 200, outro 412), `WorkflowCreated` PENDING no outbox sem relay e a exclusão
// restritiva de etapa sem tocar nas linhas. Os gatilhos de imutabilidade, as FKs compostas e o
// rascunho único estão em `workflows.spec.ts` (US-040).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c043-0000-7000-8000-00000000000a';
const B = '0192c043-0000-7000-8000-00000000000b';
const CARLA = '0192c043-0000-7000-8000-0000000000a1';
const DANIEL = '0192c043-0000-7000-8000-0000000000a2';
const BETO = '0192c043-0000-7000-8000-0000000000b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CARLA]: ['ADMIN_ORGAO'],
  // Outro administrador, para a edição simultânea.
  [DANIEL]: ['ADMIN_ORGAO'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-wf-editor', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-wf-editor', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla', 'carla@a.test', true, 'Carla Mendes'),
  ('${DANIEL}', 'sub-daniel', 'daniel@a.test', true, 'Daniel Souza'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c043-0000-7000-8000-0000000001a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c043-0000-7000-8000-0000000001a2', '${A}', '${DANIEL}', 'INTERNAL', 'ACTIVE'),
  ('0192c043-0000-7000-8000-0000000001b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
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

describe('Feature: editor de workflow isolado por tenant sobre PostgreSQL (US-043)', () => {
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
  const patch = (subject: string, path: string, body: object, version: number) =>
    as(request(api.server).patch(`/api/v1${path}`), subject)
      .set('If-Match', `"${version}"`)
      .send(body);
  const remove = (subject: string, path: string, version: number) =>
    as(request(api.server).delete(`/api/v1${path}`), subject).set('If-Match', `"${version}"`);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

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

  let obras: WorkflowDto;
  let draftId: string;
  let parecer: WorkflowStageDto;

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
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Falha de integração] sem relay, WorkflowCreated fica PENDING e o workflow nasce com a v1 DRAFT', async () => {
    obras = await createWorkflow(
      'sub-carla',
      'OBRAS_RITO_SIMPLIFICADO',
      'Obras — rito simplificado',
    );
    draftId = obras.draftVersion?.id ?? '';
    const [version] = await db.admin<Row>(
      'SELECT version_number, status FROM workflow_versions WHERE workflow_id = $1',
      [obras.id],
    );
    expect(version).toMatchObject({ version_number: 1, status: 'DRAFT' });
    expect(
      await db.admin<Row>(
        `SELECT routing_key, status, payload FROM outbox_events
          WHERE tenant_id = $1 AND event_type = 'WorkflowCreated'`,
        [A],
      ),
    ).toEqual([
      expect.objectContaining({
        routing_key: 'workflow.created',
        status: 'PENDING',
        payload: { workflowId: obras.id, key: 'OBRAS_RITO_SIMPLIFICADO' },
      }),
    ]);
  });

  it('[Concorrência] dois PATCH simultâneos na mesma etapa com o mesmo If-Match: um 200, outro 412', async () => {
    parecer = await addStage('sub-carla', draftId, {
      key: 'PARECER_JURIDICO',
      name: 'Parecer jurídico',
      type: 'TASK',
    });
    const etag = parecer.version ?? 1;
    const [carla, daniel] = await Promise.all([
      patch('sub-carla', `/workflow-stages/${parecer.id}`, { slaDays: 10 }, etag),
      patch('sub-daniel', `/workflow-stages/${parecer.id}`, { name: 'Parecer da PGM' }, etag),
    ]);
    expect([carla.status, daniel.status].sort()).toEqual([200, 412]);
    const loser = carla.status === 412 ? carla : daniel;
    expect(problemCode(loser)).toBe('VERSION_CONFLICT');
    const [row] = await db.admin<Row>('SELECT version FROM workflow_stages WHERE id = $1', [
      parecer.id,
    ]);
    expect(row?.version).toBe(etag + 1);
    parecer = data<WorkflowStageDto>(carla.status === 200 ? carla : daniel);
  });

  it('[Validação] RN-WF-50: etapa referenciada por transição não é excluída (sem cascata)', async () => {
    const abertura = await addStage('sub-carla', draftId, {
      key: 'ABERTURA',
      name: 'Abertura',
      type: 'START',
    });
    const response = await post('sub-carla', `/workflow-versions/${draftId}/transitions`, {
      key: 'ENCAMINHAR_JURIDICO',
      name: 'Encaminhar para o jurídico',
      fromStageId: abertura.id,
      toStageId: parecer.id,
      action: 'FORWARD',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const transition = data<WorkflowTransitionDto>(response);

    const blocked = await remove(
      'sub-carla',
      `/workflow-stages/${parecer.id}`,
      parecer.version ?? 1,
    );
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(422);
    expect(problemDetailsSchema.parse(blocked.body).violations).toEqual([
      expect.objectContaining({ itemId: transition.id, code: 'REFERENCED_BY_TRANSITION' }),
    ]);
    expect(
      await db.admin<Row>('SELECT id FROM workflow_transitions WHERE id = $1', [transition.id]),
    ).toHaveLength(1);
    expect(
      await db.admin<Row>('SELECT id FROM workflow_stages WHERE id = $1', [parecer.id]),
    ).toHaveLength(1);
  });

  it('[Tenant incorreto] workflow de outro tenant → 404 sem revelar a existência', async () => {
    const other = await createWorkflow('sub-beto', 'FLUXO_INTERNO', 'Fluxo interno LEAK-B');
    const otherDraft = other.draftVersion?.id ?? '';
    const otherStage = await addStage('sub-beto', otherDraft, {
      key: 'ETAPA_B',
      name: 'Etapa LEAK-B',
      type: 'TASK',
    });

    for (const response of [
      await get('sub-carla', `/workflows/${other.id}`),
      await get('sub-carla', `/workflow-versions/${otherDraft}`),
      await post('sub-carla', `/workflow-versions/${otherDraft}/stages`, {
        key: 'INVASAO',
        name: 'Invasão',
        type: 'TASK',
      }),
      await patch('sub-carla', `/workflow-stages/${otherStage.id}`, { name: 'Invasão' }, 1),
      await remove('sub-carla', `/workflow-stages/${otherStage.id}`, 1),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemCode(response)).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }
    const list = data<WorkflowDto[]>(await get('sub-carla', '/workflows'));
    expect(list.map((workflow) => workflow.id)).toEqual([obras.id]);
    const [stageB] = await db.admin<Row>('SELECT name FROM workflow_stages WHERE id = $1', [
      otherStage.id,
    ]);
    expect(stageB?.name).toBe('Etapa LEAK-B');
  });
});
