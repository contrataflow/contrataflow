import 'server-only';

import { createLogger } from '@contrataflow/observability';
import type { Logger } from '@contrataflow/observability';

import { webTelemetryConfig } from '@/config/telemetry';

/*
 * Log estruturado do BFF (RN-FND-71 · US-084): pino em JSON para stdout com `service=web`,
 * ambiente, versão, `traceId`/`spanId` do span ativo e a redação de DEC-138 do pacote
 * `@contrataflow/observability` (token, cookie, corpo, e-mail…). Os campos aceitos continuam só
 * escalares — nunca corpo de requisição/resposta nem o nonce da CSP.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEvent =
  | 'bff.proxy_request_completed'
  | 'bff.session_refresh_failed'
  | 'bff.csrf_rejected'
  | 'bff.unhandled_exception'
  | 'bff.csp_violation'
  | 'auth.session_store_unavailable'
  | 'auth.login_started'
  | 'auth.login_unavailable'
  | 'auth.session_created'
  | 'auth.session_evicted'
  | 'auth.callback_rejected'
  | 'auth.token_exchange_failed'
  | 'auth.directory_unavailable'
  | 'auth.tenant_activation_failed'
  | 'auth.rate_limited'
  | 'auth.rate_limit_degraded'
  | 'auth.return_to_rejected'
  | 'auth.tenant_switch'
  | 'auth.tenant_switch_rejected'
  | 'auth.logout'
  | 'auth.session_expired'
  | 'auth.refresh_failed'
  | 'auth.rp_logout_unavailable'
  | 'auth.reauthentication_required'
  | 'auth.recovery_redirect'
  | 'auth.recovery_unavailable'
  | 'tracing.disabled';

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

type Sink = (line: string) => void;

let sink: Sink = (line) => {
  process.stdout.write(line);
};

let instance: Logger | undefined;

/** Logger pino do BFF (criado no primeiro uso, com a configuração validada). */
export function bffLogger(): Logger {
  if (!instance) {
    const config = webTelemetryConfig();
    instance = createLogger({
      service: 'web',
      env: config.environment,
      version: config.version,
      level: config.logLevel,
      destination: {
        write: (line: string) => {
          sink(line);
        },
      },
    });
  }
  return instance;
}

export function log(level: LogLevel, event: LogEvent, fields: LogFields = {}): void {
  bffLogger()[level]({ ...fields, event }, event);
}

/** Só para testes: captura as linhas emitidas (JSON, uma por evento). */
export function captureLogsForTests(): { readonly lines: string[]; restore: () => void } {
  const previous = sink;
  const lines: string[] = [];
  sink = (line) => {
    lines.push(line.trimEnd());
  };
  return {
    lines,
    restore: () => {
      sink = previous;
    },
  };
}
