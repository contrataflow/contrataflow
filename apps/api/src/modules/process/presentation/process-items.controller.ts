import {
  createProcessItemSchema,
  dataEnvelope,
  processIdParamsSchema,
  processItemIdParamsSchema,
  processItemSchema,
  reorderProcessItemsSchema,
  updateProcessItemSchema,
} from '@contrataflow/validation';
import type {
  CreateProcessItem,
  ProcessItemDto,
  ReorderProcessItems,
  UpdateProcessItem,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, RequirePermission } from '#shared/auth/authorization.js';
import { ApiError } from '#shared/errors/api-error.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import {
  AddProcessItemCommand,
  RemoveProcessItemCommand,
  ReorderProcessItemsCommand,
  UpdateProcessItemCommand,
} from '../application/process-items.commands.js';
import { ListProcessItemsQuery } from '../application/process-items.queries.js';

const TAGS = ['Processos'];

/** Identificador do caminho que não é UUIDv7 = 400 `MALFORMED_REQUEST` (não é campo — sem 422). */
class UuidV7Pipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = processIdParamsSchema.shape.id.safeParse(value);
    if (!parsed.success) {
      throw new ApiError('MALFORMED_REQUEST', { detail: 'Requisição inválida.' });
    }
    return parsed.data;
  }
}

/** `@PathId('id' | 'itemId')`: valida o identificador do caminho e documenta-o no OpenAPI. */
function PathId(name: 'id' | 'itemId'): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param(name, new UuidV7Pipe())(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(
        target,
        propertyKey,
        'params',
        name === 'id' ? processIdParamsSchema : processItemIdParamsSchema,
      );
    }
  };
}

/** Lista mutável e personalizada (mascaramento por usuário): nenhum cache intermediário. */
function noStore(response: HttpResponse): void {
  response.setHeader('Cache-Control', 'no-store');
}

const WRITE_RULES =
  '`PROCESS_UPDATE` cobrindo o processo + custódia (POL-01 — 403 `NOT_PROCESS_CUSTODIAN`) + status `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`). Toda alteração incrementa a versão do processo e grava `process.items_update`, `ProcessItemsChanged` e a timeline `ITEMS_CHANGED` na mesma transação.';

/**
 * Itens da contratação (api/02-processes.md · US-006): PRC-13 (listar), PRC-14 (incluir), PRC-17
 * (reordenar/renumerar) sob `/processes/{id}/items` e PRC-15/PRC-16 (editar/excluir) sob
 * `/process-items/{itemId}`. `PROCESS_UPDATE` em algum escopo no guard; o escopo sobre o processo,
 * o status e a custódia são conferidos no caso de uso, sob a trava do processo.
 */
@Controller()
@TenantScope('TENANT')
export class ProcessItemsController {
  constructor(
    private readonly list: ListProcessItemsQuery,
    private readonly add: AddProcessItemCommand,
    private readonly update: UpdateProcessItemCommand,
    private readonly remove: RemoveProcessItemCommand,
    private readonly reorder: ReorderProcessItemsCommand,
  ) {}

