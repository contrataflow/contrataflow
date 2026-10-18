import {
  RISK_LEVELS,
  RISK_LEVEL_LABELS,
  RISK_PHASE_LABELS,
  RISK_STATUS_LABELS,
  TREATMENT_STATUS_LABELS,
  TREATMENT_TYPE_LABELS,
  buildRiskMatrix,
  evaluateRiskMapCompleteness,
} from '@contrataflow/validation';
import type {
  RiskDto,
  RiskLevel,
  RiskMatrixDto,
  RiskScaleSnapshot,
  Violation,
} from '@contrataflow/validation';

/*
 * Mapa de Riscos (US-035 · DEC-021): a matriz (`RiskMatrix` — RN-RISK-18), a completude
 * (RN-RISK-21) e o snapshot congelado na `DocumentVersion` (`RiskMapSnapshotBuilder` —
 * RN-RISK-20). Funções puras sobre os DTOs dos riscos (o MESMO apresentador de RSK-01): o que a
 * tela mostra é o que a versão congela.
 */

/** RN-RISK-18: a grade da escala VIGENTE com os riscos do processo (já filtrados). */
export function riskMatrixOf(
  risks: readonly Pick<RiskDto, 'id' | 'code' | 'title' | 'probability' | 'impact'>[],
  current: RiskScaleSnapshot,
): RiskMatrixDto {
  return buildRiskMatrix(risks, current);
}

/** RN-RISK-21 sobre os riscos não excluídos (com os tratamentos não excluídos de cada um). */
export function riskMapViolations(risks: readonly RiskDto[]): Violation[] {
  return evaluateRiskMapCompleteness(risks);
}

/** Cabeçalho e coleções do `RISK_MAP` (a forma de `TypedSnapshotParts` do `document`). */
export interface RiskMapSnapshot {
  readonly header: Readonly<Record<string, unknown>>;
  readonly collections: Readonly<Record<string, readonly unknown[]>>;
}

const countByLevel = (risks: readonly RiskDto[]): Record<RiskLevel, number> =>
  Object.fromEntries(
    RISK_LEVELS.map((level) => [level, risks.filter((risk) => risk.level === level).length]),
  ) as Record<RiskLevel, number>;

/**
 * RN-RISK-20 (`RiskMapSnapshotBuilder`): os riscos e tratamentos VIGENTES congelados na versão —
 * `risks` (uma linha por risco, rótulos legíveis), `treatments` (uma linha por ação, com o código
 * do risco) e `matrix` (as células ocupadas da grade vigente, a mesma agregação de RSK-09). O
 * cabeçalho traz a escala usada e as contagens. Riscos já vêm por `sortOrder`/`code`.
 */
export function riskMapSnapshot(
  risks: readonly RiskDto[],
  current: RiskScaleSnapshot,
): RiskMapSnapshot {
  const matrix = riskMatrixOf(risks, current);
  return {
    header: {
      riskCount: risks.length,
      treatmentCount: risks.reduce((total, risk) => total + risk.treatments.length, 0),
      scaleMax: current.scale.max,
      levelThresholds: current.levelThresholds.map((band) => ({ ...band })),
      byLevel: countByLevel(risks),
    },
    collections: {
      risks: risks.map((risk) => ({
        riskId: risk.id,
        code: risk.code,
        title: risk.title,
        description: risk.description,
        category: risk.category.label,
        phase: RISK_PHASE_LABELS[risk.phase],
        cause: risk.cause,
        consequence: risk.consequence,
        probability: risk.probability,
        impact: risk.impact,
        score: risk.score,
        level: RISK_LEVEL_LABELS[risk.level],
        residualScore: risk.residualScore,
        residualLevel: risk.residualLevel === null ? null : RISK_LEVEL_LABELS[risk.residualLevel],
        status: RISK_STATUS_LABELS[risk.status],
        owner: risk.owner?.name ?? risk.ownerDepartment?.name ?? null,
      })),
      treatments: risks.flatMap((risk) =>
        risk.treatments.map((treatment) => ({
          treatmentId: treatment.id,
          riskCode: risk.code,
          type: TREATMENT_TYPE_LABELS[treatment.type],
          description: treatment.description,
          responsible: treatment.responsible?.name ?? treatment.responsibleDepartment?.name ?? null,
          dueDate: treatment.dueDate,
          status: TREATMENT_STATUS_LABELS[treatment.status],
          completedAt: treatment.completedAt,
          notes: treatment.notes,
        })),
      ),
      matrix: matrix.cells
        .filter((cell) => cell.risks.length > 0)
        .map((cell) => ({
          probability: cell.probability,
          impact: cell.impact,
          score: cell.score,
          level: RISK_LEVEL_LABELS[cell.level],
          risks: cell.risks.map((risk) => risk.code).join(', '),
        })),
    },
  };
}

/**
 * Resumo de `DocumentFinalized` e de `document.finalize` (RN-DOC-52 · "Auditoria": quantidade de
 * riscos no snapshot) e do cartão do painel de documentos.
 */
export function riskMapSummary(risks: readonly RiskDto[]): Readonly<Record<string, unknown>> {
  return {
    riskCount: risks.length,
    treatmentCount: risks.reduce((total, risk) => total + risk.treatments.length, 0),
    byLevel: countByLevel(risks),
  };
}
