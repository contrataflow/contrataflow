import {
  DFD_WIZARD_STEPS,
  PRIORITY_RANK,
  documentItemQuantityIssue,
  dfdStepOfViolation,
} from '@contrataflow/validation';
import type {
  DfdDto,
  DfdHeaderValues,
  DfdWizardStep,
  DocumentItemDto,
  DocumentItemInput,
  Priority,
  ProcessItemDto,
  Violation,
} from '@contrataflow/validation';

/*
 * Regras de tela do wizard do DFD (US-014 · SCR-007), puras e testadas: passos e `?passo=`, a grade
 * de itens (itens do processo × itens do DFD), a coleção enviada ao DOC-07, a reaplicação das
 * alterações locais depois de um 412 (merge por `processItemId`) e o checklist agrupado por passo.
 * A UI nunca recalcula permissões: edição = `meta.allowedActions` contém `UPDATE`.
 */

/** `?passo=` de cada passo (screens.md SCR-007). */
export const DFD_STEP_SLUGS: Readonly<Record<DfdWizardStep, string>> = {
  IDENTIFICATION: 'identificacao',
  JUSTIFICATION: 'justificativa',
  PLANNING: 'planejamento',
  REVIEW: 'revisao',
  CONCLUSION: 'conclusao',
};

export function stepFromSlug(slug: string | null | undefined): DfdWizardStep | null {
  const found = DFD_WIZARD_STEPS.find((step) => DFD_STEP_SLUGS[step] === slug);
  return found ?? null;
}

export const stepIndex = (step: DfdWizardStep) => DFD_WIZARD_STEPS.indexOf(step);

/** O cabeçalho do DFD como o wizard o edita (FA-06: estimativa mascarada não é editável). */
export function headerOf(dfd: DfdDto): DfdHeaderValues {
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
  };
}

/** Edição liberada pela API (FA-05: fora de `DRAFT`/`RETURNED` ou sem permissão = leitura). */
export function canEditDfd(allowedActions: readonly string[]): boolean {
  return allowedActions.includes('UPDATE');
}

/** Dica de US-017: a prioridade do DFD é maior que a do processo. */
export function raisesProcessPriority(dfd: Priority | null, process: Priority): boolean {
  return dfd !== null && PRIORITY_RANK[dfd] > PRIORITY_RANK[process];
}

/** Linha da grade "Itens e quantidades" (passo 3). */
export interface ItemRow {
  readonly processItemId: string;
  readonly sequence: number;
  readonly description: string;
  readonly unitLabel: string;
  readonly allowsDecimal: boolean;
  readonly included: boolean;
  /** Texto digitado (ou a quantidade gravada / `referenceQuantity` sugerida). */
  readonly quantity: string;
}

/** Quantidade gravada como o usuário a lê (`"120.0000"` → `"120"`). */
export function displayQuantity(quantity: string | null): string {
  if (quantity === null) return '';
  return quantity.includes('.') ? quantity.replace(/\.?0+$/, '') : quantity;
}

/**
 * Itens do processo por número, com a inclusão e a quantidade do DFD; sem quantidade no DFD, a
 * sugestão é a `referenceQuantity` do item (fluxo principal 9). `allowsDecimal` vem do DOC-06 ou,
 * para itens ainda não incluídos, das unidades do catálogo (`UNIT_OF_MEASURE.metadata`).
 */
export function itemRows(
  processItems: readonly ProcessItemDto[],
  documentItems: readonly DocumentItemDto[],
  unitAllowsDecimal: ReadonlyMap<string, boolean>,
): ItemRow[] {
  const included = new Map(documentItems.map((item) => [item.processItemId, item]));
  return [...processItems]
    .sort((a, b) => a.sequence - b.sequence)
    .map((item) => {
      const line = included.get(item.id);
      return {
        processItemId: item.id,
        sequence: item.sequence,
        description: item.description,
        unitLabel: item.unitOfMeasure.label,
        allowsDecimal:
          line?.unit.allowsDecimal ?? unitAllowsDecimal.get(item.unitOfMeasure.id) ?? true,
        included: line !== undefined,
        quantity: displayQuantity(line?.quantity ?? item.referenceQuantity),
      };
    });
}

/** Erro de quantidade de uma linha incluída (V-09 — a mesma regra da API). */
export function rowQuantityError(row: ItemRow): string | null {
  if (!row.included) return null;
  return documentItemQuantityIssue(row.quantity, row.allowsDecimal)?.message ?? null;
}

/** A coleção do DOC-07: só as linhas incluídas, na ordem dos itens. */
export function itemsPayload(rows: readonly ItemRow[]): DocumentItemInput[] {
  return rows
    .filter((row) => row.included)
    .map((row) => ({ processItemId: row.processItemId, quantity: row.quantity.trim() }));
}

/** O que o usuário mudou numa linha desde a última leitura (reaplicado depois de um 412). */
export interface ItemEdit {
  readonly processItemId: string;
  readonly included: boolean;
  readonly quantity: string;
}

/**
 * "Concorrência" (V-11): recarregados os itens do servidor, reaplica só as alterações locais por
 * `processItemId` — as linhas que o outro editor mudou e o usuário não tocou ficam como estão.
 */
export function mergeItemEdits(
  serverItems: readonly DocumentItemDto[],
  edits: readonly ItemEdit[],
): DocumentItemInput[] {
  const merged = new Map<string, DocumentItemInput>(
    serverItems.map((item) => [
      item.processItemId,
      { processItemId: item.processItemId, quantity: displayQuantity(item.quantity) },
    ]),
  );
  for (const edit of edits) {
    if (edit.included) {
      merged.set(edit.processItemId, {
        processItemId: edit.processItemId,
        quantity: edit.quantity.trim(),
      });
    } else {
      merged.delete(edit.processItemId);
    }
  }
  return [...merged.values()];
}

/** Checklist da revisão (RN-DFD-19): pendências por passo, bloqueantes antes dos avisos. */
export interface StepViolations {
  readonly step: DfdWizardStep;
  readonly blocking: readonly Violation[];
  readonly warnings: readonly Violation[];
}

export function violationsByStep(violations: readonly Violation[]): StepViolations[] {
  return DFD_WIZARD_STEPS.flatMap((step) => {
    const ofStep = violations.filter((item) => dfdStepOfViolation(item) === step);
    if (ofStep.length === 0) return [];
    return [
      {
        step,
        blocking: ofStep.filter((item) => item.severity === 'BLOCKING'),
        warnings: ofStep.filter((item) => item.severity === 'WARNING'),
      },
    ];
  });
}

/** Alvo do foco do "Ir para o campo": o `id` do controle do campo ou da seção. */
export function fieldAnchor(item: Pick<Violation, 'field' | 'sectionKey'>): string {
  if (item.sectionKey !== null) return `dfd-section-${item.sectionKey}`;
  return `dfd-field-${item.field ?? 'items'}`;
}

/** Departamento ativo da subárvore da secretaria solicitante (RN-DFD-09 · `path` materializado). */
export function departmentsOfSecretariat<
  T extends { readonly id: string; readonly path: string; readonly isActive: boolean },
>(departments: readonly T[], secretariatId: string): T[] {
  return departments.filter(
    (department) => department.isActive && department.path.includes(`/${secretariatId}/`),
  );
}
