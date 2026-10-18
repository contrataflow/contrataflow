import type { MovementMetadata } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { isEligibleAssignee } from '../domain/process-forward.js';
import type { Process } from '../domain/process.js';

/**
 * Leituras comuns aos comandos de tramitação (encaminhar — US-047; devolver — US-048), no `tx` de
 * quem chama: elegibilidade do responsável de destino (RN-TRAM-08), os nomes congelados da
 * tramitação (`metadata.labels` — RN-TRAM-15) e quem alterou o processo por último (o nome do
 * diálogo de conflito `STAGE_CHANGED`).
 */
@Injectable()
export class StageTransitionSupport {
  constructor(
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  /** RN-TRAM-08: vínculo ativo não vencido, lotação na unidade de destino e `PROCESS_VIEW`. */
  async isEligibleAssignee(
    tx: TenantTx,
    userId: string,
    departmentId: string,
    now: Date,
  ): Promise<boolean> {
    const [member] = await this.identity.membersInTenant(tx, [userId]);
    if (member === undefined) return isEligibleAssignee(null, now);
    const assigned = (
      await this.identity.usersAssignedToDepartment(tx, departmentId, [userId])
    ).has(userId);
    const canViewProcesses =
      assigned && member.status === 'ACTIVE'
        ? await this.access.membershipHoldsIn(tx, member, 'PROCESS_VIEW')
        : false;
    return isEligibleAssignee(
      {
        membershipStatus: member.status,
        membershipExpiresAt: member.expiresAt,
        assignedToDepartment: assigned,
        canViewProcesses,
      },
      now,
    );
  }

  /** Nomes congelados de etapas, unidades e pessoas (`metadata.labels` — RN-TRAM-15). */
  async labels(
    tx: TenantTx,
    input: {
      readonly fromStage: string;
      readonly toStage: string;
      readonly fromDepartmentId: string;
      readonly toDepartmentId: string;
      readonly fromUserId: string | null;
      readonly toUserId: string | null;
    },
  ): Promise<NonNullable<MovementMetadata['labels']>> {
    const departments = await this.organization.departmentNames(tx, [
      input.fromDepartmentId,
      input.toDepartmentId,
    ]);
    const userIds = [input.fromUserId, input.toUserId].filter((id): id is string => id !== null);
    const users = await this.identity.userDisplayNames(tx, userIds);
    const userName = (id: string | null) => (id === null ? undefined : users.get(id));
    const fromUser = userName(input.fromUserId);
    const toUser = userName(input.toUserId);
    const fromDepartment = departments.get(input.fromDepartmentId);
    const toDepartment = departments.get(input.toDepartmentId);
    return {
      fromStage: input.fromStage,
      toStage: input.toStage,
      ...(fromDepartment === undefined ? {} : { fromDepartment }),
      ...(toDepartment === undefined ? {} : { toDepartment }),
      ...(fromUser === undefined ? {} : { fromUser }),
      ...(toUser === undefined ? {} : { toUser }),
    };
  }

  /** Quem alterou o processo por último (nome exibido no diálogo de conflito). */
  async lastWriter(
    tx: TenantTx,
    process: Process,
  ): Promise<{ readonly id: string; readonly name: string } | null> {
    const id = process.updatedById ?? process.createdById;
    const name = (await this.identity.userDisplayNames(tx, [id])).get(id);
    return name === undefined ? null : { id, name };
  }
}
