import type {
  DocumentKind,
  DocumentSnapshot,
  DocumentStatus,
  DraftContent,
  VersionReason,
} from '@contrataflow/validation';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import type { Document } from './document.js';

/*
 * Snapshot imutável da versão (entities.md §5.3.2 · DEC-017/084 · RN-DOC-53): cabeçalho, seções e
 * coleções do documento no instante da transição. O `contentHash` é o SHA-256 do JSON canonicalizado
 * pelo JCS (RFC 8785): o mesmo conteúdo gera sempre o mesmo hash, e recalcular o hash do snapshot
 * gravado reproduz o valor.
 */

export interface DocumentVersionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly processId: string;
  readonly versionNumber: number;
  readonly reason: VersionReason;
  readonly statusAtCreation: DocumentStatus;
  /** Nulo para `UPLOADED` (o arquivo é a versão — `attachmentId`). */
  readonly content: DocumentSnapshot | null;
  readonly contentHash: string;
  readonly attachmentId: string | null;
  readonly templateVersionId: string | null;
  readonly changeSummary: string | null;
  readonly createdById: string;
  readonly createdAt: Date;
}

/** Processo como o snapshot o congela (nomes do momento da versão). */
export type SnapshotProcess = DocumentSnapshot['process'];

export interface SnapshotInput {
  readonly document: Document;
  readonly type: { readonly code: string; readonly kind: DocumentKind };
  readonly template: DocumentSnapshot['template'];
  readonly process: SnapshotProcess;
  readonly versionNumber: number;
  /** Cabeçalho tipado e coleções (do módulo dono; vazios para tipos livres). */
  readonly header: Readonly<Record<string, unknown>>;
  readonly collections: Readonly<Record<string, readonly unknown[]>>;
  readonly generatedAt: Date;
}

/** Seções sem os campos de controle de concorrência (`revision`/`updatedAt`/`updatedById`). */
function snapshotSections(sections: DraftContent['sections']): DocumentSnapshot['sections'] {
  const result: DocumentSnapshot['sections'] = {};
  for (const key of Object.keys(sections).sort()) {
    const section = sections[key];
    if (!section) continue;
    result[key] = {
      state: section.state,
      content: section.content,
      justification: section.justification,
      ...(section.ai === undefined ? {} : { ai: section.ai }),
    };
  }
  return result;
}

/** Snapshot do documento (§5.3.2) no esquema 1. */
export function buildDocumentSnapshot(input: SnapshotInput): DocumentSnapshot {
  const { document } = input;
  return {
    schemaVersion: 1,
    document: {
      id: document.id,
      code: document.code,
      title: document.title,
      typeCode: input.type.code,
      kind: input.type.kind,
      confidentiality: document.confidentiality,
      versionNumber: input.versionNumber,
    },
    template: input.template,
    process: input.process,
    header: { ...input.header },
    sections: snapshotSections(document.draftContent.sections),
    collections: Object.fromEntries(
      Object.entries(input.collections).map(([key, items]) => [key, [...items]]),
    ),
    generatedAt: input.generatedAt.toISOString(),
  };
}

/** `contentHash` (DEC-084): SHA-256 hex do JSON canonicalizado (RFC 8785). */
export function snapshotHash(snapshot: DocumentSnapshot): string {
  return sha256Hex(canonicalJson(snapshot));
}

/** Seções do rascunho de trabalho reconstruídas de uma versão (reabertura — RN-DOC-47). */
export function draftSectionsFromSnapshot(
  snapshot: DocumentSnapshot,
  stamp: { readonly actorId: string; readonly now: Date },
  previous: DraftContent['sections'],
): DraftContent['sections'] {
  const sections: DraftContent['sections'] = {};
  for (const [key, section] of Object.entries(snapshot.sections)) {
    sections[key] = {
      state: section.state,
      content: section.content,
      justification: section.justification,
      ...(section.ai === undefined ? {} : { ai: section.ai }),
      // A revisão por seção continua crescendo: um autosave antigo nunca sobrescreve o reaberto.
      revision: (previous[key]?.revision ?? 0) + 1,
      updatedAt: stamp.now.toISOString(),
      updatedById: stamp.actorId,
    };
  }
  return sections;
}
