import {
  checkDuplicateProcessesSchema,
  createProcessSchema,
  dataEnvelope,
  duplicateCheckResultSchema,
  processIdParamsSchema,
  processListQuerySchema,
  processListResponseSchema,
  processSchema,
} from '@contrataflow/validation';
import type {
  CheckDuplicateProcesses,
  CreateProcess,
  DuplicateCheckResult,
  ProcessDto,
  ProcessListItemDto,
  ProcessListQuery,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';

import { ImplicitAccess, RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { PageResult } from '#shared/http/pagination.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { CreateProcessCommand } from '../application/create-process.command.js';
import { ListProcessesHandler } from '../application/list-processes.query.js';
import { CheckDuplicateProcessesQuery, GetProcessQuery } from '../application/process.queries.js';

const TAGS = ['Processos'];

/** `@ProcessId()`: `id` do caminho (o guard já recusou o malformado com 400) e o OpenAPI. */
function ProcessId(): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('id')(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(target, propertyKey, 'params', processIdParamsSchema);
    }
  };
}

/**
 * Processos de contratação (api/02-processes.md · US-001/US-002): PRC-01 (listar), PRC-02 (criar), PRC-03 (verificar
 * duplicidade) e PRC-04 (detalhe mínimo para o painel SCR-006 — completado pela US-004).
 * `PROCESS_CREATE` em algum escopo no guard; o escopo sobre o setor solicitante (RN-PROC-03) é
 * conferido no caso de uso, depois das referências.
 */
@Controller('processes')
@TenantScope('TENANT')
export class ProcessController {
  constructor(
    private readonly create: CreateProcessCommand,
    private readonly duplicates: CheckDuplicateProcessesQuery,
    private readonly detail: GetProcessQuery,
    private readonly list: ListProcessesHandler,
  ) {}

  @Get()
  @ImplicitAccess(
    'Lista de processos (US-002 · DEC-024 cond. 4): PROCESS_VIEW em algum escopo OU concessão USER ativa, conferido no caso de uso (403 + access.denied); o resultado é sempre restrito pelo predicado de visibilidade.',
  )
  @ApiOperation({
    operationId: 'PRC-01',
    summary: 'Listar, pesquisar e filtrar processos',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Processos visíveis (DEC-024) que casam os filtros (E entre filtros, OU dentro de cada um), com o valor sigiloso mascarado por linha (POL-09) e o DTO calculado `deadline`. Página e total do mesmo snapshot; página além do total = `data: []`.',
        schema: processListResponseSchema,
      },
    },
  })
  async listProcesses(
    @ZodQuery(processListQuerySchema) query: ProcessListQuery,
  ): Promise<PageResult<ProcessListItemDto>> {
    const result = await this.list.execute(query);
    // `meta` com os extras da lista (`stageOptions`, notas de sigilo) — envelope `{ data, meta }`.
    return new PageResult(result.items, result.meta);
  }

  @Post()
  @Idempotent()
  @RequirePermission('PROCESS_CREATE', {
    detail: 'Você não tem permissão para abrir processos para este setor.',
  })
  @ApiOperation({
    operationId: 'PRC-02',
    summary: 'Criar processo de contratação',
    tags: TAGS,
    idempotent: true,
    auditActions: ['process.create'],
    responses: {
      201: {
        description:
          'Processo em `DRAFT` na etapa inicial do workflow aplicável (`Location` e `ETag` = versão). Sem número quando `numbering.process.assignOn = START`.',
        schema: dataEnvelope(processSchema),
      },
    },
  })
  async createProcess(
    @ZodBody(createProcessSchema) body: CreateProcess,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessDto> {
    const created = await this.create.execute({ body, idempotencyKey: idempotencyKey ?? null });
    response.setHeader('Location', `/api/v1/processes/${created.dto.id}`);
    response.setHeader('ETag', `"${created.dto.version}"`);
    return created.dto;
  }

  @Post('check-duplicates')
  @HttpCode(200)
  @RequirePermission('PROCESS_CREATE')
  @ApiOperation({
    operationId: 'PRC-03',
    summary: 'Verificar possível duplicidade de processo',
    tags: TAGS,
    auditExempt:
      'Consulta somente de leitura: o POST apenas carrega título, objeto e setor, sem efeito colateral.',
    responses: {
      200: {
        description:
          'Processos visíveis com título ou objeto semelhante (trigram ≥ 0,6), do mesmo criador ou setor, na janela configurada (0 desativa).',
        schema: dataEnvelope(duplicateCheckResultSchema),
      },
    },
  })
  checkDuplicates(
    @ZodBody(checkDuplicateProcessesSchema) body: CheckDuplicateProcesses,
  ): Promise<DuplicateCheckResult> {
    return this.duplicates.execute(body);
  }

  @Get(':id')
  @RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })
  @ApiOperation({
    operationId: 'PRC-04',
    summary: 'Obter detalhe do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Processo visível ao usuário (DEC-024 — `ETag` = versão); não visível, inexistente ou de outro tenant = 404 `PROCESS_NOT_FOUND`.',
        schema: dataEnvelope(processSchema),
      },
    },
  })
  async getProcess(
    @ProcessId() id: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessDto> {
    const process = await this.detail.execute(id);
    response.setHeader('ETag', `"${process.version}"`);
    return process;
  }
}
