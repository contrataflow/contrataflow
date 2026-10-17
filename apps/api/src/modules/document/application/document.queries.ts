import type { DocumentValidationDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentTransitionResult } from './document.commands.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';

/*
 * Leituras do documento (US-065): DOC-03 (mínimo para a SCR-105 — a US-062 completa o painel) e
 * DOC-08 (validação de completude). `PROCESS_VIEW` na rota; documento de processo não visível,
 * excluído ou de outro tenant → 404 (DEC-024). Somente leitura: sem auditoria nem eventos.
 */
@Injectable()
export class DocumentQueries {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  /** DOC-03: o documento com `meta.allowedActions` (RN-DOC-18). */
  get(documentId: string): Promise<Omit<DocumentTransitionResult, 'transition'>> {
    return this.transactions.read(async (tx) => {
      const context = await this.lifecycle.load(tx, documentId);
      const actor = await this.lifecycle.actorOf(context);
      return {
        document: context.document,
        type: context.type,
        allowedActions: this.lifecycle.allowedActions(context, actor),
      };
    });
  }

  /**
   * DOC-08 (RN-DOC-51): regras genéricas + `DocumentValidator` do módulo tipado num único
   * `violations[]` — indicador não bloqueante, o mesmo cálculo que finalizar/submeter reaplicam.
   */
  validation(documentId: string): Promise<DocumentValidationDto> {
    return this.transactions.read(async (tx) => {
      const context = await this.lifecycle.load(tx, documentId);
      const { sections, violations } = await this.lifecycle.evaluate(tx, context);
      const blocking = violations.filter((item) => item.severity === 'BLOCKING').length;
      return {
        documentId: context.document.id,
        isComplete: blocking === 0,
        draftRevision: context.document.draftRevision,
        evaluatedAt: this.clock().toISOString(),
        summary: { blocking, warnings: violations.length - blocking },
        sections: sections.map((section) => ({ ...section })),
        violations: [...violations],
      };
    });
  }
}
