import {
  CONFIDENTIAL_LABELS,
  DEADLINE_SITUATION_LABELS,
  PRIORITY_LABELS,
  PROCESS_STATUS_LABELS,
  processExportHeaders,
} from '@contrataflow/validation';
import type {
  ProcessColumnKey,
  ProcessDeadlineDto,
  ProcessListItemDto,
} from '@contrataflow/validation';

/*
 * `CsvRowSerializer` (US-003 · RN-PROC-42..44): o arquivo da exportação da lista, montado aos
 * pedaços (cabeçalho + linhas) para o *streaming*. Formato pt-BR: UTF-8 com BOM, separador `;`,
 * CRLF, decimais com vírgula e sem separador de milhar, datas `DD/MM/AAAA` e data-hora
 * `DD/MM/AAAA HH:mm` no fuso do tenant, enums pelos rótulos (DEC-184), etiquetas por " | ".
 * Proteção contra CSV injection (RN-PROC-43): célula de TEXTO iniciada por `=`, `+`, `-`, `@`, TAB
 * ou CR ganha `'`; valores numéricos e datas gerados pelo sistema não. O valor mascarado (POL-09)
 * nunca chega aqui: o DTO já traz `estimatedValue = null` e `estimatedValueMasked`.
 */

export const CSV_SEPARATOR = ';';
const CRLF = '\r\n';
const BOM = String.fromCharCode(0xfeff);

/** Gatilhos de fórmula em Excel/Sheets/LibreOffice (OWASP "CSV Injection"). */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Texto livre (neutralizado) ou valor gerado pelo sistema (número, data — sem prefixo). */
export type CsvValue =
  | { readonly kind: 'text'; readonly value: string | null }
  | { readonly kind: 'system'; readonly value: string | null };

const text = (value: string | null): CsvValue => ({ kind: 'text', value });
const system = (value: string | null): CsvValue => ({ kind: 'system', value });

/** RN-PROC-43: prefixa `'` no texto que a planilha interpretaria como fórmula. */
export function neutralizeFormula(value: string): string {
  return value.length > 0 && FORMULA_TRIGGERS.has(value.charAt(0)) ? `'${value}` : value;
}

