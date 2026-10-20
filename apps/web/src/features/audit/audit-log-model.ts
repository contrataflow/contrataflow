import { AUDIT_LOG_MESSAGES, auditLogSearchQuerySchema } from '@contrataflow/validation';
import type { AuditExportFormat, AuditLogDto } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { isoToLocalInput, localInputToIso } from './seal-model';

/*
 * Regras puras da aba "Registros" (US-075 · SCR-037): filtros digitados (campos `datetime-local`
 * no fuso da instituição) ↔ query de AUD-01/AUD-03 validada com o MESMO schema da API (V-01/V-02),
 * leitura dos valores mascarados do diff, contagem das linhas exportadas e classificação dos erros.
 */

/** Filtros como estão no painel (strings dos campos). */
export interface AuditFilterInput {
  readonly from: string;
  readonly to: string;
  readonly actions: readonly string[];
  readonly category: string;
  readonly result: string;
  readonly actorUserId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly processId: string;
}

/** Query de AUD-01/AUD-03 já validada (valores prontos para a URL). */
export type AuditQuery = Readonly<Record<string, string>>;

const DAY_MS = 86_400_000;
const BOM = String.fromCharCode(0xfeff);
/** Padrão de SCR-037: últimos 7 dias. */
export const DEFAULT_PERIOD_DAYS = 7;

export function defaultAuditFilters(now: Date, timeZone: string): AuditFilterInput {
  return {
    from: isoToLocalInput(
      new Date(now.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS).toISOString(),
      timeZone,
    ),
    to: isoToLocalInput(now.toISOString(), timeZone),
    actions: [],
    category: '',
    result: '',
    actorUserId: '',
    entityType: '',
    entityId: '',
    processId: '',
  };
}

/** Quantos filtros avançados estão preenchidos (rótulo do recolhível). */
export function advancedFilterCount(input: AuditFilterInput): number {
  return [input.actorUserId, input.entityType, input.entityId, input.processId].filter(
    (value) => value.trim() !== '',
  ).length;
}

export type AuditFilterField = 'from' | 'to' | 'entityId' | 'processId' | 'actorUserId';

export type AuditFilterValidation =
  | { readonly ok: true; readonly query: AuditQuery }
  | { readonly ok: false; readonly errors: Partial<Record<AuditFilterField, string>> };

const FIELD_OF: Readonly<Record<string, AuditFilterField>> = {
  occurredFrom: 'from',
  occurredTo: 'to',
  entityId: 'entityId',
  processId: 'processId',
  actorUserId: 'actorUserId',
};

/**
 * Valida o painel com `auditLogSearchQuerySchema` (o mesmo da API): período obrigatório de até 90
 * dias (V-01), data final posterior à inicial (V-02) e ids bem formados. Devolve a query de AUD-01.
 */
export function validateAuditFilters(
  input: AuditFilterInput,
  timeZone: string,
  messages: { readonly required: string; readonly invalidId: string },
): AuditFilterValidation {
  const from = input.from === '' ? null : localInputToIso(input.from, timeZone);
  const to = input.to === '' ? null : localInputToIso(input.to, timeZone);
  if (from === null || to === null) {
    return {
      ok: false,
      errors: {
        ...(from === null ? { from: messages.required } : {}),
        ...(to === null ? { to: messages.required } : {}),
      },
    };
  }
  const query: Record<string, string> = { occurredFrom: from, occurredTo: to };
  if (input.actions.length > 0) query.action = input.actions.join(',');
  if (input.category !== '') query.category = input.category;
  if (input.result !== '') query.result = input.result;
  for (const key of ['actorUserId', 'entityType', 'entityId', 'processId'] as const) {
    const value = input[key].trim();
    if (value !== '') query[key] = value;
  }
  const parsed = auditLogSearchQuerySchema.safeParse(query);
  if (parsed.success) return { ok: true, query };
  const errors: Partial<Record<AuditFilterField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = FIELD_OF[String(issue.path[0])];
    if (field === undefined || errors[field] !== undefined) continue;
    errors[field] =
      field === 'entityId' || field === 'processId' || field === 'actorUserId'
        ? messages.invalidId
        : issue.message;
  }
  return {
    ok: false,
    errors: Object.keys(errors).length > 0 ? errors : { to: AUDIT_LOG_MESSAGES.period },
  };
}

