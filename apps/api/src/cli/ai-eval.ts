import type { AiProvider, AiTokenUsage } from '#modules/ai/application/ai-provider.port.js';
import { AiProviderError } from '#modules/ai/application/ai-provider.port.js';
import { costOf } from '#modules/ai/domain/ai-pricing.js';
import type { PricingTable } from '#modules/ai/domain/ai-pricing.js';
import { sanitizeContext } from '#modules/ai/domain/context-sanitizer.js';
import type { ContextPart } from '#modules/ai/domain/context-sanitizer.js';
import { convertStructuredOutput } from '#modules/ai/domain/output-converter.js';
import type { SectionSpec } from '#modules/ai/domain/output-converter.js';
import { runPostProcessors } from '#modules/ai/domain/post-processing.js';
import type { AiOutputPostProcessor } from '#modules/ai/domain/post-processing.js';
import { renderPrompt, repairInstruction } from '#modules/ai/domain/prompts.js';
import type { PromptTemplate } from '#modules/ai/domain/prompts.js';
import { responseJsonSchema } from '#modules/ai/domain/structured-output.js';

/*
 * Harness de avaliação `pnpm ai:eval` (US-115 · tests.md §3.10 · ADR-013): roda processos
 * sintéticos pelo MESMO pipeline do job (sanitização → prompt versionado → provedor → validação com
 * 1 reparo → conversão → pós-processamento) e mede, por provedor e versão de prompt: validade do
 * schema na 1ª resposta, `OUTPUT_INVALID` após o reparo, `[a confirmar]`, trocas do
 * GroundingGuard, tokens, custo e latência. Fora do CI: a qualidade do texto é julgada por
 * especialista; o harness dá os números para comparar provedores e versões.
 */

export interface SyntheticProcess {
  readonly id: string;
  readonly label: string;
  readonly isBudgetConfidential: boolean;
  readonly needSummary: string;
  readonly parts: readonly ContextPart[];
  /** Ganchos do gerador do documento (ex.: guarda das decisões do ETP — US-118). */
  readonly postProcessors?: readonly AiOutputPostProcessor[];
}

export interface EvalCaseResult {
  readonly processId: string;
  readonly validOnFirstTry: boolean;
  readonly outputInvalid: boolean;
  readonly errorCode: string | null;
  readonly placeholders: number;
  readonly groundingReplacements: number;
  readonly usage: AiTokenUsage;
  readonly costUsd: string | null;
  readonly latencyMs: number;
}

export interface EvalReport {
  readonly provider: string;
  readonly model: string;
  readonly promptKey: string;
  readonly promptVersion: string;
  readonly cases: readonly EvalCaseResult[];
  readonly summary: {
    readonly total: number;
    readonly validOnFirstTry: number;
    readonly outputInvalid: number;
    readonly failures: number;
    readonly placeholders: number;
    readonly groundingReplacements: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: string | null;
    readonly p95LatencyMs: number;
  };
}

/** Seções do DFD avaliadas (mesmas chaves do template padrão — US-117 traz o gerador real). */
export const EVAL_SECTIONS: readonly SectionSpec[] = [
  { sectionKey: 'NECESSIDADE', title: 'Descrição da necessidade', maxChars: 5_000 },
  {
    sectionKey: 'JUSTIFICATIVA',
    title: 'Justificativa da necessidade',
    maxChars: 5_000,
    legalBasis: 'Lei 14.133/2021, art. 18, §1º, I',
  },
  { sectionKey: 'QUANTIDADES', title: 'Estimativa das quantidades', maxChars: 3_000 },
  { sectionKey: 'PREVISAO_DATA', title: 'Previsão de data', maxChars: 1_000 },
];

export const EVAL_PROMPT: PromptTemplate = {
  key: 'eval.draft_dfd',
  version: '1.0.0',
  instructions:
    'Redija o Documento de Formalização da Demanda (DFD) com as seções pedidas, a partir do resumo e dos dados do processo.',
};

