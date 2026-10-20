import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas da timeline (US-059 · DoD): `timeline_entries_projected_total{type}`, duplicidades
 * absorvidas, falhas e a duração da projeção dentro da transação hospedeira (meta p95 < 20 ms).
 * Pela API do OpenTelemetry: no-op até a US-085 registrar o provedor. Rótulos de baixa
 * cardinalidade.
 */

interface TimelineInstruments {
  readonly projected: Counter;
  readonly duplicates: Counter;
  readonly failed: Counter;
  readonly duration: Histogram;
}

let instruments: TimelineInstruments | undefined;

export function timelineMetrics(): TimelineInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    projected: meter.createCounter('timeline_entries_projected_total', {
      description: 'Entradas de timeline gravadas na transação do caso de uso (US-059).',
    }),
    duplicates: meter.createCounter('timeline_duplicates_ignored_total', {
      description:
        'Entradas já existentes absorvidas pela unicidade (reprocessamento — RN-TML-03).',
    }),
    failed: meter.createCounter('timeline_projection_failed_total', {
      description: 'Projeções que falharam (a transação de origem é desfeita).',
    }),
    duration: meter.createHistogram('timeline_projection_duration_ms', {
      description: 'Duração da projeção de um evento (leituras auxiliares e INSERT).',
      unit: 'ms',
    }),
  };
  return instruments;
}

interface TimelineReadInstruments {
  readonly listDuration: Histogram;
}

let readInstruments: TimelineReadInstruments | undefined;

/**
 * Leitura da timeline (US-060 · DoD): `timeline_list_duration_ms{filtered}` — latência de PRC-12
 * no caso de uso (meta p95 < 300 ms para páginas de até 50 itens — RN-TML-16).
 */
export function timelineReadMetrics(): TimelineReadInstruments {
  if (readInstruments) return readInstruments;
  const meter = metrics.getMeter('contrataflow-api');
  readInstruments = {
    listDuration: meter.createHistogram('timeline_list_duration_ms', {
      description: 'Duração da leitura paginada da timeline do processo (PRC-12).',
      unit: 'ms',
    }),
  };
  return readInstruments;
}
