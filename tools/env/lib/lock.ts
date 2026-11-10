// Trava de execução dos scripts `pnpm env:*` (Gherkin "[Concorrência] Subida reentrante"): um
// segundo `pnpm env:up` em paralelo espera o primeiro terminar, em vez de disputar o Compose. A
// idempotência do bootstrap do MinIO e dos blueprints cobre o resto (RN-FND-18).
import { createHash, randomBytes } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface LockOptions {
  readonly timeoutMs: number;
  readonly pollMs?: number;
  /** Chamado uma vez quando a trava está com outro processo. */
  readonly onWait?: (holderPid: number) => void;
  readonly isAlive?: (pid: number) => boolean;
}

/** Quanto tempo um arquivo de trava vazio/ilegível é tratado como ocupado antes de virar lixo. */
const UNREADABLE_GRACE_MS = 1000;

/** Arquivo de trava por checkout (fora do repositório). */
export function lockFileFor(root: string, name: string): string {
  const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `contrataflow-${name}-${id}.lock`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function holderOf(file: string): Promise<number> {
  try {
    return Number.parseInt(await readFile(file, 'utf8'), 10);
  } catch {
    return Number.NaN;
  }
}

/**
 * Cria a trava já com o PID dentro: o PID vai para um arquivo temporário exclusivo (`wx`, 0o600) e
 * é publicado no caminho da trava por `link`, que falha com EEXIST se ela já existir. Assim o
 * arquivo da trava nunca aparece vazio para um concorrente.
 */
async function acquire(file: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(String(process.pid));
  } finally {
    await handle.close();
  }
  try {
    await link(temp, file);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** Executa `task` com a trava; espera a liberação e remove travas de processos que já morreram. */
export async function withLock<T>(
  file: string,
  task: () => Promise<T>,
  options: LockOptions,
): Promise<T> {
  const isAlive = options.isAlive ?? processAlive;
  const deadline = Date.now() + options.timeoutMs;
  let notified = false;
  let unreadableSince: number | undefined;
  for (;;) {
    try {
      await acquire(file);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await holderOf(file);
    if (Number.isInteger(holder)) {
      unreadableSince = undefined;
      if (!isAlive(holder)) {
        await unlink(file).catch(() => undefined);
        continue;
      }
    } else {
      // Vazio/ilegível não prova dono morto (pode ser um arquivo recém-criado por outra versão):
      // trata como ocupado e só descarta depois da carência.
      unreadableSince ??= Date.now();
      if (Date.now() - unreadableSince >= UNREADABLE_GRACE_MS) {
        await unlink(file).catch(() => undefined);
        unreadableSince = undefined;
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        Number.isInteger(holder)
          ? `Trava ${file} ocupada pelo processo ${holder} além do tempo limite.`
          : `Trava ${file} ocupada além do tempo limite.`,
      );
    }
    if (!notified && Number.isInteger(holder)) {
      options.onWait?.(holder);
      notified = true;
    }
    await sleep(options.pollMs ?? 1000);
  }
  try {
    return await task();
  } finally {
    await unlink(file).catch(() => undefined);
  }
}
