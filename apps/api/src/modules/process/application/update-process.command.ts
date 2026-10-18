import { localDateOf } from '@contrataflow/types';
import { ProcessUpdated } from '@contrataflow/validation';
import type {
  FieldError,
  ProcessConflictCurrent,
  ProcessDto,
  UpdateProcess,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  InternalCodeTakenError,
  PROCESS_CLOCK,
  PROCESS_REPOSITORY,
  PROCESS_TRANSACTIONS,
} from './ports.js';
import type {
  ProcessAggregateRows,
  ProcessClock,
  ProcessRepository,
  ProcessTransactions,
} from './ports.js';
import { auditedValue } from './process-audit.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import {
  duplicateInternalCode,
  estimatedValueFromSource,
  notProcessCustodian,
  processNotEditable,
  processNotFoundError,
  processValidationError,
  processVersionConflict,
  recordProcessUpdateConflict,
  recordProcessUpdated,
} from './process.errors.js';
import { ProcessPresenter } from './process.presenter.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import {
  applyProcessChanges,
  diffProcess,
  estimatedValueLockedBy,
  isEditableStatus,
  isProcessCustodian,
  lockIssues,
  numberingDependsOnOrganization,
  revalidationIssues,
} from '../domain/process-update.js';
import type { ProcessChangeSet } from '../domain/process-update.js';
import { requestingUnitIssues } from '../domain/requesting-units.js';

const REQUIRE_INTERNAL_CODE = 'process.requireInternalCode';
const REQUESTING_FIELDS = new Set(['requestingSecretariatId', 'requestingDepartmentId']);

export interface UpdateProcessInput {
  readonly processId: string;
  readonly patch: UpdateProcess;
  /** `If-Match` (a versão que o painel leu — RN-PROC-66; o 428 é do guard). */
  readonly expectedVersion: number;
}

export interface UpdatedProcess {
  readonly dto: ProcessDto;
  /** Campos alterados (vazio = PATCH sem diferença efetiva — RN-PROC-67). */
  readonly changedFields: readonly string[];
}

interface Prepared {
  readonly now: Date;
}

/** Erros de campo de um `ApiError` 422 (`assertActive`), para juntar com os demais. */
function fieldErrorsOf(error: unknown): readonly FieldError[] {
  if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') return error.errors;
  throw error;
}

/**
 * `UpdateProcessCommand` — PRC-05 (US-005 · fluxo principal, passo 5): o padrão
 * `TransactionalCommandHandler`. Numa transação do tenant, com `SELECT … FOR UPDATE` no processo
 * (serializa a edição com tramitações e com a derivação do valor estimado — DEC-055): visibilidade
 * (404) → diferença efetiva (RN-PROC-67: sem diferença, 200 sem nova versão) → `If-Match`
 * (RN-PROC-66) → `PROCESS_UPDATE` cobrindo o processo, status editável e custódia (RN-PROC-59 ·
 * POL-01) → bloqueio por status (RN-PROC-60/61) → valor estimado (RN-PROC-63) → revalidação parcial
 * (RN-PROC-64) → referências alteradas (RN-PROC-16/02) e escopo do `PROCESS_CREATE` no novo setor
 * (RN-PROC-62) → código interno (RN-PROC-70) → gravação (`version + 1`), `process.update` com o diff
 * e `ProcessUpdated` (timeline e `ProcessAccess` projetados no mesmo `tx` — RN-PROC-68). A versão do
 * workflow nunca muda (RN-PROC-69 · DEC-014).
 */
