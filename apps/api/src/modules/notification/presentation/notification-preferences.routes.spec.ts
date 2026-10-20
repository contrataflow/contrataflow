import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  defaultChannelEnabled,
} from '@contrataflow/types';
import { notificationPreferenceSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { NotificationPreferenceDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { NOTIFICATION_TRANSACTIONS } from '../application/notification-ports.js';
import type { NotificationTransactions } from '../application/notification-ports.js';

/*
 * US-113 — ME-05/ME-06 (`GET`/`PUT /me/notification-preferences`) pelo pipeline HTTP completo com a
 * identidade fake, as preferências em memória e a auditoria real do `AuditService`. O mesmo fluxo
 * contra o PostgreSQL (RLS, GRANTs, UNIQUE sob concorrência) está em
 * `test/tenant-leak/notification-preferences.spec.ts`.
 *
 * Elenco do Gherkin: Elisa = Ana (vínculo ativo na Prefeitura A); Fábio tem vínculo em A e em B;
 * Marta administra as configurações de A (`SETTINGS_MANAGE`, para desligar o e-mail do tenant).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const ELISA = FAKE_USERS.ana;
const OUTRA = FAKE_USERS.otavio;
const FABIO = FAKE_USERS.fabio;
const SUSPENSO = FAKE_USERS.bruno;
const ADMIN = FAKE_USERS.marta;
const MFA = ['pwd', 'otp'];

interface Subject {
  subject: string;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const dataOf = (response: request.Response): NotificationPreferenceDto[] =>
  ((response.body as { data?: unknown[] }).data ?? []).map((item) =>
    notificationPreferenceSchema.parse(item),
  );
const metaOf = (response: request.Response) =>
  (response.body as { meta: { emailEnabled: boolean } }).meta;
const valueOf = (list: readonly NotificationPreferenceDto[], type: string, channel: string) =>
  list.find((item) => item.notificationType === type && item.channel === channel);

describe('Feature: Preferências de notificação (US-113)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi();
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

  const as = (test: request.Test, user: Subject, tenant: string, amr: string[] = ['pwd']) =>
    test.set('Authorization', api.bearer(user.subject, { amr })).set('X-Tenant-Id', tenant);
  const get = (user: Subject = ELISA, tenant: string = A) =>
    as(request(api.server).get('/api/v1/me/notification-preferences'), user, tenant);
  const put = (body: unknown, user: Subject = ELISA, tenant: string = A) =>
    as(request(api.server).put('/api/v1/me/notification-preferences'), user, tenant).send(
      body as object,
    );
  const set = (
    notificationType: string,
    channel: string,
    enabled: boolean | null,
    user: Subject = ELISA,
    tenant: string = A,
  ) => put({ preferences: [{ notificationType, channel, enabled }] }, user, tenant);
  const auditOf = () =>
    api.auditRecords().filter((record) => record.action === 'notification.preferences_update');

  describe('[Sucesso] ME-05 — primeira visita (FA-03)', () => {
    it('lista toda combinação tipo × canal com o padrão do registro e a trava dos obrigatórios', async () => {
      const response = await get(OUTRA);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const list = dataOf(response);
      expect(list).toHaveLength(NOTIFICATION_TYPES.length * NOTIFICATION_CHANNELS.length);
      for (const item of list) {
        const locked =
          item.channel === 'IN_APP' &&
          ['APPROVAL_REQUESTED', 'ATTACHMENT_REJECTED', 'ROLE_CHANGED'].includes(
            item.notificationType,
          );
        expect(item.enabled, `${item.notificationType}/${item.channel}`).toBe(
          defaultChannelEnabled(item.notificationType, item.channel),
        );
        expect(item.editable).toBe(!locked);
      }
      expect(metaOf(response)).toEqual({ emailEnabled: true });
    });
  });

  describe('[Sucesso] Desativar e-mail de um tipo não obrigatório', () => {
    it('grava a preferência, devolve o estado novo e audita notification.preferences_update (RN-NTF-26)', async () => {
      silence();
      const before = auditOf().length;
      const response = await set('PROCESS_RECEIVED', 'EMAIL', false);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(valueOf(dataOf(response), 'PROCESS_RECEIVED', 'EMAIL')).toMatchObject({
        enabled: false,
        editable: true,
      });
      // As demais combinações seguem o padrão (merge — RN-NTF-25).
      expect(valueOf(dataOf(response), 'PROCESS_RETURNED', 'EMAIL')?.enabled).toBe(true);
      // A leitura seguinte reflete a escolha.
      expect(valueOf(dataOf(await get()), 'PROCESS_RECEIVED', 'EMAIL')?.enabled).toBe(false);

      const records = auditOf();
      expect(records).toHaveLength(before + 1);
      expect(records.at(-1)).toMatchObject({
        action: 'notification.preferences_update',
        category: 'SECURITY',
        entityId: ELISA.id,
        changes: [{ path: 'preferences.PROCESS_RECEIVED.EMAIL', old: null, new: false }],
        metadata: { changedCount: 1, requestedCount: 1 },
      });
    });

    it('o e-mail de um tipo que já era padrão desligado também fica gravado (COMMENT_REPLY)', async () => {
      silence();
      const response = await set('COMMENT_REPLY', 'EMAIL', false);
      expect(response.status).toBe(200);
      expect(auditOf().at(-1)?.changes).toEqual([
        { path: 'preferences.COMMENT_REPLY.EMAIL', old: null, new: false },
      ]);
    });
  });

  describe('[Duplicidade] Reenvio do mesmo PUT é idempotente', () => {
    it('responde 200 sem nova linha nem nova auditoria', async () => {
      silence();
      await set('MENTIONED', 'EMAIL', false);
      const audits = auditOf().length;
      const again = await set('MENTIONED', 'EMAIL', false);
      expect(again.status).toBe(200);
      expect(dataOf(again).filter((i) => i.notificationType === 'MENTIONED')).toHaveLength(2);
      expect(valueOf(dataOf(again), 'MENTIONED', 'EMAIL')?.enabled).toBe(false);
      expect(auditOf()).toHaveLength(audits);
    });
  });

  describe('[Sucesso] FA-01 — usar padrão', () => {
    it('enabled nulo remove a preferência e volta ao padrão do registro', async () => {
      silence();
      await set('PARTICIPANT_ADDED', 'EMAIL', false);
      const reset = await set('PARTICIPANT_ADDED', 'EMAIL', null);
      expect(reset.status).toBe(200);
      expect(valueOf(dataOf(reset), 'PARTICIPANT_ADDED', 'EMAIL')?.enabled).toBe(true);
      expect(auditOf().at(-1)?.changes).toEqual([
        { path: 'preferences.PARTICIPANT_ADDED.EMAIL', old: false, new: null },
      ]);
    });
  });

  describe('[Concorrência] Duas alterações simultâneas em tipos diferentes (RN-NTF-25)', () => {
    it('as duas preferências ficam salvas', async () => {
      silence();
      const [one, two] = await Promise.all([
        set('STAGE_OVERDUE', 'EMAIL', false, FABIO),
        set('APPROVAL_REASSIGNED', 'EMAIL', false, FABIO),
      ]);
      expect([one.status, two.status]).toEqual([200, 200]);
      const list = dataOf(await get(FABIO));
      expect(valueOf(list, 'STAGE_OVERDUE', 'EMAIL')?.enabled).toBe(false);
      expect(valueOf(list, 'APPROVAL_REASSIGNED', 'EMAIL')?.enabled).toBe(false);
    });
  });

  describe('[Validação]', () => {
    it('tipo fora do registro → 422 VALIDATION_ERROR (INVALID_ENUM) "Tipo de notificação inválido."', async () => {
      const response = await set('TIPO_INEXISTENTE', 'EMAIL', false);
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        expect.objectContaining({
          field: 'preferences[0].notificationType',
          code: 'INVALID_ENUM',
          message: 'Tipo de notificação inválido.',
        }),
      ]);
    });

    it('canal fora do enum → 422 INVALID_ENUM', async () => {
      const response = await set('COMMENT_REPLY', 'SMS', false);
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({
        field: 'preferences[0].channel',
        code: 'INVALID_ENUM',
      });
    });

    it.each([
      ['corpo vazio', {}],
      ['lista vazia', { preferences: [] }],
      [
        'userId no corpo',
        {
          preferences: [{ notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: true }],
          userId: 'x',
        },
      ],
      [
        'enabled que não é booleano',
        { preferences: [{ notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: 'sim' }] },
      ],
    ])('%s → 422 VALIDATION_ERROR', async (_name, body) => {
      expectProblem(await put(body), 422, 'VALIDATION_ERROR');
    });

    it('combinação repetida → 422 DUPLICATE_IN_LIST', async () => {
      const problem = expectProblem(
        await put({
          preferences: [
            { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: true },
            { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: false },
          ],
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors[0]).toMatchObject({ code: 'DUPLICATE_IN_LIST' });
    });
  });

  describe('[Permissão] Tentativa de desligar canal obrigatório (RN-NTF-23)', () => {
    it.each(['APPROVAL_REQUESTED', 'ATTACHMENT_REJECTED', 'ROLE_CHANGED'])(
      '%s IN_APP desligado → 422 NOT_ALLOWED, sem alterar nada nem auditar',
      async (type) => {
        silence();
        const audits = auditOf().length;
        const response = await put({
          preferences: [
            { notificationType: 'DOCUMENT_RENDER_FAILED', channel: 'EMAIL', enabled: true },
            { notificationType: type, channel: 'IN_APP', enabled: false },
          ],
        });
        const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
        expect(problem.errors).toEqual([
          expect.objectContaining({
            field: 'preferences[1].enabled',
            code: 'NOT_ALLOWED',
            message: 'Este aviso não pode ser desligado.',
          }),
        ]);
        // Tudo ou nada: o item válido do mesmo corpo também não foi gravado.
        const list = dataOf(await get());
        expect(valueOf(list, 'DOCUMENT_RENDER_FAILED', 'EMAIL')?.enabled).toBe(false);
        expect(valueOf(list, type, 'IN_APP')).toMatchObject({ enabled: true, editable: false });
        expect(auditOf()).toHaveLength(audits);
      },
    );

    it('o e-mail de um tipo obrigatório pode ser desligado', async () => {
      silence();
      const response = await set('APPROVAL_REQUESTED', 'EMAIL', false);
      expect(response.status).toBe(200);
      expect(valueOf(dataOf(response), 'APPROVAL_REQUESTED', 'EMAIL')?.enabled).toBe(false);
    });
  });

  describe('[Tenant incorreto] Preferências isoladas por tenant e por usuário', () => {
    it('desligar o e-mail em A não altera o vínculo de Fábio em B nem outro usuário de A', async () => {
      silence();
      expect((await set('PROCESS_ASSIGNED', 'EMAIL', false, FABIO, A)).status).toBe(200);
      expect(valueOf(dataOf(await get(FABIO, A)), 'PROCESS_ASSIGNED', 'EMAIL')?.enabled).toBe(
        false,
      );
      expect(valueOf(dataOf(await get(FABIO, B)), 'PROCESS_ASSIGNED', 'EMAIL')?.enabled).toBe(true);
      expect(valueOf(dataOf(await get(OUTRA, A)), 'PROCESS_ASSIGNED', 'EMAIL')?.enabled).toBe(true);
    });

    it('sem vínculo ativo no tenant informado → 403', async () => {
      const response = await get(OUTRA, B);
      expect(response.status).toBe(403);
    });
  });

  describe('[Permissão] autenticação e vínculo', () => {
    it('sem autenticação → 401 UNAUTHENTICATED', async () => {
      const response = await request(api.server)
        .get('/api/v1/me/notification-preferences')
        .set('X-Tenant-Id', A);
      expectProblem(response, 401, 'UNAUTHENTICATED');
    });

    it('vínculo suspenso → 403 MEMBERSHIP_INACTIVE', async () => {
      expectProblem(await get(SUSPENSO), 403, 'MEMBERSHIP_INACTIVE');
    });
  });

  describe('[Falha de banco] banco indisponível ao salvar', () => {
    it('responde 503 DEPENDENCY_UNAVAILABLE e nada é alterado', async () => {
      silence();
      const failing: NotificationTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      };
      const down = await createTestApi({
        providers: [{ token: NOTIFICATION_TRANSACTIONS, value: failing }],
      });
      try {
        const response = await request(down.server)
          .put('/api/v1/me/notification-preferences')
          .set('Authorization', down.bearer(ELISA.subject, { amr: ['pwd'] }))
          .set('X-Tenant-Id', A)
          .send({
            preferences: [{ notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: true }],
          });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(
          down.auditRecords().filter((r) => r.action === 'notification.preferences_update'),
        ).toEqual([]);
      } finally {
        await down.close();
      }
    });
  });

  describe('[Sucesso] RN-NTF-24 — e-mail desligado no tenant', () => {
    it('meta.emailEnabled passa a false e a preferência segue sendo gravável', async () => {
      silence();
      const off = await as(request(api.server).patch('/api/v1/settings'), ADMIN, A, MFA).send({
        values: { 'notifications.emailEnabled': false },
        expectedVersions: { 'notifications.emailEnabled': 0 },
      });
      expect(off.status, JSON.stringify(off.body)).toBe(200);

      const response = await get();
      expect(metaOf(response)).toEqual({ emailEnabled: false });
      const saved = await set('MENTIONED', 'EMAIL', true);
      expect(saved.status).toBe(200);
      expect(metaOf(saved)).toEqual({ emailEnabled: false });
    });
  });
});
