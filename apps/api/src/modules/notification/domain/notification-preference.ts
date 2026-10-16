import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  defaultChannelEnabled,
  isNotificationChannelEditable,
} from '@contrataflow/types';
import type { NotificationChannel, NotificationType } from '@contrataflow/types';

/*
 * Preferências de notificação (US-113 · RN-NTF-22..25): regras puras sobre o registro
 * `NotificationType`. Ausência de linha = padrão do registro; o in-app dos tipos obrigatórios é
 * sempre ligado e não editável.
 */

/** Uma preferência salva: a linha de `notification_preferences` do próprio usuário. */
export interface StoredPreference {
  readonly notificationType: NotificationType;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

/** Valor efetivo de uma combinação, com a trava de edição (itens de ME-05/ME-06). */
export interface EffectivePreference {
  readonly notificationType: NotificationType;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
  readonly editable: boolean;
}

/** Combinação pedida em ME-06: `enabled = null` restaura o padrão do registro (FA-01). */
export interface PreferenceChange {
  readonly notificationType: NotificationType;
  readonly channel: NotificationChannel;
  readonly enabled: boolean | null;
}

/** Alteração do estado salvo (`null` = sem linha, vale o padrão): base da auditoria (RN-NTF-26). */
export interface PreferenceDelta {
  readonly notificationType: NotificationType;
  readonly channel: NotificationChannel;
  readonly from: boolean | null;
  readonly to: boolean | null;
}

/** RN-NTF-23: tentativa de desligar o in-app de um tipo obrigatório (V-02). */
export class MandatoryChannelError extends Error {
  constructor(
    readonly notificationType: NotificationType,
    /** Posição do item no corpo, para apontar o campo no erro de validação. */
    readonly index: number,
  ) {
    super(`${notificationType}: o canal IN_APP é obrigatório`);
    this.name = 'MandatoryChannelError';
  }
}

const keyOf = (type: NotificationType, channel: NotificationChannel) => `${type}:${channel}`;

/** Todas as combinações tipo × canal, na ordem do registro: salvo, ou o padrão (RN-NTF-22). */
export function effectivePreferences(
  stored: readonly StoredPreference[],
): readonly EffectivePreference[] {
  const saved = new Map(stored.map((item) => [keyOf(item.notificationType, item.channel), item]));
  const result: EffectivePreference[] = [];
  for (const notificationType of NOTIFICATION_TYPES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const editable = isNotificationChannelEditable(notificationType, channel);
      const override = saved.get(keyOf(notificationType, channel));
      result.push({
        notificationType,
        channel,
        // Canal travado ignora linha antiga (ex.: gravada antes do tipo virar obrigatório).
        enabled: editable
          ? (override?.enabled ?? defaultChannelEnabled(notificationType, channel))
          : true,
        editable,
      });
    }
  }
  return result;
}

/**
 * ME-06 como merge (RN-NTF-25): só as combinações enviadas mudam. Devolve apenas o que altera o
 * estado salvo — reenviar o mesmo valor não gera escrita nem auditoria (idempotência).
 * @throws MandatoryChannelError ao desligar o in-app de tipo obrigatório (RN-NTF-23)
 */
export function planPreferenceChanges(
  stored: readonly StoredPreference[],
  requested: readonly PreferenceChange[],
): readonly PreferenceDelta[] {
  const saved = new Map(
    stored.map((item) => [keyOf(item.notificationType, item.channel), item.enabled]),
  );
  const deltas: PreferenceDelta[] = [];
  for (const [index, change] of requested.entries()) {
    const { notificationType, channel } = change;
    if (!isNotificationChannelEditable(notificationType, channel)) {
      if (change.enabled === false) throw new MandatoryChannelError(notificationType, index);
      continue; // Canal travado já vale ligado: nada a gravar.
    }
    const from = saved.get(keyOf(notificationType, channel)) ?? null;
    if (from !== change.enabled)
      deltas.push({ notificationType, channel, from, to: change.enabled });
  }
  return deltas;
}