  @Get('processes/:id/items')
  @ImplicitAccess(
    'Itens do processo (US-006 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso sobre o runtime do mesmo tx; não visível = 404 PROCESS_NOT_FOUND igual ao inexistente.',
  )
  @ApiOperation({
    operationId: 'PRC-13',
    summary: 'Listar itens do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Itens ativos por número (`ETag` = versão do PROCESSO, o `If-Match` do PRC-17). `referenceUnitPrice` mascarado pela POL-09 (`null` + `referenceUnitPriceMasked: true`); `referenceQuantity` sempre visível (RN-PROC-84).',
        schema: dataEnvelope(z.array(processItemSchema)),
      },
    },
  })
  async listItems(
    @PathId('id') id: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessItemDto[]> {
    const { items, processVersion } = await this.list.execute(id);
    response.setHeader('ETag', `"${String(processVersion)}"`);
    noStore(response);
    return items;
  }

  @Post('processes/:id/items')
  @Idempotent()
  @RequirePermission('PROCESS_UPDATE', {
    detail: 'Você não tem permissão para alterar os itens deste processo.',
  })
  @ApiOperation({
    operationId: 'PRC-14',
    summary: 'Adicionar item ao processo',
    tags: TAGS,
    idempotent: true,
    auditActions: ['process.items_update'],
    responses: {
      201: {
        description: `Item criado com o próximo número (maior + 1 — RN-PROC-73), \`Location\` e \`ETag\` = versão do item. Unidade de medida ativa do catálogo do tenant (422 \`REFERENCE_NOT_FOUND\`/\`REFERENCE_INACTIVE\`); limite de 1.000 itens (422 \`OUT_OF_RANGE\`); nome de lote diferente renomeia o lote inteiro (RN-PROC-75). ${WRITE_RULES}`,
        schema: dataEnvelope(processItemSchema),
      },
    },
  })
  async addItem(
    @PathId('id') id: string,
    @ZodBody(createProcessItemSchema) body: CreateProcessItem,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessItemDto> {
    const { dto } = await this.add.execute({ processId: id, body });
    response.setHeader('Location', `/api/v1/process-items/${dto.id}`);
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Post('processes/:id/items/reorder')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('PROCESS_UPDATE', {
    detail: 'Você não tem permissão para alterar os itens deste processo.',
  })
  @ApiOperation({
    operationId: 'PRC-17',
    summary: 'Reordenar itens do processo',
    tags: TAGS,
    auditActions: ['process.items_update'],
    responses: {
      200: {
        description: `Itens renumerados 1..n na ordem enviada (RN-PROC-74) e \`ETag\` = nova versão do processo. \`itemIds\` deve trazer todos os itens ativos uma única vez (422 \`DUPLICATE_IN_LIST\`/\`REFERENCE_NOT_FOUND\`/\`REQUIRED\` em \`itemIds\`); \`If-Match\` com a versão do processo (412 \`VERSION_CONFLICT\`). ${WRITE_RULES}`,
        schema: dataEnvelope(z.array(processItemSchema)),
      },
    },
  })
  async reorderItems(
    @PathId('id') id: string,
    @ZodBody(reorderProcessItemsSchema) body: ReorderProcessItems,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessItemDto[]> {
    const result = await this.reorder.execute({
      processId: id,
      itemIds: body.itemIds,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(result.processVersion)}"`);
    noStore(response);
    return result.items;
  }

  @Patch('process-items/:itemId')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('PROCESS_UPDATE', {
    detail: 'Você não tem permissão para alterar os itens deste processo.',
  })
  @ApiOperation({
    operationId: 'PRC-15',
    summary: 'Editar item do processo',
    tags: TAGS,
    auditActions: ['process.items_update'],
    responses: {
      200: {
        description: `Item atualizado (\`ETag\` = nova versão do item). Quantidade e preço de referência e o número são somente leitura (422 \`NOT_ALLOWED\`); troca de unidade de item referenciado por documento ou pesquisa → 409 \`ITEM_IN_USE\` (RN-PROC-76); item de outro tenant = 404 \`NOT_FOUND\`. ${WRITE_RULES}`,
        schema: dataEnvelope(processItemSchema),
      },
    },
  })
  async updateItem(
    @PathId('itemId') itemId: string,
    @ZodBody(updateProcessItemSchema) body: UpdateProcessItem,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessItemDto> {
    const { dto } = await this.update.execute({
      itemId,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Delete('process-items/:itemId')
  @HttpCode(204)
  @RequireIfMatch()
  @RequirePermission('PROCESS_UPDATE', {
    detail: 'Você não tem permissão para alterar os itens deste processo.',
  })
  @ApiOperation({
    operationId: 'PRC-16',
    summary: 'Remover item do processo',
    tags: TAGS,
    auditActions: ['process.items_update'],
    responses: {
      204: {
        description: `Exclusão lógica, sem renumerar (RN-PROC-73). Item referenciado por documento ou pesquisa → 409 \`ITEM_IN_USE\` com \`meta.references\` (RN-PROC-79); item de outro tenant = 404 \`NOT_FOUND\`. ${WRITE_RULES}`,
      },
    },
  })
  async removeItem(
    @PathId('itemId') itemId: string,
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ itemId, expectedVersion: ifMatch?.value ?? 0 });
  }
}
