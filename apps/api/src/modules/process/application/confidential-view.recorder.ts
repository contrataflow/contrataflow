import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { requireRequestContext } from '#shared/context/request-context.js';

/** Validade da marca "já auditado nesta sessão" (sessão absoluta máxima do BFF). */
export const CONFIDENTIAL_VIEW_TTL_SECONDS = 12 * 3600;

const CACHE_MODULE = 'process';
const marker = z.literal('1');

/**
 * `process.confidential_view` (US-004 · RN-PROC-55 · regra de US-013): a entrega de valores
 * desmascarados de processo sigiloso é auditada UMA vez por sessão e processo — duas abas e
 * recargas não repetem o registro. A marca fica no cache do tenant; leituras concorrentes da
 * mesma instância compartilham a gravação em andamento. Grava em transação curta própria
 * (`recordStandalone`), depois da leitura; falha da auditoria propaga (nada sai sem registro).
 * Cache fora do ar: grava assim mesmo (pode repetir — nunca deixa de auditar).
 */
@Injectable()
export class ConfidentialViewRecorder {
  private readonly logger = new Logger('ProcessConfidentialView');
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly cache: TenantCache,
  ) {}

  async recordOnce(
    process: { readonly id: string; readonly code: string | null },
    source: 'PRC-04' | 'PRC-07' | 'PRC-33',
  ): Promise<void> {
    const context = requireRequestContext();
    const session = context.sessionIdHash ?? `user.${context.actor.userId ?? 'anonymous'}`;
    const key = `confidential-view:${session}:${process.id}`;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const work = this.record(key, process, source).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async record(
    key: string,
    process: { readonly id: string; readonly code: string | null },
    source: 'PRC-04' | 'PRC-07' | 'PRC-33',
  ): Promise<void> {
    if ((await this.cached(key)) !== null) return;
    await this.audit.recordStandalone({
      action: 'process.confidential_view',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      metadata: { processCode: process.code, source },
    });
    try {
      await this.cache.set(CACHE_MODULE, key, '1', { ttlSeconds: CONFIDENTIAL_VIEW_TTL_SECONDS });
    } catch (error) {
      this.cacheUnavailable(error);
    }
  }

  private async cached(key: string): Promise<'1' | null> {
    try {
      return await this.cache.get(CACHE_MODULE, key, marker);
    } catch (error) {
      this.cacheUnavailable(error);
      return null;
    }
  }

  private cacheUnavailable(error: unknown): void {
    this.logger.warn(
      {
        event: 'process.confidential_view_cache_unavailable',
        cause: error instanceof Error ? error.name : 'unknown',
        correlationId: requireRequestContext().correlationId,
      },
      'process.confidential_view_cache_unavailable',
    );
  }
}
