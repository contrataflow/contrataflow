import {
  dataEnvelope,
  dfdCreateSchema,
  dfdIdParamsSchema,
  dfdMetaSchema,
  dfdSchema,
  dfdSummarySchema,
  processIdParamsSchema,
} from '@contrataflow/validation';
import type { DfdCreate, DfdDto, DfdMeta, DfdSummaryDto } from '@contrataflow/validation';
import { Controller, Get, Headers, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import { CreateDfdCommand } from '../application/dfd.commands.js';
import { GetDfdQuery, ListProcessDfdsQuery } from '../application/dfd.queries.js';

const TAGS = ['DFD'];

const READ_ACCESS =
  'DFD do processo (US-014 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 igual ao inexistente.';
const CREATE_ACCESS =
  'DFD_CREATE com escopo que cubra o processo (403 PERMISSION_DENIED com access.denied) + custódia atual (POL-01 — 403 NOT_PROCESS_CUSTODIAN; participação não cria) + POL-02 (processo editável, tipo DFD permitido na etapa), conferidos no caso de uso.';

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
}
