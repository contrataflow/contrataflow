import {
  createSavedViewSchema,
  dataEnvelope,
  savedViewIdParamsSchema,
  savedViewListQuerySchema,
  savedViewSchema,
  updateSavedViewSchema,
} from '@contrataflow/validation';
import type {
  CreateSavedView,
  SavedViewDto,
  SavedViewListQuery,
  UpdateSavedView,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  CreateSavedViewCommand,
  DeleteSavedViewCommand,
  ListSavedViewsQuery,
  UpdateSavedViewCommand,
} from '../application/saved-views.commands.js';

const TAGS = ['Processos'];

/** "Permissões" da US-003: acesso ao escopo e posse conferidos no caso de uso. */
const VIEW_ACCESS =
  'Visões salvas (US-003 · RN-PROC-37): PROCESS_VIEW ou concessão USER (escopo PROCESS_LIST) ou INBOX_VIEW (escopo INBOX), conferidos no caso de uso com 403 + access.denied; alterar/excluir só o dono (compartilhada de outro = 403, privada de outro = 404).';

const PREFERENCE =
  'Preferência pessoal do usuário (US-003): visões guardam critérios da lista, sem dados de negócio — sem auditoria nem evento.';

/** Resposta personalizada: nenhum cache intermediário. */
function noStore(response: HttpResponse): void {
  response.setHeader('Cache-Control', 'no-store');
}

/**
 * Visões salvas da lista de processos (api/02-processes.md PRC-35..38 · US-003): critérios
 * (`filters` versionado, `sort`, `columns`) por dono e escopo, com compartilhamento somente leitura.
 */
@Controller('saved-views')
@TenantScope('TENANT')
export class SavedViewsController {
  constructor(
    private readonly list: ListSavedViewsQuery,
    private readonly create: CreateSavedViewCommand,
    private readonly update: UpdateSavedViewCommand,
    private readonly remove: DeleteSavedViewCommand,
  ) {}

  @Get()
  @ImplicitAccess(VIEW_ACCESS)
  @ApiOperation({
    operationId: 'PRC-35',
    summary: 'Listar visões salvas',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Visões do usuário no escopo (por nome) seguidas das compartilhadas por outros usuários do tenant (`isOwner = false`, somente leitura). `filters` segue `savedViewFiltersSchema` (`v: 1`).',
        schema: dataEnvelope(z.array(savedViewSchema)),
      },
    },
  })
  async listViews(
    @ZodQuery(savedViewListQuerySchema) query: SavedViewListQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SavedViewDto[]> {
    const views = await this.list.execute(query.scope);
    noStore(response);
    return views;
  }

  @Post()
  @Idempotent()
  @ImplicitAccess(VIEW_ACCESS)
  @ApiOperation({
    operationId: 'PRC-36',
    summary: 'Criar visão salva',
    tags: TAGS,
    idempotent: true,
    auditExempt: PREFERENCE,
    responses: {
      201: {
        description:
          'Visão criada (`Location` e `ETag` = versão). Nome de 1 a 80 caracteres, único por dono e escopo sem diferenciar maiúsculas (409 `CONFLICT`); até 20 visões por dono e escopo (422); `columns` com `code` e `title`; `isDefault = true` desmarca a padrão anterior na mesma transação.',
        schema: dataEnvelope(savedViewSchema),
      },
    },
  })
  async createView(
    @ZodBody(createSavedViewSchema) body: CreateSavedView,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SavedViewDto> {
    const view = await this.create.execute(body);
    response.setHeader('Location', `/api/v1/saved-views/${view.id}`);
    response.setHeader('ETag', `"${view.version}"`);
    return view;
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(VIEW_ACCESS)
  @ApiOperation({
    operationId: 'PRC-37',
    summary: 'Editar visão salva',
    tags: TAGS,
    auditExempt: PREFERENCE,
    responses: {
      200: {
        description:
          'Visão alterada (`ETag` = nova versão); PATCH sem diferença devolve a atual sem nova versão. Só o dono: compartilhada de outro = 403 `PERMISSION_DENIED`; privada de outro, inexistente ou de outro tenant = 404 `NOT_FOUND`; `If-Match` divergente = 412 `VERSION_CONFLICT`.',
        schema: dataEnvelope(savedViewSchema),
      },
    },
  })
  async updateView(
    @ZodParams(savedViewIdParamsSchema) params: { id: string },
    @ZodBody(updateSavedViewSchema) body: UpdateSavedView,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SavedViewDto> {
    const view = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${view.version}"`);
    noStore(response);
    return view;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(VIEW_ACCESS)
  @ApiOperation({
    operationId: 'PRC-38',
    summary: 'Excluir visão salva',
    tags: TAGS,
    auditExempt: PREFERENCE,
    responses: {
      204: {
        description:
          'Visão excluída. Só o dono: compartilhada de outro = 403; privada de outro, inexistente ou de outro tenant = 404; `If-Match` divergente = 412.',
      },
    },
  })
  async deleteView(
    @ZodParams(savedViewIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ id: params.id, expectedVersion: ifMatch?.value ?? 0 });
  }
}
