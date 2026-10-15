import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { Attributes, Context, Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

/*
 * Spans de negócio e propagação W3C Trace Context (RN-FND-76/78 · observability.md §4.2–§4.3).
 * Sem SDK registrado, a API do OpenTelemetry é no-op: estes helpers nunca falham por ausência de
 * tracing.
 */

export const TRACER_NAME = '@contrataflow/observability';

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Atributos fora do prefixo `cf.` aceitos nos spans manuais (convenções do OpenTelemetry). */
const STANDARD_ATTRIBUTES = new Set([
  'enduser.id',
  'messaging.message.id',
  'messaging.destination.name',
  'messaging.operation.type',
]);

const CF_ATTRIBUTE = /^cf\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

/** Últimos segmentos de nome que denunciam dado proibido (§4.3: nomes, e-mails, CPF, IP, valores…). */
const FORBIDDEN_SEGMENTS = new Set([
  'name',
  'email',
  'cpf',
  'ip',
  'url',
  'file_name',
  'filename',
  'token',
  'content',
  'value',
  'amount',
  'price',
  'password',
  'secret',
  'sql',
  'query',
]);

/** Valor textual permitido: UUID, código, enum ou chave técnica — sem espaço, `@` ou `/`. */
const SAFE_TEXT = /^[A-Za-z0-9_.:-]{1,128}$/;
const CPF_LIKE = /^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/;
const IPV4_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export type SpanAttributeInput = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export interface SanitizedAttributes {
  readonly attributes: Attributes;
  /** Chaves descartadas (nunca os valores). */
  readonly dropped: readonly string[];
}

/** Política de atributos de spans manuais (RN-FND-78 · V-04): o que não é permitido é descartado. */
export function sanitizeSpanAttributes(input: SpanAttributeInput): SanitizedAttributes {
  const attributes: Attributes = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (isAllowedAttribute(key, value)) attributes[key] = value;
    else dropped.push(key);
  }
  return { attributes, dropped };
}

function isAllowedAttribute(key: string, value: string | number | boolean): boolean {
  if (!STANDARD_ATTRIBUTES.has(key)) {
    if (!CF_ATTRIBUTE.test(key)) return false;
    if (FORBIDDEN_SEGMENTS.has(key.slice(key.lastIndexOf('.') + 1))) return false;
  }
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return SAFE_TEXT.test(value) && !CPF_LIKE.test(value) && !IPV4_LIKE.test(value);
}

export interface WithSpanOptions {
  readonly kind?: SpanKind;
  /** Contexto pai (padrão: o ativo). */
  readonly parent?: Context;
}

/**
 * Executa `fn` dentro de um span manual (padrão de referência das stories de negócio):
 * atributos filtrados pela allowlist, status `ERROR` com o tipo da exceção (nunca a mensagem) e
 * encerramento garantido. Uso: `await withSpan('process.forward', { 'cf.process.id': id }, fn)`.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributeInput,
  fn: (span: Span) => T | Promise<T>,
  options: WithSpanOptions = {},
): Promise<T> {
  const { attributes: allowed, dropped } = sanitizeSpanAttributes(attributes);
  if (dropped.length > 0) allowed['cf.attributes.dropped'] = dropped.length;
  return tracer().startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: allowed },
    options.parent ?? context.active(),
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute('exception.type', error instanceof Error ? error.name : typeof error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Contexto W3C serializável (envelope do outbox, `JobMeta`, cabeçalhos). Sem *baggage*. */
export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

const propagator = new W3CTraceContextPropagator();

const carrierSetter = {
  set(carrier: TraceCarrier, key: string, value: string) {
    if (key === 'traceparent' || key === 'tracestate') carrier[key] = value;
  },
};

const carrierGetter = {
  get(carrier: TraceCarrier, key: string) {
    return key === 'traceparent' || key === 'tracestate' ? carrier[key] : undefined;
  },
  keys(carrier: TraceCarrier) {
    return Object.keys(carrier);
  },
};

/** `traceparent`/`tracestate` do span ativo (vazio se não houver span amostrável). */
export function injectTraceCarrier(from: Context = context.active()): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagator.inject(from, carrier, carrierSetter);
  return carrier;
}

/** Contexto pai a partir de um carrier recebido; carrier inválido → raiz nova (sem erro). */
export function extractTraceContext(carrier: TraceCarrier | null | undefined): Context {
  if (!carrier) return ROOT_CONTEXT;
  return propagator.extract(ROOT_CONTEXT, carrier, carrierGetter);
}

export { SpanKind };
export type { Span };
