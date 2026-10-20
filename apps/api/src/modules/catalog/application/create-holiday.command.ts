import { HolidayChanged } from '@contrataflow/validation';
import type { CreateHoliday, HolidayDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { CATALOG_CLOCK, CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogClock, CatalogTransactions } from './catalog-ports.js';
import { HOLIDAY_REPOSITORY, HolidayAlreadyExistsError } from './holiday-ports.js';
import type { HolidayRepository } from './holiday-ports.js';
import { holidayAlreadyExists, logOperationFailure } from './holiday.errors.js';
import { toHolidayDto } from './holiday.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { createHoliday } from '../domain/holiday.js';
import type { Holiday } from '../domain/holiday.js';

/**
 * `CreateHolidayCommand` — CAL-02 (US-106 · fluxo principal, passos 2–3): autoriza
 * (`CALENDAR_MANAGE` + MFA), confere a unicidade `(tenant, data, nome em minúsculas)` e, numa
 * transação, insere o feriado (`isSystem = false`, ativo), grava `holiday.create` e
 * `HolidayChanged` (`CREATED`). Cadastro retroativo é permitido e nunca recalcula `dueAt` já
 * gravados (FA-02 · RN-TEN-79). Duas criações simultâneas do mesmo feriado: o índice único decide
 * (um 201, o outro 409).
 */
@Injectable()
export class CreateHolidayCommand {
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

  async execute(body: CreateHoliday): Promise<HolidayDto> {
    this.access.assertCan('CALENDAR_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    let created: Holiday;
    try {
      created = await this.transactions.run(async (tx) => {
        const draft = createHoliday(body, {
          id: newId(),
          tenantId: context.tenantId ?? '',
          now,
          userId: context.actor.userId,
        });
        try {
          await this.holidays.insert(tx, draft);
        } catch (error) {
          // Corrida de duas criações (ou duplicidade): o índice único decide.
          if (error instanceof HolidayAlreadyExistsError) throw holidayAlreadyExists();
          throw error;
        }
        await this.audit.record(tx, {
          action: 'holiday.create',
          entityType: 'Holiday',
          entityId: draft.id,
          changes: [
            { path: 'date', old: null, new: draft.date },
            { path: 'name', old: null, new: draft.name },
            { path: 'scope', old: null, new: draft.scope },
          ],
          metadata: { holidayId: draft.id },
        });
        await this.outbox.record(
          tx,
          HolidayChanged.of({
            aggregateId: draft.id,
            payload: { holidayId: draft.id, date: draft.date, change: 'CREATED' },
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
        event: 'calendar.holiday_created',
        holidayId: created.id,
        date: created.date,
        scope: created.scope,
        tenantId: created.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'calendar.holiday_created',
    );
    return toHolidayDto(created);
  }
}
