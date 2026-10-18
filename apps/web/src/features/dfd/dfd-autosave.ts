import { changedHeaderFields, mergeHeader } from '@contrataflow/ui';
import type { AutosaveFailure } from '@contrataflow/ui';
import {
  DFD_FIELD_GROUPS,
  DFD_PATCH_FIELDS,
  DFD_WIZARD_STEPS,
  DOCUMENT_SECTION_MESSAGES,
  dfdPatchIssues,
  estimatedValueSchema,
} from '@contrataflow/validation';
import type {
  DfdDto,
  DfdHeaderValues,
  DfdPatch,
  DfdPatchField,
  DfdWizardStep,
  SectionConflictCurrent,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras de tela do autosave do DFD (US-015 · SCR-007), puras e testadas: os alvos do
 * `useAutosave` (`SECTION:<CHAVE>` → DOC-05; `HEADER` → DFD-04), o patch do cabeçalho com APENAS
 * os campos alterados e válidos (RN-DFD-27 — o grupo que o banco confere junto vai inteiro ou
 * espera), o merge do 412 do cabeçalho (RN-DFD-28), a tradução dos erros da API nas falhas do
 * autosave (FA-01..09) e a retomada do passo (RN-DFD-34).
 */

export const HEADER_TARGET = 'HEADER';
const SECTION_PREFIX = 'SECTION:';

export const sectionTarget = (key: string) => `${SECTION_PREFIX}${key}`;

export function sectionKeyOf(target: string): string | null {
  return target.startsWith(SECTION_PREFIX) ? target.slice(SECTION_PREFIX.length) : null;
}

/** O cabeçalho como o autosave o grava: os campos do DFD-04 + o passo do wizard. */
export interface DfdHeaderDraft extends DfdHeaderValues {
  readonly wizardStep: DfdWizardStep;
  readonly completedSteps: readonly DfdWizardStep[];
}

export function headerDraftOf(dfd: DfdDto): DfdHeaderDraft {
  return {
    requestDate: dfd.requestDate,
    requestingDepartmentId: dfd.requestingDepartmentId,
    responsibleId: dfd.responsibleId,
    objectSummary: dfd.objectSummary,
    priority: dfd.priority,
    expectedDate: dfd.expectedDate,
    estimatedValue: dfd.estimatedValue,
    estimatedValueMasked: dfd.estimatedValueMasked,
    pcaStatus: dfd.pcaStatus,
    pcaYear: dfd.pcaYear,
    pcaItemCode: dfd.pcaItemCode,
    pcaJustification: dfd.pcaJustification,
    wizardStep: dfd.wizardStep,
    completedSteps: [...dfd.completedSteps],
  };
}

/** Campos sempre obrigatórios (RN-DFD-08): o DFD-04 não aceita apagá-los. */
const NON_NULLABLE: ReadonlySet<DfdPatchField> = new Set([
  'requestDate',
  'requestingDepartmentId',
  'responsibleId',
  'objectSummary',
  'priority',
  'pcaStatus',
]);

const groupOf = (field: DfdPatchField): readonly DfdPatchField[] =>
  DFD_FIELD_GROUPS.find((group) => group.includes(field)) ?? [field];

const blank = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/** O valor do campo como o DFD-04 o espera (textos aparados; vazio → `null`). */
function wireValue(field: DfdPatchField, value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  if (field === 'objectSummary') return value;
  return value.trim() === '' ? null : value.trim();
}

export interface DfdHeaderPatchPlan {
  readonly patch: DfdPatch;
  /** Campos alterados que esperam ficar válidos (com os do mesmo grupo — CHECKs de `dfds`). */
  readonly held: readonly DfdPatchField[];
}

/**
 * O patch do DFD-04 (RN-DFD-27): os campos em que o local difere da base do servidor, menos os
 * que não passariam nas regras do servidor (`dfdPatchIssues` — as mesmas) e os do mesmo grupo.
 * A estimativa mascarada (POL-09) nunca é enviada.
 */
export function dfdHeaderPatch(
  local: DfdHeaderDraft,
  base: DfdHeaderDraft,
  context: { readonly today: string },
): DfdHeaderPatchPlan {
  const changed = changedHeaderFields(
    base as unknown as Record<string, unknown>,
    local as unknown as Record<string, unknown>,
    DFD_PATCH_FIELDS,
  ) as DfdPatchField[];
  const held = new Set<DfdPatchField>();
  const hold = (field: DfdPatchField) => {
    for (const mate of groupOf(field)) held.add(mate);
  };
  for (const field of changed) {
    const value = local[field as keyof DfdHeaderDraft];
    if (field === 'estimatedValue' && local.estimatedValueMasked === true) held.add(field);
    else if (NON_NULLABLE.has(field) && blank(value)) hold(field);
    else if (
      field === 'estimatedValue' &&
      !blank(value) &&
      !estimatedValueSchema.safeParse(String(value).trim()).success
    ) {
      hold(field);
    } else if (field === 'pcaYear' && value !== null && !Number.isInteger(value)) hold(field);
  }
  // Cada rodada segura ao menos um campo: no máximo uma por campo.
  for (const _round of DFD_PATCH_FIELDS) {
    const patch = Object.fromEntries(
      changed
        .filter((field) => !held.has(field))
        .map((field) => [field, wireValue(field, local[field as keyof DfdHeaderDraft])]),
    ) as DfdPatch;
    const pick = <K extends keyof DfdPatch & keyof DfdHeaderDraft>(field: K) =>
      (field in patch ? patch[field] : base[field]) as DfdHeaderDraft[K];
    const issues = dfdPatchIssues(
      patch,
      {
        requestDate: pick('requestDate'),
        expectedDate: pick('expectedDate'),
        pcaStatus: pick('pcaStatus'),
        pcaYear: pick('pcaYear'),
        pcaJustification: pick('pcaJustification'),
      },
      context,
    );
    if (issues.length === 0) {
      return { patch, held: changed.filter((field) => held.has(field)) };
    }
    for (const issue of issues) hold(issue.field);
  }
  return { patch: {}, held: changed };
}

const MERGE_RULES = {
  lastWriteWins: ['wizardStep'],
  union: ['completedSteps'],
  unionOrder: { completedSteps: DFD_WIZARD_STEPS },
};

export interface DfdHeaderMerge {
  /** Campos alterados pelos dois lados com valores diferentes (diálogo por campo). */
  readonly conflicts: readonly DfdPatchField[];
  /** O local reescrito sobre o servidor: alterações locais + as do servidor + a união dos passos. */
  readonly local: DfdHeaderDraft;
  /** Campos que só o servidor alterou (a tela os atualiza). */
  readonly remote: readonly DfdPatchField[];
}

/** RN-DFD-28: merge base × local × servidor depois do 412 do DFD-04. */
export function mergeDfdHeader(
  base: DfdHeaderDraft,
  local: DfdHeaderDraft,
  server: DfdHeaderDraft,
): DfdHeaderMerge {
  const asRecord = (value: DfdHeaderDraft) => value as unknown as Record<string, unknown>;
  const result = mergeHeader(
    {
      base: asRecord(base),
      local: asRecord(local),
      server: asRecord(server),
      fields: DFD_PATCH_FIELDS,
    },
    MERGE_RULES,
  );
  const localChanged = new Set(
    changedHeaderFields(asRecord(base), asRecord(local), DFD_PATCH_FIELDS),
  );
  const remote = (
    changedHeaderFields(asRecord(base), asRecord(server), DFD_PATCH_FIELDS) as DfdPatchField[]
  ).filter((field) => !localChanged.has(field));
  return {
    conflicts: result.conflicts as DfdPatchField[],
    local: { ...server, ...(result.patch as Partial<DfdHeaderDraft>) },
    remote,
  };
}

// --- Erros da API → falhas do autosave (FA-01..09) ----------------------------------------------

/** O que a faixa de bloqueio precisa saber (FA-05/06/07). */
export interface DfdAutosaveBlock {
  readonly code: string;
  /** `meta.status`/`meta.statusSince` do 409 `DOCUMENT_NOT_EDITABLE`. */
  readonly status?: string | undefined;
  readonly statusSince?: string | undefined;
  readonly processStatus?: string | undefined;
}

const metaOf = (error: { readonly problem: Readonly<Record<string, unknown>> | null }) =>
  (error.problem?.meta ?? {}) as Readonly<Record<string, unknown>>;

export function classifyDfdAutosaveError(error: unknown): AutosaveFailure {
  if (!isApiError(error)) return { kind: 'offline' };
  const { status, code } = error;
  if (status === 412 && code === 'SECTION_REVISION_CONFLICT') {
    return {
      kind: 'conflict',
      current: { kind: 'section', current: metaOf(error).current as SectionConflictCurrent },
    };
  }
  if (status === 412) return { kind: 'conflict', current: { kind: 'reload' } };
  if (status === 428) {
    return { kind: 'invalid', message: DOCUMENT_SECTION_MESSAGES.preconditionRequired };
  }
  if (status === 401) return { kind: 'sessionExpired' };
  if (status === 403 || status === 404) return { kind: 'blocked', reason: code };
  if (status === 409) {
    const meta = metaOf(error);
    const block: DfdAutosaveBlock = {
      code,
      status: typeof meta.status === 'string' ? meta.status : undefined,
      statusSince: typeof meta.statusSince === 'string' ? meta.statusSince : undefined,
      processStatus:
        typeof error.problem?.processStatus === 'string' ? error.problem.processStatus : undefined,
    };
    return { kind: 'blocked', reason: code, detail: block };
  }
  if (status === 429) {
    return { kind: 'rateLimited', retryAfterMs: (error.retryAfterSeconds ?? 5) * 1000 };
  }
  if (status === 413)
    return { kind: 'invalid', message: DOCUMENT_SECTION_MESSAGES.payloadTooLarge };
  if (status === 422) {
    return { kind: 'invalid', message: error.errors[0]?.message ?? error.message };
  }
  if (status >= 500) return { kind: 'offline' };
  return { kind: 'invalid', message: error.message };
}

/**
 * RN-DFD-34: o wizard abre no passo salvo; se o passo salvo é a Conclusão e há pendência
 * bloqueante, abre a Revisão.
 */
export function resumeStep(saved: DfdWizardStep, hasBlocking: boolean): DfdWizardStep {
  return saved === 'CONCLUSION' && hasBlocking ? 'REVIEW' : saved;
}
