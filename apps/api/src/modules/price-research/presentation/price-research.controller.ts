import {
  addPriceItemsSchema,
  createPriceResearchSchema,
  dataEnvelope,
  pageMetaSchema,
  priceItemIdParamsSchema,
  priceItemListQuerySchema,
  priceItemSchema,
  priceResearchIdParamsSchema,
  priceResearchMetaSchema,
  priceResearchSchema,
  priceResearchSummarySchema,
  processIdParamsSchema,
  updatePriceResearchSchema,
} from '@contrataflow/validation';
import type {
  AddPriceItems,
  CreatePriceResearch,
  PriceItemDto,
  PriceItemListQuery,
  PriceResearchDto,
  PriceResearchMeta,
  PriceResearchSummaryDto,
  UpdatePriceResearch,
} from '@contrataflow/validation';
import { Controller, Delete, Get, Headers, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  AddPriceItemsCommand,
  CreatePriceResearchCommand,
  RemovePriceItemCommand,
  UpdatePriceResearchHeaderCommand,
} from '../application/price-research.commands.js';
import {
  GetPriceResearchQuery,
  ListPriceItemsQuery,
  ListProcessPriceResearchQuery,
} from '../application/price-research.queries.js';

const TAGS = ['Pesquisa de preços'];

const READ_ACCESS =
  'Pesquisa de preços do processo (US-024 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 NOT_FOUND igual ao inexistente. Valores monetários sob POL-09 (RN-PRICE-12).';
const CREATE_ACCESS =
  'PRICE_RESEARCH_CREATE com escopo que cubra o processo (403 PERMISSION_DENIED com access.denied) + custódia atual (POL-01 — 403 NOT_PROCESS_CUSTODIAN; participação não cria) + POL-02 (processo editável, tipo PRICE_RESEARCH permitido na etapa), conferidos no caso de uso.';
const WRITE_ACCESS =
  'PRICE_RESEARCH_UPDATE cobrindo o processo — por perfil ou por participação COLLABORATOR/CONSULTANT — com a POL-02 estendida e POL-09 em processo sigiloso (RN-PRICE-10/12), conferidas no caso de uso; sem permissão = 403 PERMISSION_DENIED com access.denied.';
const WRITE_RULES =
  '`PRICE_RESEARCH_UPDATE` cobrindo o processo (403 `PERMISSION_DENIED`) + custódia ou participação `COLLABORATOR`/`CONSULTANT` (403) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`) + tipo permitido na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) + documento em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`) + POL-09 em processo sigiloso (403 `PERMISSION_DENIED`, `reasonCode = POL-09`).';

const RESEARCH_RESPONSE = z.object({ data: priceResearchSchema, meta: priceResearchMetaSchema });

function noStore(response: HttpResponse): void {
  response.setHeader('Cache-Control', 'no-store');
}

/**
 * Pesquisa de preços (api/07 · US-024): PRS-01/02 sob `/processes/{id}/price-research`, PRS-03/04/
 * 05/06 sob `/price-research/{id}` e PRS-08 sob `/price-items/{itemId}`. O id da pesquisa é o do
 * documento: seções (DOC-05), versões e PDF usam os endpoints genéricos de documento.
 */
@Controller()
@TenantScope('TENANT')
export class PriceResearchController {
  constructor(
    private readonly list: ListProcessPriceResearchQuery,
    private readonly get: GetPriceResearchQuery,
    private readonly listItems: ListPriceItemsQuery,
    private readonly create: CreatePriceResearchCommand,
    private readonly update: UpdatePriceResearchHeaderCommand,
    private readonly addItems: AddPriceItemsCommand,
    private readonly removeItem: RemovePriceItemCommand,
  ) {}

