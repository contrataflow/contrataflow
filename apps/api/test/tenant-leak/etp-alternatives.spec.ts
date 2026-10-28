// Alternativas de solução do ETP sobre PostgreSQL real (US-021 · Sucesso, Concorrência, Falha de
// integração, Tenant incorreto): a API inteira como `cf_app` (RLS) com os seeders reais, o processo
// pelo PRC-02 (Ana) levado (SQL) à etapa ESTUDOS_PRELIMINARES com o Rui (PLANEJAMENTO) responsável e
// o ETP pelo ETP-02. Prova o ETP-06/09 gravando `etp_alternatives`, `etps.recommended_alternative_id`
// (FK composta), a auditoria `etp.alternative_*` e o `EtpAlternativeRecommended` PENDING no outbox
// (sem relay); a substituição (FA-01) numa transação; duas recomendações simultâneas (exatamente uma
// 200 — o documento ETP travado enfileira, o índice único parcial é a última barreira); os índices
// únicos parciais (uma RECOMMENDED por ETP, nome sem caixa entre as não excluídas) e o CHECK da
// justificativa; e o isolamento: alternativa de A vista do tenant B → 404 sem alterar nada; a
// leitura sob o `app.tenant_id` de B não vê a linha. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { etpAlternativeSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { EtpAlternativeDto, EtpDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { ETP_CLOCK } from '../../src/modules/etp/application/ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c021-0000-7000-8000-00000000010a';
const B = '0192c021-0000-7000-8000-00000000010b';
const ORG_A = '0192c021-0000-7000-8000-0000000010a0';
const ORG_B = '0192c021-0000-7000-8000-0000000010b0';
const OBRAS = '0192c021-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c021-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c021-0000-7000-8000-0000000010b1';
const ANA = '0192c021-0000-7000-8000-0000000010c1';
const RUI = '0192c021-0000-7000-8000-0000000010c2';
const BETO = '0192c021-0000-7000-8000-0000000010c3';
const ANA_M = '0192c021-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-18T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const JUSTIFICATION = 'A locação reduz o custo total do período.';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = { ana: 'sub-ana-us021', rui: 'sub-rui-us021', beto: 'sub-beto-us021' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us021', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us021', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana-us021@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui-us021@a.test', true, 'Carla Mendes'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto-us021@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c021-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c021-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c021-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

