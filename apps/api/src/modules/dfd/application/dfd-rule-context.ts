import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DFD_REPOSITORY } from './ports.js';
import type { DfdRepository } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  RuleContextContribution,
  RuleContextContributor,
  RuleContextRequest,
  RuleDocumentFact,
} from '../../workflow/application/workflow.facade.js';

/**
 * Contribuidor `dfd` do `RuleContext` (US-014 · RN-DFD-19 · DEC-015): `documents.DFD` com a MESMA
 * completude do DOC-08 (`DocumentFacade.isCompleteIn` — genéricas + `DfdDocumentValidator`), que a
 * regra `REQUIRED_DOCUMENT` (`minStatus: COMPLETE`) da saída de `ABERTURA` lê. Substitui os fatos
 * de DFD da semente do `process`. Somente leitura, no `tx` do chamador.
 */
@Injectable()
export class DfdRuleContextContributor implements RuleContextContributor {
  readonly name = 'dfd';

  constructor(
    @Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository,
    private readonly documents: DocumentFacade,
  ) {}

  async contribute(tx: TenantTx, request: RuleContextRequest): Promise<RuleContextContribution> {
    const dfds = await this.dfds.listByProcess(tx, request.processId);
    if (dfds.length === 0) return {};
    const states = await this.documents.documentStatesIn(
      tx,
      dfds.map((dfd) => dfd.documentId),
    );
    const documents: RuleDocumentFact[] = [];
    for (const dfd of dfds) {
      const state = states.get(dfd.documentId);
      if (state === undefined) continue;
      documents.push({
        documentTypeCode: 'DFD',
        status: state.status,
        isComplete: (await this.documents.isCompleteIn(tx, dfd.documentId)) === true,
        versionNumber: state.currentVersionNumber,
        approvedAt: state.approvedAt?.toISOString() ?? null,
      });
    }
    return { documents };
  }
}
