import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

/*
 * Métricas do dispatcher (DoD da US-111): pela API do OpenTelemetry — sem provedor registrado, as
 * chamadas são no-op. Rótulo `type` de baixa cardinalidade (registro fechado de `packages/types`).
 */

export interface NotificationInstruments {
  /** Notificações gravadas (novas ou agregadas), por `type` e `outcome`. */
  readonly dispatched: Counter;
  /** E-mail desejado, mas `notifications.emailEnabled` desligado no tenant (`SKIPPED`). */
  readonly emailSkipped: Counter;
}

let instruments: NotificationInstruments | undefined;

export function notificationMetrics(): NotificationInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-worker');
  instruments = {
    dispatched: meter.createCounter('notification_dispatched_total', {
      description: 'Notificações in-app gravadas pelo NotificationDispatcher, por type e outcome.',
    }),
    emailSkipped: meter.createCounter('notification_email_skipped_total', {
      description: 'Notificações com e-mail desejado e desligado no tenant (SKIPPED), por type.',
    }),
  };
  return instruments;
}