const paragraph = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** SQLSTATE do erro do `pg` (pela cadeia de `cause`). */
function sqlStateOf(error: unknown): string | null {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^\d{2}[0-9A-Z]{3}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

describe('Feature: Gerenciar alternativas de solução sobre PostgreSQL (US-021)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo (PRC-02, Ana) nos ESTUDOS_PRELIMINARES com o Rui e o ETP criado por ele (ETP-02). */
  const newEtp = async (): Promise<EtpDto> => {
    const response = await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Locação de equipamentos ${words(2)}`,
        object: `Contratação de equipamentos de manutenção ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const process = (response.body as { data: ProcessDto }).data;
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'ESTUDOS_PRELIMINARES'`,
      [process.id, RUI],
    );
    const created = await call(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body as { data: EtpDto }).data;
  };
  const createAlternative = async (etpId: string, name: string): Promise<EtpAlternativeDto> => {
    const response = await call(
      request(api.server).post(`/api/v1/etps/${etpId}/alternatives`),
    ).send({ name, description: paragraph(`Descrição de ${name}.`), estimatedCost: '15000.00' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return etpAlternativeSchema.parse((response.body as { data: unknown }).data);
  };
  const decide = (
    id: string,
    body: Record<string, unknown>,
    version: number,
    subject: string = SUBJECTS.rui,
  ) =>
    call(request(api.server).post(`/api/v1/etp-alternatives/${id}/decide`), subject)
      .set('If-Match', `"${String(version)}"`)
      .send(body);
  const alternativeRows = (etpId: string) =>
    db.admin<Row>(
      `SELECT id, name, decision::text, decision_justification, estimated_cost::text, version,
              deleted_at
         FROM etp_alternatives WHERE etp_id = $1 ORDER BY sort_order, created_at, id`,
      [etpId],
    );
  const recommendedOf = async (etpId: string) => {
    const [row] = await db.admin<{ recommended_alternative_id: string | null }>(
      'SELECT recommended_alternative_id FROM etps WHERE id = $1',
      [etpId],
    );
    return row?.recommended_alternative_id ?? null;
  };
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
      DATABASE_POOL_SIZE: '10',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: ETP_CLOCK, value: () => NOW },
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
    const seeders = [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso · Falha de integração] criar, recomendar e substituir: linhas, FK do cabeçalho, auditoria e evento PENDING no outbox', async () => {
    const etp = await newEtp();
    const first = await createAlternative(etp.id, 'Locação de equipamentos');
    const second = await createAlternative(etp.id, 'Aquisição direta');

    const recommended = await decide(
      first.id,
      { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION },
      1,
    );
    expect(recommended.status, JSON.stringify(recommended.body)).toBe(200);
    expect(await recommendedOf(etp.id)).toBe(first.id);

    const replaced = await decide(
      second.id,
      {
        decision: 'RECOMMENDED',
        decisionJustification: 'Melhor custo-benefício levantado.',
        replaceRecommended: true,
      },
      1,
    );
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(await alternativeRows(etp.id)).toEqual([
      expect.objectContaining({
        id: first.id,
        decision: 'UNDER_ANALYSIS',
        decision_justification: JUSTIFICATION,
        estimated_cost: '15000.00',
        version: 3,
      }),
      expect.objectContaining({ id: second.id, decision: 'RECOMMENDED', version: 2 }),
    ]);
    expect(await recommendedOf(etp.id)).toBe(second.id);

    const events = await db.admin<Row>(
      `SELECT payload, status::text FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'EtpAlternativeRecommended'
        ORDER BY occurred_at, id`,
      [etp.id],
    );
    expect(events).toEqual([
      { payload: { etpId: etp.id, alternativeId: first.id }, status: 'PENDING' },
      {
        payload: { etpId: etp.id, alternativeId: second.id, previousAlternativeId: first.id },
        status: 'PENDING',
      },
    ]);
    const audits = await db.admin<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_id = ANY($1::uuid[])
          AND action LIKE 'etp.alternative_%' ORDER BY occurred_at, id`,
      [[first.id, second.id]],
    );
    expect(audits.map((row) => row.action)).toEqual([
      'etp.alternative_create',
      'etp.alternative_create',
      'etp.alternative_decide',
      'etp.alternative_decide',
    ]);
    const [timeline] = await db.admin<{ count: number }>(
      `SELECT count(*)::int AS count FROM process_timeline_entries
        WHERE process_id = $1 AND type = 'ETP_ALTERNATIVE_RECOMMENDED'`,
      [etp.processId],
    );
    expect(timeline?.count).toBe(2);
  });

  it('[Concorrência] duas recomendações simultâneas em alternativas diferentes: exatamente uma 200 e a outra 409', async () => {
    const etp = await newEtp();
    const alternatives = await Promise.all(
      ['Locação', 'Aquisição', 'Comodato', 'Consórcio'].map((name) =>
        createAlternative(etp.id, name),
      ),
    );
    const responses = await Promise.all(
      alternatives.map((alternative) =>
        decide(
          alternative.id,
          { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION },
          1,
        ),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(3);
    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('RECOMMENDED_ALTERNATIVE_EXISTS');
    }
    const rows = await alternativeRows(etp.id);
    expect(rows.filter((row) => row.decision === 'RECOMMENDED')).toHaveLength(1);
    expect(await recommendedOf(etp.id)).toBe(
      rows.find((row) => row.decision === 'RECOMMENDED')?.id,
    );
  });

  it('[Integridade] índices únicos parciais e CHECK da justificativa no banco', async () => {
    const etp = await newEtp();
    const first = await createAlternative(etp.id, 'Locação de equipamentos');
    const second = await createAlternative(etp.id, 'Aquisição direta');
    await db.admin(
      `UPDATE etp_alternatives SET decision = 'RECOMMENDED', decision_justification = $2
        WHERE id = $1`,
      [first.id, JUSTIFICATION],
    );
    const failures: (string | null)[] = [];
    for (const [sql, params] of [
      // RN-ETP-20: segunda RECOMMENDED no mesmo ETP.
      [
        `UPDATE etp_alternatives SET decision = 'RECOMMENDED', decision_justification = $2 WHERE id = $1`,
        [second.id, JUSTIFICATION],
      ],
      // RN-ETP-18: nome repetido sem diferenciar maiúsculas.
      [`UPDATE etp_alternatives SET name = 'LOCAÇÃO DE EQUIPAMENTOS' WHERE id = $1`, [second.id]],
      // RN-ETP-19: decisão sem justificativa.
      [
        `UPDATE etp_alternatives SET decision = 'DISCARDED', decision_justification = NULL WHERE id = $1`,
        [second.id],
      ],
    ] as const) {
      try {
        await db.admin(sql, [...params]);
        failures.push(null);
      } catch (error) {
        failures.push(sqlStateOf(error));
      }
    }
    expect(failures).toEqual(['23505', '23505', '23514']);
    // As excluídas logicamente não contam para as unicidades.
    await db.admin(`UPDATE etp_alternatives SET deleted_at = now() WHERE id = $1`, [second.id]);
    const reused = await createAlternative(etp.id, 'aquisição direta');
    expect(reused.name).toBe('aquisição direta');
  });

  it('[Tenant incorreto] alternativa de A vista do tenant B: ETP-05..09 → 404 NOT_FOUND sem alterar nada; a RLS de B não vê a linha', async () => {
    const etp = await newEtp();
    const alternative = await createAlternative(etp.id, 'Locação de equipamentos');
    const before = await alternativeRows(etp.id);

    const responses = [
      await call(request(api.server).get(`/api/v1/etps/${etp.id}/alternatives`), SUBJECTS.beto),
      await call(
        request(api.server).post(`/api/v1/etps/${etp.id}/alternatives`),
        SUBJECTS.beto,
      ).send({ name: 'Intrusa', description: paragraph('Tentativa de outro órgão.') }),
      await call(
        request(api.server).patch(`/api/v1/etp-alternatives/${alternative.id}`),
        SUBJECTS.beto,
      )
        .set('If-Match', '"1"')
        .send({ name: 'Renomeada por B' }),
      await call(
        request(api.server).delete(`/api/v1/etp-alternatives/${alternative.id}`),
        SUBJECTS.beto,
      ).set('If-Match', '"1"'),
      await decide(
        alternative.id,
        { decision: 'DISCARDED', decisionJustification: JUSTIFICATION },
        1,
        SUBJECTS.beto,
      ),
    ];
    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('Locação');
    }
    expect(await alternativeRows(etp.id)).toEqual(before);

    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM etp_alternatives WHERE id = ${alternative.id}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
    } finally {
      await client.$disconnect();
    }
  });
});
