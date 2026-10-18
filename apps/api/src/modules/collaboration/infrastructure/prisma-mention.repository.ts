import { Injectable } from '@nestjs/common';

import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type { MentionRepository } from '../application/ports.js';
import type { Mention } from '../domain/mention.js';

type Row = Prisma.MentionGetPayload<object>;

const toDomain = (row: Row): Mention => ({
  id: row.id,
  tenantId: row.tenantId,
  commentId: row.commentId,
  processId: row.processId,
  mentionedUserId: row.mentionedUserId,
  mentionedDepartmentId: row.mentionedDepartmentId,
  notifiedAt: row.notifiedAt,
  createdAt: row.createdAt,
});

/** Menções no PostgreSQL sob a RLS do tenant da transação (`app.tenant_id`). */
@Injectable()
export class PrismaMentionRepository implements MentionRepository {
  async listByComments(tx: TenantTx, commentIds: readonly string[]): Promise<Mention[]> {
    if (commentIds.length === 0) return [];
    const rows = await tx.mention.findMany({
      where: { commentId: { in: [...commentIds] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async insertNew(tx: TenantTx, mentions: readonly Mention[]): Promise<Mention[]> {
    const inserted: Mention[] = [];
    // Em sequência (a transação interativa executa uma instrução por vez); poucas por comentário.
    for (const mention of mentions) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "mentions" ("id", "tenant_id", "comment_id", "process_id",
                                "mentioned_user_id", "mentioned_department_id", "created_at")
        VALUES (${mention.id}::uuid, ${mention.tenantId}::uuid, ${mention.commentId}::uuid,
                ${mention.processId}::uuid, ${mention.mentionedUserId}::uuid,
                ${mention.mentionedDepartmentId}::uuid, ${mention.createdAt})
        ON CONFLICT DO NOTHING
        RETURNING "id"`;
      if (rows.length > 0) inserted.push(mention);
    }
    return inserted;
  }
}
