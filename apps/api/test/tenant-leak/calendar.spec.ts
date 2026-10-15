// Calendário de dias úteis na API inteira sobre PostgreSQL real (US-106 · Tenant incorreto,
// Permissão, Duplicidade, Concorrência, Falha de banco, Falha de integração): administradores nos
// tenants A e B, auditoria e outbox reais na mesma transação, RLS de `holidays`, índice único
// `(tenant, data, lower(nome))`, gatilhos de imutabilidade e de proteção do feriado de sistema,
// concorrência real (cadastro e edição) e o seeder `catalog.holidays` reaplicado a tenant
// existente. Perfis ainda não existem como registro (US-096): o vínculo ganha `roleKeys` por uma
// porta de teste sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { seedHolidaysOf } from '@contrataflow/types';
import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  AddBusinessDaysResult,
  BusinessDaysResult,
  HolidayDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { TOKEN_VERIFIER, MEMBERSHIP_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { ApplyTenantSeedersCommand } from '../../src/modules/tenancy/application/apply-tenant-seeders.command.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000106a';
const B = '0192c000-0000-7000-8000-00000000106b';
const MARTA = '0192c000-0000-7000-8000-0000000106a1';
const OTAVIO = '0192c000-0000-7000-8000-0000000106a2';
const LUCIA = '0192c000-0000-7000-8000-0000000106a3';
const BETO = '0192c000-0000-7000-8000-0000000106b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [OTAVIO]: ['ADMIN_ORGAO'],
  // Sem CALENDAR_MANAGE (só o ADMIN_ORGAO tem — permissions.md).
  [LUCIA]: ['REQUISITANTE'],
  [BETO]: ['ADMIN_ORGAO'],
};

