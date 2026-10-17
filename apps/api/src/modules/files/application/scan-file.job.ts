import { currentJobLogFields } from '@contrataflow/observability';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';
import type { TenantStatusPort } from '#shared/auth/ports.js';
import { TenantJob } from '#shared/jobs/tenant-job.js';

import { FILES_SETTINGS } from './files-ports.js';
import type { FilesSettings } from './files-ports.js';
import { ScanFileProcessor } from './scan-file.processor.js';

/*
 * Handler do job `file-scan/scan` (queues.md §4.5 · US-068): payload só com o `attachmentId`
 * (`jobId` = `attachmentId` — padrão B). A base `TenantJob` valida `meta`/payload, ignora tenant
 * fora de `ACTIVE` e restaura o contexto do tenant (RLS) e do ator — quem confirmou o upload —
 * antes do processador, que é idempotente pela trava condicional de `SCANNING`.
 */

export const FILE_SCAN_QUEUE = 'file-scan';
export const FILE_SCAN_JOB = 'scan';

const payloadSchema = z.strictObject({ attachmentId: z.uuid() });

@Injectable()
export class ScanFileJob extends TenantJob<z.infer<typeof payloadSchema>> {
  readonly queue = FILE_SCAN_QUEUE;
  readonly name = FILE_SCAN_JOB;
  protected readonly payloadSchema = payloadSchema;

  constructor(
    @Inject(TENANT_STATUS_PORT) tenants: TenantStatusPort,
    @Inject(FILES_SETTINGS) private readonly settings: FilesSettings,
    private readonly processor: ScanFileProcessor,
  ) {
    super(tenants);
  }

  protected async handle(payload: z.infer<typeof payloadSchema>): Promise<void> {
    const attempt = currentJobLogFields()?.attempt;
    const current = typeof attempt === 'number' ? attempt : 1;
    await this.processor.process({
      attachmentId: payload.attachmentId,
      attempt: current,
      lastAttempt: current >= this.settings.scanAttempts,
    });
  }
}
