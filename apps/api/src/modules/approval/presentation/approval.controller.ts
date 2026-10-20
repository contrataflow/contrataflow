import {
  approvalListQuerySchema,
  approvalListResponseSchema,
  approvalMetaSchema,
  approvalSchema,
  dataEnvelope,
  decideApprovalSchema,
  decidedApprovalSchema,
  reassignApprovalSchema,
  withdrawApprovalSchema,
  withdrawnApprovalSchema,
} from '@contrataflow/validation';
import type {
  ApprovalDto,
  ApprovalListItemDto,
  ApprovalListQuery,
  ApprovalMeta,
  DecideApproval,
  DecidedApprovalDto,
  ReassignApproval,
  WithdrawApproval,
  WithdrawnApprovalDto,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy, RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { DecideApprovalCommand } from '../application/decide-approval.command.js';
import { GetApprovalQuery } from '../application/get-approval.query.js';
import { ListApprovalsHandler } from '../application/list-approvals.query.js';
import { ReassignApprovalCommand } from '../application/reassign-approval.command.js';
import { WithdrawApprovalCommand } from '../application/withdraw-approval.command.js';

const TAGS = ['Aprovações'];

const approvalIdParamsSchema = z.object({ id: z.uuid() }).meta({ id: 'ApprovalIdParams' });

/** `@ApprovalId()`: `id` do caminho (o guard já recusou o malformado com 400) e o OpenAPI. */
function ApprovalId(): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('id')(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(target, propertyKey, 'params', approvalIdParamsSchema);
    }
  };
}

/** Resposta personalizada e mutável: nenhum cache intermediário. */
function noStore(response: HttpResponse): void {
  response.setHeader('Cache-Control', 'no-store');
}

/**
 * Aprovações (api/11-approvals-inbox.md): APV-01 (lista da cobertura de aprovador — US-057), APV-02 (detalhe com `meta.allowedActions`,
 * opções de decisão e o motivo de não poder decidir) e APV-03 (decidir — aprovar, devolver ou
 * indeferir, com os efeitos atômicos no processo e nos documentos). `APPROVAL_DECIDE` em algum
 * escopo no guard (com o 2º fator — risco H, POL-14); POL-03 no caso de uso. US-053: APV-04
 * (retirar — POL-17 no caso de uso) e APV-05 (redirecionar — `APPROVAL_REASSIGN`).
 */
@Controller('approvals')
@TenantScope('TENANT')
export class ApprovalController {
  constructor(
    private readonly list: ListApprovalsHandler,
    private readonly detail: GetApprovalQuery,
    private readonly decideCommand: DecideApprovalCommand,
    private readonly withdrawCommand: WithdrawApprovalCommand,
    private readonly reassignCommand: ReassignApprovalCommand,
  ) {}

