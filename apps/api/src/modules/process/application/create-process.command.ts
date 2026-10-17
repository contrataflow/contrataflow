import { withSpan } from '@contrataflow/observability';
import { localDateOf } from '@contrataflow/types';
import { ProcessCreated } from '@contrataflow/validation';
import type {
  CreateProcess,
  DuplicateCandidate,
  FieldError,
  ProcessDto,
  WorkflowResolutionDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DuplicateCandidatesFinder } from './duplicate-candidates.js';
import {
  InternalCodeTakenError,
  PROCESS_CLOCK,
  PROCESS_REPOSITORY,
  PROCESS_TRANSACTIONS,
} from './ports.js';
import type { ProcessClock, ProcessRepository, ProcessTransactions } from './ports.js';
import { LONG_TEXT_FIELDS, fingerprint } from './process-audit.js';
import {
  duplicateInternalCode,
  possibleDuplicate,
  processValidationError,
  recordProcessCreated,
} from './process.errors.js';
import { ProcessPresenter, toProcessDto } from './process.presenter.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import type { CatalogItemRef } from '../../catalog/application/catalog.facade.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { WorkflowSnapshotStage } from '../../workflow/application/workflow.facade.js';
import { duplicateWindowStart } from '../domain/duplicate-detection.js';
import {
  enterStage,
  openingMovement,
  stageEntryAssignment,
} from '../domain/process-runtime-records.js';
import { ProcessValidationError, createProcess, draftProcess } from '../domain/process.js';
import type { Process, ProcessDraft, ProcessNumber } from '../domain/process.js';
import { requestingUnitIssues } from '../domain/requesting-units.js';

/** Configurações lidas na criação (US-001 · "Configurações"). */
export const CREATE_PROCESS_SETTING_KEYS = [
  'process.duplicateDetectionWindowMinutes',
  'process.requireInternalCode',
  'numbering.process.assignOn',
] as const;

export interface CreateProcessInput {
  readonly body: CreateProcess;
  /** `Idempotency-Key` da requisição (auditoria `process.create`). */
  readonly idempotencyKey: string | null;
}

export interface CreatedProcess {
  readonly process: Process;
  readonly dto: ProcessDto;
  readonly initialStageKey: string;
  readonly duplicateConfirmed: boolean;
}

interface Prepared {
  readonly now: Date;
}

/** Relógio e configurações do tenant lidos uma vez por criação (PRC-02 e PRC-27). */
export interface CreationContext {
  readonly now: Date;
  readonly settings: ReadonlyMap<string, unknown>;
  /** Hoje (`YYYY-MM-DD`) e o exercício no fuso do tenant (RN-PROC-11/12). */
  readonly today: string;
  readonly currentYear: number;
  /** `process.requireInternalCode` (RN-PROC-09). */
  readonly requireInternalCode: boolean;
}

export interface CreationOptions {
  /** `Idempotency-Key` da requisição (auditoria `process.create`). */
  readonly idempotencyKey: string | null;
  /**
   * US-011: processo de origem da duplicação — canal `DUPLICATION`, `duplicatedFromId` no agregado,
   * na auditoria e no `ProcessCreated`, e sem a heurística de duplicidade (RN-PROC-13), que
   * recusaria justamente a cópia pedida.
   */
  readonly duplicatedFromId?: string | null;
  /** Mensagem do 403 quando o `PROCESS_CREATE` não cobre o setor solicitante. */
  readonly permissionDetail?: string;
}

/** Campos não sensíveis registrados com o valor inicial (`process.create` · `changes`). */
const AUDITED_FIELDS = [
  'organizationId',
  'contractingTypeId',
  'modalityId',
  'isPriceRegistration',
  'requestingSecretariatId',
  'requestingDepartmentId',
  'priority',
  'targetDate',
  'originId',
  'pcaStatus',
  'pcaYear',
  'pcaItemCode',
  'internalCode',
] as const satisfies readonly (keyof Process)[];

