import type { CreateRisk, RiskDto, UpdateRisk } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { RISK_CLOCK, RISK_REPOSITORY, RISK_TRANSACTIONS } from './ports.js';
import type { RiskClock, RiskRepository, RiskTransactions } from './ports.js';
import {
  countRiskAssessed,
  countRiskCreated,
  riskNotFound,
  riskValidationError,
  riskVersionConflict,
} from './risk.errors.js';
import {
  RiskChangeRecorder,
  RiskGate,
  RiskPresenter,
  RiskReferences,
  RiskScaleReader,
} from './risk.support.js';
import {
  createRisk,
  diffRisk,
  gradeIssues,
  nextRiskCode,
  patchRisk,
  residualIssues,
  touchRisk,
} from '../domain/risk.js';
import type { Risk, RiskReassessment } from '../domain/risk.js';

/*
 * Comandos de riscos (US-033 · RSK-02/04/05): o padrão `TransactionalCommandHandler` — numa
 * transação do tenant, a guarda (POL-02 estendida, com o `RISK_MAP` travado — RN-RISK-09) →
 * `If-Match` → escala vigente (RN-RISK-03/04) → referências (V-04/V-05) → domínio puro → gravação
 * (código sob a trava de numeração do processo — RN-RISK-02) → auditoria `risk.*` e eventos `Risk*`
 * (timeline no mesmo `tx`). Logs de negócio só depois do commit e nunca com textos do risco.
 */

interface Prepared {
  readonly now: Date;
}

const userIdOf = () => requireRequestContext().actor.userId;

function logContext() {
  const context = requireRequestContext();
  return {
    tenantId: context.tenantId,
    userId: context.actor.userId,
    correlationId: context.correlationId,
  };
}

abstract class RiskCommand<I, O> extends TransactionalCommandHandler<I, Prepared, O> {
  protected constructor(
    name: string,
    transactions: RiskTransactions,
    private readonly clock: RiskClock,
  ) {
    super(name, transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }
}

/** 412 se o `If-Match` não é a versão do risco (Concorrência · `currentVersion`). */
function assertVersion(risk: Risk, expectedVersion: number): void {
  if (risk.version !== expectedVersion) throw riskVersionConflict(risk.version);
}

/** Corrida com outra transação na gravação vira 412 com a versão vencedora. */
async function conflictToVersion(
  risks: RiskRepository,
  tx: TenantTx,
  risk: Risk,
  error: unknown,
): Promise<never> {
  if (error instanceof VersionConflictError) {
    const latest = await risks.findById(tx, risk.id);
    if (latest === null) throw riskNotFound();
    throw riskVersionConflict(latest.version);
  }
  throw error;
}

export interface CreateRiskInput {
  readonly processId: string;
  readonly body: CreateRisk;
}

export interface RiskResult {
  readonly dto: RiskDto;
}

/** `CreateRiskCommand` — RSK-02 (fluxo principal, passos 5–7). */
@Injectable()
export class CreateRiskCommand extends RiskCommand<CreateRiskInput, RiskResult> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly gate: RiskGate,
    private readonly scales: RiskScaleReader,
    private readonly references: RiskReferences,
    private readonly presenter: RiskPresenter,
    private readonly recorder: RiskChangeRecorder,
  ) {
    super('risk.create', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { processId, body }: CreateRiskInput,
    { now }: Prepared,
  ): Promise<RiskResult> {
    await this.gate.writable(tx, processId);
    const snapshot = await this.scales.current(tx);
    const issues = gradeIssues(body, snapshot);
    if (issues.length > 0) throw riskValidationError(issues);
    const categoryCode = await this.references.category(tx, body.categoryId);
    if (body.ownerId) await this.references.owner(tx, body.ownerId);
    if (body.ownerDepartmentId) await this.references.ownerDepartment(tx, body.ownerDepartmentId);

    // RN-RISK-02: o próximo código é lido e gravado sob a trava de numeração do processo.
    await this.risks.lockProcessCodes(tx, processId);
    const code = nextRiskCode(await this.risks.usedCodes(tx, processId));
    const risk = createRisk(body, {
      id: newId(),
      tenantId: requireRequestContext().tenantId ?? '',
      processId,
      code,
      snapshot,
      now,
      userId: userIdOf(),
    });
    await this.risks.insert(tx, risk);
    await this.recorder.created(tx, risk, diffRisk(null, risk), categoryCode);
    const [dto] = await this.presenter.present(tx, [risk]);
    if (!dto) throw new Error('Risco recém-criado sem DTO.');
    return { dto };
  }

  protected override committed({ dto }: RiskResult, durationMs: number): void {
    countRiskCreated(dto.level);
    this.logger.log(
      {
        event: 'risk.created',
        riskId: dto.id,
        processId: dto.processId,
        code: dto.code,
        level: dto.level,
        durationMs,
        ...logContext(),
      },
      'risk.created',
    );
  }
}

