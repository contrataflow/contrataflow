import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { AI_PRICING_TABLE } from '#modules/ai/domain/pricing-table.js';
import {
  DEFAULT_FAKE_AI_FIXTURES_DIR,
  FakeAiProvider,
  loadFakeAiFixtures,
} from '#modules/ai/infrastructure/fake-ai.provider.js';

import { etpEvalSuite } from './ai-eval-etp.js';
import { termEvalSuite } from './ai-eval-tr.js';
import { formatEvalReport, runAiEval } from './ai-eval.js';

/*
 * `pnpm ai:eval [--provider fake] [--model <id>] [--suite dfd|etp|tr] [--out relatorio.json]`
 * (US-115 · tests.md §3.10): fora do CI. `--suite etp` (US-118) avalia o prompt `draft.etp`;
 * `--suite tr` (US-120), o `draft.tr`. Hoje só o
 * `FakeAiProvider` — os adaptadores reais entram com a ADR-013 (PEND-21) e passam a ser escolhidos
 * aqui para a comparação. O relatório JSON (sem o texto gerado) vai para
 * `--out`; o resumo, para o stdout.
 */

const write = (text: string) => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'fake' },
      model: { type: 'string', default: 'fake-draft-1' },
      suite: { type: 'string', default: 'dfd' },
      out: { type: 'string' },
    },
  });
  if (values.provider !== 'fake') {
    process.stderr.write(
      `Provedor "${values.provider}" ainda sem adaptador (ADR-013 · PEND-21). Use --provider fake.\n`,
    );
    return 2;
  }
  if (values.suite !== 'dfd' && values.suite !== 'etp' && values.suite !== 'tr') {
    process.stderr.write(`Suíte "${values.suite}" desconhecida. Use --suite dfd, etp ou tr.\n`);
    return 2;
  }
  const report = await runAiEval({
    provider: new FakeAiProvider(loadFakeAiFixtures(DEFAULT_FAKE_AI_FIXTURES_DIR)),
    model: values.model,
    pricing: AI_PRICING_TABLE,
    ...(values.suite === 'etp' ? etpEvalSuite() : values.suite === 'tr' ? termEvalSuite() : {}),
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