function creationChanges(process: Process): AuditChange[] {
  const changes: AuditChange[] = AUDITED_FIELDS.filter((field) => process[field] !== null).map(
    (field) => ({ path: field, old: null, new: process[field] }),
  );
  for (const field of LONG_TEXT_FIELDS) {
    const value = process[field];
    if (value !== null) changes.push({ path: field, old: null, new: fingerprint(value) });
  }
  return changes;
}

/** Erros de campo de um `ApiError` 422 (`assertActive`), para juntar com os demais. */
function fieldErrorsOf(error: unknown): readonly FieldError[] {
  if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') return error.errors;
  throw error;
}

/**
 * `CreateProcessCommand` — PRC-02 (US-001 · fluxo principal, passo 7): o padrão de comando
 * transacional (`TransactionalCommandHandler`). Numa transação do tenant: regras do corpo
 * (RN-PROC-01..12), referências (catálogos ativos — RN-PROC-16; órgão e unidades ativas do mesmo
 * órgão, setor na subárvore da secretaria — RN-PROC-02), escopo do `PROCESS_CREATE` sobre o setor
 * (RN-PROC-03), código interno único (RN-PROC-09), heurística de duplicidade (RN-PROC-13), workflow
 * aplicável e etapa inicial (RN-PROC-06/07), prazo da etapa em dias úteis, número (RN-PROC-04/05,
 * por último: a linha da sequência fica travada só pelas gravações) e, então, processo + passagem
 * nº 1 + responsabilidade + tramitação `CREATE`, `process.create` e `ProcessCreated` (que projeta
 * timeline e `ProcessAccess` no mesmo `tx`). Qualquer falha desfaz tudo, inclusive o número
 * (RN-PROC-15). Sem notificação (RN-PROC-17).
 */
