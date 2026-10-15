import { HolidayChanged } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogTransactions } from './catalog-ports.js';
import { HOLIDAY_REPOSITORY } from './holiday-ports.js';
import type { HolidayRepository } from './holiday-ports.js';
import {
  holidayNotFound,
  holidaySystem,
  holidayVersionConflict,
  logOperationFailure,
} from './holiday.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';

export interface DeleteHolidayInput {
  readonly id: string;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `DeleteHolidayCommand` — CAL-04 (US-106 · fluxo principal, passo 4): exclusão física do feriado
 * do administrador. Feriado de sistema (`isSystem`, semeado) nunca é excluído — só desativado
 * (FA-01 · RN-TEN-77) → 409 `CATALOG_ITEM_SYSTEM`. Grava `holiday.delete` (`holidayId` e `date`)
 * e `HolidayChanged` (`DELETED`) na mesma transação; nunca recalcula `dueAt` (RN-TEN-79).
 */
@Injectable()
export class DeleteHolidayCommand {
  private readonly logger = new Logger('Calendar');

  constructor(
    @Inject(HOLIDAY_REPOSITORY) private readonly holidays: HolidayRepository,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: DeleteHolidayInput): Promise<void> {
    this.access.assertCan('CALENDAR_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();

    try {
      const deleted = await this.transactions.run(async (tx) => {
        const current = await this.holidays.findById(tx, input.id);
        if (!current) throw holidayNotFound();
        if (current.isSystem) {
          this.logger.warn(
            {
              event: 'calendar.system_change_blocked',
              holidayId: current.id,
              date: current.date,
              tenantId: current.tenantId,
              userId: context.actor.userId,
              correlationId: context.correlationId,
            },
            'calendar.system_change_blocked',
          );
          throw holidaySystem();
        }
        if (current.version !== input.expectedVersion) {
          throw holidayVersionConflict(current.version);
        }
        try {
          await this.holidays.delete(tx, current, current.version);
        } catch (error) {
          if (error instanceof VersionConflictError) {
            const latest = await this.holidays.findById(tx, current.id);
            throw holidayVersionConflict(latest?.version ?? current.version + 1);
          }
          throw error;
        }
        await this.audit.record(tx, {
          action: 'holiday.delete',
          entityType: 'Holiday',
          entityId: current.id,
          metadata: { holidayId: current.id, date: current.date },
        });
        await this.outbox.record(
          tx,
          HolidayChanged.of({
            aggregateId: current.id,
            payload: { holidayId: current.id, date: current.date, change: 'DELETED' },
          }),
        );
        return current;
      });
      this.logger.log(
        {
          event: 'calendar.holiday_deleted',
          holidayId: deleted.id,
          date: deleted.date,
          scope: deleted.scope,
          tenantId: deleted.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'calendar.holiday_deleted',
      );
    } catch (error) {
      logOperationFailure(this.logger, error, context.correlationId);
      throw error;
    }
  }
}