const OBJECTS = [
  ['Notebooks para os laboratórios das escolas', 'Secretaria de Educação', 30],
  ['Merenda escolar do segundo semestre', 'Secretaria de Educação', 12_000],
  ['Manutenção preventiva de ar-condicionado', 'Secretaria de Administração', 85],
  ['Medicamentos da farmácia básica', 'Secretaria de Saúde', 4_500],
  ['Pavimentação da Rua das Flores', 'Secretaria de Obras', 1],
  ['Uniformes da Guarda Municipal', 'Secretaria de Segurança', 240],
  ['Licenças de software de escritório', 'Secretaria de Administração', 150],
  ['Transporte escolar rural', 'Secretaria de Educação', 18],
  ['Material de limpeza das unidades de saúde', 'Secretaria de Saúde', 900],
  ['Locação de impressoras multifuncionais', 'Secretaria de Fazenda', 25],
] as const;

/** Os 10 processos sintéticos (com casos de dado pessoal e de orçamento sigiloso). */
export function syntheticProcesses(): SyntheticProcess[] {
  return OBJECTS.map(([object, unit, quantity], index) => ({
    id: `sintetico-${String(index + 1).padStart(2, '0')}`,
    label: object,
    isBudgetConfidential: index % 4 === 3,
    needSummary:
      index % 3 === 0
        ? `${object}. Responsável: maria.silva@prefeitura.gov.br, CPF 123.456.789-09.`
        : `${object} para atender à demanda da ${unit}.`,
    parts: [
      {
        ref: { kind: 'PROCESS', id: `p-${String(index + 1)}` },
        label: 'Processo',
        data: { objeto: object, unidadeRequisitante: unit, estimatedValue: (index + 1) * 10_000 },
      },
      {
        ref: { kind: 'PROCESS_ITEMS', id: null },
        label: 'Itens',
        data: [{ descricao: object, quantidade: quantity, unidade: 'UN' }],
      },
    ],
  }));
}

export interface EvalOptions {
  readonly provider: AiProvider;
  readonly model: string;
  readonly pricing: PricingTable;
  readonly prompt?: PromptTemplate;
  /** Seções pedidas (padrão: as do DFD de avaliação). */
  readonly sections?: readonly SectionSpec[];
  readonly postProcessors?: readonly AiOutputPostProcessor[];
  readonly processes?: readonly SyntheticProcess[];
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

function sum(a: AiTokenUsage, b: AiTokenUsage): AiTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function evaluate(process: SyntheticProcess, options: EvalOptions): Promise<EvalCaseResult> {
  const now = options.now ?? (() => performance.now());
  const prompt = options.prompt ?? EVAL_PROMPT;
  const sections = options.sections ?? EVAL_SECTIONS;
  const context = sanitizeContext(
    [
      {
        ref: { kind: 'USER_SUMMARY', id: null },
        label: 'Resumo da necessidade',
        data: process.needSummary,
      },
      ...process.parts,
    ],
    { isBudgetConfidential: process.isBudgetConfidential, maxChars: 240_000 },
  );
  const rendered = renderPrompt(prompt, { sections, context, action: null });
  const base = {
    model: options.model,
    system: rendered.system,
    responseSchema: responseJsonSchema(),
    maxOutputTokens: 4_000,
    temperature: 0.2,
    timeoutMs: options.timeoutMs ?? 120_000,
    metadata: {
      promptKey: prompt.key,
      promptVersion: prompt.version,
      contextHash: context.contextHash,
      sectionKeys: sections.map((section) => section.sectionKey),
    },
  };
  const startedAt = now();
  let usage: AiTokenUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    const first = await options.provider.generate({
      ...base,
      messages: [{ role: 'user', content: rendered.user }],
      metadata: { ...base.metadata, call: 'initial' },
    });
    usage = first.usage;
    let conversion = convertStructuredOutput(first.output, {
      sections,
      warnings: context.warnings,
    });
    const validOnFirstTry = conversion.ok;
    if (!conversion.ok) {
      const repair = await options.provider.generate({
        ...base,
        messages: [
          { role: 'user', content: rendered.user },
          {
            role: 'assistant',
            content: typeof first.output === 'string' ? first.output : JSON.stringify(first.output),
          },
          { role: 'user', content: repairInstruction(conversion.issues) },
        ],
        metadata: { ...base.metadata, call: 'repair' },
      });
      usage = sum(usage, repair.usage);
      conversion = convertStructuredOutput(repair.output, {
        sections,
        warnings: context.warnings,
      });
    }
    const processed = conversion.ok
      ? runPostProcessors(
          [...(process.postProcessors ?? []), ...(options.postProcessors ?? [])],
          conversion.output,
          context,
        )
      : null;
    return {
      processId: process.id,
      validOnFirstTry,
      outputInvalid: !conversion.ok,
      errorCode: conversion.ok ? null : 'OUTPUT_INVALID',
      placeholders: processed?.placeholdersCount ?? 0,
      groundingReplacements: processed?.groundingReplacements ?? 0,
      usage,
      costUsd: costOf(options.pricing, options.model, usage).costUsd,
      latencyMs: Math.round(now() - startedAt),
    };
  } catch (error) {
    const failure = error instanceof AiProviderError ? error : new AiProviderError('UNAVAILABLE');
    return {
      processId: process.id,
      validOnFirstTry: false,
      outputInvalid: false,
      errorCode: failure.kind,
      placeholders: 0,
      groundingReplacements: 0,
      usage: sum(usage, failure.usage),
      costUsd: costOf(options.pricing, options.model, sum(usage, failure.usage)).costUsd,
      latencyMs: Math.round(now() - startedAt),
    };
  }
}

