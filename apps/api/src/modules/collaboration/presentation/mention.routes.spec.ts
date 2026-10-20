import { randomUUID } from 'node:crypto';

import {
  COMMENT_MESSAGES,
  commentSchema,
  mentionCandidateSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { CommentDto, MentionCandidateDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedActiveMember,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { COMMENT_CLOCK, COMMENT_TRANSACTIONS } from '../application/ports.js';
import type { CommentTransactions } from '../application/ports.js';
import { InMemoryMentionRepository } from '../infrastructure/in-memory-mention.repository.js';

/*
 * US-072 — mencionar usuários e unidades: CMT-05 (candidatos) e o nó `mention` de CMT-02/CMT-03
 * pelo pipeline HTTP completo, com a identidade fake e os seeders reais. As 8 categorias do
 * Gherkin + FA-02/03/04 e o limite de 10. Personas: "Marcos" = Ana (REQUISITANTE, lotada no Setor de
 * Manutenção — unidade solicitante); "Cláudia" = Lúcia (LICITACOES com escopo TENANT, vê o
 * processo); "Tatiane" = Otávio (SOMENTE_LEITURA); Eva (vínculo ativo, sem perfil — não vê o
 * processo); "Roberto" = Heitor (só no tenant B). A entrega de `MENTIONED` (in-app/e-mail, sem o
 * autor, membros da unidade) é do `NotificationDispatcher`: apps/worker. RLS e FKs compostas de
 * `mentions` no PostgreSQL: test/tenant-leak/mentions.spec.ts.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-18T12:00:00.000Z');
const MARCOS = 'sub-ana';
const TATIANE = 'sub-otavio';
const CLAUDIA_ID = FAKE_USERS.lucia.id;
const MARCOS_ID = FAKE_USERS.ana.id;

const UNITS_A = {
  organizationId: '0192d072-0000-7000-8000-0000000000a0',
  obras: '0192d072-0000-7000-8000-0000000000a1',
  manutencao: '0192d072-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d072-0000-7000-8000-0000000000a3',
  saude: '0192d072-0000-7000-8000-0000000000a4',
  posto: '0192d072-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d072-0000-7000-8000-0000000000b0',
  obras: '0192d072-0000-7000-8000-0000000000b1',
  manutencao: '0192d072-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d072-0000-7000-8000-0000000000b3',
  saude: '0192d072-0000-7000-8000-0000000000b4',
  posto: '0192d072-0000-7000-8000-0000000000b5',
};

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

const membershipOf = (userId: string, tenantId: string = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** UUIDv7 determinístico para os membros semeados (`kind` 1 = usuário, 2 = vínculo). */
const seededId = (prefix: string, kind: 1 | 2, index: number) =>
  `0192d072-${prefix}-7${String(kind)}00-8000-${String(index).padStart(12, '0')}`;

class FlakyTransactions implements CommentTransactions {
  down = false;
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    const next = this.queue.then(() => runSimulatedTransaction(work));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function data<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const mention = (kind: 'USER' | 'DEPARTMENT', id: string, label: string) => ({
  type: 'mention',
  attrs: { kind, id, label },
});

/** `body` com texto e menções num parágrafo. */
const withMentions = (text: string, ...mentions: unknown[]) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }, ...mentions] }],
});

