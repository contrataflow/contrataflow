// US-079 — `run()` de tools/lib/process: a saída de um comando pode passar de 1 MiB (o `git diff`
// do lote no gate de cobertura) sem o processo ser morto por ENOBUFS.
import { describe, expect, it } from 'vitest';

import { run } from '../lib/process.js';

describe('run() (US-079 · saída grande)', () => {
  it('devolve um stdout maior que o maxBuffer padrão do Node (1 MiB)', () => {
    const size = 2 * 1024 * 1024;
    const result = run(process.execPath, ['-e', `process.stdout.write('x'.repeat(${size}))`], {
      cwd: process.cwd(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(size);
  });
});