/** Célula RFC 4180 com separador `;`: entre aspas com separador, aspas ou quebra de linha. */
export function csvCell(cell: CsvValue): string {
  if (cell.value === null || cell.value === '') return '';
  const value = cell.kind === 'text' ? neutralizeFormula(cell.value) : cell.value;
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** `1200000.00` → `1200000,00` (sem separador de milhar). */
export function formatDecimal(value: string): string {
  return value.replace('.', ',');
}

/** `2026-10-05` → `05/10/2026`. */
export function formatLocalDate(date: string): string {
  const [year = '', month = '', day = ''] = date.split('-');
  return `${day}/${month}/${year}`;
}

function zonedParts(instant: Date, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** Instante → `DD/MM/AAAA` no fuso do tenant. */
export function formatZonedDate(instant: Date, timezone: string): string {
  const part = zonedParts(instant, timezone);
  return `${part.day ?? ''}/${part.month ?? ''}/${part.year ?? ''}`;
}

/** Instante → `DD/MM/AAAA HH:mm` no fuso do tenant. */
export function formatZonedDateTime(instant: Date, timezone: string): string {
  const part = zonedParts(instant, timezone);
  return `${formatZonedDate(instant, timezone)} ${part.hour ?? ''}:${part.minute ?? ''}`;
}

/** Instante → `AAAAMMDD-HHmm` no fuso do tenant (nome do arquivo). */
export function fileStamp(instant: Date, timezone: string): string {
  const part = zonedParts(instant, timezone);
  return `${part.year ?? ''}${part.month ?? ''}${part.day ?? ''}-${part.hour ?? ''}${part.minute ?? ''}`;
}

/** RN-PROC-44: `processos-AAAAMMDD-HHmm.csv` no horário do tenant. */
export function processExportFileName(instant: Date, timezone: string): string {
  return `processos-${fileStamp(instant, timezone)}.csv`;
}

/** Coluna "Situação do prazo". */
export function deadlineSituation(deadline: ProcessDeadlineDto): string {
  if (deadline.isPaused) return DEADLINE_SITUATION_LABELS.paused;
  if (deadline.isOverdue) return DEADLINE_SITUATION_LABELS.overdue;
  if (deadline.dueAt === null) return DEADLINE_SITUATION_LABELS.none;
  return deadline.isDueSoon ? DEADLINE_SITUATION_LABELS.dueSoon : DEADLINE_SITUATION_LABELS.onTime;
}

export interface CsvSerializerContext {
  readonly timezone: string;
  /** `labels.secretariat` / `labels.department` do tenant (cabeçalho). */
  readonly labels: { readonly secretariat: string; readonly department: string };
}

/** Rótulo de "Modalidade" sem modalidade definida (US-002 · `modalityId = none`). */
const MODALITY_NONE = 'A definir';

/** Valores de uma chave de coluna (uma chave pode gerar duas colunas). */
export function columnValues(
  column: ProcessColumnKey,
  item: ProcessListItemDto,
  timezone: string,
): readonly CsvValue[] {
  const dateTime = (iso: string) => system(formatZonedDateTime(new Date(iso), timezone));
  switch (column) {
    case 'code':
      return [text(item.code)];
    case 'title':
      return [text(item.title)];
    case 'status':
      return [text(PROCESS_STATUS_LABELS[item.status])];
    case 'stage':
      return [text(item.currentStage?.name ?? null)];
    case 'currentDepartment':
      return [text(item.currentDepartment.name)];
    case 'currentResponsible':
      return [text(item.currentResponsible?.name ?? null)];
    case 'deadline':
      return [
        system(
          item.deadline.dueAt === null
            ? null
            : formatZonedDate(new Date(item.deadline.dueAt), timezone),
        ),
        text(deadlineSituation(item.deadline)),
      ];
    case 'priority':
      return [text(PRIORITY_LABELS[item.priority])];
    case 'requestingSecretariat':
      return [text(item.requestingSecretariat.name)];
    case 'requestingDepartment':
      return [text(item.requestingDepartment.name)];
    case 'organization':
      return [text(item.organization.shortName)];
    case 'contractingType':
      return [text(item.contractingType.label)];
    case 'modality':
      return [text(item.modality?.label ?? MODALITY_NONE)];
    case 'origin':
      return [text(item.origin.label)];
    case 'estimatedValue':
      return [
        item.estimatedValueMasked
          ? text(CONFIDENTIAL_LABELS.masked)
          : system(item.estimatedValue === null ? null : formatDecimal(item.estimatedValue)),
        text(item.isBudgetConfidential ? CONFIDENTIAL_LABELS.yes : CONFIDENTIAL_LABELS.no),
      ];
    case 'targetDate':
      return [system(item.targetDate === null ? null : formatLocalDate(item.targetDate))];
    case 'tags':
      return [text(item.tags.map((tag) => tag.name).join(' | '))];
    case 'internalCode':
      return [text(item.internalCode)];
    case 'createdAt':
      return [dateTime(item.createdAt)];
    case 'updatedAt':
      return [dateTime(item.updatedAt)];
  }
}

export interface CsvRowSerializer {
  /** BOM + cabeçalho (com o terminador). */
  header(): string;
  /** Uma linha completa (com o terminador). */
  line(item: ProcessListItemDto): string;
}

export function csvRowSerializer(
  columns: readonly ProcessColumnKey[],
  context: CsvSerializerContext,
): CsvRowSerializer {
  return {
    header: () =>
      `${BOM}${columns
        .flatMap((column) => processExportHeaders(column, context.labels))
        .map((label) => csvCell(text(label)))
        .join(CSV_SEPARATOR)}${CRLF}`,
    line: (item) =>
      `${columns
        .flatMap((column) => columnValues(column, item, context.timezone))
        .map(csvCell)
        .join(CSV_SEPARATOR)}${CRLF}`,
  };
}
