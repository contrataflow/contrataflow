import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { MentionRepository } from '../application/ports.js';
import type { Mention } from '../domain/mention.js';

const sameTarget = (a: Mention, b: Mention) =>
  a.tenantId === b.tenantId &&
  a.commentId === b.commentId &&
  a.mentionedUserId === b.mentionedUserId &&
  a.mentionedDepartmentId === b.mentionedDepartmentId;

/**
 * Menções em memória (testes e modo de identidade fake): mesma semântica do adaptador Prisma —
 * isolamento pelo tenant do contexto e um registro por alvo por comentário (`ON CONFLICT DO NOTHING`).
 */
@Injectable()
export class InMemoryMentionRepository implements MentionRepository {
  private readonly rows: Mention[] = [];

  listByComments(_tx: TenantTx, commentIds: readonly string[]): Promise<Mention[]> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const wanted = new Set(commentIds);
    return Promise.resolve(
      this.rows.filter((row) => row.tenantId === tenantId && wanted.has(row.commentId)),
    );
  }

  insertNew(_tx: TenantTx, mentions: readonly Mention[]): Promise<Mention[]> {
    const inserted: Mention[] = [];
    for (const mention of mentions) {
      if (this.rows.some((row) => sameTarget(row, mention))) continue;
      this.rows.push(mention);
      inserted.push(mention);
    }
    return Promise.resolve(inserted);
  }

  /** Inspeção de testes: todas as menções (de todos os tenants). */
  snapshot(): readonly Mention[] {
    return [...this.rows];
  }
}
