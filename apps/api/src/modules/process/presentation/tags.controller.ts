import {
  createTagSchema,
  dataEnvelope,
  processIdParamsSchema,
  processTagsSchema,
  setProcessTagsSchema,
  tagIdParamsSchema,
  tagListQuerySchema,
  tagSchema,
  updateTagSchema,
} from '@contrataflow/validation';
import type {
  CreateTag,
  ProcessTagsDto,
  SetProcessTags,
  TagDto,
  TagListQuery,
  UpdateTag,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Patch, Post, Put, Res } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  CreateTagCommand,
  ListTagsQuery,
  SetProcessTagsCommand,
  UpdateTagCommand,
} from '../application/tags.commands.js';

const TAGS = ['Processos'];

/** Lista usada pela tela e pelo seletor: nenhum cache intermediário (cache é do cliente). */
function noStore(response: HttpResponse): void {
  response.setHeader('Cache-Control', 'no-store');
}

const CONFIG_RULES =
  'Exige `TAG_MANAGE` (403 `PERMISSION_DENIED` + `access.denied`). Etiquetas nunca são excluídas: a desativação mantém as associações existentes (RN-PROC-86). Cadastro e manutenção não geram evento de domínio — só auditoria de configuração.';

/**
 * Etiquetas do órgão (api/02-processes.md TAG-01..03 · US-007): listar (`PROCESS_VIEW`), criar e
 * editar (`TAG_MANAGE`). Nome único no tenant sem diferenciar maiúsculas e cor da paleta acessível.
 */
@Controller('tags')
@TenantScope('TENANT')
export class TagsController {
  constructor(
    private readonly list: ListTagsQuery,
    private readonly create: CreateTagCommand,
    private readonly update: UpdateTagCommand,
  ) {}

  @Get()
  @RequirePermission('PROCESS_VIEW', { detail: 'Você não tem permissão para ver as etiquetas.' })
  @ApiOperation({
    operationId: 'TAG-01',
    summary: 'Listar etiquetas do tenant',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Etiquetas ativas por nome. `includeInactive=true` só é atendido para quem tem `TAG_MANAGE` (para os demais, o parâmetro é ignorado — RN-PROC-91).',
        schema: dataEnvelope(z.array(tagSchema)),
      },
    },
  })
  async listTags(
    @ZodQuery(tagListQuerySchema) query: TagListQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TagDto[]> {
    const tags = await this.list.execute(query.includeInactive ?? false);
    noStore(response);
    return tags;
  }

  @Post()
  @Idempotent()
  @RequirePermission('TAG_MANAGE', { detail: 'Você não tem permissão para gerenciar etiquetas.' })
  @ApiOperation({
    operationId: 'TAG-02',
    summary: 'Criar etiqueta',
    tags: TAGS,
    idempotent: true,
    auditActions: ['tag.create'],
    responses: {
      201: {
        description: `Etiqueta criada (\`Location\` e \`ETag\` = versão). Nome de 2 a 40 caracteres, único no tenant sem diferenciar maiúsculas (409 \`CONFLICT\`); cor da paleta acessível (422 \`INVALID_ENUM\`/\`INVALID_FORMAT\`), padrão \`#64748B\`. ${CONFIG_RULES}`,
        schema: dataEnvelope(tagSchema),
      },
    },
  })
  async createTag(
    @ZodBody(createTagSchema) body: CreateTag,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TagDto> {
    const tag = await this.create.execute(body);
    response.setHeader('Location', `/api/v1/tags/${tag.id}`);
    response.setHeader('ETag', `"${String(tag.version)}"`);
    return tag;
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('TAG_MANAGE', { detail: 'Você não tem permissão para gerenciar etiquetas.' })
  @ApiOperation({
    operationId: 'TAG-03',
    summary: 'Editar etiqueta',
    tags: TAGS,
    auditActions: ['tag.update', 'tag.deactivate'],
    responses: {
      200: {
        description: `Etiqueta alterada (\`ETag\` = nova versão); PATCH sem diferença devolve a atual sem nova versão. Renomear, recolorir ou desativar reflete em todos os processos sem alterar a versão deles (RN-PROC-90); etiqueta inexistente ou de outro tenant = 404 \`NOT_FOUND\`; \`If-Match\` divergente = 412 \`VERSION_CONFLICT\`. ${CONFIG_RULES}`,
        schema: dataEnvelope(tagSchema),
      },
    },
  })
  async updateTag(
    @ZodParams(tagIdParamsSchema) params: { id: string },
    @ZodBody(updateTagSchema) body: UpdateTag,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TagDto> {
    const { dto } = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }
}

/** Aplica o conjunto de etiquetas ao processo (api/02-processes.md PRC-18 · US-007). */
@Controller('processes')
@TenantScope('TENANT')
export class ProcessTagsController {
  constructor(private readonly setTags: SetProcessTagsCommand) {}

  @Put(':id/tags')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('PROCESS_UPDATE', {
    detail: 'Você não pode alterar as etiquetas deste processo.',
  })
  @ApiOperation({
    operationId: 'PRC-18',
    summary: 'Definir etiquetas do processo',
    tags: TAGS,
    auditActions: ['process.tags_update'],
    responses: {
      200: {
        description:
          'Etiquetas do processo (por nome) e `ETag` = nova versão do processo. `tagIds` é o conjunto completo final (pode ser vazio): até 10 (422 `OUT_OF_RANGE`), sem repetição (`DUPLICATE_IN_LIST`), do tenant (`REFERENCE_NOT_FOUND`) e ativas — inativa só se já aplicada (`REFERENCE_INACTIVE`). `PROCESS_UPDATE` cobrindo o processo + custódia (POL-01 — 403 `NOT_PROCESS_CUSTODIAN`) + status `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`); `If-Match` com a versão do processo (412 `VERSION_CONFLICT`). Conjunto idêntico ao atual responde 200 sem nova versão, evento, timeline nem auditoria (RN-PROC-89); com diferença, grava `process.tags_update`, `ProcessUpdated` (`changedFields = ["tags"]`) e a timeline `PROCESS_UPDATED` na mesma transação.',
        schema: dataEnvelope(processTagsSchema),
      },
    },
  })
  async setProcessTags(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @ZodBody(setProcessTagsSchema) body: SetProcessTags,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessTagsDto> {
    const result = await this.setTags.execute({
      processId: params.id,
      tagIds: body.tagIds,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(result.processVersion)}"`);
    noStore(response);
    return result.data;
  }
}
