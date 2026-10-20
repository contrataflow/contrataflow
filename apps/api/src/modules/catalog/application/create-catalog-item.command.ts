import type { CatalogType } from '@contrataflow/types';
import { CatalogItemChanged } from '@contrataflow/validation';
import type { CatalogItemDto, CreateCatalogItem } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  CATALOG_CLOCK,
  CATALOG_ITEM_REPOSITORY,
  CATALOG_TRANSACTIONS,
  CatalogCodeTakenError,
} from './catalog-ports.js';
import type { CatalogClock, CatalogItemRepository, CatalogTransactions } from './catalog-ports.js';
import {
  catalogCodeTaken,
  catalogMetadataInvalid,
  catalogParentInvalid,
  logOperationFailure,
} from './catalog.errors.js';
import { toCatalogItemDto } from './catalog.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { CatalogMetadataInvalidError, createCatalogItem } from '../domain/catalog-item.js';
import type { CatalogItem } from '../domain/catalog-item.js';

export interface CreateCatalogItemInput {
  readonly catalogType: CatalogType;
  readonly body: CreateCatalogItem;
}

/**
 * `CreateCatalogItemCommand` — CAT-02 (US-104 · fluxo principal, passos 3–4): autoriza
 * (`CATALOG_MANAGE` + MFA), valida o pai (RN-TEN-63), a unicidade do `code` e o schema de
 * `metadata` do tipo (RN-TEN-62) e, numa transação, insere o item (`isSystem = false`, no fim da
 * lista), grava `catalog.create` e `CatalogItemChanged` (`CREATED`).
 */
@Injectable()
export class CreateCatalogItemCommand {
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

  async execute(input: CreateCatalogItemInput): Promise<CatalogItemDto> {
    this.access.assertCan('CATALOG_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    let created: CatalogItem;
    try {
      created = await this.transactions.run(async (tx) => {
        if (input.body.parentId) {
          const parent = await this.items.findById(tx, input.body.parentId);
          if (parent?.catalogType !== input.catalogType) throw catalogParentInvalid();
        }
        if (await this.items.findByCode(tx, input.catalogType, input.body.code)) {
          throw catalogCodeTaken();
        }
        let draft: CatalogItem;
        try {
          draft = createCatalogItem(input.body, {
            id: newId(),
            tenantId: context.tenantId ?? '',
            catalogType: input.catalogType,
            now,
            userId: context.actor.userId,
            sortOrder: (await this.items.maxSortOrder(tx, input.catalogType)) + 1,
          });
        } catch (error) {
          if (error instanceof CatalogMetadataInvalidError) throw catalogMetadataInvalid(error);
          throw error;
        }
        try {
          await this.items.insert(tx, draft);
        } catch (error) {
          // Corrida de duas criações: o índice único decide.
          if (error instanceof CatalogCodeTakenError) throw catalogCodeTaken();
          throw error;
        }
        await this.audit.record(tx, {
          action: 'catalog.create',
          entityType: 'CatalogItem',
          entityId: draft.id,
          changes: [
            { path: 'code', old: null, new: draft.code },
            { path: 'label', old: null, new: draft.label },
            { path: 'metadata', old: null, new: draft.metadata },
          ],
          metadata: { catalogType: draft.catalogType, catalogItemId: draft.id },
        });
        await this.outbox.record(
          tx,
          CatalogItemChanged.of({
            aggregateId: draft.id,
            payload: {
              catalogType: draft.catalogType,
              catalogItemId: draft.id,
              code: draft.code,
              change: 'CREATED',
            },
          }),
        );
        return draft;
      });
    } catch (error) {
      logOperationFailure(this.logger, error, context.correlationId);
      throw error;
    }

    this.logger.log(
      {
        event: 'catalog.item_created',
        catalogType: created.catalogType,
        catalogItemId: created.id,
        code: created.code,
        tenantId: created.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'catalog.item_created',
    );
    return toCatalogItemDto(created);
  }
}
