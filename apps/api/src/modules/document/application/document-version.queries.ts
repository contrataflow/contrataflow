import { DOCUMENT_VERSION_MESSAGES, MAX_PAGE_SIZE } from '@contrataflow/validation';
import type {
  DocumentVersionComparisonDto,
  DocumentVersionDto,
  DocumentVersionListQuery,
  DocumentVersionSummaryDto,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';
import { pageResult, pageWindow } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext } from './document-lifecycle.service.js';
import { toDocumentVersionDto, toDocumentVersionSummaryDto } from './document-version.view.js';
import { documentNotFound } from './document.errors.js';
import { DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentTransactions } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { DocumentVersionRecord } from '../domain/document-snapshot.js';
import { diffDocumentVersions } from '../domain/document-version-comparator.js';

/*
 * Leituras das versões imutáveis (US-066 · DOC-15/17/18): `PROCESS_VIEW` na rota; documento ou
 * versão de outro tenant, excluído ou de processo não visível → 404 (DEC-024). Campos monetários
 * do snapshot passam por POL-09 (RN-DOC-61). Somente leitura: sem auditoria nem eventos; a
 * comparação é calculada sob demanda (sem cache no MVP 1).
 */
@Injectable()
export class DocumentVersionQueries {
  private readonly logger = new Logger('Documents');

  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly identity: IdentityFacade,
  ) {}

  /** DOC-15 (RN-DOC-59): por `versionNumber` desc, sem o snapshot. */
  list(
    documentId: string,
    query: DocumentVersionListQuery,
  ): Promise<PageResult<DocumentVersionSummaryDto>> {
    return this.transactions.read(async (tx) => {
      await this.lifecycle.load(tx, documentId);
      const window = pageWindow(query, MAX_PAGE_SIZE);
      const { items, total } = await this.lifecycle.listVersions(tx, documentId, window);
      const names = await this.authorNames(tx, items);
      return pageResult(
        items.map((version) => toDocumentVersionSummaryDto(version, names)),
        window,
        total,
      );
    });
  }

  /** DOC-17: a versão com o snapshot, mascarado conforme POL-09. */
  get(versionId: string): Promise<DocumentVersionDto> {
    return this.transactions.read(async (tx) => {
      const version = await this.lifecycle.findVersion(tx, versionId);
      if (version === null) throw documentNotFound();
      const context = await this.lifecycle.load(tx, version.documentId);
      const masker = await this.maskerFor(context, [version]);
      return toDocumentVersionDto(
        version,
        context.type.kind,
        masker(version.content),
        await this.authorNames(tx, [version]),
      );
    });
  }

  /**
   * DOC-18 (RN-DOC-60/61): as duas versões precisam ser do documento do caminho — de outro
   * documento, inexistentes ou de outro tenant respondem igual (422 `REFERENCE_NOT_FOUND`, sem
   * revelar nada); iguais já são recusadas pelo schema da query (V-05).
   */
  compare(
    documentId: string,
    query: { readonly from: string; readonly to: string },
  ): Promise<DocumentVersionComparisonDto> {
    const startedAt = performance.now();
    return this.transactions.read(async (tx) => {
      const context = await this.lifecycle.load(tx, documentId);
      const from = await this.versionOf(tx, documentId, query.from, 'from');
      const to = await this.versionOf(tx, documentId, query.to, 'to');
      const masker = await this.maskerFor(context, [from, to]);
      const fromContent = masker(from.content);
      const toContent = masker(to.content);
      const diff = diffDocumentVersions(
        context.type.kind,
        { content: fromContent, contentHash: from.contentHash, attachmentId: from.attachmentId },
        { content: toContent, contentHash: to.contentHash, attachmentId: to.attachmentId },
      );
      const names = await this.authorNames(tx, [from, to]);
      this.logger.log(
        {
          event: 'document.versions_compared',
          documentId,
          fromVersion: from.versionNumber,
          toVersion: to.versionNumber,
          durationMs: Math.round(performance.now() - startedAt),
          correlationId: requireRequestContext().correlationId,
        },
        'document.versions_compared',
      );
      return {
        documentId,
        kind: context.type.kind,
        from: toDocumentVersionSummaryDto(from, names),
        to: toDocumentVersionSummaryDto(to, names),
        ...diff,
      };
    });
  }

  private async versionOf(
    tx: TenantTx,
    documentId: string,
    versionId: string,
    field: 'from' | 'to',
  ): Promise<DocumentVersionRecord> {
    const version = await this.lifecycle.findVersion(tx, versionId);
    if (version?.documentId !== documentId) {
      throw validationError([
        {
          field,
          code: 'REFERENCE_NOT_FOUND',
          message: DOCUMENT_VERSION_MESSAGES.versionsOfOtherDocument,
        },
      ]);
    }
    return version;
  }

  private maskerFor(context: DocumentContext, versions: readonly DocumentVersionRecord[]) {
    return this.lifecycle.confidentialMasker(context, versions);
  }

  private authorNames(
    tx: TenantTx,
    versions: readonly DocumentVersionRecord[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(versions.map((version) => version.createdById))];
    return ids.length === 0
      ? Promise.resolve(new Map<string, string>())
      : this.identity.userDisplayNames(tx, ids);
  }
}
