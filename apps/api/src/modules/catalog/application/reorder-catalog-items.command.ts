import type { CatalogType } from '@contrataflow/types';
import { CatalogItemChanged } from '@contrataflow/validation';
import type { CatalogItemDto, ReorderCatalogItems } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { CATALOG_CLOCK, CATALOG_ITEM_REPOSITORY, CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogClock, CatalogItemRepository, CatalogTransactions } from './catalog-ports.js';
import { catalogOrderInvalid, logOperationFailure } from './catalog.errors.js';
import { toCatalogItemDto } from './catalog.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { CatalogOrderInvalidError, planReorder } from '../domain/catalog-item.js';
import type { CatalogItem } from '../domain/catalog-item.js';

export interface ReorderCatalogItemsInput {
  readonly catalogType: CatalogType;
  readonly body: ReorderCatalogItems;
}

/**
 * `ReorderCatalogItemsCommand` — CAT-06 (US-104 · fluxo principal, passo 7 · RN-TEN-65): recebe a
 * lista completa de IDs do catálogo na ordem final e recalcula `sortOrder` sequencialmente. Trava
 * as linhas do catálogo (`FOR UPDATE`) para que reordenações concorrentes serializem sem corromper
 * a ordem; ID alheio ao catálogo/tenant ou lista incompleta bloqueia a operação inteira. Grava
 * UM `catalog.update` e um `CatalogItemChanged` (`UPDATED`) por item cuja posição mudou; ordem
 * idêntica → 200 sem efeitos.
 */
@Injectable()
export class ReorderCatalogItemsCommand {
  private readonly logger = new Logger('Catalog');

  constructor(
    @Inject(CATALOG_ITEM_REPOSITORY) private readonly items: CatalogItemRepository,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
    @Inject(CATALOG_CLOCK) private readonly clock: CatalogClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: ReorderCatalogItemsInput): Promise<CatalogItemDto[]> {
    this.access.assertCan('CATALOG_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    let result: { ordered: CatalogItem[]; moved: number };
    try {
      result = await this.transactions.run(async (tx) => {
        const current = await this.items.listAll(tx, input.catalogType, true);
        let plan;
        try {
          plan = planReorder(current, input.body.orderedIds);
        } catch (error) {
          if (error instanceof CatalogOrderInvalidError) throw catalogOrderInvalid(error);
          throw error;
        }
        const sortOrders = new Map(plan.moves.map((move) => [move.item.id, move.sortOrder]));
        const ordered = plan.ordered.map((item) => {
          const sortOrder = sortOrders.get(item.id);
          return sortOrder === undefined
            ? item
            : {
                ...item,
                sortOrder,
                version: item.version + 1,
                updatedAt: now,
                updatedById: context.actor.userId,
              };
        });
        if (plan.moves.length === 0) return { ordered, moved: 0 };

        await this.items.applySortOrder(
          tx,
          plan.moves.map((move) => ({
            id: move.item.id,
            sortOrder: move.sortOrder,
            now,
            userId: context.actor.userId,
          })),
        );
        await this.audit.record(tx, {
          action: 'catalog.update',
          entityType: 'CatalogItem',
          changes: plan.moves.map((move) => ({
            path: `sortOrder.${move.item.code}`,
            old: move.item.sortOrder,
            new: move.sortOrder,
          })),
          metadata: { catalogType: input.catalogType, movedItems: plan.moves.length },
        });
        for (const move of plan.moves) {
          await this.outbox.record(
            tx,
            CatalogItemChanged.of({
              aggregateId: move.item.id,
              payload: {
                catalogType: move.item.catalogType,
                catalogItemId: move.item.id,
                code: move.item.code,
                change: 'UPDATED',
              },
            }),
          );
        }
        return { ordered, moved: plan.moves.length };
      });
    } catch (error) {
      logOperationFailure(this.logger, error, context.correlationId);
      throw error;
    }

    if (result.moved > 0) {
      this.logger.log(
        {
          event: 'catalog.item_updated',
          catalogType: input.catalogType,
          movedItems: result.moved,
          tenantId: context.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'catalog.item_updated',
      );
    }
    return result.ordered.map(toCatalogItemDto);
  }
}
