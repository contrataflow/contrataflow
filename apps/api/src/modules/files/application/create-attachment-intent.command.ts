import { ATTACHMENT_PRESIGN_SECONDS, PROCESSLESS_ATTACHMENT_TARGETS } from '@contrataflow/types';
import type { CreateAttachmentIntent } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { AttachmentTargetRegistry } from '#shared/files/attachment-targets.js';
import { StorageKeyBuilder } from '#shared/storage/storage-keys.js';
import { StorageService } from '#shared/storage/storage.service.js';
import type { PresignedRequest } from '#shared/storage/storage.service.js';

import { AttachmentAccess, actorUserId } from './attachment-access.js';
import {
  ATTACHMENT_REPOSITORY,
  FILES_CLOCK,
  FILES_SETTINGS,
  FILES_TRANSACTIONS,
} from './files-ports.js';
import type {
  AttachmentRepository,
  FilesClock,
  FilesSettings,
  FilesTransactions,
} from './files-ports.js';
import { storageUnavailable } from './files.errors.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { createAttachment } from '../domain/attachment.js';
import type { Attachment } from '../domain/attachment.js';
import { displayFileName, storageFileName } from '../domain/file-names.js';
import { checkUpload, effectiveExtensions } from '../domain/upload-policy.js';
import type { UploadLimits } from '../domain/upload-policy.js';

/*
 * ATT-02 — Registrar intenção de upload (US-068 · RN-DOC-71/72/77/80 · DEC-136), numa transação:
 *
 *   alvo visível (404) → `ATTACHMENT_UPLOAD` cobrindo o processo do alvo (403) → regra de edição do
 *   alvo (409/403 do dono) → allowlist/tamanho do tenant (415/413) → categoria ativa (422) → quota
 *   do tenant (422) → `Attachment` `PENDING_UPLOAD` com as chaves montadas pelo servidor →
 *   auditoria `attachment.upload_intent` → URL `PUT` da quarentena (≤ 300 s).
 *
 * A URL é assinada antes do commit: falha do storage desfaz a intenção (503, nenhum anexo criado).
 * Nenhum evento de domínio nesta chamada. O nome do arquivo nunca vai para log acima de `debug`.
 */

export interface CreateAttachmentIntentInput {
  readonly body: CreateAttachmentIntent;
  readonly idempotencyKey: string | null;
}

export interface CreateAttachmentIntentResult {
  readonly attachment: Attachment;
  readonly upload: PresignedRequest;
}

const SETTING_EXTENSIONS = 'uploads.allowedExtensions';
const SETTING_MAX_SIZE = 'uploads.maxFileSizeMb';
const QUOTA_THRESHOLDS = [0.95, 0.8] as const;

@Injectable()
export class CreateAttachmentIntentCommand extends TransactionalCommandHandler<
  CreateAttachmentIntentInput,
  null,
  CreateAttachmentIntentResult
