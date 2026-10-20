import type {
  AddProcessParticipant,
  ParticipantGrantChannel,
  ProcessParticipantDto,
  ProcessParticipantsMeta,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import {
  PROCESS_CLOCK,
  PROCESS_PARTICIPANT_REPOSITORY,
  PROCESS_TRANSACTIONS,
  ParticipantAlreadyActiveError,
} from './ports.js';
import type { ProcessClock, ProcessParticipantRepository, ProcessTransactions } from './ports.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import {
  ProcessParticipantPresenter,
  ProcessParticipantRecorder,
  accessTargetOf,
} from './process-participants.support.js';
import {
  participantAlreadyExists,
  participantGrantRefused,
  participantNotFound,
  recordParticipantAdded,
  recordParticipantRemoved,
  unfollowNotObserver,
} from './process.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import {
  compareParticipants,
  grantRefusal,
  isParticipationExpired,
  newParticipant,
  revokedParticipant,
  unfollowDecision,
} from '../domain/process-participants.js';
import type { GrantTarget, ProcessParticipant } from '../domain/process-participants.js';

/*
 * Casos de uso de participantes (US-012 · PRC-28..32 · DEC-036 · POL-10): o padrão
 * `TransactionalCommandHandler` — numa transação do tenant, o processo visível (404) → a
 * autorização sobre o processo (o guard já conferiu `PROCESS_MANAGE_PARTICIPANTS`/`PROCESS_FOLLOW`
 * cobrindo o processo do caminho; PRC-30 confere aqui, pelo processo do participante) → o alvo e o
 * domínio puro (RN-PROC-126..133) → a gravação → `ProcessAccess`, auditoria e evento (timeline no
 * mesmo `tx`). O índice único parcial é a salvaguarda de concorrência (RN-PROC-129).
 */

function actorUserId(): string {
  return requireRequestContext().actor.userId ?? '';
}

/** O que o log de negócio precisa depois do commit (nunca nomes nem textos livres). */
interface ParticipantChange {
  readonly participantId: string;
  readonly processId: string;
  readonly role: ProcessParticipant['role'];
  readonly kind: 'ADDED' | 'REMOVED' | 'NOOP';
  readonly grantedVia?: ParticipantGrantChannel;
  readonly hasExpiresAt?: boolean;
}

abstract class ParticipantCommand<
  I,
  O extends { readonly change: ParticipantChange },
> extends TransactionalCommandHandler<I, { readonly now: Date }, O> {
  protected constructor(
    name: string,
    transactions: ProcessTransactions,
    private readonly clock: ProcessClock,
  ) {
    super(name, transactions);
  }

  protected prepare(): Promise<{ readonly now: Date }> {
    return Promise.resolve({ now: this.clock() });
  }

  protected override committed(result: O, durationMs: number): void {
    const { change } = result;
    if (change.kind === 'NOOP') return;
    const context = requireRequestContext();
    const common = {
      participantId: change.participantId,
      processId: change.processId,
      durationMs,
      tenantId: context.tenantId,
      userId: context.actor.userId,
      correlationId: context.correlationId,
    };
    if (change.kind === 'ADDED') {
      recordParticipantAdded(change.role, change.grantedVia ?? 'MANAGE');
      this.logger.log(
        {
          event: 'process.participant_added',
          ...common,
          role: change.role,
          grantedVia: change.grantedVia,
          hasExpiresAt: change.hasExpiresAt ?? false,
        },
        'process.participant_added',
      );
    } else {
      recordParticipantRemoved('REVOKED');
      this.logger.log(
        { event: 'process.participant_removed', ...common, reason: 'REVOKED' },
        'process.participant_removed',
      );
    }
  }

  /** Corrida perdida no índice único (RN-PROC-129): 409, sem saber o papel do vencedor. */
  protected async insertOrConflict(
    participants: ProcessParticipantRepository,
    tx: TenantTx,
    participant: ProcessParticipant,
  ): Promise<void> {
    try {
      await participants.insert(tx, participant);
    } catch (error) {
      if (error instanceof ParticipantAlreadyActiveError) {
        this.logger.warn(
          { event: 'participant.duplicate_attempt', processId: participant.processId },
          'participant.duplicate_attempt',
        );
        throw participantAlreadyExists(null);
      }
      throw error;
    }
  }
}

export interface AddParticipantInput {
  readonly processId: string;
  readonly body: AddProcessParticipant;
}

export interface ParticipantResult {
  readonly dto: ProcessParticipantDto;
  readonly change: ParticipantChange;
}

