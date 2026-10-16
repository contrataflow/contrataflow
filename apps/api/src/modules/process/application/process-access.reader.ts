import { Inject, Injectable } from '@nestjs/common';

import type { ProcessAccessReader, ProcessAccessTarget } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { PROCESS_RUNTIME_READER } from './ports.js';
import type { ProcessRuntimeReader } from './ports.js';

/**
 * Lado `process` da porta `ProcessAccessRegistry` (US-097): o processo como a autorização o vê —
 * órgão, concessões `ProcessAccess` e participações — lido do runtime no `tx` da autorização (RLS:
 * de outro tenant = inexistente). A US-001 pode trocar por uma leitura só das concessões sem mudar
 * quem chama.
 */
@Injectable()
export class ProcessRuntimeAccessReader implements ProcessAccessReader {
  constructor(@Inject(PROCESS_RUNTIME_READER) private readonly runtimes: ProcessRuntimeReader) {}

  async load(tx: TenantTx, processId: string): Promise<ProcessAccessTarget | null> {
    const runtime = await this.runtimes.load(tx, processId);
    if (runtime === null) return null;
    return {
      processId: runtime.id,
      organizationId: runtime.organizationId ?? null,
      departmentIds: runtime.access.departmentIds,
      userIds: runtime.access.userIds,
      participations: runtime.access.participations ?? [],
    };
  }
}
