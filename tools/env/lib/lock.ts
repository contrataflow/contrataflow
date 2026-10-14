// Trava de execução dos scripts `pnpm env:*` (Gherkin "[Concorrência] Subida reentrante"): um
// segundo `pnpm env:up` em paralelo espera o primeiro terminar, em vez de disputar o Compose. A
// idempotência do bootstrap do MinIO e dos blueprints cobre o resto (RN-FND-18).
import { createHash } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface LockOptions {
  readonly timeoutMs: number;
  readonly pollMs?: number;
  /** Chamado uma vez quando a trava está com outro processo. */
  readonly onWait?: (holderPid: number) => void;
  readonly isAlive?: (pid: number) => boolean;
}

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

/** Executa `task` com a trava; espera a liberação e remove travas de processos que já morreram. */
export async function withLock<T>(
  file: string,
  task: () => Promise<T>,
  options: LockOptions,
): Promise<T> {
  const isAlive = options.isAlive ?? processAlive;
  const deadline = Date.now() + options.timeoutMs;
  let notified = false;
  for (;;) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = await holderOf(file);
      if (!Number.isInteger(holder) || !isAlive(holder)) {
        await unlink(file).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Trava ${file} ocupada pelo processo ${holder} além do tempo limite.`);
      }
      if (!notified) {
        options.onWait?.(holder);
        notified = true;
      }
      await sleep(options.pollMs ?? 1000);
    }
  }
  try {
    return await task();
  } finally {
    await unlink(file).catch(() => undefined);
  }
}
