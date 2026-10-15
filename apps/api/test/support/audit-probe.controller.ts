import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { newId } from '#shared/database/ids.js';
import { ApiError } from '#shared/errors/api-error.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

const createProcessSchema = z.object({
  title: z.string().min(1),
  requesterCpf: z.string().optional(),
  /** Ação de auditoria a gravar (para provocar V-01 com `foo.bar`). */
  action: z.string().default('process.create'),
});

/**
 * Caso de uso de exemplo do padrão transacional da US-073 (o `CreateProcessHandler` real chega com
 * a US-001): a mudança de negócio (um evento no outbox) e o `AuditLog` na MESMA transação.
 */
@Controller('_test/audit')
export class AuditProbeController {
  constructor(
    private readonly transaction: TenantTransaction,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  @Post('processes')
  @HttpCode(201)
  async createProcess(@ZodBody(createProcessSchema) body: z.infer<typeof createProcessSchema>) {
    const processId = newId();
    return this.transaction.run(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type,
                                   aggregate_id, payload, metadata)
        VALUES (${newId()}::uuid, current_setting('app.tenant_id')::uuid, 'ProcessCreated',
                'process.created', 'Process', ${processId}::uuid, '{}'::jsonb, '{}'::jsonb)`;
      const outcome = await this.audit.record(tx, {
        action: body.action as 'process.create',
        entityType: 'Process',
        entityId: processId,
        processId,
        changes: [
          { path: 'title', old: null, new: body.title },
          ...(body.requesterCpf
            ? [{ path: 'requester.cpf', old: null, new: body.requesterCpf }]
            : []),
        ],
        metadata: { processCode: 'PRC-2026/0001' },
      });
      return { processId, audit: outcome };
    });
  }

  /** `POST /processes` sem `PROCESS_CREATE` (a autorização por permissão chega com a US-097). */
  @Post('forbidden')
  forbidden(): never {
    throw new ApiError('PERMISSION_DENIED', { auditReasonCode: 'PROCESS_CREATE' });
  }
}
