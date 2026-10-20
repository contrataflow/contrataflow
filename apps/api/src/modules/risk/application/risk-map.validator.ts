import type { RiskDto, Violation } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { RISK_REPOSITORY } from './ports.js';
import type { RiskRepository } from './ports.js';
import { RiskPresenter, RiskScaleReader } from './risk.support.js';
import type {
  DocumentValidationSubject,
  DocumentValidator,
  TypedSnapshotParts,
} from '../../document/application/document.facade.js';
import { riskMapSnapshot, riskMapSummary, riskMapViolations } from '../domain/risk-map.js';

/*
 * `RiskMapDocumentValidator` (US-035 · porta `DocumentValidator` da US-065): o módulo `risk` só
 * fornece as regras e o conteúdo tipado do `RISK_MAP`; o ciclo de vida (DOC-08/09/10/12 —
 * transições, versão, auditoria, eventos e timeline) é o genérico do `document`, sem duplicação.
 * Completude RN-RISK-21 (`RISK_LIST_EMPTY`, `RISK_TREATMENT_REQUIRED_FOR_LEVEL`), snapshot dos
 * riscos e tratamentos VIGENTES na submissão/finalização (RN-RISK-20 — pelo mesmo apresentador de
 * RSK-01 e pela mesma agregação da matriz) e o resumo de `DocumentFinalized`. Tudo no `tx` do caso
 * de uso; nunca textos dos riscos no log.
 */

@Injectable()
export class RiskMapDocumentValidator implements DocumentValidator {
  readonly module = 'RISK_MAP' as const;
  private readonly logger = new Logger('RiskMap');

  constructor(
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly presenter: RiskPresenter,
    private readonly scales: RiskScaleReader,
  ) {}

  /** Riscos não excluídos do processo do documento, com os tratamentos (o DTO de RSK-01). */
  private async currentRisks(tx: TenantTx, subject: DocumentValidationSubject): Promise<RiskDto[]> {
    const risks = await this.risks.listByProcess(tx, subject.document.processId, {});
    return risks.length === 0 ? [] : this.presenter.present(tx, risks);
  }

  async validate(tx: TenantTx, subject: DocumentValidationSubject): Promise<readonly Violation[]> {
    const startedAt = performance.now();
    const violations = riskMapViolations(await this.currentRisks(tx, subject));
    this.logger.debug(
      {
        event: 'document.validation_evaluated',
        documentId: subject.document.id,
        blockingCount: violations.filter((item) => item.severity === 'BLOCKING').length,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'document.validation_evaluated',
    );
    return violations;
  }

  async typedSummary(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    return riskMapSummary(await this.currentRisks(tx, subject));
  }

  async snapshotParts(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<TypedSnapshotParts> {
    return riskMapSnapshot(await this.currentRisks(tx, subject), await this.scales.current(tx));
  }
}
