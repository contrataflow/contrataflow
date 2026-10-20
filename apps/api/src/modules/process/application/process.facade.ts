import type {
  DayCountType,
  EstimatedValueSource,
  PcaStatus,
  Priority,
  ProcessDeadlineDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import {
  PROCESS_CLOCK,
  PROCESS_ITEM_REPOSITORY,
  PROCESS_PARTICIPANT_REPOSITORY,
  PROCESS_REPOSITORY,
} from './ports.js';
import type {
  ProcessClock,
  ProcessItemRepository,
  ProcessParticipantReference,
  ProcessParticipantRepository,
  ProcessRepository,
} from './ports.js';
import { ProcessDfdDuplication } from './process-dfd-duplication.js';
import type {
  CloneItemsForDfdInput,
  DuplicateProcessForDfdInput,
  ProcessCreatedForDfd,
} from './process-dfd-duplication.js';
import { ProcessListPresenter } from './process-list.presenter.js';
import { accessGrantsOf } from './process-runtime.loader.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import { acceptsDerivedEstimatedValue } from '../domain/derived-estimated-value.js';
import { canViewConfidentialBudget } from '../domain/process-list.js';

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';

/** O que o DFD copia do processo na criação (RN-DFD-05). */
export interface ProcessDfdDefaults {
  readonly priority: Priority;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
  /** Decimal(18,2) como string. */
  readonly estimatedValue: string | null;
  readonly estimatedValueSource: EstimatedValueSource | null;
}

/**
 * Dados do processo para o contexto da geração com IA (US-117 · RN-AI-26): ids de catálogo e de
 * unidades (os nomes vêm das fachadas donas), sem pessoas. O sigilo (DEC-030) é de quem chama.
 */
export interface ProcessAiContext {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string | null;
  readonly title: string;
  readonly object: string;
  readonly description: string | null;
  readonly contractingTypeId: string;
  readonly modalityId: string | null;
  readonly originId: string;
  readonly isPriceRegistration: boolean;
  readonly priority: Priority;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  /** `YYYY-MM-DD`. */
  readonly targetDate: string | null;
  /** Decimal(18,2) como string. */
  readonly estimatedValue: string | null;
  readonly isBudgetConfidential: boolean;
}

/** Valores de referência de uma pesquisa de preços concluída (US-032 · RN-PRICE-61/62). */
export interface PriceResearchReferenceInput {
  readonly processId: string;
  /** Documento da pesquisa (`referenceUnitPriceSourceDocumentId`). */
  readonly sourceDocumentId: string;
  /** Preço unitário de referência (Decimal(18,4) como string) por item do processo. */
  readonly unitPrices: readonly { readonly processItemId: string; readonly unitPrice: string }[];
  /** Soma dos `totalPrice` (Decimal(18,2) como string). */
  readonly estimatedValue: string;
  readonly at: Date;
  readonly userId: string;
}

export interface PriceResearchReferenceResult {
  readonly previousEstimatedValue: string | null;
  readonly previousSource: EstimatedValueSource | null;
  /** Valor e origem gravados (iguais aos anteriores quando a origem atual tem precedência). */
  readonly estimatedValue: string | null;
  readonly estimatedValueSource: EstimatedValueSource | null;
  /** `false` = o processo manteve o valor de fonte de maior precedência (TR — DEC-032). */
  readonly estimatedValueApplied: boolean;
  readonly isBudgetConfidential: boolean;
  readonly itemsUpdated: number;
  /** Nova versão do processo (o `If-Match` da edição aberta vira 412). */
  readonly processVersion: number;
}

/** A passagem ativa como o DTO `deadline` a lê (US-056: linhas da caixa de tarefas). */
export interface StageDeadlineFacts {
  readonly dueAt: Date | null;
  readonly slaType: DayCountType | null;
  readonly pausedAt: Date | null;
  /** Atraso detectado pelo job `deadlines` (US-106). */
  readonly overdueSince: Date | null;
}

/**
 * API pública do módulo `process` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-001: as leituras de nomes congelados da timeline (fontes
 * `PROCESS` e `PROCESS_STAGE` de `TIMELINE_LOOKUP_SOURCES`), no `tx` do caso de uso. US-060: POL-09
 * de um processo para a leitura da timeline.
 */
@Injectable()
export class ProcessFacade {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly workflow: WorkflowFacade,
    private readonly access: AccessFacade,
    private readonly tenancy: TenancyFacade,
    @Inject(PROCESS_PARTICIPANT_REPOSITORY)
    private readonly participants: ProcessParticipantRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    private readonly dfdDuplication: ProcessDfdDuplication,
    private readonly listPresenter: ProcessListPresenter,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
  ) {}

  /**
   * Conclusão da pesquisa de preços (US-032 · DEC-019/DEC-032 · RN-PRICE-61/62), no `tx` do
   * chamador, que já autorizou a conclusão: trava o processo, grava `referenceUnitPrice` e a origem
   * de cada item e o valor estimado com `estimatedValueSource = PRICE_RESEARCH` — salvo origem de
   * maior precedência (TR), que fica como está. A versão do processo sobe nos dois casos (os itens
   * são do agregado — RN-PROC-81). Processo inexistente no tenant = erro interno (o documento existe).
   */
  async applyPriceResearchReferenceIn(
    tx: TenantTx,
    input: PriceResearchReferenceInput,
  ): Promise<PriceResearchReferenceResult> {
    if (!(await this.processes.lockForUpdate(tx, input.processId))) {
      throw new Error('Processo da pesquisa de preços ausente ao propagar os valores.');
    }
    const rows = await this.processes.loadAggregate(tx, input.processId);
    if (rows === null) throw new Error('Processo da pesquisa de preços ausente.');
    const { process } = rows;
    const itemsUpdated = await this.items.updateReferenceUnitPrices(tx, input.processId, {
      lines: input.unitPrices.map((line) => ({
        itemId: line.processItemId,
        unitPrice: line.unitPrice,
      })),
      sourceDocumentId: input.sourceDocumentId,
      at: input.at,
      userId: input.userId,
    });
    const applied = acceptsDerivedEstimatedValue(process.estimatedValueSource, 'PRICE_RESEARCH');
    const processVersion = applied
      ? await this.processes.recordDerivedEstimatedValue(tx, input.processId, {
          estimatedValue: input.estimatedValue,
          source: 'PRICE_RESEARCH',
          at: input.at,
          userId: input.userId,
        })
      : await this.processes.touchProcess(tx, input.processId, input.at, input.userId);
    return {
      previousEstimatedValue: process.estimatedValue,
      previousSource: process.estimatedValueSource,
      estimatedValue: applied ? input.estimatedValue : process.estimatedValue,
      estimatedValueSource: applied ? 'PRICE_RESEARCH' : process.estimatedValueSource,
      estimatedValueApplied: applied,
      isBudgetConfidential: process.isBudgetConfidential,
      itemsUpdated,
      processVersion,
    };
  }

  /**
   * DTO `deadline` (US-055 · `DueDateBadge`) de cada passagem ativa informada, no `tx` do chamador
   * (US-056: linhas da caixa de tarefas) — o mesmo cálculo da lista de processos, com o atraso
   * derivado de `overdueSince`.
   */
  async stageDeadlinesIn(
    tx: TenantTx,
    stages: readonly StageDeadlineFacts[],
  ): Promise<ProcessDeadlineDto[]> {
    if (stages.length === 0) return [];
    const inputs = stages.map((stage) => ({
      dueAt: stage.dueAt,
      slaType: stage.slaType,
      isPaused: stage.pausedAt !== null,
      isOverdue: stage.overdueSince !== null,
      overdueSince: stage.overdueSince,
    }));
    const context = await this.listPresenter.loadDeadlineContext(tx);
    const deadlineOf = await this.listPresenter.deadlineCalculator(tx, inputs, context);
    return inputs.map(deadlineOf);
  }

  /**
   * Duplicação do DFD para um NOVO processo (US-018 · RN-DFD-74), no `tx` do chamador: cria o
   * processo pela mecânica da duplicação (US-011) com os itens da origem renumerados e devolve o
   * mapa item de origem → item novo. `PROCESS_CREATE` (403) e a visibilidade da origem (404) são
   * conferidos aqui; `DFD_CREATE` e a custódia, na criação do documento.
   */
  createProcessForDfdIn(
    tx: TenantTx,
    input: DuplicateProcessForDfdInput,
  ): Promise<ProcessCreatedForDfd> {
    return this.dfdDuplication.createProcessIn(tx, input);
  }

  /**
   * Duplicação do DFD para um processo EXISTENTE (US-018 · RN-DFD-75): clona no destino os itens da
   * origem indicados (a autorização do destino é de quem chama). Devolve item de origem → item novo.
   */
  cloneItemsForDfdIn(
    tx: TenantTx,
    input: CloneItemsForDfdInput,
  ): Promise<ReadonlyMap<string, string>> {
    return this.dfdDuplication.cloneItemsIn(tx, input);
  }

  /**
   * POL-09 sobre UM processo para o usuário da requisição (US-060 · RN-TML-13): a mesma regra do
   * desmascaramento por linha da lista (`canViewConfidentialBudget` — permissão
   * `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo, sem o 2º fator exigido não conta, ou
   * custódia atual). Avaliada como se o processo fosse sigiloso — o conteúdo restrito foi gravado
   * quando era, e tornar o orçamento público depois não o revela retroativamente. Processo
   * inexistente no tenant = `false` (falha fechada).
   */
  async canViewConfidentialBudget(tx: TenantTx, processId: string): Promise<boolean> {
    const rows = await this.processes.loadAggregate(tx, processId);
    if (rows === null) return false;
    const budget = await this.access.confidentialBudgetAccess();
    const settings = await this.tenancy.settingValues(tx, [HISTORICAL_SETTING]);
    const grants = accessGrantsOf(rows, settings.get(HISTORICAL_SETTING) !== false, this.clock());
    return canViewConfidentialBudget(
      { ...rows.process, isBudgetConfidential: true },
      { ...budget.scope, custodyDepartmentIds: budget.custodyDepartmentIds },
      grants.departmentIds,
    );
  }

  /**
   * Valores do processo que o DFD copia na criação (US-014 · RN-DFD-05) e o valor manual que o passo
   * Planejamento sugere (fluxo principal 9). `null` = inexistente no tenant (RLS). O mascaramento do
   * valor (POL-09) é de quem chama.
   */
  async dfdDefaultsIn(tx: TenantTx, processId: string): Promise<ProcessDfdDefaults | null> {
    const rows = await this.processes.loadAggregate(tx, processId);
    if (rows === null) return null;
    const { process } = rows;
    return {
      priority: process.priority,
      pcaStatus: process.pcaStatus,
      pcaYear: process.pcaYear,
      pcaItemCode: process.pcaItemCode,
      pcaJustification: process.pcaJustification,
      estimatedValue: process.estimatedValue,
      estimatedValueSource: process.estimatedValueSource,
    };
  }

  /**
   * Orçamento sigiloso do processo (POL-09): `true` se for sigiloso. `null` = inexistente no tenant
   * (US-018: o valor estimado do DFD só é copiado de processo sem sigilo).
   */
  async isBudgetConfidentialIn(tx: TenantTx, processId: string): Promise<boolean | null> {
    const rows = await this.processes.loadAggregate(tx, processId);
    return rows === null ? null : rows.process.isBudgetConfidential;
  }

  /** Processo para o contexto da IA (US-117), no `tx` do chamador. `null` = inexistente no tenant. */
  async aiContextIn(tx: TenantTx, processId: string): Promise<ProcessAiContext | null> {
    const rows = await this.processes.loadAggregate(tx, processId);
    if (rows === null) return null;
    const { process } = rows;
    return {
      id: process.id,
      organizationId: process.organizationId,
      code: process.code,
      title: process.title,
      object: process.object,
      description: process.description,
      contractingTypeId: process.contractingTypeId,
      modalityId: process.modalityId,
      originId: process.originId,
      isPriceRegistration: process.isPriceRegistration,
      priority: process.priority,
      pcaStatus: process.pcaStatus,
      pcaYear: process.pcaYear,
      pcaItemCode: process.pcaItemCode,
      requestingSecretariatId: process.requestingSecretariatId,
      requestingDepartmentId: process.requestingDepartmentId,
      targetDate: process.targetDate,
      estimatedValue: process.estimatedValue,
      isBudgetConfidential: process.isBudgetConfidential,
    };
  }

  /** Código (nulo em rascunho sem número) e sigilo do orçamento dos processos do tenant. */
  processReferences(
    tx: TenantTx,
    processIds: readonly string[],
  ): Promise<
    Map<string, { readonly code: string | null; readonly isBudgetConfidential: boolean }>
  > {
    return this.processes.codes(tx, processIds);
  }

  /** Nome da etapa de cada passagem (`ProcessStage`), da versão de workflow fixada no processo. */
  async stageNames(tx: TenantTx, processStageIds: readonly string[]): Promise<Map<string, string>> {
    const refs = await this.processes.stageRefs(tx, processStageIds);
    const names = new Map<string, string>();
    const byVersion = new Map<string, Map<string, string>>();
    for (const [processStageId, ref] of refs) {
      let stages = byVersion.get(ref.workflowVersionId);
      if (!stages) {
        const snapshot = await this.workflow.publishedDefinitionIn(tx, ref.workflowVersionId);
        stages = new Map((snapshot?.stages ?? []).map((stage) => [stage.id, stage.name]));
        byVersion.set(ref.workflowVersionId, stages);
      }
      const name = stages.get(ref.workflowStageId);
      if (name !== undefined) names.set(processStageId, name);
    }
    return names;
  }

  /**
   * Principal e papel dos participantes (revogados ou não — fonte `PROCESS_PARTICIPANT` da timeline,
   * US-012): o nome congelado é resolvido pela fonte, com as fachadas de `identity`/`organization`.
   */
  participantReferences(
    tx: TenantTx,
    participantIds: readonly string[],
  ): Promise<Map<string, ProcessParticipantReference>> {
    return this.participants.references(tx, participantIds);
  }
}