> {
  constructor(
    @Inject(FILES_TRANSACTIONS) transactions: FilesTransactions,
    @Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository,
    @Inject(FILES_CLOCK) private readonly clock: FilesClock,
    @Inject(FILES_SETTINGS) private readonly settings: FilesSettings,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly targets: AttachmentTargetRegistry,
    private readonly access: AttachmentAccess,
    private readonly storage: StorageService,
    private readonly tenancy: TenancyFacade,
    private readonly catalog: CatalogFacade,
  ) {
    super('attachment.upload_intent', transactions);
  }

  protected prepare(): Promise<null> {
    return Promise.resolve(null);
  }

  protected async handle(
    tx: TenantTx,
    input: CreateAttachmentIntentInput,
  ): Promise<CreateAttachmentIntentResult> {
    const { body } = input;
    const userId = actorUserId();
    const now = this.clock();

    const target = await this.targets.load(tx, {
      targetType: body.targetType,
      targetId: body.targetId,
    });
    if (target === null) {
      throw new ApiError('NOT_FOUND', { detail: 'Alvo do anexo não encontrado.' });
    }
    await this.access.assert(
      'ATTACHMENT_UPLOAD',
      { process: target.process },
      'Você não tem permissão para anexar arquivos aqui.',
    );
    await this.targets.assertAttachable(tx, target);

    const limits = await this.limits(tx);
    const check = checkUpload(body, limits);
    if (!check.ok) {
      throw check.violation === 'TOO_LARGE'
        ? new ApiError('FILE_TOO_LARGE', {
            detail: `O arquivo excede o limite de ${limits.maxFileSizeMb} MB.`,
            extensions: { maxFileSizeMb: limits.maxFileSizeMb },
          })
        : new ApiError('FILE_TYPE_NOT_ALLOWED', {
            detail: `Este tipo de arquivo não é permitido. Tipos aceitos: ${effectiveExtensions(limits).join(', ')}.`,
            extensions: { allowedExtensions: effectiveExtensions(limits) },
          });
    }
    if (body.categoryId !== undefined) {
      await this.catalog.assertActive(tx, 'ATTACHMENT_CATEGORY', body.categoryId, 'categoryId');
    }
    await this.assertQuota(tx, body.sizeBytes);

    const id = newId();
    const fileName = displayFileName(body.fileName);
    const processId = PROCESSLESS_ATTACHMENT_TARGETS.includes(body.targetType)
      ? null
      : target.processId;
    const keyName = storageFileName(fileName, check.extension);
    const attachment = createAttachment({
      id,
      tenantId: requireRequestContext().tenantId ?? '',
      processId,
      targetType: body.targetType,
      targetId: body.targetId,
      categoryId: body.categoryId ?? null,
      fileName,
      extension: check.extension,
      declaredMimeType: body.declaredMimeType,
      sizeBytes: body.sizeBytes,
      storageKey:
        processId === null
          ? StorageKeyBuilder.tenantAsset(id, keyName)
          : StorageKeyBuilder.processAttachment(processId, id, keyName),
      quarantineKey: StorageKeyBuilder.quarantine(id),
      description: body.description ?? null,
      uploadedById: userId,
      now,
    });
    await this.attachments.insert(tx, attachment);
    await this.audit.record(tx, {
      action: 'attachment.upload_intent',
      entityType: 'Attachment',
      entityId: attachment.id,
      processId,
      metadata: {
        targetType: attachment.targetType,
        targetId: attachment.targetId,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const upload = await this.presign(attachment);
    return { attachment, upload };
  }

  protected override committed(result: CreateAttachmentIntentResult): void {
    const { attachment } = result;
    this.logger.log(
      {
        event: 'attachment.upload_intent_created',
        attachmentId: attachment.id,
        targetType: attachment.targetType,
        sizeBytes: attachment.sizeBytes,
        correlationId: requireRequestContext().correlationId,
      },
      'attachment.upload_intent_created',
    );
  }

  private async limits(tx: TenantTx): Promise<UploadLimits> {
    const values = await this.tenancy.settingValues(tx, [SETTING_EXTENSIONS, SETTING_MAX_SIZE]);
    const extensions = values.get(SETTING_EXTENSIONS);
    const maxFileSizeMb = values.get(SETTING_MAX_SIZE);
    return {
      allowedExtensions: Array.isArray(extensions) ? extensions.map(String) : [],
      maxFileSizeMb: typeof maxFileSizeMb === 'number' ? maxFileSizeMb : 0,
    };
  }

  /**
   * RN-DOC-80 (storage.md §8): uso retido + o arquivo novo acima do limite técnico → 422; ao
   * cruzar 80%/95%, log `storage.quota_threshold_reached` (sem rótulo de tenant em métrica).
   */
  private async assertQuota(tx: TenantTx, sizeBytes: number): Promise<void> {
    const quota = this.settings.tenantQuotaBytes;
    const used = await this.attachments.usedBytes(tx);
    if (used + sizeBytes > quota) {
      throw new ApiError('STORAGE_QUOTA_EXCEEDED', {
        detail: 'O órgão atingiu o limite de armazenamento de arquivos. Procure o administrador.',
      });
    }
    const crossed = QUOTA_THRESHOLDS.find(
      (threshold) => used < quota * threshold && used + sizeBytes >= quota * threshold,
    );
    if (crossed !== undefined) {
      this.logger.warn(
        {
          event: 'storage.quota_threshold_reached',
          tenantId: requireRequestContext().tenantId,
          thresholdPct: Math.round(crossed * 100),
          correlationId: requireRequestContext().correlationId,
        },
        'storage.quota_threshold_reached',
      );
    }
  }

  private async presign(attachment: Attachment): Promise<PresignedRequest> {
    try {
      return await this.storage.presignPut({
        ref: { bucket: 'quarantine', key: attachment.quarantineKey ?? '' },
        contentType: attachment.declaredMimeType,
        contentLength: attachment.sizeBytes,
        expiresInSeconds: ATTACHMENT_PRESIGN_SECONDS,
      });
    } catch (error) {
      throw storageUnavailable(error);
    }
  }
}
