import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import { TagNameTakenError } from '../application/ports.js';
import type { TagRepository } from '../application/ports.js';
import type { Tag, TagSetDiff } from '../domain/tag.js';

/*
 * `tags` e `process_tags` (US-007): PostgreSQL sob a RLS do tenant da transação e o equivalente em
 * memória (testes e modo de identidade fake). A unicidade `lower(name)` é do índice único.
 */

type Row = Prisma.TagGetPayload<object>;

function toDomain(row: Row): Tag {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    color: row.color,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

const byName = (a: Tag, b: Tag) =>
  a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id);

function nameTaken(error: unknown): never {
  if (isUniqueViolation(error)) throw new TagNameTakenError();
  throw error;
}

@Injectable()
export class PrismaTagRepository implements TagRepository {
  async list(tx: TenantTx, includeInactive: boolean): Promise<Tag[]> {
    const rows = await tx.tag.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<Tag | null> {
    const row = await tx.tag.findFirst({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByIds(tx: TenantTx, ids: readonly string[]): Promise<Tag[]> {
    if (ids.length === 0) return [];
    const rows = await tx.tag.findMany({ where: { id: { in: [...ids] } } });
    return rows.map(toDomain);
  }

  async insert(tx: TenantTx, tag: Tag): Promise<void> {
    await tx.tag
      .create({
        data: {
          id: tag.id,
          tenantId: tag.tenantId,
          name: tag.name,
          color: tag.color,
          isActive: tag.isActive,
          createdAt: tag.createdAt,
          updatedAt: tag.updatedAt,
          createdById: tag.createdById,
          updatedById: tag.updatedById,
          version: tag.version,
        },
      })
      .catch(nameTaken);
  }

  async update(tx: TenantTx, tag: Tag, expectedVersion: number): Promise<void> {
    await updateVersioned({ aggregateType: 'Tag', aggregateId: tag.id, expectedVersion }, () =>
      tx.tag
        .updateMany({
          where: { id: tag.id, version: expectedVersion },
          data: {
            name: tag.name,
            color: tag.color,
            isActive: tag.isActive,
            updatedAt: tag.updatedAt,
            updatedById: tag.updatedById,
            version: { increment: 1 },
          },
        })
        .catch(nameTaken),
    );
  }

  async forProcesses(tx: TenantTx, processIds: readonly string[]): Promise<Map<string, Tag[]>> {
    const result = new Map<string, Tag[]>();
    if (processIds.length === 0) return result;
    const links = await tx.processTag.findMany({ where: { processId: { in: [...processIds] } } });
    const tags = new Map(
      (await this.findByIds(tx, [...new Set(links.map((link) => link.tagId))])).map((tag) => [
        tag.id,
        tag,
      ]),
    );
    for (const link of links) {
      const tag = tags.get(link.tagId);
      if (tag === undefined) continue;
      result.set(link.processId, [...(result.get(link.processId) ?? []), tag]);
    }
    for (const list of result.values()) list.sort(byName);
    return result;
  }

  async applyDiff(
    tx: TenantTx,
    processId: string,
    diff: TagSetDiff,
    at: Date,
    userId: string | null,
  ): Promise<void> {
    if (diff.removed.length > 0) {
      await tx.processTag.deleteMany({ where: { processId, tagId: { in: [...diff.removed] } } });
    }
    if (diff.added.length > 0) {
      const { tenantId } = requireRequestContext();
      await tx.processTag.createMany({
        data: diff.added.map((tagId) => ({
          tenantId: tenantId ?? '',
          processId,
          tagId,
          createdAt: at,
          createdById: userId,
        })),
      });
    }
  }
}

/** Etiquetas em memória (testes e modo fake), do tenant do contexto. */
@Injectable()
export class InMemoryTagRepository implements TagRepository {
  private readonly tags = new Map<string, Tag>();
  /** `processId` → ids de etiqueta (o tenant é o do processo, já travado pelo chamador). */
  private readonly links = new Map<string, Set<string>>();

  private tenant(): string {
    return requireRequestContext().tenantId ?? '';
  }

  private owned(): Tag[] {
    const tenantId = this.tenant();
    return [...this.tags.values()].filter((tag) => tag.tenantId === tenantId).sort(byName);
  }

  /** Carga de teste (inclusive de outro tenant). */
  seed(tag: Tag): void {
    this.tags.set(tag.id, structuredClone(tag));
  }

  /** Carga de teste: associação direta processo × etiqueta. */
  seedLink(processId: string, tagId: string): void {
    this.links.set(processId, new Set([...(this.links.get(processId) ?? []), tagId]));
  }

  snapshot(): Tag[] {
    return structuredClone([...this.tags.values()]);
  }

  /** Ids de etiqueta do processo (filtro da lista em memória). */
  tagIdsOf(processId: string): string[] {
    return [...(this.links.get(processId) ?? [])];
  }

  /** Limpa o estado entre testes. */
  reset(): void {
    this.tags.clear();
    this.links.clear();
  }

  list(_tx: TenantTx, includeInactive: boolean): Promise<Tag[]> {
    return Promise.resolve(
      structuredClone(this.owned().filter((tag) => includeInactive || tag.isActive)),
    );
  }

  findById(_tx: TenantTx, id: string): Promise<Tag | null> {
    const tag = this.tags.get(id);
    return Promise.resolve(tag?.tenantId === this.tenant() ? structuredClone(tag) : null);
  }

  findByIds(_tx: TenantTx, ids: readonly string[]): Promise<Tag[]> {
    const wanted = new Set(ids);
    return Promise.resolve(structuredClone(this.owned().filter((tag) => wanted.has(tag.id))));
  }

  private assertNameFree(tag: Tag): void {
    const key = tag.name.trim().toLowerCase();
    const taken = this.owned().some(
      (other) => other.id !== tag.id && other.name.trim().toLowerCase() === key,
    );
    if (taken) throw new TagNameTakenError();
  }

  insert(_tx: TenantTx, tag: Tag): Promise<void> {
    this.assertNameFree(tag);
    this.tags.set(tag.id, structuredClone(tag));
    return Promise.resolve();
  }

  async update(_tx: TenantTx, tag: Tag, expectedVersion: number): Promise<void> {
    await updateVersioned({ aggregateType: 'Tag', aggregateId: tag.id, expectedVersion }, () => {
      const current = this.tags.get(tag.id);
      if (current?.tenantId !== this.tenant() || current.version !== expectedVersion) {
        return Promise.resolve(0);
      }
      this.assertNameFree(tag);
      this.tags.set(tag.id, structuredClone({ ...tag, version: expectedVersion + 1 }));
      return Promise.resolve(1);
    });
  }

  forProcesses(_tx: TenantTx, processIds: readonly string[]): Promise<Map<string, Tag[]>> {
    const result = new Map<string, Tag[]>();
    for (const processId of processIds) {
      const tags = [...(this.links.get(processId) ?? [])]
        .flatMap((id) => {
          const tag = this.tags.get(id);
          return tag?.tenantId === this.tenant() ? [structuredClone(tag)] : [];
        })
        .sort(byName);
      if (tags.length > 0) result.set(processId, tags);
    }
    return Promise.resolve(result);
  }

  applyDiff(
    _tx: TenantTx,
    processId: string,
    diff: TagSetDiff,
    _at: Date,
    _userId: string | null,
  ): Promise<void> {
    const set = new Set(this.links.get(processId) ?? []);
    for (const id of diff.removed) set.delete(id);
    for (const id of diff.added) set.add(id);
    this.links.set(processId, set);
    return Promise.resolve();
  }
}