/** Atores distintos dos registros carregados (opções do filtro "Ator"), por nome. */
export function actorOptions(
  records: readonly Pick<AuditLogDto, 'actorUserId' | 'actorName'>[],
  selected: string,
): { readonly id: string; readonly name: string }[] {
  const byId = new Map<string, string>();
  for (const record of records) {
    if (record.actorUserId !== null && !byId.has(record.actorUserId)) {
      byId.set(record.actorUserId, record.actorName ?? record.actorUserId);
    }
  }
  if (selected !== '' && !byId.has(selected)) byId.set(selected, selected);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
}

/** Valor resumido na gravação (US-073): `{ hash, length }` — nunca desmascarado (RN-AUD-18). */
export interface SummarizedValue {
  readonly hash: string;
  readonly length: number;
}

export function summarizedValue(value: unknown): SummarizedValue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { hash, length } = value as Record<string, unknown>;
  const keys = Object.keys(value);
  return keys.length === 2 && typeof hash === 'string' && typeof length === 'number'
    ? { hash, length }
    : null;
}

/** Texto de um valor do diff: texto como está; estrutura em JSON. `null` = vazio. */
export function changeValueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** FA-05: registro coalescido com o intervalo de salvamentos no `metadata`, quando houver. */
export function coalescedRange(
  metadata: Readonly<Record<string, unknown>>,
): { readonly first: string; readonly last: string } | null {
  const coalesce = metadata.coalesce;
  if (typeof coalesce !== 'object' || coalesce === null) return null;
  const { firstSavedAt, lastSavedAt } = coalesce as Record<string, unknown>;
  return typeof firstSavedAt === 'string' && typeof lastSavedAt === 'string'
    ? { first: firstSavedAt, last: lastSavedAt }
    : null;
}

/** Registros num arquivo exportado: NDJSON = linhas; CSV = registros fora de aspas menos o cabeçalho. */
export function countExportedRows(text: string, format: AuditExportFormat): number {
  if (format === 'ndjson') return text.split('\n').filter((line) => line.trim() !== '').length;
  let rows = 0;
  let quoted = false;
  let pending = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === '\n' && !quoted) {
      if (pending) rows += 1;
      pending = false;
    } else if (char !== '\r' && char !== BOM) {
      pending = true;
    }
  }
  if (pending) rows += 1;
  return Math.max(0, rows - 1);
}

/** Como a aba reage a cada falha de AUD-01/02/03 (Casos de erro da US-075). */
export type AuditFailure =
  | { readonly kind: 'validation'; readonly message: string }
  | { readonly kind: 'tooLarge'; readonly message: string }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable'; readonly correlationId: string | null }
  | { readonly kind: 'mfa' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'unexpected'; readonly correlationId: string | null };

export function classifyAuditError(error: unknown): AuditFailure {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: null };
  if (error.status === 403 && error.code === 'MFA_REQUIRED') return { kind: 'mfa' };
  if (error.status === 403) return { kind: 'forbidden' };
  if (error.status === 404) return { kind: 'notFound' };
  if (error.status === 429) return { kind: 'rateLimited' };
  if (error.status === 422 && error.code === 'EXPORT_TOO_LARGE') {
    return { kind: 'tooLarge', message: error.message };
  }
  if (error.status === 422) {
    const message = error.errors.find((item) => item.message !== '')?.message;
    return { kind: 'validation', message: message ?? AUDIT_LOG_MESSAGES.period };
  }
  if (error.status >= 500) return { kind: 'unavailable', correlationId: error.correlationId };
  return { kind: 'unexpected', correlationId: error.correlationId };
}

/** Dispara o download do arquivo no navegador (âncora temporária com `download`). */
export function saveFile(blob: Blob, fileName: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30_000);
}
