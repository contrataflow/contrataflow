import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas da exportação CSV da lista (US-003 · DoD): `process_export_total{outcome}`
 * (`completed`, `too_large`, `failed`, `aborted`), duração e tamanho do arquivo. Pela API do
 * OpenTelemetry: sem provedor registrado, no-op. Rótulos só de baixa cardinalidade.
 */

interface ProcessExportInstruments {
  readonly exports: Counter;
  readonly duration: Histogram;
  readonly bytes: Histogram;
}

let instruments: ProcessExportInstruments | undefined;

export function processExportMetrics(): ProcessExportInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    exports: meter.createCounter('process_export_total', {
      description: 'Exportações CSV da lista de processos, por resultado (PRC-34 · US-003).',
    }),
    duration: meter.createHistogram('process_export_duration_ms', {
      description: 'Duração da exportação CSV, da contagem ao último byte (meta p95 < 15 s).',
      unit: 'ms',
    }),
    bytes: meter.createHistogram('process_export_bytes', {
      description: 'Tamanho do arquivo CSV exportado.',
      unit: 'By',
    }),
  };
  return instruments;
}
