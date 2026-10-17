import { Injectable } from '@nestjs/common';

import { DocumentFacade } from '#modules/document/application/document.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/*
 * Fontes de nomes congelados (RN-TML-04) dos eventos de documento (US-065 · events.md §4.3): o
 * rótulo do documento (código, título e nome do tipo) e o número da versão. Pela fachada do módulo
 * `document`, no `tx` do caso de uso (RLS do tenant).
 */

/** Fonte `DOCUMENT`: `documentLabel` das entradas `DOCUMENT_*`. */
@Injectable()
export class DocumentLookupSource implements TimelineLookupSource<'DOCUMENT'> {
  readonly kind = 'DOCUMENT';

  constructor(private readonly documents: DocumentFacade) {}

  lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['DOCUMENT']>> {
    return this.documents.documentLabels(tx, ids);
  }
}

/** Fonte `DOCUMENT_VERSION`: número da versão. */
@Injectable()
export class DocumentVersionLookupSource implements TimelineLookupSource<'DOCUMENT_VERSION'> {
  readonly kind = 'DOCUMENT_VERSION';

  constructor(private readonly documents: DocumentFacade) {}

  async lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['DOCUMENT_VERSION']>> {
    const numbers = await this.documents.versionNumbers(tx, ids);
    return new Map([...numbers].map(([id, versionNumber]) => [id, { versionNumber }]));
  }
}
