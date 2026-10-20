import {
  createPriceSourceSchema,
  dataEnvelope,
  excludeQuotationSchema,
  pageMetaSchema,
  pageQuerySchema,
  priceResearchIdParamsSchema,
  priceSourceIdParamsSchema,
  priceSourceSchema,
  quotationIdParamsSchema,
  quotationSchema,
  updatePriceSourceSchema,
  updateQuotationSchema,
  upsertQuotationsSchema,
} from '@contrataflow/validation';
import type {
  CreatePriceSource,
  ExcludeQuotation,
  PageQuery,
  PriceSourceDto,
  QuotationDto,
  UpdatePriceSource,
  UpdateQuotation,
  UpsertQuotations,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Patch, Post, Put, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  CreatePriceSourceCommand,
  DeletePriceSourceCommand,
  DeleteQuotationCommand,
  ExcludeQuotationCommand,
  RestoreQuotationCommand,
  UpdatePriceSourceCommand,
  UpdateQuotationCommand,
  UpsertQuotationsCommand,
} from '../application/price-source.commands.js';
import { ListPriceSourcesQuery } from '../application/price-source.queries.js';

const TAGS = ['Pesquisa de preços'];

const READ_ACCESS =
  'Fontes da pesquisa (US-026 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 NOT_FOUND igual ao inexistente. Preços sob POL-09 (RN-PRICE-12).';
const WRITE_ACCESS =
  'PRICE_RESEARCH_UPDATE cobrindo o processo — por perfil ou por participação COLLABORATOR/CONSULTANT — com a POL-02 estendida e POL-09 em processo sigiloso (RN-PRICE-10/12), conferidas no caso de uso; sem permissão = 403 PERMISSION_DENIED com access.denied.';
const WRITE_RULES =
  '`PRICE_RESEARCH_UPDATE` cobrindo o processo (403 `PERMISSION_DENIED`) + custódia ou participação `COLLABORATOR`/`CONSULTANT` (403) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`) + tipo permitido na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) + documento em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`) + POL-09 em processo sigiloso (403 `PERMISSION_DENIED`, `reasonCode = POL-09`). Todo commit recalcula a pesquisa (RN-PRICE-27: cotações válidas, alertas, contadores, `lastCalculatedAt`) e emite `PriceResearchRecalculated` (`price_research.recalculated`).';
const EXCLUDE_ACCESS =
  'PRICE_RESEARCH_EXCLUDE_QUOTATION cobrindo o processo — por perfil ou por participação COLLABORATOR/CONSULTANT — com a POL-02 estendida e POL-09 em processo sigiloso, conferidas no caso de uso; sem permissão = 403 PERMISSION_DENIED com access.denied (reasonCode = PRICE_RESEARCH_EXCLUDE_QUOTATION).';
const EXCLUDE_RULES =
  '`PRICE_RESEARCH_EXCLUDE_QUOTATION` cobrindo o processo (403 `PERMISSION_DENIED`) + custódia ou participação `COLLABORATOR`/`CONSULTANT` (403) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`) + tipo permitido na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) + documento em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`) + POL-09 em processo sigiloso (403 `PERMISSION_DENIED`, `reasonCode = POL-09`). `If-Match` = versão da cotação (412 `VERSION_CONFLICT` com `currentVersion`; ausente → 428). Responde a cotação; `ETag` = nova versão. A fonte ganha versão nova. Recalcula a pesquisa (RN-PRICE-34) e emite `PriceResearchRecalculated` (`price_research.recalculated`) logo depois do evento da transição.';
const SOURCE_RULES =
  'Tipo ativo do catálogo `PRICE_SOURCE_TYPE` do tenant (422 `VALIDATION_ERROR` `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `sourceTypeId`); descrição 1–300; `url` iniciada por `https://` (422 `INVALID_FORMAT`); `quoteDate`/`accessedAt` não futuras (422 `DATE_IN_PAST`); campos de `requiredFields` do tipo presentes (422 `QUOTATION_REQUIRED_FIELDS`, um erro `CONDITIONAL_REQUIRED` por campo — o anexo segue o ATT-02 com alvo `PRICE_SOURCE` depois de a fonte existir, RN-PRICE-28); `supplierId` de fornecedor ativo do tenant (422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`).';

/**
 * Fontes de pesquisa e cotações (api/07 · US-026): PRS-09/10 sob `/price-research/{id}/sources`,
 * PRS-11/12/13 sob `/price-sources/{sourceId}` e PRS-14/15 sob `/quotations/{quotationId}`.
 */
@Controller()
@TenantScope('TENANT')
export class PriceSourceController {
  constructor(
    private readonly list: ListPriceSourcesQuery,
    private readonly create: CreatePriceSourceCommand,
    private readonly update: UpdatePriceSourceCommand,
    private readonly remove: DeletePriceSourceCommand,
    private readonly upsert: UpsertQuotationsCommand,
    private readonly updateOne: UpdateQuotationCommand,
    private readonly removeOne: DeleteQuotationCommand,
    private readonly exclude: ExcludeQuotationCommand,
    private readonly restore: RestoreQuotationCommand,
  ) {}

