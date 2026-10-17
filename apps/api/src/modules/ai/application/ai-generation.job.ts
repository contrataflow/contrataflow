import { currentJobLogFields } from '@contrataflow/observability';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { MEMBERSHIP_PORT, TENANT_STATUS_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, TenantStatusPort } from '#shared/auth/ports.js';
import { requireRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { TenantJob } from '#shared/jobs/tenant-job.js';
import type { JobMeta } from '#shared/jobs/tenant-job.js';

import { AiGenerationProcessor } from './ai-generation.processor.js';

/*
 * Handler do job `ai-generation/generate` (queues.md §4.5.1 · DEC-164): payload só com o
 * `generationId`; a base `TenantJob` valida `meta`/payload, ignora tenant fora de `ACTIVE` e
 * restaura o contexto — tenant do job (RLS) e o SOLICITANTE como ator — antes do pipeline.
 * Como no pipeline HTTP, o vínculo do solicitante é relido (perfis vigentes para a revalidação de
 * POL-18; vínculo inativo → cancelamento por política). Idempotente por `generationId` (claim
 * condicional no processador). Uma `AiRetryableError`
 * propaga para a fila tentar de novo com o backoff da política da fila (3 tentativas, base 10 s).
 */

export const AI_GENERATION_QUEUE = 'ai-generation';
export const AI_GENERATION_JOB = 'generate';

const payloadSchema = z.strictObject({ generationId: z.uuid() });

@Injectable()
export class AiGenerationJob extends TenantJob<z.infer<typeof payloadSchema>> {
  readonly queue = AI_GENERATION_QUEUE;
  readonly name = AI_GENERATION_JOB;
  protected readonly payloadSchema = payloadSchema;

  constructor(
    @Inject(TENANT_STATUS_PORT) tenants: TenantStatusPort,
    @Inject(MEMBERSHIP_PORT) private readonly memberships: MembershipPort,
    private readonly processor: AiGenerationProcessor,
  ) {
    super(tenants);
  }

  protected async handle(payload: z.infer<typeof payloadSchema>, meta: JobMeta): Promise<void> {
    const attempt = currentJobLogFields()?.attempt;
    const { userId } = requireRequestContext().actor;
    const membership =
      userId === null || meta.tenantId === null
        ? null
        : await this.memberships.findByUserAndTenant(userId, meta.tenantId);
    const requesterActive = membership?.status === 'ACTIVE';
    updateRequestContext({ roleKeys: requesterActive ? membership.roleKeys : [] });
    await this.processor.process({
      generationId: payload.generationId,
      attempt: typeof attempt === 'number' ? attempt : 1,
      requesterActive,
    });
  }
}
