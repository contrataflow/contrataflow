import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  DOCUMENT_ITEM_LIMITS,
  richTextPlainText,
  TERM_IMPORT_FIELDS,
  TERM_IMPORT_MESSAGES,
  TERM_IMPORT_TOKEN_TTL_MINUTES,
} from '@contrataflow/validation';
import type {
  DraftContent,
  DraftSection,
  FieldError,
  ImportMappings,
  RichTextDoc,
  RichTextDocValue,
  TermImportField,
} from '@contrataflow/validation';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import { normalizeMoney } from './term-of-reference.js';
import type { TermOfReference } from './term-of-reference.js';

/*
 * Importação do ETP para o TR (US-037 · RN-TR-16..24 · entities.md §5.8/§5.10). Funções puras:
 *
 * - `planEtpImport` aplica o `importMappings` da versão do template FIXADA no TR ao estado atual do
 *   ETP e do TR — seções `REPLACE` (substitui) e `APPEND` (acrescenta ao fim com "Importado do ETP
 *   v{n} em {data}"), campos do cabeçalho (POL-09: valor mascarado sem a política) e itens por
 *   `processItemId` (quantidade do ETP; especificados só com `overwriteExisting` — RN-TR-21);
 * - `importFingerprint` resume o estado de origem e destino que a prévia leu: a aplicação recalcula
 *   e compara (RN-TR-19 — ETP ou TR mudou → 410);
 * - `signImportToken`/`verifyImportToken`: o `importToken` autocontido (HMAC-SHA256, sem estado,
 *   15 min — RN-TR-18);
 * - `applyEtpFields`: o valor estimado e a pesquisa vinculada do ETP no cabeçalho do TR, com a
 *   precedência da origem (RN-TR-22) e a rastreabilidade `importedFromEtp*`.
 */

// --- Entradas -----------------------------------------------------------------------------------

/** O ETP como a importação o lê (documento + cabeçalho tipado + itens). */
export interface EtpImportSource {
  readonly etpId: string;
  readonly code: string | null;
  readonly status: string;
  /** Versão vigente do ETP (`null` = ainda sem versão — FA-02). */
  readonly versionId: string | null;
  readonly versionNumber: number | null;
  /** `Document.version`/`draftRevision` do ETP (mudam a cada gravação). */
  readonly documentVersion: number;
  readonly draftRevision: number;
  readonly sections: DraftContent['sections'];
  /** `null` sem o cabeçalho tipado (leitor não registrado) — os campos não são oferecidos. */
  readonly header: {
    readonly estimatedTotalValue: string | null;
    readonly priceResearchId: string | null;
    readonly version: number;
  } | null;
  readonly items: readonly {
    readonly processItemId: string;
    readonly sequence: number;
    readonly description: string;
    readonly quantity: string;
    readonly calculationMemo: RichTextDocValue | null;
  }[];
}

/** O TR como a importação o lê. */
export interface TermImportTarget {
  readonly term: TermOfReference;
  readonly templateVersionId: string | null;
  /** Chaves das seções da versão do template fixada (destinos válidos). */
  readonly templateSectionKeys: ReadonlySet<string>;
  readonly documentVersion: number;
  readonly draftRevision: number;
  readonly sections: DraftContent['sections'];
  readonly items: readonly {
    readonly processItemId: string;
    readonly quantity: string;
    readonly notes: string | null;
  }[];
  /** FA-04: itens do TR já especificados. */
  readonly specified: ReadonlySet<string>;
  /** POL-09: o usuário não vê o valor estimado. */
  readonly masked: boolean;
}

/** Mapeamento ausente na versão do template: só os itens (DEC-019), com as quantidades. */
export const NO_IMPORT_MAPPINGS: ImportMappings = {
  fromDocumentType: 'ETP',
  sections: [],
  fields: [],
  items: { copyQuantities: true, copyCalculationMemoToNotes: false },
};

// --- Plano (TRM-05) -----------------------------------------------------------------------------

