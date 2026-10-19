import type {
  AlternativeDecision,
  CreateEtpAlternativeParsed,
  DecideEtpAlternativeParsed,
  EtpAlternativeDto,
  UpdateEtpAlternativeParsed,
} from '@contrataflow/validation';
import { nextAlternativeSortOrder } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import {
  alternativeNotFound,
  alternativeVersionConflict,
  cannotDeleteRecommended,
  confidentialCostDenied,
  countAlternativeChanged,
  duplicateName,
  EtpAlternativeGate,
  EtpAlternativeRecorder,
  recommendedExists,
  toAlternativeDto,
} from './etp-alternative.support.js';
import {
  ETP_ALTERNATIVE_REPOSITORY,
  ETP_CLOCK,
  ETP_REPOSITORY,
  ETP_TRANSACTIONS,
  EtpAlternativeUniqueViolation,
} from './ports.js';
import type {
  EtpAlternativeRepository,
  EtpClock,
  EtpRepository,
  EtpTransactions,
} from './ports.js';
import {
  canDeleteEtpAlternative,
  createEtpAlternative,
  diffEtpAlternative,
  isNameTaken,
  patchEtpAlternative,
  planDecision,
  setRecommendedAlternative,
  touchEtpAlternative,
} from '../domain/etp-alternative.js';
import type { EtpAlternative } from '../domain/etp-alternative.js';

/*
 * Comandos das alternativas de solução (US-021 · ETP-06..09), no padrão `TransactionalCommandHandler`:
 * numa transação do tenant, a guarda (`ETP_UPDATE` + POL-02 estendida, com o documento ETP travado —
 * decisões concorrentes se enfileiram) → `If-Match` → POL-09 do custo → domínio puro (RN-ETP-18..22)
 * → gravação (os índices únicos parciais são a última barreira) → cabeçalho `Etp` (RN-ETP-21) →
 * auditoria `etp.alternative_*` e `EtpAlternativeRecommended`. Todos com o nome
 * `etp.alternative_command` (span e o log `etp.alternative_command_failed` da story). Logs de
 * negócio só depois do commit e nunca com textos, justificativa nem custo.
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

abstract class EtpAlternativeCommand<I, O> extends TransactionalCommandHandler<I, Prepared, O> {
  protected constructor(
    transactions: EtpTransactions,
    private readonly clock: EtpClock,
  ) {
    super('etp.alternative_command', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }
}

/** V-09: 412 se o `If-Match` não é a versão da alternativa. */
function assertVersion(alternative: EtpAlternative, expectedVersion: number): void {
  if (alternative.version !== expectedVersion) {
    throw alternativeVersionConflict(alternative.version);
  }
}

/** Corrida com outra transação na gravação vira 412 com a versão vencedora. */
async function conflictToVersion(
  alternatives: EtpAlternativeRepository,
  tx: TenantTx,
  alternative: EtpAlternative,
  error: unknown,
): Promise<never> {
  if (error instanceof VersionConflictError) {
    const latest = await alternatives.findById(tx, alternative.id);
    if (latest === null) throw alternativeNotFound();
    throw alternativeVersionConflict(latest.version);
  }
  throw error;
}

export interface AlternativeResult {
  readonly dto: EtpAlternativeDto;
}

export interface CreateEtpAlternativeInput {
  readonly etpId: string;
  readonly body: CreateEtpAlternativeParsed;
}

/** `CreateEtpAlternativeHandler` — ETP-06 (fluxo principal, passos 1–3). */
@Injectable()
export class CreateEtpAlternativeCommand extends EtpAlternativeCommand<
  CreateEtpAlternativeInput,
  AlternativeResult
