import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DOCUMENT_ITEM_REPOSITORY } from './document-items.ports.js';
import type { DocumentItemRepository } from './document-items.ports.js';
import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { recordDocumentVersion } from './document.commands.js';
import { DOCUMENT_CLOCK } from './ports.js';
import type { DocumentClock } from './ports.js';
import { recordManualVersion } from '../domain/document.js';
import type { Document } from '../domain/document.js';
import { applyImportedSections, planImportedItems } from '../domain/imported-content.js';
import type { ImportedItemLine, ImportedSection } from '../domain/imported-content.js';

/*
 * Importação de conteúdo no documento tipado pelo módulo dono (US-037 · TRM-06 · DEC-017/019), no
 * `tx` do chamador — que já travou a linha do documento e autorizou a edição
 * (`editableTypedDocumentIn`) e gravou o próprio cabeçalho ANTES (o snapshot o congela): seções
 * (`applyImportedSections` — 422 do chamador para `ImportedSectionRejectedError`), upsert dos itens
 * por `processItemId`, documento com `version + 1` apontando a versão nova e a `DocumentVersion`
 * `reason = IMPORT` (snapshot + SHA-256) com `document.version_create` e `DocumentVersionCreated`
 * (`document.version_created.<tipo>`). A auditoria e o evento próprios da importação são do dono.
 */

export interface DocumentImportInput {
  readonly documentId: string;
  readonly sections: readonly ImportedSection[];
  readonly items: readonly ImportedItemLine[];
  /** Resumo da versão (`changeSummary`), ex.: "Importação do ETP 0001/2026 (v2)". */
  readonly changeSummary: string;
}

export interface DocumentImportResult {
  readonly document: Document;
  readonly version: { readonly id: string; readonly versionNumber: number };
  /** Linhas de item incluídas ou atualizadas (as iguais contam — foram importadas). */
  readonly itemsWritten: number;
}

@Injectable()
export class DocumentImportService {
  constructor(
    private readonly lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_ITEM_REPOSITORY) private readonly items: DocumentItemRepository,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  async importIn(tx: TenantTx, input: DocumentImportInput): Promise<DocumentImportResult> {
    const actorId = requireRequestContext().actor.userId;
    if (actorId === null) throw new ApiError('UNAUTHENTICATED');
    const context = await this.lifecycle.load(tx, input.documentId);
    const { document } = context;
    const now = this.clock();
    const maxChars = new Map(
      (context.template?.sections ?? []).map((section) => [section.key, section.maxChars]),
    );
    const withSections = this.lifecycle.transition(() =>
      applyImportedSections(document, {
        sections: input.sections,
        maxCharsOf: (key) => maxChars.get(key),
        actorId,
        now,
      }),
    );

    let itemsWritten = 0;
    if (input.items.length > 0) {
      const plan = planImportedItems({
        tenantId: document.tenantId,
        documentId: document.id,
        current: await this.items.listByDocument(tx, document.id),
        lines: input.items,
        actorId,
        now,
        newId,
      });
      await this.items.replace(tx, document.id, plan.items);
      itemsWritten = plan.written.length;
    }

    const versionId = newId();
    const versionNumber = await this.lifecycle.nextVersionNumber(tx, document.id);
    const next = this.lifecycle.transition(() =>
      recordManualVersion(withSections, { actorId, now, versionId, versionNumber }),
    );
    // Gravação condicionada ANTES da versão (FKs `DEFERRABLE`), como nas transições.
    const saved = await this.lifecycle.save(tx, next, document.version);
    const version = await this.lifecycle.createVersion(tx, context, {
      document: saved,
      versionId,
      versionNumber,
      reason: 'IMPORT',
      actorId,
      now,
      changeSummary: input.changeSummary,
    });
    await recordDocumentVersion(this.audit, this.outbox, tx, context, version);
    return { document: saved, version: { id: versionId, versionNumber }, itemsWritten };
  }
}
