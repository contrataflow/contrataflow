import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

import { currentRequestContext } from '../context/request-context.js';

/*
 * Violações de isolamento entre tenants (US-100 · RN-TEN-23/30/31 · FA-06): erros de programação,
 * nunca comportamento esperado. Abortam a transação, viram 500 `INTERNAL_ERROR` sem detalhe ao
 * cliente e acionam o alerta S1 do runbook "Suspeita de vazamento entre tenants" pelo log `error`
 * `security.*` e pelas métricas abaixo (sem `tenantId` como rótulo — multi-tenancy.md §12).
 */

/** Barreira que detectou o problema (RN-TEN-34 · campo `barrier` do log de segurança). */
export type IsolationBarrier = 'prisma_extension' | 'rls' | 'storage' | 'cache' | 'job' | 'context';

/**
 * Operação de dados de tenant sem contexto de tenant (requisição ou job): falha fechada antes de
 * tocar no banco, no cache, no storage ou na fila (V-06 · V-09).
 */
export class TenantContextMissingError extends Error {
  constructor(
    detail = 'Operação de dados de tenant sem tenant no contexto da requisição ou do job.',
  ) {
    super(detail);
    this.name = 'TenantContextMissingError';
  }
}

/**
 * Dado de outro tenant alcançado ou referenciado (V-07 · V-08): `tenantId` divergente na escrita,
 * escrita barrada pela RLS, chave de storage/cache fora do prefixo do tenant, transação aberta para
 * outro tenant dentro de um contexto `TENANT` (RN-TEN-21).
 */
export class TenantIsolationViolationError extends Error {
  constructor(
    readonly barrier: IsolationBarrier,
    detail: string,
    options?: { readonly cause?: unknown },
  ) {
    super(detail, options);
    this.name = 'TenantIsolationViolationError';
  }
}

interface IsolationInstruments {
  readonly violations: Counter;
  readonly contextMissing: Counter;
  readonly contextOverhead: Histogram;
  readonly systemDbCalls: Counter;
}

let instruments: IsolationInstruments | undefined;

/** Métricas de isolamento (OpenTelemetry; no-op até a US-085 registrar o provedor). */
export function isolationMetrics(): IsolationInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    violations: meter.createCounter('cf_tenant_isolation_violations_total', {
      description: 'Violações de isolamento entre tenants detectadas, por barreira (US-100).',
    }),
    contextMissing: meter.createCounter('cf_tenant_context_missing_total', {
      description: 'Operações de dados de tenant bloqueadas por falta de contexto (US-100).',
    }),
    contextOverhead: meter.createHistogram('cf_tenant_context_overhead_seconds', {
      description: 'Custo do set_config do contexto no início de cada transação (meta p95 ≤ 2 ms).',
      unit: 's',
    }),
    systemDbCalls: meter.createCounter('cf_system_db_calls_total', {
      description: 'Chamadas ao SystemDbService (papel cf_platform), por motivo (RN-TEN-28).',
    }),
  };
  return instruments;
}

const logger = new Logger('Security');

/** Campos de diagnóstico sem dados de negócio: modelo/operação, chave mascarada, fila… */
export type IsolationDetails = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Registra a operação sem contexto (`error security.tenant_context_missing` + métrica) e devolve o
 * erro a lançar. Nenhum dado da consulta vai para o log.
 */
export function tenantContextMissing(
  barrier: IsolationBarrier,
  details: IsolationDetails = {},
): TenantContextMissingError {
  isolationMetrics().contextMissing.add(1, { barrier });
  logger.error(
    {
      event: 'security.tenant_context_missing',
      barrier,
      ...details,
      correlationId: currentRequestContext()?.correlationId ?? null,
    },
    'security.tenant_context_missing',
  );
  return new TenantContextMissingError();
}

/**
 * Registra a violação (`error security.tenant_isolation_violation` + métrica por barreira) e
 * devolve o erro a lançar. Os detalhes nunca chegam ao cliente (500 genérico com correlationId).
 */
export function tenantIsolationViolation(
  barrier: IsolationBarrier,
  reason: string,
  details: IsolationDetails = {},
  cause?: unknown,
): TenantIsolationViolationError {
  isolationMetrics().violations.add(1, { barrier });
  logger.error(
    {
      event: 'security.tenant_isolation_violation',
      barrier,
      reason,
      ...details,
      correlationId: currentRequestContext()?.correlationId ?? null,
    },
    'security.tenant_isolation_violation',
  );
  return new TenantIsolationViolationError(
    barrier,
    reason,
    cause === undefined ? undefined : { cause },
  );
}