> {
  constructor(
    @Inject(ETP_TRANSACTIONS) transactions: EtpTransactions,
    @Inject(ETP_CLOCK) clock: EtpClock,
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
    private readonly gate: EtpAlternativeGate,
    private readonly recorder: EtpAlternativeRecorder,
  ) {
    super(transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { etpId, body }: CreateEtpAlternativeInput,
    { now }: Prepared,
  ): Promise<AlternativeResult> {
    const { etp, masked } = await this.gate.writableEtp(tx, etpId);
    if (masked && body.estimatedCost !== undefined) throw confidentialCostDenied();
    const siblings = await this.alternatives.listByEtp(tx, etp.id);
    if (isNameTaken(siblings, body.name)) throw duplicateName();
    const alternative = createEtpAlternative(body, {
      id: newId(),
      etp,
      sortOrder: nextAlternativeSortOrder(siblings),
      now,
      userId: userIdOf(),
    });
    try {
      await this.alternatives.insert(tx, alternative);
    } catch (error) {
      if (error instanceof EtpAlternativeUniqueViolation) throw duplicateName();
      throw error;
    }
    await this.recorder.created(tx, alternative);
    return { dto: toAlternativeDto(alternative, { masked }) };
  }

  protected override committed(): void {
    countAlternativeChanged('CREATED');
  }
}

export interface UpdateEtpAlternativeInput {
  readonly alternativeId: string;
  readonly patch: UpdateEtpAlternativeParsed;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

export interface UpdateAlternativeResult extends AlternativeResult {
  /** `false` = nada mudou (sem auditoria). */
  readonly changed: boolean;
}

/** `UpdateEtpAlternativeCommand` — ETP-07 (passos 3 e 7: edição e reordenação). */
@Injectable()
export class UpdateEtpAlternativeCommand extends EtpAlternativeCommand<
  UpdateEtpAlternativeInput,
  UpdateAlternativeResult
> {
  constructor(
    @Inject(ETP_TRANSACTIONS) transactions: EtpTransactions,
    @Inject(ETP_CLOCK) clock: EtpClock,
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
    private readonly gate: EtpAlternativeGate,
    private readonly recorder: EtpAlternativeRecorder,
  ) {
    super(transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { alternativeId, patch, expectedVersion }: UpdateEtpAlternativeInput,
    { now }: Prepared,
  ): Promise<UpdateAlternativeResult> {
    const { alternative, masked } = await this.gate.writableAlternative(tx, alternativeId);
    assertVersion(alternative, expectedVersion);
    if (masked && patch.estimatedCost !== undefined) throw confidentialCostDenied();
    const next = patchEtpAlternative(alternative, patch);
    const changes = diffEtpAlternative(alternative, next);
    if (changes.length === 0) {
      return { dto: toAlternativeDto(alternative, { masked }), changed: false };
    }
    if (next.name !== alternative.name) {
      const siblings = await this.alternatives.listByEtp(tx, alternative.etpId);
      if (isNameTaken(siblings, next.name, alternative.id)) throw duplicateName();
    }
    const touched = touchEtpAlternative(next, now, userIdOf());
    try {
      await this.alternatives.update(tx, touched, expectedVersion);
    } catch (error) {
      if (error instanceof EtpAlternativeUniqueViolation) throw duplicateName();
      await conflictToVersion(this.alternatives, tx, alternative, error);
    }
    const saved: EtpAlternative = { ...touched, version: expectedVersion + 1 };
    await this.recorder.updated(tx, saved, changes);
    return { dto: toAlternativeDto(saved, { masked }), changed: true };
  }

  protected override committed({ changed }: UpdateAlternativeResult): void {
    if (changed) countAlternativeChanged('UPDATED');
  }
}

export interface DeleteEtpAlternativeInput {
  readonly alternativeId: string;
  readonly expectedVersion: number;
}

/** `DeleteEtpAlternativeCommand` — ETP-08 (passo 7 · RN-ETP-22 · FA-03). */
@Injectable()
export class DeleteEtpAlternativeCommand extends EtpAlternativeCommand<
  DeleteEtpAlternativeInput,
  void
> {
  constructor(
    @Inject(ETP_TRANSACTIONS) transactions: EtpTransactions,
    @Inject(ETP_CLOCK) clock: EtpClock,
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
    private readonly gate: EtpAlternativeGate,
    private readonly recorder: EtpAlternativeRecorder,
  ) {
    super(transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { alternativeId, expectedVersion }: DeleteEtpAlternativeInput,
    { now }: Prepared,
  ): Promise<void> {
    const { alternative } = await this.gate.writableAlternative(tx, alternativeId);
    assertVersion(alternative, expectedVersion);
    if (!canDeleteEtpAlternative(alternative)) throw cannotDeleteRecommended();
    try {
      await this.alternatives.softDelete(tx, alternative, expectedVersion, {
        at: now,
        userId: userIdOf(),
      });
    } catch (error) {
      await conflictToVersion(this.alternatives, tx, alternative, error);
    }
    await this.recorder.deleted(tx, alternative);
  }

  protected override committed(): void {
    countAlternativeChanged('DELETED');
  }
}

export interface DecideEtpAlternativeInput {
  readonly alternativeId: string;
  readonly body: DecideEtpAlternativeParsed;
  readonly expectedVersion: number;
}

export interface DecideAlternativeResult extends AlternativeResult {
  readonly decision: AlternativeDecision;
  /** Houve substituição da recomendada (FA-01). */
  readonly replaced: boolean;
  readonly changed: boolean;
}

/** `DecideEtpAlternativeCommand` — ETP-09 (passos 4–6 · FA-01 · RN-ETP-19..21). */
@Injectable()
export class DecideEtpAlternativeCommand extends EtpAlternativeCommand<
  DecideEtpAlternativeInput,
  DecideAlternativeResult
> {
  constructor(
    @Inject(ETP_TRANSACTIONS) transactions: EtpTransactions,
    @Inject(ETP_CLOCK) clock: EtpClock,
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
    @Inject(ETP_REPOSITORY) private readonly etps: EtpRepository,
    private readonly gate: EtpAlternativeGate,
    private readonly recorder: EtpAlternativeRecorder,
  ) {
    super(transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { alternativeId, body, expectedVersion }: DecideEtpAlternativeInput,
    { now }: Prepared,
  ): Promise<DecideAlternativeResult> {
    const { etp, alternative, masked } = await this.gate.writableAlternative(tx, alternativeId);
    assertVersion(alternative, expectedVersion);
    const siblings = await this.alternatives.listByEtp(tx, alternative.etpId);
    const plan = planDecision(alternative, siblings, {
      decision: body.decision,
      decisionJustification: body.decisionJustification ?? null,
      replaceRecommended: body.replaceRecommended === true,
    });
    if (!plan.ok) throw recommendedExists(plan.recommendedAlternativeId);
    if (plan.changes.length === 0) {
      return {
        dto: toAlternativeDto(alternative, { masked }),
        decision: alternative.decision,
        replaced: false,
        changed: false,
      };
    }
    const userId = userIdOf();
    try {
      // FA-01 numa transação só: a antiga sai de RECOMMENDED ANTES (índice único parcial).
      if (plan.demoted !== null) {
        const demoted = plan.demoted;
        await this.alternatives.update(
          tx,
          touchEtpAlternative(demoted, now, userId),
          demoted.version,
        );
      }
      await this.alternatives.update(
        tx,
        touchEtpAlternative(plan.next, now, userId),
        expectedVersion,
      );
    } catch (error) {
      if (error instanceof EtpAlternativeUniqueViolation) {
        // A verificação prévia não viu a outra recomendada (a trava do documento deveria ter
        // enfileirado): a recomendação concorrente perde com o mesmo 409. O `tx` já falhou no
        // banco — nada mais é lido nele.
        this.logger.warn(
          { event: 'etp.alternative_recommend_race', alternativeId, ...logContext() },
          'etp.alternative_recommend_race',
        );
        throw recommendedExists(null);
      }
      await conflictToVersion(this.alternatives, tx, alternative, error);
    }
    if (plan.recommendedAlternativeId !== undefined) {
      await this.etps.setRecommendedAlternative(
        tx,
        setRecommendedAlternative(etp, plan.recommendedAlternativeId, { at: now, userId }),
      );
    }
    const saved: EtpAlternative = {
      ...touchEtpAlternative(plan.next, now, userId),
      version: expectedVersion + 1,
    };
    const previousAlternativeId = plan.demoted?.id ?? null;
    await this.recorder.decided(tx, saved, {
      changes: plan.changes,
      replaceRecommended: body.replaceRecommended === true,
      previousAlternativeId,
      recommended: plan.recommended !== null,
    });
    return {
      dto: toAlternativeDto(saved, { masked }),
      decision: saved.decision,
      replaced: previousAlternativeId !== null,
      changed: true,
    };
  }

  protected override committed(result: DecideAlternativeResult, durationMs: number): void {
    if (!result.changed) return;
    countAlternativeChanged(result.decision);
    this.logger.log(
      {
        event: 'etp.alternative_decided',
        etpId: result.dto.etpId,
        alternativeId: result.dto.id,
        decision: result.decision,
        replaced: result.replaced,
        durationMs,
        ...logContext(),
      },
      'etp.alternative_decided',
    );
  }
}
