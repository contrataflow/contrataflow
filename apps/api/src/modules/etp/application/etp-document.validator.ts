import { evaluateEtpCompleteness } from '@contrataflow/validation';
import type { Violation } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ETP_ALTERNATIVE_REPOSITORY, ETP_REPOSITORY } from './ports.js';
import type { EtpAlternativeRepository, EtpRepository } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  DocumentValidationSubject,
  DocumentValidator,
  TypedSnapshotParts,
} from '../../document/application/document.facade.js';
import type { EtpAlternative } from '../domain/etp-alternative.js';
import { etpSnapshotHeader } from '../domain/etp.js';

/*
 * `EtpDocumentValidator` (US-023 · RN-ETP-33..38 · porta `DocumentValidator` da US-065): o módulo
 * `etp` só fornece o cabeçalho e as regras próprias; o `document` compõe as genéricas de seção
 * (RN-ETP-33 — configuração semeada do template, DEC-016) com estas num único `violations[]`. O
 * DOC-08 e a revalidação do DOC-10 na MESMA transação da finalização (RN-ETP-37 — FA-03: vale o
 * estado do momento do clique, não o da última consulta) usam o mesmo registro. A versão
 * `FINALIZATION` congela o cabeçalho, os itens e as alternativas (entities.md §5.3.2). Sem
 * `typedSummary`: não definido para o ETP no catálogo de eventos. Tudo no `tx` do caso de uso;
 * nunca valores nem textos no log.
 */

@Injectable()
export class EtpDocumentValidator implements DocumentValidator {
  readonly module = 'ETP' as const;
  private readonly logger = new Logger('Etp');

  constructor(
    @Inject(ETP_REPOSITORY) private readonly etps: EtpRepository,
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
    private readonly documents: DocumentFacade,
  ) {}

  async validate(tx: TenantTx, subject: DocumentValidationSubject): Promise<readonly Violation[]> {
    const startedAt = performance.now();
    const etp = await this.etps.findById(tx, subject.document.id);
    if (etp === null) return [];
    const items = await this.documents.documentItemsIn(tx, subject.document.id);
    const alternatives = await this.alternatives.listByEtp(tx, etp.id);
    const violations = evaluateEtpCompleteness({
      conclusion: etp.conclusion,
      parcelingDecision: etp.parcelingDecision,
      estimatedTotalValue: etp.estimatedTotalValue,
      items,
      recommendedAlternatives: alternatives.filter(
        (alternative) => alternative.decision === 'RECOMMENDED',
      ).length,
    });
    this.logger.debug(
      {
        event: 'document.validation_evaluated',
        documentId: subject.document.id,
        blockingCount: violations.filter((item) => item.severity === 'BLOCKING').length,
        warningCount: violations.filter((item) => item.severity === 'WARNING').length,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'document.validation_evaluated',
    );
    return violations;
  }

  /**
   * `EtpSnapshotBuilder` (US-023 · RN-ETP-38): cabeçalho tipado, itens (com a memória de cálculo) e
   * alternativas não excluídas congelados na versão; POL-09 é de quem lê (custos e valor estimado
   * mascarados pelo `document`).
   */
  async snapshotParts(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<TypedSnapshotParts> {
    const etp = await this.etps.findById(tx, subject.document.id);
    if (etp === null) return { header: {}, collections: {} };
    const items = await this.documents.snapshotItemsIn(tx, subject.document);
    const alternatives = await this.alternatives.listByEtp(tx, etp.id);
    return {
      header: etpSnapshotHeader(etp),
      collections: { items, alternatives: alternatives.map(alternativeSnapshot) },
    };
  }
}

function alternativeSnapshot(alternative: EtpAlternative): Readonly<Record<string, unknown>> {
  return {
    id: alternative.id,
    name: alternative.name,
    description: alternative.description,
    advantages: alternative.advantages,
    disadvantages: alternative.disadvantages,
    estimatedCost: alternative.estimatedCost,
    riskLevel: alternative.riskLevel,
    observations: alternative.observations,
    decision: alternative.decision,
    decisionJustification: alternative.decisionJustification,
    sortOrder: alternative.sortOrder,
  };
}
