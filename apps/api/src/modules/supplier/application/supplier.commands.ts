import { SupplierCreated, SupplierUpdated } from '@contrataflow/validation';
import type { CreateSupplier, SupplierDto, UpdateSupplier } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { FIELD_PROTECTION } from '#shared/crypto/field-protection.js';
import type { FieldProtection } from '#shared/crypto/field-protection.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { documentHash, protectDocument } from './supplier-document.js';
import {
  SUPPLIER_CLOCK,
  SUPPLIER_REPOSITORY,
  SUPPLIER_TRANSACTIONS,
  SupplierDocumentTakenError,
} from './supplier-ports.js';
import type { SupplierClock, SupplierRepository, SupplierTransactions } from './supplier-ports.js';
import { SupplierUsageRegistry } from './supplier-usage.registry.js';
import {
  countSupplierCreated,
  documentNotAllowed,
  logSaveFailure,
  supplierAlreadyExists,
  supplierInUse,
  supplierNotFound,
  versionConflict,
} from './supplier.errors.js';
import { toSupplierDto } from './supplier.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { createAuditChanges, createSupplier, updateSupplier } from '../domain/supplier.js';
import type { Supplier } from '../domain/supplier.js';

/**
 * Base dos casos de uso do fornecedor: autoriza (`SUPPLIER_MANAGE` em nível de tenant, sem escopo
 * por unidade/processo — DEC-010; MFA só com `security.mfaPolicy = ALL`), roda a transação e
 * registra `supplier.create_failed`/`supplier.save_failed` nas falhas de gravação.
 */
abstract class SupplierCommand {
  protected readonly logger = new Logger('Suppliers');

  constructor(
    protected readonly suppliers: SupplierRepository,
    protected readonly transactions: SupplierTransactions,
    protected readonly clock: SupplierClock,
    protected readonly audit: AuditTrailPort,
    protected readonly outbox: OutboxWriterPort,
    protected readonly access: AccessFacade,
    protected readonly identity: IdentityFacade,
    protected readonly protection: FieldProtection,
  ) {}

  protected async authorize(): Promise<void> {
    this.access.assertCan('SUPPLIER_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
  }

  /** Roda `work` e registra no log a falha de gravação (sem dados do fornecedor). */
  protected async guarded<T>(
    event: 'supplier.create_failed' | 'supplier.save_failed',
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      logSaveFailure(this.logger, event, error, requireRequestContext().correlationId);
      throw error;
    }
  }

  /** Lê o fornecedor sob a RLS (outro tenant/excluído → 404) e confere o `If-Match` (412). */
  protected async load(tx: TenantTx, id: string, expectedVersion: number): Promise<Supplier> {
    const current = await this.suppliers.findById(tx, id);
    if (!current) throw supplierNotFound();
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    return current;
  }

  /** Corrida com outra transação vira 412 com a versão vencedora. */
  protected async conflictToVersion(
    tx: TenantTx,
    current: Supplier,
    error: unknown,
  ): Promise<never> {
    if (error instanceof VersionConflictError) {
      const latest = await this.suppliers.findById(tx, current.id);
      throw versionConflict(latest?.version ?? current.version + 1);
    }
    throw error;
  }

  protected logInfo(event: string, supplier: Supplier, extra: Record<string, unknown> = {}) {
    const context = requireRequestContext();
    this.logger.log(
      {
        event,
        supplierId: supplier.id,
        documentType: supplier.documentType,
        ...extra,
        tenantId: supplier.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      event,
    );
  }
}

export interface CreateSupplierInput {
  readonly body: CreateSupplier;
}

/**
 * `CreateSupplierCommand` — SUP-02 (US-025 · fluxo principal, passos 5–7): normaliza e protege o
 * documento (CPF cifrado + blind index, ANTES da transação: KMS fora → 503 e nada é gravado),
 * confere a duplicidade por `(tipo, hash)` e, numa transação, insere o fornecedor ativo, grava
 * `supplier.create` e `SupplierCreated`. Duas criações simultâneas do mesmo documento: o índice
 * único decide — uma 201, a outra 409.
 */
@Injectable()
export class CreateSupplierCommand extends SupplierCommand {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) suppliers: SupplierRepository,
    @Inject(SUPPLIER_TRANSACTIONS) transactions: SupplierTransactions,
    @Inject(SUPPLIER_CLOCK) clock: SupplierClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
    @Inject(FIELD_PROTECTION) protection: FieldProtection,
  ) {
    super(suppliers, transactions, clock, audit, outbox, access, identity, protection);
  }

  async execute(input: CreateSupplierInput): Promise<SupplierDto> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();
    const { body } = input;

    const created = await this.guarded('supplier.create_failed', async () => {
      const document = await protectDocument(
        this.protection,
        body.documentType,
        body.documentNumber,
      );
      return this.transactions.run(async (tx) => {
        const existing = await this.suppliers.findByDocument(tx, body.documentType, document.hash);
        if (existing) throw supplierAlreadyExists(existing.id);

        const draft = createSupplier(body, {
          id: newId(),
          tenantId: context.tenantId ?? '',
          document,
          now,
          userId: context.actor.userId,
        });
        try {
          await this.suppliers.insert(tx, draft);
        } catch (error) {
          if (error instanceof SupplierDocumentTakenError) throw supplierAlreadyExists();
          throw error;
        }
        await this.audit.record(tx, {
          action: 'supplier.create',
          entityType: 'Supplier',
          entityId: draft.id,
          changes: createAuditChanges(draft),
          metadata: { documentType: draft.documentType },
        });
        await this.outbox.record(
          tx,
          SupplierCreated.of({
            aggregateId: draft.id,
            payload: { supplierId: draft.id, documentType: draft.documentType },
          }),
        );
        return draft;
      });
    });

    countSupplierCreated(created.documentType);
    this.logInfo('supplier.created', created);
    return toSupplierDto(created);
  }
}

