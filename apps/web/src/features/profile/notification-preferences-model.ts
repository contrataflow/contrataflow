import { NOTIFICATION_CHANNELS, defaultChannelEnabled } from '@contrataflow/types';
import type { NotificationChannel, NotificationType } from '@contrataflow/types';
import type {
  NotificationPreferenceChange,
  NotificationPreferenceDto,
} from '@contrataflow/validation';

/*
 * Modelo da grade de preferências (US-113 · SCR-039): agrupamento dos tipos por área, rascunho
 * editável e as combinações a enviar em ME-06. Puro, sem React.
 */

export const NOTIFICATION_AREAS = [
  'processes',
  'approvals',
  'collaboration',
  'deadlines',
  'security',
] as const;
export type NotificationArea = (typeof NOTIFICATION_AREAS)[number];

/** Tipos de cada área (SCR-039: Processos, Aprovações, Colaboração, Prazos, Segurança). */
export const NOTIFICATION_TYPES_BY_AREA: Readonly<
  Record<NotificationArea, readonly NotificationType[]>
> = {
  processes: [
    'PROCESS_RECEIVED',
    'PROCESS_RETURNED',
    'PROCESS_ASSIGNED',
    'PROCESS_STATUS_CHANGED',
    'ATTACHMENT_REJECTED',
    'DOCUMENT_RENDER_FAILED',
    'AI_GENERATION_READY',
    'AI_GENERATION_FAILED',
  ],
  approvals: ['APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'APPROVAL_REASSIGNED'],
  collaboration: ['MENTIONED', 'COMMENT_REPLY', 'PARTICIPANT_ADDED'],
  deadlines: ['STAGE_DUE_SOON', 'STAGE_OVERDUE'],
  security: ['ROLE_CHANGED', 'AI_USAGE_LIMIT_WARNING'],
};

const keyOf = (type: NotificationType, channel: NotificationChannel) => `${type}:${channel}`;

export interface PreferenceCell {
  readonly enabled: boolean;
  readonly editable: boolean;
}

/** Rascunho: valor de cada célula e as que o usuário mandou "usar padrão" (apagar a salva). */
export interface PreferencesDraft {
  readonly cells: ReadonlyMap<string, PreferenceCell>;
  readonly reset: ReadonlySet<string>;
}

export function toPreferencesDraft(items: readonly NotificationPreferenceDto[]): PreferencesDraft {
  return {
    cells: new Map(
      items.map((item) => [
        keyOf(item.notificationType, item.channel),
        { enabled: item.enabled, editable: item.editable },
      ]),
    ),
    reset: new Set(),
  };
}

export function cellOf(
  draft: PreferencesDraft,
  type: NotificationType,
  channel: NotificationChannel,
): PreferenceCell | undefined {
  return draft.cells.get(keyOf(type, channel));
}

/** Liga ou desliga uma célula editável; mexer à mão cancela o "usar padrão" dela. */
export function toggleCell(
  draft: PreferencesDraft,
  type: NotificationType,
  channel: NotificationChannel,
  enabled: boolean,
): PreferencesDraft {
  const key = keyOf(type, channel);
  const cell = draft.cells.get(key);
  if (!cell?.editable) return draft;
  const reset = new Set(draft.reset);
  reset.delete(key);
  return { cells: new Map(draft.cells).set(key, { ...cell, enabled }), reset };
}

/** FA-01 — "Usar padrão" do tipo: valores do registro nas células editáveis, a salva é apagada. */
export function resetType(draft: PreferencesDraft, type: NotificationType): PreferencesDraft {
  const cells = new Map(draft.cells);
  const reset = new Set(draft.reset);
  for (const channel of NOTIFICATION_CHANNELS) {
    const key = keyOf(type, channel);
    const cell = cells.get(key);
    if (!cell?.editable) continue;
    cells.set(key, { ...cell, enabled: defaultChannelEnabled(type, channel) });
    reset.add(key);
  }
  return { cells, reset };
}

/**
 * Combinações de ME-06: o que difere do servidor e o que foi mandado "usar padrão" (`null`).
 * Lista vazia = nada a salvar.
 */
export function buildChanges(
  draft: PreferencesDraft,
  server: readonly NotificationPreferenceDto[],
): NotificationPreferenceChange[] {
  const changes: NotificationPreferenceChange[] = [];
  for (const item of server) {
    if (!item.editable) continue;
    const key = keyOf(item.notificationType, item.channel);
    const cell = draft.cells.get(key);
    if (!cell) continue;
    const { notificationType, channel } = item;
    if (draft.reset.has(key)) changes.push({ notificationType, channel, enabled: null });
    else if (cell.enabled !== item.enabled) {
      changes.push({ notificationType, channel, enabled: cell.enabled });
    }
  }
  return changes;
}
