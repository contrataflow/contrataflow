import {
  TASK_BULK_MESSAGES,
  bulkAssignSchema,
  bulkClaimSchema,
  bulkResultResponseSchema,
} from '@contrataflow/validation';
import type {
  BulkAssign,
  BulkClaim,
  BulkItemResultDto,
  BulkResultMeta,
} from '@contrataflow/validation';
import { Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';

import { ImplicitAccess, RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import {
  BulkAssignProcessesCommand,
  BulkClaimProcessesCommand,
} from '../application/task-bulk.commands.js';
import type { BulkOutcome } from '../application/task-bulk.support.js';

const TAGS = ['Caixa de tarefas'];

const PER_ITEM =
  'Resultado por item (RN-INBOX-22), na ordem de `processIds`: `ok = true` com `process` (`id`, `code`, `version`, `currentResponsible`) ou `ok = false` com `code`/`message` — `PROCESS_ALREADY_ASSIGNED`, `PERMISSION_DENIED`, `INVALID_PROCESS_STATUS`, `REFERENCE_NOT_FOUND` (outro tenant, inexistente ou invisível — sem revelar a existência) e `DEPENDENCY_UNAVAILABLE` (banco fora no meio do lote: os itens seguintes não são tentados). Cada item em sua própria transação; sucesso e erro convivem. `meta`: `successCount`/`errorCount`. Lote de 2 a 50 `processId` distintos (422 `VALIDATION_ERROR` com `TOO_SHORT`/`TOO_LONG`/`DUPLICATE_IN_LIST` em `processIds`). `Idempotency-Key` cobre o lote inteiro (mesma chave e corpo = o mesmo resultado com `Idempotent-Replayed: true`; corpo diferente = 422 `IDEMPOTENCY_KEY_REUSED`).';

function resultOf(
  outcome: BulkOutcome,
  response: HttpResponse,
): DataResult<BulkItemResultDto[], BulkResultMeta> {
  response.setHeader('Cache-Control', 'no-store');
  return new DataResult(outcome.items, outcome.summary);
}

/**
 * TSK-03/TSK-04 (api/11-approvals-inbox.md · US-058 · SCR-013/SCR-115): ações em lote da fila da
 * unidade. Moram no `process` (dono do PRC-21/PRC-22 reaproveitados por item); a leitura da caixa
 * (TSK-01/TSK-02) é do `inbox`.
 */
@Controller('tasks')
@TenantScope('TENANT')
export class TaskBulkController {
  constructor(
    private readonly bulkClaims: BulkClaimProcessesCommand,
    private readonly bulkAssignments: BulkAssignProcessesCommand,
  ) {}

  @Post('bulk-claim')
  @HttpCode(200)
  @Idempotent()
  @RequirePermission('PROCESS_CLAIM', { detail: TASK_BULK_MESSAGES.permissionDenied })
  @ApiOperation({
    operationId: 'TSK-03',
    summary: 'Assumir processos em lote',
    tags: TAGS,
    idempotent: true,
    auditActions: ['process.claim'],
    responses: {
      200: {
        description: `Cada item é o PRC-21 (POL-04 por item: \`PROCESS_CLAIM\` cobrindo o processo, lotação na unidade atual, sem responsável), sem \`If-Match\` por item — a trava do processo decide a corrida entre lotes. Por item bem-sucedido: \`ProcessAssigned\` (\`assignmentType = CLAIM\`) e \`process.claim\` com \`metadata.batchId\`/\`metadata.idempotencyKey\`. ${PER_ITEM}`,
        schema: bulkResultResponseSchema,
      },
    },
  })
  async bulkClaim(
    @ZodBody(bulkClaimSchema) body: BulkClaim,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<BulkItemResultDto[], BulkResultMeta>> {
    const outcome = await this.bulkClaims.execute({ body, idempotencyKey: idempotencyKey ?? null });
    return resultOf(outcome, response);
  }

  @Post('bulk-assign')
  @HttpCode(200)
  @Idempotent()
  @ImplicitAccess(
    'POL-05 conferida pelo caso de uso (US-058): permissão base PROCESS_ASSIGN em algum escopo OU titular/substituto de alguma unidade (403 PERMISSION_DENIED do lote, com access.denied); depois POL-05 por item no PRC-22.',
  )
  @ApiOperation({
    operationId: 'TSK-04',
    summary: 'Atribuir processos em lote',
    tags: TAGS,
    idempotent: true,
    auditActions: ['process.assign'],
    responses: {
      200: {
        description: `Todos os itens vão ao mesmo \`assigneeId\` com o motivo do lote (10–2.000 — RN-INBOX-21). Sem \`PROCESS_ASSIGN\` em nenhum escopo nem titularidade/substituição de unidade: 403 \`PERMISSION_DENIED\` do lote inteiro. Cada item é o PRC-22 (POL-05 por item: \`PROCESS_ASSIGN\` em \`TENANT\`/\`ORGANIZATION\` cobrindo o processo ou titular/substituto da unidade atual; responsável elegível na unidade atual — \`ASSIGNEE_NOT_ELIGIBLE\`), sem \`If-Match\` por item. Por item bem-sucedido: \`ProcessAssigned\` (\`assignmentType = MANUAL\`, notificação \`PROCESS_ASSIGNED\` ao novo responsável) e \`process.assign\` com \`metadata.batchId\`. ${PER_ITEM}`,
        schema: bulkResultResponseSchema,
      },
    },
  })
  async bulkAssign(
    @ZodBody(bulkAssignSchema) body: BulkAssign,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<BulkItemResultDto[], BulkResultMeta>> {
    const outcome = await this.bulkAssignments.execute({
      body,
      idempotencyKey: idempotencyKey ?? null,
    });
    return resultOf(outcome, response);
  }
}
