import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { DuplicateRenditionError } from '../application/rendition.ports.js';
import type {
  DocumentRenditionRepository,
  EquivalentRenditionKey,
} from '../application/rendition.ports.js';
import type { DocumentRendition } from '../domain/document-rendition.js';

const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  PENDING: ['PROCESSING', 'FAILED', 'EXPIRED'],
  PROCESSING: ['READY', 'FAILED', 'EXPIRED'],
  READY: ['EXPIRED'],
};

/**
 * Renditions em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto, gravação condicional por versão, os
 * índices únicos parciais de `CONTENT`/`APPROVAL_STAMPED` e a máquina de estados do gatilho.
 */
@Injectable()
export class InMemoryDocumentRenditionRepository implements DocumentRenditionRepository {
  readonly rows = new Map<string, DocumentRendition>();

  private inTenant(): DocumentRendition[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  private conflicts(candidate: DocumentRendition): boolean {
    if (candidate.kind !== 'CONTENT' && candidate.kind !== 'APPROVAL_STAMPED') return false;
    return [...this.rows.values()].some(
      (row) =>
        row.id !== candidate.id &&
        row.tenantId === candidate.tenantId &&
        row.kind === candidate.kind &&
        row.documentVersionId === candidate.documentVersionId &&
        row.approvalId === candidate.approvalId &&
        row.masked === candidate.masked &&
        row.status !== 'FAILED',
    );
  }

  insert(_tx: TenantTx, rendition: DocumentRendition): Promise<void> {
    if (this.conflicts(rendition)) return Promise.reject(new DuplicateRenditionError());
    this.rows.set(rendition.id, rendition);
    return Promise.resolve();
  }

  findById(_tx: TenantTx, id: string): Promise<DocumentRendition | null> {
    return Promise.resolve(this.inTenant().find((row) => row.id === id) ?? null);
  }

  findEquivalent(_tx: TenantTx, key: EquivalentRenditionKey): Promise<DocumentRendition | null> {
    const found = this.inTenant()
      .filter(
        (row) =>
          row.documentVersionId === key.documentVersionId &&
          row.kind === key.kind &&
          row.approvalId === key.approvalId &&
          row.masked === key.masked &&
          ['PENDING', 'PROCESSING', 'READY'].includes(row.status),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(found[0] ?? null);
  }

  update(_tx: TenantTx, next: DocumentRendition, expectedVersion: number): Promise<boolean> {
    const current = this.inTenant().find((row) => row.id === next.id);
    if (current?.version !== expectedVersion) return Promise.resolve(false);
    if (
      current.status !== next.status &&
      !(TRANSITIONS[current.status] ?? []).includes(next.status)
    ) {
      return Promise.reject(
        new Error(`document_renditions_guard: ${current.status} → ${next.status}`),
      );
    }
    this.rows.set(next.id, next);
    return Promise.resolve(true);
  }

  /** Testes: todas as linhas (de todos os tenants). */
  all(): DocumentRendition[] {
    return [...this.rows.values()];
  }
}
