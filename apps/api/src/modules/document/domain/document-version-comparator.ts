import { richTextPlainText } from '@contrataflow/validation';
import type {
  CollectionDiff,
  DocumentKind,
  DocumentSnapshot,
  HeaderDiff,
  SectionDiff,
  SectionSide,
  VersionChangeType,
} from '@contrataflow/validation';

import { canonicalJson } from '#shared/integrity/canonical-json.js';

import { isMaskedField, isMaskFlag } from './confidential-snapshot.js';

/*
 * `DocumentVersionComparator.diff` (US-066 · RN-DOC-60/61 · FA-02/FA-03): compara dois snapshots
 * do MESMO documento — já mascarados por POL-09 quando o usuário não vê o orçamento sigiloso — em
 * três blocos: cabeçalho (por campo), seções (por `sectionKey`) e coleções (por chave natural).
 * Igualdade pelo JSON canônico (RFC 8785): ordem de chaves nunca conta como alteração. Campo
 * mascarado em qualquer dos lados vira `MASKED` com os dois valores nulos — nem a mudança pode ser
 * inferida. Função pura, sem I/O.
 */

/** Um lado da comparação: o que a versão congelou. */
export interface ComparedVersion {
  /** Snapshot (já mascarado conforme POL-09); `null` para `UPLOADED`. */
  readonly content: DocumentSnapshot | null;
  readonly contentHash: string;
  readonly attachmentId: string | null;
}

export interface VersionDiff {
  readonly header: HeaderDiff[];
  readonly sections: SectionDiff[];
  readonly collections: CollectionDiff[];
}

/** Chave natural da linha por coleção (entities.md §5.3.2); as demais usam `id`. */
const NATURAL_KEYS: Readonly<Record<string, string>> = { items: 'processItemId' };

type JsonRecord = Readonly<Record<string, unknown>>;

const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);

function changeOf(hasFrom: boolean, hasTo: boolean, equal: boolean): VersionChangeType {
  if (!hasFrom) return 'ADDED';
  if (!hasTo) return 'REMOVED';
  return equal ? 'UNCHANGED' : 'CHANGED';
}

/** Chaves de dado (sem as marcas `<campo>Masked`) na ordem de aparição, sem repetição. */
function dataKeys(...records: readonly JsonRecord[]): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) if (!isMaskFlag(record, key)) keys.add(key);
  }
  return [...keys];
}

// --- Cabeçalho ---------------------------------------------------------------------------------

function headerEntry(
  field: string,
  from: JsonRecord | null,
  to: JsonRecord | null,
  key: string = field,
): HeaderDiff | null {
  const hasFrom = from !== null && key in from;
  const hasTo = to !== null && key in to;
  if (!hasFrom && !hasTo) return null;
  if ((from !== null && isMaskedField(from, key)) || (to !== null && isMaskedField(to, key))) {
    return { field, changeType: 'MASKED', from: null, to: null };
  }
  const fromValue = hasFrom ? (from[key] ?? null) : null;
  const toValue = hasTo ? (to[key] ?? null) : null;
  return {
    field,
    changeType: changeOf(hasFrom, hasTo, same(fromValue, toValue)),
    from: fromValue,
    to: toValue,
  };
}

/** Metadados genéricos do documento e do template congelados na versão. */
function documentFields(snapshot: DocumentSnapshot | null): JsonRecord | null {
  if (snapshot === null) return null;
  return {
    'document.title': snapshot.document.title,
    'document.code': snapshot.document.code,
    'document.confidentiality': snapshot.document.confidentiality,
    'template.versionNumber': snapshot.template?.versionNumber ?? null,
  };
}

function diffHeader(from: DocumentSnapshot | null, to: DocumentSnapshot | null): HeaderDiff[] {
  const fromDocument = documentFields(from);
  const toDocument = documentFields(to);
  const generic = dataKeys(fromDocument ?? {}, toDocument ?? {}).map((field) =>
    headerEntry(field, fromDocument, toDocument),
  );
  const fromHeader = from?.header ?? {};
  const toHeader = to?.header ?? {};
  const typed = dataKeys(fromHeader, toHeader)
    .sort()
    .map((field) => headerEntry(field, fromHeader, toHeader));
  return [...generic, ...typed].filter((entry): entry is HeaderDiff => entry !== null);
}

// --- Seções -------------------------------------------------------------------------------------

type SnapshotSection = DocumentSnapshot['sections'][string];

function sectionSide(section: SnapshotSection | undefined): SectionSide | null {
  if (section === undefined) return null;
  return {
    state: section.state,
    text: richTextPlainText(section.content),
    justification: section.justification,
  };
}

