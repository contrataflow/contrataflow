import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { AttachmentTargetRegistry } from '#shared/files/attachment-targets.js';
import type {
  AttachmentConfidentiality,
  AttachmentTarget,
  AttachmentTargetReader,
  AttachmentTargetRef,
} from '#shared/files/attachment-targets.js';

import { PRICE_RESEARCH_REPOSITORY, PRICE_SOURCE_REPOSITORY } from './ports.js';
import type { PriceResearchRepository, PriceSourceRepository } from './ports.js';

/*
 * Alvo de anexo `PRICE_SOURCE` (US-026 · RN-PRICE-28 · US-068): a evidência da fonte (o orçamento,
 * o print do sítio eletrônico) segue o fluxo genérico de upload. A fonte é parte do documento da
 * pesquisa de preços, então tudo é decidido pelo alvo `DOCUMENT` dela: visibilidade (404 — DEC-024),
 * a POL-02 de edição com o documento em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`) e o sigilo
 * do arquivo (documento `RESTRICTED` em processo sigiloso — POL-09, US-069).
 */

@Injectable()
export class PriceSourceAttachmentTargets implements AttachmentTargetReader {
  readonly targetTypes = ['PRICE_SOURCE'] as const;

  constructor(
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly registry: AttachmentTargetRegistry,
  ) {}

  async load(tx: TenantTx, ref: AttachmentTargetRef): Promise<AttachmentTarget | null> {
    const document = await this.documentTarget(tx, ref);
    if (document === null) return null;
    return { ...ref, processId: document.processId, process: document.process };
  }

  async assertAttachable(tx: TenantTx, target: AttachmentTarget): Promise<void> {
    const document = await this.documentTarget(tx, target);
    if (document === null) throw new Error('Fonte de pesquisa sem documento visível.');
    await this.registry.assertAttachable(tx, document);
  }

  async confidentiality(
    tx: TenantTx,
    ref: AttachmentTargetRef,
  ): Promise<AttachmentConfidentiality | null> {
    const documentId = await this.documentIdOf(tx, ref);
    if (documentId === null) return null;
    return this.registry.confidentiality(tx, { targetType: 'DOCUMENT', targetId: documentId });
  }

  private async documentTarget(
    tx: TenantTx,
    ref: AttachmentTargetRef,
  ): Promise<AttachmentTarget | null> {
    const documentId = await this.documentIdOf(tx, ref);
    if (documentId === null) return null;
    return this.registry.load(tx, { targetType: 'DOCUMENT', targetId: documentId });
  }

  private async documentIdOf(tx: TenantTx, ref: AttachmentTargetRef): Promise<string | null> {
    const source = await this.sources.findSource(tx, ref.targetId);
    if (source === null) return null;
    const research = await this.researches.findById(tx, source.priceResearchId);
    return research?.documentId ?? null;
  }
}