export interface PlannedSection {
  readonly target: string;
  readonly sources: readonly string[];
  readonly mode: 'REPLACE' | 'APPEND';
  readonly content: RichTextDoc;
  readonly ai: DraftSection['ai'];
  readonly before: string;
  readonly preview: string;
}

export interface PlannedField {
  readonly target: TermImportField;
  readonly source: string;
  /** Valor de origem (`null` mascarado). */
  readonly value: string | null;
  readonly valueMasked: boolean;
  /** Valor atual do TR (mascarado como `value`). */
  readonly current: string | null;
}

export interface PlannedItem {
  readonly processItemId: string;
  readonly sequence: number;
  readonly description: string;
  readonly etpQuantity: string;
  readonly trCurrentQuantity: string | null;
  readonly specified: boolean;
  /** `copyCalculationMemoToNotes`: a memória do ETP como texto (até o limite das observações). */
  readonly notes: string | undefined;
}

export interface EtpImportPlan {
  readonly sections: readonly PlannedSection[];
  readonly fields: readonly PlannedField[];
  readonly items: readonly PlannedItem[];
  readonly copyQuantities: boolean;
  readonly copyCalculationMemoToNotes: boolean;
  /** RN-TR-22: o TR tem o valor vinculado à pesquisa e a prévia oferece o valor do ETP. */
  readonly replacesPriceResearchValue: boolean;
}

type ContentNode = Record<string, unknown>;

function nodesOf(section: DraftSection | undefined): ContentNode[] {
  if (section?.state !== 'FILLED' || section.content === null) return [];
  const content = (section.content as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ContentNode[]) : [];
}

