import { Injectable } from '@nestjs/common';

import type { PlatformOperator, PlatformOperatorPort } from '#shared/auth/ports.js';
import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { PlatformTransaction } from '#shared/database/platform-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_USERS } from '#shared/testing/fake-directory.js';

import type {
  FirstAdminStore,
  IdentityTenantTransactions,
  InternalMember,
} from '../application/ports.js';

/**
 * Primeiro administrador e operadores da plataforma no PostgreSQL: `users` pelo
 * `PlatformTransaction` (tabela de plataforma) e `tenant_memberships` no `tx` do tenant novo.
 */
@Injectable()
export class PrismaFirstAdminStore implements FirstAdminStore, PlatformOperatorPort {
  constructor(private readonly platform: PlatformTransaction) {}

  async findOrCreateUser(input: {
    id: string;
    email: string;
    name: string;
    now: Date;
  }): Promise<{ id: string; created: boolean }> {
    const existing = await this.platform.read((tx) =>
      tx.user.findUnique({ where: { email: input.email }, select: { id: true } }),
    );
    if (existing) return { id: existing.id, created: false };
    try {
      await this.platform.run((tx) =>
        tx.user.create({
          data: {
            id: input.id,
            email: input.email,
            name: input.name,
            createdAt: input.now,
            updatedAt: input.now,
          },
          select: { id: true },
        }),
      );
      return { id: input.id, created: true };
    } catch (error) {
      // Corrida com outro provisionamento/convite do mesmo e-mail: reutiliza a identidade.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.platform.read((tx) =>
        tx.user.findUniqueOrThrow({ where: { email: input.email }, select: { id: true } }),
      );
      return { id: raced.id, created: false };
    }
  }

  async internalMembers(tx: TenantTx): Promise<InternalMember[]> {
    // `users` é de plataforma (sem RLS): o vínculo, filtrado pela RLS, restringe ao tenant do tx.
    const rows = await tx.$queryRaw<
      { membership_id: string; user_id: string; email: string; status: string }[]
    >`
      SELECT m.id AS membership_id, m.user_id, u.email::text AS email, m.status::text AS status
        FROM tenant_memberships m
        JOIN users u ON u.id = m.user_id
       WHERE m.type = 'INTERNAL'
       ORDER BY m.created_at, m.id`;
    return rows.map((row) => ({
      membershipId: row.membership_id,
      userId: row.user_id,
      email: row.email,
      status: row.status,
    }));
  }

  async insertInvitedMembership(
    tx: TenantTx,
    membership: { id: string; tenantId: string; userId: string; now: Date },
  ): Promise<boolean> {
    const inserted = await tx.$executeRaw`
      INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, created_at, updated_at)
      VALUES (${membership.id}::uuid, ${membership.tenantId}::uuid, ${membership.userId}::uuid,
              'INTERNAL', 'INVITED', ${membership.now}, ${membership.now})
      ON CONFLICT (tenant_id, user_id) DO NOTHING`;
    return inserted === 1;
  }

  findOperatorById(userId: string): Promise<PlatformOperator | null> {
    return this.findOperator({ id: userId });
  }

  findOperatorByEmail(email: string): Promise<PlatformOperator | null> {
    return this.findOperator({ email });
  }

  private async findOperator(
    where: { id: string } | { email: string },
  ): Promise<PlatformOperator | null> {
    const row = await this.platform.read((tx) =>
      tx.user.findUnique({
        where,
        select: {
          id: true,
          name: true,
          socialName: true,
          email: true,
          status: true,
          isPlatformOperator: true,
        },
      }),
    );
    return row
      ? {
          id: row.id,
          name: row.socialName ?? row.name,
          email: row.email,
          status: row.status,
          isPlatformOperator: row.isPlatformOperator,
        }
      : null;
  }
}

@Injectable()
export class PrismaIdentityTenantTransactions implements IdentityTenantTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

interface StoredMember extends InternalMember {
  readonly tenantId: string;
}

/**
 * Testes e modo de identidade fake: usuários criados pelo provisionamento e vínculos isolados pelo
 * tenant do contexto (como a RLS); operadores do diretório fake (`isPlatformOperator`).
 */
export class InMemoryFirstAdminStore
  implements FirstAdminStore, PlatformOperatorPort, IdentityTenantTransactions
{
  private readonly users = new Map<string, { id: string; email: string; name: string }>();
  private readonly members: StoredMember[] = [];
  /** Falha injetada na próxima escrita (testes de indisponibilidade). */
  failNextWrite: Error | null = null;

  constructor() {
    for (const user of Object.values(FAKE_USERS)) {
      this.users.set(user.email.toLowerCase(), { id: user.id, email: user.email, name: user.name });
    }
  }

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  findOrCreateUser(input: {
    id: string;
    email: string;
    name: string;
  }): Promise<{ id: string; created: boolean }> {
    const failure = this.failNextWrite;
    this.failNextWrite = null;
    if (failure) return Promise.reject(failure);
    const existing = this.users.get(input.email.toLowerCase());
    if (existing) return Promise.resolve({ id: existing.id, created: false });
    this.users.set(input.email.toLowerCase(), {
      id: input.id,
      email: input.email,
      name: input.name,
    });
    return Promise.resolve({ id: input.id, created: true });
  }

  internalMembers(_tx: TenantTx): Promise<InternalMember[]> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return Promise.resolve(
      this.members
        .filter((member) => member.tenantId === tenantId)
        .map(({ tenantId: _tenant, ...member }) => member),
    );
  }

  insertInvitedMembership(
    _tx: TenantTx,
    membership: { id: string; tenantId: string; userId: string },
  ): Promise<boolean> {
    if (membership.tenantId !== currentRequestContext()?.tenantId) {
      return Promise.reject(new Error('Vínculo de outro tenant.'));
    }
    if (
      this.members.some((m) => m.tenantId === membership.tenantId && m.userId === membership.userId)
    ) {
      return Promise.resolve(false);
    }
    const user = [...this.users.values()].find((candidate) => candidate.id === membership.userId);
    this.members.push({
      membershipId: membership.id,
      tenantId: membership.tenantId,
      userId: membership.userId,
      email: user?.email ?? '',
      status: 'INVITED',
    });
    return Promise.resolve(true);
  }

  /** Testes: vínculos do tenant, sem filtro de contexto. */
  membersOf(tenantId: string): readonly InternalMember[] {
    return this.members.filter((member) => member.tenantId === tenantId);
  }

  findOperatorById(userId: string): Promise<PlatformOperator | null> {
    return Promise.resolve(this.operator((user) => user.id === userId));
  }

  findOperatorByEmail(email: string): Promise<PlatformOperator | null> {
    return Promise.resolve(this.operator((user) => user.email === email.toLowerCase()));
  }

  private operator(
    match: (user: { readonly id: string; readonly email: string }) => boolean,
  ): PlatformOperator | null {
    const user = Object.values(FAKE_USERS).find((candidate) => match(candidate));
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      isPlatformOperator: 'isPlatformOperator' in user && user.isPlatformOperator,
    };
  }
}
