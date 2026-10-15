import type { DocumentTypeDto, DocumentTypeListQuery } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { DocumentTypeFacade } from './document-type.facade.js';
import { toDocumentTypeDto } from './document-type.view.js';
import { DOCUMENT_CLOCK } from './ports.js';
import type { DocumentClock } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { DocumentType } from '../domain/document-type.js';

/** Minúsculas e sem acentos: a busca do SCR-108 ignora ambos. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matches(type: DocumentType, query: string): boolean {
  const needle = fold(query);
  return [type.name, type.code, type.description ?? ''].some((text) => fold(text).includes(needle));
}

/**
 * `ListDocumentTypesQuery` — DTY-01 (US-061 · RN-DOC-12): capacidade implícita do vínculo ativo
 * (só tipos ativos); `includeInactive=true` exige `DOCUMENT_TYPE_MANAGE` (+ MFA, risco alto).
 * Servida do cache por tenant, ordenada por `sortOrder` e nome.
 */
@Injectable()
export class ListDocumentTypesQuery {
  constructor(
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly facade: DocumentTypeFacade,
  ) {}

  async execute(query: DocumentTypeListQuery): Promise<DocumentTypeDto[]> {
    const includeInactive = query.includeInactive === true;
    if (includeInactive) {
      this.access.assertCan('DOCUMENT_TYPE_MANAGE', {
        mfaPolicy: await this.identity.mfaPolicy(),
      });
    }
    const now = this.clock();
    return (await this.facade.listAll())
      .filter((type) => includeInactive || type.isActive)
      .filter((type) => query.kind === undefined || query.kind.includes(type.kind))
      .filter((type) => !query.q || matches(type, query.q))
      .map((type) => toDocumentTypeDto(type, now));
  }
}