describe('Feature: Mencionar usuários e unidades (US-072)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string };
  let roles: Map<string, { id: string }>;
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = MARCOS, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const candidates = (processId: string, q: string | null, subject = MARCOS) =>
    auth(
      request(api.server).get(
        `/api/v1/processes/${processId}/mention-candidates${q === null ? '' : `?q=${encodeURIComponent(q)}`}`,
      ),
      subject,
    );
  const post = (processId: string, body: unknown, subject = MARCOS) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/comments`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({ body, targetType: 'PROCESS' });
  const patch = (commentId: string, body: unknown, ifMatch = '"1"') =>
    auth(request(api.server).patch(`/api/v1/comments/${commentId}`))
      .set('If-Match', ifMatch)
      .send({ body });

  const mentionsOf = (commentId: string) =>
    api.app
      .get(InMemoryMentionRepository, { strict: false })
      .snapshot()
      .filter((row) => row.commentId === commentId);
  const mentionEvents = (processId: string) =>
    api
      .outboxRows()
      .filter((row) => row.processId === processId && row.eventType === 'UserMentioned');
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const candidatesOf = (response: request.Response) =>
    z.array(mentionCandidateSchema).parse(data<MentionCandidateDto[]>(response));

  async function processWith(fields: Partial<Process> = {}): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição ${words(2)}`,
        object: `Objeto da contratação ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    const process: Process = { ...created, status: 'IN_PROGRESS', ...fields };
    processRepositoryOf(api).replace(process);
    return process;
  }

  async function createOk(processId: string, body: unknown, subject = MARCOS) {
    const response = await post(processId, body, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return commentSchema.parse(data<CommentDto>(response));
  }

  /** Membros ativos semeados, lotados na unidade e, se pedido, com LICITACOES (escopo TENANT). */
  function seedMembers(
    prefix: string,
    count: number,
    options: { departmentId?: string; name?: string; seeing?: boolean },
  ): string[] {
    return Array.from({ length: count }, (_, index) => {
      const userId = seededId(prefix, 1, index + 1);
      const membershipId = seededId(prefix, 2, index + 1);
      seedActiveMember(
        api,
        {
          id: userId,
          name: `${options.name ?? 'Servidor'} ${String(index + 1).padStart(2, '0')}`,
          email: `${prefix}${String(index)}@prefeitura-a.test`,
        },
        { id: membershipId, tenantId: A },
      );
      if (options.departmentId) assignDepartment(api, membershipId, options.departmentId);
      if (options.seeing) {
        assignRole(api, { tenantId: A, membershipId, roleId: roles.get('LICITACOES')?.id ?? '' });
      }
      return userId;
    });
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: COMMENT_TRANSACTIONS, value: transactions },
        { token: COMMENT_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), UNITS_A.saude);
    roles = seedDefaultRolesOf(api, A);
    const rolesB = seedDefaultRolesOf(api, B);
    const grant = (userId: string, key: string, tenantId: string = A) => {
      assignRole(api, {
        tenantId,
        membershipId: membershipOf(userId, tenantId),
        roleId: (tenantId === A ? roles : rolesB).get(key)?.id ?? '',
      });
    };
    grant(FAKE_USERS.lucia.id, 'LICITACOES');
    grant(FAKE_USERS.otavio.id, 'SOMENTE_LEITURA');
    grant(FAKE_USERS.marta.id, 'GESTOR_CONTRATACOES');
    grant(FAKE_USERS.heitor.id, 'LICITACOES', B);
    // "Setor de Manutenção" com 12 membros ativos (Ana + 11); "Setor de Pavimentação" com 51.
    seedMembers('0a01', 11, { departmentId: UNITS_A.manutencao, name: 'Técnico' });
    seedMembers('0a02', 51, { departmentId: UNITS_A.pavimentacao, name: 'Operário' });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  describe('[Sucesso]', () => {
    it('Mencionar um usuário com visibilidade: CMT-05 sugere, 201 com mentions[], Mention, UserMentioned e auditoria só com ids', async () => {
      const process = await processWith();
      const found = await candidates(process.id, 'lúc');
      expect(found.status, JSON.stringify(found.body)).toBe(200);
      expect(found.headers['cache-control']).toBe('no-store');
      const [claudia] = candidatesOf(found);
      expect(claudia).toEqual({
        kind: 'USER',
        id: CLAUDIA_ID,
        label: 'Lúcia Matos',
        secondaryLabel: 'Secretaria de Saúde',
      });

      const created = await createOk(
        process.id,
        withMentions('Pode revisar, ', mention('USER', CLAUDIA_ID, 'Lúcia Matos')),
      );
      const [stored] = mentionsOf(created.id);
      expect(mentionsOf(created.id)).toHaveLength(1);
      expect(stored).toMatchObject({
        processId: process.id,
        mentionedUserId: CLAUDIA_ID,
        mentionedDepartmentId: null,
        notifiedAt: null,
      });
      expect(created.mentions).toEqual([{ id: stored?.id, kind: 'USER', targetId: CLAUDIA_ID }]);
      expect(created.body).toMatchObject(
        withMentions('Pode revisar, ', mention('USER', CLAUDIA_ID, 'Lúcia Matos')),
      );

      expect(mentionEvents(process.id)).toEqual([
        expect.objectContaining({
          routingKey: 'comment.user_mentioned',
          aggregateId: created.id,
          payload: {
            commentId: created.id,
            mentionId: stored?.id,
            mentionedUserId: CLAUDIA_ID,
            mentionedDepartmentId: null,
          },
        }),
      ]);
      // RN-CMT-25: a menção não gera entrada própria na timeline (só o COMMENT_ADDED).
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.entityId === created.id,
        ),
      ).toHaveLength(1);
      expect(auditOf(process.id, 'comment.create').at(-1)?.metadata).toMatchObject({
        mentionedUserIds: [CLAUDIA_ID],
        mentionedDepartmentIds: [],
      });
      // Logs sem nome nem e-mail do mencionado.
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('mention.created');
      expect(logged).not.toContain('Lúcia');

      // A lista (CMT-01) devolve as mesmas menções.
      const listed = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/comments`),
      );
      expect((listed.body as { data: CommentDto[] }).data[0]?.mentions).toEqual(created.mentions);
    });

    it('Mencionar uma unidade com até 50 membros: um único Mention com mentionedDepartmentId', async () => {
      const process = await processWith();
      const found = candidatesOf(await candidates(process.id, 'manuten'));
      expect(found).toContainEqual({
        kind: 'DEPARTMENT',
        id: UNITS_A.manutencao,
        label: 'Setor de Manutenção',
      });
      const created = await createOk(
        process.id,
        withMentions('Equipe, ', mention('DEPARTMENT', UNITS_A.manutencao, 'Setor de Manutenção')),
      );
      expect(mentionsOf(created.id)).toEqual([
        expect.objectContaining({
          mentionedUserId: null,
          mentionedDepartmentId: UNITS_A.manutencao,
        }),
      ]);
      expect(mentionEvents(process.id).map((row) => row.payload)).toEqual([
        expect.objectContaining({
          mentionedUserId: null,
          mentionedDepartmentId: UNITS_A.manutencao,
        }),
      ]);
      expect(created.mentions).toEqual([
        expect.objectContaining({ kind: 'DEPARTMENT', targetId: UNITS_A.manutencao }),
      ]);
    });

    it('CMT-05 devolve no máximo 10 candidatos, em ordem alfabética', async () => {
      const process = await processWith();
      seedMembers('0a03', 12, { name: 'Analista', seeing: true });
      const found = candidatesOf(await candidates(process.id, 'analista'));
      expect(found).toHaveLength(10);
      expect(found.map((item) => item.label)).toEqual(
        Array.from({ length: 10 }, (_, index) => `Analista ${String(index + 1).padStart(2, '0')}`),
      );
    });
  });

  describe('[Validação]', () => {
    it('Nó de menção sem o atributo "id": 422 RICH_TEXT_INVALID e nenhum comentário criado', async () => {
      const process = await processWith();
      const response = await post(process.id, {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'mention', attrs: { kind: 'USER', label: 'Lúcia Matos' } }],
          },
        ],
      });
      const problem = expectProblem(response, 422, 'RICH_TEXT_INVALID');
      expect(problem.detail).toBe(COMMENT_MESSAGES.mentionInvalid);
      expect(
        api
          .outboxRows()
          .filter((row) => row.processId === process.id && row.eventType.startsWith('Comment')),
      ).toEqual([]);
    });

    it('V-02: CMT-05 sem q (ou só espaços) → 422 VALIDATION_ERROR', async () => {
      const process = await processWith();
      expectProblem(await candidates(process.id, null), 422, 'VALIDATION_ERROR');
      expectProblem(await candidates(process.id, '  '), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem COMMENT_CREATE não acessa candidatos: 403 PERMISSION_DENIED com access.denied', async () => {
      const process = await processWith();
      const response = await candidates(process.id, 'cla', TATIANE);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'COMMENT_CREATE',
      });
    });

    it('FA-02/RN-CMT-22: alvo sem visibilidade não é sugerido e, no commit, vira rótulo simples sem Mention', async () => {
      const process = await processWith();
      // Eva tem vínculo ativo, mas nenhum perfil: não vê o processo (DEC-024).
      expect(candidatesOf(await candidates(process.id, 'eva'))).toEqual([]);
      const created = await createOk(
        process.id,
        withMentions('Oi ', mention('USER', FAKE_USERS.eva.id, 'Eva Prado')),
      );
      expect(created.mentions).toEqual([]);
      expect(created.body).toMatchObject(
        withMentions('Oi ', mention('USER', FAKE_USERS.eva.id, 'Eva Prado')),
      );
      expect(mentionsOf(created.id)).toEqual([]);
      expect(mentionEvents(process.id)).toEqual([]);
      const warned = JSON.stringify(warn.mock.calls);
      expect(warned).toContain('mention.target_unavailable');
      expect(warned).not.toContain('Eva Prado');
    });

    it('FA-04: unidade com mais de 50 membros ativos não é sugerida e é descartada no commit', async () => {
      const process = await processWith();
      const unit = await candidates(process.id, 'paviment');
      expect(candidatesOf(unit).filter((item) => item.id === UNITS_A.pavimentacao)).toEqual([]);
      const created = await createOk(
        process.id,
        withMentions(
          'Equipe, ',
          mention('DEPARTMENT', UNITS_A.pavimentacao, 'Setor de Pavimentação'),
        ),
      );
      expect(mentionsOf(created.id)).toEqual([]);
    });

    it('FA-03: menção ao próprio autor é registrada (o dispatcher nunca notifica o ator)', async () => {
      const process = await processWith();
      const created = await createOk(
        process.id,
        withMentions('Lembrete para mim, ', mention('USER', MARCOS_ID, 'Ana Souza')),
      );
      expect(mentionsOf(created.id)).toEqual([
        expect.objectContaining({ mentionedUserId: MARCOS_ID }),
      ]);
      const [event] = mentionEvents(process.id);
      expect(event?.payload).toMatchObject({ mentionedUserId: MARCOS_ID });
      // RN-CMT-26: o ator do envelope é o autor — o `NotificationDispatcher` o exclui.
      expect(event?.metadata.actor).toMatchObject({ userId: MARCOS_ID });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Candidato homônimo de outro tenant não aparece; processo fora do tenant → 404; alvo de B é descartado', async () => {
      const process = await processWith();
      expect(candidatesOf(await candidates(process.id, 'heitor'))).toEqual([]);
      expect(candidatesOf(await candidates(process.id, 'secretaria de obras'))).not.toContainEqual(
        expect.objectContaining({ id: UNITS_B.obras }),
      );
      expectProblem(await candidates(newId(), 'heitor'), 404, 'PROCESS_NOT_FOUND');
      const created = await createOk(
        process.id,
        withMentions(
          'Oi ',
          mention('USER', FAKE_USERS.heitor.id, 'Heitor Barros'),
          mention('DEPARTMENT', UNITS_B.manutencao, 'Setor de Manutenção'),
        ),
      );
      expect(mentionsOf(created.id)).toEqual([]);
      expect(mentionEvents(process.id)).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Mesmo alvo mencionado duas vezes no mesmo comentário: um Mention e um UserMentioned', async () => {
      const process = await processWith();
      const created = await createOk(
        process.id,
        withMentions(
          'Oi ',
          mention('USER', CLAUDIA_ID, 'Lúcia Matos'),
          { type: 'text', text: ' e de novo ' },
          mention('USER', CLAUDIA_ID, 'Lúcia Matos'),
        ),
      );
      expect(mentionsOf(created.id)).toHaveLength(1);
      expect(mentionEvents(process.id)).toHaveLength(1);
      expect(created.mentions).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Edição sem novas menções não gera UserMentioned; nova menção gera só o dela (RN-CMT-24)', async () => {
      const process = await processWith();
      const created = await createOk(
        process.id,
        withMentions('Oi ', mention('USER', CLAUDIA_ID, 'Lúcia Matos')),
      );
      const kept = await patch(
        created.id,
        withMentions('Oi (corrigido) ', mention('USER', CLAUDIA_ID, 'Lúcia Matos')),
      );
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(mentionEvents(process.id)).toHaveLength(1);
      expect(commentSchema.parse(data<CommentDto>(kept)).mentions).toHaveLength(1);

      const added = await patch(
        created.id,
        withMentions(
          'Oi ',
          mention('USER', CLAUDIA_ID, 'Lúcia Matos'),
          mention('USER', FAKE_USERS.marta.id, 'Marta Ribeiro'),
        ),
        '"2"',
      );
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(mentionEvents(process.id).map((row) => row.payload.mentionedUserId)).toEqual([
        CLAUDIA_ID,
        FAKE_USERS.marta.id,
      ]);
      expect(auditOf(process.id, 'comment.update').at(-1)?.metadata).toMatchObject({
        mentionedUserIds: [FAKE_USERS.marta.id],
      });
    });

    it('Duas edições simultâneas adicionando a mesma menção: uma vence (412 na outra), um único Mention', async () => {
      const process = await processWith();
      const created = await createOk(process.id, withMentions('Sem menção ainda.'));
      const body = withMentions('Oi ', mention('USER', CLAUDIA_ID, 'Lúcia Matos'));
      const [first, second] = await Promise.all([patch(created.id, body), patch(created.id, body)]);
      expect([first.status, second.status].sort()).toEqual([200, 412]);
      expect(mentionsOf(created.id)).toHaveLength(1);
      expect(mentionEvents(process.id)).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao publicar com menção: 503 DEPENDENCY_UNAVAILABLE e nada persistido', async () => {
      const process = await processWith();
      transactions.down = true;
      const response = await post(
        process.id,
        withMentions('Oi ', mention('USER', CLAUDIA_ID, 'Lúcia Matos')),
      );
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(
        api
          .outboxRows()
          .filter((row) => row.processId === process.id && row.eventType !== 'ProcessCreated'),
      ).toEqual(
        api
          .outboxRows()
          .filter(
            (row) =>
              row.processId === process.id &&
              row.eventType !== 'ProcessCreated' &&
              !['CommentCreated', 'UserMentioned'].includes(row.eventType),
          ),
      );
      expect(mentionEvents(process.id)).toEqual([]);
      expect(auditOf(process.id, 'comment.create')).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila de notificações indisponível: 201 e UserMentioned fica PENDING no outbox até o relay', async () => {
      const process = await processWith();
      const response = await post(
        process.id,
        withMentions('Oi ', mention('USER', CLAUDIA_ID, 'Lúcia Matos')),
      );
      expect(response.status).toBe(201);
      const pending = mentionEvents(process.id);
      expect(pending).toHaveLength(1);
      // Sem relay no modo em memória: a entrega única de `MENTIONED` é do dispatcher (idempotente
      // por `eventId` — RN-NTF-03), quando a fila voltar.
      expect(pending[0]).not.toHaveProperty('publishedAt', expect.anything());
    });
  });
});
