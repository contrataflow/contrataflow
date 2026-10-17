import { describe, expect, it } from 'vitest';

import {
  aiGenerationListQuerySchema,
  aiGenerationOutputSchema,
  aiInputRefSchema,
  requestAiGenerationSchema,
} from './ai.js';
import { AiGenerationCompleted, AiGenerationFailed, AiGenerationRequested } from './events.js';

const DOC = '0192d115-0000-7000-8000-000000000001';
const SUMMARY = 'Aquisição de computadores para as escolas municipais.';

function issuesOf(input: unknown) {
  const result = requestAiGenerationSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code === 'custom' ? (issue.params?.code as string) : issue.code,
      }));
}

describe('AI-01 — pedido de geração (US-115 · V-01..V-04)', () => {
  it('aceita o rascunho com resumo e trata resumo/instrução vazios como ausentes', () => {
    expect(
      requestAiGenerationSchema.parse({ targetModule: 'DFD', kind: 'DRAFT', needSummary: SUMMARY }),
    ).toEqual({ targetModule: 'DFD', kind: 'DRAFT', needSummary: SUMMARY });
    expect(
      requestAiGenerationSchema.parse({
        targetModule: 'ETP',
        kind: 'DRAFT',
        documentId: DOC,
        needSummary: '   ',
        instruction: '',
      }),
    ).toEqual({ targetModule: 'ETP', kind: 'DRAFT', documentId: DOC });
  });

  it('V-02: SECTION exige ação, seção e documento; DRAFT não aceita ação nem seção', () => {
    expect(issuesOf({ targetModule: 'DFD', kind: 'SECTION' })).toEqual([
      { path: 'action', code: 'CONDITIONAL_REQUIRED' },
      { path: 'sectionKey', code: 'CONDITIONAL_REQUIRED' },
      { path: 'documentId', code: 'CONDITIONAL_REQUIRED' },
    ]);
    expect(
      issuesOf({
        targetModule: 'DFD',
        kind: 'DRAFT',
        action: 'REWRITE',
        sectionKey: 'NECESSIDADE',
      }),
    ).toEqual([
      { path: 'action', code: 'NOT_ALLOWED' },
      { path: 'sectionKey', code: 'NOT_ALLOWED' },
    ]);
    expect(
      requestAiGenerationSchema.safeParse({
        targetModule: 'DFD',
        kind: 'SECTION',
        action: 'SUMMARIZE',
        sectionKey: 'NECESSIDADE',
        documentId: DOC,
      }).success,
    ).toBe(true);
  });

  it('V-01/V-03/V-04: alvo inválido, resumo fora de 20..2.000 e instrução acima de 500', () => {
    expect(issuesOf({ targetModule: 'PRICE_RESEARCH', kind: 'DRAFT' })[0]?.path).toBe(
      'targetModule',
    );
    expect(issuesOf({ targetModule: 'DFD', kind: 'DRAFT', needSummary: 'curto' })).toEqual([
      { path: 'needSummary', code: 'TOO_SHORT' },
    ]);
    expect(
      issuesOf({ targetModule: 'DFD', kind: 'DRAFT', needSummary: 'x'.repeat(2_001) })[0],
    ).toEqual({ path: 'needSummary', code: 'too_big' });
    expect(
      issuesOf({ targetModule: 'DFD', kind: 'DRAFT', instruction: 'x'.repeat(501) })[0],
    ).toEqual({ path: 'instruction', code: 'too_big' });
    expect(issuesOf({ targetModule: 'DFD', kind: 'DRAFT', extra: 1 })[0]?.code).toBe(
      'unrecognized_keys',
    );
  });
});

describe('AI-03 — filtros da lista', () => {
  it('converte a lista de status e aplica o limite padrão', () => {
    expect(aiGenerationListQuerySchema.parse({ status: 'QUEUED,RUNNING' })).toEqual({
      limit: 20,
      status: ['QUEUED', 'RUNNING'],
    });
    expect(aiGenerationListQuerySchema.safeParse({ status: 'QUEUED,FOO' }).success).toBe(false);
  });
});

describe('estruturas JSON (entities.md §5.10)', () => {
  it('AiInputRef só aceita ids, versões e hash — nunca conteúdo', () => {
    const ref = { kind: 'USER_SUMMARY', id: null, contentHash: 'a'.repeat(64) };
    expect(aiInputRefSchema.parse(ref)).toEqual(ref);
    expect(aiInputRefSchema.safeParse({ ...ref, text: SUMMARY }).success).toBe(false);
  });

  it('AiGenerationOutput: seções TipTap, avisos de código fechado', () => {
    const output = {
      sections: [
        {
          sectionKey: 'NECESSIDADE',
          title: 'Necessidade',
          content: { type: 'doc', content: [] },
          placeholdersCount: 0,
          groundingReplacements: 0,
        },
      ],
      warnings: [{ code: 'CONTEXT_TRUNCATED' }],
    };
    expect(aiGenerationOutputSchema.parse(output)).toEqual(output);
    expect(
      aiGenerationOutputSchema.safeParse({ ...output, warnings: [{ code: 'OUTRO' }] }).success,
    ).toBe(false);
  });
});

describe('eventos AiGeneration* (events.md §4)', () => {
  const base = {
    generationId: DOC,
    processId: DOC,
    documentId: null,
    targetModule: 'RISK_MAP',
    kind: 'DRAFT',
  } as const;

  it('routing keys e payload sem texto', () => {
    const requested = AiGenerationRequested.of({
      aggregateId: DOC,
      payload: { ...base, action: null, sectionKey: null },
    });
    expect(requested.definition.resolve(requested.payload).routingKey).toBe(
      'ai.generation_requested',
    );
    expect(
      AiGenerationCompleted.payloadSchema.safeParse({
        ...base,
        action: null,
        sectionKey: null,
        requestedById: DOC,
        model: 'fake-draft-1',
        promptKey: 'draft.dfd',
        promptVersion: '1.0.0',
        totalTokens: 10,
        sectionsCount: 1,
        risksCount: 0,
        placeholdersCount: 2,
        output: 'texto',
      }).success,
    ).toBe(false);
    expect(
      AiGenerationFailed.payloadSchema.parse({
        ...base,
        requestedById: DOC,
        errorCode: 'TIMEOUT',
        attempts: 3,
      }).errorCode,
    ).toBe('TIMEOUT');
  });
});
