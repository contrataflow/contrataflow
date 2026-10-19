import { describe, expect, it } from 'vitest';

import { FakeAiProvider } from '#modules/ai/infrastructure/fake-ai.provider.js';

import { etpEvalSuite } from './ai-eval-etp.js';
import { EVAL_SECTIONS, formatEvalReport, runAiEval, syntheticProcesses } from './ai-eval.js';

const PRICING = {
  version: 'teste.1',
  models: { 'modelo-eval': { inputPerMillionUsd: '3', outputPerMillionUsd: '15' } },
};

describe('pnpm ai:eval (US-115 · tests.md §3.10)', () => {
  it('10 processos sintéticos, com dado pessoal e orçamento sigiloso entre eles', () => {
    const processes = syntheticProcesses();
    expect(processes).toHaveLength(10);
    expect(processes.some((process) => process.isBudgetConfidential)).toBe(true);
    expect(processes.some((process) => process.needSummary.includes('CPF'))).toBe(true);
  });

  it('mede validade, reparo, [a confirmar], tokens, custo e latência — e o texto não sai sanitizado de menos', async () => {
    let tick = 0;
    const provider = new FakeAiProvider();
    // 1º processo: inválido e reparado; 2º: inválido duas vezes; 3º: falha do provedor.
    provider.enqueue(
      { kind: 'output', output: { secoes: [] }, usage: { inputTokens: 10, outputTokens: 1 } },
      {
        kind: 'output',
        output: {
          sections: EVAL_SECTIONS.map((section) => ({
            sectionKey: section.sectionKey,
            blocks: [{ type: 'paragraph', text: '[a confirmar: quantidade]' }],
          })),
        },
        usage: { inputTokens: 20, outputTokens: 5 },
      },
      { kind: 'output', output: 'x' },
      { kind: 'output', output: 'y' },
      { kind: 'error', error: 'RATE_LIMITED' },
    );
    const report = await runAiEval({
      provider,
      model: 'modelo-eval',
      pricing: PRICING,
      now: () => (tick += 10),
    });
    expect(report.summary).toMatchObject({
      total: 10,
      outputInvalid: 1,
      failures: 1,
      validOnFirstTry: 7,
    });
    expect(report.cases[0]).toMatchObject({
      validOnFirstTry: false,
      outputInvalid: false,
      placeholders: 4,
      usage: { inputTokens: 30, outputTokens: 6 },
    });
    expect(report.cases[2]?.errorCode).toBe('RATE_LIMITED');
    expect(report.summary.costUsd).toMatch(/^\d+\.\d{6}$/);
    expect(report.summary.p95LatencyMs).toBeGreaterThan(0);
    const sent = provider.calls
      .flatMap((call) => call.messages.map((message) => message.content))
      .join('\n');
    expect(sent).not.toContain('123.456.789-09');
    expect(sent).not.toContain('maria.silva@prefeitura.gov.br');
    expect(formatEvalReport(report)).toContain('OUTPUT_INVALID: 1');
  });

  it('modelo sem preço: custo nulo no relatório', async () => {
    const report = await runAiEval({
      provider: new FakeAiProvider(),
      model: 'sem-preco',
      pricing: PRICING,
      processes: syntheticProcesses().slice(0, 1),
    });
    expect(report.summary.costUsd).toBeNull();
    expect(formatEvalReport(report)).toContain('sem preço na tabela');
  });
  it('suíte draft.etp (US-118): DFD em rascunho, sem pesquisa e sigilo, com a guarda das decisões', async () => {
    const suite = etpEvalSuite();
    expect(suite.prompt.key).toBe('draft.etp');
    expect(suite.processes.map((process) => process.label)).toEqual([
      'DFD aprovado e pesquisa concluída',
      'DFD só em rascunho',
      'Sem pesquisa de preços concluída',
      'Orçamento sigiloso',
    ]);
    expect(JSON.stringify(suite.processes[3]?.parts)).not.toContain('125.000');
    const report = await runAiEval({
      provider: new FakeAiProvider(),
      model: 'modelo-eval',
      pricing: PRICING,
      ...suite,
    });
    expect(report.promptKey).toBe('draft.etp');
    expect(report.summary).toMatchObject({ total: 4, outputInvalid: 0, failures: 0 });
    // A resposta genérica não decide nada: a guarda acrescenta conclusão, solução e parcelamento.
    expect(report.summary.placeholders).toBeGreaterThanOrEqual(4 * 3);
  });
});
