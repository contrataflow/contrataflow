import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

/*
 * Métricas do `EmailSender` (DoD da US-112): pela API do OpenTelemetry — sem provedor registrado,
 * no-op. Rótulos de baixa cardinalidade: `kind` (`NOTIFICATION`/`INVITATION`), `provider` e
 * `reason` (códigos fechados). Alimentam o alerta de falha > 5% em 15 min (queues.md §12).
 */

export interface EmailInstruments {
  readonly sent: Counter;
  readonly failed: Counter;
  readonly skipped: Counter;
}

let instruments: EmailInstruments | undefined;

export function emailMetrics(): EmailInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-worker');
  instruments = {
    sent: meter.createCounter('email_sent_total', {
      description: 'E-mails transacionais aceitos pelo provedor, por kind e provider.',
    }),
    failed: meter.createCounter('email_failed_total', {
      description: 'E-mails transacionais gravados como FAILED, por kind e reason.',
    }),
    skipped: meter.createCounter('email_skipped_total', {
      description: 'E-mails transacionais pulados no envio (SKIPPED), por kind e reason.',
    }),
  };
  return instruments;
}
