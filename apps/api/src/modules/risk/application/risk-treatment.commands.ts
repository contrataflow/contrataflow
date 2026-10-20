import type {
  CreateRiskTreatment,
  RiskTreatmentDto,
  TreatmentType,
  UpdateRiskTreatment,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { RISK_CLOCK, RISK_REPOSITORY, RISK_TRANSACTIONS } from './ports.js';
import type { RiskClock, RiskRepository, RiskTransactions } from './ports.js';
import { logContext, RiskCommand, userIdOf } from './risk.commands.js';
import type { Prepared } from './risk.commands.js';
import {
  countTreatmentChanged,
  invalidTreatmentTransition,
  treatmentNotFound,
  treatmentVersionConflict,
} from './risk.errors.js';
import { RiskChangeRecorder, RiskGate, RiskPresenter, RiskReferences } from './risk.support.js';
import {
  createRiskTreatment,
  diffRiskTreatment,
  nextTreatmentSortOrder,
  patchRiskTreatment,
  touchRiskTreatment,
} from '../domain/risk-treatment.js';
import type { RiskTreatment, TreatmentStatusChange } from '../domain/risk-treatment.js';
import { startTreatment } from '../domain/risk.js';

/*
 * Comandos das ações de tratamento (US-034 · RSK-06..08), no mesmo padrão dos riscos: numa transação
 * do tenant, a guarda (RN-RISK-16 = POL-02 estendida, com o `RISK_MAP` travado e as mensagens dos
 * tratamentos) → `If-Match` → referências (V-03) → domínio puro (RN-RISK-11..15) → gravação → a
 * transição automática do risco (RN-RISK-14) → auditoria `risk.treatment_*` e `RiskTreatmentChanged`
 * (sem timeline). Logs de negócio só depois do commit e nunca com descrição nem observações.
 */

/** 412 se o `If-Match` não é a versão do tratamento. */
function assertVersion(treatment: RiskTreatment, expectedVersion: number): void {
  if (treatment.version !== expectedVersion) throw treatmentVersionConflict(treatment.version);
}

/** Corrida com outra transação na gravação vira 412 com a versão vencedora. */
async function conflictToVersion(
  risks: RiskRepository,
  tx: TenantTx,
  treatment: RiskTreatment,
  error: unknown,
): Promise<never> {
  if (error instanceof VersionConflictError) {
    const latest = await risks.findTreatment(tx, treatment.id);
    if (latest === null) throw treatmentNotFound();
    throw treatmentVersionConflict(latest.version);
  }
  throw error;
}

export interface CreateRiskTreatmentInput {
  readonly riskId: string;
  readonly body: CreateRiskTreatment;
}

export interface CreateRiskTreatmentResult {
  readonly dto: RiskTreatmentDto;
  readonly type: TreatmentType;
  /** O risco passou de `OPEN` a `IN_TREATMENT` (RN-RISK-14). */
  readonly riskStarted: boolean;
}

/** `CreateRiskTreatmentHandler` — RSK-06 (fluxo principal, passos 3–5). */
@Injectable()
export class CreateRiskTreatmentCommand extends RiskCommand<
  CreateRiskTreatmentInput,
  CreateRiskTreatmentResult
> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly gate: RiskGate,
    private readonly references: RiskReferences,
    private readonly presenter: RiskPresenter,
    private readonly recorder: RiskChangeRecorder,
  ) {
    super('risk.treatment_create', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { riskId, body }: CreateRiskTreatmentInput,
    { now }: Prepared,
  ): Promise<CreateRiskTreatmentResult> {
    const { risk } = await this.gate.writableRisk(tx, riskId, 'treatments');
    if (body.responsibleId) {
      await this.references.owner(tx, body.responsibleId, 'responsibleId');
    }
    if (body.responsibleDepartmentId) {
      await this.references.ownerDepartment(
        tx,
        body.responsibleDepartmentId,
        'responsibleDepartmentId',
      );
    }
    const siblings = await this.risks.treatmentsOf(tx, [risk.id]);
    const userId = userIdOf();
    const treatment = createRiskTreatment(body, {
      id: newId(),
      risk,
      sortOrder: nextTreatmentSortOrder(siblings),
      now,
      userId,
    });
    await this.risks.insertTreatment(tx, treatment);

    // RN-RISK-14: no mesmo `tx` — nunca um risco `OPEN` com tratamento ativo por falha parcial.
    const started = startTreatment(risk, siblings);
    const riskStarted =
      started !== null && (await this.risks.markInTreatment(tx, risk.id, { at: now, userId }));
    await this.recorder.treatmentCreated(
      tx,
      treatment,
      riskStarted ? { from: risk.status, to: 'IN_TREATMENT' } : null,
    );
    return {
      dto: await this.presenter.presentTreatment(tx, treatment),
      type: treatment.type,
      riskStarted,
    };
  }

  protected override committed(
    { dto, type, riskStarted }: CreateRiskTreatmentResult,
    durationMs: number,
  ): void {
    countTreatmentChanged('CREATED');
    this.logger.log(
      {
        event: 'risk.treatment_created',
        riskId: dto.riskId,
        treatmentId: dto.id,
        type,
        riskStarted,
        durationMs,
        ...logContext(),
      },
      'risk.treatment_created',
    );
  }
}

