import { CatalogItemChanged } from '@contrataflow/validation';
import type { CatalogItemDto, UpdateCatalogItem } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { CATALOG_CLOCK, CATALOG_ITEM_REPOSITORY, CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogClock, CatalogItemRepository, CatalogTransactions } from './catalog-ports.js';
import {
  catalogCodeImmutable,
  catalogItemNotFound,
  catalogItemSystem,
  catalogMetadataInvalid,
  catalogParentInvalid,
  catalogVersionConflict,
  logOperationFailure,
} from './catalog.errors.js';
import { toCatalogItemDto } from './catalog.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  CatalogCodeImmutableError,
  CatalogItemSystemError,
  CatalogMetadataInvalidError,
  createsParentCycle,
  setCatalogItemActive,
  updateCatalogItem,
} from '../domain/catalog-item.js';
import type { CatalogItem } from '../domain/catalog-item.js';

export interface UpdateCatalogItemInput {
  readonly id: string;
  readonly patch: UpdateCatalogItem;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

export interface ToggleCatalogItemInput {
  readonly id: string;
  readonly expectedVersion: number;
}

interface Outcome {
  readonly item: CatalogItem;
  readonly written: boolean;
}

/** Base dos casos de uso que gravam UM item com `If-Match`: autoriza, lê, confere versão, grava. */
abstract class VersionedCatalogCommand {
  protected readonly logger = new Logger('Catalog');

  constructor(
    protected readonly items: CatalogItemRepository,
    protected readonly transactions: CatalogTransactions,
    protected readonly clock: CatalogClock,
    protected readonly audit: AuditTrailPort,
    protected readonly outbox: OutboxWriterPort,
    protected readonly access: AccessFacade,
    protected readonly identity: IdentityFacade,
  ) {}

  protected async run(
    id: string,
    expectedVersion: number,
    work: (tx: TenantTx, current: CatalogItem, now: Date) => Promise<Outcome>,
  ): Promise<CatalogItemDto> {
    this.access.assertCan('CATALOG_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    let outcome: Outcome;
    try {
      outcome = await this.transactions.run(async (tx) => {
        const current = await this.items.findById(tx, id);
        if (!current) throw catalogItemNotFound();
        if (current.version !== expectedVersion) throw catalogVersionConflict(current.version);
        return work(tx, current, now);
      });
    } catch (error) {
      logOperationFailure(this.logger, error, context.correlationId);
      throw error;
    }

    if (outcome.written) {
      this.logger.log(
        {
          event: 'catalog.item_updated',
          catalogType: outcome.item.catalogType,
          catalogItemId: outcome.item.id,
          code: outcome.item.code,
          tenantId: outcome.item.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'catalog.item_updated',
      );
    }
    return toCatalogItemDto(outcome.item);
  }

  /** UPDATE versionado; corrida com outra transação vira 412 com a versão vencedora. */
  protected async persist(tx: TenantTx, next: CatalogItem, current: CatalogItem): Promise<void> {
    try {
      await this.items.update(tx, next, current.version);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.items.findById(tx, current.id);
        throw catalogVersionConflict(latest?.version ?? current.version + 1);
      }
      throw error;
    }
  }

  protected async recordChange(
    tx: TenantTx,
    item: CatalogItem,
    change: 'UPDATED' | 'ACTIVATED' | 'DEACTIVATED',
  ): Promise<void> {
    await this.outbox.record(
      tx,
      CatalogItemChanged.of({
        aggregateId: item.id,
        payload: {
          catalogType: item.catalogType,
          catalogItemId: item.id,
          code: item.code,
          change,
        },
      }),
    );
  }
}

/**
 * `UpdateCatalogItemCommand` — CAT-03 (US-104 · fluxo principal, passo 5): `label`, `description`,
 * `parentId`, `sortOrder` e `metadata` (RN-TEN-60). `code` diferente do atual → 409
 * `CATALOG_ITEM_SYSTEM` (item de sistema — FA-01) ou 422 (RN-TEN-59). Grava `catalog.update` e
 * `CatalogItemChanged` (`UPDATED`) na mesma transação; nada alterado → 200 sem nova versão,
 * auditoria nem evento.
 */
@Injectable()
export class UpdateCatalogItemCommand extends VersionedCatalogCommand {
  constructor(
    @Inject(CATALOG_ITEM_REPOSITORY) items: CatalogItemRepository,
    @Inject(CATALOG_TRANSACTIONS) transactions: CatalogTransactions,
    @Inject(CATALOG_CLOCK) clock: CatalogClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(items, transactions, clock, audit, outbox, access, identity);
  }

