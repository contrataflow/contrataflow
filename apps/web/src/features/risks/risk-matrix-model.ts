import { RISK_LEVEL_LABELS } from '@contrataflow/validation';
import type {
  RiskListMetaDto,
  RiskMatrixCellDto,
  RiskMatrixDto,
  Violation,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';
import type { ApiError } from '@/lib/api/api-error';

import { gradeLabelOf } from './risks-model';

/*
 * Regras de apresentação da aba "Matriz" do SCR-011 (US-035): o rótulo acessível das células da
 * grade de calor, o que o botão "Emitir Mapa de Riscos" mostra (a partir do `meta` de RSK-01 —
 * `riskMap`, `canManage`) e o desfecho de uma emissão recusada (RSK-10).
 */

/** `aria-label` da célula: graus com rótulo, quantidade e nível (cor nunca é a única pista). */
export function heatmapCellLabelOf(cell: RiskMatrixCellDto, scale: RiskMatrixDto['scale']): string {
  const count = cell.risks.length;
  const risks =
    count === 0
      ? 'nenhum risco'
      : `${String(count)} ${count === 1 ? 'risco' : 'riscos'} (${cell.risks.map((risk) => risk.code).join(', ')})`;
  return `Probabilidade ${gradeLabelOf(scale.probabilityLabels, cell.probability)}, impacto ${gradeLabelOf(scale.impactLabels, cell.impact)}: ${risks}, nível ${RISK_LEVEL_LABELS[cell.level]}`;
}

/** Status em que o Mapa de Riscos está concluído e os riscos bloqueados (RN-RISK-23). */
const COMPLETED_STATUSES: ReadonlySet<string> = new Set([
  'FINALIZED',
  'APPROVED',
  'IN_REVIEW',
  'REJECTED',
]);

export type RiskMapAction =
  /** Sem `RISK_MAP` e com permissão: "Emitir Mapa de Riscos" (desabilitado sem riscos — FA-02). */
  | { readonly kind: 'emit'; readonly disabled: boolean }
  /** `RISK_MAP` em rascunho/devolvido: abrir para conferir e finalizar. */
  | { readonly kind: 'open'; readonly documentId: string; readonly code: string | null }
  /** `RISK_MAP` concluído (ou rejeitado): riscos bloqueados até a reabertura (RN-RISK-23). */
  | {
      readonly kind: 'completed';
      readonly documentId: string;
      readonly code: string | null;
      readonly rejected: boolean;
    }
  /** Sem `RISK_MAP` e sem permissão de emitir: nada a exibir. */
  | { readonly kind: 'none' };

export function riskMapActionOf(
  meta: Pick<RiskListMetaDto, 'riskMap' | 'canManage'>,
  riskCount: number,
): RiskMapAction {
  const { riskMap } = meta;
  if (riskMap === null) {
    return meta.canManage ? { kind: 'emit', disabled: riskCount === 0 } : { kind: 'none' };
  }
  const target = { documentId: riskMap.id, code: riskMap.code };
  return COMPLETED_STATUSES.has(riskMap.status)
    ? { kind: 'completed', ...target, rejected: riskMap.status === 'REJECTED' }
    : { kind: 'open', ...target };
}

/** Resultado de uma emissão recusada pelo servidor (a faixa abaixo do botão). */
export type EmitOutcome =
  | { readonly kind: 'exists'; readonly documentId: string | null }
  | { readonly kind: 'empty' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notEditable' }
  | { readonly kind: 'typeNotAllowed' }
  | { readonly kind: 'unavailable'; readonly correlationId: string | null }
  | { readonly kind: 'failed'; readonly correlationId: string | null };

/** `meta.existingDocumentId` do 409 `DOCUMENT_ALREADY_EXISTS` (FA-01: "Abrir o existente"). */
function existingDocumentId(error: ApiError): string | null {
  const meta = (error.problem?.meta ?? {}) as { existingDocumentId?: unknown };
  return typeof meta.existingDocumentId === 'string' ? meta.existingDocumentId : null;
}

export function emitOutcomeOf(error: unknown): EmitOutcome {
  if (!isApiError(error)) return { kind: 'failed', correlationId: null };
  if (error.code === 'DOCUMENT_ALREADY_EXISTS') {
    return { kind: 'exists', documentId: existingDocumentId(error) };
  }
  if (error.code === 'BUSINESS_RULE_VIOLATION') return { kind: 'empty' };
  if (error.status === 403) return { kind: 'forbidden' };
  if (error.code === 'DOCUMENT_NOT_EDITABLE' || error.code === 'INVALID_PROCESS_STATUS') {
    return { kind: 'notEditable' };
  }
  if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') return { kind: 'typeNotAllowed' };
  if (error.status === 503) return { kind: 'unavailable', correlationId: error.correlationId };
  return { kind: 'failed', correlationId: error.correlationId };
}

/** Pendências de risco do DOC-08 (RN-RISK-21), bloqueantes primeiro, na ordem do servidor. */
export function riskViolationsOf(violations: readonly Violation[]): Violation[] {
  return violations.filter((violation) => violation.code.startsWith('RISK_'));
}