/** Avalia os processos sintéticos em sequência (sem paralelismo: latência comparável). */
export async function runAiEval(options: EvalOptions): Promise<EvalReport> {
  const cases: EvalCaseResult[] = [];
  for (const process of options.processes ?? syntheticProcesses()) {
    cases.push(await evaluate(process, options));
  }
  const total = (pick: (item: EvalCaseResult) => number) =>
    cases.reduce((acc, item) => acc + pick(item), 0);
  const costs = cases.map((item) => item.costUsd);
  const costUsd = costs.some((cost) => cost === null)
    ? null
    : (costOf(options.pricing, options.model, {
        inputTokens: total((item) => item.usage.inputTokens),
        outputTokens: total((item) => item.usage.outputTokens),
      }).costUsd ?? null);
  const prompt = options.prompt ?? EVAL_PROMPT;
  return {
    provider: options.provider.name,
    model: options.model,
    promptKey: prompt.key,
    promptVersion: prompt.version,
    cases,
    summary: {
      total: cases.length,
      validOnFirstTry: cases.filter((item) => item.validOnFirstTry).length,
      outputInvalid: cases.filter((item) => item.outputInvalid).length,
      failures: cases.filter((item) => item.errorCode !== null && !item.outputInvalid).length,
      placeholders: total((item) => item.placeholders),
      groundingReplacements: total((item) => item.groundingReplacements),
      inputTokens: total((item) => item.usage.inputTokens),
      outputTokens: total((item) => item.usage.outputTokens),
      costUsd,
      p95LatencyMs: percentile95(cases.map((item) => item.latencyMs)),
    },
  };
}

/** Tabela legível do relatório (stdout da CLI). */
export function formatEvalReport(report: EvalReport): string {
  const { summary } = report;
  return [
    `ai:eval — provedor ${report.provider} · modelo ${report.model} · prompt ${report.promptKey}@${report.promptVersion}`,
    `processos: ${String(summary.total)} · schema válido na 1ª: ${String(summary.validOnFirstTry)} · OUTPUT_INVALID: ${String(summary.outputInvalid)} · falhas do provedor: ${String(summary.failures)}`,
    `[a confirmar]: ${String(summary.placeholders)} · trocas do GroundingGuard: ${String(summary.groundingReplacements)}`,
    `tokens: ${String(summary.inputTokens)} entrada / ${String(summary.outputTokens)} saída · custo: ${summary.costUsd ?? 'sem preço na tabela'} USD · latência p95: ${String(summary.p95LatencyMs)} ms`,
  ].join('\n');
}
