import { isSpanContextValid, trace } from '@opentelemetry/api';
import { pino } from 'pino';
import type { DestinationStream, Level, Logger, LoggerOptions } from 'pino';

import {
  REDACTED,
  SENSITIVE_KEYS,
  maskEmail,
  redact,
  scrubText,
  serializeError,
} from './redaction.js';

/** Níveis aceitos em `LOG_LEVEL` (observability.md §2.3). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Níveis nunca habilitados em produção (RN-FND-72 · V-03). */
export const PRODUCTION_FORBIDDEN_LEVELS: readonly LogLevel[] = ['debug', 'trace'];

/** `event` de linhas que chegaram sem um (ex.: mensagens internas do NestJS). */
export const DEFAULT_LOG_EVENT = 'app.log';

export type ServiceName = 'web' | 'api' | 'worker';

/** Campos de contexto aceitos em toda linha (correlação, tenant, job…). */
export type LogContextFields = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export interface CreateLoggerOptions {
  readonly service: ServiceName;
  /** Ambiente lógico (`APP_ENV`). */
  readonly env: string;
  /** Versão + commit (`APP_VERSION`). */
  readonly version: string;
  readonly level: LogLevel;
  /** Campos do contexto atual (requisição ou job), lidos a cada linha. */
  readonly context?: () => LogContextFields | undefined;
  /** Destino das linhas (padrão: stdout). Usado pelos testes. */
  readonly destination?: DestinationStream;
}

/** Nível numérico do pino a partir do qual o `stack` do erro é mantido (`error`). */
const ERROR_LEVEL = 50;

/**
 * Logger pino comum a web, api e worker (RN-FND-71): JSON em stdout, uma linha por evento, com
 * `time` ISO 8601 UTC, `level` em texto, `service`/`env`/`version`, o contexto da requisição/job,
 * `traceId`/`spanId` do span ativo e redação de DEC-138 aplicada a tudo que é logado.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const config: LoggerOptions = {
    level: options.level,
    base: { service: options.service, env: options.env, version: options.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => redact(bindings) as Record<string, unknown>,
      log: (object) => {
        const clean = redact(object) as Record<string, unknown>;
        return { event: clean.event ?? DEFAULT_LOG_EVENT, ...clean };
      },
    },
    serializers: { err: (error: unknown) => serializeError(error) },
    // Bindings de `child()` não passam por `formatters.log`: o `redact` do pino cobre o 1º nível.
    redact: {
      paths: [...SENSITIVE_KEYS],
      censor: (value, path) => (path.at(-1) === 'email' ? maskEmail(value) : REDACTED),
    },
    mixin: () => ({ ...definedFields(options.context?.()), ...activeTraceFields() }),
    hooks: {
      logMethod(args, method, level) {
        method.apply(
          this,
          normalizeLogArguments(args as unknown[], level) as Parameters<typeof method>,
        );
      },
    },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

/**
 * Padroniza a chamada: garante `msg` (o `event` quando não houver texto), redige o texto e tira o
 * `stack` de erros logados abaixo de `error` (observability.md §2.2).
 */
export function normalizeLogArguments(args: readonly unknown[], level: number): unknown[] {
  const [first, ...rest] = args;
  if (typeof first === 'string') {
    const legacy = parseLegacyMessage(first);
    return legacy ? [legacy, scrubText(legacy.event), ...rest] : [scrubText(first), ...rest];
  }
  if (first instanceof Error) {
    const message = typeof rest[0] === 'string' ? rest[0] : first.message;
    return [{ err: serializeError(first, { stack: level >= ERROR_LEVEL }) }, scrubText(message)];
  }
  if (first === null || typeof first !== 'object') return [...args];
  let object = { ...(first as Record<string, unknown>) };
  if (object.err !== undefined) {
    object.err = serializeError(object.err, { stack: level >= ERROR_LEVEL });
  }
  let explicit = typeof rest[0] === 'string' ? rest[0] : undefined;
  const legacy =
    explicit !== undefined && object.event === undefined ? parseLegacyMessage(explicit) : null;
  if (legacy) {
    object = { ...object, ...legacy };
    explicit = legacy.event;
  }
  const fromObject = typeof object.msg === 'string' ? object.msg : undefined;
  const event = typeof object.event === 'string' ? object.event : undefined;
  delete object.msg;
  const message = explicit ?? fromObject ?? event ?? DEFAULT_LOG_EVENT;
  const consumed = typeof rest[0] === 'string' ? 1 : 0;
  return [object, scrubText(message), ...rest.slice(consumed)];
}

const LEGACY_EVENT = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const LEGACY_FIELD = /^[A-Za-z][A-Za-z0-9]*=/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/**
 * Compatibilidade com o formato da US-080/US-081 (`evento chave=valor …`): vira `{ event, …campos }`
 * — valores numéricos como número e `-` como `null`. Texto em outro formato fica como `msg`.
 * Código novo loga objetos: `logger.log({ event: 'x.y', campo })`.
 */
export function parseLegacyMessage(
  text: string,
): ({ event: string } & Record<string, unknown>) | null {
  const [head = '', ...tail] = text.split(' ');
  if (!LEGACY_EVENT.test(head)) return null;
  const remainder = tail.join(' ');
  if (remainder !== '' && !LEGACY_FIELD.test(remainder)) return null;
  const fields: Record<string, unknown> = {};
  for (const pair of remainder === '' ? [] : remainder.split(/ (?=[A-Za-z][A-Za-z0-9]*=)/)) {
    const separator = pair.indexOf('=');
    const value = pair.slice(separator + 1);
    fields[pair.slice(0, separator)] =
      value === '-' ? null : NUMERIC.test(value) ? Number(value) : value;
  }
  return { ...fields, event: head };
}

function definedFields(fields: LogContextFields | undefined): Record<string, unknown> {
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  );
}

/** `traceId`/`spanId` do span ativo (FA-02: sem span, nenhum campo — e nenhum erro). */
export function activeTraceFields(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const context = span.spanContext();
  if (!isSpanContextValid(context)) return {};
  return { traceId: context.traceId, spanId: context.spanId };
}

/** Rejeita `debug`/`trace` em produção (V-03); devolve o nível validado. */
export function assertLogLevelAllowed(level: LogLevel, production: boolean): LogLevel {
  if (production && PRODUCTION_FORBIDDEN_LEVELS.includes(level)) {
    throw new Error(`LOG_LEVEL=${level} não é permitido em produção.`);
  }
  return level;
}

export type { DestinationStream, Level, Logger };
