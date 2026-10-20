import { MENTION_LIMITS } from '@contrataflow/validation';
import type { MentionCandidateDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { CommentGate } from './comment.support.js';
import type { CommentProcess } from './comment.support.js';
import { MentionTargets } from './mention.support.js';
import { COMMENT_CLOCK, COMMENT_TRANSACTIONS } from './ports.js';
import type { CommentClock, CommentTransactions } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';

/*
 * `SearchMentionCandidatesQuery` — CMT-05 (US-072 · RN-CMT-21 · fluxo principal, passo 2): processo
 * visível (404) e `COMMENT_CREATE` (403); usuários com vínculo ativo que veem o processo e unidades
 * ativas que o veem com até 50 membros ativos, filtrados por `q` (nome/e-mail ou nome/sigla), até
 * 10 em ordem alfabética. A visibilidade é revalidada no commit do comentário (RN-CMT-22). Leitura:
 * sem auditoria.
 */

/** Usuários examinados por busca (o predicado de visibilidade é calculado por usuário). */
const USER_SCAN = 30;
/** Unidades examinadas por busca. */
const DEPARTMENT_SCAN = 50;

const byLabel = (a: MentionCandidateDto, b: MentionCandidateDto) =>
  a.label.localeCompare(b.label, 'pt-BR') || a.id.localeCompare(b.id);

@Injectable()
export class SearchMentionCandidatesQuery {
  constructor(
    @Inject(COMMENT_TRANSACTIONS) private readonly transactions: CommentTransactions,
    @Inject(COMMENT_CLOCK) private readonly clock: CommentClock,
    private readonly gate: CommentGate,
    private readonly targets: MentionTargets,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  execute(processId: string, q: string): Promise<MentionCandidateDto[]> {
    return this.transactions.read(async (tx) => {
      const process = await this.gate.visibleProcess(tx, processId);
      await this.gate.assertCanComment(process);
      const now = this.clock();
      const users = await this.users(tx, q, process, now);
      const departments = await this.departments(tx, q, process, now);
      return [...users, ...departments].sort(byLabel).slice(0, MENTION_LIMITS.maxCandidates);
    });
  }

  private async users(
    tx: TenantTx,
    q: string,
    process: CommentProcess,
    now: Date,
  ): Promise<MentionCandidateDto[]> {
    const found: { userId: string; name: string }[] = [];
    for (const member of await this.identity.searchActiveMembers(tx, q, USER_SCAN, now)) {
      if (found.length >= MENTION_LIMITS.maxCandidates) break;
      if (await this.targets.memberSees(tx, member, process.access)) found.push(member);
    }
    // Unidade de lotação principal (a primeira) como rótulo secundário.
    const firstDepartment = new Map<string, string>();
    for (const { userId } of found) {
      const [departmentId] = await this.identity.departmentsOfUser(tx, userId);
      if (departmentId !== undefined) firstDepartment.set(userId, departmentId);
    }
    const names = await this.organization.departmentNames(tx, [...firstDepartment.values()]);
    return found.map(({ userId, name }) => {
      const departmentName = names.get(firstDepartment.get(userId) ?? '');
      return {
        kind: 'USER',
        id: userId,
        label: name,
        ...(departmentName === undefined ? {} : { secondaryLabel: departmentName }),
      };
    });
  }

  private async departments(
    tx: TenantTx,
    q: string,
    process: CommentProcess,
    now: Date,
  ): Promise<MentionCandidateDto[]> {
    const found = await this.organization.searchActiveDepartments(tx, q, DEPARTMENT_SCAN);
    const eligible = await this.targets.eligibleDepartments(
      tx,
      found.map((department) => department.id),
      process.access,
      now,
    );
    return found
      .filter((department) => eligible.has(department.id))
      .map((department) => ({
        kind: 'DEPARTMENT',
        id: department.id,
        label: department.name,
        ...(department.acronym === null ? {} : { secondaryLabel: department.acronym }),
      }));
  }
}
