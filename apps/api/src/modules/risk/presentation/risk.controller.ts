import {
  createRiskSchema,
  dataEnvelope,
  processIdParamsSchema,
  riskIdParamsSchema,
  riskListMetaSchema,
  riskListQuerySchema,
  riskSchema,
  updateRiskSchema,
} from '@contrataflow/validation';
import type {
  CreateRisk,
  RiskDto,
  RiskListMetaDto,
  RiskListQuery,
  UpdateRisk,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import { ApiError } from '#shared/errors/api-error.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  CreateRiskCommand,
  DeleteRiskCommand,
  UpdateRiskCommand,
} from '../application/risk.commands.js';
import { GetRiskQuery, ListRisksQuery } from '../application/risk.queries.js';

const TAGS = ['Riscos'];

/** Identificador do caminho que não é UUIDv7 = 400 `MALFORMED_REQUEST` (não é campo — sem 422). */
class UuidV7Pipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = riskIdParamsSchema.shape.id.safeParse(value);
    if (!parsed.success) {
      throw new ApiError('MALFORMED_REQUEST', { detail: 'Requisição inválida.' });
    }
    return parsed.data;
  }
}

/** `@PathId('process' | 'risk')`: valida o `:id` do caminho e documenta-o no OpenAPI. */
function PathId(kind: 'process' | 'risk'): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('id', new UuidV7Pipe())(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(
        target,
        propertyKey,
        'params',
        kind === 'process' ? processIdParamsSchema : riskIdParamsSchema,
      );
    }
  };
}

/** Lista mutável e personalizada (`meta.canManage` por usuário): nenhum cache intermediário. */
function noStore(response: HttpResponse): void {
  response.setHeader('Cache-Control', 'no-store');
}

const READ_ACCESS =
  'Riscos do processo (US-033 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 NOT_FOUND igual ao inexistente.';
const WRITE_ACCESS =
  'RISK_MANAGE cobrindo o processo — por perfil ou por participação COLLABORATOR/CONSULTANT (permissions.md §4) — conferida no caso de uso com a POL-02 estendida (RN-RISK-09); sem permissão = 403 PERMISSION_DENIED com access.denied.';
const WRITE_RULES =
  '`RISK_MANAGE` cobrindo o processo (403 `PERMISSION_DENIED`) + custódia ou participação `COLLABORATOR`/`CONSULTANT` (403) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`) + `RISK_MAP` permitido na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) + documento `RISK_MAP` existente em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`).';

const RISK_LIST_RESPONSE = z.object({ data: z.array(riskSchema), meta: riskListMetaSchema });

/**
 * Riscos do processo (api/08-risks.md · US-033): RSK-01/RSK-02 sob `/processes/{id}/risks` e
 * RSK-03..05 sob `/risks/{id}`. A permissão (`RISK_MANAGE` — que a participação também concede) e
 * a POL-02 são conferidas no caso de uso, sobre o processo, com o `RISK_MAP` travado.
 */
@Controller()
@TenantScope('TENANT')
export class RiskController {
  constructor(
    private readonly list: ListRisksQuery,
    private readonly get: GetRiskQuery,
    private readonly create: CreateRiskCommand,
    private readonly update: UpdateRiskCommand,
    private readonly remove: DeleteRiskCommand,
  ) {}