const NATAL_A = '0192c000-0000-7000-8000-0000000116a1';
const CARNAVAL_A = '0192c000-0000-7000-8000-0000000116a2';
const HOLIDAY_B = '0192c000-0000-7000-8000-0000000116b1';
const SYSTEM_B = '0192c000-0000-7000-8000-0000000116b2';

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'prefeitura-a-cal', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-cal', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'AM', 'America/Manaus');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${OTAVIO}', 'sub-otavio', 'otavio@a.test', true, 'Otávio Campos'),
  ('${LUCIA}', 'sub-lucia', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000116c1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000116c2', '${A}', '${OTAVIO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000116c3', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000116d1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO holidays (id, tenant_id, date, name, scope, is_recurring, is_system, version) VALUES
  ('${NATAL_A}', '${A}', '2026-12-25', 'Natal', 'NATIONAL', true, true, 3),
  ('${CARNAVAL_A}', '${A}', '2026-02-17', 'Carnaval (terça-feira)', 'OPTIONAL', true, true, 1),
  ('${HOLIDAY_B}', '${B}', '2026-11-17', 'Feriado LEAK-B', 'MUNICIPAL', false, false, 4),
  ('${SYSTEM_B}', '${B}', '2026-12-25', 'Natal', 'NATIONAL', true, true, 1);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (perfis como registro: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: calendário de dias úteis isolado por tenant sobre PostgreSQL (US-106)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (subject: string, amr: readonly string[] = MFA) => api.bearer(subject, { amr });
  const holidaysOf = (tenantId: string) =>
    db.admin<Row>(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, name, scope, is_recurring, is_system,
              is_active, version, created_by_id, updated_by_id
         FROM holidays WHERE tenant_id = $1 ORDER BY date, name`,
      [tenantId],
    );
  const holidayOf = async (tenantId: string, date: string, name: string) =>
    (await holidaysOf(tenantId)).find((row) => row.date === date && row.name === name);
  const digestOf = async (tenantId: string) => {
    const [row] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM holidays t WHERE tenant_id = $1`,
      [tenantId],
    );
    return row?.digest;
  };
  const events = (tenantId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, event_type, routing_key, status, payload FROM outbox_events
        WHERE tenant_id = $1 AND event_type = 'HolidayChanged' ORDER BY occurred_at, id`,
      [tenantId],
    );
  const audits = (tenantId: string, action: string) =>
    db.admin<Row>(
      `SELECT tenant_id, action, category, result, reason_code, actor_user_id, entity_id, changes, metadata
         FROM audit_logs WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
      [tenantId, action],
    );

  const create = (subject: string, tenant: string, body: object) =>
    request(api.server)
      .post('/api/v1/holidays')
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .send(body);
  const patch = (subject: string, tenant: string, id: string, body: object, version: number) =>
    request(api.server)
      .patch(`/api/v1/holidays/${id}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .set('If-Match', `"${version}"`)
      .send(body);
  const remove = (subject: string, tenant: string, id: string, version: number) =>
    request(api.server)
      .delete(`/api/v1/holidays/${id}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .set('If-Match', `"${version}"`);
  const list = (subject: string, tenant: string, query = '') =>
    request(api.server)
      .get(`/api/v1/holidays?${query}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant);
  const businessDays = (subject: string, tenant: string, from: string, to: string) =>
    request(api.server)
      .get(`/api/v1/calendar/business-days?from=${from}&to=${to}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant);
  const addDays = (subject: string, tenant: string, body: object) =>
    request(api.server)
      .post('/api/v1/calendar/add-business-days')
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .send(body);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

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
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] Marta cadastra o feriado municipal 12/10/2026: linha só em A, auditoria holiday.create, evento CREATED PENDING e CAL-06 não conta o dia', async () => {
    const digestOfB = await digestOf(B);

    const response = await create('sub-marta', A, {
      date: '2026-10-12',
      name: 'Aniversário da cidade',
      scope: 'MUNICIPAL',
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = data<HolidayDto>(response);
    expect(created).toMatchObject({
      date: '2026-10-12',
      scope: 'MUNICIPAL',
      isSystem: false,
      isActive: true,
      isRecurring: false,
      version: 1,
    });
    expect(await holidayOf(A, '2026-10-12', 'Aniversário da cidade')).toMatchObject({
      is_system: false,
      created_by_id: MARTA,
      updated_by_id: MARTA,
    });
    expect(await audits(A, 'holiday.create')).toEqual([
      expect.objectContaining({
        tenant_id: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actor_user_id: MARTA,
        entity_id: created.id,
        changes: [
          { path: 'date', old: null, new: '2026-10-12' },
          { path: 'name', old: null, new: 'Aniversário da cidade' },
          { path: 'scope', old: null, new: 'MUNICIPAL' },
        ],
      }),
    ]);
    // [Falha de integração] o relay não roda aqui: o evento fica PENDING até ele voltar.
    expect(await events(A)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        routing_key: 'catalog.holiday_changed',
        status: 'PENDING',
        payload: { holidayId: created.id, date: '2026-10-12', change: 'CREATED' },
      }),
    ]);
    expect(await digestOf(B)).toBe(digestOfB);
    expect(await audits(B, 'holiday.create')).toHaveLength(0);

    // Segunda 12/10 não é dia útil: sexta 09/10 + 1 dia útil = terça 13/10 (fim do dia em UTC-3).
    const due = await addDays('sub-marta', A, {
      fromDateTime: '2026-10-09T15:00:00Z',
      businessDays: 1,
    });
    expect(data<AddBusinessDaysResult>(due).dueDateTime).toBe('2026-10-14T02:59:59.999Z');
    const listed = await list('sub-marta', A, 'year=2026');
    expect(data<HolidayDto[]>(listed).map((holiday) => holiday.id)).toContain(created.id);
  });

  it('[Sucesso] edição e exclusão: versão +1, auditoria dos campos, evento por mudança e feriado excluído de verdade', async () => {
    const edited = await patch('sub-marta', A, NATAL_A, { isActive: false }, 3);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.headers.etag).toBe('"4"');
    expect(await holidayOf(A, '2026-12-25', 'Natal')).toMatchObject({
      is_active: false,
      is_system: true,
      version: 4,
      updated_by_id: MARTA,
    });
    // Desativado: 25/12/2026 (sexta) volta a ser dia útil.
    const open = await businessDays('sub-marta', A, '2026-12-24', '2026-12-28');
    expect(data<BusinessDaysResult>(open).dates).toEqual([
      '2026-12-24',
      '2026-12-25',
      '2026-12-28',
    ]);
    await patch('sub-marta', A, NATAL_A, { isActive: true }, 4);

    const extra = data<HolidayDto>(
      await create('sub-marta', A, { date: '2026-09-20', name: 'Farroupilha', scope: 'STATE' }),
    );
    const deleted = await remove('sub-marta', A, extra.id, 1);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    expect(await holidayOf(A, '2026-09-20', 'Farroupilha')).toBeUndefined();

    expect((await audits(A, 'holiday.update')).map((row) => row.changes)).toEqual([
      [{ path: 'isActive', old: true, new: false }],
      [{ path: 'isActive', old: false, new: true }],
    ]);
    expect(await audits(A, 'holiday.delete')).toEqual([
      expect.objectContaining({
        entity_id: extra.id,
        metadata: { holidayId: extra.id, date: '2026-09-20' },
      }),
    ]);
    const changes = (await events(A)).map((row) => (row.payload as { change: string }).change);
    expect(changes).toEqual(['CREATED', 'UPDATED', 'UPDATED', 'CREATED', 'DELETED']);
  });

  it('[Validação] data ausente e escopo NATIONAL: 422 e nada gravado nem publicado', async () => {
    const digestOfA = await digestOf(A);
    const totalEvents = (await events(A)).length;

    const missing = await create('sub-marta', A, { name: 'Sem data', scope: 'MUNICIPAL' });
    expect(missing.status).toBe(422);
    expect(problemDetailsSchema.parse(missing.body).errors).toEqual([
      expect.objectContaining({ field: 'date', code: 'REQUIRED' }),
    ]);
    const national = await create('sub-marta', A, {
      date: '2026-05-05',
      name: 'Nacional falso',
      scope: 'NATIONAL',
    });
    expect(national.status).toBe(422);

    expect(await digestOf(A)).toBe(digestOfA);
    expect((await events(A)).length).toBe(totalEvents);
  });

  it('[Permissão] vínculo sem CALENDAR_MANAGE: 403 PERMISSION_DENIED + access.denied em CAL-02..04, nada muda; leitura liberada', async () => {
    const digestOfA = await digestOf(A);
    const denied = [
      await create('sub-lucia', A, { date: '2026-06-01', name: 'Negado', scope: 'MUNICIPAL' }),
      await patch('sub-lucia', A, CARNAVAL_A, { isActive: false }, 1),
      await remove('sub-lucia', A, CARNAVAL_A, 1),
    ];
    for (const response of denied) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(problemCode(response)).toBe('PERMISSION_DENIED');
    }
    expect(await audits(A, 'access.denied')).toHaveLength(3);
    expect(await audits(A, 'access.denied')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_user_id: LUCIA,
          reason_code: 'CALENDAR_MANAGE',
          result: 'DENIED',
        }),
      ]),
    );
    expect(await digestOf(A)).toBe(digestOfA);
    expect((await list('sub-lucia', A, 'year=2026')).status).toBe(200);
    expect((await businessDays('sub-lucia', A, '2026-10-01', '2026-10-05')).status).toBe(200);
  });

  it('[Tenant incorreto] o feriado de B não afeta A; ID de B → 404; RLS limita a sessão ao tenant', async () => {
    const digestOfB = await digestOf(B);

    // B tem feriado na terça 17/11/2026; A não.
    const inA = await businessDays('sub-marta', A, '2026-11-16', '2026-11-18');
    expect(data<BusinessDaysResult>(inA).dates).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);
    const inB = await businessDays('sub-beto', B, '2026-11-16', '2026-11-18');
    expect(data<BusinessDaysResult>(inB).dates).toEqual(['2026-11-16', '2026-11-18']);
    const dueA = await addDays('sub-marta', A, {
      fromDateTime: '2026-11-16T15:00:00Z',
      businessDays: 1,
    });
    expect(data<AddBusinessDaysResult>(dueA).dueDateTime).toBe('2026-11-18T02:59:59.999Z');
    // Em B a terça é feriado: 16/11 + 1 dia útil = quarta 18/11, e o fuso é o do tenant (Manaus,
    // UTC-4, fecha o dia às 03:59:59.999Z do dia seguinte).
    const dueB = await addDays('sub-beto', B, {
      fromDateTime: '2026-11-16T15:00:00Z',
      businessDays: 1,
    });
    expect(data<AddBusinessDaysResult>(dueB).dueDateTime).toBe('2026-11-19T03:59:59.999Z');

    for (const response of [
      await patch('sub-marta', A, HOLIDAY_B, { name: 'Invasão' }, 4),
      await remove('sub-marta', A, HOLIDAY_B, 4),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemCode(response)).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }
    const listed = await list('sub-marta', A, 'year=2026');
    expect(JSON.stringify(listed.body)).not.toContain('LEAK-B');
    const own = await list('sub-beto', B, 'year=2026');
    expect(data<HolidayDto[]>(own).map((holiday) => holiday.name)).toEqual([
      'Feriado LEAK-B',
      'Natal',
    ]);

    // RLS: sem filtro de aplicação, a sessão do tenant A só enxerga as linhas de A.
    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id FROM holidays`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Duplicidade] mesma data e nome (sem diferenciar maiúsculas): 409 CONFLICT; o índice único cobre o SQL direto; outro tenant pode repetir', async () => {
    const duplicate = await create('sub-marta', A, {
      date: '2026-10-12',
      name: 'ANIVERSÁRIO DA CIDADE',
      scope: 'STATE',
    });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(409);
    expect(problemCode(duplicate)).toBe('CONFLICT');

    await expect(
      db.admin(
        `INSERT INTO holidays (id, tenant_id, date, name, scope)
         VALUES ('0192c000-0000-7000-8000-0000000126a1', '${A}', '2026-10-12', 'aniversário da cidade', 'STATE')`,
      ),
    ).rejects.toThrow(/holidays_tenant_id_date_lower_name_key/);

    // Mesmo nome e data em B (o Natal de sistema): a unicidade é por tenant.
    expect(await holidayOf(B, '2026-12-25', 'Natal')).toBeDefined();
    expect(await holidayOf(A, '2026-12-25', 'Natal')).toBeDefined();
    // Escopos/nomes diferentes na mesma data convivem (RN-TEN-75).
    const sameDay = await create('sub-marta', A, {
      date: '2026-10-12',
      name: 'Dia do estado',
      scope: 'STATE',
    });
    expect(sameDay.status, JSON.stringify(sameDay.body)).toBe(201);
  });

  it('[Concorrência] dois POST simultâneos do mesmo feriado: um 201 e o outro 409 CONFLICT (o índice único decide)', async () => {
    const body = { date: '2026-10-27', name: 'Corrida', scope: 'MUNICIPAL' };
    const results = await Promise.all([
      create('sub-marta', A, body),
      create('sub-otavio', A, body),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(problemCode(results.find((result) => result.status === 409) as request.Response)).toBe(
      'CONFLICT',
    );
    expect((await holidaysOf(A)).filter((row) => row.name === 'Corrida')).toHaveLength(1);
    // O perdedor não deixou auditoria nem evento (a transação foi desfeita).
    expect(
      (await audits(A, 'holiday.create')).filter(
        (row) => (row.changes as { path: string; new: unknown }[])[1]?.new === 'Corrida',
      ),
    ).toHaveLength(1);
  });

  it('[Concorrência] dois PATCH com o mesmo If-Match: um 200 (versão +1), o outro 412 VERSION_CONFLICT com currentVersion', async () => {
    const version = Number((await holidayOf(A, '2026-02-17', 'Carnaval (terça-feira)'))?.version);
    const results = await Promise.all([
      patch('sub-marta', A, CARNAVAL_A, { scope: 'MUNICIPAL' }, version),
      patch('sub-otavio', A, CARNAVAL_A, { isRecurring: false }, version),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const loser = results.find((result) => result.status === 412);
    expect(problemDetailsSchema.parse(loser?.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: version + 1,
    });
    expect((await holidayOf(A, '2026-02-17', 'Carnaval (terça-feira)'))?.version).toBe(version + 1);
  });

  it('[Sistema] feriado de sistema: excluir/renomear → 409 CATALOG_ITEM_SYSTEM; pode ser desativado; FA-03 ponto facultativo só conta com a configuração', async () => {
    const del = await remove('sub-marta', A, CARNAVAL_A, 2);
    expect(del.status, JSON.stringify(del.body)).toBe(409);
    expect(problemCode(del)).toBe('CATALOG_ITEM_SYSTEM');
    const rename = await patch('sub-marta', A, CARNAVAL_A, { name: 'Carnaval local' }, 2);
    expect(rename.status).toBe(409);
    expect(problemCode(rename)).toBe('CATALOG_ITEM_SYSTEM');
    expect(await holidayOf(A, '2026-02-17', 'Carnaval (terça-feira)')).toBeDefined();

    // Volta o escopo do Carnaval a OPTIONAL (o teste de concorrência o mudou ou não, conforme o vencedor).
    const current = await holidayOf(A, '2026-02-17', 'Carnaval (terça-feira)');
    await patch('sub-marta', A, CARNAVAL_A, { scope: 'OPTIONAL' }, Number(current?.version));

    const range = () => businessDays('sub-marta', A, '2026-02-16', '2026-02-18');
    expect(data<BusinessDaysResult>(await range()).dates).toEqual([
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
    ]);
    await db.admin(
      `INSERT INTO tenant_settings (id, tenant_id, key, value)
       VALUES ('0192c000-0000-7000-8000-0000000136a1', '${A}',
               'calendar.optionalHolidaysAreNonBusiness', 'true')`,
    );
    expect(data<BusinessDaysResult>(await range()).dates).toEqual(['2026-02-16', '2026-02-18']);
    await db.admin(`DELETE FROM tenant_settings WHERE tenant_id = '${A}'`);
  });

  it('[Sucesso] seeder catalog.holidays reaplicado a tenant existente: repõe os dois anos, preserva edições e não toca em B', async () => {
    const year = new Date().getFullYear();
    const expected = seedHolidaysOf(year).length + seedHolidaysOf(year + 1).length;
    const digestOfB = await digestOf(B);
    const apply = api.app.get(ApplyTenantSeedersCommand, { strict: false });
    const natal = await holidayOf(A, '2026-12-25', 'Natal');

    const first = await apply.execute({
      slug: 'prefeitura-a-cal',
      seederKey: 'catalog.holidays',
      dryRun: false,
    });

    expect(first).toEqual([
      expect.objectContaining({ key: 'catalog.holidays', result: 'APPLIED' }),
    ]);
    const thisAndNext = (await holidaysOf(A)).filter(
      (row) =>
        row.is_system &&
        (String(row.date).startsWith(String(year)) ||
          String(row.date).startsWith(String(year + 1))),
    );
    expect(thisAndNext).toHaveLength(expected);
    if (year === 2026) expect(await holidayOf(A, '2026-12-25', 'Natal')).toEqual(natal);

    const second = await apply.execute({
      slug: 'prefeitura-a-cal',
      seederKey: 'catalog.holidays',
      dryRun: false,
    });
    expect(second).toEqual([expect.objectContaining({ result: 'UP_TO_DATE' })]);
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Banco] gatilhos de imutabilidade e proteção do feriado de sistema; privilégios da aplicação e do worker', async () => {
    await expect(
      db.admin(`UPDATE holidays SET date = '2026-12-26' WHERE id = '${NATAL_A}'`),
    ).rejects.toThrow(/imutáveis|date/);
    await expect(
      db.admin(`UPDATE holidays SET is_system = false WHERE id = '${NATAL_A}'`),
    ).rejects.toThrow(/imutáveis|is_system/);
    await expect(
      db.admin(`UPDATE holidays SET tenant_id = '${B}' WHERE id = '${NATAL_A}'`),
    ).rejects.toThrow(/imutáveis|tenant_id/);
    await expect(
      db.admin(`UPDATE holidays SET name = 'Natal do município' WHERE id = '${NATAL_A}'`),
    ).rejects.toThrow(/imutáveis|name/);
    await expect(db.admin(`DELETE FROM holidays WHERE id = '${NATAL_A}'`)).rejects.toThrow(
      /não pode ser excluído/,
    );

    // A aplicação exclui só o que não é de sistema (o gatilho recusa o resto, mesmo com DELETE).
    const app = db.client('cf_app');
    await expect(
      asTenant(A, () => app.$tenantTransaction((tx) => tx.holiday.deleteMany({}))),
    ).rejects.toSatisfy((error: unknown) => /não pode ser excluído/i.test(String(error)));
    expect((await holidaysOf(A)).length).toBeGreaterThan(0);

    // O worker só lê e insere (geração do ano seguinte): nada de UPDATE/DELETE.
    const worker = db.client('cf_worker');
    await expect(
      asTenant(A, () => worker.$tenantTransaction((tx) => tx.holiday.deleteMany({}))),
    ).rejects.toSatisfy((error: unknown) => /permission denied/i.test(String(error)));
    await expect(
      asTenant(A, () =>
        worker.$tenantTransaction((tx) => tx.holiday.updateMany({ data: { name: 'x' } })),
      ),
    ).rejects.toSatisfy((error: unknown) => /permission denied/i.test(String(error)));
  });

  it('[Falha de banco] banco indisponível ao cadastrar → 503 com Retry-After e CAL-06 também 503 (repetível)', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await create('sub-marta', A, {
      date: '2026-11-30',
      name: 'Sem banco',
      scope: 'MUNICIPAL',
    });
    expect(response.status).toBe(503);
    expect(problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();

    const calculation = await addDays('sub-marta', A, {
      fromDateTime: '2026-10-09T15:00:00Z',
      businessDays: 1,
    });
    expect(calculation.status).toBe(503);
    expect(problemCode(calculation)).toBe('DEPENDENCY_UNAVAILABLE');
  });
});