  @Get()
  @ImplicitAccess(
    'APV-01 (US-057): a cobertura de aprovador (POL-03 — direto, titular/substituto, perfil com escopo sobre a unidade solicitante) é o filtro da consulta; sem cobertura, lista vazia (nunca 403).',
  )
  @ApiOperation({
    operationId: 'APV-01',
    summary: 'Listar aprovações',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Aprovações em que o usuário é aprovador designado (POL-03 · RN-INBOX-14 — direto, titular ou substituto com `allowDeputy`, detentor do perfil com escopo sobre o órgão ou a unidade solicitante) ou que ele decidiu, uma linha por aprovação. Filtros (RN-INBOX-15): `status` múltiplo (padrão `PENDING`), `subjectType`, `requestingDepartmentId` (secretaria ou setor solicitante; inexistente/de outro tenant = 422 `REFERENCE_NOT_FOUND`), `requestedFrom`/`requestedTo` (datas locais do tenant; invertido = 422) e `q` (código ou título, ≥ 2). Ordenação `requestedAt`, `dueAt`, `code` (padrão `-requestedAt`, nulos por último). `isOverdue` = `dueAt` vencido enquanto pendente (RN-INBOX-16). Sem cobertura: `data: []`. Sem valores monetários.',
        schema: approvalListResponseSchema,
      },
    },
  })
  async listApprovals(
    @ZodQuery(approvalListQuerySchema) query: ApprovalListQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PageResult<ApprovalListItemDto>> {
    const result = await this.list.execute(query);
    noStore(response);
    return new PageResult(result.items, result.meta);
  }

  @Get(':id')
  @ImplicitAccess(
    'APV-02 (US-052): APPROVAL_VIEW sobre processo visível OU designação (titular, substituto, detentor do perfil competente — POL-03), solicitante ou decisor, conferidos no caso de uso; não visível = 404 APPROVAL_NOT_FOUND.',
  )
  @ApiOperation({
    operationId: 'APV-02',
    summary: 'Obter aprovação',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Aprovação (`ETag` = versão) com os documentos cobertos na versão exata analisada e `meta`: `allowedActions` (`DECIDE` só para o designado — POL-03 — com `APPROVAL_DECIDE`, sem autoria de documento coberto e processo decidível), `decisionOptions` (saídas do workflow: devolução uma por etapa percorrida, destino e regras `TRANSITION` não satisfeitas), `decidesAsDeputy` e `decisionBlocker`. Visível sem `APPROVAL_VIEW` nem designação = 403 `PERMISSION_DENIED`; inexistente, de outro tenant ou não visível = 404 `APPROVAL_NOT_FOUND`.',
        schema: z.object({ data: approvalSchema, meta: approvalMetaSchema }),
      },
    },
  })
  async getApproval(
    @ApprovalId() id: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<ApprovalDto, ApprovalMeta>> {
    const { dto, meta } = await this.detail.execute(id);
    response.setHeader('ETag', `"${dto.version}"`);
    noStore(response);
    return new DataResult(dto, meta);
  }

  @Post(':id/decide')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @RequirePermission('APPROVAL_DECIDE', {
    detail: 'Você não tem permissão para decidir aprovações.',
  })
  @Policy('POL-03')
  @ApiOperation({
    operationId: 'APV-03',
    summary: 'Decidir aprovação',
    tags: TAGS,
    idempotent: true,
    auditActions: [
      'approval.decide',
      'approval.request',
      'document.version_create',
      'document.submit',
    ],
    responses: {
      200: {
        description:
          'Aprovação decidida (`ETag` = nova versão) com a etapa e o status do processo (`processStage`, `processStatus`; `null` na avulsa) e a próxima aprovação encadeada (`chainedApprovalId`). Uma transação: trava do processo e da aprovação; já decidida = 409 `APPROVAL_NOT_PENDING` (antes do `If-Match`: 412 `VERSION_CONFLICT`); POL-03 (403 `NOT_DESIGNATED_APPROVER`/`SELF_APPROVAL_FORBIDDEN`, auditados como `access.denied`); processo suspenso ou final = 409 `INVALID_PROCESS_STATUS`; motor de workflow (422 `TRANSITION_NOT_AVAILABLE`/`TRANSITION_BLOCKED`/`WARNINGS_NOT_ACKNOWLEDGED`; mais de uma devolução sem `transitionId` = 422 `VALIDATION_ERROR`); aprovador da próxima etapa (422 `APPROVER_UNRESOLVED`). Efeitos: documentos cobertos (DEC-018), renderização `APPROVAL_STAMPED` `PENDING` (fila só depois do commit), mudança de etapa/status (destino `END` conclui o processo) e eventos `ApprovalCompleted`/`ApprovalReturned`/`ApprovalRejected`, `ProcessStageChanged`, `ProcessStatusChanged`, `ApprovalRequested`.',
        schema: dataEnvelope(decidedApprovalSchema),
      },
    },
  })
  async decide(
    @ApprovalId() id: string,
    @ZodBody(decideApprovalSchema) body: DecideApproval,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DecidedApprovalDto> {
    const result = await this.decideCommand.execute({
      approvalId: id,
      body,
      expectedVersion: ifMatch?.value ?? 0,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('ETag', `"${result.dto.version}"`);
    noStore(response);
    return result.dto;
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @ImplicitAccess(
    'APV-04 (US-053): POL-17 no caso de uso — etapa: `PROCESS_FORWARD` sobre a unidade de origem e ser o solicitante ou lotado nela (custódia anterior); avulsa: permissão de submissão do tipo cobrindo o processo. Sem custódia/permissão = 403 PERMISSION_DENIED (`access.denied`).',
  )
  @Policy('POL-17')
  @ApiOperation({
    operationId: 'APV-04',
    summary: 'Retirar aprovação',
    tags: TAGS,
    idempotent: true,
    auditActions: ['approval.withdraw', 'document.withdraw'],
    responses: {
      200: {
        description:
          'Aprovação `CANCELED` (`WITHDRAWN`; `ETag` = nova versão) com a etapa e o status atuais do processo (`null` na avulsa). Uma transação: trava do processo e da aprovação; já decidida ou retirada = 409 `APPROVAL_NOT_PENDING` (antes do `If-Match`: 412 `VERSION_CONFLICT`); sem custódia anterior (POL-17) = 403 `PERMISSION_DENIED` auditado; processo suspenso ou final = 409 `INVALID_PROCESS_STATUS`. Efeitos: documentos cobertos `IN_REVIEW` → `DRAFT` (os demais só perdem `pendingApprovalId` — DEC-018) e, na etapa, a devolução à passagem de origem (tramitação `RETURN` com `metadata.withdrawn`, processo `RETURNED`, responsável anterior). Eventos `ApprovalCanceled` (`WITHDRAWN`), `ProcessStageChanged` (`return`), `ProcessStatusChanged`, `DocumentWithdrawn`.',
        schema: dataEnvelope(withdrawnApprovalSchema),
      },
    },
  })
  async withdraw(
    @ApprovalId() id: string,
    @ZodBody(withdrawApprovalSchema) body: WithdrawApproval,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WithdrawnApprovalDto> {
    const result = await this.withdrawCommand.execute({
      approvalId: id,
      body,
      expectedVersion: ifMatch?.value ?? 0,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('ETag', `"${result.dto.version}"`);
    noStore(response);
    return result.dto;
  }

  @Post(':id/reassign')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @RequirePermission('APPROVAL_REASSIGN', {
    detail: 'Você não tem permissão para redirecionar aprovações.',
  })
  @ApiOperation({
    operationId: 'APV-05',
    summary: 'Redirecionar aprovação',
    tags: TAGS,
    idempotent: true,
    auditActions: ['approval.reassign'],
    responses: {
      200: {
        description:
          'Aprovação ainda `PENDING` com o novo aprovador (`ETag` = nova versão); título, prazo, solicitante e documentos cobertos preservados (RN-TRAM-70). Uma transação: já decidida ou retirada = 409 `APPROVAL_NOT_PENDING` (antes do `If-Match`: 412 `VERSION_CONFLICT`); `APPROVAL_REASSIGN` que não cobre o processo = 403 `PERMISSION_DENIED`; processo suspenso ou final = 409 `INVALID_PROCESS_STATUS`; novo aprovador igual ao atual ou inelegível (vínculo ativo; perfil com `APPROVAL_DECIDE` e detentor competente sobre a unidade solicitante; titular atual da unidade) = 422 `APPROVER_NOT_ELIGIBLE`; autor de documento coberto com `approval.preventSelfApproval` = 403 `SELF_APPROVAL_FORBIDDEN`; motivo ausente/curto = 422 `VALIDATION_ERROR` (`TOO_SHORT`). Efeitos: `ApprovalReassigned` (timeline e troca do `ProcessAccess` `APPROVER`; aviso `APPROVAL_REASSIGNED`).',
        schema: dataEnvelope(approvalSchema),
      },
    },
  })
  async reassign(
    @ApprovalId() id: string,
    @ZodBody(reassignApprovalSchema) body: ReassignApproval,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ApprovalDto> {
    const result = await this.reassignCommand.execute({
      approvalId: id,
      body,
      expectedVersion: ifMatch?.value ?? 0,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('ETag', `"${result.dto.version}"`);
    noStore(response);
    return result.dto;
  }
}
