import { DFD_PATCH_FIELDS, DFD_WIZARD_STEPS } from '@contrataflow/validation';
import type {
  DfdHeaderValues,
  DfdPatch,
  DfdPatchField,
  DfdWizardStep,
  PcaStatus,
  Priority,
} from '@contrataflow/validation';

/*
 * Cabeçalho tipado do DFD (US-014 · entities.md §4.8 · Decreto 10.947/2022, art. 8º). O DFD nasce
 * dentro do processo, 1:1 com o `Document` do tipo `DFD` (mesmo id — CHECK `dfds_id_is_document`),
 * com os valores iniciais copiados do processo (RN-DFD-05). Puro: sem NestJS, Prisma nem outro
 * módulo.
 */

export interface Dfd {
  /** = `documentId` (o identificador das rotas da SCR-007 e do painel de documentos). */
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string;
  readonly requestingDepartmentId: string;
  readonly responsibleId: string;
  /** `AAAA-MM-DD` no fuso do tenant. */
  readonly requestDate: string;
  readonly objectSummary: string;
  readonly priority: Priority;
  readonly expectedDate: string | null;
  /** Decimal(18,2) como string. */
  readonly estimatedValue: string | null;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
  readonly wizardStep: DfdWizardStep;
  readonly completedSteps: readonly DfdWizardStep[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** O que o DFD copia do processo (RN-DFD-05). */
export interface DfdProcessSource {
  readonly id: string;
  readonly requestingDepartmentId: string;
  readonly object: string;
  readonly priority: Priority;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
}

/**
 * RN-DFD-05: setor = setor solicitante do processo; responsável pela demanda = criador; data = hoje
 * (fuso do tenant); objeto, prioridade e PCA = os do processo; previsão e estimativa vazias; passo
 * `IDENTIFICATION`, nenhum concluído. O objeto do processo já respeita 10–2.000 caracteres
 * (RN-DFD-12). A justificativa de PCA do processo só é copiada quando a situação a exige.
 */
export function createDfdFromProcess(
  process: DfdProcessSource,
  input: {
    readonly documentId: string;
    readonly tenantId: string;
    readonly creatorId: string;
    readonly today: string;
    readonly now: Date;
  },
): Dfd {
  const planned = process.pcaStatus === 'PLANNED';
  const notPlanned = process.pcaStatus === 'NOT_PLANNED';
  return {
    id: input.documentId,
    tenantId: input.tenantId,
    processId: process.id,
    documentId: input.documentId,
    requestingDepartmentId: process.requestingDepartmentId,
    responsibleId: input.creatorId,
    requestDate: input.today,
    objectSummary: process.object.trim(),
    priority: process.priority,
    expectedDate: null,
    estimatedValue: null,
    pcaStatus: process.pcaStatus,
    pcaYear: planned ? process.pcaYear : null,
    pcaItemCode: planned ? process.pcaItemCode : null,
    pcaJustification: notPlanned ? process.pcaJustification : null,
    wizardStep: 'IDENTIFICATION',
    completedSteps: [],
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.creatorId,
    updatedById: input.creatorId,
    version: 1,
  };
}

/** Os valores do cabeçalho para a completude (`evaluateDfdCompleteness`) e o snapshot. */
export function dfdHeaderValues(dfd: Dfd): DfdHeaderValues {
  return {
    requestDate: dfd.requestDate,
    requestingDepartmentId: dfd.requestingDepartmentId,
    responsibleId: dfd.responsibleId,
    objectSummary: dfd.objectSummary,
    priority: dfd.priority,
    expectedDate: dfd.expectedDate,
    estimatedValue: dfd.estimatedValue,
    pcaStatus: dfd.pcaStatus,
    pcaYear: dfd.pcaYear,
    pcaItemCode: dfd.pcaItemCode,
    pcaJustification: dfd.pcaJustification,
  };
}

/**
 * RN-DFD-09: o setor do DFD é unidade da subárvore da secretaria solicitante do processo (`path`
 * materializado `/<raiz>/…/<id>/` contém o id da secretaria) e do mesmo órgão.
 */
export function isInSecretariat(
  department: { readonly path: string; readonly organizationId: string },
  secretariat: { readonly id: string; readonly organizationId: string },
): boolean {
  return (
    department.organizationId === secretariat.organizationId &&
    department.path.includes(`/${secretariat.id}/`)
  );
}

/** Campo do cabeçalho alterado por um patch (valores antes/depois, para a auditoria). */
export interface DfdHeaderChange {
  readonly field: DfdPatchField;
  readonly old: unknown;
  readonly new: unknown;
}

/** `completedSteps` sem repetição e na ordem do wizard (união do merge — RN-DFD-28). */
export function normalizeCompletedSteps(steps: readonly DfdWizardStep[]): DfdWizardStep[] {
  const wanted = new Set(steps);
  return DFD_WIZARD_STEPS.filter((step) => wanted.has(step));
}

const sameValue = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, index) => item === b[index])
    : a === b;

/**
 * DFD-04 (US-015 · RN-DFD-27): aplica os campos enviados ao cabeçalho, devolvendo só as mudanças
 * efetivas (patch igual ao atual = sem mudança — nenhuma versão nova). Textos aparados; o código do
 * PCA vazio vira `null`. As regras de campo e de referência já foram conferidas por quem chama.
 */
export function applyDfdPatch(
  dfd: Dfd,
  patch: DfdPatch,
  stamp: { readonly actorId: string; readonly now: Date },
): { readonly dfd: Dfd; readonly changes: readonly DfdHeaderChange[] } {
  const blankToNull = (value: string | null | undefined) =>
    value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim();
  const normalized: Partial<Record<DfdPatchField, unknown>> = {
    ...patch,
    ...(patch.objectSummary === undefined ? {} : { objectSummary: patch.objectSummary.trim() }),
    ...(patch.pcaItemCode === undefined ? {} : { pcaItemCode: blankToNull(patch.pcaItemCode) }),
    ...(patch.pcaJustification === undefined
      ? {}
      : { pcaJustification: blankToNull(patch.pcaJustification) }),
    ...(patch.completedSteps === undefined
      ? {}
      : { completedSteps: normalizeCompletedSteps(patch.completedSteps) }),
  };
  const changes: DfdHeaderChange[] = [];
  const next: Record<string, unknown> = { ...dfd };
  for (const field of DFD_PATCH_FIELDS) {
    const value = normalized[field];
    if (value === undefined || sameValue(dfd[field], value)) continue;
    changes.push({ field, old: dfd[field], new: value });
    next[field] = value;
  }
  if (changes.length === 0) return { dfd, changes };
  return {
    dfd: { ...(next as unknown as Dfd), updatedAt: stamp.now, updatedById: stamp.actorId },
    changes,
  };
}
