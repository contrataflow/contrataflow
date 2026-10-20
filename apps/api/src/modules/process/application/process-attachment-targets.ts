import { FINAL_PROCESS_STATUSES } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { isProcessVisible } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import type {
  AttachmentTarget,
  AttachmentTargetReader,
  AttachmentTargetRef,
} from '#shared/files/attachment-targets.js';

import { PROCESS_RUNTIME_READER } from './ports.js';
import type { ProcessRuntimeReader } from './ports.js';
import { ProcessRuntimeAccessReader } from './process-access.reader.js';
import { AccessFacade } from '../../access/application/access.facade.js';

/*
 * Alvo de anexo `PROCESS` (US-068 · RN-DOC-71 · V-04): o processo visível ao usuário (DEC-024,
 * senão 404). Anexar exige o processo fora de status final (`CANCELED`/`COMPLETED`/`PUBLISHED` →
 * 409 `INVALID_PROCESS_STATUS`); a custódia/participação como regra de edição do processo fica com
 * o épico de tramitação (story, "Políticas").
 */

@Injectable()
export class ProcessAttachmentTargets implements AttachmentTargetReader {
  readonly targetTypes = ['PROCESS'] as const;

  constructor(
    @Inject(PROCESS_RUNTIME_READER) private readonly runtimes: ProcessRuntimeReader,
    private readonly accessReader: ProcessRuntimeAccessReader,
    private readonly access: AccessFacade,
  ) {}

  async load(tx: TenantTx, ref: AttachmentTargetRef): Promise<AttachmentTarget | null> {
    const process = await this.accessReader.load(tx, ref.targetId);
    if (process === null) return null;
    if (!isProcessVisible(await this.access.processVisibilityScope(), process)) return null;
    return { ...ref, processId: process.processId, process };
  }

  async assertAttachable(tx: TenantTx, target: AttachmentTarget): Promise<void> {
    const runtime = await this.runtimes.load(tx, target.targetId);
    if (runtime === null) throw new ApiError('NOT_FOUND');
    if (FINAL_PROCESS_STATUSES.includes(runtime.status)) {
      throw new ApiError('INVALID_PROCESS_STATUS', {
        detail: 'Não é possível anexar arquivos neste momento.',
        extensions: { processStatus: runtime.status },
      });
    }
  }
}
