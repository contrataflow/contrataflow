import type {
  DocumentAction,
  EtpDto,
  EtpMeta,
  EtpSummaryDto,
  ImportableDfdDto,
} from '@contrataflow/validation';

import type {
  Document,
  DocumentState,
  ImportableDfdSource,
} from '../../document/application/document.facade.js';
import { dfdImportPreview } from '../domain/etp.js';
import type { Etp } from '../domain/etp.js';

/* Serialização do ETP (US-019 · api/06-etp.md ETP-01/02): o cabeçalho tipado + o resumo do documento. */

export function toEtpDto(
  etp: Etp,
  document: Pick<
    Document,
    'code' | 'title' | 'status' | 'templateVersionId' | 'version' | 'responsibleId'
  >,
  itemsCount: number,
): EtpDto {
  return {
    id: etp.id,
    documentId: etp.documentId,
    processId: etp.processId,
    code: document.code,
    title: document.title,
    status: document.status,
    conclusion: etp.conclusion,
    importedFromDfdVersionId: etp.importedFromDfdVersionId,
    responsibleId: document.responsibleId,
    templateVersionId: document.templateVersionId,
    documentVersion: document.version,
    itemsCount,
    createdAt: etp.createdAt.toISOString(),
    updatedAt: etp.updatedAt.toISOString(),
    version: etp.version,
  };
}

export function toEtpMeta(allowedActions: readonly DocumentAction[]): EtpMeta {
  return { allowedActions: [...allowedActions] };
}

export function toEtpSummaryDto(etp: Etp, document: DocumentState): EtpSummaryDto {
  return {
    id: etp.id,
    documentId: etp.documentId,
    code: document.code,
    status: document.status,
    conclusion: etp.conclusion,
    version: etp.version,
  };
}

/** O cartão "Importar dados do DFD 0005/2026?" (objeto, nº de itens e situação no PCA). */
export function toImportableDfdDto(source: ImportableDfdSource): ImportableDfdDto {
  return {
    documentId: source.documentId,
    code: source.code,
    status: source.status,
    versionId: source.versionId,
    versionNumber: source.versionNumber,
    ...dfdImportPreview(source.snapshot),
  };
}