export interface UpdateRiskInput {
  readonly riskId: string;
  readonly patch: UpdateRisk;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

export interface UpdateRiskResult extends RiskResult {
  readonly reassessment: RiskReassessment | null;
}

/** `UpdateRiskCommand` — RSK-04 (fluxo principal, passo 8 · `AssessRiskCommand` embutido). */
@Injectable()
export class UpdateRiskCommand extends RiskCommand<UpdateRiskInput, UpdateRiskResult> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly gate: RiskGate,
    private readonly scales: RiskScaleReader,
    private readonly references: RiskReferences,
    private readonly presenter: RiskPresenter,
    private readonly recorder: RiskChangeRecorder,
  ) {
    super('risk.update', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { riskId, patch, expectedVersion }: UpdateRiskInput,
    { now }: Prepared,
  ): Promise<UpdateRiskResult> {
    const { risk } = await this.gate.writableRisk(tx, riskId);
    assertVersion(risk, expectedVersion);
    const snapshot = await this.scales.current(tx);
    const gradeErrors = gradeIssues(patch, snapshot);
    if (gradeErrors.length > 0) throw riskValidationError(gradeErrors);
    const { next, reassessment } = patchRisk(risk, patch, snapshot);
    const pairErrors = residualIssues(next);
    if (pairErrors.length > 0) throw riskValidationError(pairErrors);

    const changes = diffRisk(risk, next);
    if (changes.length === 0) {
      const [dto] = await this.presenter.present(tx, [risk]);
      if (!dto) throw new Error('Risco sem DTO.');
      return { dto, reassessment: null };
    }
    if (next.categoryId !== risk.categoryId) await this.references.category(tx, next.categoryId);
    if (next.ownerId !== null && next.ownerId !== risk.ownerId) {
      await this.references.owner(tx, next.ownerId);
    }
    if (next.ownerDepartmentId !== null && next.ownerDepartmentId !== risk.ownerDepartmentId) {
      await this.references.ownerDepartment(tx, next.ownerDepartmentId);
    }

    const touched = touchRisk(next, now, userIdOf());
    try {
      await this.risks.update(tx, touched, expectedVersion);
    } catch (error) {
      await conflictToVersion(this.risks, tx, risk, error);
    }
    const saved: Risk = { ...touched, version: expectedVersion + 1 };
    await this.recorder.updated(tx, saved, changes, reassessment);
    const [dto] = await this.presenter.present(tx, [saved]);
    if (!dto) throw new Error('Risco sem DTO.');
    return { dto, reassessment };
  }

  protected override committed({ dto, reassessment }: UpdateRiskResult): void {
    if (reassessment === null) return;
    countRiskAssessed(reassessment.fromLevel !== reassessment.toLevel);
    this.logger.log(
      {
        event: 'risk.assessed',
        riskId: dto.id,
        fromLevel: reassessment.fromLevel,
        toLevel: reassessment.toLevel,
        score: reassessment.toScore,
        ...logContext(),
      },
      'risk.assessed',
    );
  }
}

export interface DeleteRiskInput {
  readonly riskId: string;
  readonly expectedVersion: number;
}

interface DeleteRiskResult {
  readonly risk: Risk;
  readonly treatmentsRemoved: number;
}

/** `DeleteRiskHandler` — RSK-05 (fluxo principal, passo 9 · RN-RISK-10). */
@Injectable()
export class DeleteRiskCommand extends RiskCommand<DeleteRiskInput, DeleteRiskResult> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly gate: RiskGate,
    private readonly recorder: RiskChangeRecorder,
  ) {
    super('risk.delete', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { riskId, expectedVersion }: DeleteRiskInput,
    { now }: Prepared,
  ): Promise<DeleteRiskResult> {
    const { risk } = await this.gate.writableRisk(tx, riskId);
    assertVersion(risk, expectedVersion);
    const deletion = { at: now, userId: userIdOf() };
    try {
      await this.risks.softDelete(tx, risk, expectedVersion, deletion);
    } catch (error) {
      await conflictToVersion(this.risks, tx, risk, error);
    }
    // RN-RISK-10: os tratamentos vão junto (exclusão lógica), na mesma transação.
    const treatmentsRemoved = await this.risks.softDeleteTreatments(tx, risk.id, deletion);
    await this.recorder.deleted(tx, risk, treatmentsRemoved);
    return { risk, treatmentsRemoved };
  }

  protected override committed({ risk, treatmentsRemoved }: DeleteRiskResult): void {
    this.logger.log(
      {
        event: 'risk.deleted',
        riskId: risk.id,
        processId: risk.processId,
        code: risk.code,
        treatmentsRemoved,
        ...logContext(),
      },
      'risk.deleted',
    );
  }
}