@Injectable()
export class CreateProcessCommand extends TransactionalCommandHandler<
  CreateProcessInput,
  Prepared,
  CreatedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly catalog: CatalogFacade,
    private readonly numbering: NumberingFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
    private readonly workflow: WorkflowFacade,
    private readonly presenter: ProcessPresenter,
    private readonly duplicates: DuplicateCandidatesFinder,
  ) {
    super('process.create', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: CreateProcessInput,
    { now }: Prepared,
  ): Promise<CreatedProcess> {
    const context = await this.creationContext(tx, now);

    // 7.1 — regras do corpo (RN-PROC-01..12).
    let draft: ProcessDraft;
    try {
      draft = draftProcess(input.body, context);
    } catch (error) {
      if (error instanceof ProcessValidationError) throw processValidationError(error.issues);
      throw error;
    }
    return this.createIn(tx, draft, context, { idempotencyKey: input.idempotencyKey });
  }

  /** Configurações e relógio do tenant para montar e validar o rascunho (`draftIssues`). */
  async creationContext(tx: TenantTx, now: Date): Promise<CreationContext> {
    const settings = await this.tenancy.settingValues(tx, CREATE_PROCESS_SETTING_KEYS);
    const { timezone } = await this.numbering.settingsOf(tx);
    const today = localDateOf(now, timezone);
    return {
      now,
      settings,
      today,
      currentYear: Number(today.slice(0, 4)),
      requireInternalCode: settings.get('process.requireInternalCode') === true,
    };
  }

  /**
   * Passos 7.1 (referências) a 7.11 sobre um rascunho já validado, no `tx` de quem chama: o PRC-02
   * e a duplicação (US-011 · RN-PROC-122 — mesmas regras de numeração, workflow e concessões,
   * independentes da origem).
   */
  async createIn(
    tx: TenantTx,
    draft: ProcessDraft,
    { now, settings, currentYear }: CreationContext,
    options: CreationOptions,
  ): Promise<CreatedProcess> {
    const context = requireRequestContext();
    const userId = context.actor.userId ?? '';
    const duplicatedFromId = options.duplicatedFromId ?? null;

    // 7.1 — referências do tenant (inexistente = de outro tenant, sem distinguir).
    const references = await this.references(tx, draft);

    // 7.2 — escopo do PROCESS_CREATE sobre o setor solicitante (RN-PROC-03 · V-06).
    await this.access.assertCanInDepartment(
      'PROCESS_CREATE',
      { id: draft.requestingDepartmentId, organizationId: references.organizationId },
      {
        mfaPolicy: await this.identity.mfaPolicy(),
        ...(options.permissionDetail === undefined ? {} : { detail: options.permissionDetail }),
      },
    );

    // 7.3 — código interno único e possível duplicidade.
    if (
      draft.internalCode !== null &&
      (await this.processes.internalCodeExists(tx, draft.internalCode))
    ) {
      throw duplicateInternalCode(draft.internalCode);
    }
    if (duplicatedFromId === null) await this.checkDuplicates(tx, draft, userId, now, settings);

    // 7.4 — workflow aplicável e etapa inicial (versão fixada — RN-PROC-06).
    const resolution = await withSpan('process.resolve_workflow', {}, () =>
      this.workflow.resolveApplicable(tx, {
        contractingTypeCode: references.contractingType.code,
        modalityCode: references.modality?.code ?? null,
        originCode: references.origin.code,
        estimatedValue: draft.estimatedValue === null ? null : Number(draft.estimatedValue),
        isPriceRegistration: draft.isPriceRegistration,
        organizationId: references.organizationId,
      }),
    );
    const stage = await this.initialStage(tx, resolution);
    const position = await this.position(tx, stage, draft, userId, now);

    const ids = { process: newId(), stage: newId(), assignment: newId(), movement: newId() };
    const lookups = await this.presenter.lookups(tx, {
      organizationId: references.organizationId,
      requestingSecretariatId: draft.requestingSecretariatId,
      requestingDepartmentId: draft.requestingDepartmentId,
      currentDepartmentId: position.departmentId,
      contractingTypeId: draft.contractingTypeId,
      modalityId: draft.modalityId,
      originId: draft.originId,
      workflowVersionId: resolution.workflowVersionId,
      currentWorkflowStageId: stage.id,
      createdById: userId,
      currentResponsibleId: position.assigneeId,
    });

    // 7.5 — número (RN-PROC-04/05 · FA-03): por último antes das gravações.
    const numbering: ProcessNumber | null =
      settings.get('numbering.process.assignOn') === 'START'
        ? null
        : await this.numbering.assignProcessNumber(tx, {
            organizationId: references.organizationId,
          });

    // 7.6–7.9 — agregado, passagem nº 1, responsabilidade e tramitação `CREATE`.
    const process = createProcess(draft, {
      id: ids.process,
      tenantId: context.tenantId ?? '',
      organizationId: references.organizationId,
      now,
      createdById: userId,
      currentYear,
      numbering,
      workflowVersionId: resolution.workflowVersionId,
      creationChannel: duplicatedFromId === null ? 'WEB' : 'DUPLICATION',
      duplicatedFromId,
      initialStage: {
        processStageId: ids.stage,
        workflowStageId: stage.id,
        departmentId: position.departmentId,
        assigneeId: position.assigneeId,
        dueAt: position.dueAt,
      },
    });
    const stageRecord = enterStage({
      id: ids.stage,
      tenantId: process.tenantId,
      processId: process.id,
      workflowStageId: stage.id,
      sequence: 1,
      departmentId: position.departmentId,
      assigneeId: position.assigneeId,
      enteredAt: now,
      dueAt: position.dueAt,
      slaDays: stage.slaDays,
      slaType: stage.slaType,
      movementId: ids.movement,
    });
    try {
      await this.processes.insertCreation(tx, {
        process,
        stage: stageRecord,
        assignment: stageEntryAssignment(ids.assignment, stageRecord),
        movement: openingMovement({
          id: ids.movement,
          stage: stageRecord,
          actorId: userId,
          ip: context.ip,
          userAgent: context.userAgent === '' ? null : context.userAgent,
          correlationId: context.correlationId,
          channel: process.creationChannel,
        }),
      });
    } catch (error) {
      // Corrida com outra criação do mesmo código interno: o índice único decide (V-10).
      if (error instanceof InternalCodeTakenError) throw duplicateInternalCode(error.internalCode);
      throw error;
    }

    // 7.11 — auditoria e evento (timeline e ProcessAccess projetados no mesmo tx — 7.10).
    await this.audit.record(tx, {
      action: 'process.create',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: creationChanges(process),
      metadata: {
        code: process.code,
        workflowVersionId: process.workflowVersionId,
        initialStageKey: stage.key,
        idempotencyKey: options.idempotencyKey,
        duplicateConfirmed: draft.confirmDuplicate,
        ...(duplicatedFromId === null ? {} : { duplicatedFromId }),
      },
    });
    await this.outbox.record(
      tx,
      ProcessCreated.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          code: process.code,
          number: process.number,
          year: process.year,
          title: process.title,
          organizationId: process.organizationId,
          requestingSecretariatId: process.requestingSecretariatId,
          requestingDepartmentId: process.requestingDepartmentId,
          contractingTypeCode: references.contractingType.code,
          modalityCode: references.modality?.code ?? null,
          priority: process.priority,
          workflowId: resolution.workflowId,
          workflowVersionId: process.workflowVersionId,
          initialStageKey: stage.key,
          initialDepartmentId: process.currentDepartmentId,
          initialResponsibleId: process.currentResponsibleId,
          creationChannel: process.creationChannel,
          duplicatedFromId: process.duplicatedFromId,
        },
      }),
    );

    return {
      process,
      dto: toProcessDto(process, lookups),
      initialStageKey: stage.key,
      duplicateConfirmed: draft.confirmDuplicate,
    };
  }

  protected override committed(result: CreatedProcess, durationMs: number): void {
    const context = requireRequestContext();
    recordProcessCreated(result.process.creationChannel, durationMs);
    // Nunca logar título, objeto, descrição, observações, justificativas nem valores (story · Logs).
    this.logger.log(
      {
        event: 'process.created',
        processId: result.process.id,
        code: result.process.code,
        workflowVersionId: result.process.workflowVersionId,
        initialStageKey: result.initialStageKey,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'process.created',
    );
  }

  /** Órgão, catálogos e unidades do corpo (V-03/V-04/V-05), com TODOS os erros de uma vez. */
  private async references(
    tx: TenantTx,
    draft: ProcessDraft,
  ): Promise<{
    readonly organizationId: string;
    readonly contractingType: CatalogItemRef;
    readonly modality: CatalogItemRef | null;
    readonly origin: CatalogItemRef;
  }> {
    const errors: FieldError[] = [];
    const organizationId =
      draft.organizationId ?? (await this.tenancy.primaryOrganizationId(tx)) ?? '';
    const organization =
      organizationId === '' ? null : await this.tenancy.organizationSummary(tx, organizationId);
    if (!organization?.isActive) {
      errors.push({
        field: 'organizationId',
        code: organization === null ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_INACTIVE',
        message: 'Selecione um órgão válido.',
      });
    }
    const check = async (
      run: () => Promise<CatalogItemRef>,
    ): Promise<CatalogItemRef | undefined> => {
      try {
        return await run();
      } catch (error) {
        errors.push(...fieldErrorsOf(error));
        return undefined;
      }
    };
    const contractingType = await check(() =>
      this.catalog.assertActive(
        tx,
        'CONTRACTING_TYPE',
        draft.contractingTypeId,
        'contractingTypeId',
      ),
    );
    const modality =
      draft.modalityId === null
        ? null
        : await check(() =>
            this.catalog.assertActive(tx, 'MODALITY', draft.modalityId ?? '', 'modalityId'),
          );
    const origin = await check(() =>
      this.catalog.assertActive(tx, 'PROCESS_ORIGIN', draft.originId, 'originId'),
    );
    // Sem órgão válido não há contra o que conferir as unidades (o erro já está no `organizationId`).
    if (organization !== null) {
      const units = await this.organization.departmentReferences(tx, [
        draft.requestingSecretariatId,
        draft.requestingDepartmentId,
      ]);
      errors.push(
        ...requestingUnitIssues({
          organizationId,
          secretariat: units.get(draft.requestingSecretariatId),
          department: units.get(draft.requestingDepartmentId),
        }),
      );
    }
    if (errors.length > 0 || !contractingType || !origin || modality === undefined) {
      throw validationError(errors);
    }
    return { organizationId, contractingType, modality, origin };
  }

  /** RN-PROC-13 · FA-02: recusa (409) até a confirmação explícita; a confirmação é auditada. */
  private async checkDuplicates(
    tx: TenantTx,
    draft: ProcessDraft,
    userId: string,
    now: Date,
    settings: ReadonlyMap<string, unknown>,
  ): Promise<void> {
    const windowMinutes = settings.get('process.duplicateDetectionWindowMinutes');
    const since = duplicateWindowStart(now, typeof windowMinutes === 'number' ? windowMinutes : 0);
    if (since === null) return;
    const candidates: DuplicateCandidate[] = await this.duplicates.find(tx, {
      title: draft.title,
      object: draft.object,
      requestingDepartmentId: draft.requestingDepartmentId,
      createdById: userId,
      since,
    });
    if (candidates.length === 0) return;
    this.logger.log(
      {
        event: 'process.duplicate_warning',
        candidates: candidates.length,
        confirmed: draft.confirmDuplicate,
        correlationId: requireRequestContext().correlationId,
      },
      'process.duplicate_warning',
    );
    if (!draft.confirmDuplicate) throw possibleDuplicate(candidates);
  }

  /** Etapa inicial da versão publicada fixada (`WorkflowVersion.initialStageId` — RN-PROC-07). */
  private async initialStage(
    tx: TenantTx,
    resolution: WorkflowResolutionDto,
  ): Promise<WorkflowSnapshotStage> {
    const snapshot = await this.workflow.publishedDefinitionIn(tx, resolution.workflowVersionId);
    const stage = snapshot?.stages.find((candidate) => candidate.id === resolution.initialStage.id);
    if (!stage) {
      throw new Error(
        `Etapa inicial ${resolution.initialStage.id} ausente da versão ${resolution.workflowVersionId}.`,
      );
    }
    return stage;
  }

  /**
   * RN-PROC-07 · RN-WF-30/31: unidade (`departmentResolution` — no padrão, o setor solicitante) e
   * responsável (`assignmentPolicy` — no padrão, o criador) da etapa inicial e o prazo do SLA em
   * dias úteis do tenant (US-106).
   */
  private async position(
    tx: TenantTx,
    stage: WorkflowSnapshotStage,
    draft: ProcessDraft,
    creatorId: string,
    now: Date,
  ): Promise<{ departmentId: string; assigneeId: string | null; dueAt: Date | null }> {
    const resolved = this.workflow.resolveStageDepartment(stage, draft);
    // `CHOSEN_ON_FORWARD` não se aplica à abertura (não há encaminhamento): fica no setor solicitante.
    const departmentId = resolved.departmentId ?? draft.requestingDepartmentId;
    const head =
      stage.assignmentPolicy === 'DEPARTMENT_HEAD'
        ? ((await this.organization.departmentReferences(tx, [departmentId])).get(departmentId)
            ?.headUserId ?? null)
        : null;
    const assigneeId = this.workflow.resolveStageAssignee(stage, {
      creatorId,
      departmentHeadId: head,
      passes: [],
    });
    const dueAt =
      stage.slaDays === null
        ? null
        : await this.calendar.addBusinessDays(tx, now, stage.slaDays, stage.slaType);
    return { departmentId, assigneeId, dueAt };
  }
}