  @Get('processes/:id/risks')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'RSK-01',
    summary: 'Listar riscos do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Riscos não excluídos por `sortOrder`/`code`, filtráveis por `phase`, `categoryId` e `status`. `meta`: escala vigente (`scale`, `levelThresholds`), o documento `RISK_MAP` do processo e se o usuário pode gerenciar agora (`canManage`/`lockReason` — FA-04).',
        schema: RISK_LIST_RESPONSE,
      },
    },
  })
  async listRisks(
    @PathId('process') id: string,
    @ZodQuery(riskListQuerySchema) query: RiskListQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<RiskDto[], RiskListMetaDto>> {
    const { risks, meta } = await this.list.execute(id, query);
    noStore(response);
    return new DataResult(risks, meta);
  }

  @Post('processes/:id/risks')
  @Idempotent()
  @ImplicitAccess(WRITE_ACCESS)
  @ApiOperation({
    operationId: 'RSK-02',
    summary: 'Registrar risco',
    tags: TAGS,
    idempotent: true,
    auditActions: ['risk.create'],
    responses: {
      201: {
        description: `Risco com o próximo código do processo (\`R01\`, \`R02\`… — nunca reaproveitado, RN-RISK-02), \`score\` = probabilidade × impacto, \`level\` pelas faixas vigentes e \`scaleSnapshot\` (RN-RISK-03/04); \`Location\` e \`ETag\` = versão. Graus fora de \`[1, risk.scale.max]\` → 422 \`OUT_OF_RANGE\`; categoria inexistente, de outro tenant ou inativa → 422 \`REFERENCE_NOT_FOUND\`/\`REFERENCE_INACTIVE\`. Grava \`risk.create\` e \`RiskCreated\` (timeline \`RISK_ADDED\`). ${WRITE_RULES}`,
        schema: dataEnvelope(riskSchema),
      },
    },
  })
  async createRisk(
    @PathId('process') id: string,
    @ZodBody(createRiskSchema) body: CreateRisk,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RiskDto> {
    const { dto } = await this.create.execute({ processId: id, body });
    response.setHeader('Location', `/api/v1/risks/${dto.id}`);
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Get('risks/:id')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'RSK-03',
    summary: 'Obter risco',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Risco com os tratamentos vinculados (`ETag` = versão, o `If-Match` de RSK-04/05). Inexistente, excluído, de outro tenant ou de processo não visível = 404 `NOT_FOUND`.',
        schema: dataEnvelope(riskSchema),
      },
    },
  })
  async getRisk(
    @PathId('risk') id: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RiskDto> {
    const dto = await this.get.execute(id);
    response.setHeader('ETag', `"${String(dto.version)}"`);
    noStore(response);
    return dto;
  }

  @Patch('risks/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @ApiOperation({
    operationId: 'RSK-04',
    summary: 'Atualizar/avaliar risco',
    tags: TAGS,
    auditActions: ['risk.update', 'risk.assess'],
    responses: {
      200: {
        description: `Risco atualizado (\`ETag\` = nova versão). Probabilidade e/ou impacto alterados recalculam \`score\`/\`level\` pela escala vigente, gravam novo \`scaleSnapshot\` e emitem \`RiskAssessed\` (mesmo sem mudança de nível) com \`risk.assess\`; demais edições gravam \`risk.update\`. Residuais em par (422 \`CONDITIONAL_REQUIRED\`). \`If-Match\` divergente → 412 \`VERSION_CONFLICT\` com \`currentVersion\`. ${WRITE_RULES}`,
        schema: dataEnvelope(riskSchema),
      },
    },
  })
  async updateRisk(
    @PathId('risk') id: string,
    @ZodBody(updateRiskSchema) body: UpdateRisk,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RiskDto> {
    const { dto } = await this.update.execute({
      riskId: id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Delete('risks/:id')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @ApiOperation({
    operationId: 'RSK-05',
    summary: 'Excluir risco',
    tags: TAGS,
    auditActions: ['risk.delete'],
    responses: {
      204: {
        description: `Exclusão lógica do risco e, em cascata, dos tratamentos vinculados (RN-RISK-10); o código não é reaproveitado. Grava \`risk.delete\` e \`RiskDeleted\` (timeline \`RISK_REMOVED\`). \`If-Match\` divergente → 412 \`VERSION_CONFLICT\`. ${WRITE_RULES}`,
      },
    },
  })
  async deleteRisk(
    @PathId('risk') id: string,
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ riskId: id, expectedVersion: ifMatch?.value ?? 0 });
  }
}
