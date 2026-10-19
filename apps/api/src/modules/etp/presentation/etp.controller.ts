import {
  etpCreateSchema,
  etpDetailMetaSchema,
  etpDetailSchema,
  etpIdParamsSchema,
  etpListMetaSchema,
  etpMetaSchema,
  etpSchema,
  etpSummarySchema,
  processIdParamsSchema,
} from '@contrataflow/validation';
import type {
  EtpCreate,
  EtpDetailDto,
  EtpDetailMeta,
  EtpDto,
  EtpListMeta,
  EtpMeta,
  EtpSummaryDto,
} from '@contrataflow/validation';
import { Controller, Get, Headers, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import { CreateEtpCommand } from '../application/etp.commands.js';
import { GetEtpQuery, ListProcessEtpsQuery } from '../application/etp.queries.js';

const TAGS = ['ETP'];

const READ_ACCESS =
  'ETPs do processo (US-019 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 igual ao inexistente.';
const DETAIL_ACCESS =
  'ETP do processo (US-020 · DEC-024): visibilidade do processo do ETP (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 igual ao inexistente. POL-09 no valor estimado.';
const CREATE_ACCESS =
  'ETP_CREATE com escopo que cubra o processo (403 PERMISSION_DENIED com access.denied reasonCode ETP_CREATE) + POL-02 (RN-ETP-07: custódia atual OU participação COLLABORATOR/CONSULTANT — senão 403 PERMISSION_DENIED; processo em DRAFT/IN_PROGRESS/RETURNED — senão 409 DOCUMENT_NOT_EDITABLE; tipo ETP permitido na etapa — senão 422), conferidos no caso de uso.';

/**
 * ETP (api/06-etp.md · US-019/020): ETP-01/02 sob `/processes/{id}/etps` e ETP-03 `/etps/{id}`. O
 * id do ETP é o do documento:
 * seções (DOC-05), itens (DOC-06/07), validação (DOC-08) e versões usam os endpoints genéricos.
 */
@Controller()
@TenantScope('TENANT')
export class EtpController {
  constructor(
    private readonly list: ListProcessEtpsQuery,
    private readonly get: GetEtpQuery,
    private readonly create: CreateEtpCommand,
  ) {}

  @Get('etps/:id')
  @ImplicitAccess(DETAIL_ACCESS)
  @ApiOperation({
    operationId: 'ETP-03',
    summary: 'Obter ETP',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Cabeçalho do ETP (conclusão, parcelamento, origem e valor estimado — `estimatedTotalValue = null` com `estimatedTotalValueMasked: true` sem POL-09 em processo sigiloso), o resumo do documento (código, status, `documentVersion` — o `If-Match` do DOC-07 —, `itemsCount`) e o rascunho por seção (`draftContent.sections[key]`: `state`, `content`, `justification` e `revision` — o `If-Match: "s<revision>"` do DOC-05). `meta.allowedActions` (`UPDATE` só com `ETP_UPDATE` + POL-02 e o ETP em `DRAFT`/`RETURNED`; sem ela a SCR-008 abre somente leitura) e `meta.template` (seções da versão fixada no documento, com `requirement`, `minChars`/`maxChars`, `render` e `allowNarrative`). `ETag` = versão do ETP. Inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: z.object({ data: etpDetailSchema, meta: etpDetailMetaSchema }),
      },
    },
  })
  async getEtp(
    @ZodParams(etpIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<EtpDetailDto, EtpDetailMeta>> {
    const view = await this.get.execute(params.id);
    response.setHeader('ETag', `"${String(view.dto.version)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return new DataResult(view.dto, view.meta);
  }

  @Get('processes/:id/etps')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'ETP-01',
    summary: 'Listar ETPs do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Singular por processo: 0 ou 1 ETP ativo + os cancelados (histórico); excluídos logicamente ficam de fora. `meta.importableDfd` = o DFD não cancelado em `FINALIZED`/`APPROVED` com versão (objeto, nº de itens e situação no PCA do snapshot da versão aprovada, senão a atual) — o cartão "Importar dados do DFD" —, ou `null`. Processo inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: z.object({ data: z.array(etpSummarySchema), meta: etpListMetaSchema }),
      },
    },
  })
  async listEtps(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<EtpSummaryDto[], EtpListMeta>> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(params.id);
    return new DataResult(result.items, result.meta);
  }

  @Post('processes/:id/etps')
  @Idempotent()
  @ImplicitAccess(CREATE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'ETP-02',
    summary: 'Criar ETP (com importação opcional do DFD)',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.create'],
    responses: {
      201: {
        description:
          'Uma transação (RN-ETP-09): template publicado do tipo ETP com as 16 seções (`EMPTY`, ou `FILLED` com `defaultContent`), ETP ativo único (409 `DOCUMENT_ALREADY_EXISTS` com `meta.existingEtpId`), número `ETP 0001/2026`, `Document` em `DRAFT` sob responsabilidade do criador e o `Etp` com `conclusion = PENDING`. Com `importFromDfd: true`: exige DFD não cancelado em `FINALIZED`/`APPROVED` (senão 422 `VALIDATION_ERROR` com `NOT_ALLOWED` em `importFromDfd`); do snapshot da versão aprovada (senão a atual) copia objeto + justificativa para `NEED_DESCRIPTION` e a situação no PCA para `PCA_ALIGNMENT` (ambas `FILLED`), cria um item do ETP por item do DFD (mesmo `processItemId` e `quantity`) e grava `importedFromDfdVersionId`. Grava `document.create` (`changes`: `documentTypeCode`, `importedFromDfdVersionId`), `DocumentCreated` (`document.created.etp`) e a timeline `DOCUMENT_CREATED`. `Location: /api/v1/etps/{id}` e `ETag: "1"`; reenvio com a mesma chave = mesma resposta com `Idempotent-Replayed: true`.',
        schema: z.object({ data: etpSchema, meta: etpMetaSchema }),
      },
    },
  })
  async createEtp(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @ZodBody(etpCreateSchema) body: EtpCreate,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<EtpDto, EtpMeta>> {
    const created = await this.create.execute({
      processId: params.id,
      importFromDfd: body.importFromDfd ?? false,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/etps/${created.dto.id}`);
    response.setHeader('ETag', `"${String(created.dto.version)}"`);
    return new DataResult(created.dto, created.meta);
  }
}
