import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { isActiveTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { DocumentAlreadyExistsError } from '../application/document.ports.js';
import type { DocumentLabel, DocumentRepository } from '../application/document.ports.js';
import type { DocumentVersionRecord } from '../domain/document-snapshot.js';
import type { Document } from '../domain/document.js';

/** Ocupa a vaga do tipo singular no processo (o índice parcial `documents_singleton_key`). */
function holdsSingleton(document: Document): boolean {
  return (
    document.singletonKey !== null && document.status !== 'CANCELED' && document.deletedAt === null
  );
}

/**
 * Documentos e versões em memória (testes e modo de identidade fake de local/dev/test): mesma
 * semântica do adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`),
 * tipo singular por processo, concorrência otimista por `version` e versões só com inserção.
 */
@Injectable()
export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly documents = new Map<string, Document>();
  private readonly versions = new Map<string, DocumentVersionRecord>();
  /** Trava de linha por documento (`lockForUpdate`): o `tx` que a detém. */
  private readonly locks = new Map<string, TenantTx>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private inTenant(): Document[] {
    const tenantId = this.tenantId();
    return [...this.documents.values()].filter((document) => document.tenantId === tenantId);
  }

  private versionsInTenant(): DocumentVersionRecord[] {
    const tenantId = this.tenantId();
    return [...this.versions.values()].filter((version) => version.tenantId === tenantId);
  }

  private withVersionNumber(document: Document): Document {
    const current =
      document.currentVersionId === null ? undefined : this.versions.get(document.currentVersionId);
    return { ...document, currentVersionNumber: current?.versionNumber ?? null };
  }

  /** A vaga do tipo singular já ocupada por outro documento ativo do processo (ou `null`). */
  private singletonConflict(document: Document): DocumentAlreadyExistsError | null {
    if (!holdsSingleton(document)) return null;
    const taken = this.inTenant().some(
      (other) =>
        other.id !== document.id &&
        other.processId === document.processId &&
        other.singletonKey === document.singletonKey &&
        holdsSingleton(other),
    );
    return taken ? new DocumentAlreadyExistsError(document.documentTypeId) : null;
  }

  findById(_tx: TenantTx, id: string): Promise<Document | null> {
    const document = this.inTenant().find((row) => row.id === id && row.deletedAt === null);
    return Promise.resolve(document ? this.withVersionNumber(document) : null);
  }

  findActiveOfType(
    _tx: TenantTx,
    processId: string,
    documentTypeId: string,
  ): Promise<Document | null> {
    const document = this.inTenant()
      .filter(
        (row) =>
          row.processId === processId &&
          row.documentTypeId === documentTypeId &&
          row.deletedAt === null &&
          row.status !== 'CANCELED',
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    return Promise.resolve(document ? this.withVersionNumber(document) : null);
  }

  listActiveByProcess(_tx: TenantTx, processId: string): Promise<Document[]> {
    return Promise.resolve(
      this.inTenant()
        .filter(
          (row) =>
            row.processId === processId && row.deletedAt === null && row.status !== 'CANCELED',
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => this.withVersionNumber(row)),
    );
  }

  listByProcess(_tx: TenantTx, processId: string): Promise<Document[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((row) => row.processId === processId && row.deletedAt === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => this.withVersionNumber(row)),
    );
  }

  insert(_tx: TenantTx, document: Document): Promise<void> {
    const conflict = this.singletonConflict(document);
    if (conflict) return Promise.reject(conflict);
    this.documents.set(document.id, document);
    return Promise.resolve();
  }

  update(_tx: TenantTx, document: Document, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((row) => row.id === document.id && row.deletedAt === null);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'Document',
          aggregateId: document.id,
          expectedVersion,
        }),
      );
    }
    const conflict = this.singletonConflict(document);
    if (conflict) return Promise.reject(conflict);
    this.documents.set(document.id, { ...document, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  /**
   * Emula o `FOR UPDATE`: espera a transação que detém a trava terminar (o `tx` simulado deixa de
   * estar ativo no commit/rollback) — mesma serialização do PostgreSQL entre requisições paralelas.
   */
  async lockForUpdate(tx: TenantTx, documentId: string): Promise<void> {
    for (;;) {
      const holder = this.locks.get(documentId);
      if (holder === undefined || holder === tx || !isActiveTransaction(holder)) {
        this.locks.set(documentId, tx);
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  listVersions(
    _tx: TenantTx,
    documentId: string,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ items: DocumentVersionRecord[]; total: number }> {
    const all = this.versionsInTenant()
      .filter((version) => version.documentId === documentId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return Promise.resolve({
      items: all.slice(window.skip, window.skip + window.take),
      total: all.length,
    });
  }

  nextVersionNumber(_tx: TenantTx, documentId: string): Promise<number> {
    const numbers = this.versionsInTenant()
      .filter((version) => version.documentId === documentId)
      .map((version) => version.versionNumber);
    return Promise.resolve(Math.max(0, ...numbers) + 1);
  }

  insertVersion(_tx: TenantTx, version: DocumentVersionRecord): Promise<void> {
    const duplicated = this.versionsInTenant().some(
      (other) =>
        other.documentId === version.documentId && other.versionNumber === version.versionNumber,
    );
    if (duplicated) {
      return Promise.reject(new Error('document_versions_number_key: versão repetida.'));
    }
    this.versions.set(version.id, version);
    return Promise.resolve();
  }

  findVersion(_tx: TenantTx, versionId: string): Promise<DocumentVersionRecord | null> {
    return Promise.resolve(
      this.versionsInTenant().find((version) => version.id === versionId) ?? null,
    );
  }

  countByType(_tx: TenantTx, documentTypeId: string): Promise<number> {
    return Promise.resolve(
      this.inTenant().filter(
        (row) => row.documentTypeId === documentTypeId && row.deletedAt === null,
      ).length,
    );
  }

  labels(_tx: TenantTx, ids: readonly string[]): Promise<Map<string, DocumentLabel>> {
    const wanted = new Set(ids);
    return Promise.resolve(
      new Map(
        this.inTenant()
          .filter((row) => wanted.has(row.id))
          .map((row) => [
            row.id,
            {
              code: row.code,
              title: row.title,
              documentTypeId: row.documentTypeId,
              confidentiality: row.confidentiality,
            },
          ]),
      ),
    );
  }

  versionNumbers(_tx: TenantTx, versionIds: readonly string[]): Promise<Map<string, number>> {
    const wanted = new Set(versionIds);
    return Promise.resolve(
      new Map(
        this.versionsInTenant()
          .filter((version) => wanted.has(version.id))
          .map((version) => [version.id, version.versionNumber]),
      ),
    );
  }

  /** Carga de testes (documento de outro tenant, estados iniciais…). */
  seed(...documents: readonly Document[]): void {
    for (const document of documents) this.documents.set(document.id, document);
  }

  /** Carga de testes: versão já existente. */
  seedVersion(...versions: readonly DocumentVersionRecord[]): void {
    for (const version of versions) this.versions.set(version.id, version);
  }

  /** Inspeção de testes: todos os documentos (inclusive excluídos) de todos os tenants. */
  allDocuments(): readonly Document[] {
    return [...this.documents.values()];
  }

  /** Inspeção de testes: versões de um documento, por número. */
  versionsOf(documentId: string): readonly DocumentVersionRecord[] {
    return [...this.versions.values()]
      .filter((version) => version.documentId === documentId)
      .sort((a, b) => a.versionNumber - b.versionNumber);
  }
}
