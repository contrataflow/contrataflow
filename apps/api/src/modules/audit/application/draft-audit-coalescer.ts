import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { DRAFT_AUDIT_WINDOW_STORE } from '#shared/audit/draft-audit.js';
import type {
  DraftAuditCoalescerPort,
  DraftAuditTarget,
  DraftAuditTicket,
  DraftAuditWindowStorePort,
} from '#shared/audit/draft-audit.js';

/** Intervalo mínimo entre logs `audit.coalesce_store_unavailable` (um por minuto). */
const UNAVAILABLE_LOG_INTERVAL_MS = 60_000;

/**
 * `DraftAuditCoalescer` (US-015 · RN-DFD-35): a janela de 10 min (`audit.coalesce.windowMs`, fixa
 * por decisão) por (documento, alvo, usuário) no Redis. Quem grava o rascunho abre a janela antes
 * da transação e, se `record`, audita com a faixa `fromRevision..toRevision`. Nunca lança: com o
 * Redis fora, toda gravação é auditada (fail-safe) e o `warn` sai agregado por minuto.
 */
@Injectable()
export class DraftAuditCoalescer implements DraftAuditCoalescerPort {
  private readonly logger = new Logger('Audit');
  private lastUnavailableLogAt = Number.NEGATIVE_INFINITY;

  constructor(
    @Inject(DRAFT_AUDIT_WINDOW_STORE) private readonly store: DraftAuditWindowStorePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async open(target: DraftAuditTarget): Promise<DraftAuditTicket> {
    const key = [target.tenantId, target.documentId, target.target, target.userId].join('|');
    try {
      const { opened, lastAuditedRevision } = await this.store.open(
        key,
        this.config.audit.coalesce.windowMs,
      );
      return { key, record: opened, opened, lastAuditedRevision };
    } catch (error) {
      this.unavailable(error);
      return { key, record: true, opened: false, lastAuditedRevision: null };
    }
  }

  fromRevision(ticket: DraftAuditTicket, toRevision: number): number {
    const last = ticket.lastAuditedRevision;
    return last !== null && last < toRevision ? last + 1 : toRevision;
  }

  async recorded(ticket: DraftAuditTicket, toRevision: number): Promise<void> {
    try {
      await this.store.markAudited(ticket.key, toRevision);
    } catch (error) {
      this.unavailable(error);
    }
  }

  async abandon(ticket: DraftAuditTicket): Promise<void> {
    if (!ticket.opened) return;
    try {
      await this.store.release(ticket.key);
    } catch (error) {
      this.unavailable(error);
    }
  }

  private unavailable(error: unknown): void {
    const now = Date.now();
    if (now - this.lastUnavailableLogAt < UNAVAILABLE_LOG_INTERVAL_MS) return;
    this.lastUnavailableLogAt = now;
    this.logger.warn(
      {
        event: 'audit.coalesce_store_unavailable',
        cause: error instanceof Error ? error.name : 'unknown',
      },
      'audit.coalesce_store_unavailable',
    );
  }
}
