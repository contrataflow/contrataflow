import type { CommentBody } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type {
  CommentCursor,
  CommentListFilter,
  CommentRepository,
  CommentTransactions,
} from '../application/ports.js';
import type { Comment } from '../domain/comment.js';

type Row = Prisma.CommentGetPayload<object>;

function toDomain(row: Row): Comment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    targetType: row.targetType,
    documentId: row.documentId,
    sectionKey: row.sectionKey,
    parentId: row.parentId,
    authorId: row.authorId,
    body: row.body as unknown as CommentBody,
    bodyText: row.bodyText,
    editedAt: row.editedAt,
    deletionReason: row.deletionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
    deletedAt: row.deletedAt,
    deletedById: row.deletedById,
    version: row.version,
  };
}

/** Depois do cursor: decrescente (raízes) ou crescente (respostas) por (`createdAt`, `id`). */
function afterCursor(
  after: CommentCursor | null,
  direction: 'desc' | 'asc',
): Prisma.CommentWhereInput {
  if (after === null) return {};
  const op = direction === 'desc' ? 'lt' : 'gt';
  return {
    OR: [
      { createdAt: { [op]: after.createdAt } },
      { createdAt: after.createdAt, id: { [op]: after.id } },
    ],
  };
}

/** Comentários no PostgreSQL sob a RLS do tenant da transação (`app.tenant_id`). */
@Injectable()
export class PrismaCommentRepository implements CommentRepository {
  async listRoots(
    tx: TenantTx,
    processId: string,
    filter: CommentListFilter,
    page: { readonly after: CommentCursor | null; readonly limit: number },
  ): Promise<Comment[]> {
    const rows = await tx.comment.findMany({
      where: {
        processId,
        parentId: null,
        ...(filter.targetType ? { targetType: filter.targetType } : {}),
        ...(filter.documentId ? { documentId: filter.documentId } : {}),
        ...(filter.sectionKey ? { sectionKey: filter.sectionKey } : {}),
        ...afterCursor(page.after, 'desc'),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map(toDomain);
  }

  async repliesOf(
    tx: TenantTx,
    parentIds: readonly string[],
    perParent: number,
  ): Promise<{ readonly replies: Comment[]; readonly counts: Map<string, number> }> {
    if (parentIds.length === 0) return { replies: [], counts: new Map() };
    // Uma janela por pai (ROW_NUMBER) — as primeiras `perParent` respostas de cada thread.
    const ranked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM (
        SELECT "id", ROW_NUMBER() OVER (
          PARTITION BY "parent_id" ORDER BY "created_at" ASC, "id" ASC
        ) AS "position"
        FROM "comments"
        WHERE "parent_id" = ANY(${[...parentIds]}::uuid[])
      ) AS "ranked"
      WHERE "position" <= ${perParent}`;
    const rows =
      ranked.length === 0
        ? []
        : await tx.comment.findMany({
            where: { id: { in: ranked.map((row) => row.id) } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
    const grouped = await tx.comment.groupBy({
      by: ['parentId'],
      where: { parentId: { in: [...parentIds] } },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const group of grouped) {
      if (group.parentId !== null) counts.set(group.parentId, group._count._all);
    }
    return { replies: rows.map(toDomain), counts };
  }

  async listReplies(
    tx: TenantTx,
    parentId: string,
    page: { readonly after: CommentCursor | null; readonly limit: number },
  ): Promise<Comment[]> {
    const rows = await tx.comment.findMany({
      where: { parentId, ...afterCursor(page.after, 'asc') },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: page.limit,
    });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<Comment | null> {
    const row = await tx.comment.findFirst({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async insert(tx: TenantTx, comment: Comment): Promise<void> {
    await tx.comment.create({
      data: {
        id: comment.id,
        tenantId: comment.tenantId,
        processId: comment.processId,
        targetType: comment.targetType,
        documentId: comment.documentId,
        sectionKey: comment.sectionKey,
        parentId: comment.parentId,
        authorId: comment.authorId,
        body: comment.body as Prisma.InputJsonObject,
        bodyText: comment.bodyText,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        createdById: comment.authorId,
        updatedById: comment.updatedById,
        version: comment.version,
      },
    });
  }

  async save(tx: TenantTx, comment: Comment, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'Comment', aggregateId: comment.id, expectedVersion },
      () =>
        tx.comment.updateMany({
          where: { id: comment.id, version: expectedVersion, deletedAt: null },
          data: {
            body: comment.body as Prisma.InputJsonObject,
            bodyText: comment.bodyText,
            editedAt: comment.editedAt,
            deletionReason: comment.deletionReason,
            deletedAt: comment.deletedAt,
            deletedById: comment.deletedById,
            updatedAt: comment.updatedAt,
            updatedById: comment.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  countReplies(tx: TenantTx, parentId: string): Promise<number> {
    return tx.comment.count({ where: { parentId, deletedAt: null } });
  }

  async excerpts(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<
    Map<
      string,
      { readonly bodyText: string; readonly documentId: string | null; readonly isDeleted: boolean }
    >
  > {
    if (ids.length === 0) return new Map();
    const rows = await tx.comment.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, bodyText: true, documentId: true, deletedAt: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        { bodyText: row.bodyText, documentId: row.documentId, isDeleted: row.deletedAt !== null },
      ]),
    );
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaCommentTransactions implements CommentTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}
