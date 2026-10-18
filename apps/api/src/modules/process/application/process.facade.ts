import type { EstimatedValueSource, PcaStatus, Priority } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { PROCESS_CLOCK, PROCESS_PARTICIPANT_REPOSITORY, PROCESS_REPOSITORY } from './ports.js';
import type {
  ProcessClock,
  ProcessParticipantReference,
  ProcessParticipantRepository,
  ProcessRepository,
} from './ports.js';
import { accessGrantsOf } from './process-runtime.loader.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
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
  ) {}

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
