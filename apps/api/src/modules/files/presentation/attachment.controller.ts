import {
  attachmentConfirmationSchema,
  attachmentIdParamsSchema,
  attachmentIntentResponseSchema,
  attachmentSchema,
  createAttachmentIntentSchema,
  dataEnvelope,
  deleteAttachmentSchema,
} from '@contrataflow/validation';
import type {
  AttachmentConfirmationDto,
  AttachmentDto,
  AttachmentIntentResponse,
  CreateAttachmentIntent,
  DeleteAttachment,
} from '@contrataflow/validation';
import { Controller, Delete, Get, Headers, HttpCode, Post, Res } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import { DataWithMembers } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import { toAttachmentDto } from '../application/attachment.view.js';
import { ConfirmAttachmentUploadCommand } from '../application/confirm-attachment-upload.command.js';
import { CreateAttachmentIntentCommand } from '../application/create-attachment-intent.command.js';
import { DeleteAttachmentCommand } from '../application/delete-attachment.command.js';
import { GetAttachmentQuery } from '../application/get-attachment.query.js';
import { reasonCodeOf } from '../domain/attachment.js';

const TAGS = ['Anexos'];

/**
 * ATT-02/03/04/06 (api/12-comments-attachments.md · US-068): upload seguro em quatro passos
 * (DEC-136) — intenção com URL `PUT` assinada da quarentena, upload direto do navegador,
 * confirmação e varredura assíncrona (`file-scan`). A rota exige a permissão em algum escopo; o
 * caso de uso confere o processo do ALVO (DEC-024: invisível = 404) e a regra de edição dele.
 */
@Controller('attachments')
@TenantScope('TENANT')
export class AttachmentController {
  constructor(
    private readonly intent: CreateAttachmentIntentCommand,
    private readonly confirmation: ConfirmAttachmentUploadCommand,
    private readonly detail: GetAttachmentQuery,
    private readonly removal: DeleteAttachmentCommand,
  ) {}

  @Post()
  @Idempotent()
  @RateLimit('upload')
  @RequirePermission('ATTACHMENT_UPLOAD', {
    detail: 'Você não tem permissão para anexar arquivos aqui.',
  })
  @ApiOperation({
    operationId: 'ATT-02',
    summary: 'Registrar intenção de upload',
    tags: TAGS,
    idempotent: true,
    auditActions: ['attachment.upload_intent'],
    responses: {
      201: {
        description:
          'Anexo `PENDING_UPLOAD` e URL `PUT` da quarentena (validade ≤ 300 s; enviar os `headers` devolvidos). Extensão/MIME fora da allowlist do tenant → 415 `FILE_TYPE_NOT_ALLOWED`; acima de `uploads.maxFileSizeMb` → 413 `FILE_TOO_LARGE`; alvo não editável → 409 `DOCUMENT_NOT_EDITABLE`/`INVALID_PROCESS_STATUS`; quota do tenant → 422 `STORAGE_QUOTA_EXCEEDED`.',
        schema: attachmentIntentResponseSchema,
      },
    },
  })
  async createIntent(
    @ZodBody(createAttachmentIntentSchema) body: CreateAttachmentIntent,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataWithMembers<AttachmentDto, Pick<AttachmentIntentResponse, 'upload'>>> {
    const { attachment, upload } = await this.intent.execute({
      body,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/attachments/${attachment.id}`);
    response.setHeader('ETag', `"${attachment.version}"`);
    return new DataWithMembers(toAttachmentDto(attachment), {
      upload: {
        url: upload.url,
        method: 'PUT',
        headers: { ...upload.headers },
        expiresAt: upload.expiresAt.toISOString(),
      },
    });
  }

  @Post(':id/confirm')
  @HttpCode(202)
  @Idempotent()
  @RequirePermission('ATTACHMENT_UPLOAD')
  @ApiOperation({
    operationId: 'ATT-03',
    summary: 'Confirmar upload',
    tags: TAGS,
    idempotent: true,
    auditActions: ['attachment.confirm'],
    responses: {
      202: {
        description:
          'Upload recebido (`UPLOADED`, varredura enfileirada) ou `REJECTED` com `reasonCode = SIZE_MISMATCH`; o status final (`AVAILABLE`/`INFECTED`/`REJECTED`) sai em ATT-04. Sem objeto na quarentena → 409 `UPLOAD_NOT_RECEIVED`; só quem enviou confirma (403).',
        schema: dataEnvelope(attachmentConfirmationSchema),
      },
    },
  })
  async confirm(
    @ZodParams(attachmentIdParamsSchema) params: { id: string },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AttachmentConfirmationDto> {
    const { attachment } = await this.confirmation.execute({
      id: params.id,
      idempotencyKey: idempotencyKey ?? null,
    });
    const reasonCode = reasonCodeOf(attachment);
    return { status: attachment.status, ...(reasonCode === null ? {} : { reasonCode }) };
  }

  @Get(':id')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'ATT-04',
    summary: 'Obter anexo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Anexo (`ETag` = versão), sem URL de download (ATT-05); `reasonCode` resumido em `INFECTED`/`REJECTED`. Excluído, de outro tenant ou de processo invisível → 404.',
        schema: dataEnvelope(attachmentSchema),
      },
    },
  })
  async getAttachment(
    @ZodParams(attachmentIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<AttachmentDto> {
    const attachment = await this.detail.execute(params.id);
    response.setHeader('ETag', `"${attachment.version}"`);
    return toAttachmentDto(attachment);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireIfMatch()
  @RequirePermission('ATTACHMENT_UPLOAD')
  @ApiOperation({
    operationId: 'ATT-06',
    summary: 'Excluir anexo',
    tags: TAGS,
    auditActions: ['attachment.delete'],
    responses: {
      204: {
        description:
          'Exclusão lógica com motivo (o binário fica retido). Anexo de terceiro exige `ATTACHMENT_DELETE`; o próprio, alvo editável. Só `AVAILABLE` (409 `ATTACHMENT_NOT_AVAILABLE`).',
      },
    },
  })
  async deleteAttachment(
    @ZodParams(attachmentIdParamsSchema) params: { id: string },
    @ZodBody(deleteAttachmentSchema) body: DeleteAttachment,
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.removal.execute({
      id: params.id,
      deletionReason: body.deletionReason,
      expectedVersion: ifMatch?.value ?? 0,
    });
  }
}
