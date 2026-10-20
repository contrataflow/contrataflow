import { uuidv7 } from '@contrataflow/observability';
import { localDateOf, planRecurringHolidays } from '@contrataflow/types';
import type { RecurringHolidaySource } from '@contrataflow/types';
import { Logger } from '@nestjs/common';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { HousekeepingTask } from './tenant-housekeeping.job.js';

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

interface HolidayRow {
  readonly date: string;
  readonly name: string;
  readonly scope: RecurringHolidaySource['scope'];
  readonly is_active: boolean;
  readonly is_system: boolean;
}

/**
 * Geração do calendário do ano seguinte (US-106 · RN-TEN-76 · fila `maintenance`, tarefa diária
 * do `tenant-housekeeping`): garante as ocorrências do ano corrente (no fuso do tenant) e do
 * seguinte para os feriados recorrentes, recalculando os móveis pela Páscoa (Meeus/Butcher).
 * Idempotente — `ON CONFLICT DO NOTHING` na unicidade `(tenant, data, nome em minúsculas)` — e
 * roda dentro da `tenantTransaction` (RLS do tenant do job). Não recalcula prazos nem notifica
 * (RN-TEN-79); só registra `calendar.year_generated` no log.
 */
export class HolidayYearGeneratorTask implements HousekeepingTask {
  readonly name = 'holiday-year';
  private readonly logger = new Logger('Calendar');

  constructor(private readonly now: () => Date = () => new Date()) {}

  async run(client: SqlClient, tenantId: string): Promise<Readonly<Record<string, number>>> {
    const tenant = await client.query<{ timezone: string }>(
      'SELECT timezone FROM tenants WHERE id = $1',
      [tenantId],
    );
    const timezone = tenant.rows[0]?.timezone ?? DEFAULT_TIMEZONE;
    const currentYear = Number(localDateOf(this.now(), timezone).slice(0, 4));

    const generated: Record<string, number> = {};
    for (const year of [currentYear, currentYear + 1]) {
      const created = await this.generate(client, tenantId, year);
      generated[String(year)] = created;
      this.logger.log({ event: 'calendar.year_generated', tenantId, year, holidays: created });
    }
    return generated;
  }

  /** Gera o ano a partir dos recorrentes anteriores a ele; devolve quantos criou. */
  private async generate(client: SqlClient, tenantId: string, year: number): Promise<number> {
    const { rows } = await client.query<HolidayRow>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, name, scope::text AS scope, is_active, is_system
         FROM holidays
        WHERE tenant_id = $1 AND is_recurring AND date < $2::date
        ORDER BY date`,
      [tenantId, `${String(year).padStart(4, '0')}-01-01`],
    );
    const planned = planRecurringHolidays(
      rows.map((row) => ({
        date: row.date,
        name: row.name,
        scope: row.scope,
        isActive: row.is_active,
        isSystem: row.is_system,
      })),
      year,
    );
    let created = 0;
    for (const holiday of planned) {
      const result = await client.query(
        `INSERT INTO holidays
           (id, tenant_id, date, name, scope, is_recurring, is_system, is_active)
         VALUES ($1, $2, $3::date, $4, $5::holiday_scope, true, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          uuidv7(),
          tenantId,
          holiday.date,
          holiday.name,
          holiday.scope,
          holiday.isSystem,
          holiday.isActive,
        ],
      );
      created += result.rowCount ?? 0;
    }
    return created;
  }
}
