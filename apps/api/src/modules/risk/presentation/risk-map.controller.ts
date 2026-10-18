import {
  dataEnvelope,
  documentMetaSchema,
  documentSchema,
  riskMapCreateSchema,
  riskMatrixQuerySchema,
  riskMatrixSchema,
} from '@contrataflow/validation';
import type {
  DocumentDto,
  DocumentMeta,
  RiskMapCreate,
  RiskMatrixDto,
  RiskMatrixQuery,
} from '@contrataflow/validation';
import { Controller, Get, Headers, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { PathId } from './risk.controller.js';
import { CreateRiskMapCommand } from '../application/risk-map.commands.js';
import { GetRiskMatrixQuery } from '../application/risk.queries.js';

const TAGS = ['Riscos'];

const READ_ACCESS =
  'Matriz de riscos (US-035 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível ou de outro tenant = 404 NOT_FOUND igual ao inexistente.';
const CREATE_ACCESS =
  'RISK_MANAGE cobrindo o processo — por perfil ou por participação COLLABORATOR/CONSULTANT — (403 PERMISSION_DENIED com access.denied) + POL-02 (custódia OU participação; processo em DRAFT/IN_PROGRESS/RETURNED — senão 409 INVALID_PROCESS_STATUS; RISK_MAP permitido na etapa — senão 422), conferidos no caso de uso, como em RN-RISK-09.';

/**
 * Matriz e Mapa de Riscos (api/08-risks.md · US-035): RSK-09 (leitura) e RSK-10 (emissão) sob
 * `/processes/{id}`. O Mapa de Riscos é um `Document` `RISK_MAP`: validação, submissão,
 * finalização e reabertura usam DOC-08/09/10/12 (o ciclo de vida genérico da US-065).
 */
@Controller()
@TenantScope('TENANT')
export class RiskMapController {
  constructor(
    private readonly matrix: GetRiskMatrixQuery,
    private readonly create: CreateRiskMapCommand,
  ) {}

  @Get('processes/:id/risk-matrix')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'RSK-09',
    summary: 'Obter matriz de riscos',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Grade probabilidade × impacto da escala e das faixas VIGENTES do tenant (RN-RISK-18 — não o `scaleSnapshot` de cada risco): todas as `scale.max²` células (probabilidade decrescente, impacto crescente) com `score`, `level` e os riscos não excluídos (`id`, `code`, `title`, por código); grau acima do máximo vigente fica na borda. Filtros `phase`, `categoryId` e `status` (não persistidos). Disponível em qualquer status do `RISK_MAP` (RN-RISK-24 — lê os riscos atuais, não a versão congelada).',
        schema: dataEnvelope(riskMatrixSchema),
      },
    },
  })
  async getMatrix(
    @PathId('process') id: string,
    @ZodQuery(riskMatrixQuerySchema) query: RiskMatrixQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RiskMatrixDto> {
    const matrix = await this.matrix.execute(id, query);
    response.setHeader('Cache-Control', 'no-store');
    return matrix;
  }

  @Post('processes/:id/risk-map')
  @Idempotent()
  @ImplicitAccess(CREATE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'RSK-10',
    summary: 'Emitir Mapa de Riscos',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.create'],
    responses: {
      201: {
        description:
          'Cria o `Document` `RISK_MAP` (`STRUCTURED`, singular por processo — RN-RISK-19) em `DRAFT` com o título "Mapa de Riscos", a partir da versão publicada do template padrão do tipo (US-110), numerado pela máscara do tipo. Já existe `RISK_MAP` não cancelado → 409 `DOCUMENT_ALREADY_EXISTS` (`meta.existingDocumentId`); processo sem nenhum risco → 422 `BUSINESS_RULE_VIOLATION` (`RISK_LIST_EMPTY`); fora da etapa → 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`. O conteúdo tipado são os riscos vigentes: o snapshot só é gravado na submissão/finalização (DOC-09/10 — RN-RISK-20), quando também valem as pendências `RISK_TREATMENT_REQUIRED_FOR_LEVEL` (DOC-08). Grava `document.create`, `DocumentCreated` (`document.created.risk_map`) e a timeline `DOCUMENT_CREATED`. `Location: /api/v1/documents/{id}` e `ETag: "1"`; reenvio com a mesma chave = mesma resposta com `Idempotent-Replayed: true`.',
        schema: z.object({ data: documentSchema, meta: documentMetaSchema }),
      },
    },
  })
  async createRiskMap(
    @PathId('process') id: string,
    @ZodBody(riskMapCreateSchema) _body: RiskMapCreate,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<DocumentDto, DocumentMeta>> {
    const created = await this.create.execute({
      processId: id,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/documents/${created.dto.id}`);
    response.setHeader('ETag', `"${String(created.dto.version)}"`);
    return new DataResult(created.dto, created.meta);
  }
}
