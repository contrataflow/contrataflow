import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas da varredura de anexos (US-068 · DoD "métricas de duração de varredura e taxa de
 * rejeição"): sem rótulo de tenant nem nome de arquivo (observability.md). `result` ∈
 * `AVAILABLE`/`INFECTED`/`REJECTED`/`DEFERRED`; `reason` = `reasonCode` ou `none`.
 */

interface ScanInstruments {
  readonly scans: Counter;
  readonly duration: Histogram;
}

let instruments: ScanInstruments | undefined;

function scanInstruments(): ScanInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    scans: meter.createCounter('cf_attachment_scans_total', {
      description: 'Varreduras de anexos por resultado e motivo.',
    }),
    duration: meter.createHistogram('cf_attachment_scan_duration_seconds', {
      description: 'Duração da varredura (leitura, tipo, SHA-256 e antivírus) até o resultado.',
      unit: 's',
    }),
  };
  return instruments;
}

export function recordScan(result: string, reason: string | null, durationMs: number): void {
  const { scans, duration } = scanInstruments();
  scans.add(1, { result, reason: reason ?? 'none' });
  if (result !== 'DEFERRED') duration.record(durationMs / 1000, { result });
}
