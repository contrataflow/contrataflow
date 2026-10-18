import {
  dataEnvelope,
  dfdCreateSchema,
  dfdIdParamsSchema,
  dfdMetaSchema,
  dfdPatchSchema,
  dfdSchema,
  dfdSummarySchema,
  processIdParamsSchema,
} from '@contrataflow/validation';
import type { DfdCreate, DfdDto, DfdMeta, DfdPatch, DfdSummaryDto } from '@contrataflow/validation';
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

import { CreateDfdCommand } from '../application/dfd.commands.js';
import { GetDfdQuery, ListProcessDfdsQuery } from '../application/dfd.queries.js';
import { PatchDfdHeaderCommand } from '../application/patch-dfd-header.command.js';

const TAGS = ['DFD'];

const READ_ACCESS =
  'DFD do processo (US-014 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 igual ao inexistente.';
const CREATE_ACCESS =
  'DFD_CREATE com escopo que cubra o processo (403 PERMISSION_DENIED com access.denied) + custódia atual (POL-01 — 403 NOT_PROCESS_CUSTODIAN; participação não cria) + POL-02 (processo editável, tipo DFD permitido na etapa), conferidos no caso de uso.';

const UPDATE_ACCESS =
  'DFD_UPDATE com escopo que cubra o processo (403 PERMISSION_DENIED com access.denied) + custódia ou participação COLLABORATOR/CONSULTANT (POL-02 — 403 NOT_PROCESS_CUSTODIAN com access.denied) + processo em DRAFT/IN_PROGRESS/RETURNED (409) + tipo DFD permitido na etapa (422), conferidos no caso de uso a cada gravação (RN-DFD-30).';

const DFD_RESPONSE = z.object({ data: dfdSchema, meta: dfdMetaSchema });

/**
 * DFD (api/05-dfd.md · US-014): DFD-01/02 sob `/processes/{id}/dfds` e DFD-03 sob `/dfds/{id}`. O
 * id do DFD é o do documento: seções, itens (DOC-06/07), validação (DOC-08) e prévia (DOC-20) usam
 * os endpoints genéricos de documento.
 */
@Controller()
@TenantScope('TENANT')
export class DfdController {
  constructor(
    private readonly list: ListProcessDfdsQuery,
    private readonly get: GetDfdQuery,
    private readonly create: CreateDfdCommand,
    private readonly patchHeader: PatchDfdHeaderCommand,
  ) {}

  @Get('processes/:id/dfds')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'DFD-01',
    summary: 'Listar DFDs do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Singular por processo: 0 ou 1 DFD ativo + os cancelados (histórico); excluídos logicamente ficam de fora. Processo inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: dataEnvelope(z.array(dfdSummarySchema)),
      },
    },
  })
  async listDfds(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DfdSummaryDto[]> {
    response.setHeader('Cache-Control', 'no-store');
    return this.list.execute(params.id);
  }

  @Post('processes/:id/dfds')
  @Idempotent()
  @ImplicitAccess(CREATE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DFD-02',
    summary: 'Criar DFD a partir de template',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.create'],
    responses: {
      201: {
        description:
          'Uma transação: template ativo do tipo DFD com versão publicada (padrão do tipo sem `templateId` — 422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `templateId`), `DFD_CREATE` + custódia (403), processo editável (409 `INVALID_PROCESS_STATUS`), tipo na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`), DFD ativo único (409 `DOCUMENT_ALREADY_EXISTS` com `meta.existingDfdId`/`code`), número `DFD 0005/2026` na mesma transação, `Document` em `DRAFT` com todas as seções do template e o `Dfd` com os valores do processo (RN-DFD-05). Grava `document.create`, `DocumentCreated` (`document.created.dfd`) e a timeline `DOCUMENT_CREATED`. `Location: /api/v1/dfds/{id}` e `ETag: "1"`; reenvio com a mesma chave = mesma resposta com `Idempotent-Replayed: true`.',
        schema: DFD_RESPONSE,
      },
    },
  })
  async createDfd(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @ZodBody(dfdCreateSchema) body: DfdCreate,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<DfdDto, DfdMeta>> {
    const created = await this.create.execute({
      processId: params.id,
      templateId: body.templateId ?? null,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/dfds/${created.dto.id}`);
    response.setHeader('ETag', `"${String(created.dto.version)}"`);
    return new DataResult(created.dto, created.meta);
  }

  @Get('dfds/:id')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'DFD-03',
    summary: 'Obter DFD',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Cabeçalho do DFD, resumo do documento (código, status, `documentVersion` — o `If-Match` do DOC-07) e `meta.allowedActions`; estimativa mascarada (`estimatedValueMasked`) sem POL-09 em processo sigiloso. `ETag` = versão do DFD. Inexistente, de outro tenant ou não visível = 404 `DFD_NOT_FOUND`.',
        schema: DFD_RESPONSE,
      },
    },
  })
  async getDfd(
    @ZodParams(dfdIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<DfdDto, DfdMeta>> {
    const view = await this.get.execute(params.id);
    response.setHeader('ETag', `"${String(view.dto.version)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return new DataResult(view.dto, view.meta);
  }

  @Patch('dfds/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(UPDATE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DFD-04',
    summary: 'Atualizar cabeçalho do DFD (autosave)',
    tags: TAGS,
    auditActions: ['document.draft_update'],
    responses: {
      200: {
        description:
          'Gravação parcial: APENAS os campos enviados (RN-DFD-27), `If-Match: "<version>"` e `version + 1` (`ETag` novo); patch sem mudança efetiva = 200 sem nova versão. Também persiste `wizardStep`/`completedSteps` (retomada — RN-DFD-34). Regras de campo só nos enviados (data ≤ hoje, objeto 10–2.000, previsão ≥ data e ≥ hoje, PCA, item ≤ 60), setor na secretaria solicitante (`DEPARTMENT_NOT_IN_SECRETARIAT`), responsável ativo; `processId`/`documentId` → 422 `NOT_ALLOWED`. Erros: 404 `DFD_NOT_FOUND`, 403 `NOT_PROCESS_CUSTODIAN`/`PERMISSION_DENIED` (estimativa sem POL-09 em processo sigiloso), 409 `DOCUMENT_NOT_EDITABLE`/`INVALID_PROCESS_STATUS`, 412 `VERSION_CONFLICT` com `meta.current` (o DFD atual + `updatedBy` — merge do cliente, RN-DFD-28), 422 `VALIDATION_ERROR`, 428 `PRECONDITION_REQUIRED`. Auditoria `document.draft_update`: imediata com `changes` nos campos de dados (estimativa mascarada se sigilosa), coalescida nos textos (hash + tamanho); sem evento de domínio.',
        schema: DFD_RESPONSE,
      },
    },
  })
  async patchDfd(
    @ZodParams(dfdIdParamsSchema) params: { id: string },
    @ZodBody(dfdPatchSchema) body: DfdPatch,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<DfdDto, DfdMeta>> {
    const result = await this.patchHeader.save({
      dfdId: params.id,
      // `"s3"` (revisão de seção) nunca casa com a versão do cabeçalho: 412.
      expectedVersion: ifMatch?.kind === 'version' ? ifMatch.value : -1,
      patch: body,
    });
    response.setHeader('ETag', `"${String(result.dto.version)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return new DataResult(result.dto, result.meta);
  }
}
