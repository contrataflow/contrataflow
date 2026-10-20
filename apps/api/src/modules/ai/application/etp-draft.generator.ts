import { Injectable, Logger } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';

import { AiPolicyRevokedError } from './ai-generator.js';
import type {
  AiGenerator,
  AiGeneratorCheck,
  AiGeneratorContext,
  AiGeneratorRequest,
} from './ai-generator.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { DfdFacade } from '../../dfd/application/dfd.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { EtpFacade } from '../../etp/application/etp.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { PriceResearchFacade } from '../../price-research/application/price-research.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import { assembleEtpDraftContext } from '../domain/etp-draft-context.js';
import { ETP_DRAFT_PROMPT } from '../prompts/draft.etp/prompt.js';

/*
 * `EtpDraftGenerator` — `ETP`/`DRAFT` (US-118 · RN-AI-33..37): o rascunho das seções narrativas do
 * ETP a partir do DFD e dos dados já cadastrados. No pedido, o DFD não cancelado (RN-AI-33 —
 * `AI_PREREQUISITE_MISSING`); o ETP em `DRAFT`/`RETURNED`, a POL-02 e a etapa já foram conferidos
 * pelo pipeline (`DocumentFacade.aiTargetIn`). No job, o DFD pela precedência aprovada → finalizada
 * → rascunho (`DfdSourceResolver` = `DocumentFacade.aiChainSourceIn`) e o contexto pelas FACHADAS
 * DE LEITURA de `document`, `dfd`, `etp`, `price-research`, `process`, `catalog` e `organization`
 * (regra D9), na transação do tenant (RLS), montado por `assembleEtpDraftContext`. Nada é escrito em
 * `etp`, `dfd` nem `price-research`: a aplicação é o DOC-26 do `document`.
 */

/** Reserva de tokens do rascunho do ETP (RN-AI-18 · "Fluxo principal", passo 2). */
const ETP_DRAFT_RESERVED_TOKENS = 40_000;
const ETP_DRAFT_MAX_OUTPUT_TOKENS = 12_000;

@Injectable()
export class EtpDraftGenerator implements AiGenerator {
  readonly targetModule = 'ETP' as const;
  readonly kind = 'DRAFT' as const;
  readonly prompt = ETP_DRAFT_PROMPT;
  readonly reservedTokens = ETP_DRAFT_RESERVED_TOKENS;
  readonly needSummary = 'OPTIONAL' as const;
  readonly maxOutputTokens = ETP_DRAFT_MAX_OUTPUT_TOKENS;
  private readonly logger = new Logger('EtpDraftGenerator');

  constructor(
    private readonly documents: DocumentFacade,
    private readonly dfds: DfdFacade,
    private readonly etps: EtpFacade,
    private readonly priceResearches: PriceResearchFacade,
    private readonly processes: ProcessFacade,
    private readonly catalog: CatalogFacade,
    private readonly departments: OrganizationFacade,
    private readonly processItems: ProcessItemCatalogRegistry,
  ) {}

  /** RN-AI-33 (V-03): DFD não cancelado no processo; revalidado no job (`buildContext`). */
  async validateRequest(tx: TenantTx, request: AiGeneratorRequest): Promise<AiGeneratorCheck> {
    const dfd = await this.documents.aiChainSourceIn(tx, request.processId, 'DFD');
    if (dfd === null) {
      this.logger.warn({ event: 'ai.prerequisite_missing', missing: ['DFD'] });
      throw new ApiError('AI_PREREQUISITE_MISSING', {
        detail: 'Elabore o DFD antes de gerar o ETP com IA.',
        extensions: { meta: { missing: ['DFD'] } },
      });
    }
    return { baseRevision: null };
  }

  async buildContext(tx: TenantTx, generation: AiGeneration): Promise<AiGeneratorContext> {
    const documentId = generation.documentId;
    if (documentId === null) throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    // Leituras em sequência: uma transação interativa não executa consultas em paralelo.
    const dfd = await this.documents.aiChainSourceIn(tx, generation.processId, 'DFD');
    const source = await this.documents.aiDraftSourceIn(tx, documentId);
    const etp = await this.etps.aiDraftContextIn(tx, documentId);
    const process = await this.processes.aiContextIn(tx, generation.processId);
    if (dfd === null || source === null || etp === null || process === null) {
      throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    }
    const header = await this.dfds.aiDraftHeaderIn(tx, dfd.documentId);
    const research = await this.priceResearches.aiCompletedResearchIn(tx, process.id);

    const catalogIds = [process.contractingTypeId, process.modalityId].filter(
      (id): id is string => id !== null,
    );
    const labels = new Map<string, string>();
    for (const id of catalogIds) {
      const item = await this.catalog.find(tx, id);
      if (item !== null) labels.set(id, item.label);
    }
    const departmentNames = await this.departments.departmentNames(tx, [
      process.requestingSecretariatId,
      process.requestingDepartmentId,
    ]);
    const processItems = new Map(
      (await this.processItems.listActive(tx, process.id)).map((item) => [item.id, item]),
    );
    const lines = source.items.flatMap((line) => {
      const item = processItems.get(line.processItemId);
      return item === undefined ? [] : [{ item, line }];
    });
    const units = await this.catalog.unitsOf(
      tx,
      lines.map(({ item }) => item.unitOfMeasureId),
    );
    const labelOf = (id: string | null) => (id === null ? null : (labels.get(id) ?? null));

    return assembleEtpDraftContext({
      process: {
        id: process.id,
        code: process.code,
        title: process.title,
        object: process.object,
        description: process.description,
        contractingType: labelOf(process.contractingTypeId),
        modality: labelOf(process.modalityId),
        isPriceRegistration: process.isPriceRegistration,
        priority: process.priority,
        pcaStatus: process.pcaStatus,
        pcaYear: process.pcaYear,
        pcaItemCode: process.pcaItemCode,
        requestingSecretariat: departmentNames.get(process.requestingSecretariatId) ?? null,
        requestingDepartment: departmentNames.get(process.requestingDepartmentId) ?? null,
        isBudgetConfidential: process.isBudgetConfidential,
      },
      dfd: {
        documentId: dfd.documentId,
        documentTypeCode: dfd.documentTypeCode,
        source: dfd.source,
        versionNumber: dfd.versionNumber,
        draftRevision: dfd.draftRevision,
        sections: dfd.sections,
        header:
          header === null
            ? null
            : {
                objectSummary: header.objectSummary,
                priority: header.priority,
                expectedDate: header.expectedDate,
                pcaStatus: header.pcaStatus,
                pcaYear: header.pcaYear,
                pcaItemCode: header.pcaItemCode,
              },
      },
      etp: {
        documentId: source.documentId,
        documentTypeCode: source.documentTypeCode,
        draftRevision: source.draftRevision,
        conclusion: etp.conclusion,
        parcelingDecision: etp.parcelingDecision,
        recommendedAlternativeId: etp.recommendedAlternativeId,
        estimatedTotalValue: etp.estimatedTotalValue,
        estimatedValueSource: etp.estimatedValueSource,
      },
      items: lines.map(({ item, line }) => ({
        processItemId: item.id,
        description: item.description,
        unit: units.get(item.unitOfMeasureId)?.label ?? null,
        quantity: line.quantity,
        calculationMemo: line.calculationMemo,
      })),
      alternatives: etp.alternatives,
      priceResearch: research,
      template: source.template,
    });
  }
}