  execute(input: UpdateCatalogItemInput): Promise<CatalogItemDto> {
    return this.run(input.id, input.expectedVersion, async (tx, current, now) => {
      const context = requireRequestContext();
      let result;
      try {
        result = updateCatalogItem(current, input.patch, { now, userId: context.actor.userId });
      } catch (error) {
        if (error instanceof CatalogItemSystemError) {
          this.logger.warn(
            {
              event: 'catalog.system_change_blocked',
              catalogType: current.catalogType,
              catalogItemId: current.id,
              code: current.code,
              tenantId: current.tenantId,
              userId: context.actor.userId,
              correlationId: context.correlationId,
            },
            'catalog.system_change_blocked',
          );
          throw catalogItemSystem(current.code);
        }
        if (error instanceof CatalogCodeImmutableError) throw catalogCodeImmutable();
        if (error instanceof CatalogMetadataInvalidError) throw catalogMetadataInvalid(error);
        throw error;
      }
      if (result.changes.length === 0) return { item: current, written: false };

      if (result.parentToValidate !== null) {
        await this.assertParent(tx, current, result.parentToValidate);
      }
      await this.persist(tx, result.next, current);
      await this.audit.record(tx, {
        action: 'catalog.update',
        entityType: 'CatalogItem',
        entityId: current.id,
        changes: result.changes.map((change) => ({
          path: change.path,
          old: change.old,
          new: change.new,
        })),
        metadata: { catalogType: current.catalogType, catalogItemId: current.id },
      });
      await this.recordChange(tx, result.next, 'UPDATED');
      return { item: { ...result.next, version: current.version + 1 }, written: true };
    });
  }

  /** RN-TEN-63: pai do mesmo catálogo e tenant, que não seja o próprio item nem crie ciclo. */
  private async assertParent(tx: TenantTx, item: CatalogItem, parentId: string): Promise<void> {
    if (parentId === item.id) throw catalogParentInvalid();
    const parent = await this.items.findById(tx, parentId);
    if (parent?.catalogType !== item.catalogType) throw catalogParentInvalid();
    const cycle = await createsParentCycle(item.id, parentId, async (id) => {
      const found = await this.items.findById(tx, id);
      return found?.parentId ?? null;
    });
    if (cycle) throw catalogParentInvalid();
  }
}

/**
 * `ActivateCatalogItemCommand` — CAT-04 (US-104 · passo 6): reativa o item. Grava `catalog.update`
 * (reativação) e `CatalogItemChanged` (`ACTIVATED`); já ativo → 200 sem efeitos.
 */
@Injectable()
export class ActivateCatalogItemCommand extends VersionedCatalogCommand {
  constructor(
    @Inject(CATALOG_ITEM_REPOSITORY) items: CatalogItemRepository,
    @Inject(CATALOG_TRANSACTIONS) transactions: CatalogTransactions,
    @Inject(CATALOG_CLOCK) clock: CatalogClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(items, transactions, clock, audit, outbox, access, identity);
  }

  execute(input: ToggleCatalogItemInput): Promise<CatalogItemDto> {
    return this.run(input.id, input.expectedVersion, async (tx, current, now) => {
      const context = requireRequestContext();
      const next = setCatalogItemActive(current, true, { now, userId: context.actor.userId });
      if (next === null) return { item: current, written: false };
      await this.persist(tx, next, current);
      await this.audit.record(tx, {
        action: 'catalog.update',
        entityType: 'CatalogItem',
        entityId: current.id,
        changes: [{ path: 'isActive', old: false, new: true }],
        metadata: {
          catalogType: current.catalogType,
          catalogItemId: current.id,
          reactivated: true,
        },
      });
      await this.recordChange(tx, next, 'ACTIVATED');
      return { item: { ...next, version: current.version + 1 }, written: true };
    });
  }
}

/**
 * `DeactivateCatalogItemCommand` — CAT-05 (US-104 · passo 6 · RN-TEN-61): desativa o item (em uso
 * ou não — sem efeito retroativo). Grava `catalog.deactivate` e `CatalogItemChanged`
 * (`DEACTIVATED`); já inativo → 200 sem efeitos.
 */
@Injectable()
export class DeactivateCatalogItemCommand extends VersionedCatalogCommand {
  constructor(
    @Inject(CATALOG_ITEM_REPOSITORY) items: CatalogItemRepository,
    @Inject(CATALOG_TRANSACTIONS) transactions: CatalogTransactions,
    @Inject(CATALOG_CLOCK) clock: CatalogClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(items, transactions, clock, audit, outbox, access, identity);
  }

  execute(input: ToggleCatalogItemInput): Promise<CatalogItemDto> {
    return this.run(input.id, input.expectedVersion, async (tx, current, now) => {
      const context = requireRequestContext();
      const next = setCatalogItemActive(current, false, { now, userId: context.actor.userId });
      if (next === null) return { item: current, written: false };
      await this.persist(tx, next, current);
      await this.audit.record(tx, {
        action: 'catalog.deactivate',
        entityType: 'CatalogItem',
        entityId: current.id,
        metadata: { catalogType: current.catalogType, catalogItemId: current.id },
      });
      await this.recordChange(tx, next, 'DEACTIVATED');
      return { item: { ...next, version: current.version + 1 }, written: true };
    });
  }
}
