import type { JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { NotificationDispatcher } from './notification-dispatcher.js';
import { planNotification } from './notification-rules.js';
import type { NotificationPlan } from './notification-rules.js';
import { RecipientResolver } from './recipient-resolver.js';
import type { ProcessVisibility } from './recipient-resolver.js';
import {
  SqlStageDeadlineSource,
  formatTenantDate,
  formatTenantDateTime,
  stageDeadlineRecipients,
} from './stage-deadline.js';
import type { StageDeadlineSource, StageDeadlineType } from './stage-deadline.js';
import {
  FakeDirectory,
  MemoryNotificationStore,
  NO_SQL,
  TENANT,
  envelope,
  testId,
} from './testing.js';
import type { JobHandlerContext } from '../queues/run-job.js';

/*
 * US-114 — lembretes de prazo e alertas de atraso: `StageDeadlineRecipientResolver` (responsável
 * só, titular só, ambos, mesma pessoa, nenhum) e os cenários Gherkin no `NotificationDispatcher`
 * com portas em memória. O consumo real dos eventos do job `deadlines` sobre PostgreSQL fica em
 * `test/tenant-leak/stage-deadline-notifications.spec.ts`.
 */

const FABIO = testId();
const HELENA = testId();
const OBRAS = testId();
const SEM_TITULAR = testId();
const STAGE = testId();
const T0 = new Date('2026-10-19T15:00:00.000Z');
const DUE_AT = '2026-10-16T23:59:59.999-03:00';
const OVERDUE_SINCE = '2026-10-17T03:15:00.000Z';
const SYSTEM = { type: 'SYSTEM', userId: null, membershipId: null } as const;

function stageEvent(
  type: StageDeadlineType,
  overrides: { assigneeId?: string | null; departmentId?: string; processStageId?: string } = {},
) {
  const base = {
    processStageId: overrides.processStageId ?? STAGE,
    stageKey: 'analise_juridica',
    dueAt: DUE_AT,
    assigneeId: overrides.assigneeId === undefined ? FABIO : overrides.assigneeId,
    departmentId: overrides.departmentId ?? OBRAS,
  };
  return type === 'STAGE_OVERDUE'
    ? envelope(
        'ProcessStageOverdue',
        { ...base, overdueSince: OVERDUE_SINCE },
        { routingKey: 'process.stage_overdue', actor: SYSTEM },
      )
    : envelope(
        'ProcessStageDueSoon',
        { ...base, businessDaysLeft: 2 },
        { routingKey: 'process.stage_due_soon', actor: SYSTEM },
      );
}

function planOf(event: ReturnType<typeof stageEvent>): NotificationPlan {
  const outcome = planNotification(event);
  if (outcome.kind !== 'notify') throw new Error(`esperava notificar, veio ${outcome.kind}`);
  return outcome;
}

function directoryWith(head: string | null): FakeDirectory {
  const directory = new FakeDirectory();
  for (const userId of [FABIO, HELENA]) directory.active.add(userId);
  directory.heads.set(OBRAS, { headUserId: head, deputyUserId: testId() });
  directory.heads.set(SEM_TITULAR, { headUserId: null, deputyUserId: null });
  return directory;
}

const seeAll: ProcessVisibility = {
  visibleTo: (_client, _processId, userIds) => Promise.resolve(new Set(userIds)),
};

async function recipientsOf(
  type: StageDeadlineType,
  options: { assigneeId?: string | null; departmentId?: string; head?: string | null } = {},
): Promise<readonly string[]> {
  const resolver = new RecipientResolver({
    directory: directoryWith(options.head === undefined ? HELENA : options.head),
    visibility: seeAll,
  });
  const event = stageEvent(type, options);
  const { recipients } = await resolver.resolve(NO_SQL, planOf(event), event, T0);
  return recipients;
}

describe('StageDeadlineRecipientResolver (RN-NTF-27..29)', () => {
  it('especificações: a vencer = responsável OU titular; atraso = responsável E titular', () => {
    const parties = { assigneeId: FABIO, departmentId: OBRAS };
    const head = { kind: 'DEPARTMENT_HEADS', departmentId: OBRAS, includeDeputy: false };
    expect(stageDeadlineRecipients('STAGE_DUE_SOON', parties)).toEqual([
      { kind: 'FIRST_OF', specs: [{ kind: 'USER', userId: FABIO }, head] },
    ]);
    expect(stageDeadlineRecipients('STAGE_OVERDUE', parties)).toEqual([
      { kind: 'USER', userId: FABIO },
      head,
    ]);
  });

  it('só o responsável: a vencer vai a ele (o titular não entra); sem titular, o atraso também', async () => {
    expect(await recipientsOf('STAGE_DUE_SOON')).toEqual([FABIO]);
    expect(await recipientsOf('STAGE_OVERDUE', { head: null })).toEqual([FABIO]);
  });

  it('só o titular: sem responsável individual, os dois avisos vão ao titular', async () => {
    expect(await recipientsOf('STAGE_DUE_SOON', { assigneeId: null })).toEqual([HELENA]);
    expect(await recipientsOf('STAGE_OVERDUE', { assigneeId: null })).toEqual([HELENA]);
  });

  it('ambos: o atraso escala ao titular sem depender da ausência de responsável', async () => {
    expect(await recipientsOf('STAGE_OVERDUE')).toEqual([FABIO, HELENA].sort());
  });

  it('mesma pessoa (RN-NTF-28): responsável = titular resolve um destinatário só', async () => {
    expect(await recipientsOf('STAGE_OVERDUE', { head: FABIO })).toEqual([FABIO]);
    expect(await recipientsOf('STAGE_DUE_SOON', { head: FABIO })).toEqual([FABIO]);
  });

  it('nenhum resolvível (RN-NTF-29): sem responsável e unidade sem titular, ninguém', async () => {
    for (const type of ['STAGE_DUE_SOON', 'STAGE_OVERDUE'] as const) {
      expect(await recipientsOf(type, { assigneeId: null, departmentId: SEM_TITULAR })).toEqual([]);
      // Unidade inexistente ou inativa (V-01) também não resolve ninguém.
      expect(await recipientsOf(type, { assigneeId: null, departmentId: testId() })).toEqual([]);
    }
  });
});

describe('datas no fuso do tenant (DEC-003 · RN-NTF-32)', () => {
  it('formata dia e dia com hora; entrada ausente ou inválida = nulo', () => {
    expect(formatTenantDate(DUE_AT, 'America/Sao_Paulo')).toBe('16/10/2026');
    expect(formatTenantDate(DUE_AT, 'UTC')).toBe('17/10/2026');
    expect(formatTenantDateTime(OVERDUE_SINCE, 'America/Sao_Paulo')).toBe('17/10/2026 às 00:15');
    expect(formatTenantDateTime(OVERDUE_SINCE, 'America/Manaus')).toBe('16/10/2026 às 23:15');
    expect(formatTenantDate(null, 'UTC')).toBeNull();
    expect(formatTenantDate('ontem', 'UTC')).toBeNull();
    expect(formatTenantDateTime(null, 'UTC')).toBeNull();
  });
});

describe('SqlStageDeadlineSource', () => {
  it('lê o nome da etapa e o fuso do tenant; sem linha, nome nulo e fuso padrão', async () => {
    const queries: unknown[][] = [];
    const client = (rows: Record<string, unknown[]>): SqlClient => ({
      query: (sql: string, params?: unknown[]) => {
        queries.push(params ?? []);
        const key = sql.includes('FROM tenants') ? 'tenant' : 'stage';
        return Promise.resolve({ rows: rows[key] ?? [] }) as never;
      },
    });
    const source = new SqlStageDeadlineSource();
    expect(
      await source.details(
        client({
          stage: [{ stage_name: 'Análise jurídica' }],
          tenant: [{ timezone: 'America/Manaus' }],
        }),
        TENANT,
        STAGE,
      ),
    ).toEqual({ stageName: 'Análise jurídica', timezone: 'America/Manaus' });
    expect(queries[0]).toEqual([STAGE, TENANT]);
    expect(await source.details(client({}), TENANT, STAGE)).toEqual({
      stageName: null,
      timezone: 'America/Sao_Paulo',
    });
  });
});

function setup(
  options: {
    readonly head?: string | null;
    readonly visibility?: ProcessVisibility;
    readonly failTransaction?: Error;
    readonly failEmail?: () => boolean;
    readonly stageName?: string | null;
    readonly withoutSource?: boolean;
  } = {},
) {
  const directory = directoryWith(options.head === undefined ? HELENA : options.head);
  const store = new MemoryNotificationStore();
  const emails: string[] = [];
  const stageDeadlines: StageDeadlineSource = {
    details: () =>
      Promise.resolve({
        stageName: options.stageName === undefined ? 'Análise jurídica' : options.stageName,
        timezone: 'America/Sao_Paulo',
      }),
  };
  const dispatcher = new NotificationDispatcher({
    directory,
    store,
    visibility: options.visibility ?? seeAll,
    ...(options.withoutSource ? {} : { stageDeadlines }),
    email: {
      enqueue: (notificationId) => {
        if (options.failEmail?.()) {
          return Promise.reject(
            Object.assign(new Error('fila email fora'), { code: 'ECONNREFUSED' }),
          );
        }
        emails.push(notificationId);
        return Promise.resolve();
      },
    },
    now: () => T0,
  });
  const logger = new Logger('test');
  const logs = {
    log: vi.spyOn(logger, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(logger, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(logger, 'error').mockImplementation(() => undefined),
  };
  const meta: JobMeta = {
    schemaVersion: 1,
    tenantId: TENANT,
    actor: SYSTEM,
    correlationId: 'corr-ntf-1',
    causationId: null,
    enqueuedAt: T0.toISOString(),
  };
  const context = {
    meta,
    logger,
    tenantTransaction: <T>(work: (client: SqlClient) => Promise<T>): Promise<T> =>
      options.failTransaction ? Promise.reject(options.failTransaction) : work(NO_SQL),
  } as unknown as JobHandlerContext;
  const handle = (event: ReturnType<typeof stageEvent>) =>
    dispatcher.handle({ envelope: event }, context);
  return { handle, store, emails, logs };
}

describe('NotificationDispatcher — STAGE_DUE_SOON/STAGE_OVERDUE (Gherkin da US-114)', () => {
  it('[Sucesso] atraso notifica responsável e titular, in-app e e-mail, com etapa e datas', async () => {
    const { handle, store, emails, logs } = setup();
    await expect(handle(stageEvent('STAGE_OVERDUE'))).resolves.toBe('completed');
    expect(store.rows.map((row) => [row.recipientId, row.type, row.emailStatus])).toEqual(
      [FABIO, HELENA].sort().map((userId) => [userId, 'STAGE_OVERDUE', 'PENDING']),
    );
    expect(emails).toEqual(store.rows.map((row) => row.id));
    expect(store.rows[0]).toMatchObject({
      title: 'Prazo da etapa vencido',
      body: 'O prazo da etapa “Análise jurídica” terminou em 16/10/2026; o atraso foi registrado em 17/10/2026 às 00:15. Abra o processo para regularizar.',
    });
    expect(logs.log).toHaveBeenCalledWith({
      event: 'notification.deadline_escalated',
      processStageId: STAGE,
      notificationType: 'STAGE_OVERDUE',
      recipientCount: 2,
      correlationId: 'corr-ntf-1',
    });
  });

  it('[Sucesso] vencimento próximo: só o responsável, sem e-mail por padrão (RN-NTF-30)', async () => {
    const { handle, store, emails } = setup();
    await expect(handle(stageEvent('STAGE_DUE_SOON'))).resolves.toBe('completed');
    expect(store.rows).toEqual([
      expect.objectContaining({
        recipientId: FABIO,
        type: 'STAGE_DUE_SOON',
        emailStatus: 'NOT_APPLICABLE',
        title: 'Prazo da etapa perto do fim',
        body: 'O prazo da etapa “Análise jurídica” termina em 16/10/2026. Abra o processo para dar andamento.',
      }),
    ]);
    expect(emails).toEqual([]);
  });

  it('[Validação] sem responsável e unidade sem titular: nada criado, warn deadline_recipient_missing', async () => {
    const { handle, store, logs } = setup();
    await expect(
      handle(stageEvent('STAGE_OVERDUE', { assigneeId: null, departmentId: SEM_TITULAR })),
    ).resolves.toBe('skipped');
    expect(store.rows).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith({
      event: 'notification.deadline_recipient_missing',
      processStageId: STAGE,
      notificationType: 'STAGE_OVERDUE',
      reasons: ['NO_RECIPIENT'],
      correlationId: 'corr-ntf-1',
    });
    expect(logs.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notification.deadline_escalated' }),
    );
  });

  it('[Permissão] responsável sem visibilidade do processo não recebe; o titular recebe', async () => {
    const { handle, store } = setup({
      visibility: {
        visibleTo: (_client, _processId, userIds) =>
          Promise.resolve(new Set(userIds.filter((userId) => userId !== FABIO))),
      },
    });
    await expect(handle(stageEvent('STAGE_OVERDUE'))).resolves.toBe('completed');
    expect(store.rows.map((row) => row.recipientId)).toEqual([HELENA]);
  });

  it('[Duplicidade] reentrega do mesmo evento não cria outra notificação (RN-NTF-31)', async () => {
    const { handle, store, emails } = setup();
    const event = stageEvent('STAGE_OVERDUE');
    await handle(event);
    await handle(event);
    expect(store.rows).toHaveLength(2);
    // A reentrega reenfileira o e-mail ainda PENDING (o jobId = notificationId deduplica na fila).
    expect(new Set(emails).size).toBe(2);
  });

  it('[Concorrência] responsável = titular: uma notificação só; a vencer e o atraso não se confundem', async () => {
    const { handle, store } = setup({ head: FABIO });
    await handle(stageEvent('STAGE_DUE_SOON'));
    await handle(stageEvent('STAGE_OVERDUE'));
    expect(store.rows.map((row) => [row.recipientId, row.type])).toEqual([
      [FABIO, 'STAGE_DUE_SOON'],
      [FABIO, 'STAGE_OVERDUE'],
    ]);
  });

  it('[Falha de banco] a transação falha: erro relançado para o retry da fila, nada gravado', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { handle, store, emails, logs } = setup({ failTransaction: down });
    await expect(handle(stageEvent('STAGE_OVERDUE'))).rejects.toBe(down);
    expect(store.rows).toEqual([]);
    expect(emails).toEqual([]);
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.dispatch_failed',
        notificationType: 'STAGE_OVERDUE',
        errorCode: 'ECONNREFUSED',
      }),
    );
  });

  it('[Falha de integração] fila de e-mail fora: in-app criada e e-mail PENDING até a reentrega', async () => {
    let emailDown = true;
    const { handle, store, emails } = setup({ failEmail: () => emailDown });
    const event = stageEvent('STAGE_OVERDUE', { assigneeId: null });
    await expect(handle(event)).rejects.toThrow('fila email fora');
    expect(store.rows).toEqual([
      expect.objectContaining({ recipientId: HELENA, emailStatus: 'PENDING' }),
    ]);
    emailDown = false;
    await expect(handle(event)).resolves.toBe('completed');
    expect(store.rows).toHaveLength(1);
    expect(emails).toEqual([store.rows[0]?.id]);
  });

  it('[V-03] passagem não encontrada no tenant: log error e texto genérico, sem deixar de avisar', async () => {
    const { handle, store, logs } = setup({ stageName: null });
    await handle(stageEvent('STAGE_DUE_SOON'));
    expect(logs.error).toHaveBeenCalledWith({
      event: 'notification.deadline_stage_missing',
      processStageId: STAGE,
      notificationType: 'STAGE_DUE_SOON',
    });
    expect(store.rows[0]?.body).toBe(
      'O prazo de uma etapa termina em 16/10/2026. Abra o processo para dar andamento.',
    );
  });

  it('agrupa atrasos do mesmo processo em 5 min com texto de contagem; sem fonte, texto genérico', async () => {
    const { handle, store } = setup();
    await handle(stageEvent('STAGE_OVERDUE', { assigneeId: null }));
    await handle(stageEvent('STAGE_OVERDUE', { assigneeId: null, processStageId: testId() }));
    expect(store.rows).toEqual([
      expect.objectContaining({
        recipientId: HELENA,
        body: 'Há 2 etapas com prazo vencido neste processo.',
      }),
    ]);
    const generic = setup({ withoutSource: true });
    await generic.handle(stageEvent('STAGE_DUE_SOON'));
    expect(generic.store.rows[0]?.body).toBe(
      'O prazo de uma etapa termina. Abra o processo para dar andamento.',
    );
  });
});