/** `AddProcessParticipantCommand` — PRC-29 (fluxo principal, passos 4–6). */
@Injectable()
export class AddProcessParticipantCommand extends ParticipantCommand<
  AddParticipantInput,
  ParticipantResult
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) clock: ProcessClock,
    @Inject(PROCESS_PARTICIPANT_REPOSITORY)
    private readonly participants: ProcessParticipantRepository,
    private readonly panel: ProcessPanelReader,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
    private readonly presenter: ProcessParticipantPresenter,
    private readonly recorder: ProcessParticipantRecorder,
  ) {
    super('process.participant_add', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { processId, body }: AddParticipantInput,
    { now }: { readonly now: Date },
  ): Promise<ParticipantResult> {
    // O guard já exigiu `PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo (POL-10).
    const { rows } = await this.panel.load(tx, processId);
    const actor = actorUserId();
    const target = await this.targetOf(tx, body);
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    const refusal = grantRefusal(target, { role: body.role, expiresAt, actorUserId: actor }, now);
    if (refusal !== null) throw participantGrantRefused(refusal);

    const principal =
      target.kind === 'USER' ? { userId: target.userId } : { departmentId: target.departmentId };
    const current = await this.participants.findActive(tx, processId, principal);
    if (current !== null) {
      this.logger.warn(
        { event: 'participant.duplicate_attempt', processId, participantId: current.id },
        'participant.duplicate_attempt',
      );
      throw participantAlreadyExists(current.role);
    }
    const participant = newParticipant({
      id: newId(),
      tenantId: rows.process.tenantId,
      processId,
      target: principal,
      role: body.role,
      notify: body.notify,
      expiresAt,
      reason: body.reason ?? null,
      grantedById: actor,
      now,
    });
    await this.insertOrConflict(this.participants, tx, participant);
    await this.recorder.added(tx, participant, 'MANAGE');
    const [dto] = await this.presenter.present(tx, [participant]);
    if (!dto) throw new Error('Participante recém-criado sem DTO.');
    return {
      dto,
      change: {
        participantId: participant.id,
        processId,
        role: participant.role,
        kind: 'ADDED',
        grantedVia: 'MANAGE',
        hasExpiresAt: participant.expiresAt !== null,
      },
    };
  }

  /** O alvo no tenant da transação (de outro tenant = inexistente — RLS · V-06). */
  private async targetOf(tx: TenantTx, body: AddProcessParticipant): Promise<GrantTarget> {
    if (body.userId) {
      const [member] = await this.identity.membersInTenant(tx, [body.userId]);
      return {
        kind: 'USER',
        userId: body.userId,
        membership: member
          ? { type: member.type, status: member.status, expiresAt: member.expiresAt }
          : null,
      };
    }
    const departmentId = body.departmentId ?? '';
    const department = (await this.organization.departmentReferences(tx, [departmentId])).get(
      departmentId,
    );
    return { kind: 'DEPARTMENT', departmentId, isActive: department?.isActive ?? null };
  }
}

export interface RemoveParticipantInput {
  readonly participantId: string;
  readonly revocationReason: string | null;
}

/** `RemoveProcessParticipantCommand` — PRC-30 (fluxo principal, passos 7–9 · RN-PROC-136). */
@Injectable()
export class RemoveProcessParticipantCommand extends ParticipantCommand<
  RemoveParticipantInput,
  { readonly change: ParticipantChange }
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) clock: ProcessClock,
    @Inject(PROCESS_PARTICIPANT_REPOSITORY)
    private readonly participants: ProcessParticipantRepository,
    private readonly panel: ProcessPanelReader,
    private readonly access: AccessFacade,
    private readonly recorder: ProcessParticipantRecorder,
  ) {
    super('process.participant_remove', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { participantId, revocationReason }: RemoveParticipantInput,
    { now }: { readonly now: Date },
  ): Promise<{ readonly change: ParticipantChange }> {
    // Trava a participação: duas remoções simultâneas → a segunda vê "revogada" (404).
    const participant = await this.participants.lockActive(tx, participantId);
    if (participant === null) throw participantNotFound();
    let runtime;
    try {
      ({ runtime } = await this.panel.load(tx, participant.processId));
    } catch {
      // Processo não visível: o participante "não existe" para quem pede (sem revelar).
      throw participantNotFound();
    }
    await this.access.assertCanOnProcess(
      'PROCESS_MANAGE_PARTICIPANTS',
      accessTargetOf(runtime),
      'Você não tem permissão para gerenciar participantes deste processo.',
    );
    const revoked = revokedParticipant(participant, {
      at: now,
      byUserId: actorUserId(),
      reason: revocationReason,
    });
    await this.participants.revoke(tx, revoked);
    await this.recorder.removed(tx, revoked, 'REVOKED');
    return {
      change: {
        participantId,
        processId: participant.processId,
        role: participant.role,
        kind: 'REMOVED',
      },
    };
  }
}

