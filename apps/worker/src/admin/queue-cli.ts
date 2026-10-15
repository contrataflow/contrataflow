import { parseArgs } from 'node:util';

import { QueueOperationError } from './queue-operations.js';
import type { QueueOperations } from './queue-operations.js';

/*
 * Comandos da CLI de operação (FA-04 · queues.md §5.6/§11.2). A saída é JSON (uma linha), para
 * colar no ticket; erros vão para stderr com código de saída ≠ 0.
 */

export const CLI_USAGE = [
  'Uso: node dist/cli.js <comando> [opções]   (CF_OPS_TOKEN = access token do operador)',
  '  dlq:list [--queue <fila>] [--tenant <id>] [--since <1h|30m|2d|ISO>] [--limit <n>]',
  '  dlq:show <id>',
  '  dlq:retry <id> --ticket <ref> --reason <texto>',
  '  dlq:retry --queue <fila> --since <ts> --ticket <ref> --reason <texto> [--dry-run]',
  '  dlq:discard <id> --ticket <ref> --reason <texto>',
  '  outbox:republish --id <eventId> --ticket <ref> --reason <texto>',
].join('\n');

export interface CliOutput {
  out(text: string): void;
  err(text: string): void;
}

const OPTIONS = {
  queue: { type: 'string' },
  tenant: { type: 'string' },
  limit: { type: 'string' },
  ticket: { type: 'string' },
  reason: { type: 'string' },
  id: { type: 'string' },
  since: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;

/** `--since`: relativo (`30m`, `1h`, `2d`) ou instante ISO 8601. */
export function parseSince(value: string, now: Date = new Date()): Date {
  const relative = /^(\d+)([mhd])$/.exec(value);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 'm' | 'h' | 'd'];
    return new Date(now.getTime() - Number(relative[1]) * unit);
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new QueueOperationError('INVALID_ARGUMENT', `--since inválido: ${value}`);
  }
  return at;
}

/** Executa um comando; devolve o código de saída. */
export async function runQueueCli(
  argv: readonly string[],
  operations: QueueOperations,
  output: CliOutput,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    output.err(`${error instanceof Error ? error.message : String(error)}\n${CLI_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, target] = positionals;
  const justification = { ticket: values.ticket ?? '', reason: values.reason ?? '' };
  const print = (value: unknown) => {
    output.out(JSON.stringify(value));
  };
  try {
    switch (command) {
      case 'dlq:list':
        print(
          await operations.listDeadLetters({
            ...(values.queue ? { queue: values.queue } : {}),
            ...(values.tenant ? { tenantId: values.tenant } : {}),
            ...(values.since ? { since: parseSince(values.since) } : {}),
            ...(values.limit ? { limit: Number(values.limit) } : {}),
          }),
        );
        return 0;
      case 'dlq:show':
        if (!target) break;
        print(await operations.showDeadLetter(target));
        return 0;
      case 'dlq:retry':
        if (target) {
          print({ retriedJobId: await operations.retryDeadLetter(target, justification) });
          return 0;
        }
        if (!values.queue || !values.since) break;
        print(
          await operations.retryDeadLetters(
            {
              queue: values.queue,
              since: parseSince(values.since),
              ...(values.tenant ? { tenantId: values.tenant } : {}),
            },
            justification,
            values['dry-run'] === true,
          ),
        );
        return 0;
      case 'dlq:discard':
        if (!target) break;
        await operations.discardDeadLetter(target, justification);
        print({ discarded: target });
        return 0;
      case 'outbox:republish':
        if (!values.id) break;
        await operations.republishOutboxEvent(values.id, justification);
        print({ republished: values.id });
        return 0;
      default:
        break;
    }
  } catch (error) {
    if (error instanceof QueueOperationError) {
      output.err(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
  output.err(CLI_USAGE);
  return 2;
}