  @Get('processes/:id/price-research')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'PRS-01',
    summary: 'Listar pesquisas de preços do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Singular por processo (RN-PRICE-01): 0 ou 1 pesquisa não cancelada + as canceladas (histórico); excluídas logicamente ficam de fora. Processo inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: dataEnvelope(z.array(priceResearchSummarySchema)),
      },
    },
  })
  async listResearch(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PriceResearchSummaryDto[]> {
    noStore(response);
    return this.list.execute(params.id);
  }

  @Post('processes/:id/price-research')
  @Idempotent()
  @ImplicitAccess(CREATE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-02',
    summary: 'Criar pesquisa de preços a partir dos itens do processo',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.create'],
    responses: {
      201: {
        description:
          'Uma transação (RN-PRICE-13): itens do processo (padrão: todos os não excluídos por `sequence`; 422 `REFERENCE_NOT_FOUND`/`DUPLICATE_IN_LIST` em `items[i].processItemId`), quantidade (processo → ETP → DFD, > 0, até 4 casas, inteira se a unidade não admite decimais — 422 `REQUIRED`/`OUT_OF_RANGE`/`INVALID_DECIMAL` em `items[i].quantity`), data-base ≤ hoje no fuso do tenant (422 `OUT_OF_RANGE`), template ativo e publicado do tipo (422 em `templateId`), `PRICE_RESEARCH_CREATE` + custódia (403), processo editável (409 `INVALID_PROCESS_STATUS`), tipo na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`), pesquisa não cancelada única (409 `DOCUMENT_ALREADY_EXISTS` com `meta.existingId`), processo com itens (422 `BUSINESS_RULE_VIOLATION` `PRICE_ITEMS_REQUIRED`). Cria o `Document` (`DRAFT`, número pela máscara do tipo, `RESTRICTED` em processo sigiloso), o cabeçalho com o snapshot de `priceResearch.*` e um `PriceItem` por item com os alertas `NO_VALID_QUOTES`/`BELOW_MINIMUM_QUOTES`. Grava `document.create`, `DocumentCreated` (`document.created.price_research`) e a timeline `DOCUMENT_CREATED`. `Location: /api/v1/price-research/{id}` e `ETag: "1"`; reenvio com a mesma chave = mesma resposta com `Idempotent-Replayed: true`.',
        schema: RESEARCH_RESPONSE,
      },
    },
  })
  async createResearch(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @ZodBody(createPriceResearchSchema) body: CreatePriceResearch,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<PriceResearchDto, PriceResearchMeta>> {
    const created = await this.create.execute({
      processId: params.id,
      body,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/price-research/${created.dto.id}`);
    response.setHeader('ETag', `"${String(created.dto.version)}"`);
    return new DataResult(created.dto, created.meta);
  }

  @Get('price-research/:id')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'PRS-03',
    summary: 'Obter pesquisa de preços',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Cabeçalho, snapshot dos parâmetros, resumo do documento e `meta` (`allowedActions`, `documentActions`, `lockReason`, template fixado). Sem POL-09 em processo sigiloso: `totalEstimatedValue: null` + `totalEstimatedValueMasked: true`. `ETag` = versão da pesquisa. Inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: RESEARCH_RESPONSE,
      },
    },
  })
  async getResearch(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<PriceResearchDto, PriceResearchMeta>> {
    const view = await this.get.execute(params.id);
    response.setHeader('ETag', `"${String(view.dto.version)}"`);
    noStore(response);
    return new DataResult(view.dto, view.meta);
  }

  @Patch('price-research/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-04',
    summary: 'Atualizar pesquisa de preços (data-base e título)',
    tags: TAGS,
    auditActions: ['document.draft_update'],
    responses: {
      200: {
        description: `Data-base (≤ hoje; 422 \`OUT_OF_RANGE\`) e título (5–250). A nova data-base reavalia a validade das cotações e recalcula os alertas (FA-07), emitindo \`PriceResearchRecalculated\` (\`price_research.recalculated\`). Parâmetros do snapshot (RN-PRICE-05) no corpo → 422 \`NOT_ALLOWED\`. Grava \`document.draft_update\`. \`If-Match\` divergente → 412 \`VERSION_CONFLICT\` com \`currentVersion\`; ausente → 428. ${WRITE_RULES}`,
        schema: RESEARCH_RESPONSE,
      },
    },
  })
  async updateResearch(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @ZodBody(updatePriceResearchSchema) body: UpdatePriceResearch,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<PriceResearchDto, PriceResearchMeta>> {
    const result = await this.update.execute({
      researchId: params.id,
      patch: { referenceDate: body.referenceDate, title: body.title },
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(result.dto.version)}"`);
    return new DataResult(result.dto, result.meta);
  }

  @Get('price-research/:id/items')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'PRS-05',
    summary: 'Listar itens da pesquisa',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Itens por `sortOrder` (= nº do item no processo), com filtros `lot` e `hasAlerts`. Valores monetários `null` + `valuesMasked`/`recommendedUnitPriceMasked` sem POL-09 em processo sigiloso. 404 `NOT_FOUND` como o PRS-03.',
        schema: z.object({ data: z.array(priceItemSchema), meta: pageMetaSchema }),
      },
    },
  })
  async listResearchItems(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @ZodQuery(priceItemListQuerySchema) query: PriceItemListQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PageResult<PriceItemDto>> {
    noStore(response);
    const result = await this.listItems.execute(params.id, query);
    return new PageResult(result.items, result.meta);
  }

  @Post('price-research/:id/items')
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-06',
    summary: 'Incluir itens na pesquisa',
    tags: TAGS,
    auditActions: ['document.items_update'],
    responses: {
      201: {
        description: `Itens do mesmo processo ainda ausentes da pesquisa (RN-PRICE-11 — já incluído = 422 \`DUPLICATE_IN_LIST\`; de outro processo/tenant ou excluído = 422 \`REFERENCE_NOT_FOUND\`), sem cotações. Grava \`document.items_update\` e emite \`PriceResearchRecalculated\` em todo commit. ${WRITE_RULES}`,
        schema: dataEnvelope(z.array(priceItemSchema)),
      },
    },
  })
  async addResearchItems(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @ZodBody(addPriceItemsSchema) body: AddPriceItems,
  ): Promise<PriceItemDto[]> {
    return (await this.addItems.execute({ researchId: params.id, body })).items;
  }

  @Delete('price-items/:itemId')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-08',
    summary: 'Remover item da pesquisa',
    tags: TAGS,
    auditActions: ['document.items_update'],
    responses: {
      204: {
        description: `Remoção física do item e, em cascata, das cotações dele (RN-PRICE-11); proibida para o último item (422 \`NOT_ALLOWED\`). \`If-Match\` = versão do item (412 \`VERSION_CONFLICT\`). Grava \`document.items_update\` (com o nº de cotações apagadas) e emite \`PriceResearchRecalculated\`. ${WRITE_RULES}`,
      },
    },
  })
  async removeResearchItem(
    @ZodParams(priceItemIdParamsSchema) params: { itemId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.removeItem.execute({ itemId: params.itemId, expectedVersion: ifMatch?.value ?? 0 });
  }
}