@Injectable()
export class UpdateProcessCommand extends TransactionalCommandHandler<
  UpdateProcessInput,
  Prepared,
  UpdatedProcess
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
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
    private readonly panel: ProcessPanelReader,
    private readonly presenter: ProcessPresenter,
  ) {
    super('process.update', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: UpdateProcessInput,
    { now }: Prepared,
  ): Promise<UpdatedProcess> {
    const context = requireRequestContext();
    const userId = context.actor.userId ?? '';

    // 5 — trava o processo antes de ler: o estado lido é o do vencedor de qualquer corrida.
    if (!(await this.processes.lockForUpdate(tx, input.processId))) throw processNotFoundError();
    const { rows, runtime, viewer } = await this.panel.load(tx, input.processId);
    const process = rows.process;
    const canSeeBudget = await this.panel.canSeeBudget(rows, runtime);

    // 5.1 — diferença efetiva (RN-PROC-67): sem diferença, o recurso atual, sem nova versão.
    const changes = diffProcess(process, input.patch);
    if (changes.changes.length === 0) {
      this.logger.log(
        {
          event: 'process.update_noop',
          processId: process.id,
          version: process.version,
          correlationId: context.correlationId,
        },
        'process.update_noop',
      );
      return {
        dto: await this.presenter.present(tx, process, canSeeBudget),
        changedFields: [],
      };
    }

    // 5.2 — concorrência otimista (RN-PROC-66 · FA-05).
    if (input.expectedVersion !== process.version) {
      throw await this.conflict(tx, rows, input.expectedVersion, canSeeBudget);
    }

    // 5.3 — permissão no escopo do processo, status editável e custódia (RN-PROC-59 · POL-01).
    await this.access.assertCanOnProcess('PROCESS_UPDATE', accessTargetOf(runtime));
    if (!isEditableStatus(process.status)) throw processNotEditable(process.status);
    if (!isProcessCustodian(process, viewer.engine)) throw notProcessCustodian();

    // 5.4 — bloqueio por status, valor estimado, revalidação parcial e referências alteradas.
    const settings = await this.numbering.settingsOf(tx);
    const locked = lockIssues(changes, {
      status: process.status,
      numbered: process.code !== null,
      numberingDependsOnOrganization: numberingDependsOnOrganization(settings),
    });
    if (locked.length > 0) throw processValidationError(locked);
    const source = estimatedValueLockedBy(process, changes);
    if (source !== null) throw estimatedValueFromSource(source);
    const today = localDateOf(now, settings.timezone);
    const requireInternalCode =
      (await this.tenancy.settingValues(tx, [REQUIRE_INTERNAL_CODE])).get(REQUIRE_INTERNAL_CODE) ===
      true;
    const issues = revalidationIssues(changes, {
      today,
      currentYear: Number(today.slice(0, 4)),
      requireInternalCode,
    });
    if (issues.length > 0) throw processValidationError(issues);
    await this.assertReferences(tx, changes);

    // RN-PROC-62 · V-06: o novo setor solicitante precisa estar no escopo do PROCESS_CREATE.
    const changed = new Set<string>(changes.changes.map((change) => change.field));
    const requestingChanged = [...changed].some((field) => REQUESTING_FIELDS.has(field));
    if (requestingChanged) {
      await this.access.assertCanInDepartment(
        'PROCESS_CREATE',
        { id: changes.next.requestingDepartmentId, organizationId: changes.next.organizationId },
        { mfaPolicy: await this.identity.mfaPolicy() },
      );
    }

    // RN-PROC-70 · V-11: código interno único no tenant (o índice único decide a corrida).
    const internalCode = changes.next.internalCode;
    if (
      changed.has('internalCode') &&
      internalCode !== null &&
      (await this.processes.internalCodeExists(tx, internalCode, process.id))
    ) {
      throw duplicateInternalCode(internalCode);
    }

    // 5.6 — grava (`version + 1`); a trava garante a versão, o `WHERE version` é a rede.
    const updated = applyProcessChanges(process, changes, { now, userId });
    try {
      if (!(await this.processes.updateProcess(tx, updated, process.version))) {
        throw await this.conflict(tx, rows, input.expectedVersion, canSeeBudget);
      }
    } catch (error) {
      if (error instanceof InternalCodeTakenError) throw duplicateInternalCode(error.internalCode);
      throw error;
    }

    // 5.7 — auditoria com o diff e evento (timeline e ProcessAccess projetados no mesmo tx).
    const changedFields = changes.changes.map((change) => change.field);
    await this.audit.record(tx, {
      action: 'process.update',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: changes.changes.map((change) => ({
        path: change.field,
        old: auditedValue(change.field, change.old),
        new: auditedValue(change.field, change.new),
      })),
      metadata: {
        processCode: process.code,
        version: updated.version,
        requestingAccessChanged: requestingChanged,
      },
    });
    await this.outbox.record(
      tx,
      ProcessUpdated.of({
        aggregateId: process.id,
        processId: process.id,
        payload: { changedFields, version: updated.version },
      }),
    );

    return { dto: await this.presenter.present(tx, updated, canSeeBudget), changedFields };
  }

  protected override committed(result: UpdatedProcess, durationMs: number): void {
    if (result.changedFields.length === 0) return;
    const context = requireRequestContext();
    recordProcessUpdated(durationMs);
    // Nunca logar título, objeto, descrição, observações, justificativas nem valores (story · Logs).
    this.logger.log(
      {
        event: 'process.updated',
        processId: result.dto.id,
        changedFields: result.changedFields,
        version: result.dto.version,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'process.updated',
    );
  }

  /** 412 com a versão atual e `meta.current` (o processo atual e quem o alterou por último). */
  private async conflict(
    tx: TenantTx,
    rows: ProcessAggregateRows,
    sentVersion: number,
    canSeeBudget: boolean,
  ): Promise<ApiError> {
    const process = rows.process;
    const dto = await this.presenter.present(tx, process, canSeeBudget);
    const updatedBy =
      process.updatedById === null
        ? null
        : {
            id: process.updatedById,
            name:
              (await this.identity.userDisplayNames(tx, [process.updatedById])).get(
                process.updatedById,
              ) ?? process.updatedById,
          };
    const current: ProcessConflictCurrent = { ...dto, updatedBy };
    recordProcessUpdateConflict();
    this.logger.warn(
      {
        event: 'process.update_conflict',
        processId: process.id,
        sentVersion,
        currentVersion: process.version,
        correlationId: requireRequestContext().correlationId,
      },
      'process.update_conflict',
    );
    return processVersionConflict(sentVersion, current);
  }

  /**
   * V-04/V-05 (RN-PROC-16/02 · RN-PROC-64): só as referências ALTERADAS — catálogos ativos e do tipo
   * certo; órgão ativo; secretaria e setor ativos, do mesmo órgão e na subárvore. Todos os erros de
   * uma vez; referência de outro tenant = inexistente.
   */
  private async assertReferences(tx: TenantTx, changes: ProcessChangeSet): Promise<void> {
    const changed = new Set<string>(changes.changes.map((change) => change.field));
    const { next } = changes;
    const errors: FieldError[] = [];
    const check = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        errors.push(...fieldErrorsOf(error));
      }
    };
    if (changed.has('contractingTypeId')) {
      await check(() =>
        this.catalog.assertActive(
          tx,
          'CONTRACTING_TYPE',
          next.contractingTypeId,
          'contractingTypeId',
        ),
      );
    }
    if (changed.has('modalityId') && next.modalityId !== null) {
      const modalityId = next.modalityId;
      await check(() => this.catalog.assertActive(tx, 'MODALITY', modalityId, 'modalityId'));
    }
    if (changed.has('originId')) {
      await check(() => this.catalog.assertActive(tx, 'PROCESS_ORIGIN', next.originId, 'originId'));
    }
    let organizationValid = true;
    if (changed.has('organizationId')) {
      const organization = await this.tenancy.organizationSummary(tx, next.organizationId);
      if (!organization?.isActive) {
        organizationValid = false;
        errors.push({
          field: 'organizationId',
          code: organization === null ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_INACTIVE',
          message: 'Selecione um órgão válido.',
        });
      }
    }
    if (
      organizationValid &&
      (changed.has('organizationId') ||
        changed.has('requestingSecretariatId') ||
        changed.has('requestingDepartmentId'))
    ) {
      const units = await this.organization.departmentReferences(tx, [
        next.requestingSecretariatId,
        next.requestingDepartmentId,
      ]);
      errors.push(
        ...requestingUnitIssues({
          organizationId: next.organizationId,
          secretariat: units.get(next.requestingSecretariatId),
          department: units.get(next.requestingDepartmentId),
        }),
      );
    }
    if (errors.length > 0) throw validationError(errors);
  }
}

/** O processo como a autorização o vê (escopo e participações — US-097). */
export function accessTargetOf(runtime: ProcessRuntime) {
  return {
    processId: runtime.id,
    organizationId: runtime.organizationId ?? null,
    departmentIds: runtime.access.departmentIds,
    userIds: runtime.access.userIds,
    participations: runtime.access.participations ?? [],
  };
}
