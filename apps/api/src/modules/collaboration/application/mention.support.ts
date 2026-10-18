import { MENTION_LIMITS } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { ProcessAccessTarget } from '#shared/auth/process-access.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { MENTION_REPOSITORY } from './ports.js';
import type { MentionRepository } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { TenantMember } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type { Comment } from '../domain/comment.js';
import { createMention } from '../domain/mention.js';
import type { Mention, MentionTarget } from '../domain/mention.js';

/*
 * Visibilidade dos alvos de menção (US-072 · DEC-024 · RN-CMT-21/22/27) e a gravação dos `Mention`
 * na transação do comentário. Usuário: vínculo ativo não vencido e o processo visível a ele
 * (concessão própria ou escopo de `PROCESS_VIEW`). Unidade: ativa, com `ProcessAccess` ativo no
 * processo e no máximo 50 membros ativos (FA-04). Menção nunca concede acesso: alvo inválido é só
 * descartado, sem bloquear a publicação.
 */

/** Resultado da gravação: menções novas (com evento) e alvos descartados (log `warn`). */
export interface MentionOutcome {
  readonly created: readonly Mention[];
  readonly discarded: readonly MentionTarget[];
}

export const NO_MENTIONS: MentionOutcome = { created: [], discarded: [] };

/** Vínculo `ACTIVE` não vencido (RN-CMT-21: "vínculo ativo"). */
export const isActiveMember = (member: TenantMember, now: Date) =>
  member.status === 'ACTIVE' && (member.expiresAt === null || member.expiresAt > now);

/** Unidades com visibilidade do processo: concessão de unidade ou participação (DEC-024). */
export const departmentsSeeing = (access: ProcessAccessTarget): ReadonlySet<string> =>
  new Set([...access.departmentIds, ...(access.participantDepartmentIds ?? [])]);

@Injectable()
export class MentionTargets {
  constructor(
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  /** O membro vê o processo (DEC-024), no `tx` do chamador. */
  memberSees(
    tx: TenantTx,
    member: Pick<TenantMember, 'membershipId' | 'userId' | 'roleKeys'>,
    access: ProcessAccessTarget,
  ): Promise<boolean> {
    return this.access.memberCanViewProcess(tx, member, access);
  }

  /** Unidades que podem ser mencionadas: ativas, vendo o processo e com até 50 membros ativos. */
  async eligibleDepartments(
    tx: TenantTx,
    departmentIds: readonly string[],
    access: ProcessAccessTarget,
    now: Date,
  ): Promise<Set<string>> {
    const seeing = departmentsSeeing(access);
    const candidates = departmentIds.filter((id) => seeing.has(id));
    if (candidates.length === 0) return new Set();
    const references = await this.organization.departmentReferences(tx, candidates);
    const counts = await this.identity.activeMemberCounts(tx, candidates, now);
    return new Set(
      candidates.filter(
        (id) =>
          references.get(id)?.isActive === true &&
          (counts.get(id) ?? 0) <= MENTION_LIMITS.maxDepartmentMembers,
      ),
    );
  }

  /** RN-CMT-22: os alvos ainda válidos no commit (a ordem é preservada). */
  async valid(
    tx: TenantTx,
    targets: readonly MentionTarget[],
    access: ProcessAccessTarget,
    now: Date,
  ): Promise<MentionTarget[]> {
    const userIds = targets.filter((target) => target.kind === 'USER').map((target) => target.id);
    const departmentIds = targets
      .filter((target) => target.kind === 'DEPARTMENT')
      .map((target) => target.id);
    const seeingUsers = new Set<string>();
    if (userIds.length > 0) {
      for (const member of await this.identity.membersInTenant(tx, userIds)) {
        if (isActiveMember(member, now) && (await this.memberSees(tx, member, access))) {
          seeingUsers.add(member.userId);
        }
      }
    }
    const departments = await this.eligibleDepartments(tx, departmentIds, access, now);
    return targets.filter((target) =>
      target.kind === 'USER' ? seeingUsers.has(target.id) : departments.has(target.id),
    );
  }
}

/** Grava os `Mention` dos alvos válidos na transação do comentário (fluxo principal, passo 4). */
@Injectable()
export class MentionWriter {
  constructor(
    @Inject(MENTION_REPOSITORY) private readonly mentions: MentionRepository,
    private readonly targets: MentionTargets,
  ) {}

  async record(
    tx: TenantTx,
    comment: Pick<Comment, 'id' | 'tenantId' | 'processId'>,
    targets: readonly MentionTarget[],
    access: ProcessAccessTarget,
    now: Date,
  ): Promise<MentionOutcome> {
    if (targets.length === 0) return NO_MENTIONS;
    const valid = await this.targets.valid(tx, targets, access, now);
    const created = await this.mentions.insertNew(
      tx,
      valid.map((target) => createMention({ id: newId(), comment, target, now })),
    );
    return { created, discarded: targets.filter((target) => !valid.includes(target)) };
  }
}
