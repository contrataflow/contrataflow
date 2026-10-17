import {
  commentIdParamsSchema,
  commentListMetaSchema,
  commentListQuerySchema,
  commentSchema,
  commentThreadSchema,
  createCommentSchema,
  dataEnvelope,
  deleteCommentSchema,
  processIdParamsSchema,
  updateCommentSchema,
} from '@contrataflow/validation';
import type {
  CommentDto,
  CommentListMetaDto,
  CommentListQuery,
  CommentThreadDto,
  CreateComment,
  DeleteComment,
  UpdateComment,
} from '@contrataflow/validation';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import { ApiError } from '#shared/errors/api-error.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery, ZodValidationPipe } from '#shared/validation/zod-validation.pipe.js';

import {
  CreateCommentCommand,
  DeleteCommentCommand,
  UpdateCommentCommand,
} from '../application/comment.commands.js';
import { ListCommentsQuery } from '../application/comment.queries.js';

const TAGS = ['Comentários'];

/** Identificador do caminho que não é UUIDv7 = 400 `MALFORMED_REQUEST` (não é campo — sem 422). */
class UuidV7Pipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = commentIdParamsSchema.shape.id.safeParse(value);
    if (!parsed.success) {
      throw new ApiError('MALFORMED_REQUEST', { detail: 'Requisição inválida.' });
    }
    return parsed.data;
  }
}

/** `@PathId('process' | 'comment')`: valida o `:id` do caminho e documenta-o no OpenAPI. */
function PathId(kind: 'process' | 'comment'): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('id', new UuidV7Pipe())(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(
        target,
        propertyKey,
        'params',
        kind === 'process' ? processIdParamsSchema : commentIdParamsSchema,
      );
    }
  };
}

/** Corpo opcional do DELETE (sem corpo = `{}`), validado e documentado como os demais. */
function OptionalZodBody(schema: z.ZodType): ParameterDecorator {
  const pipe = new ZodValidationPipe(schema);
  return (target, propertyKey, index) => {
    Body({ transform: (value: unknown) => pipe.transform(value ?? {}) })(
      target,
      propertyKey,
      index,
    );
    if (propertyKey !== undefined) recordRequestSchema(target, propertyKey, 'body', schema);
  };
}

/** Lista personalizada (`canEdit`/`canModerate` por usuário): nenhum cache intermediário. */
function noStore(response: HttpResponse): void {
  response.setHeader('Cache-Control', 'no-store');
}

const READ_ACCESS =
  'Comentários do processo (US-071 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 PROCESS_NOT_FOUND igual ao inexistente.';
const CREATE_ACCESS =
  'COMMENT_CREATE cobrindo o processo — por perfil com escopo ou por participação OBSERVER/COLLABORATOR/CONSULTANT (RN-CMT-07 · permissions.md §4) — conferida no caso de uso; sem permissão = 403 PERMISSION_DENIED com access.denied.';
const AUTHOR_ACCESS =
  'Autor do comentário (RN-CMT-09/10) ou, na exclusão, COMMENT_MODERATE com escopo que cubra o processo (RN-CMT-11 — 403 com access.denied), conferidos no caso de uso.';

const COMMENT_LIST_RESPONSE = z.object({
  data: z.array(commentThreadSchema),
  meta: commentListMetaSchema,
});

/**
 * Comentários (api/12-comments-attachments.md · US-071): CMT-01/CMT-02 sob
 * `/processes/{id}/comments` e CMT-03/CMT-04 sob `/comments/{id}`. Visibilidade, permissão
 * (`COMMENT_CREATE` — que a participação também concede — e `COMMENT_MODERATE`) e status do
 * processo são conferidos no caso de uso, sobre o processo do comentário.
 */
@Controller()
@TenantScope('TENANT')
export class CommentController {
  constructor(
    private readonly list: ListCommentsQuery,
    private readonly create: CreateCommentCommand,
    private readonly update: UpdateCommentCommand,
    private readonly remove: DeleteCommentCommand,
  ) {}

