/**
 * Timeline do processo (entities.md §2 e §4.10 `ProcessTimelineEntry` · events.md §5 · DEC-025 ·
 * US-059): o registro `TimelineEntryType` — `varchar(60)` validado aqui, extensível sem migração — e
 * a visibilidade de cada entrada (POL-09). Tipo novo entra primeiro em events.md §5, depois aqui e
 * no mapeamento do `TimelineProjector` (`apps/api/src/modules/timeline/domain`).
 */

export const TIMELINE_ENTRY_TYPES = [
  // Processo
  'PROCESS_CREATED',
  'PROCESS_DUPLICATED_FROM',
  'PROCESS_UPDATED',
  'PROCESS_NUMBER_ASSIGNED',
  'ITEMS_CHANGED',
  'PROCESS_FORWARDED',
  'PROCESS_RETURNED',
  'PROCESS_STAGE_CHANGED',
  'PROCESS_CLAIMED',
  'PROCESS_ASSIGNED',
  'PROCESS_SUSPENDED',
  'PROCESS_RESUMED',
  'PROCESS_CANCELED',
  'PROCESS_COMPLETED',
  'PARTICIPANT_ADDED',
  'PARTICIPANT_REMOVED',
  'CONFIDENTIALITY_CHANGED',
  'STAGE_OVERDUE',
  // Documentos
  'DOCUMENT_CREATED',
  'DOCUMENT_VERSION_CREATED',
  'DOCUMENT_SUBMITTED',
  'DOCUMENT_FINALIZED',
  'DOCUMENT_APPROVED',
  'DOCUMENT_RETURNED',
  'DOCUMENT_REJECTED',
  'DOCUMENT_REOPENED',
  'DOCUMENT_CANCELED',
  'DOCUMENT_WITHDRAWN',
  // Aprovações
  'APPROVAL_REQUESTED',
  'APPROVAL_DECIDED',
  'APPROVAL_CANCELED',
  'APPROVAL_REASSIGNED',
  // Colaboração e arquivos
  'COMMENT_ADDED',
  'COMMENT_REMOVED',
  'ATTACHMENT_ADDED',
  'ATTACHMENT_REMOVED',
  // Artefatos tipados
  'ETP_ALTERNATIVE_RECOMMENDED',
  'QUOTATION_EXCLUDED',
  'QUOTATION_RESTORED',
  'RISK_ADDED',
  'RISK_LEVEL_CHANGED',
  'RISK_REMOVED',
  'TERM_IMPORTED_FROM_ETP',
] as const;

export type TimelineEntryType = (typeof TIMELINE_ENTRY_TYPES)[number];

const ENTRY_TYPES: ReadonlySet<string> = new Set(TIMELINE_ENTRY_TYPES);

export function isTimelineEntryType(value: unknown): value is TimelineEntryType {
  return typeof value === 'string' && ENTRY_TYPES.has(value);
}

/**
 * `STANDARD` para quem vê o processo; `BUDGET_RESTRICTED` quando a entrada revela ou resume valor
 * orçamentário de processo sigiloso — só com `PROCESS_VIEW_CONFIDENTIAL_BUDGET` ou custódia atual
 * (POL-09, aplicada na leitura pela US-060).
 */
export const TIMELINE_VISIBILITIES = ['STANDARD', 'BUDGET_RESTRICTED'] as const;

export type TimelineVisibility = (typeof TIMELINE_VISIBILITIES)[number];

/**
 * Grupos de apresentação da timeline (US-060 · RN-TML-12): filtro `group` de PRC-12 e ícone da
 * entrada no frontend. Não é coluna no banco — a API traduz os grupos em `type IN (…)`. Todo tipo
 * novo do registro entra em exatamente um grupo (teste em `timeline.test.ts`).
 */
export const TIMELINE_GROUPS = [
  'PROCESSO',
  'TRAMITACAO',
  'DOCUMENTOS',
  'APROVACOES',
  'COMENTARIOS',
] as const;

export type TimelineGroup = (typeof TIMELINE_GROUPS)[number];

export const TIMELINE_GROUP_TYPES: Readonly<Record<TimelineGroup, readonly TimelineEntryType[]>> = {
  PROCESSO: [
    'PROCESS_CREATED',
    'PROCESS_DUPLICATED_FROM',
    'PROCESS_UPDATED',
    'PROCESS_NUMBER_ASSIGNED',
    'ITEMS_CHANGED',
    'PROCESS_SUSPENDED',
    'PROCESS_RESUMED',
    'PROCESS_CANCELED',
    'PROCESS_COMPLETED',
    'CONFIDENTIALITY_CHANGED',
    'PARTICIPANT_ADDED',
    'PARTICIPANT_REMOVED',
  ],
  TRAMITACAO: [
    'PROCESS_FORWARDED',
    'PROCESS_RETURNED',
    'PROCESS_STAGE_CHANGED',
    'PROCESS_CLAIMED',
    'PROCESS_ASSIGNED',
    'STAGE_OVERDUE',
  ],
  DOCUMENTOS: [
    'DOCUMENT_CREATED',
    'DOCUMENT_VERSION_CREATED',
    'DOCUMENT_SUBMITTED',
    'DOCUMENT_FINALIZED',
    'DOCUMENT_APPROVED',
    'DOCUMENT_RETURNED',
    'DOCUMENT_REJECTED',
    'DOCUMENT_REOPENED',
    'DOCUMENT_CANCELED',
    'DOCUMENT_WITHDRAWN',
    'ETP_ALTERNATIVE_RECOMMENDED',
    'QUOTATION_EXCLUDED',
    'QUOTATION_RESTORED',
    'RISK_ADDED',
    'RISK_LEVEL_CHANGED',
    'RISK_REMOVED',
    'TERM_IMPORTED_FROM_ETP',
  ],
  APROVACOES: [
    'APPROVAL_REQUESTED',
    'APPROVAL_DECIDED',
    'APPROVAL_CANCELED',
    'APPROVAL_REASSIGNED',
  ],
  COMENTARIOS: ['COMMENT_ADDED', 'COMMENT_REMOVED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED'],
};

const GROUP_OF: ReadonlyMap<string, TimelineGroup> = new Map(
  TIMELINE_GROUPS.flatMap((group) => TIMELINE_GROUP_TYPES[group].map((type) => [type, group])),
);

export function isTimelineGroup(value: unknown): value is TimelineGroup {
  return typeof value === 'string' && (TIMELINE_GROUPS as readonly string[]).includes(value);
}

/** Grupo do tipo; tipo fora do registro (entrada antiga de tipo removido) = `PROCESSO`. */
export function timelineGroupOf(type: string): TimelineGroup {
  return GROUP_OF.get(type) ?? 'PROCESSO';
}

/** Tipos dos grupos selecionados (OU — RN-TML-12), sem repetição. */
export function timelineTypesOfGroups(groups: readonly TimelineGroup[]): TimelineEntryType[] {
  return [...new Set(groups.flatMap((group) => TIMELINE_GROUP_TYPES[group]))];
}
