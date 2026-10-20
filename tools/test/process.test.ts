// US-079 — `run()` de tools/lib/process: a saída de um comando pode passar de 1 MiB (o `git diff`
// do lote no gate de cobertura) sem o processo ser morto por ENOBUFS; no Windows, comandos do PATH
// passam pelo shell com os argumentos entre aspas (`quoteWindowsArg`).
import { describe, expect, it } from 'vitest';

import { quoteWindowsArg, run } from '../lib/process.js';

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

describe('quoteWindowsArg (regras do CommandLineToArgvW)', () => {
  it('só põe aspas quando precisa; dobra as barras antes de aspas e antes da aspa final', () => {
    expect(quoteWindowsArg('--filter=@contrataflow/api')).toBe('--filter=@contrataflow/api');
    expect(quoteWindowsArg('C:\\a b\\c')).toBe('"C:\\a b\\c"');
    expect(quoteWindowsArg('C:\\dir com espaço\\')).toBe('"C:\\dir com espaço\\\\"');
    expect(quoteWindowsArg('diz "oi"')).toBe('"diz \\"oi\\""');
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('o processo filho recebe os argumentos intactos (no Windows, pelo shell)', () => {
    const args = ['C:\\dir com espaço\\', 'diz "oi"', 'a\\"b', 'simples'];
    const result = run(
      'node',
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args],
      { cwd: process.cwd() },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });
});
