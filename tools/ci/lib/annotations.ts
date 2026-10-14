// Saída dos scripts do CI (US-079 — Logs): comandos de workflow do GitHub Actions (anotações
// inline no PR, outputs e resumo do job) e eventos `ci.*` no formato dos scripts `env:*`.
// Nunca recebe segredos: mensagens citam caminho, linha e regra, nunca o valor encontrado.
import { appendFileSync } from 'node:fs';

import { formatLine } from '../../env/lib/log.js';
import type { LogLevel } from '../../env/lib/log.js';

export type AnnotationLevel = 'error' | 'warning' | 'notice';

export interface AnnotationProps {
  readonly file?: string;
  readonly line?: number;
  readonly col?: number;
  readonly title?: string;
}

/** Escapa a mensagem de um comando de workflow (`%`, CR e LF). */
export function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escapa o valor de uma propriedade (`file=`, `title=`…): também `:` e `,`. */
export function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** Linha `::error file=…,line=…::mensagem` — vira anotação no arquivo e linha do PR. */
export function annotation(
  level: AnnotationLevel,
  message: string,
  props: AnnotationProps = {},
): string {
  const entries: string[] = [];
  if (props.file !== undefined) entries.push(`file=${escapeProperty(props.file)}`);
  if (props.line !== undefined) entries.push(`line=${props.line}`);
  if (props.col !== undefined) entries.push(`col=${props.col}`);
  if (props.title !== undefined) entries.push(`title=${escapeProperty(props.title)}`);
  const head = entries.length > 0 ? ` ${entries.join(',')}` : '';
  return `::${level}${head}::${escapeData(message)}`;
}

/** Valor para `$GITHUB_OUTPUT`; multilinha usa delimitador (heredoc do GitHub). */
export function outputLine(name: string, value: string, delimiter = 'CF_EOF'): string {
  if (!value.includes('\n')) return `${name}=${value}\n`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

export interface CiReporter {
  readonly annotate: (level: AnnotationLevel, message: string, props?: AnnotationProps) => void;
  readonly log: (
    level: LogLevel,
    event: string,
    message: string,
    data?: Readonly<Record<string, unknown>>,
  ) => void;
  readonly setOutput: (name: string, value: string) => void;
  readonly summary: (markdown: string) => void;
  readonly lines: readonly string[];
}

export interface ReporterOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Saída padrão (testes injetam um coletor). */
  readonly write?: (line: string) => void;
  readonly append?: (file: string, text: string) => void;
}

/**
 * Reporter do CI. Fora do GitHub Actions as anotações saem como texto legível e outputs/resumo são
 * ignorados, então os mesmos scripts rodam na estação da pessoa desenvolvedora.
 */
export function createReporter(options: ReporterOptions = {}): CiReporter {
  const env = options.env ?? process.env;
  const lines: string[] = [];
  const write =
    options.write ??
    ((line: string) => {
      console.log(line);
    });
  const append =
    options.append ??
    ((file: string, text: string) => {
      appendFileSync(file, text);
    });
  const onActions = env.GITHUB_ACTIONS === 'true';
  const emit = (line: string) => {
    lines.push(line);
    write(line);
  };
  return {
    lines,
    annotate: (level, message, props = {}) => {
      if (onActions) {
        emit(annotation(level, message, props));
        return;
      }
      const where =
        props.file === undefined
          ? ''
          : `${props.file}${props.line === undefined ? '' : `:${props.line}`} — `;
      emit(`${level === 'error' ? '✖' : level === 'warning' ? '⚠' : 'ℹ'} ${where}${message}`);
    },
    log: (level, event, message, data) => {
      emit(formatLine(level, event, message, data));
    },
    setOutput: (name, value) => {
      const file = env.GITHUB_OUTPUT;
      if (file) append(file, outputLine(name, value));
      else emit(`${name}=${value}`);
    },
    summary: (markdown) => {
      const file = env.GITHUB_STEP_SUMMARY;
      if (file) append(file, `${markdown}\n`);
    },
  };
}

/** Link para os logs completos da execução (`ci.stage_failed`). */
export function runUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = env;
  if (!server || !repo || !run) return undefined;
  return `${server}/${repo}/actions/runs/${run}`;
}
