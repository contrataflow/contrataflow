import {
  checkDuplicateProcessesSchema,
  createProcessSchema,
  dataEnvelope,
  duplicateCheckResultSchema,
  duplicateProcessSchema,
  forwardedProcessSchema,
  forwardProcessSchema,
  processIdParamsSchema,
  processListQuerySchema,
  processDetailMetaSchema,
  processListResponseSchema,
  processSchema,
  processStageEntrySchema,
  processSummarySchema,
  PROCESS_CONFIDENTIALITY_MESSAGES,
  returnedProcessSchema,
  returnProcessSchema,
  setProcessConfidentialitySchema,
  updateProcessSchema,
} from '@contrataflow/validation';
import type {
  CheckDuplicateProcesses,
  CreateProcess,
  DuplicateCheckResult,
  DuplicateProcess,
  ForwardProcess,
  ForwardedProcessDto,
  ProcessDetailMeta,
  ProcessDto,
  ProcessListItemDto,
  ProcessListQuery,
  ProcessStageEntryDto,
  ProcessSummaryDto,
  ReturnedProcessDto,
  ReturnProcess,
  SetProcessConfidentiality,
  UpdateProcess,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Res } from '@nestjs/common';
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

import { ClaimProcessCommand } from '../application/claim-process.command.js';
import { CreateProcessCommand } from '../application/create-process.command.js';
import { DuplicateProcessCommand } from '../application/duplicate-process.command.js';
import { ForwardProcessCommand } from '../application/forward-process.command.js';
import { ListProcessesHandler } from '../application/list-processes.query.js';
import {
  GetProcessSummaryQuery,
  ListProcessStagesQuery,
} from '../application/process-panel.queries.js';
import { CheckDuplicateProcessesQuery, GetProcessQuery } from '../application/process.queries.js';
import { ReturnProcessCommand } from '../application/return-process.command.js';
import { SetProcessConfidentialityCommand } from '../application/set-process-confidentiality.command.js';
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
 * (editar dados), PRC-07 (painel situacional), PRC-10 (etapas e passagens do stepper), PRC-19
 * (encaminhar — US-047), PRC-27 (duplicar — US-011) e PRC-33 (sigilo do orçamento — US-013).
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
    private readonly duplicate: DuplicateProcessCommand,
    private readonly confidentiality: SetProcessConfidentialityCommand,
    private readonly forward: ForwardProcessCommand,
    private readonly returns: ReturnProcessCommand,
    private readonly claims: ClaimProcessCommand,
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

  @Put(':id/confidentiality')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('PROCESS_SET_CONFIDENTIAL_BUDGET', {
    scope: { processParam: 'id' },
    detail: PROCESS_CONFIDENTIALITY_MESSAGES.permissionDenied,
  })
  @ApiOperation({
    operationId: 'PRC-33',
    summary: 'Definir sigilo do orçamento estimado',
    tags: TAGS,
    auditActions: ['process.confidentiality_change'],
    responses: {
      200: {
        description:
          'Processo com o novo `isBudgetConfidential` (`ETag` = nova versão) e o valor mascarado pela POL-09 sobre o novo estado. Ao ativar, os documentos de pesquisa de preços passam a `RESTRICTED`; ao desativar, voltam à confidencialidade padrão do tipo (RN-PROC-139). Flag já no estado pedido = processo atual sem nova versão, evento nem auditoria. `PROCESS_SET_CONFIDENTIAL_BUDGET` cobrindo o processo (não visível = 404 `PROCESS_NOT_FOUND`); `If-Match` divergente = 412 `VERSION_CONFLICT` com `currentVersion` e `meta.current`. Evento `ProcessConfidentialityChanged`; sem notificação.',
        schema: dataEnvelope(processSchema),
      },
    },
  })
  async setConfidentiality(
    @ProcessId() id: string,
    @ZodBody(setProcessConfidentialitySchema) body: SetProcessConfidentiality,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessDto> {
    const result = await this.confidentiality.execute({
      processId: id,
      isBudgetConfidential: body.isBudgetConfidential,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${result.dto.version}"`);
    noStore(response);
    return result.dto;
  }

  @Post(':id/forward')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @RequirePermission('PROCESS_FORWARD', {
    detail: 'Você não tem permissão para encaminhar processos.',
  })
  @ApiOperation({
    operationId: 'PRC-19',
    summary: 'Encaminhar processo',
    tags: TAGS,
    idempotent: true,
    auditActions: [
      'process.forward',
      'process.number_assign',
      'document.version_create',
      'document.submit',
      'approval.request',
    ],
    responses: {
      200: {
        description:
          'Processo na nova etapa (`ETag` = nova versão) com a tramitação `FORWARD` (`movement`), a aprovação aberta no destino `APPROVAL` (`approval`) e a autuação (`numberAssigned`). Uma transação: trava do processo, `expectedStageId` diferente da etapa atual = 409 `STAGE_CHANGED` (antes do `If-Match`: 412 `VERSION_CONFLICT`), `PROCESS_FORWARD` cobrindo o processo + custódia (POL-01: 403 `NOT_PROCESS_CUSTODIAN`), status `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`) e o motor de workflow (422 `TRANSITION_NOT_AVAILABLE`/`TRANSITION_BLOCKED`/`WARNINGS_NOT_ACKNOWLEDGED`). Unidade (`DEPARTMENT_REQUIRED`), pessoa (`ASSIGNEE_NOT_ELIGIBLE`), prazo (`DUE_DATE_OVERRIDE_NOT_ALLOWED`), documentos cobertos (`DOCUMENT_INCOMPLETE`) e aprovador (`APPROVER_UNRESOLVED`) desfazem tudo.',
        schema: dataEnvelope(forwardedProcessSchema),
      },
    },
  })
  async forwardProcess(
    @ProcessId() id: string,
    @ZodBody(forwardProcessSchema) body: ForwardProcess,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ForwardedProcessDto> {
    const result = await this.forward.execute({
      processId: id,
      body,
      expectedVersion: ifMatch?.value ?? 0,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('ETag', `"${result.dto.version}"`);
    noStore(response);
    return result.dto;
  }

  @Post(':id/return')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @RequirePermission('PROCESS_RETURN', {
    detail: 'Você não tem permissão para devolver processos.',
  })
  @ApiOperation({
    operationId: 'PRC-20',
    summary: 'Devolver processo',
    tags: TAGS,
    idempotent: true,
    auditActions: ['process.return'],
    responses: {
      200: {
        description:
          'Processo devolvido (`status = RETURNED`, `ETag` = nova versão) para a etapa já percorrida `targetStageId`, com a tramitação `RETURN` (`movement`). Uma transação: trava do processo, `expectedStageId` (se enviado) diferente da etapa atual = 409 `STAGE_CHANGED` (antes do `If-Match`: 412 `VERSION_CONFLICT`), `PROCESS_RETURN` cobrindo o processo + custódia (POL-01: 403 `NOT_PROCESS_CUSTODIAN`), status `IN_PROGRESS` (409 `INVALID_PROCESS_STATUS`), destino percorrido e configurado na transição `RETURN` da etapa atual (422 `TRANSITION_NOT_AVAILABLE`) e prazo informado só com `allowDueDateOverride` (422 `DUE_DATE_OVERRIDE_NOT_ALLOWED`). Responsável de destino por `PREVIOUS_ASSIGNEE` (sem histórico = fila da unidade); nenhum documento muda de status.',
        schema: dataEnvelope(returnedProcessSchema),
      },
    },
  })
  async returnProcess(
    @ProcessId() id: string,
    @ZodBody(returnProcessSchema) body: ReturnProcess,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ReturnedProcessDto> {
    const result = await this.returns.execute({
      processId: id,
      body,
      expectedVersion: ifMatch?.value ?? 0,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('ETag', `"${result.dto.version}"`);
    noStore(response);
    return result.dto;
  }

  @Post(':id/claim')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('PROCESS_CLAIM', {
    detail: 'Você não tem permissão para assumir processos.',
  })
  @ApiOperation({
    operationId: 'PRC-21',
    summary: 'Assumir processo',
    tags: TAGS,
    auditActions: ['process.claim'],
    responses: {
      200: {
        description:
          'Processo assumido (`currentResponsible` = quem chamou, `ETag` = nova versão). Sem corpo. Uma transação: trava do processo, `PROCESS_CLAIM` cobrindo o processo + lotação na unidade atual (POL-04: 403 `PERMISSION_DENIED`, auditado), status `IN_PROGRESS`/`RETURNED` em etapa que não seja `APPROVAL` (409 `INVALID_PROCESS_STATUS`), sem responsável individual (409 `PROCESS_ALREADY_ASSIGNED` com `currentResponsible`) e `If-Match` (412 `VERSION_CONFLICT`; o reenvio do clique duplo de quem já assumiu cai aqui). Sem motivo e sem notificação.',
        schema: dataEnvelope(processSchema),
      },
    },
  })
  async claimProcess(
    @ProcessId() id: string,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessDto> {
    const result = await this.claims.execute({
      processId: id,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${result.dto.version}"`);
    noStore(response);
    return result.dto;
  }

  @Post(':id/duplicate')
  @Idempotent()
  @RequirePermission('PROCESS_DUPLICATE', {
    scope: { processParam: 'id' },
    detail: 'Você não tem permissão para duplicar este processo.',
  })
  @ApiOperation({
    operationId: 'PRC-27',
    summary: 'Duplicar processo',
    tags: TAGS,
    idempotent: true,
    auditActions: ['process.duplicate', 'process.create'],
    responses: {
      201: {
        description:
          'Novo processo em `DRAFT` (`Location` e `ETag` = versão) com `duplicatedFromId` = origem: metadados, itens e — com `copyDocuments`/`copyAttachments` — documentos estruturados como rascunho e anexos por cópia lógica (DEC-033). Número, workflow e etapa inicial resolvidos para os NOVOS dados, como no PRC-02; nunca copia número, aprovações, tramitações, timeline, comentários, auditoria, participantes nem valor estimado. `PROCESS_DUPLICATE` cobrindo a origem (não visível = 404 `PROCESS_NOT_FOUND`) e `PROCESS_CREATE` cobrindo o setor solicitante final.',
        schema: dataEnvelope(processSchema),
      },
    },
  })
  async duplicateProcess(
    @ProcessId() id: string,
    @ZodBody(duplicateProcessSchema) body: DuplicateProcess,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessDto> {
    const duplicated = await this.duplicate.execute({
      processId: id,
      body,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/processes/${duplicated.dto.id}`);
    response.setHeader('ETag', `"${duplicated.dto.version}"`);
    return duplicated.dto;
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
