import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';
import { withLockTiming } from '#shared/database/row-lock.js';

import { SavedViewNameTakenError } from '../application/ports.js';
import type { SavedViewRepository } from '../application/ports.js';
import { restoreSavedViewCriteria, savedViewNameKey } from '../domain/saved-view.js';
import type { SavedView } from '../domain/saved-view.js';

/*
 * `saved_views` (US-003): PostgreSQL sob a RLS do tenant da transação e o equivalente em memória
 * (testes e modo de identidade fake). `filters`/`columns` voltam pelo upcaster do domínio.
 */

type Row = Prisma.SavedViewGetPayload<object>;

function toDomain(row: Row): SavedView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerId: row.ownerId,
    scope: row.scope,
    name: row.name,
    ...restoreSavedViewCriteria({ filters: row.filters, columns: row.columns }),
    sort: row.sort,
    isShared: row.isShared,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function editable(view: SavedView) {
  return {
    name: view.name,
    filters: view.filters as unknown as Prisma.InputJsonObject,
    sort: view.sort,
    columns: [...view.columns],
    isShared: view.isShared,
    isDefault: view.isDefault,
    updatedAt: view.updatedAt,
    updatedById: view.updatedById,
  };
}

/** Índice `lower(name)` (V-02); a padrão única é serializada pela trava do dono e escopo. */
function nameTaken(error: unknown): never {
  if (isUniqueViolation(error)) throw new SavedViewNameTakenError();
  throw error;
}

@Injectable()
export class PrismaSavedViewRepository implements SavedViewRepository {
  async lockOwnerScope(tx: TenantTx, ownerId: string, scope: SavedView['scope']): Promise<void> {
    const key = `saved-view:${ownerId}:${scope}`;
    await withLockTiming(
      { lockType: 'advisory', tableName: 'saved_views' },
      () => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  async listOwned(tx: TenantTx, ownerId: string, scope: SavedView['scope']): Promise<SavedView[]> {
    const rows = await tx.savedView.findMany({
      where: { ownerId, scope },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async listSharedByOthers(
    tx: TenantTx,
    userId: string,
    scope: SavedView['scope'],
  ): Promise<SavedView[]> {
    const rows = await tx.savedView.findMany({
      where: { scope, isShared: true, ownerId: { not: userId } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<SavedView | null> {
    const row = await tx.savedView.findFirst({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async clearDefault(
    tx: TenantTx,
    ownerId: string,
    scope: SavedView['scope'],
    exceptId: string | null,
  ): Promise<void> {
    const { actor } = requireRequestContext();
    await tx.savedView.updateMany({
      where: { ownerId, scope, isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: {
        isDefault: false,
        updatedAt: new Date(),
        updatedById: actor.userId,
        version: { increment: 1 },
      },
    });
  }

  async insert(tx: TenantTx, view: SavedView): Promise<void> {
    await tx.savedView
      .create({
        data: {
          ...editable(view),
          id: view.id,
          tenantId: view.tenantId,
          ownerId: view.ownerId,
          scope: view.scope,
          createdAt: view.createdAt,
          createdById: view.createdById,
          version: view.version,
        },
      })
      .catch(nameTaken);
  }

  async update(tx: TenantTx, view: SavedView, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'SavedView', aggregateId: view.id, expectedVersion },
      () =>
        tx.savedView
          .updateMany({
            where: { id: view.id, version: expectedVersion },
            data: { ...editable(view), version: { increment: 1 } },
          })
          .catch(nameTaken),
    );
  }

  async delete(tx: TenantTx, view: SavedView, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'SavedView', aggregateId: view.id, expectedVersion },
      () => tx.savedView.deleteMany({ where: { id: view.id, version: expectedVersion } }),
    );
  }
}

/** Visões em memória (testes e modo fake), do tenant do contexto. */
@Injectable()
export class InMemorySavedViewRepository implements SavedViewRepository {
  private readonly views = new Map<string, SavedView>();

  private tenant(): string {
    return requireRequestContext().tenantId ?? '';
  }

  private owned(): SavedView[] {
    const tenantId = this.tenant();
    return [...this.views.values()]
      .filter((view) => view.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id));
  }

  /** Carga de teste (inclusive de outro tenant). */
  seed(view: SavedView): void {
    this.views.set(view.id, structuredClone(view));
  }

  snapshot(): SavedView[] {
    return structuredClone([...this.views.values()]);
  }

  lockOwnerScope(): Promise<void> {
    return Promise.resolve();
  }

  listOwned(_tx: TenantTx, ownerId: string, scope: SavedView['scope']): Promise<SavedView[]> {
    return Promise.resolve(
      structuredClone(
        this.owned().filter((view) => view.ownerId === ownerId && view.scope === scope),
      ),
    );
  }

  listSharedByOthers(
    _tx: TenantTx,
    userId: string,
    scope: SavedView['scope'],
  ): Promise<SavedView[]> {
    return Promise.resolve(
      structuredClone(
        this.owned().filter(
          (view) => view.scope === scope && view.isShared && view.ownerId !== userId,
        ),
      ),
    );
  }

  findById(_tx: TenantTx, id: string): Promise<SavedView | null> {
    const view = this.views.get(id);
    return Promise.resolve(view?.tenantId === this.tenant() ? structuredClone(view) : null);
  }

  clearDefault(
    _tx: TenantTx,
    ownerId: string,
    scope: SavedView['scope'],
    exceptId: string | null,
  ): Promise<void> {
    for (const view of this.owned()) {
      if (
        view.ownerId === ownerId &&
        view.scope === scope &&
        view.isDefault &&
        view.id !== exceptId
      ) {
        this.views.set(view.id, { ...view, isDefault: false, version: view.version + 1 });
      }
    }
    return Promise.resolve();
  }

  private assertNameFree(view: SavedView): void {
    const key = savedViewNameKey(view.name);
    const taken = this.owned().some(
      (other) =>
        other.id !== view.id &&
        other.ownerId === view.ownerId &&
        other.scope === view.scope &&
        savedViewNameKey(other.name) === key,
    );
    if (taken) throw new SavedViewNameTakenError();
  }

  insert(_tx: TenantTx, view: SavedView): Promise<void> {
    this.assertNameFree(view);
    this.views.set(view.id, structuredClone(view));
    return Promise.resolve();
  }

  async update(_tx: TenantTx, view: SavedView, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'SavedView', aggregateId: view.id, expectedVersion },
      () => {
        const current = this.views.get(view.id);
        if (current?.tenantId !== this.tenant() || current.version !== expectedVersion) {
          return Promise.resolve(0);
        }
        this.assertNameFree(view);
        this.views.set(view.id, structuredClone({ ...view, version: expectedVersion + 1 }));
        return Promise.resolve(1);
      },
    );
  }

  async delete(_tx: TenantTx, view: SavedView, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'SavedView', aggregateId: view.id, expectedVersion },
      () => {
        const current = this.views.get(view.id);
        if (current?.tenantId !== this.tenant() || current.version !== expectedVersion) {
          return Promise.resolve(0);
        }
        this.views.delete(view.id);
        return Promise.resolve(1);
      },
    );
  }
}
