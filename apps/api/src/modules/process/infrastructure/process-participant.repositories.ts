import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import { ParticipantAlreadyActiveError } from '../application/ports.js';
import type {
  ProcessParticipantReference,
  ProcessParticipantRepository,
} from '../application/ports.js';
import type { ProcessParticipant } from '../domain/process-participants.js';

/*
 * `process_participants` (US-012): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS do
 * tenant + extensão de isolamento); em memória para os testes e o modo de identidade fake (isolados
 * pelo tenant do contexto, como a RLS). A unicidade do participante ativo é dos índices únicos
 * parciais (RN-PROC-129): a segunda concessão simultânea espera a primeira e recebe 23505.
 */

type ParticipantRow = Prisma.ProcessParticipantGetPayload<object>;

function toParticipant(row: ParticipantRow): ProcessParticipant {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    userId: row.userId,
    departmentId: row.departmentId,
    role: row.role,
    notify: row.notify,
    grantedById: row.grantedById,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
    reason: row.reason,
    revokedAt: row.revokedAt,
    revokedById: row.revokedById,
    revocationReason: row.revocationReason,
  };
}

type Principal = { readonly userId: string } | { readonly departmentId: string };

@Injectable()
export class PrismaProcessParticipantRepository implements ProcessParticipantRepository {
  async listActive(tx: TenantTx, processId: string): Promise<ProcessParticipant[]> {
    const rows = await tx.processParticipant.findMany({
      where: { processId, revokedAt: null },
      orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toParticipant);
  }

  async findActive(
    tx: TenantTx,
    processId: string,
    principal: Principal,
  ): Promise<ProcessParticipant | null> {
    const row = await tx.processParticipant.findFirst({
      where: { processId, revokedAt: null, ...principal },
    });
    return row === null ? null : toParticipant(row);
  }

  async lockActive(tx: TenantTx, participantId: string): Promise<ProcessParticipant | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT pp.id
        FROM process_participants pp
       WHERE pp.tenant_id = current_setting('app.tenant_id')::uuid
         AND pp.id = ${participantId}::uuid
         AND pp.revoked_at IS NULL
         FOR UPDATE`;
    if (locked.length === 0) return null;
    const row = await tx.processParticipant.findFirst({ where: { id: participantId } });
    return row === null ? null : toParticipant(row);
  }

  async insert(tx: TenantTx, participant: ProcessParticipant): Promise<void> {
    try {
      await tx.processParticipant.create({
        data: {
          id: participant.id,
          tenantId: participant.tenantId,
          processId: participant.processId,
          userId: participant.userId,
          departmentId: participant.departmentId,
          role: participant.role,
          notify: participant.notify,
          grantedById: participant.grantedById,
          grantedAt: participant.grantedAt,
          expiresAt: participant.expiresAt,
          reason: participant.reason,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ParticipantAlreadyActiveError();
      throw error;
    }
  }

  async revoke(tx: TenantTx, participant: ProcessParticipant): Promise<void> {
    await tx.processParticipant.updateMany({
      where: { id: participant.id, revokedAt: null },
      data: {
        revokedAt: participant.revokedAt,
        revokedById: participant.revokedById,
        revocationReason: participant.revocationReason,
      },
    });
  }

  async references(
    tx: TenantTx,
    participantIds: readonly string[],
  ): Promise<Map<string, ProcessParticipantReference>> {
    if (participantIds.length === 0) return new Map();
    const rows = await tx.processParticipant.findMany({
      where: { id: { in: [...participantIds] } },
      select: { id: true, userId: true, departmentId: true, role: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        { userId: row.userId, departmentId: row.departmentId, role: row.role },
      ]),
    );
  }
}

function tenantOfContext(): string {
  return requireRequestContext().tenantId ?? '';
}

const samePrincipal = (participant: ProcessParticipant, principal: Principal) =>
  'userId' in principal
    ? participant.userId === principal.userId
    : participant.departmentId === principal.departmentId;

/**
 * Participantes em memória (testes e modo de identidade fake): isolados pelo tenant do contexto,
 * com a unicidade do participante ativo dos índices parciais. Concorrência real, RLS e o gatilho
 * de colunas imutáveis são cobertos contra o PostgreSQL em `test/tenant-leak/process-participants.spec.ts`.
 */
@Injectable()
export class InMemoryProcessParticipantRepository implements ProcessParticipantRepository {
  private readonly rows = new Map<string, ProcessParticipant>();

  private owned(): ProcessParticipant[] {
    const tenantId = tenantOfContext();
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  listActive(_tx: TenantTx, processId: string): Promise<ProcessParticipant[]> {
    return Promise.resolve(
      structuredClone(
        this.owned()
          .filter((row) => row.processId === processId && row.revokedAt === null)
          .sort(
            (a, b) => a.grantedAt.getTime() - b.grantedAt.getTime() || a.id.localeCompare(b.id),
          ),
      ),
    );
  }

  findActive(
    _tx: TenantTx,
    processId: string,
    principal: Principal,
  ): Promise<ProcessParticipant | null> {
    const found = this.owned().find(
      (row) =>
        row.processId === processId && row.revokedAt === null && samePrincipal(row, principal),
    );
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  lockActive(_tx: TenantTx, participantId: string): Promise<ProcessParticipant | null> {
    const found = this.owned().find((row) => row.id === participantId && row.revokedAt === null);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  insert(_tx: TenantTx, participant: ProcessParticipant): Promise<void> {
    const principal: Principal =
      participant.userId !== null
        ? { userId: participant.userId }
        : { departmentId: participant.departmentId ?? '' };
    const duplicate = [...this.rows.values()].some(
      (row) =>
        row.tenantId === participant.tenantId &&
        row.processId === participant.processId &&
        row.revokedAt === null &&
        samePrincipal(row, principal),
    );
    if (duplicate) return Promise.reject(new ParticipantAlreadyActiveError());
    this.rows.set(participant.id, structuredClone(participant));
    return Promise.resolve();
  }

  revoke(_tx: TenantTx, participant: ProcessParticipant): Promise<void> {
    const current = this.rows.get(participant.id);
    if (current?.tenantId === tenantOfContext() && current.revokedAt === null) {
      this.rows.set(participant.id, {
        ...current,
        revokedAt: participant.revokedAt,
        revokedById: participant.revokedById,
        revocationReason: participant.revocationReason,
      });
    }
    return Promise.resolve();
  }

  references(
    _tx: TenantTx,
    participantIds: readonly string[],
  ): Promise<Map<string, ProcessParticipantReference>> {
    const refs = new Map<string, ProcessParticipantReference>();
    for (const row of this.owned()) {
      if (participantIds.includes(row.id)) {
        refs.set(row.id, { userId: row.userId, departmentId: row.departmentId, role: row.role });
      }
    }
    return Promise.resolve(refs);
  }

  // --- Inspeção e carga (testes) ---------------------------------------------------------------

  /** Participações de todos os tenants (revogadas inclusive). */
  all(): readonly ProcessParticipant[] {
    return [...this.rows.values()];
  }

  /** Grava (ou substitui) uma participação — ex.: consultor com validade vencida. */
  put(participant: ProcessParticipant): void {
    this.rows.set(participant.id, structuredClone(participant));
  }

  /** Participações não revogadas de um processo, sem o contexto de tenant (runtime em memória). */
  activeOf(processId: string): ProcessParticipant[] {
    return [...this.rows.values()].filter(
      (row) => row.processId === processId && row.revokedAt === null,
    );
  }
}
