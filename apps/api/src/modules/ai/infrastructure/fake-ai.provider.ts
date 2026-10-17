import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { sha256Hex } from '#shared/integrity/canonical-json.js';

import { AiProviderError } from '../application/ai-provider.port.js';
import type {
  AiProvider,
  AiProviderErrorKind,
  AiProviderRequest,
  AiProviderResponse,
  AiTokenUsage,
} from '../application/ai-provider.port.js';

/*
 * `FakeAiProvider` (tests.md §3.10 · RN-AI-14): o provedor de dev, testes e CI — nenhuma chamada
 * real. Determinístico: a resposta vem da fixture de `apps/api/test/fixtures/ai/<promptKey>/`
 * escolhida pelo `contextHash` (sem correspondência, a fixture padrão da `promptKey`; sem ela, uma
 * resposta genérica com marcações [a confirmar] para cada seção pedida). Roteirizável para os
 * cenários de falha: `enqueue` de saídas, erros (429, 5xx, timeout, filtro), espera indefinida
 * (estoura o timeout) e espera controlada pelo teste (cancelamento durante a execução).
 */

export type FakeAiStep =
  | {
      readonly kind: 'output';
      readonly output: unknown;
      readonly usage?: AiTokenUsage;
      readonly finishReason?: AiProviderResponse['finishReason'];
    }
  | { readonly kind: 'error'; readonly error: AiProviderErrorKind; readonly usage?: AiTokenUsage }
  /** Nunca responde: só termina pelo cancelamento (timeout do pipeline). */
  | { readonly kind: 'hang' }
  /** Responde o passo `then` depois que `until` resolver (controle fino nos testes). */
  | { readonly kind: 'wait'; readonly until: Promise<void>; readonly then: FakeAiStep };

export interface FakeAiFixture {
  readonly promptKey: string;
  /** Ausente = padrão da `promptKey`. */
  readonly contextHash?: string;
  readonly output: unknown;
}

const fixtureFileSchema = z.object({
  contextHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  output: z.unknown(),
});

/** Fixtures de um diretório: `<dir>/<promptKey>/*.json` com `{ contextHash?, output }`. */
export function loadFakeAiFixtures(dir: string): FakeAiFixture[] {
  if (!existsSync(dir)) return [];
  const fixtures: FakeAiFixture[] = [];
  for (const promptKey of readdirSync(dir).sort()) {
    const folder = join(dir, promptKey);
    if (!statSync(folder).isDirectory()) continue;
    for (const file of readdirSync(folder).sort()) {
      if (!file.endsWith('.json')) continue;
      const parsed = fixtureFileSchema.parse(JSON.parse(readFileSync(join(folder, file), 'utf8')));
      fixtures.push({
        promptKey,
        output: parsed.output,
        ...(parsed.contextHash === undefined ? {} : { contextHash: parsed.contextHash }),
      });
    }
  }
  return fixtures;
}

/** Diretório padrão das fixtures (mesmo caminho a partir de `src/` e de `dist/`). */
export const DEFAULT_FAKE_AI_FIXTURES_DIR = fileURLToPath(
  new URL('../../../../test/fixtures/ai/', import.meta.url),
);

const GENERIC_TEXT =
  'Texto proposto pelo provedor de IA de teste. [a confirmar: conteúdo da seção]';

function tokensOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake' as const;
  /** Pedidos recebidos (inspeção nos testes: nada de dado pessoal no texto enviado). */
  readonly calls: AiProviderRequest[] = [];
  private readonly script: FakeAiStep[] = [];

  constructor(private readonly fixtures: readonly FakeAiFixture[] = []) {}

  /** Próximas respostas, em ordem; esgotado o roteiro, volta às fixtures. */
  enqueue(...steps: readonly FakeAiStep[]): this {
    this.script.push(...steps);
    return this;
  }

  reset(): void {
    this.script.length = 0;
    this.calls.length = 0;
  }

  async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    this.calls.push(request);
    const step = this.script.shift() ?? { kind: 'output', output: this.fixtureOutput(request) };
    return this.run(step, request);
  }

  private async run(step: FakeAiStep, request: AiProviderRequest): Promise<AiProviderResponse> {
    switch (step.kind) {
      case 'output':
        return this.respond(request, step.output, step.usage, step.finishReason);
      case 'error':
        throw new AiProviderError(
          step.error,
          step.usage === undefined ? {} : { usage: step.usage },
        );
      case 'hang':
        return new Promise<never>((_, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new AiProviderError('TIMEOUT'));
          });
        });
      case 'wait':
        await step.until;
        return this.run(step.then, request);
    }
  }

  private respond(
    request: AiProviderRequest,
    output: unknown,
    usage: AiTokenUsage | undefined,
    finishReason: AiProviderResponse['finishReason'] = 'stop',
  ): AiProviderResponse {
    const prompt = [request.system, ...request.messages.map((message) => message.content)].join(
      '\n',
    );
    const serialized = typeof output === 'string' ? output : JSON.stringify(output ?? null);
    return {
      output,
      usage: usage ?? { inputTokens: tokensOf(prompt), outputTokens: tokensOf(serialized) },
      model: request.model,
      finishReason,
      providerRequestId: `fake-${sha256Hex(
        `${request.metadata.promptKey}|${request.metadata.contextHash}|${request.metadata.call}|${String(this.calls.length)}`,
      ).slice(0, 16)}`,
    };
  }

  private fixtureOutput(request: AiProviderRequest): unknown {
    const { promptKey, contextHash, sectionKeys } = request.metadata;
    const exact = this.fixtures.find(
      (fixture) => fixture.promptKey === promptKey && fixture.contextHash === contextHash,
    );
    const fallback = this.fixtures.find(
      (fixture) => fixture.promptKey === promptKey && fixture.contextHash === undefined,
    );
    const fixture = exact ?? fallback;
    if (fixture !== undefined) return fixture.output;
    return {
      sections: sectionKeys.map((sectionKey) => ({
        sectionKey,
        blocks: [{ type: 'paragraph', text: GENERIC_TEXT }],
      })),
    };
  }
}
