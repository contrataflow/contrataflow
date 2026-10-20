import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';
import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';

import { AiPolicyRevokedError } from './ai-generator.js';
import type {
  AiGenerator,
  AiGeneratorCheck,
  AiGeneratorContext,
  AiGeneratorRequest,
} from './ai-generator.js';
import { needSummaryRequired } from './ai.errors.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { DfdFacade } from '../../dfd/application/dfd.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import { assembleDfdDraftContext, dfdDraftRequestProblem } from '../domain/dfd-draft-context.js';
import { DFD_DRAFT_PROMPT } from '../prompts/draft.dfd/prompt.js';

/*
 * `DfdDraftGenerator` — `DFD`/`DRAFT` (US-117 · RN-AI-25..27): o rascunho completo das seções
 * narrativas do DFD. No pedido (`DfdDraftRequestPolicy`), o resumo e o documento; no job, o
 * contexto pelas FACHADAS DE LEITURA de `document`, `dfd`, `process`, `catalog`, `organization` e
 * `tenancy` (regra D9), na transação do tenant (RLS), montado por `assembleDfdDraftContext`. A
 * POL-02 e o status do DFD já foram conferidos pelo pipeline (`DocumentFacade.aiTargetIn`).
 */

/** Reserva de tokens do rascunho do DFD (RN-AI-18): contexto pequeno. */
const DFD_DRAFT_RESERVED_TOKENS = 15_000;
const DFD_DRAFT_MAX_OUTPUT_TOKENS = 6_000;

@Injectable()
export class DfdDraftGenerator implements AiGenerator {
  readonly targetModule = 'DFD' as const;
  readonly kind = 'DRAFT' as const;
  readonly prompt = DFD_DRAFT_PROMPT;
  readonly reservedTokens = DFD_DRAFT_RESERVED_TOKENS;
  readonly needSummary = 'REQUIRED' as const;
  readonly maxOutputTokens = DFD_DRAFT_MAX_OUTPUT_TOKENS;

  constructor(
    private readonly documents: DocumentFacade,
    private readonly dfds: DfdFacade,
    private readonly processes: ProcessFacade,
    private readonly catalog: CatalogFacade,
    private readonly departments: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
    private readonly processItems: ProcessItemCatalogRegistry,
  ) {}

  /** `DfdDraftRequestPolicy` (RN-AI-25 · V-01/V-02): o status e a etapa são do `aiTargetIn`. */
  validateRequest(_tx: TenantTx, request: AiGeneratorRequest): Promise<AiGeneratorCheck> {
    const problem = dfdDraftRequestProblem(request);
    if (problem === 'DOCUMENT_REQUIRED') {
      return Promise.reject(
        validationError([
          {
            field: 'documentId',
            code: 'CONDITIONAL_REQUIRED',
            message: 'Informe o DFD a gerar.',
          },
        ]),
      );
    }
    if (problem !== null) return Promise.reject(needSummaryRequired());
    return Promise.resolve({ baseRevision: null });
  }

  async buildContext(tx: TenantTx, generation: AiGeneration): Promise<AiGeneratorContext> {
    const documentId = generation.documentId;
    if (documentId === null) throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    // Leituras em sequência: uma transação interativa não executa consultas em paralelo.
    const source = await this.documents.aiDraftSourceIn(tx, documentId);
    const header = await this.dfds.aiDraftHeaderIn(tx, documentId);
    const process = await this.processes.aiContextIn(tx, generation.processId);
    if (source === null || header === null || process === null) {
      throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    }

    const catalogIds = [process.contractingTypeId, process.modalityId, process.originId].filter(
      (id): id is string => id !== null,
    );
    const catalogItems: Awaited<ReturnType<CatalogFacade['find']>>[] = [];
    for (const id of catalogIds) catalogItems.push(await this.catalog.find(tx, id));
    const departmentNames = await this.departments.departmentNames(tx, [
      process.requestingSecretariatId,
      process.requestingDepartmentId,
    ]);
    const organization = await this.tenancy.organizationAiProfile(tx, process.organizationId);
    const processItems = await this.processItems.listActive(tx, process.id);
    const labelOf = (id: string | null) =>
      id === null ? null : (catalogItems.find((item) => item?.id === id)?.label ?? null);
    const byId = new Map(processItems.map((item) => [item.id, item]));
    const lines = source.items.flatMap((line) => {
      const item = byId.get(line.processItemId);
      return item === undefined ? [] : [{ item, quantity: line.quantity }];
    });
    const units = await this.catalog.unitsOf(
      tx,
      lines.map(({ item }) => item.unitOfMeasureId),
    );

    return assembleDfdDraftContext({
      process: {
        id: process.id,
        code: process.code,
        title: process.title,
        object: process.object,
        description: process.description,
        contractingType: labelOf(process.contractingTypeId),
        modality: labelOf(process.modalityId),
        origin: labelOf(process.originId),
        isPriceRegistration: process.isPriceRegistration,
        priority: process.priority,
        requestingSecretariat: departmentNames.get(process.requestingSecretariatId) ?? null,
        requestingDepartment: departmentNames.get(process.requestingDepartmentId) ?? null,
        targetDate: process.targetDate,
        estimatedValue: process.estimatedValue,
        isBudgetConfidential: process.isBudgetConfidential,
      },
      items: lines.map(({ item, quantity }) => ({
        description: item.description,
        unit: units.get(item.unitOfMeasureId)?.label ?? null,
        quantity,
      })),
      dfd: {
        documentId: source.documentId,
        documentTypeCode: source.documentTypeCode,
        draftRevision: source.draftRevision,
        objectSummary: header.objectSummary,
        priority: header.priority,
        requestDate: header.requestDate,
        expectedDate: header.expectedDate,
        estimatedValue: header.estimatedValue,
        pcaStatus: header.pcaStatus,
        pcaYear: header.pcaYear,
        pcaItemCode: header.pcaItemCode,
      },
      organization,
      template: source.template,
    });
  }
}
