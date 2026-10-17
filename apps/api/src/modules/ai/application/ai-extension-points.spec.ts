import { describe, expect, it } from 'vitest';

import { AiSuggestionSourceRegistry } from '#shared/ai/ai-suggestion-source.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';

import { AiPostProcessorRegistry, AiTenantGateRegistry } from './ai-extension-points.js';
import { AiGeneratorRegistry, DuplicateAiGeneratorError } from './ai-generator.js';
import { TestAiGenerator, TestValueGuard } from '../../../../test/support/ai-fixtures.js';
import { sanitizeContext } from '../domain/context-sanitizer.js';
import { blocksToDoc } from '../domain/output-converter.js';
import { runPostProcessors } from '../domain/post-processing.js';

const REQUEST = {
  userId: 'u1',
  processId: 'p1',
  targetModule: 'DFD',
  kind: 'DRAFT',
  reservedTokens: 15_000,
  stage: 'REQUEST',
} as const;

describe('pontos de extensão da camada de IA (US-115 · "Impacto técnico")', () => {
  it('sem portão do órgão registrado (US-116), falha fechada com AI_DISABLED', async () => {
    const gates = new AiTenantGateRegistry();
    await expect(runSimulatedTransaction((tx) => gates.check(tx, REQUEST))).resolves.toEqual({
      allowed: false,
      code: 'AI_DISABLED',
    });
    gates.register({ check: () => Promise.resolve({ allowed: true }) });
    await expect(runSimulatedTransaction((tx) => gates.check(tx, REQUEST))).resolves.toEqual({
      allowed: true,
    });
  });

  it('um gerador por par targetModule/kind, com o prompt registrado e validado', () => {
    const registry = new AiGeneratorRegistry();
    const generator = new TestAiGenerator();
    registry.register(generator);
    expect(registry.find('DFD', 'DRAFT')).toBe(generator);
    expect(registry.find('DFD', 'SECTION')).toBeUndefined();
    expect(registry.prompts.get('test.draft')).toBe(generator.prompt);
    expect(() => {
      registry.register(new TestAiGenerator());
    }).toThrow(DuplicateAiGeneratorError);
    registry.unregister('DFD', 'DRAFT');
    expect(registry.find('DFD', 'DRAFT')).toBeUndefined();
  });

  it('pós-processadores rodam em ordem e recontam as marcações por seção', () => {
    const registry = new AiPostProcessorRegistry();
    registry.register(new TestValueGuard());
    expect(() => {
      registry.register(new TestValueGuard());
    }).toThrow(/duas vezes/);
    const context = sanitizeContext([], { isBudgetConfidential: false, maxChars: 1_000 });
    const result = runPostProcessors(
      registry.all(),
      {
        sections: [
          {
            sectionKey: 'S',
            title: 'Seção',
            content: blocksToDoc([
              { type: 'paragraph', text: 'Valor de R$ 1.500,00 e [a confirmar]' },
            ]),
            placeholdersCount: 1,
            groundingReplacements: 0,
          },
        ],
        warnings: [],
      },
      context,
    );
    expect(result).toMatchObject({ placeholdersCount: 2, groundingReplacements: 1 });
    registry.clear();
    expect(registry.all()).toEqual([]);
    expect(runPostProcessors([], result.output, context).groundingReplacements).toBe(1);
  });

  it('porta AiSuggestionSource sem implementação: 503 DEPENDENCY_UNAVAILABLE (falha fechada)', async () => {
    const registry = new AiSuggestionSourceRegistry();
    await expect(
      runSimulatedTransaction((tx) =>
        registry.loadForApply(tx, { generationId: 'g', targetModule: 'DFD', documentId: null }),
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503 });
    await expect(
      runSimulatedTransaction((tx) =>
        registry.markApplied(tx, { generationId: 'g', targets: { sectionKeys: [], riskIds: [] } }),
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});
