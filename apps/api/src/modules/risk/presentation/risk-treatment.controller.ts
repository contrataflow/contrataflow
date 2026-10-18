import {
  createRiskTreatmentSchema,
  dataEnvelope,
  riskTreatmentIdParamsSchema,
  riskTreatmentSchema,
  updateRiskTreatmentSchema,
} from '@contrataflow/validation';
import type {
  CreateRiskTreatment,
  RiskTreatmentDto,
  UpdateRiskTreatment,
} from '@contrataflow/validation';
import { Controller, Delete, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import { PathId, UuidV7Pipe } from './risk.controller.js';
import {
  CreateRiskTreatmentCommand,
  DeleteRiskTreatmentCommand,
  UpdateRiskTreatmentCommand,
} from '../application/risk-treatment.commands.js';

const TAGS = ['Riscos'];

/** `:treatmentId` do caminho (UUIDv7; senão 400 `MALFORMED_REQUEST`), documentado no OpenAPI. */
function TreatmentPathId(): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('treatmentId', new UuidV7Pipe())(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(target, propertyKey, 'params', riskTreatmentIdParamsSchema);
    }
  };
}

const WRITE_ACCESS =
  'RISK_MANAGE cobrindo o processo do risco — por perfil ou por participação COLLABORATOR/CONSULTANT (permissions.md §4) — conferida no caso de uso com a POL-02 estendida (RN-RISK-16 = RN-RISK-09); sem permissão = 403 PERMISSION_DENIED com access.denied.';
const WRITE_RULES =
  '`RISK_MANAGE` cobrindo o processo (403 `PERMISSION_DENIED`) + custódia ou participação `COLLABORATOR`/`CONSULTANT` (403) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`) + `RISK_MAP` permitido na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) + documento `RISK_MAP` existente em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`).';

/**
 * Ações de tratamento dos riscos (api/08-risks.md · US-034): RSK-06 sob `/risks/{id}/treatments` e
 * RSK-07/08 sob `/risk-treatments/{treatmentId}`. A leitura vem nos riscos (RSK-01/03 —
 * `Risk.treatments`). Permissão e POL-02 conferidas no caso de uso, com o `RISK_MAP` travado.
 */
@Controller()
@TenantScope('TENANT')
export class RiskTreatmentController {
  constructor(
    private readonly create: CreateRiskTreatmentCommand,
    private readonly update: UpdateRiskTreatmentCommand,
    private readonly remove: DeleteRiskTreatmentCommand,
  ) {}

  @Post('risks/:id/treatments')
  @Idempotent()
  @ImplicitAccess(WRITE_ACCESS)
  @ApiOperation({
    operationId: 'RSK-06',
    summary: 'Criar ação de tratamento',
    tags: TAGS,
    idempotent: true,
    auditActions: ['risk.treatment_create'],
    responses: {
      201: {
        description: `Tratamento com \`status = PLANNED\` (RN-RISK-11), ao fim da lista do risco (\`sortOrder\`); \`ETag\` = versão. O primeiro tratamento ativo de um risco \`OPEN\` o leva a \`IN_TREATMENT\` na mesma transação (RN-RISK-14). Responsável ou unidade inexistente, inativo ou de outro tenant → 422 \`REFERENCE_NOT_FOUND\`/\`REFERENCE_INACTIVE\`. Grava \`risk.treatment_create\` e \`RiskTreatmentChanged\` (\`CREATED\`, sem timeline). Risco inexistente, excluído ou de processo não visível → 404. ${WRITE_RULES}`,
        schema: dataEnvelope(riskTreatmentSchema),
      },
    },
  })
  async createTreatment(
    @PathId('risk') id: string,
    @ZodBody(createRiskTreatmentSchema) body: CreateRiskTreatment,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RiskTreatmentDto> {
    const { dto } = await this.create.execute({ riskId: id, body });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Patch('risk-treatments/:treatmentId')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @ApiOperation({
    operationId: 'RSK-07',
    summary: 'Atualizar ação de tratamento',
    tags: TAGS,
    auditActions: ['risk.treatment_update'],
    responses: {
      200: {
        description: `Tratamento atualizado (\`ETag\` = nova versão). \`status\` segue RN-RISK-15 (\`PLANNED → IN_PROGRESS → DONE\`; não terminais → \`CANCELED\`; \`DONE\`/\`CANCELED\` terminais) — fora disso 409 \`INVALID_STATE\`; \`DONE\` grava \`completedAt\` e sair dele o limpa (RN-RISK-12). \`sortOrder\` reordena (FA-02). Cancelar não reverte o status do risco (FA-04). Grava \`risk.treatment_update\` e \`RiskTreatmentChanged\` (\`UPDATED\`/\`STATUS_CHANGED\`). \`If-Match\` divergente → 412 \`VERSION_CONFLICT\` com \`currentVersion\`. ${WRITE_RULES}`,
        schema: dataEnvelope(riskTreatmentSchema),
      },
    },
  })
  async updateTreatment(
    @TreatmentPathId() treatmentId: string,
    @ZodBody(updateRiskTreatmentSchema) body: UpdateRiskTreatment,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RiskTreatmentDto> {
    const { dto } = await this.update.execute({
      treatmentId,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Delete('risk-treatments/:treatmentId')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @ApiOperation({
    operationId: 'RSK-08',
    summary: 'Excluir ação de tratamento',
    tags: TAGS,
    auditActions: ['risk.treatment_delete'],
    responses: {
      204: {
        description: `Exclusão lógica do tratamento (RN-RISK-17): não afeta o código do risco, os demais tratamentos nem o status do risco (FA-04). Grava \`risk.treatment_delete\` e \`RiskTreatmentChanged\` (\`DELETED\`). \`If-Match\` divergente → 412 \`VERSION_CONFLICT\`. ${WRITE_RULES}`,
      },
    },
  })
  async deleteTreatment(
    @TreatmentPathId() treatmentId: string,
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ treatmentId, expectedVersion: ifMatch?.value ?? 0 });
  }
}
