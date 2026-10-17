import {
  checkDuplicateProcessesSchema,
  createProcessSchema,
  dataEnvelope,
  duplicateCheckResultSchema,
  processIdParamsSchema,
  processListQuerySchema,
  processDetailMetaSchema,
  processListResponseSchema,
  processSchema,
  processStageEntrySchema,
  processSummarySchema,
  updateProcessSchema,
} from '@contrataflow/validation';
import type {
  CheckDuplicateProcesses,
  CreateProcess,
  DuplicateCheckResult,
  ProcessDetailMeta,
  ProcessDto,
  ProcessListItemDto,
  ProcessListQuery,
  ProcessStageEntryDto,
  ProcessSummaryDto,
  UpdateProcess,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { CreateProcessCommand } from '../application/create-process.command.js';
import { ListProcessesHandler } from '../application/list-processes.query.js';
import {
  GetProcessSummaryQuery,
  ListProcessStagesQuery,
} from '../application/process-panel.queries.js';
import { CheckDuplicateProcessesQuery, GetProcessQuery } from '../application/process.queries.js';
import { UpdateProcessCommand } from '../application/update-process.command.js';

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

/** DEC-024 · RN-PROC-47: a visibilidade (inclusive concessão própria) é conferida no caso de uso. */
const PANEL_ACCESS =
  'Detalhe e painel do processo (US-004 · DEC-024): PROCESS_VIEW com escopo que cubra o processo, concessão USER (criador, responsável, aprovador) ou participação ativa, conferidos no caso de uso sobre o runtime do mesmo tx; não visível = 404 PROCESS_NOT_FOUND igual ao inexistente, sem access.denied.';

/** Resposta personalizada e mutável: nenhum cache intermediário (US-004 · "Impacto técnico"). */
function noStore(response: HttpResponse): void {
  response.setHeader('Cache-Control', 'no-store');
}

/**
 * Processos de contratação (api/02-processes.md · US-001/US-002/US-004/US-005): PRC-01 (listar),
 * PRC-02 (criar), PRC-03 (verificar duplicidade), PRC-04 (detalhe com `meta.allowedActions`), PRC-05
 * (editar dados), PRC-07 (painel situacional) e PRC-10 (etapas e passagens do stepper).
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
    private readonly summary: GetProcessSummaryQuery,
    private readonly stages: ListProcessStagesQuery,
    private readonly update: UpdateProcessCommand,
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
  @ImplicitAccess(PANEL_ACCESS)
  @ApiOperation({
    operationId: 'PRC-04',
    summary: 'Obter detalhe do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Processo visível ao usuário (DEC-024 — `ETag` = versão), com o valor sigiloso mascarado pela POL-09 e `meta.allowedActions` (ações habilitadas do motor); não visível, inexistente ou de outro tenant = 404 `PROCESS_NOT_FOUND`. Valor sigiloso entregue = `process.confidential_view` (1× por sessão).',
        schema: z.object({ data: processSchema, meta: processDetailMetaSchema }),
      },
    },
  })
  async getProcess(
    @ProcessId() id: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<ProcessDto, ProcessDetailMeta>> {
    const { process, allowedActions } = await this.detail.execute(id);
    response.setHeader('ETag', `"${process.version}"`);
    noStore(response);
    return new DataResult(process, { allowedActions });
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('PROCESS_UPDATE', {
    detail: 'Você não tem permissão para editar este processo.',
  })
  @ApiOperation({
    operationId: 'PRC-05',
    summary: 'Editar dados do processo',
    tags: TAGS,
    auditActions: ['process.update'],
    responses: {
      200: {
        description:
          'Processo atualizado (`ETag` = nova versão). PATCH sem diferença efetiva devolve o processo atual sem nova versão, evento, timeline nem auditoria. `PROCESS_UPDATE` cobrindo o processo + custódia (POL-01) + status `DRAFT`/`IN_PROGRESS`/`RETURNED`; órgão e unidade solicitante só em `DRAFT` (422 `NOT_ALLOWED`); `If-Match` divergente = 412 `VERSION_CONFLICT` com `currentVersion` e `meta.current`.',
        schema: dataEnvelope(processSchema),
      },
    },
  })
  async updateProcess(
    @ProcessId() id: string,
    @ZodBody(updateProcessSchema) body: UpdateProcess,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessDto> {
    const updated = await this.update.execute({
      processId: id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${updated.dto.version}"`);
    noStore(response);
    return updated.dto;
  }

  @Get(':id/summary')
  @ImplicitAccess(PANEL_ACCESS)
  @ApiOperation({
    operationId: 'PRC-07',
    summary: 'Obter painel situacional do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'As 7 perguntas de DEC-180 (onde está, responsável, o que falta, próximo passo, prazos, documentos e aprovações pendentes), o cabeçalho e os contadores das abas, num instante único (`REPEATABLE READ`). Valor sigiloso mascarado (POL-09) e documentos `RESTRICTED` sem link para quem não atende; não visível = 404 `PROCESS_NOT_FOUND`.',
        schema: dataEnvelope(processSummarySchema),
      },
    },
  })
  async getSummary(
    @ProcessId() id: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessSummaryDto> {
    const summary = await this.summary.execute(id);
    noStore(response);
    return summary;
  }

  @Get(':id/stages')
  @ImplicitAccess(PANEL_ACCESS)
  @ApiOperation({
    operationId: 'PRC-10',
    summary: 'Listar etapas e passagens do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Etapas da versão de workflow fixada no processo, em `displayOrder`, com o status da última passagem (`null` = não percorrida) e todas as passagens (idas e voltas). A etapa `END` só aparece concluída com o processo `COMPLETED`.',
        schema: dataEnvelope(z.array(processStageEntrySchema)),
      },
    },
  })
  async listStages(
    @ProcessId() id: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessStageEntryDto[]> {
    const stages = await this.stages.execute(id);
    noStore(response);
    return stages;
  }
}