/** `FollowProcessCommand` — PRC-31 (FA-01 · RN-PROC-133): `OBSERVER` com `notify`, idempotente. */
@Injectable()
export class FollowProcessCommand extends ParticipantCommand<string, ParticipantResult> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) clock: ProcessClock,
    @Inject(PROCESS_PARTICIPANT_REPOSITORY)
    private readonly participants: ProcessParticipantRepository,
    private readonly panel: ProcessPanelReader,
    private readonly presenter: ProcessParticipantPresenter,
    private readonly recorder: ProcessParticipantRecorder,
  ) {
    super('process.follow', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    processId: string,
    { now }: { readonly now: Date },
  ): Promise<ParticipantResult> {
    const { rows } = await this.panel.load(tx, processId);
    const actor = actorUserId();
    const current = await this.participants.findActive(tx, processId, { userId: actor });
    // RN-PROC-133: já participa (em qualquer papel, ainda válido) → o existente, sem evento.
    if (current !== null && !isParticipationExpired(current, now)) {
      const [dto] = await this.presenter.present(tx, [current]);
      if (!dto) throw new Error('Participante sem DTO.');
      return {
        dto,
        change: { participantId: current.id, processId, role: current.role, kind: 'NOOP' },
      };
    }
    if (current !== null) {
      // Consultor vencido ainda não revogado pelo job: revoga antes de seguir (RN-PROC-135).
      const expired = revokedParticipant(current, { at: now, byUserId: null, reason: null });
      await this.participants.revoke(tx, expired);
      await this.recorder.removed(tx, expired, 'EXPIRED');
    }
    const participant = newParticipant({
      id: newId(),
      tenantId: rows.process.tenantId,
      processId,
      target: { userId: actor },
      role: 'OBSERVER',
      notify: true,
      expiresAt: null,
      reason: null,
      grantedById: actor,
      now,
    });
    await this.insertOrConflict(this.participants, tx, participant);
    await this.recorder.added(tx, participant, 'FOLLOW');
    const [dto] = await this.presenter.present(tx, [participant]);
    if (!dto) throw new Error('Participante recém-criado sem DTO.');
    return {
      dto,
      change: {
        participantId: participant.id,
        processId,
        role: 'OBSERVER',
        kind: 'ADDED',
        grantedVia: 'FOLLOW',
        hasExpiresAt: false,
      },
    };
  }
}

/** `UnfollowProcessCommand` — PRC-32 (FA-01 · RN-PROC-133): só o papel `OBSERVER` do próprio. */
@Injectable()
export class UnfollowProcessCommand extends ParticipantCommand<
  string,
  { readonly change: ParticipantChange }
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) clock: ProcessClock,
    @Inject(PROCESS_PARTICIPANT_REPOSITORY)
    private readonly participants: ProcessParticipantRepository,
    private readonly panel: ProcessPanelReader,
    private readonly recorder: ProcessParticipantRecorder,
  ) {
    super('process.unfollow', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    processId: string,
    { now }: { readonly now: Date },
  ): Promise<{ readonly change: ParticipantChange }> {
    await this.panel.load(tx, processId);
    const actor = actorUserId();
    const found = await this.participants.findActive(tx, processId, { userId: actor });
    const own = found === null ? null : await this.participants.lockActive(tx, found.id);
    const decision = unfollowDecision(own);
    if (decision === 'NOT_OBSERVER') throw unfollowNotObserver();
    if (decision === 'NOOP' || own === null) {
      return { change: { participantId: '', processId, role: 'OBSERVER', kind: 'NOOP' } };
    }
    const revoked = revokedParticipant(own, { at: now, byUserId: actor, reason: null });
    await this.participants.revoke(tx, revoked);
    await this.recorder.removed(tx, revoked, 'REVOKED');
    return {
      change: { participantId: own.id, processId, role: own.role, kind: 'REMOVED' },
    };
  }
}

export interface ParticipantsList {
  readonly items: ProcessParticipantDto[];
  readonly meta: ProcessParticipantsMeta;
}

/** `ListProcessParticipantsQuery` — PRC-28: participações ativas e válidas + `meta` da UI. */
@Injectable()
export class ListProcessParticipantsQuery {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(PROCESS_PARTICIPANT_REPOSITORY)
    private readonly participants: ProcessParticipantRepository,
    private readonly panel: ProcessPanelReader,
    private readonly access: AccessFacade,
    private readonly presenter: ProcessParticipantPresenter,
  ) {}

  execute(processId: string): Promise<ParticipantsList> {
    const now = this.clock();
    return this.transactions.read(async (tx) => {
      const { runtime } = await this.panel.load(tx, processId);
      // RN-PROC-135: consultor vencido some da lista antes mesmo do job.
      const active = (await this.participants.listActive(tx, processId))
        .filter((participant) => !isParticipationExpired(participant, now))
        .sort(compareParticipants);
      const actor = actorUserId();
      const mine = active.find((participant) => participant.userId === actor) ?? null;
      return {
        items: await this.presenter.present(tx, active),
        meta: {
          canManage: await this.access.canOnProcess(
            'PROCESS_MANAGE_PARTICIPANTS',
            accessTargetOf(runtime),
          ),
          me: mine === null ? null : { participantId: mine.id, role: mine.role },
        },
      };
    });
  }
}
