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
import { DocumentFacade } from '../../document/application/document.facade.js';
import { EtpFacade } from '../../etp/application/etp.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { PriceResearchFacade } from '../../price-research/application/price-research.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { RiskFacade } from '../../risk/application/risk.facade.js';
import { TermFacade } from '../../term/application/term.facade.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import { assembleTermDraftContext } from '../domain/term-draft-context.js';
import { TERM_DRAFT_PROMPT } from '../prompts/draft.tr/prompt.js';

/*
 * `TermDraftGenerator` — `TERM_OF_REFERENCE`/`DRAFT` (US-120 · RN-AI-43..46): o rascunho das seções
 * narrativas do TR a partir do ETP e dos dados já cadastrados. No pedido, o ETP não cancelado
 * (RN-AI-43 — `AI_PREREQUISITE_MISSING`); o TR em `DRAFT`/`RETURNED`, a POL-02 e a etapa já foram
 * conferidos pelo pipeline (`DocumentFacade.aiTargetIn`). No job, o ETP e o DFD pela precedência
 * aprovada → finalizada → rascunho (`DocumentFacade.aiChainSourceIn` — o `DfdSourceResolver` da
 * US-118 generalizado) e o contexto pelas FACHADAS DE LEITURA de `document`, `term`, `etp`, `risk`,
 * `price-research`, `process`, `catalog` e `organization` (regra D9), na transação do tenant (RLS),
 * montado por `assembleTermDraftContext`. Nada é escrito em `term`, `etp`, `risk` nem
 * `price-research`: a aplicação é o DOC-26 do `document`.
 */

/** Reserva de tokens do rascunho do TR (RN-AI-18 · "Fluxo principal", passo 2). */
const TERM_DRAFT_RESERVED_TOKENS = 40_000;
const TERM_DRAFT_MAX_OUTPUT_TOKENS = 12_000;

@Injectable()
export class TermDraftGenerator implements AiGenerator {
  readonly targetModule = 'TERM_OF_REFERENCE' as const;
  readonly kind = 'DRAFT' as const;
  readonly prompt = TERM_DRAFT_PROMPT;
  readonly reservedTokens = TERM_DRAFT_RESERVED_TOKENS;
  /** O TR não usa resumo da necessidade: ela vem do ETP ("Fluxo principal", passo 2). */
  readonly needSummary = 'OPTIONAL' as const;
  readonly maxOutputTokens = TERM_DRAFT_MAX_OUTPUT_TOKENS;
  private readonly logger = new Logger('TermDraftGenerator');

  constructor(
    private readonly documents: DocumentFacade,
    private readonly terms: TermFacade,
    private readonly etps: EtpFacade,
    private readonly risks: RiskFacade,
    private readonly priceResearches: PriceResearchFacade,
    private readonly processes: ProcessFacade,
    private readonly catalog: CatalogFacade,
    private readonly departments: OrganizationFacade,
    private readonly processItems: ProcessItemCatalogRegistry,
  ) {}

  /** RN-AI-43 (V-02): ETP não cancelado no processo; revalidado no job (`buildContext`). */
  async validateRequest(tx: TenantTx, request: AiGeneratorRequest): Promise<AiGeneratorCheck> {
    const etp = await this.documents.aiChainSourceIn(tx, request.processId, 'ETP');
    if (etp === null) {
      this.logger.warn({ event: 'ai.prerequisite_missing', missing: ['ETP'] });
      throw new ApiError('AI_PREREQUISITE_MISSING', {
        detail: 'Elabore o ETP antes de gerar o TR com IA.',
        extensions: { meta: { missing: ['ETP'] } },
      });
    }
    return { baseRevision: null };
  }

  async buildContext(tx: TenantTx, generation: AiGeneration): Promise<AiGeneratorContext> {
    const documentId = generation.documentId;
    if (documentId === null) throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    // Leituras em sequência: uma transação interativa não executa consultas em paralelo.
    const etp = await this.documents.aiChainSourceIn(tx, generation.processId, 'ETP');
    const source = await this.documents.aiDraftSourceIn(tx, documentId);
    const term = await this.terms.aiDraftContextIn(tx, documentId);
    const process = await this.processes.aiContextIn(tx, generation.processId);
    if (etp === null || source === null || term === null || process === null) {
      throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    }
    const etpHeader = await this.etps.aiDraftContextIn(tx, etp.documentId);
    const dfd = await this.documents.aiChainSourceIn(tx, process.id, 'DFD');
    const risks = await this.risks.aiContextIn(tx, process.id);
    const research = await this.priceResearches.aiCompletedResearchIn(tx, process.id);

    const catalogIds = [
      process.contractingTypeId,
      process.modalityId,
      term.selectionCriterionId,
      ...risks.map((risk) => risk.categoryId),
    ].filter((id): id is string => id !== null);
    const labels = new Map<string, string>();
    for (const id of new Set(catalogIds)) {
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
    const chain = (document: NonNullable<typeof etp>) => ({
      documentId: document.documentId,
      documentTypeCode: document.documentTypeCode,
      source: document.source,
      versionNumber: document.versionNumber,
      draftRevision: document.draftRevision,
      sections: document.sections,
    });

    return assembleTermDraftContext({
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
      etp: {
        ...chain(etp),
        estimatedTotalValue: etpHeader?.estimatedTotalValue ?? null,
        estimatedValueSource: etpHeader?.estimatedValueSource ?? null,
      },
      dfd: dfd === null ? null : chain(dfd),
      risks: risks.map((risk) => ({
        title: risk.title,
        description: risk.description,
        category: labelOf(risk.categoryId),
        phase: risk.phase,
        treatments: risk.treatments.map((treatment) => treatment.description),
      })),
      term: {
        documentId: source.documentId,
        documentTypeCode: source.documentTypeCode,
        draftRevision: source.draftRevision,
        conditions: {
          contractDurationMonths: term.contractDurationMonths,
          executionDeadline: term.executionDeadline,
          executionDeadlineType: term.executionDeadlineType,
          deliveryLocation: term.deliveryLocation,
          paymentTermDays: term.paymentTermDays,
          productWarrantyMonths: term.productWarrantyMonths,
          contractGuaranteePercent: term.contractGuaranteePercent,
          allowsSubcontracting: term.allowsSubcontracting,
          selectionCriterion: labelOf(term.selectionCriterionId),
          awardType: term.awardType,
        },
        estimatedTotalValue: term.estimatedTotalValue,
        estimatedValueSource: term.estimatedValueSource,
      },
      items: lines.map(({ item, line }) => ({
        processItemId: item.id,
        description: item.description,
        unit: units.get(item.unitOfMeasureId)?.label ?? null,
        quantity: line.quantity,
        specification: line.specification,
        acceptanceCriteria: line.acceptanceCriteria,
      })),
      priceResearch: research,
      template: source.template,
    });
  }
}