/** O que conta como alteração da seção: estado, conteúdo TipTap (inclusive marcas) e justificativa. */
const sectionFingerprint = (section: SnapshotSection) => ({
  state: section.state,
  content: section.content,
  justification: section.justification,
});

function diffSections(from: DocumentSnapshot | null, to: DocumentSnapshot | null): SectionDiff[] {
  const fromSections = from?.sections ?? {};
  const toSections = to?.sections ?? {};
  const keys = [...new Set([...Object.keys(fromSections), ...Object.keys(toSections)])].sort();
  return keys.map((sectionKey) => {
    const before = fromSections[sectionKey];
    const after = toSections[sectionKey];
    const equal =
      before !== undefined &&
      after !== undefined &&
      same(sectionFingerprint(before), sectionFingerprint(after));
    return {
      sectionKey,
      changeType: changeOf(before !== undefined, after !== undefined, equal),
      from: sectionSide(before),
      to: sectionSide(after),
    };
  });
}

// --- Coleções -----------------------------------------------------------------------------------

function asRecord(item: unknown): JsonRecord {
  return item !== null && typeof item === 'object' && !Array.isArray(item)
    ? (item as JsonRecord)
    : { value: item ?? null };
}

/** Linhas por chave natural; sem chave (ou repetida), a posição na lista (`#n`). */
function keyed(collection: string, items: readonly unknown[]): Map<string, JsonRecord> {
  const field = NATURAL_KEYS[collection] ?? 'id';
  const rows = new Map<string, JsonRecord>();
  items.forEach((item, index) => {
    const record = asRecord(item);
    const natural = record[field] ?? record.id;
    const key =
      (typeof natural === 'string' || typeof natural === 'number') && !rows.has(String(natural))
        ? String(natural)
        : `#${index + 1}`;
    rows.set(key, record);
  });
  return rows;
}

function rowDiff(
  collection: string,
  itemId: string,
  from: JsonRecord | undefined,
  to: JsonRecord | undefined,
): CollectionDiff {
  const records = [from, to].filter((record): record is JsonRecord => record !== undefined);
  const fields = dataKeys(...records);
  const maskedFields = fields.filter((field) => records.some((row) => isMaskedField(row, field)));
  const changedFields =
    from === undefined || to === undefined
      ? []
      : fields.filter((field) => !maskedFields.includes(field) && !same(from[field], to[field]));
  return {
    collection,
    itemId,
    changeType: changeOf(from !== undefined, to !== undefined, changedFields.length === 0),
    changedFields,
    maskedFields,
    from: from === undefined ? null : { ...from },
    to: to === undefined ? null : { ...to },
  };
}

function diffCollections(
  from: DocumentSnapshot | null,
  to: DocumentSnapshot | null,
): CollectionDiff[] {
  const fromCollections = from?.collections ?? {};
  const toCollections = to?.collections ?? {};
  const names = [
    ...new Set([...Object.keys(fromCollections), ...Object.keys(toCollections)]),
  ].sort();
  return names.flatMap((collection) => {
    const before = keyed(collection, fromCollections[collection] ?? []);
    const after = keyed(collection, toCollections[collection] ?? []);
    // Ordem do lado de destino; as linhas removidas vêm ao final, na ordem de origem.
    const ids = [...after.keys(), ...[...before.keys()].filter((id) => !after.has(id))];
    return ids.map((id) => rowDiff(collection, id, before.get(id), after.get(id)));
  });
}

// --- Arquivo (UPLOADED · FA-02) -----------------------------------------------------------------

/** Documento externo: só os metadados do arquivo de cada versão, sem diff de conteúdo. */
function diffFile(from: ComparedVersion, to: ComparedVersion): HeaderDiff[] {
  const side = (version: ComparedVersion) => ({
    'file.attachmentId': version.attachmentId,
    'file.sha256': version.contentHash,
  });
  const before = side(from);
  const after = side(to);
  return Object.keys(before).flatMap((field) => headerEntry(field, before, after) ?? []);
}

/** Os três blocos de diferenças entre duas versões do mesmo documento (RN-DOC-60). */
export function diffDocumentVersions(
  kind: DocumentKind,
  from: ComparedVersion,
  to: ComparedVersion,
): VersionDiff {
  if (kind === 'UPLOADED') return { header: diffFile(from, to), sections: [], collections: [] };
  return {
    header: diffHeader(from.content, to.content),
    sections: diffSections(from.content, to.content),
    collections: diffCollections(from.content, to.content),
  };
}
