import type { PcaStatus, Priority } from '@contrataflow/validation';
import { Decimal } from 'decimal.js';

import { acceptsDerivedEstimatedValue } from './derived-estimated-value.js';
import type { ProcessItem } from './process-items.js';
import type { Process } from './process.js';

/*
 * `Process.syncFromDfd` (US-017 · RN-DFD-63..66 · DEC-019/029/032): o que a aprovação do DFD propaga
 * ao processo — valor estimado (só sobre origem `MANUAL`/`DFD`/nula), situação no PCA, prioridade e
 * a quantidade de referência dos itens que o DFD declara. Puro: quem chama trava o processo, grava,
 * audita e publica.
 */

/** Os campos do DFD aprovado que o processo recebe. */
export interface DfdSyncSource {
  /** Decimal(18,2) como string; `null` = o DFD não estimou (o valor do processo fica). */
  readonly estimatedValue: string | null;
  readonly priority: Priority;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
}

export type DfdSyncField =
  | 'estimatedValue'
  | 'estimatedValueSource'
  | 'pcaStatus'
  | 'pcaYear'
  | 'pcaItemCode'
  | 'pcaJustification'
  | 'priority';

export interface DfdSyncChange {
  readonly field: DfdSyncField;
  readonly old: unknown;
  readonly new: unknown;
}

export interface DfdSyncResult {
  /** O processo com os campos propagados (sem mudar `version`/`updated*` — é de quem grava). */
  readonly next: Process;
  /** Só os campos que mudaram, na ordem de `DfdSyncField`. */
  readonly changes: readonly DfdSyncChange[];
  /** RN-DFD-63: o DFD estimou, mas a origem atual tem precedência maior (ETP, pesquisa, TR). */
  readonly estimatedValueSkipped: boolean;
}

function sameAmount(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Decimal(a).equals(new Decimal(b));
}

/** RN-DFD-63..66 sobre o processo. */
export function syncFromDfd(process: Process, dfd: DfdSyncSource): DfdSyncResult {
  const incoming = dfd.estimatedValue;
  const valueApplies =
    incoming !== null && acceptsDerivedEstimatedValue(process.estimatedValueSource, 'DFD');
  const next: Process = {
    ...process,
    ...(incoming !== null && valueApplies
      ? {
          estimatedValue: new Decimal(incoming).toFixed(2),
          estimatedValueSource: 'DFD' as const,
        }
      : {}),
    pcaStatus: dfd.pcaStatus,
    pcaYear: dfd.pcaYear,
    pcaItemCode: dfd.pcaItemCode,
    pcaJustification: dfd.pcaJustification,
    priority: dfd.priority,
  };
  const changes: DfdSyncChange[] = [];
  if (!sameAmount(process.estimatedValue, next.estimatedValue)) {
    changes.push({
      field: 'estimatedValue',
      old: process.estimatedValue,
      new: next.estimatedValue,
    });
  }
  const fields = [
    'estimatedValueSource',
    'pcaStatus',
    'pcaYear',
    'pcaItemCode',
    'pcaJustification',
    'priority',
  ] as const;
  for (const field of fields) {
    if (process[field] !== next[field]) {
      changes.push({ field, old: process[field], new: next[field] });
    }
  }
  return {
    next,
    changes,
    estimatedValueSkipped: dfd.estimatedValue !== null && !valueApplies,
  };
}

/** Uma linha do DFD aprovado: o item do processo e a quantidade declarada (Decimal(18,4)). */
export interface DfdQuantityLine {
  readonly processItemId: string;
  readonly quantity: string;
}

export interface ReferenceQuantityUpdate {
  readonly itemId: string;
  /** Decimal(18,4) como string. */
  readonly quantity: string;
  readonly oldQuantity: string | null;
  readonly oldSourceDocumentId: string | null;
}

/**
 * RN-DFD-64 (DEC-019): cada item ativo do processo com linha no DFD recebe a quantidade e a origem
 * (o documento do DFD); itens sem linha não mudam. Linha já igual (quantidade e origem) fica de fora.
 */
export function referenceQuantityUpdates(
  items: readonly ProcessItem[],
  lines: readonly DfdQuantityLine[],
  sourceDocumentId: string,
): ReferenceQuantityUpdate[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const updates: ReferenceQuantityUpdate[] = [];
  for (const line of lines) {
    const item = byId.get(line.processItemId);
    if (item === undefined) continue;
    const quantity = new Decimal(line.quantity).toFixed(4);
    if (
      sameAmount(item.referenceQuantity, quantity) &&
      item.referenceQuantitySourceDocumentId === sourceDocumentId
    ) {
      continue;
    }
    updates.push({
      itemId: item.id,
      quantity,
      oldQuantity: item.referenceQuantity,
      oldSourceDocumentId: item.referenceQuantitySourceDocumentId,
    });
  }
  return updates;
}
