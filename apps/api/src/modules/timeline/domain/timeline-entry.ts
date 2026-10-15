import type { ActorType, TimelineEntryType, TimelineVisibility } from '@contrataflow/types';

/*
 * `ProcessTimelineEntry` (entities.md §4.10 · US-059): projeção de leitura imutável, com nomes
 * congelados no momento do fato (RN-TML-04). Não é auditoria (DEC-025 · RN-TML-06): sem IP,
 * user-agent nem diff antes/depois.
 */

/** Parâmetros de renderização da mensagem (pt-BR no frontend): só JSON, sem valor sigiloso. */
export type TimelineParams = Readonly<Record<string, unknown>>;

/** O que o mapeamento de um evento produz para cada entrada (RN-TML-02 · RN-TML-08). */
export interface TimelineEntryProjection {
  readonly type: TimelineEntryType;
  readonly params: TimelineParams;
  readonly visibility: TimelineVisibility;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly movementId: string | null;
}

/** Linha completa gravada em `process_timeline_entries`. */
export interface ProcessTimelineEntry extends TimelineEntryProjection {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly occurredAt: Date;
  readonly actorType: ActorType;
  /** Usuário que agiu; nulo para `SYSTEM`. */
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly actorDepartmentName: string | null;
  /** `eventId` de origem (idempotência com `type` — RN-TML-03). */
  readonly sourceEventId: string;
}

/** Campos do produtor que revelam valor orçamentário (POL-09 · RN-TML-05). */
export const BUDGET_VALUE_FIELDS: ReadonlySet<string> = new Set(['estimatedValue']);

/**
 * Visibilidade da entrada (RN-TML-05): `BUDGET_RESTRICTED` quando ela revela ou resume valor de
 * processo sigiloso. Sigilo desconhecido (processo não encontrado) falha fechado: restrita.
 */
export function budgetVisibility(
  revealsBudget: boolean,
  process: { readonly isBudgetConfidential: boolean } | null,
): TimelineVisibility {
  if (!revealsBudget) return 'STANDARD';
  return process?.isBudgetConfidential === false ? 'STANDARD' : 'BUDGET_RESTRICTED';
}

/** Trecho de comentário exibido na timeline (events.md §5 — até 140 caracteres). */
export const COMMENT_EXCERPT_MAX = 140;

const graphemes = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });

/** Caracteres percebidos (grafemas): acento combinado ou emoji composto contam como um. */
export function graphemesOf(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

export function commentExcerpt(text: string | null): string | null {
  if (text === null) return null;
  const chars = graphemesOf(text.trim());
  return chars.length <= COMMENT_EXCERPT_MAX
    ? chars.join('')
    : `${chars.slice(0, COMMENT_EXCERPT_MAX - 1).join('')}…`;
}

/**
 * Payload do evento sem um campo exigido pelo mapeamento (V-01): erro de programação — o caso de
 * uso de origem é desfeito (500 `INTERNAL_ERROR`). A mensagem traz só caminhos e códigos dos
 * problemas, nunca valores do payload.
 */
export class TimelinePayloadError extends Error {
  constructor(
    readonly eventType: string,
    readonly issues: readonly string[],
  ) {
    super(`Evento ${eventType} sem os campos exigidos pela timeline: ${issues.join('; ')}`);
    this.name = 'TimelinePayloadError';
  }
}
