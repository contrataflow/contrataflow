import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  AddBusinessDaysResult,
  BusinessDaysResult,
  HolidayDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { CATALOG_CLOCK, CATALOG_TRANSACTIONS } from '../application/catalog-ports.js';
import type { CatalogTransactions } from '../application/catalog-ports.js';
import type { Holiday } from '../domain/holiday.js';
import {
  InMemoryCalendarSettingsReader,
  InMemoryHolidayRepository,
} from '../infrastructure/in-memory-holiday.repository.js';

/*
 * US-106 — CAL-01..06 pelo pipeline HTTP completo (autenticação, tenant, vínculo, If-Match,
 * validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do `AuditService` e o
 * outbox em memória. Os mesmos casos contra o PostgreSQL (RLS, índice único, gatilhos,
 * concorrência real) estão em `test/tenant-leak/calendar.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta; // ADMIN_ORGAO (tem CALENDAR_MANAGE)
const OTAVIO = FAKE_USERS.otavio; // ADMIN_ORGAO
const LUCIA = FAKE_USERS.lucia; // GESTOR_CONTRATACOES (sem CALENDAR_MANAGE)
const ANA = FAKE_USERS.ana; // sem CALENDAR_MANAGE
const HEITOR = FAKE_USERS.heitor; // tenant B
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');

const NATAL_A = newId();
const CARNAVAL_A = newId();
const HOLIDAY_B = newId();

function holiday(overrides: Partial<Holiday> & Pick<Holiday, 'id' | 'tenantId'>): Holiday {
  return {
    date: '2026-01-01',
    name: 'Feriado',
    scope: 'NATIONAL',
    isRecurring: true,
    isSystem: true,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function dataOf<T = unknown>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Gerenciar calendário de dias úteis e feriados (US-106)', () => {
  let api: TestApi;
  let repository: InMemoryHolidayRepository;
  let settings: InMemoryCalendarSettingsReader;

  const rows = (tenantId: string) =>
    repository.snapshot().filter((row) => row.tenantId === tenantId);
  const rowOf = (id: string) => repository.snapshot().find((row) => row.id === id);

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: CATALOG_CLOCK, value: () => NOW }] });
    repository = api.app.get(InMemoryHolidayRepository, { strict: false });
    settings = api.app.get(InMemoryCalendarSettingsReader, { strict: false });
    // Background: tenant A com feriados de sistema; tenant B com um feriado municipal próprio
    // (na mesma semana do cálculo do cenário [Tenant incorreto]).
    repository.seed(
      holiday({ id: NATAL_A, tenantId: A, date: '2026-12-25', name: 'Natal' }),
      holiday({
        id: CARNAVAL_A,
        tenantId: A,
        date: '2026-02-17',
        name: 'Carnaval (terça-feira)',
        scope: 'OPTIONAL',
      }),
      holiday({
        id: newId(),
        tenantId: A,
        date: '2027-01-01',
        name: 'Confraternização Universal',
      }),
      holiday({
        id: HOLIDAY_B,
        tenantId: B,
        date: '2026-11-17',
        name: 'Feriado LEAK-B',
        scope: 'MUNICIPAL',
        isSystem: false,
        isRecurring: false,
      }),
    );
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const withAuth = (
    test: request.Test,
    user: { subject: string },
    options: { amr?: readonly string[]; tenant?: string } = {},
  ) =>
    test
      .set('Authorization', api.bearer(user.subject, { amr: options.amr ?? MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);

  const list = (query = '', user: { subject: string } = MARTA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/holidays?${query}`), user, { tenant });

  const create = (
    body: Record<string, unknown>,
    options: { user?: { subject: string }; amr?: readonly string[]; tenant?: string } = {},
  ) =>
    withAuth(request(api.server).post('/api/v1/holidays'), options.user ?? MARTA, options).send(
      body,
    );

  const patch = (
    id: string,
    body: Record<string, unknown>,
    version: number | string | null,
    user: { subject: string } = MARTA,
  ) => {
    const test = withAuth(request(api.server).patch(`/api/v1/holidays/${id}`), user);
    if (version !== null) test.set('If-Match', `"${version}"`);
    return test.send(body);
  };

  const remove = (id: string, version: number | null, user: { subject: string } = MARTA) => {
    const test = withAuth(request(api.server).delete(`/api/v1/holidays/${id}`), user);
    if (version !== null) test.set('If-Match', `"${version}"`);
    return test;
  };

  const businessDays = (
    from: string,
    to: string,
    tenant: string = A,
    user: { subject: string } = MARTA,
  ) =>
    withAuth(
      request(api.server).get(`/api/v1/calendar/business-days?from=${from}&to=${to}`),
      user,
      { tenant },
    );

  const addDays = (
    body: Record<string, unknown>,
    user: { subject: string } = MARTA,
    tenant: string = A,
  ) =>
    withAuth(request(api.server).post('/api/v1/calendar/add-business-days'), user, { tenant }).send(
      body,
    );

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = () => api.outboxRows().filter((row) => row.eventType === 'HolidayChanged');

  describe('[Sucesso]', () => {
    it('CAL-02: cadastrar o feriado municipal "Aniversário da cidade" em 12/10/2026 → 201, lista do ano, CAL-06 e evento CREATED', async () => {
      silence();
      const audits = auditOf('holiday.create').length;
      const events = eventsOf().length;

      const response = await create({
        date: '2026-10-12',
        name: 'Aniversário da cidade',
        scope: 'MUNICIPAL',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = dataOf<HolidayDto>(response);
      expect(created).toMatchObject({
        date: '2026-10-12',
        name: 'Aniversário da cidade',
        scope: 'MUNICIPAL',
        isRecurring: false,
        isActive: true,
        isSystem: false,
        version: 1,
      });
      expect(response.headers.location).toBe(`/api/v1/holidays/${created.id}`);
      expect(response.headers.etag).toBe('"1"');

      // Aparece na lista do ano 2026.
      const listed = dataOf<HolidayDto[]>(await list('year=2026'));
      expect(listed.map((item) => item.id)).toContain(created.id);

      // CAL-06 não conta 12/10/2026 (segunda) como dia útil: sexta 09/10 + 1 = terça 13/10.
      const due = await addDays({ fromDateTime: '2026-10-09T15:00:00Z', businessDays: 1 });
      expect(dataOf<AddBusinessDaysResult>(due).dueDateTime).toBe('2026-10-14T02:59:59.999Z');

      const records = auditOf('holiday.create');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actorUserId: MARTA.id,
        entityType: 'Holiday',
        entityId: created.id,
      });
      expect(records.at(-1)?.changes).toEqual([
        { path: 'date', old: null, new: '2026-10-12' },
        { path: 'name', old: null, new: 'Aniversário da cidade' },
        { path: 'scope', old: null, new: 'MUNICIPAL' },
      ]);
      expect(eventsOf()).toHaveLength(events + 1);
      expect(eventsOf().at(-1)).toMatchObject({
        tenantId: A,
        routingKey: 'catalog.holiday_changed',
        aggregateType: 'Holiday',
        aggregateId: created.id,
        payload: { holidayId: created.id, date: '2026-10-12', change: 'CREATED' },
      });
    });

    it('CAL-01: lista só o ano pedido por data, com selos de sistema e recorrente; leitura implícita (sem CALENDAR_MANAGE)', async () => {
      const response = await list('year=2026', ANA);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const items = dataOf<HolidayDto[]>(response);
      expect(items.every((item) => item.date.startsWith('2026'))).toBe(true);
      expect(items.map((item) => item.date)).toEqual([...items.map((item) => item.date)].sort());
      expect(items.find((item) => item.id === NATAL_A)).toMatchObject({
        date: '2026-12-25',
        name: 'Natal',
        scope: 'NATIONAL',
        isSystem: true,
        isRecurring: true,
        isActive: true,
      });
      expect((response.body as { meta: object }).meta).toMatchObject({ page: 1 });
    });

    it('CAL-01: sem year usa o ano corrente no fuso do tenant', async () => {
      const items = dataOf<HolidayDto[]>(await list(''));
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.date.startsWith('2026'))).toBe(true);
    });

    it('FA-02: cadastro retroativo é permitido', async () => {
      silence();
      const response = await create({
        date: '2020-03-19',
        name: 'Dia de São José',
        scope: 'MUNICIPAL',
        isRecurring: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(dataOf<HolidayDto>(response)).toMatchObject({ date: '2020-03-19', isRecurring: true });
    });

    it('CAL-03: edita nome e recorrência (versão +1, ETag, auditoria dos campos alterados e UPDATED)', async () => {
      silence();
      const created = dataOf<HolidayDto>(
        await create({ date: '2026-08-15', name: 'Padroeira', scope: 'MUNICIPAL' }),
      );
      const audits = auditOf('holiday.update').length;
      const events = eventsOf().length;

      const response = await patch(
        created.id,
        { name: 'Dia da padroeira', isRecurring: true },
        created.version,
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<HolidayDto>(response)).toMatchObject({
        id: created.id,
        date: '2026-08-15',
        name: 'Dia da padroeira',
        isRecurring: true,
        version: 2,
      });
      expect(response.headers.etag).toBe('"2"');
      const records = auditOf('holiday.update');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)?.changes).toEqual([
        { path: 'name', old: 'Padroeira', new: 'Dia da padroeira' },
        { path: 'isRecurring', old: false, new: true },
      ]);
      expect(eventsOf()).toHaveLength(events + 1);
      expect(eventsOf().at(-1)).toMatchObject({
        payload: { holidayId: created.id, date: '2026-08-15', change: 'UPDATED' },
      });
    });

    it('CAL-03: nada alterado → 200 sem nova versão, auditoria nem evento', async () => {
      silence();
      const created = dataOf<HolidayDto>(
        await create({ date: '2026-08-16', name: 'Sem mudança', scope: 'STATE' }),
      );
      const audits = auditOf('holiday.update').length;
      const events = eventsOf().length;

      const response = await patch(created.id, { name: 'Sem mudança', isActive: true }, 1);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<HolidayDto>(response).version).toBe(1);
      expect(auditOf('holiday.update')).toHaveLength(audits);
      expect(eventsOf()).toHaveLength(events);
    });

    it('CAL-03: feriado de sistema pode ser desativado e deixa de contar nos dias úteis; reativar volta', async () => {
      silence();
      // 25/12/2026 é sexta-feira (Natal).
      const natal = rowOf(NATAL_A);
      if (!natal) throw new Error('Natal não semeado');
      const before = dataOf<BusinessDaysResult>(await businessDays('2026-12-24', '2026-12-28'));
      expect(before.dates).toEqual(['2026-12-24', '2026-12-28']);

      const off = await patch(NATAL_A, { isActive: false }, natal.version);
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(dataOf<HolidayDto>(off)).toMatchObject({ isActive: false, isSystem: true });
      const during = dataOf<BusinessDaysResult>(await businessDays('2026-12-24', '2026-12-28'));
      expect(during.dates).toEqual(['2026-12-24', '2026-12-25', '2026-12-28']);

      const on = await patch(NATAL_A, { isActive: true }, natal.version + 1);
      expect(on.status).toBe(200);
      const after = dataOf<BusinessDaysResult>(await businessDays('2026-12-24', '2026-12-28'));
      expect(after.dates).toEqual(['2026-12-24', '2026-12-28']);
    });

    it('CAL-04: exclui feriado não-sistema → 204, auditoria com holidayId/date e evento DELETED', async () => {
      silence();
      const created = dataOf<HolidayDto>(
        await create({ date: '2026-09-20', name: 'Gaúcho', scope: 'STATE' }),
      );
      const audits = auditOf('holiday.delete').length;
      const events = eventsOf().length;

      const response = await remove(created.id, created.version);

      expect(response.status, JSON.stringify(response.body)).toBe(204);
      expect(rowOf(created.id)).toBeUndefined();
      const records = auditOf('holiday.delete');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        category: 'CONFIGURATION',
        entityId: created.id,
        metadata: { holidayId: created.id, date: '2026-09-20' },
      });
      expect(eventsOf()).toHaveLength(events + 1);
      expect(eventsOf().at(-1)).toMatchObject({
        payload: { holidayId: created.id, date: '2026-09-20', change: 'DELETED' },
      });
    });

    it('CAL-05: dias úteis do intervalo, inclusive as pontas; fim de semana não conta', async () => {
      const response = await businessDays('2026-10-02', '2026-10-06');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<BusinessDaysResult>(response)).toEqual({
        businessDays: 3,
        dates: ['2026-10-02', '2026-10-05', '2026-10-06'],
      });
    });

    it('CAL-06: BUSINESS e CALENDAR, com fim do dia no fuso do tenant e businessDays = 0', async () => {
      const business = await addDays({ fromDateTime: '2026-10-02T15:00:00Z', businessDays: 3 });
      expect(dataOf<AddBusinessDaysResult>(business).dueDateTime).toBe('2026-10-08T02:59:59.999Z');

      const calendar = await addDays({
        fromDateTime: '2026-10-02T15:00:00Z',
        businessDays: 3,
        dayCountType: 'CALENDAR',
      });
      expect(dataOf<AddBusinessDaysResult>(calendar).dueDateTime).toBe('2026-10-06T02:59:59.999Z');

      const zero = await addDays({ fromDateTime: '2026-10-02T15:00:00Z', businessDays: 0 });
      expect(dataOf<AddBusinessDaysResult>(zero).dueDateTime).toBe('2026-10-03T02:59:59.999Z');
    });

    it('FA-03: ponto facultativo não altera CAL-05/CAL-06 por padrão, e altera com calendar.optionalHolidaysAreNonBusiness', async () => {
      // Carnaval (terça 17/02/2026) é OPTIONAL.
      const range = () => businessDays('2026-02-16', '2026-02-18');
      expect(dataOf<BusinessDaysResult>(await range()).dates).toEqual([
        '2026-02-16',
        '2026-02-17',
        '2026-02-18',
      ]);

      settings.set(A, { optionalHolidaysAreNonBusiness: true });
      try {
        expect(dataOf<BusinessDaysResult>(await range()).dates).toEqual([
          '2026-02-16',
          '2026-02-18',
        ]);
      } finally {
        settings.set(A, { optionalHolidaysAreNonBusiness: false });
      }
    });

    it('o fuso do tenant decide o dia local (23h de sexta em São Paulo já é sábado em UTC)', async () => {
      // 2026-10-17T01:00Z = sexta 16/10 22:00 em São Paulo → +1 dia útil = segunda 19/10.
      const response = await addDays({ fromDateTime: '2026-10-17T01:00:00Z', businessDays: 1 });
      expect(dataOf<AddBusinessDaysResult>(response).dueDateTime).toBe('2026-10-20T02:59:59.999Z');
    });
  });

  describe('[Validação]', () => {
    it('data ausente: 422 VALIDATION_ERROR no campo date (REQUIRED)', async () => {
      silence();
      const events = eventsOf().length;
      const problem = expectProblem(
        await create({ name: 'Sem data', scope: 'MUNICIPAL' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'date', code: 'REQUIRED' }),
      ]);
      expect(eventsOf()).toHaveLength(events);
    });

    it.each(['12/10/2026', '2026-02-30', 'amanhã'])(
      'data inválida %j: 422 INVALID_FORMAT em date',
      async (date) => {
        silence();
        const problem = expectProblem(
          await create({ date, name: 'Data ruim', scope: 'MUNICIPAL' }),
          422,
          'VALIDATION_ERROR',
        );
        expect(problem.errors).toEqual([
          expect.objectContaining({ field: 'date', code: 'INVALID_FORMAT' }),
        ]);
      },
    );

    it('nome vazio ou acima de 120 caracteres e escopo inválido/NATIONAL: 422 por campo', async () => {
      silence();
      const problem = expectProblem(
        await create({ date: '2026-10-20', name: ' ', scope: 'NATIONAL' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors.map((error) => error.field).sort()).toEqual(['name', 'scope']);
      expectProblem(
        await create({ date: '2026-10-20', name: 'a'.repeat(121), scope: 'MUNICIPAL' }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('CAL-06: businessDays fora do intervalo → 422 OUT_OF_RANGE; dayCountType inválido; data sem Z', async () => {
      silence();
      const base = { fromDateTime: '2026-10-02T15:00:00Z' };
      for (const businessDays of [-1, 1001]) {
        const problem = expectProblem(
          await addDays({ ...base, businessDays }),
          422,
          'VALIDATION_ERROR',
        );
        expect(problem.errors).toEqual([
          expect.objectContaining({ field: 'businessDays', code: 'OUT_OF_RANGE' }),
        ]);
      }
      expectProblem(
        await addDays({ ...base, businessDays: 1, dayCountType: 'SEMANAL' }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await addDays({ fromDateTime: '2026-10-02', businessDays: 1 }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('CAL-05: intervalo invertido, longo demais ou sem parâmetros → 422', async () => {
      silence();
      const inverted = expectProblem(
        await businessDays('2026-10-10', '2026-10-01'),
        422,
        'VALIDATION_ERROR',
      );
      expect(inverted.errors).toEqual([
        expect.objectContaining({ field: 'to', code: 'OUT_OF_RANGE' }),
      ]);
      expectProblem(await businessDays('2026-01-01', '2030-01-01'), 422, 'VALIDATION_ERROR');
      expectProblem(
        await withAuth(request(api.server).get('/api/v1/calendar/business-days'), MARTA),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('CAL-03/04 sem If-Match: 428 PRECONDITION_REQUIRED', async () => {
      silence();
      expectProblem(
        await patch(CARNAVAL_A, { isActive: false }, null),
        428,
        'PRECONDITION_REQUIRED',
      );
      expectProblem(await remove(CARNAVAL_A, null), 428, 'PRECONDITION_REQUIRED');
    });
  });

  describe('[Permissão]', () => {
    it('usuário sem CALENDAR_MANAGE: 403 PERMISSION_DENIED e access.denied em CAL-02..04; leitura liberada', async () => {
      silence();
      const denials = auditOf('access.denied').length;
      const events = eventsOf().length;
      const total = rows(A).length;

      const denied = [
        await create({ date: '2026-10-21', name: 'Negado', scope: 'MUNICIPAL' }, { user: ANA }),
        await create({ date: '2026-10-21', name: 'Negado', scope: 'MUNICIPAL' }, { user: LUCIA }),
        await patch(CARNAVAL_A, { isActive: false }, 1, LUCIA),
        await remove(CARNAVAL_A, 1, LUCIA),
      ];

      for (const response of denied) expectProblem(response, 403, 'PERMISSION_DENIED');
      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 4);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: LUCIA.id,
        reasonCode: 'CALENDAR_MANAGE',
        result: 'DENIED',
      });
      expect(eventsOf()).toHaveLength(events);
      expect(rows(A)).toHaveLength(total);
      expect(rowOf(CARNAVAL_A)?.isActive).toBe(true);
      expect((await list('year=2026', LUCIA)).status).toBe(200);
      expect((await businessDays('2026-10-01', '2026-10-05', A, LUCIA)).status).toBe(200);
      expect(
        (await addDays({ fromDateTime: '2026-10-02T15:00:00Z', businessDays: 1 }, ANA)).status,
      ).toBe(200);
    });

    it('administrador sem MFA basta (CALENDAR_MANAGE é risco M; MFA só com security.mfaPolicy = ALL)', async () => {
      silence();
      const response = await create(
        { date: '2026-10-22', name: 'Sem MFA', scope: 'MUNICIPAL' },
        { user: MARTA, amr: ['pwd'] },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('o feriado municipal do tenant B não afeta o cálculo de A em CAL-05/CAL-06', async () => {
      // B tem feriado na terça 17/11/2026; A não.
      const inA = dataOf<BusinessDaysResult>(await businessDays('2026-11-16', '2026-11-18'));
      expect(inA.dates).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);
      const inB = dataOf<BusinessDaysResult>(
        await businessDays('2026-11-16', '2026-11-18', B, HEITOR),
      );
      expect(inB.dates).toEqual(['2026-11-16', '2026-11-18']);

      const dueA = await addDays({ fromDateTime: '2026-11-16T15:00:00Z', businessDays: 1 });
      expect(dataOf<AddBusinessDaysResult>(dueA).dueDateTime).toBe('2026-11-18T02:59:59.999Z');
    });

    it('feriado de B em CAL-03/CAL-04 → 404 sem revelar nada; a lista de A não traz o de B', async () => {
      silence();
      for (const response of [
        await patch(HOLIDAY_B, { name: 'Invasão' }, 1),
        await remove(HOLIDAY_B, 1),
      ]) {
        expectProblem(response, 404, 'NOT_FOUND');
        expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
      }
      expect(rowOf(HOLIDAY_B)).toMatchObject({ name: 'Feriado LEAK-B', version: 1 });

      const listA = await list('year=2026');
      expect(JSON.stringify(listA.body)).not.toContain('LEAK-B');
      const listB = dataOf<HolidayDto[]>(await list('year=2026', HEITOR, B));
      expect(listB.map((item) => item.name)).toEqual(['Feriado LEAK-B']);
    });

    it('administradora de A não opera no tenant B (cabeçalho divergente do vínculo)', async () => {
      const response = await list('year=2026', MARTA, B);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    });
  });

  describe('[Sistema]', () => {
    it('CAL-04 em feriado de sistema: 409 CATALOG_ITEM_SYSTEM e o feriado permanece', async () => {
      silence();
      const events = eventsOf().length;
      expectProblem(await remove(CARNAVAL_A, 1), 409, 'CATALOG_ITEM_SYSTEM');
      expect(rowOf(CARNAVAL_A)).toBeDefined();
      expect(eventsOf()).toHaveLength(events);
    });

    it('CAL-03: renomear feriado de sistema → 409 CATALOG_ITEM_SYSTEM; escopo e recorrência podem ser ajustados', async () => {
      silence();
      const carnaval = rowOf(CARNAVAL_A);
      if (!carnaval) throw new Error('Carnaval não semeado');
      expectProblem(
        await patch(CARNAVAL_A, { name: 'Carnaval do município' }, carnaval.version),
        409,
        'CATALOG_ITEM_SYSTEM',
      );
      const adjusted = await patch(CARNAVAL_A, { scope: 'MUNICIPAL' }, carnaval.version);
      expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
      expect(dataOf<HolidayDto>(adjusted).scope).toBe('MUNICIPAL');
      // Restaura para os demais cenários.
      await patch(CARNAVAL_A, { scope: 'OPTIONAL' }, carnaval.version + 1);
    });

    it('CAL-03: promover feriado do administrador a NATIONAL → 422 NOT_ALLOWED em scope', async () => {
      silence();
      const created = dataOf<HolidayDto>(
        await create({ date: '2026-10-23', name: 'Quase nacional', scope: 'STATE' }),
      );
      const problem = expectProblem(
        await patch(created.id, { scope: 'NATIONAL' }, created.version),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'scope', code: 'NOT_ALLOWED' }),
      ]);
    });
  });

  describe('[Duplicidade]', () => {
    it('mesma data e nome (sem diferenciar maiúsculas): 409 CONFLICT e nada gravado', async () => {
      silence();
      const first = await create({
        date: '2026-10-24',
        name: 'Aniversário duplicado',
        scope: 'MUNICIPAL',
      });
      expect(first.status).toBe(201);
      const total = rows(A).length;
      const events = eventsOf().length;

      const problem = expectProblem(
        await create({
          date: '2026-10-24',
          name: 'ANIVERSÁRIO DUPLICADO'.toLowerCase(),
          scope: 'STATE',
        }),
        409,
        'CONFLICT',
      );
      expect(problem.detail).toBe('Já existe um feriado com esta data e nome.');
      expect(rows(A)).toHaveLength(total);
      expect(eventsOf()).toHaveLength(events);
    });

    it('RN-TEN-75: escopos diferentes na mesma data com nomes diferentes são permitidos; o mesmo nome em outro tenant também', async () => {
      silence();
      const national = await create({ date: '2026-10-25', name: 'Dia comum', scope: 'MUNICIPAL' });
      const other = await create({ date: '2026-10-25', name: 'Dia estadual', scope: 'STATE' });
      expect(national.status).toBe(201);
      expect(other.status).toBe(201);
      const inB = await create(
        { date: '2026-10-25', name: 'Dia comum', scope: 'MUNICIPAL' },
        { user: HEITOR, tenant: B },
      );
      // HEITOR (gestor) não tem CALENDAR_MANAGE: o isolamento do índice por tenant é coberto no PostgreSQL.
      expect(inB.status).toBe(403);
    });

    it('renomear para uma data/nome já existente: 409 CONFLICT', async () => {
      silence();
      const one = dataOf<HolidayDto>(
        await create({ date: '2026-10-26', name: 'Um', scope: 'MUNICIPAL' }),
      );
      await create({ date: '2026-10-26', name: 'Dois', scope: 'MUNICIPAL' });
      expectProblem(await patch(one.id, { name: 'dois' }, one.version), 409, 'CONFLICT');
      expect(rowOf(one.id)?.name).toBe('Um');
    });
  });

  describe('[Concorrência]', () => {
    it('dois POST simultâneos do mesmo feriado: um 201 e o outro 409 CONFLICT', async () => {
      silence();
      const body = { date: '2026-10-27', name: 'Corrida', scope: 'MUNICIPAL' };

      const [one, two] = await Promise.all([
        create(body, { user: MARTA }),
        create(body, { user: OTAVIO }),
      ]);

      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expectProblem(one.status === 409 ? one : two, 409, 'CONFLICT');
      expect(rows(A).filter((row) => row.name === 'Corrida')).toHaveLength(1);
    });

    it('duas edições com o mesmo If-Match: uma 200 e a outra 412 com currentVersion', async () => {
      silence();
      const created = dataOf<HolidayDto>(
        await create({ date: '2026-10-28', name: 'Edição', scope: 'MUNICIPAL' }),
      );

      const [one, two] = await Promise.all([
        patch(created.id, { name: 'Edição (A)' }, created.version, MARTA),
        patch(created.id, { name: 'Edição (B)' }, created.version, OTAVIO),
      ]);

      expect([one.status, two.status].sort()).toEqual([200, 412]);
      const loser = one.status === 412 ? one : two;
      const problem = expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect((problem as Record<string, unknown>).currentVersion).toBe(created.version + 1);
    });

    it('If-Match desatualizado em CAL-04: 412 VERSION_CONFLICT e o feriado permanece', async () => {
      silence();
      const created = dataOf<HolidayDto>(
        await create({ date: '2026-10-29', name: 'Versão', scope: 'MUNICIPAL' }),
      );
      expectProblem(await remove(created.id, created.version + 5), 412, 'VERSION_CONFLICT');
      expect(rowOf(created.id)).toBeDefined();
    });
  });

  describe('[Falha de banco]', () => {
    const down = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
    const failing: CatalogTransactions = {
      run: () => Promise.reject(down),
      read: () => Promise.reject(down),
    };
    const brokenApi = () =>
      createTestApi({
        providers: [
          { token: CATALOG_TRANSACTIONS, value: failing },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });

    it('banco indisponível ao cadastrar: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      silence();
      const broken = await brokenApi();
      try {
        const response = await request(broken.server)
          .post('/api/v1/holidays')
          .set('Authorization', broken.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send({ date: '2026-10-30', name: 'Sem banco', scope: 'MUNICIPAL' });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBeDefined();
        expect(broken.auditRecords().filter((r) => r.action === 'holiday.create')).toHaveLength(0);
        expect(broken.outboxRows()).toHaveLength(0);
      } finally {
        await broken.close();
      }
    });

    it('CAL-06 indisponível: 503 DEPENDENCY_UNAVAILABLE com Retry-After para quem calcula o prazo', async () => {
      silence();
      const broken = await brokenApi();
      try {
        const response = await request(broken.server)
          .post('/api/v1/calendar/add-business-days')
          .set('Authorization', broken.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send({ fromDateTime: '2026-10-02T15:00:00Z', businessDays: 3 });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBeDefined();
      } finally {
        await broken.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('CAL-06 repetido (retentativa da tramitação) devolve o mesmo prazo sem efeitos colaterais', async () => {
      silence();
      const audits = api.auditRecords().length;
      const events = api.outboxRows().length;
      const body = { fromDateTime: '2026-10-02T15:00:00Z', businessDays: 3 };

      const first = await addDays(body);
      const second = await addDays(body);

      expect(dataOf<AddBusinessDaysResult>(second)).toEqual(dataOf<AddBusinessDaysResult>(first));
      expect(api.auditRecords()).toHaveLength(audits);
      expect(api.outboxRows()).toHaveLength(events);
    });

    it('relay do outbox fora do ar: feriado criado (201) e evento gravado no outbox sem publicação', async () => {
      silence();
      const events = eventsOf().length;
      const response = await create({
        date: '2026-10-31',
        name: 'Com relay fora',
        scope: 'MUNICIPAL',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(eventsOf()).toHaveLength(events + 1);
    });
  });
});
