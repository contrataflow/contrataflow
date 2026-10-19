import {
  approvalMetaSchema,
  approvalSchema,
  dataEnvelope,
  decideApprovalSchema,
  decidedApprovalSchema,
} from '@contrataflow/validation';
import type {
  ApprovalDto,
  ApprovalMeta,
  DecideApproval,
  DecidedApprovalDto,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy, RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import { DecideApprovalCommand } from '../application/decide-approval.command.js';
import { GetApprovalQuery } from '../application/get-approval.query.js';

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
 * Aprovações (api/11-approvals-inbox.md · US-052): APV-02 (detalhe com `meta.allowedActions`,
 * opções de decisão e o motivo de não poder decidir) e APV-03 (decidir — aprovar, devolver ou
 * indeferir, com os efeitos atômicos no processo e nos documentos). `APPROVAL_DECIDE` em algum
 * escopo no guard (com o 2º fator — risco H, POL-14); POL-03 no caso de uso.
 */
@Controller('approvals')
@TenantScope('TENANT')
export class ApprovalController {
  constructor(
    private readonly detail: GetApprovalQuery,
    private readonly decideCommand: DecideApprovalCommand,
  ) {}

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
}