export interface UpdateSupplierInput {
  readonly id: string;
  readonly patch: UpdateSupplier;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

interface UpdateOutcome {
  readonly supplier: Supplier;
  readonly written: boolean;
}

/**
 * `UpdateSupplierCommand` — SUP-04 (FA-01/FA-02): edita os campos do cadastro e inativa/reativa
 * (RN-PRICE-20). Tipo e número do documento são imutáveis (RN-PRICE-14): aceitos só iguais aos
 * atuais — conferidos pelo blind index —, senão 422 `NOT_ALLOWED`. Grava `supplier.update`
 * (anterior/novo, contato redigido), `supplier.deactivate` quando `isActive` passa a falso e
 * `SupplierUpdated` (`changedFields`). Nada alterado → 200 sem nova versão, auditoria nem evento.
 */
@Injectable()
export class UpdateSupplierCommand extends SupplierCommand {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) suppliers: SupplierRepository,
    @Inject(SUPPLIER_TRANSACTIONS) transactions: SupplierTransactions,
    @Inject(SUPPLIER_CLOCK) clock: SupplierClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
    @Inject(FIELD_PROTECTION) protection: FieldProtection,
  ) {
    super(suppliers, transactions, clock, audit, outbox, access, identity, protection);
  }

  async execute(input: UpdateSupplierInput): Promise<SupplierDto> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();

    let changedFields: readonly string[] = [];
    const outcome = await this.guarded('supplier.save_failed', () =>
      this.transactions.run(async (tx): Promise<UpdateOutcome> => {
        const current = await this.load(tx, input.id, input.expectedVersion);
        this.assertDocumentUnchanged(current, input.patch);

        const result = updateSupplier(current, input.patch, { now, userId: context.actor.userId });
        if (result.changedFields.length === 0) return { supplier: current, written: false };

        try {
          await this.suppliers.update(tx, result.next, current.version);
        } catch (error) {
          return this.conflictToVersion(tx, current, error);
        }
        const deactivated = result.changedFields.includes('isActive') && !result.next.isActive;
        const otherChanges = result.changes.filter((change) => change.path !== 'isActive');
        if (!deactivated || otherChanges.length > 0) {
          await this.audit.record(tx, {
            action: 'supplier.update',
            entityType: 'Supplier',
            entityId: current.id,
            changes: result.changes,
            metadata: { documentType: current.documentType },
          });
        }
        if (deactivated) {
          await this.audit.record(tx, {
            action: 'supplier.deactivate',
            entityType: 'Supplier',
            entityId: current.id,
            metadata: { documentType: current.documentType },
          });
        }
        await this.outbox.record(
          tx,
          SupplierUpdated.of({
            aggregateId: current.id,
            payload: {
              supplierId: current.id,
              documentType: current.documentType,
              changedFields: [...result.changedFields],
            },
          }),
        );
        changedFields = result.changedFields;
        return { supplier: { ...result.next, version: current.version + 1 }, written: true };
      }),
    );

    if (outcome.written) this.logInfo('supplier.updated', outcome.supplier, { changedFields });
    return toSupplierDto(outcome.supplier);
  }

  /** V-07: tipo/número em edição só são aceitos iguais aos atuais (comparação por blind index). */
  private assertDocumentUnchanged(current: Supplier, patch: UpdateSupplier): void {
    if (patch.documentType !== undefined && patch.documentType !== current.documentType) {
      throw documentNotAllowed();
    }
    if (
      patch.documentNumber !== undefined &&
      documentHash(this.protection, current.documentType, patch.documentNumber) !==
        current.documentNumberHash
    ) {
      throw documentNotAllowed();
    }
  }
}

export interface DeleteSupplierInput {
  readonly id: string;
  readonly expectedVersion: number;
}

/**
 * `DeleteSupplierCommand` — SUP-05 (FA-03/FA-04 · RN-PRICE-19): exclusão lógica, só sem
 * `PriceSource` não excluída referenciando o fornecedor (consultada pelos provedores de uso
 * registrados); em uso → 409 `SUPPLIER_IN_USE` (a UI oferece "Inativar"). Grava `supplier.delete`;
 * não há evento de domínio para a exclusão. O documento libera o índice único: pode ser cadastrado
 * de novo.
 */
@Injectable()
export class DeleteSupplierCommand extends SupplierCommand {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) suppliers: SupplierRepository,
    @Inject(SUPPLIER_TRANSACTIONS) transactions: SupplierTransactions,
    @Inject(SUPPLIER_CLOCK) clock: SupplierClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
    @Inject(FIELD_PROTECTION) protection: FieldProtection,
    private readonly usage: SupplierUsageRegistry,
  ) {
    super(suppliers, transactions, clock, audit, outbox, access, identity, protection);
  }

  async execute(input: DeleteSupplierInput): Promise<void> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();

    const removed = await this.guarded('supplier.save_failed', () =>
      this.transactions.run(async (tx) => {
        const current = await this.load(tx, input.id, input.expectedVersion);
        if (await this.usage.isInUse(tx, current.id)) throw supplierInUse();
        try {
          await this.suppliers.softDelete(tx, current, current.version, {
            at: now,
            userId: context.actor.userId,
          });
        } catch (error) {
          return this.conflictToVersion(tx, current, error);
        }
        await this.audit.record(tx, {
          action: 'supplier.delete',
          entityType: 'Supplier',
          entityId: current.id,
          metadata: { documentType: current.documentType },
        });
        return current;
      }),
    );
    this.logInfo('supplier.deleted', removed);
  }
}
