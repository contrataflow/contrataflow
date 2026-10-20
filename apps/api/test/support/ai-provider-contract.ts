import { describe, expect, it } from 'vitest';

import { AiProviderError } from '#modules/ai/application/ai-provider.port.js';
import type { AiProvider, AiProviderRequest } from '#modules/ai/application/ai-provider.port.js';
import { responseJsonSchema } from '#modules/ai/domain/structured-output.js';

/*
 * Contrato da porta `AiProvider` (US-115 · tests.md §3.10): o mesmo conjunto vale para o
 * `FakeAiProvider` e para o adaptador real da ADR-013 (sobre respostas gravadas). O pipeline só
 * depende do que está aqui: saída JSON (objeto ou texto), uso de tokens, modelo, motivo de fim e
 * as falhas classificadas (`AiProviderError` transitória ou final).
 */

export interface AiProviderContractCase {
  readonly name: string;
  /** Provedor pronto para responder a um pedido válido. */
  readonly make: () => AiProvider;
  /** Provedor que falha com a classe informada no próximo pedido. */
  readonly failing: (kind: AiProviderError['kind']) => AiProvider;
}

export function contractRequest(overrides: Partial<AiProviderRequest> = {}): AiProviderRequest {
  return {
    model: 'modelo-de-contrato',
    system: 'Você é um assistente de redação.',
    messages: [{ role: 'user', content: 'Produza as seções pedidas.' }],
    responseSchema: responseJsonSchema(),
    maxOutputTokens: 1_000,
    temperature: 0.2,
    timeoutMs: 5_000,
    metadata: {
      promptKey: 'contract.draft',
      promptVersion: '1.0.0',
      contextHash: 'c'.repeat(64),
      sectionKeys: ['NECESSIDADE'],
      call: 'initial',
    },
    ...overrides,
  };
}

export function describeAiProviderContract(contract: AiProviderContractCase): void {
  describe(`contrato AiProvider — ${contract.name}`, () => {
    it('responde JSON estruturado com uso de tokens, modelo e motivo de fim', async () => {
      const response = await contract.make().generate(contractRequest());
      const output: unknown =
        typeof response.output === 'string' ? JSON.parse(response.output) : response.output;
      expect(output).toMatchObject({ sections: expect.any(Array) as unknown });
      expect(response.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(response.usage.outputTokens).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(response.usage.inputTokens)).toBe(true);
      expect(response.model.length).toBeGreaterThan(0);
      expect(['stop', 'length', 'content_filter', 'other']).toContain(response.finishReason);
    });

    it.each(['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'] as const)(
      '%s é falha transitória (o job tenta de novo)',
      async (kind) => {
        await expect(contract.failing(kind).generate(contractRequest())).rejects.toMatchObject({
          kind,
          transient: true,
        });
      },
    );

    it.each(['CONTENT_FILTERED', 'CONTEXT_TOO_LARGE'] as const)(
      '%s é falha final (a geração vira FAILED)',
      async (kind) => {
        const failure = contract.failing(kind).generate(contractRequest());
        await expect(failure).rejects.toBeInstanceOf(AiProviderError);
        await expect(failure).rejects.toMatchObject({ kind, transient: false });
      },
    );
  });
}