  @Get('price-research/:id/sources')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'PRS-09',
    summary: 'Listar fontes da pesquisa',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Fontes por ordem de registro, com o tipo (campos exigidos e validade), o fornecedor e as cotações de cada uma (`isExpired`, `status`). Sem POL-09 em processo sigiloso: `unitPrice: null` + `unitPriceMasked: true`. Pesquisa inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: z.object({ data: z.array(priceSourceSchema), meta: pageMetaSchema }),
      },
    },
  })
  async listSources(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @ZodQuery(pageQuerySchema) query: PageQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PageResult<PriceSourceDto>> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(params.id, query);
    return new PageResult(result.items, result.meta);
  }

  @Post('price-research/:id/sources')
  @Idempotent()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-10',
    summary: 'Criar fonte de pesquisa',
    tags: TAGS,
    idempotent: true,
    auditActions: ['price_research.source_create'],
    responses: {
      201: {
        description: `${SOURCE_RULES} Grava \`price_research.source_create\` (\`metadata.sourceTypeId\`). \`ETag\` = versão da fonte; reenvio com a mesma \`Idempotency-Key\` = mesma resposta com \`Idempotent-Replayed: true\`. ${WRITE_RULES}`,
        schema: dataEnvelope(priceSourceSchema),
      },
    },
  })
  async createSource(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @ZodBody(createPriceSourceSchema) body: CreatePriceSource,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PriceSourceDto> {
    const { dto } = await this.create.execute({ researchId: params.id, body });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Patch('price-sources/:sourceId')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-11',
    summary: 'Atualizar fonte de pesquisa',
    tags: TAGS,
    auditActions: ['price_research.source_update'],
    responses: {
      200: {
        description: `Campos de PRS-10, parciais (\`null\` apaga um opcional). Trocar o tipo reavalia os campos exigidos (FA-01); tipo e datas reavaliam a validade das cotações da fonte (RN-PRICE-26). ${SOURCE_RULES} Grava \`price_research.source_update\` (\`changes\` dos campos; texto livre como impressão digital). \`If-Match\` divergente → 412 \`VERSION_CONFLICT\` com \`currentVersion\`; ausente → 428. ${WRITE_RULES}`,
        schema: dataEnvelope(priceSourceSchema),
      },
    },
  })
  async updateSource(
    @ZodParams(priceSourceIdParamsSchema) params: { sourceId: string },
    @ZodBody(updatePriceSourceSchema) body: UpdatePriceSource,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PriceSourceDto> {
    const { dto } = await this.update.execute({
      sourceId: params.sourceId,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Delete('price-sources/:sourceId')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-12',
    summary: 'Remover fonte de pesquisa',
    tags: TAGS,
    auditActions: ['price_research.source_delete'],
    responses: {
      204: {
        description: `Remoção física da fonte e, em cascata, das cotações dela (RN-PRICE-29 — não pode ser desfeita). \`If-Match\` = versão da fonte (412 \`VERSION_CONFLICT\`). Grava \`price_research.source_delete\` (\`metadata.quotationsRemoved\`). ${WRITE_RULES}`,
      },
    },
  })
  async deleteSource(
    @ZodParams(priceSourceIdParamsSchema) params: { sourceId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ sourceId: params.sourceId, expectedVersion: ifMatch?.value ?? 0 });
  }

  @Put('price-sources/:sourceId/quotations')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-13',
    summary: 'Lançar cotações da fonte (grade)',
    tags: TAGS,
    idempotent: true,
    auditActions: ['price_research.quotation_create', 'price_research.quotation_update'],
    responses: {
      200: {
        description: `Grade com uma linha por item da pesquisa (RN-PRICE-24): linha sem preço não altera nada; com preço, cria ou atualiza a cotação do item nesta fonte (única por item e fonte — RN-PRICE-25). Item fora da pesquisa → 422 \`REFERENCE_NOT_FOUND\` em \`items[i].priceItemId\`; repetido → 422 \`DUPLICATE_IN_LIST\`; preço ausente, ≤ 0 ou com mais casas que \`unitPriceDecimals\` → 422 \`INVALID_DECIMAL\` em \`items[i].unitPrice\` (nada gravado); linha sobre cotação \`EXCLUDED\` → 409 \`INVALID_STATE\` (restaurar antes — PRS-17). \`isExpired\` recalculado pela regra do tipo. Responde as cotações da fonte; \`ETag\` = nova versão da fonte. \`If-Match\` = versão da fonte (412 \`VERSION_CONFLICT\` — duas gravações simultâneas: uma 200, outra 412). \`Idempotency-Key\` opcional (FA-07: reenvio = mesma resposta com \`Idempotent-Replayed: true\`). Grava \`price_research.quotation_create\`/\`quotation_update\` por linha (\`metadata.priceItemId\`/\`priceSourceId\`). ${WRITE_RULES}`,
        schema: dataEnvelope(z.array(quotationSchema)),
      },
    },
  })
  async upsertQuotations(
    @ZodParams(priceSourceIdParamsSchema) params: { sourceId: string },
    @ZodBody(upsertQuotationsSchema) body: UpsertQuotations,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<QuotationDto[]> {
    const result = await this.upsert.execute({
      sourceId: params.sourceId,
      body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(result.sourceVersion)}"`);
    return result.quotations;
  }

  @Patch('quotations/:quotationId')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-14',
    summary: 'Atualizar cotação individual',
    tags: TAGS,
    auditActions: ['price_research.quotation_update'],
    responses: {
      200: {
        description: `Preço (> 0, casas do snapshot — 422 \`INVALID_DECIMAL\` em \`unitPrice\`) e/ou marca/modelo (≤ 200). Cotação \`EXCLUDED\` → 409 \`INVALID_STATE\`. \`outlierFlag\`/\`isExpired\` são calculados (US-030 · RN-PRICE-48/49): no corpo → 422 \`NOT_ALLOWED\` no campo; a resposta traz os valores já recalculados. \`If-Match\` = versão da cotação (412 \`VERSION_CONFLICT\`); a fonte ganha versão nova. Grava \`price_research.quotation_update\`. ${WRITE_RULES}`,
        schema: dataEnvelope(quotationSchema),
      },
    },
  })
  async updateQuotation(
    @ZodParams(quotationIdParamsSchema) params: { quotationId: string },
    @ZodBody(updateQuotationSchema) body: UpdateQuotation,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<QuotationDto> {
    const dto = await this.updateOne.execute({
      quotationId: params.quotationId,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Delete('quotations/:quotationId')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-15',
    summary: 'Remover cotação',
    tags: TAGS,
    auditActions: ['price_research.quotation_delete'],
    responses: {
      204: {
        description: `Remoção física da cotação (FA-04 — sem motivo; a exclusão justificada é a PRS-16). \`If-Match\` = versão da cotação (412 \`VERSION_CONFLICT\`); a fonte ganha versão nova. Grava \`price_research.quotation_delete\`. ${WRITE_RULES}`,
      },
    },
  })
  async deleteQuotation(
    @ZodParams(quotationIdParamsSchema) params: { quotationId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.removeOne.execute({
      quotationId: params.quotationId,
      expectedVersion: ifMatch?.value ?? 0,
    });
  }

  @Post('quotations/:quotationId/exclude')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(EXCLUDE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-16',
    summary: 'Desconsiderar cotação',
    tags: TAGS,
    auditActions: ['price_research.quotation_exclude'],
    responses: {
      200: {
        description: `Desconsidera a cotação (\`VALID\` → \`EXCLUDED\`, RN-PRICE-30): \`exclusionReason\` (enum \`ExclusionReason\` — ausente → 422 \`VALIDATION_ERROR\` \`REQUIRED\`) e \`exclusionJustification\` com no mínimo 20 caracteres (422 \`TOO_SHORT\`). Grava motivo, justificativa, autor e momento; a cotação permanece listada, fora dos cálculos (RN-PRICE-31). Já \`EXCLUDED\` → 409 \`INVALID_STATE\`. Desconsiderar a última cotação válida do item não é bloqueado (RN-PRICE-33). Grava \`price_research.quotation_exclude\` (\`metadata.reason\`; justificativa só como impressão digital) e emite \`QuotationExcluded\` (\`price_research.quotation_excluded\`) + entrada na timeline. ${EXCLUDE_RULES}`,
        schema: dataEnvelope(quotationSchema),
      },
    },
  })
  async excludeQuotation(
    @ZodParams(quotationIdParamsSchema) params: { quotationId: string },
    @ZodBody(excludeQuotationSchema) body: ExcludeQuotation,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<QuotationDto> {
    const { dto } = await this.exclude.execute({
      quotationId: params.quotationId,
      body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Post('quotations/:quotationId/restore')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(EXCLUDE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-17',
    summary: 'Restaurar cotação',
    tags: TAGS,
    auditActions: ['price_research.quotation_restore'],
    responses: {
      200: {
        description: `Restaura a cotação (\`EXCLUDED\` → \`VALID\`, RN-PRICE-32): limpa motivo, justificativa, autor e momento da exclusão; volta a participar do cálculo. Já \`VALID\` → 409 \`INVALID_STATE\`. Sem corpo. Grava \`price_research.quotation_restore\` (\`metadata.priceItemId\`) e emite \`QuotationRestored\` (\`price_research.quotation_restored\`) + entrada na timeline. ${EXCLUDE_RULES}`,
        schema: dataEnvelope(quotationSchema),
      },
    },
  })
  async restoreQuotation(
    @ZodParams(quotationIdParamsSchema) params: { quotationId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<QuotationDto> {
    const { dto } = await this.restore.execute({
      quotationId: params.quotationId,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }
}
