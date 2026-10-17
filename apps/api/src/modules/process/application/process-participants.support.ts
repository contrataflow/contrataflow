import { ProcessParticipantAdded, ProcessParticipantRemoved } from '@contrataflow/validation';
import type {
  ParticipantGrantChannel,
  ParticipantRemovalReason,
  ProcessParticipantDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { ProcessAccessTarget } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type { ProcessParticipant } from '../domain/process-participants.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';

/*
 * Peças comuns dos casos de uso de participantes (US-012): o processo como a autorização o vê, o
 * apresentador (nomes congelados na leitura) e a gravação dos efeitos na MESMA transação —
 * `ProcessAccess` (`PARTICIPANT`, origem = participante), auditoria `process.participant_add`/
 * `process.participant_remove` e o evento, que projeta a timeline `PARTICIPANT_ADDED`/`_REMOVED`
 * no mesmo `tx` (RN-PROC-134 · story · "Transação").
 */

/** O processo como a autorização o vê (escopo, concessões e participações — US-097/US-012). */
export function accessTargetOf(runtime: ProcessRuntime): ProcessAccessTarget {
  return {
    processId: runtime.id,
    organizationId: runtime.organizationId ?? null,
    departmentIds: runtime.access.departmentIds,
    userIds: runtime.access.userIds,
    participations: runtime.access.participations ?? [],
    participantDepartmentIds: runtime.access.participantDepartmentIds ?? [],
  };
}

@Injectable()
export class ProcessParticipantPresenter {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  /** DTOs de PRC-28/29/31: nome do usuário/unidade, vínculo externo e quem concedeu. */
  async present(
    tx: TenantTx,
    participants: readonly ProcessParticipant[],
  ): Promise<ProcessParticipantDto[]> {
    const userIds = [
      ...new Set(
        participants.flatMap((participant) => [
          ...(participant.userId === null ? [] : [participant.userId]),
          participant.grantedById,
        ]),
      ),
    ];
    const departmentIds = [
      ...new Set(participants.flatMap((participant) => participant.departmentId ?? [])),
    ];
    const userNames = await this.identity.userDisplayNames(tx, userIds);
    const external = new Set(
      (await this.identity.membersInTenant(tx, userIds))
        .filter((member) => member.type === 'EXTERNAL')
        .map((member) => member.userId),
    );
    const departmentNames = await this.organization.departmentNames(tx, departmentIds);
    return participants.map((participant) => {
      const principalId = participant.userId ?? participant.departmentId ?? '';
      const isUser = participant.userId !== null;
      return {
        id: participant.id,
        processId: participant.processId,
        principalType: isUser ? 'USER' : 'DEPARTMENT',
        userId: participant.userId,
        departmentId: participant.departmentId,
        principal: {
          id: principalId,
          name: (isUser ? userNames.get(principalId) : departmentNames.get(principalId)) ?? '',
          isExternal: isUser && external.has(principalId),
        },
        role: participant.role,
        notify: participant.notify,
        expiresAt: participant.expiresAt?.toISOString() ?? null,
        grantedAt: participant.grantedAt.toISOString(),
        grantedBy: {
          id: participant.grantedById,
          name: userNames.get(participant.grantedById) ?? '',
        },
        reason: participant.reason,
      };
    });
  }
}

@Injectable()
export class ProcessParticipantRecorder {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  /** Concessão: `ProcessAccess` `PARTICIPANT`, `process.participant_add` e o evento. */
  async added(
    tx: TenantTx,
    participant: ProcessParticipant,
    grantedVia: ParticipantGrantChannel,
  ): Promise<void> {
    await this.processes.grantAccess(
      tx,
      participant.processId,
      [
        participant.userId !== null
          ? {
              principalType: 'USER',
              userId: participant.userId,
              reason: 'PARTICIPANT',
              sourceId: participant.id,
            }
          : {
              principalType: 'DEPARTMENT',
              departmentId: participant.departmentId ?? '',
              reason: 'PARTICIPANT',
              sourceId: participant.id,
            },
      ],
      participant.grantedAt,
    );
    // Nunca o nome nem o motivo (texto livre) — story · "Logs"/"Auditoria".
    await this.audit.record(tx, {
      action: 'process.participant_add',
      entityType: 'ProcessParticipant',
      entityId: participant.id,
      processId: participant.processId,
      metadata: {
        role: participant.role,
        grantedVia,
        hasExpiresAt: participant.expiresAt !== null,
        principalType: participant.userId === null ? 'DEPARTMENT' : 'USER',
      },
    });
    await this.outbox.record(
      tx,
      ProcessParticipantAdded.of({
        aggregateId: participant.processId,
        processId: participant.processId,
        payload: {
          participantId: participant.id,
          userId: participant.userId,
          departmentId: participant.departmentId,
          role: participant.role,
          expiresAt: participant.expiresAt?.toISOString() ?? null,
          notify: participant.notify,
          grantedVia,
        },
      }),
    );
  }

  /** Revogação (já gravada): `ProcessAccess` revogado, `process.participant_remove` e o evento. */
  async removed(
    tx: TenantTx,
    participant: ProcessParticipant,
    reason: ParticipantRemovalReason,
  ): Promise<void> {
    await this.processes.revokeParticipantAccess(
      tx,
      participant.id,
      participant.revokedAt ?? new Date(),
    );
    await this.audit.record(tx, {
      action: 'process.participant_remove',
      entityType: 'ProcessParticipant',
      entityId: participant.id,
      processId: participant.processId,
      metadata: { reason, role: participant.role },
    });
    await this.outbox.record(
      tx,
      ProcessParticipantRemoved.of({
        aggregateId: participant.processId,
        processId: participant.processId,
        payload: { participantId: participant.id, reason },
      }),
    );
  }
}
