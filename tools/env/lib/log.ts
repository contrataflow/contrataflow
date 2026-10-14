// Saída dos scripts `pnpm env:*` (story US-078 — Logs). Uma linha por evento: ícone, nome do
// evento e mensagem; dados estruturados opcionais em JSON. Nunca recebe valores do `.env`.

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  readonly info: (event: string, message: string, data?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (event: string, message: string, data?: Readonly<Record<string, unknown>>) => void;
  readonly error: (
    event: string,
    message: string,
    data?: Readonly<Record<string, unknown>>,
  ) => void;
  /** Texto livre (passos, dicas), sem nível. */
  readonly step: (message: string) => void;
}

const ICONS: Readonly<Record<LogLevel, string>> = { info: '✔', warn: '⚠', error: '✖' };

export function formatLine(
  level: LogLevel,
  event: string,
  message: string,
  data?: Readonly<Record<string, unknown>>,
): string {
  const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  return `${ICONS[level]} ${event} — ${message}${suffix}`;
}

export const consoleLogger: Logger = {
  info: (event, message, data) => {
    console.log(formatLine('info', event, message, data));
  },
  warn: (event, message, data) => {
    console.warn(formatLine('warn', event, message, data));
  },
  error: (event, message, data) => {
    console.error(formatLine('error', event, message, data));
  },
  step: (message) => {
    console.log(message);
  },
};

/** Logger que só acumula as linhas (testes). */
export function memoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (event, message, data) => lines.push(formatLine('info', event, message, data)),
    warn: (event, message, data) => lines.push(formatLine('warn', event, message, data)),
    error: (event, message, data) => lines.push(formatLine('error', event, message, data)),
    step: (message) => lines.push(message),
  };
}

/** Erro com código estável (`ENV_FILE_MISSING`, `SERVICE_UNHEALTHY`…) para a saída dos scripts. */
export class EnvError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EnvError';
    this.code = code;
  }
}
