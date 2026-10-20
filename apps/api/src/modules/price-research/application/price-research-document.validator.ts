import type { Violation } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ComparativeMapAssembler } from './comparative-map.queries.js';
import { PRICE_RESEARCH_REPOSITORY } from './ports.js';
import type { PriceResearchRepository } from './ports.js';
import type {
  DocumentValidationSubject,
  DocumentValidator,
  TypedSnapshotParts,
} from '../../document/application/document.facade.js';
import { comparativeMapSnapshot } from '../domain/comparative-map.js';

/*
 * `PriceResearchDocumentValidator` (US-031 · porta `DocumentValidator` da US-065): o conteúdo tipado
 * do documento `PRICE_RESEARCH` no snapshot — o mapa comparativo que a seção computada
 * `PRICE_SUMMARY` renderiza no PDF (RN-PRICE-55: DOC-20 monta a prévia com o estado vigente; DOC-21
 * congela o da versão). Sem máscara: o `document` aplica a POL-09 decidida no pedido da rendition
 * (`maskConfidentialSnapshot`). Regras de completude próprias da pesquisa ficam para a conclusão
 * (US-032 · PRS-23); aqui só as genéricas valem.
 */

@Injectable()
export class PriceResearchDocumentValidator implements DocumentValidator {
  readonly module = 'PRICE_RESEARCH' as const;

  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly assembler: ComparativeMapAssembler,
  ) {}

  validate(): Promise<readonly Violation[]> {
    return Promise.resolve([]);
  }

  async snapshotParts(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<TypedSnapshotParts> {
    const research = await this.researches.findById(tx, subject.document.id);
    if (research === null) return { header: {}, collections: {} };
    const map = await this.assembler.assemble(tx, research, subject.document);
    return { header: {}, collections: comparativeMapSnapshot(map) };
  }
}
