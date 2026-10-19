import {
  processIdParamsSchema,
  termCreateSchema,
  termDetailMetaSchema,
  termDetailSchema,
  termIdParamsSchema,
  termListMetaSchema,
  termMetaSchema,
  termPatchSchema,
  termSchema,
  termSummarySchema,
} from '@contrataflow/validation';
import type {
  TermCreate,
  TermDetailDto,
  TermDetailMeta,
  TermDto,
  TermListMeta,
  TermMeta,
  TermPatch,
  TermSummaryDto,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import { CreateTermCommand } from '../application/term.commands.js';
import { GetTermQuery, ListProcessTermsQuery } from '../application/term.queries.js';
import { UpdateTermHeaderCommand } from '../application/update-term-header.command.js';

const TAGS = ['Termo de Referência'];

const READ_ACCESS =
  'TRs do processo (US-036 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 igual ao inexistente.';
const DETAIL_ACCESS =
  'TR do processo (US-036 · DEC-024): visibilidade do processo do TR (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 igual ao inexistente. POL-09 no valor estimado (PROCESS_VIEW_CONFIDENTIAL_BUDGET ou custódia).';
const CREATE_ACCESS =
  'TERM_CREATE com escopo que cubra o processo (403 PERMISSION_DENIED com access.denied reasonCode TERM_CREATE) + POL-02 com a custódia (POL-01 — participação não cria: 403 NOT_PROCESS_CUSTODIAN; processo em DRAFT/IN_PROGRESS/RETURNED — senão 409 INVALID_PROCESS_STATUS; tipo TR permitido na etapa — senão 422), conferidos no caso de uso.';
const UPDATE_ACCESS =
  'TERM_UPDATE com escopo que cubra o processo + POL-02 (custódia OU participação COLLABORATOR/CONSULTANT — senão 403 NOT_PROCESS_CUSTODIAN com access.denied; processo editável — 409; tipo na etapa — 422; TR em DRAFT/RETURNED — 409 DOCUMENT_NOT_EDITABLE) e POL-09 para alterar o valor estimado (403), conferidos no caso de uso.';

/**
 * Termo de Referência (api/09-term-of-reference.md · US-036): TRM-01/02 sob `/processes/{id}/terms`
 * e TRM-03/04 em `/terms/{id}`. O id do TR é o do documento: seções (DOC-05), itens (DOC-06/07),
 * validação (DOC-08) e pré-visualização (DOC-20) usam os endpoints genéricos.
 */
@Controller()
@TenantScope('TENANT')
export class TermController {
  constructor(
    private readonly list: ListProcessTermsQuery,
    private readonly get: GetTermQuery,
    private readonly create: CreateTermCommand,
    private readonly update: UpdateTermHeaderCommand,
  ) {}

  @Get('processes/:id/terms')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'TRM-01',
    summary: 'Listar Termos de Referência do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Singular por processo: 0 ou 1 TR ativo + os cancelados (histórico); excluídos logicamente ficam de fora. `meta.templates` = modelos ativos do tipo TR com versão publicada (o padrão do tipo primeiro, `isDefault`) e `meta.defaultTitle` = "Termo de Referência — {título do processo}" (diálogo "Criar Termo de Referência" — FA-01). Processo inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: z.object({ data: z.array(termSummarySchema), meta: termListMetaSchema }),
      },
    },
  })
  async listTerms(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<TermSummaryDto[], TermListMeta>> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(params.id);
    return new DataResult(result.items, result.meta);
  }

  @Post('processes/:id/terms')
  @Idempotent()
  @ImplicitAccess(CREATE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'TRM-02',
    summary: 'Criar Termo de Referência',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.create'],
    responses: {
      201: {
        description:
          'Uma transação: template ativo do tipo TR com versão publicada (o padrão do tipo sem `templateId`; inválido/inativo/de outro tenant = 422 `VALIDATION_ERROR` com `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `templateId`), TR ativo único (409 `DOCUMENT_ALREADY_EXISTS` com `meta.existingTermId`), número `TR 0003/2026`, `Document` em `DRAFT` (sigilo `RESTRICTED` com orçamento sigiloso) com o rascunho de todas as seções do template e a versão fixada, e o `TermOfReference` com `objectDefinition` = objeto do processo e — havendo pesquisa de preços `FINALIZED`/`APPROVED` — `priceResearchId`, o total e `estimatedValueSource = PRICE_RESEARCH`. Grava `document.create`, `DocumentCreated` (`document.created.tr`) e a timeline `DOCUMENT_CREATED`. `Location: /api/v1/terms/{id}` e `ETag: "1"`; reenvio com a mesma chave = mesma resposta com `Idempotent-Replayed: true`.',
        schema: z.object({ data: termSchema, meta: termMetaSchema }),
      },
    },
  })
  async createTerm(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @ZodBody(termCreateSchema) body: TermCreate,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<TermDto, TermMeta>> {
    const created = await this.create.execute({
      processId: params.id,
      templateId: body.templateId ?? null,
      title: body.title ?? null,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/terms/${created.dto.id}`);
    response.setHeader('ETag', `"${String(created.dto.version)}"`);
    return new DataResult(created.dto, created.meta);
  }

  @Get('terms/:id')
  @ImplicitAccess(DETAIL_ACCESS)
  @ApiOperation({
    operationId: 'TRM-03',
    summary: 'Obter Termo de Referência',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Cabeçalho do TR (objeto, condições, origem e valor estimado — `estimatedTotalValue = null` com `estimatedTotalValueMasked: true` sem POL-09 em processo sigiloso), o resumo do documento (código, status, `inApproval`, versão do template, `documentVersion`), o rascunho por seção (`draftContent.sections[key]`: `state`, `content`, `justification` e `revision` — o `If-Match: "s<revision>"` do DOC-05), `completeness` (exigidas satisfeitas ÷ exigidas — a avaliação do DOC-08), a pesquisa vinculada e a concluída do processo (`priceResearch`/`completedPriceResearch`, total mascarado pela POL-09) e `etpChangedSinceImport`. `meta.allowedActions` (`UPDATE` só com `TERM_UPDATE` + POL-02 e o TR em `DRAFT`/`RETURNED`; sem ela a SCR-012 abre somente leitura) e `meta.template` (seções da versão fixada). `ETag` = versão do TR. Inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: z.object({ data: termDetailSchema, meta: termDetailMetaSchema }),
      },
    },
  })
  async getTerm(
    @ZodParams(termIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<TermDetailDto, TermDetailMeta>> {
    const view = await this.get.execute(params.id);
    response.setHeader('ETag', `"${String(view.dto.version)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return new DataResult(view.dto, view.meta);
  }

  @Patch('terms/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(UPDATE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'TRM-04',
    summary: 'Atualizar Termo de Referência (objeto e valor estimado)',
    tags: TAGS,
    auditActions: ['document.draft_update'],
    responses: {
      200: {
        description:
          'Painel "Dados do TR" (US-036): `objectDefinition` (10–2.000; não altera o objeto do processo) e o valor estimado — `priceResearchId` (ou `estimatedValueSource: PRICE_RESEARCH`, sem id = a pesquisa concluída do processo) vincula a pesquisa do MESMO processo em `FINALIZED`/`APPROVED` e copia o total (somente leitura — 422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `priceResearchId`); `estimatedValueSource: MANUAL` + `estimatedTotalValue` (≥ 0, 2 casas — `INVALID_DECIMAL`) desvincula a pesquisa; a origem `ETP` vem só da importação (422 `NOT_ALLOWED`). Sem POL-09 em processo sigiloso, alterar o valor = 403. `If-Match: "<version>"` obrigatório (428 sem ele; 412 `VERSION_CONFLICT` com `meta.current`). Grava `document.draft_update` (objeto como hash + tamanho; valor mascarado se sigiloso). `ETag` = nova versão. Condições contratuais: US-038.',
        schema: z.object({ data: termSchema, meta: termMetaSchema }),
      },
    },
  })
  async updateTerm(
    @ZodParams(termIdParamsSchema) params: { id: string },
    @ZodBody(termPatchSchema) body: TermPatch,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<TermDto, TermMeta>> {
    const result = await this.update.execute({
      termId: params.id,
      expectedVersion: ifMatch?.kind === 'version' ? ifMatch.value : -1,
      patch: body,
    });
    response.setHeader('ETag', `"${String(result.dto.version)}"`);
    return new DataResult(result.dto, result.meta);
  }
}
