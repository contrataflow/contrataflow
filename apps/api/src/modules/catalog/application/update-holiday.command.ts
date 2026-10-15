import { HolidayChanged } from '@contrataflow/validation';
import type { HolidayDto, UpdateHoliday } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { CATALOG_CLOCK, CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogClock, CatalogTransactions } from './catalog-ports.js';
import { HOLIDAY_REPOSITORY, HolidayAlreadyExistsError } from './holiday-ports.js';
import type { HolidayRepository } from './holiday-ports.js';
import {
  holidayAlreadyExists,
  holidayNotFound,
  holidayScopeNotAllowed,
  holidaySystem,
  holidayVersionConflict,
  logOperationFailure,
} from './holiday.errors.js';
import { toHolidayDto } from './holiday.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  HolidayScopeNotAllowedError,
  HolidaySystemError,
  updateHoliday,
} from '../domain/holiday.js';
import type { Holiday } from '../domain/holiday.js';

export interface UpdateHolidayInput {
  readonly id: string;
  readonly patch: UpdateHoliday;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `UpdateHolidayCommand` — CAL-03 (US-106 · fluxo principal, passo 4): `name`, `scope`,
 * `isRecurring` e `isActive`; a data não muda. Feriado de sistema só aceita desativar/ativar e
 * ajustar escopo e recorrência — outro nome → 409 `CATALOG_ITEM_SYSTEM` (RN-TEN-77). Grava
 * `holiday.update` e `HolidayChanged` (`UPDATED`) na mesma transação; nada alterado → 200 sem
 * nova versão, auditoria nem evento. Nunca recalcula `dueAt` já gravados (RN-TEN-79).
 */
@Injectable()
export class UpdateHolidayCommand {
  private readonly logger = new Logger('Calendar');

  constructor(
    @Inject(HOLIDAY_REPOSITORY) private readonly holidays: HolidayRepository,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
    @Inject(CATALOG_CLOCK) private readonly clock: CatalogClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: UpdateHolidayInput): Promise<HolidayDto> {
    this.access.assertCan('CALENDAR_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    let outcome: { holiday: Holiday; written: boolean };
    try {
      outcome = await this.transactions.run(async (tx) => {
        const current = await this.holidays.findById(tx, input.id);
        if (!current) throw holidayNotFound();
        if (current.version !== input.expectedVersion) {
          throw holidayVersionConflict(current.version);
        }

        let result;
        try {
          result = updateHoliday(current, input.patch, { now, userId: context.actor.userId });
        } catch (error) {
          if (error instanceof HolidaySystemError) {
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
          if (error instanceof HolidayScopeNotAllowedError) throw holidayScopeNotAllowed();
          throw error;
        }
        if (result.changes.length === 0) return { holiday: current, written: false };

        try {
          await this.holidays.update(tx, result.next, current.version);
        } catch (error) {
          if (error instanceof VersionConflictError) {
            const latest = await this.holidays.findById(tx, current.id);
            throw holidayVersionConflict(latest?.version ?? current.version + 1);
          }
          if (error instanceof HolidayAlreadyExistsError) throw holidayAlreadyExists();
          throw error;
        }
        await this.audit.record(tx, {
          action: 'holiday.update',
          entityType: 'Holiday',
          entityId: current.id,
          changes: result.changes.map((change) => ({
            path: change.path,
            old: change.old,
            new: change.new,
          })),
          metadata: { holidayId: current.id, date: current.date },
        });
        await this.outbox.record(
          tx,
          HolidayChanged.of({
            aggregateId: current.id,
            payload: { holidayId: current.id, date: current.date, change: 'UPDATED' },
          }),
        );
        return {
          holiday: { ...result.next, version: current.version + 1 },
          written: true,
        };
      });
    } catch (error) {
      logOperationFailure(this.logger, error, context.correlationId);
      throw error;
    }

    if (outcome.written) {
      this.logger.log(
        {
          event: 'calendar.holiday_updated',
          holidayId: outcome.holiday.id,
          date: outcome.holiday.date,
          scope: outcome.holiday.scope,
          tenantId: outcome.holiday.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'calendar.holiday_updated',
      );
    }
    return toHolidayDto(outcome.holiday);
  }
}
