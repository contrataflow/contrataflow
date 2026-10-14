import 'server-only';

/*
 * Log estruturado do BFF (JSON por linha). A US-084 troca o destino por pino com `redact` e
 * OpenTelemetry sem mudar os eventos. Nunca registrar token, cookie, corpo de requisição/resposta
 * nem o nonce da CSP — por isso os campos aceitos são só escalares.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEvent =
  | 'bff.proxy_request_completed'
  | 'bff.session_refresh_failed'
  | 'bff.csrf_rejected'
  | 'bff.unhandled_exception'
  | 'bff.csp_violation'
  | 'auth.login_started'
  | 'auth.session_created'
  | 'auth.callback_rejected'
  | 'auth.return_to_rejected'
  | 'auth.tenant_switch'
  | 'auth.session_end';

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

type Sink = (line: string) => void;

let sink: Sink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function log(level: LogLevel, event: LogEvent, fields: LogFields = {}): void {
  sink(JSON.stringify({ level, time: new Date().toISOString(), service: 'web', event, ...fields }));
}

/** Só para testes: captura as linhas emitidas. */
export function captureLogsForTests(): { readonly lines: string[]; restore: () => void } {
  const previous = sink;
  const lines: string[] = [];
  sink = (line) => {
    lines.push(line);
  };
  return {
    lines,
    restore: () => {
      sink = previous;
    },
  };
}
