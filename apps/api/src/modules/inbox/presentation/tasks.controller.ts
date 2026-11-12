import {
  TASK_INBOX_COUNT_UNIT,
  taskInboxCountersResponseSchema,
  taskInboxQuerySchema,
  taskInboxResponseSchema,
} from '@contrataflow/validation';
import type {
  TaskInboxCountersDto,
  TaskInboxItemDto,
  TaskInboxQuery,
} from '@contrataflow/validation';
import { Controller, Get, Res } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { PageResult } from '#shared/http/pagination.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  GetTaskInboxCountersHandler,
  GetTaskInboxHandler,
} from '../application/task-inbox.queries.js';

const TAGS = ['Caixa de tarefas'];
const DENIED = 'Você não tem acesso à caixa de tarefas.';

/**
 * TSK-01/TSK-02 (api/11-approvals-inbox.md · US-056 · SCR-013): a caixa de tarefas como consulta
 * (DEC-026). Somente leitura; o "Assumir" da fila é o PRC-21 (US-049).
 */
@Controller('tasks')
@TenantScope('TENANT')
export class TasksController {
  constructor(
    private readonly inbox: GetTaskInboxHandler,
    private readonly counters: GetTaskInboxCountersHandler,
  ) {}

  @Get()
  @RequirePermission('INBOX_VIEW', { detail: DENIED })
  @ApiOperation({
    operationId: 'TSK-01',
    summary: 'Listar tarefas (caixa de tarefas)',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Itens da visão (`MINE`, `UNIT_QUEUE`, `PENDING_APPROVALS`, `RETURNED`, `OVERDUE`, `FOLLOWING` — RN-INBOX-02..08) entre os processos visíveis (DEC-024), ordenados por `dueAt`, `code` e `enteredAt` (`requestedAt` em `PENDING_APPROVALS`), nulos por último. Página e total do mesmo snapshot. `UNIT_QUEUE` de quem não tem `PROCESS_CLAIM` com lotação nem é titular/substituto = `data: []`. Sem valores monetários. US-125 (RN-WF2-29/30): uma linha por etapa ativa (ramo) — `rowKey` único, `processStageId`, `branchKey`, `branchLabel`, `activeStagesCount`, `siblings[]`/`siblingsMore`; `FOLLOWING` é uma linha por processo; `branchKey` na query restringe às linhas do ramo.',
        schema: taskInboxResponseSchema,
      },
    },
  })
  async listTasks(
    @ZodQuery(taskInboxQuerySchema) query: TaskInboxQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PageResult<TaskInboxItemDto>> {
    const result = await this.inbox.execute(query);
    // Pessoal e consultada por polling (RN-INBOX-13): nunca de cache intermediário.
    response.setHeader('Cache-Control', 'no-store');
    return new PageResult(result.items, result.meta);
  }

  @Get('counters')
  @RequirePermission('INBOX_VIEW', { detail: DENIED })
  @ApiOperation({
    operationId: 'TSK-02',
    summary: 'Obter contadores da caixa de tarefas',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Contadores por visão com os mesmos predicados do TSK-01, numa única instrução (RN-INBOX-09). `unitQueue` só quando a fila da unidade se aplica ao usuário (FA-01). US-125 (RN-WF2-31): contam LINHAS (`meta.countUnit = "ROW"`) — um processo com dois ramos visíveis na mesma visão conta 2.',
        schema: taskInboxCountersResponseSchema,
      },
    },
  })
  async getCounters(
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<TaskInboxCountersDto, { countUnit: typeof TASK_INBOX_COUNT_UNIT }>> {
    const counters = await this.counters.execute();
    response.setHeader('Cache-Control', 'no-store');
    return new DataResult(counters, { countUnit: TASK_INBOX_COUNT_UNIT });
  }
}