  @Get('processes/:id/comments')
  @ImplicitAccess(READ_ACCESS)
  @ApiOperation({
    operationId: 'CMT-01',
    summary: 'Listar comentários',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Threads (raízes por `createdAt` decrescente, cursor opaco, `limit` 1–100, padrão 20), cada uma com até 20 respostas em ordem crescente e `replyCount`; `?parentId=` pagina as respostas de uma thread (FA-10). Filtros `targetType`, `documentId`, `sectionKey` (FA-09). Excluídos vêm com `body` nulo e `isDeleted`; em documento `RESTRICTED`, quem não atende POL-09 recebe `body` nulo e `bodyMasked: true` (RN-CMT-13). `meta`: `canComment`, `readOnly` (status final — RN-CMT-08) e `isBudgetConfidential` (FA-07).',
        schema: COMMENT_LIST_RESPONSE,
      },
    },
  })
  async listComments(
    @PathId('process') id: string,
    @ZodQuery(commentListQuerySchema) query: CommentListQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<CommentThreadDto[], CommentListMetaDto>> {
    const { threads, meta } = await this.list.execute(id, query);
    noStore(response);
    return new DataResult(threads, meta);
  }

  @Post('processes/:id/comments')
  @Idempotent()
  @ImplicitAccess(CREATE_ACCESS)
  @ApiOperation({
    operationId: 'CMT-02',
    summary: 'Criar comentário',
    tags: TAGS,
    idempotent: true,
    auditActions: ['comment.create'],
    responses: {
      201: {
        description:
          'Comentário (ou resposta — `parentId` de um comentário raiz do processo, herdando o alvo — RN-CMT-02) com `Location` e `ETag: "1"`. `body` TipTap restrito (RN-CMT-03..05): nó/marca/atributo fora do schema, JSON > 100 KB ou link fora de http/https/mailto → 422 `RICH_TEXT_INVALID`; texto vazio ou > 10.000 → 422 `VALIDATION_ERROR`. Documento inexistente/de outro processo → 422 `REFERENCE_NOT_FOUND`; cancelado → 409 `INVALID_STATE`; seção fora do template → 422 `SECTION_NOT_IN_TEMPLATE`; processo em status final → 409 `INVALID_PROCESS_STATUS`. Grava `comment.create` e `CommentCreated` (timeline `COMMENT_ADDED`; `COMMENT_REPLY` ao autor do pai).',
        schema: dataEnvelope(commentSchema),
      },
    },
  })
  async createComment(
    @PathId('process') id: string,
    @ZodBody(createCommentSchema) body: CreateComment,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<CommentDto> {
    const { dto } = await this.create.execute({
      processId: id,
      body,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/comments/${dto.id}`);
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Patch('comments/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(AUTHOR_ACCESS)
  @ApiOperation({
    operationId: 'CMT-03',
    summary: 'Editar comentário',
    tags: TAGS,
    auditActions: ['comment.update'],
    responses: {
      200: {
        description:
          'Novo conteúdo e `editedAt` (`ETag` = nova versão). Só o autor (403 `PERMISSION_DENIED`), até 15 minutos depois da criação (409 `COMMENT_EDIT_WINDOW_EXPIRED`), comentário não excluído (409 `INVALID_STATE`) e processo fora de status final (409 `INVALID_PROCESS_STATUS`). `If-Match` divergente → 412 `VERSION_CONFLICT`. Grava `comment.update` (hash e tamanho antes/depois) e `CommentUpdated`.',
        schema: dataEnvelope(commentSchema),
      },
    },
  })
  async updateComment(
    @PathId('comment') id: string,
    @ZodBody(updateCommentSchema) body: UpdateComment,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<CommentDto> {
    const { dto } = await this.update.execute({
      commentId: id,
      body: body.body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(dto.version)}"`);
    return dto;
  }

  @Delete('comments/:id')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(AUTHOR_ACCESS)
  @ApiOperation({
    operationId: 'CMT-04',
    summary: 'Excluir ou moderar comentário',
    tags: TAGS,
    auditActions: ['comment.delete', 'comment.moderate'],
    responses: {
      204: {
        description:
          'Exclusão lógica pelo autor (respostas permanecem; respeita o status do processo — RN-CMT-10) ou moderação por quem tem `COMMENT_MODERATE` cobrindo o processo, com `reason` de 10–1.000 caracteres e em qualquer status (RN-CMT-11). Grava `comment.delete`/`comment.moderate` e `CommentDeleted` (`byModerator`; timeline `COMMENT_REMOVED` na moderação). `If-Match` divergente → 412 `VERSION_CONFLICT`.',
      },
    },
  })
  async deleteComment(
    @PathId('comment') id: string,
    @OptionalZodBody(deleteCommentSchema) body: DeleteComment,
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ commentId: id, body, expectedVersion: ifMatch?.value ?? 0 });
  }
}