export interface UpdateRiskTreatmentInput {
  readonly treatmentId: string;
  readonly patch: UpdateRiskTreatment;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

export interface UpdateRiskTreatmentResult {
  readonly dto: RiskTreatmentDto;
  /** `false` = nada mudou (sem auditoria nem evento). */
  readonly changed: boolean;
  readonly statusChange: TreatmentStatusChange | null;
}

/** `UpdateRiskTreatmentCommand` — RSK-07 (fluxo principal, passos 6–8 · FA-01/FA-02). */
@Injectable()
export class UpdateRiskTreatmentCommand extends RiskCommand<
  UpdateRiskTreatmentInput,
  UpdateRiskTreatmentResult
> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly gate: RiskGate,
    private readonly references: RiskReferences,
    private readonly presenter: RiskPresenter,
    private readonly recorder: RiskChangeRecorder,
  ) {
    super('risk.treatment_update', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { treatmentId, patch, expectedVersion }: UpdateRiskTreatmentInput,
    { now }: Prepared,
  ): Promise<UpdateRiskTreatmentResult> {
    const { treatment } = await this.gate.writableTreatment(tx, treatmentId);
    assertVersion(treatment, expectedVersion);
    const patched = patchRiskTreatment(treatment, patch, now);
    if (!patched.ok) throw invalidTreatmentTransition(patched.refused.from, patched.refused.to);
    const { next, statusChange } = patched;

    const changes = diffRiskTreatment(treatment, next);
    if (changes.length === 0) {
      return {
        dto: await this.presenter.presentTreatment(tx, treatment),
        changed: false,
        statusChange: null,
      };
    }
    if (next.responsibleId !== null && next.responsibleId !== treatment.responsibleId) {
      await this.references.owner(tx, next.responsibleId, 'responsibleId');
    }
    if (
      next.responsibleDepartmentId !== null &&
      next.responsibleDepartmentId !== treatment.responsibleDepartmentId
    ) {
      await this.references.ownerDepartment(
        tx,
        next.responsibleDepartmentId,
        'responsibleDepartmentId',
      );
    }

    const touched = touchRiskTreatment(next, now, userIdOf());
    try {
      await this.risks.updateTreatment(tx, touched, expectedVersion);
    } catch (error) {
      await conflictToVersion(this.risks, tx, treatment, error);
    }
    const saved: RiskTreatment = { ...touched, version: expectedVersion + 1 };
    await this.recorder.treatmentUpdated(tx, saved, changes, statusChange);
    return { dto: await this.presenter.presentTreatment(tx, saved), changed: true, statusChange };
  }

  protected override committed({ dto, changed, statusChange }: UpdateRiskTreatmentResult): void {
    if (!changed) return;
    countTreatmentChanged(statusChange === null ? 'UPDATED' : 'STATUS_CHANGED');
    if (statusChange === null) return;
    this.logger.log(
      {
        event: 'risk.treatment_status_changed',
        riskId: dto.riskId,
        treatmentId: dto.id,
        fromStatus: statusChange.from,
        toStatus: statusChange.to,
        ...logContext(),
      },
      'risk.treatment_status_changed',
    );
  }
}

export interface DeleteRiskTreatmentInput {
  readonly treatmentId: string;
  readonly expectedVersion: number;
}

/** `DeleteRiskTreatmentHandler` — RSK-08 (fluxo principal, passo 9 · RN-RISK-17 · FA-04). */
@Injectable()
export class DeleteRiskTreatmentCommand extends RiskCommand<
  DeleteRiskTreatmentInput,
  RiskTreatment
> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly gate: RiskGate,
    private readonly recorder: RiskChangeRecorder,
  ) {
    super('risk.treatment_delete', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { treatmentId, expectedVersion }: DeleteRiskTreatmentInput,
    { now }: Prepared,
  ): Promise<RiskTreatment> {
    const { treatment } = await this.gate.writableTreatment(tx, treatmentId);
    assertVersion(treatment, expectedVersion);
    try {
      await this.risks.softDeleteTreatment(tx, treatment, expectedVersion, {
        at: now,
        userId: userIdOf(),
      });
    } catch (error) {
      await conflictToVersion(this.risks, tx, treatment, error);
    }
    // FA-04: o status do risco NÃO reverte (ajuste manual pelo RSK-04).
    await this.recorder.treatmentDeleted(tx, treatment);
    return treatment;
  }

  protected override committed(treatment: RiskTreatment): void {
    countTreatmentChanged('DELETED');
    this.logger.log(
      {
        event: 'risk.treatment_deleted',
        riskId: treatment.riskId,
        treatmentId: treatment.id,
        ...logContext(),
      },
      'risk.treatment_deleted',
    );
  }
}
