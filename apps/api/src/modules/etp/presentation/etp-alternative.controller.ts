import {
  createEtpAlternativeSchema,
  dataEnvelope,
  decideEtpAlternativeSchema,
  etpAlternativeIdParamsSchema,
  etpAlternativeListMetaSchema,
  etpAlternativeSchema,
  etpIdParamsSchema,
  updateEtpAlternativeSchema,
} from '@contrataflow/validation';
import type {
  CreateEtpAlternativeParsed,
  DecideEtpAlternativeParsed,
  EtpAlternativeDto,
  EtpAlternativeListMeta,
  UpdateEtpAlternativeParsed,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import {
  CreateEtpAlternativeCommand,
  DecideEtpAlternativeCommand,
  DeleteEtpAlternativeCommand,
  UpdateEtpAlternativeCommand,
} from '../application/etp-alternative.commands.js';
import { ListEtpAlternativesQuery } from '../application/etp-alternative.queries.js';

const TAGS = ['ETP'];

const READ_ACCESS =
  'Alternativas do ETP (US-021 · DEC-024): visibilidade do processo do ETP (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 igual ao inexistente. POL-09 no custo estimado.';
const WRITE_ACCESS =
  'ETP_UPDATE cobrindo o processo do ETP — por perfil ou por participação COLLABORATOR/CONSULTANT — conferida no caso de uso com a POL-02 estendida às coleções tipadas; sem permissão = 403 PERMISSION_DENIED com access.denied (reasonCode ETP_UPDATE).';
const WRITE_RULES =
  '`ETP_UPDATE` cobrindo o processo (403 `PERMISSION_DENIED`) + custódia ou participação `COLLABORATOR`/`CONSULTANT` (403) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`) + ETP permitido na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) + ETP ativo em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`). Em processo sigiloso, quem não atende a POL-09 não envia `estimatedCost` (403 `PERMISSION_DENIED`) e o recebe mascarado.';

const LIST_RESPONSE = z.object({
  data: z.array(etpAlternativeSchema),
  meta: etpAlternativeListMetaSchema,
});

const etag = (response: HttpResponse, version: number) => {
  response.setHeader('ETag', `"${String(version)}"`);
};

/**
 * Alternativas de solução do ETP (api/06-etp.md · US-021): ETP-05/06 sob `/etps/{id}/alternatives`
 * e ETP-07/08/09 sob `/etp-alternatives/{alternativeId}`. Permissão e POL-02 conferidas no caso de
 * uso, com o documento ETP travado (RN-ETP-20).
 */
@Controller()
@TenantScope('TENANT')
export class EtpAlternativeController {
  constructor(
    private readonly list: ListEtpAlternativesQuery,
    private readonly create: CreateEtpAlternativeCommand,
    private readonly update: UpdateEtpAlternativeCommand,
    private readonly remove: DeleteEtpAlternativeCommand,
    private readonly decide: DecideEtpAlternativeCommand,
  ) {}

  @Get('etps/:id/alternatives')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'ETP-05',
    summary: 'Listar alternativas do ETP',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Alternativas não excluídas por `sortOrder` (o quadro comparativo da seção `ALTERNATIVES` — RN-ETP-23). POL-09 (RN-ETP-24): em processo sigiloso, sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia, `estimatedCost = null` e `estimatedCostMasked: true`. `meta.canManage` = `ETP_UPDATE` + POL-02 e o ETP ativo em `DRAFT`/`RETURNED` (sem ela, a seção abre somente leitura); `meta.recommendedAlternativeId` = a recomendada do cabeçalho do ETP; `meta.estimatedCostMasked` = o custo vem mascarado para este usuário (POL-09). ETP inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.',
        schema: LIST_RESPONSE,
      },
    },
  })
  async listAlternatives(
    @ZodParams(etpIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<EtpAlternativeDto[], EtpAlternativeListMeta>> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(params.id);
    return new DataResult(result.items, result.meta);
  }

  @Post('etps/:id/alternatives')
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'ETP-06',
    summary: 'Criar alternativa de solução',
    tags: TAGS,
    auditActions: ['etp.alternative_create'],
    responses: {
      201: {
        description: `Alternativa com \`decision = UNDER_ANALYSIS\`, ao fim da lista (\`sortOrder\`); \`ETag\` = versão. Nome único no ETP sem diferenciar maiúsculas (422 \`VALIDATION_ERROR\` com \`DUPLICATE_IN_LIST\` em \`name\`); descrição obrigatória (\`REQUIRED\`); custo decimal ≥ 0 com até 2 casas (\`INVALID_DECIMAL\`). Grava \`etp.alternative_create\` (nome e risco; textos longos como hash + tamanho); sem evento. ETP inexistente, de outro tenant ou não visível = 404. ${WRITE_RULES}`,
        schema: dataEnvelope(etpAlternativeSchema),
      },
    },
  })
  async createAlternative(
    @ZodParams(etpIdParamsSchema) params: { id: string },
    @ZodBody(createEtpAlternativeSchema) body: CreateEtpAlternativeParsed,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<EtpAlternativeDto> {
    const { dto } = await this.create.execute({ etpId: params.id, body });
    response.setHeader('Location', `/api/v1/etp-alternatives/${dto.id}`);
    etag(response, dto.version);
    return dto;
  }

  @Patch('etp-alternatives/:alternativeId')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'ETP-07',
    summary: 'Atualizar alternativa de solução',
    tags: TAGS,
    auditActions: ['etp.alternative_update'],
    responses: {
      200: {
        description: `Alternativa atualizada (\`ETag\` = nova versão): os campos do ETP-06 (parciais; \`null\` limpa os opcionais) e \`sortOrder\` (reordenação). A decisão só muda pelo ETP-09. Sem mudança = 200 com a mesma versão, sem auditoria. Grava \`etp.alternative_update\` (campos alterados; textos longos como hash + tamanho, custo sem valor). \`If-Match\` divergente → 412 \`VERSION_CONFLICT\` com \`currentVersion\`. Alternativa inexistente, excluída ou de outro tenant = 404 \`NOT_FOUND\`. ${WRITE_RULES}`,
        schema: dataEnvelope(etpAlternativeSchema),
      },
    },
  })
  async updateAlternative(
    @ZodParams(etpAlternativeIdParamsSchema) params: { alternativeId: string },
    @ZodBody(updateEtpAlternativeSchema) body: UpdateEtpAlternativeParsed,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<EtpAlternativeDto> {
    const { dto } = await this.update.execute({
      alternativeId: params.alternativeId,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    etag(response, dto.version);
    return dto;
  }

  @Delete('etp-alternatives/:alternativeId')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'ETP-08',
    summary: 'Excluir alternativa de solução',
    tags: TAGS,
    auditActions: ['etp.alternative_delete'],
    responses: {
      204: {
        description: `Exclusão lógica (RN-ETP-22): some do quadro comparativo e continua auditável. A alternativa \`RECOMMENDED\` corrente não pode ser excluída (409 \`INVALID_STATE\` — altere a decisão antes). Grava \`etp.alternative_delete\` (\`metadata.alternativeId\`). \`If-Match\` divergente → 412 \`VERSION_CONFLICT\`. ${WRITE_RULES}`,
      },
    },
  })
  async deleteAlternative(
    @ZodParams(etpAlternativeIdParamsSchema) params: { alternativeId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({
      alternativeId: params.alternativeId,
      expectedVersion: ifMatch?.value ?? 0,
    });
  }

  @Post('etp-alternatives/:alternativeId/decide')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(WRITE_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'ETP-09',
    summary: 'Decidir alternativa (recomendar/descartar)',
    tags: TAGS,
    auditActions: ['etp.alternative_decide'],
    responses: {
      200: {
        description:
          `Decisão aplicada (\`ETag\` = nova versão). \`RECOMMENDED\`/\`DISCARDED\` exigem \`decisionJustification\` ≥ 20 caracteres (422 \`VALIDATION_ERROR\` com \`CONDITIONAL_REQUIRED\`/\`TOO_SHORT\`). No máximo uma \`RECOMMENDED\` por ETP (RN-ETP-20): com outra já recomendada → 409 \`RECOMMENDED_ALTERNATIVE_EXISTS\` (\`meta.recommendedAlternativeId\`), salvo \`replaceRecommended: true` +
          '`, que devolve a antiga a `UNDER_ANALYSIS` na mesma transação. Recomendar atualiza `Etp.recommendedAlternativeId` e publica `EtpAlternativeRecommended` (`previousAlternativeId` na substituição — timeline `ETP_ALTERNATIVE_RECOMMENDED`); tirar a recomendada da decisão limpa o campo. Grava `etp.alternative_decide` (`decision`, `replaceRecommended`, `previousAlternativeId?`). `If-Match` divergente → 412 `VERSION_CONFLICT`. ' +
          WRITE_RULES,
        schema: dataEnvelope(etpAlternativeSchema),
      },
    },
  })
  async decideAlternative(
    @ZodParams(etpAlternativeIdParamsSchema) params: { alternativeId: string },
    @ZodBody(decideEtpAlternativeSchema) body: DecideEtpAlternativeParsed,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<EtpAlternativeDto> {
    const { dto } = await this.decide.execute({
      alternativeId: params.alternativeId,
      body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    etag(response, dto.version);
    return dto;
  }
}