function paragraph(text: string): ContentNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`. */
function brazilianDate(localDate: string): string {
  const [year = '', month = '', day = ''] = localDate.split('-');
  return `${day}/${month}/${year}`;
}

/** Proveniência de IA pendente da primeira origem que a tiver (entities.md §5.10). */
function pendingAiOf(sections: readonly (DraftSection | undefined)[]): DraftSection['ai'] {
  for (const section of sections) {
    if (section?.state === 'FILLED' && section.ai?.reviewedAt === null) return section.ai;
  }
  return null;
}

function planSection(
  mapping: ImportMappings['sections'][number],
  source: EtpImportSource,
  target: TermImportTarget,
  marker: string,
): PlannedSection | null {
  if (!target.templateSectionKeys.has(mapping.target)) return null;
  const origins = mapping.sources.map((key) => source.sections[key]);
  const imported = origins.flatMap((section) => nodesOf(section));
  if (imported.length === 0) return null;
  const current = target.sections[mapping.target];
  const before = nodesOf(current);
  const pending = pendingAiOf(origins);
  let nodes: ContentNode[];
  let ai: DraftSection['ai'];
  if (mapping.mode === 'REPLACE') {
    nodes = imported;
    // REPLACE leva a proveniência pendente da origem, ou nenhuma (origem revisada).
    ai = pending;
  } else {
    nodes = [...before, paragraph(marker), ...imported];
    // APPEND mantém a do destino e fica pendente se a origem estiver pendente.
    const kept = before.length > 0 ? (current?.ai ?? null) : null;
    ai =
      pending === null
        ? kept
        : kept === null
          ? pending
          : { ...kept, reviewedAt: null, reviewedById: null };
  }
  const content = { type: 'doc', content: nodes } as unknown as RichTextDoc;
  const beforeDoc = { type: 'doc', content: before } as unknown as RichTextDoc;
  return {
    target: mapping.target,
    sources: [...mapping.sources],
    mode: mapping.mode,
    content,
    ai,
    before: richTextPlainText(beforeDoc),
    preview: richTextPlainText(content),
  };
}

const IMPORT_FIELD_SET: ReadonlySet<string> = new Set(TERM_IMPORT_FIELDS);

function isImportField(value: string): value is TermImportField {
  return IMPORT_FIELD_SET.has(value);
}

function planFields(
  mappings: ImportMappings['fields'],
  source: EtpImportSource,
  target: TermImportTarget,
): PlannedField[] {
  const header = source.header;
  if (header === null) return [];
  const planned: PlannedField[] = [];
  for (const mapping of mappings) {
    if (!isImportField(mapping.target) || !isImportField(mapping.source)) continue;
    if (planned.some((field) => field.target === mapping.target)) continue;
    const value = header[mapping.source];
    if (value === null) continue;
    const masked = target.masked && mapping.target === 'estimatedTotalValue';
    planned.push({
      target: mapping.target,
      source: mapping.source,
      value: masked ? null : value,
      valueMasked: masked,
      current: masked ? null : target.term[mapping.target],
    });
  }
  return planned;
}

function memoNotes(memo: RichTextDocValue | null): string | undefined {
  if (memo === null) return undefined;
  const text = richTextPlainText(memo).trim();
  if (text === '') return undefined;
  return Array.from(text).slice(0, DOCUMENT_ITEM_LIMITS.notesMax).join('');
}

export function planEtpImport(
  mappings: ImportMappings | null,
  source: EtpImportSource,
  target: TermImportTarget,
  options: { readonly localDate: string },
): EtpImportPlan {
  const mapping = mappings ?? NO_IMPORT_MAPPINGS;
  const marker = TERM_IMPORT_MESSAGES.appendedFrom(
    source.versionNumber,
    brazilianDate(options.localDate),
  );
  const seen = new Set<string>();
  const sections: PlannedSection[] = [];
  for (const entry of mapping.sections) {
    if (seen.has(entry.target)) continue;
    const planned = planSection(entry, source, target, marker);
    if (planned === null) continue;
    seen.add(entry.target);
    sections.push(planned);
  }
  const fields = planFields(mapping.fields, source, target);
  const current = new Map(target.items.map((item) => [item.processItemId, item]));
  const items = source.items.map((item) => ({
    processItemId: item.processItemId,
    sequence: item.sequence,
    description: item.description,
    etpQuantity: item.quantity,
    trCurrentQuantity: current.get(item.processItemId)?.quantity ?? null,
    specified: current.has(item.processItemId) && target.specified.has(item.processItemId),
    notes: mapping.items.copyCalculationMemoToNotes ? memoNotes(item.calculationMemo) : undefined,
  }));
  return {
    sections,
    fields,
    items,
    copyQuantities: mapping.items.copyQuantities,
    copyCalculationMemoToNotes: mapping.items.copyCalculationMemoToNotes,
    replacesPriceResearchValue:
      target.term.estimatedValueSource === 'PRICE_RESEARCH' &&
      fields.some((field) => field.target === 'estimatedTotalValue' && !field.valueMasked),
  };
}

// --- Impressão digital e token (RN-TR-18/19) ----------------------------------------------------

/**
 * SHA-256 do JSON canônico do que a prévia leu: o ETP (documento, rascunho, versão vigente,
 * cabeçalho e itens), o TR (documento, rascunho, cabeçalho, itens e especificados) e a versão do
 * template. Qualquer gravação em um dos dois muda o resumo.
 */
export function importFingerprint(source: EtpImportSource, target: TermImportTarget): string {
  return sha256Hex(
    canonicalJson({
      templateVersionId: target.templateVersionId,
      etp: {
        id: source.etpId,
        status: source.status,
        versionId: source.versionId,
        documentVersion: source.documentVersion,
        draftRevision: source.draftRevision,
        headerVersion: source.header?.version ?? null,
        items: source.items.map((item) => [
          item.processItemId,
          item.quantity,
          item.calculationMemo === null ? null : sha256Hex(canonicalJson(item.calculationMemo)),
        ]),
      },
      term: {
        id: target.term.id,
        version: target.term.version,
        documentVersion: target.documentVersion,
        draftRevision: target.draftRevision,
        items: target.items.map((item) => [item.processItemId, item.quantity, item.notes]),
        specified: [...target.specified].sort(),
      },
    }),
  );
}

export interface ImportTokenClaims {
  readonly tenantId: string;
  readonly termId: string;
  readonly etpId: string;
  readonly etpVersionId: string | null;
  readonly fingerprint: string;
  readonly expiresAt: Date;
}

const TOKEN_PREFIX = 'v1';

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(`${TOKEN_PREFIX}.${body}`, 'utf8').digest('base64url');
}

/** Validade do token emitido agora (RN-TR-18). */
export function importTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + TERM_IMPORT_TOKEN_TTL_MINUTES * 60_000);
}

/** `v1.<claims base64url>.<HMAC-SHA256 base64url>` — sem estado no servidor. */
export function signImportToken(claims: ImportTokenClaims, key: Buffer): string {
  const body = Buffer.from(
    JSON.stringify({
      n: claims.tenantId,
      t: claims.termId,
      e: claims.etpId,
      v: claims.etpVersionId,
      f: claims.fingerprint,
      x: claims.expiresAt.getTime(),
    }),
    'utf8',
  ).toString('base64url');
  return `${TOKEN_PREFIX}.${body}.${sign(key, body)}`;
}

export type ImportTokenCheck =
  | { readonly kind: 'VALID'; readonly claims: ImportTokenClaims }
  /** V-03: ausente, adulterado, de outro tenant ou de outro TR → 422. */
  | { readonly kind: 'INVALID' }
  /** V-04: vencido → 410. */
  | { readonly kind: 'EXPIRED' };

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function verifyImportToken(
  token: string,
  key: Buffer,
  expected: { readonly tenantId: string; readonly termId: string; readonly now: Date },
): ImportTokenCheck {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { kind: 'INVALID' };
  const [, body = '', signature = ''] = parts;
  const wanted = Buffer.from(sign(key, body), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (wanted.length !== given.length || !timingSafeEqual(wanted, given)) {
    return { kind: 'INVALID' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { kind: 'INVALID' };
  }
  if (typeof raw !== 'object' || raw === null) return { kind: 'INVALID' };
  const claims = raw as Record<string, unknown>;
  const { n, t, e, v, f, x } = claims;
  if (
    !isString(n) ||
    !isString(t) ||
    !isString(e) ||
    !(v === null || isString(v)) ||
    !isString(f) ||
    typeof x !== 'number'
  ) {
    return { kind: 'INVALID' };
  }
  if (n !== expected.tenantId || t !== expected.termId) return { kind: 'INVALID' };
  if (expected.now.getTime() >= x) return { kind: 'EXPIRED' };
  return {
    kind: 'VALID',
    claims: {
      tenantId: n,
      termId: t,
      etpId: e,
      etpVersionId: v,
      fingerprint: f,
      expiresAt: new Date(x),
    },
  };
}

// --- Aplicação (TRM-06) -------------------------------------------------------------------------

export interface ImportSelection {
  readonly sections: readonly string[];
  readonly fields: readonly TermImportField[];
  readonly copyItems: boolean;
  readonly overwriteExisting: boolean;
  readonly confirmReplaceValueSource: boolean;
}

export interface SelectedImport {
  readonly sections: readonly PlannedSection[];
  readonly fields: readonly PlannedField[];
  readonly items: readonly PlannedItem[];
}

export type SelectionResult =
  | { readonly ok: true; readonly selected: SelectedImport }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

/**
 * RN-TR-20/21/22/23: só o que foi marcado. Seção fora da prévia = 422 `NOT_ALLOWED`; campo
 * mascarado (POL-09) ou sem valor na origem é ignorado (FA-05); item especificado só com
 * `overwriteExisting`; trocar o valor da pesquisa exige `confirmReplaceValueSource`
 * (`CONDITIONAL_REQUIRED`); trocar só a pesquisa de um valor vinculado à pesquisa = `NOT_ALLOWED`.
 * Nada efetivo para importar = V-01.
 */
export function selectImport(
  plan: EtpImportPlan,
  term: TermOfReference,
  selection: ImportSelection,
): SelectionResult {
  const errors: FieldError[] = [];
  const offered = new Map(plan.sections.map((section) => [section.target, section]));
  const wanted = [...new Set(selection.sections)];
  if (wanted.some((key) => !offered.has(key))) {
    errors.push({
      field: 'sections',
      code: 'NOT_ALLOWED',
      message: TERM_IMPORT_MESSAGES.selectionInvalid,
    });
  }
  const sections = plan.sections.filter((section) => wanted.includes(section.target));
  const fields = plan.fields.filter(
    (field) => selection.fields.includes(field.target) && !field.valueMasked,
  );
  const importsValue = fields.some((field) => field.target === 'estimatedTotalValue');
  if (
    importsValue &&
    term.estimatedValueSource === 'PRICE_RESEARCH' &&
    !selection.confirmReplaceValueSource
  ) {
    errors.push({
      field: 'confirmReplaceValueSource',
      code: 'CONDITIONAL_REQUIRED',
      message: TERM_IMPORT_MESSAGES.confirmReplaceValueSource,
    });
  }
  const research = fields.find((field) => field.target === 'priceResearchId');
  if (
    research !== undefined &&
    !importsValue &&
    term.estimatedValueSource === 'PRICE_RESEARCH' &&
    research.value !== term.priceResearchId
  ) {
    errors.push({
      field: 'fields',
      code: 'NOT_ALLOWED',
      message: TERM_IMPORT_MESSAGES.priceResearchNeedsValue,
    });
  }
  const items = selection.copyItems
    ? plan.items.filter((item) => !item.specified || selection.overwriteExisting)
    : [];
  if (errors.length === 0 && sections.length === 0 && fields.length === 0 && items.length === 0) {
    errors.push({ field: 'sections', code: 'REQUIRED', message: TERM_IMPORT_MESSAGES.noSelection });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, selected: { sections, fields, items } };
}

export interface TermImportChange {
  readonly field:
    | 'estimatedTotalValue'
    | 'estimatedValueSource'
    | 'priceResearchId'
    | 'importedFromEtpId'
    | 'importedFromEtpVersionId';
  readonly old: unknown;
  readonly new: unknown;
}

/**
 * RN-TR-22: `estimatedTotalValue` importado → origem `ETP` (a pesquisa importada junto, ou a que
 * já estava); `priceResearchId` sozinho troca só a referência. Sempre grava a rastreabilidade
 * (`importedFromEtpId`/`importedFromEtpVersionId`/`importedAt`/`importedById` — RN-TR-24).
 */
export function applyEtpFields(
  term: TermOfReference,
  fields: readonly PlannedField[],
  stamp: {
    readonly etpId: string;
    readonly etpVersionId: string | null;
    readonly actorId: string;
    readonly now: Date;
  },
): { readonly term: TermOfReference; readonly changes: readonly TermImportChange[] } {
  const value = fields.find((field) => field.target === 'estimatedTotalValue')?.value ?? null;
  const research = fields.find((field) => field.target === 'priceResearchId');
  const next: TermOfReference = {
    ...term,
    ...(value === null
      ? {}
      : { estimatedTotalValue: normalizeMoney(value), estimatedValueSource: 'ETP' as const }),
    ...(research === undefined ? {} : { priceResearchId: research.value }),
    importedFromEtpId: stamp.etpId,
    importedFromEtpVersionId: stamp.etpVersionId,
    importedAt: stamp.now,
    importedById: stamp.actorId,
    updatedAt: stamp.now,
    updatedById: stamp.actorId,
  };
  const fieldsToCompare = [
    'estimatedTotalValue',
    'estimatedValueSource',
    'priceResearchId',
    'importedFromEtpId',
    'importedFromEtpVersionId',
  ] as const;
  const changes = fieldsToCompare
    .filter((field) => term[field] !== next[field])
    .map((field) => ({ field, old: term[field], new: next[field] }));
  return { term: next, changes };
}

/** RN-TR-24: a versão vigente do ETP é outra que a importada (informativo no TRM-03). */
export function etpChangedSinceImport(
  term: Pick<TermOfReference, 'importedFromEtpId' | 'importedFromEtpVersionId'>,
  etp: { readonly currentVersionId: string | null } | null,
): boolean {
  const current = etp?.currentVersionId ?? null;
  if (term.importedFromEtpId === null || current === null) return false;
  return current !== term.importedFromEtpVersionId;
}
