import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { AI_PRICING_TABLE } from '#modules/ai/domain/pricing-table.js';
import {
  DEFAULT_FAKE_AI_FIXTURES_DIR,
  FakeAiProvider,
  loadFakeAiFixtures,
} from '#modules/ai/infrastructure/fake-ai.provider.js';

import { formatEvalReport, runAiEval } from './ai-eval.js';

/*
 * `pnpm ai:eval [--provider fake] [--model <id>] [--out relatorio.json]` (US-115 · tests.md §3.10):
 * fora do CI. Hoje só o `FakeAiProvider` — os adaptadores reais entram com a ADR-013 (PEND-21) e
 * passam a ser escolhidos aqui para a comparação. O relatório JSON (sem o texto gerado) vai para
 * `--out`; o resumo, para o stdout.
 */

const write = (text: string) => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'fake' },
      model: { type: 'string', default: 'fake-draft-1' },
      out: { type: 'string' },
    },
  });
  if (values.provider !== 'fake') {
    process.stderr.write(
      `Provedor "${values.provider}" ainda sem adaptador (ADR-013 · PEND-21). Use --provider fake.\n`,
    );
    return 2;
  }
  const report = await runAiEval({
    provider: new FakeAiProvider(loadFakeAiFixtures(DEFAULT_FAKE_AI_FIXTURES_DIR)),
    model: values.model,
    pricing: AI_PRICING_TABLE,
  });
  write(formatEvalReport(report));
  if (values.out !== undefined) {
    await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    write(`relatório: ${values.out}`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`ai:eval falhou: ${error instanceof Error ? error.message : 'erro'}\n`);
    process.exitCode = 1;
  },
);
