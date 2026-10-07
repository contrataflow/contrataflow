import { z } from 'zod';

/** Data e hora ISO 8601 em UTC, ex.: `2026-10-05T14:30:00Z` (DEC-003). */
export const isoDateTimeSchema = z.iso.datetime({
  error: 'Informe data e hora no formato ISO 8601 em UTC (ex.: 2026-10-05T14:30:00Z).',
});

/** Data sem hora `YYYY-MM-DD` (DEC-003). */
export const isoDateSchema = z.iso.date({
  error: 'Informe a data no formato AAAA-MM-DD.',
});
