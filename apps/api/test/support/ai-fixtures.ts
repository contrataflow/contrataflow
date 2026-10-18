import type { AiGenerationKind, AiTargetModule } from '@contrataflow/types';
import type { AiGenerationOutput } from '@contrataflow/validation';

import { DEFAULT_ROLES } from '#modules/access/domain/default-roles.js';
import {
  AiPostProcessorRegistry,
  AiTenantGateRegistry,
} from '#modules/ai/application/ai-extension-points.js';
import type {
  AiGateDecision,
  AiGateRequest,
  AiTenantGate,
} from '#modules/ai/application/ai-extension-points.js';
import { AiGenerationJob } from '#modules/ai/application/ai-generation.job.js';
import { AiGeneratorRegistry, AiPolicyRevokedError } from '#modules/ai/application/ai-generator.js';
import type {
  AiGenerator,
  AiGeneratorCheck,
  AiGeneratorContext,
  AiGeneratorRequest,
} from '#modules/ai/application/ai-generator.js';
import { AI_GENERATION_REPOSITORY } from '#modules/ai/application/ports.js';
import type { AiGeneration } from '#modules/ai/domain/ai-generation.js';
import type { ContextPart } from '#modules/ai/domain/context-sanitizer.js';
import { toConfirmNode } from '#modules/ai/domain/output-converter.js';
import type {
  AiOutputPostProcessor,
  PostProcessingInput,
} from '#modules/ai/domain/post-processing.js';
import type { InMemoryAiGenerationRepository } from '#modules/ai/infrastructure/in-memory-ai-generation.repository.js';
import { InMemoryDfdRepository } from '#modules/dfd/infrastructure/dfd.repositories.js';
import type { InMemoryJobQueue } from '#modules/platform/infrastructure/queues/in-memory-job-queue.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';

import type { TestApi } from './api-test-app.js';

/*
 * Apoio dos testes da camada de IA (US-115): gerador, portão do órgão e pós-processador de teste
 * (os reais chegam com US-116/117/122), e a execução do job `ai-generation` como o worker faria.
 */

export const TEST_SECTIONS = [
  { sectionKey: 'NECESSIDADE', title: 'Descrição da necessidade', maxChars: 5_000 },
  {
    sectionKey: 'JUSTIFICATIVA',
    title: 'Justificativa',
    maxChars: 5_000,
    legalBasis: 'Lei 14.133/2021, art. 18, §1º, I',
  },
] as const;

/** Saída válida para as duas seções do gerador de teste. */
export function validOutput(text = 'Aquisição de equipamentos para as escolas.'): unknown {
  return {
    sections: TEST_SECTIONS.map((section) => ({
      sectionKey: section.sectionKey,
      blocks: [{ type: 'paragraph', text: `${text} **Prioridade** [a confirmar: quantidade]` }],
    })),
  };
}

/**
 * Gerador de teste para o par configurado (padrão: rascunho do DFD). `parts` monta o contexto; os
 * campos mutáveis simulam pré-requisito perdido e processo sigiloso.
 */
export class TestAiGenerator implements AiGenerator {
  readonly prompt = {
    key: 'test.draft',
    version: '1.0.0',
    instructions: 'Gere o rascunho de teste com as seções pedidas.',
  };
  readonly reservedTokens: number = 15_000;
  readonly needSummary = 'REQUIRED' as const;
  readonly maxOutputTokens = 4_000;
  revoked = false;
  confidential = false;
  extraParts: ContextPart[] = [];
  readonly built: string[] = [];

  constructor(
    readonly targetModule: AiTargetModule = 'DFD',
    readonly kind: AiGenerationKind = 'DRAFT',
  ) {}

  validateRequest(_tx: TenantTx, _request: AiGeneratorRequest): Promise<AiGeneratorCheck> {
    return Promise.resolve({ baseRevision: null });
  }

  buildContext(_tx: TenantTx, generation: AiGeneration): Promise<AiGeneratorContext> {
    if (this.revoked) return Promise.reject(new AiPolicyRevokedError('PREREQUISITE_LOST'));
    this.built.push(generation.id);
    return Promise.resolve({
      parts: [
        {
          ref: { kind: 'PROCESS', id: generation.processId },
          label: 'Processo',
          data: { objeto: 'Aquisição de computadores', unidade: 'Secretaria de Educação' },
        },
        ...this.extraParts,
      ],
      sections: TEST_SECTIONS,
      isBudgetConfidential: this.confidential,
    });
  }
}

/** Portão do órgão de teste (US-116): libera por padrão. */
export class TestAiGate implements AiTenantGate {
  decision: AiGateDecision = { allowed: true };
  readonly requests: AiGateRequest[] = [];

  check(_tx: TenantTx, request: AiGateRequest): Promise<AiGateDecision> {
    this.requests.push(request);
    return Promise.resolve(this.decision);
  }
}

/** Gancho de teste: troca "R$ 1.500,00" por `[a confirmar]` (simula o GroundingGuard — US-122). */
export class TestValueGuard implements AiOutputPostProcessor {
  readonly name = 'test-value-guard';

  process({ output }: PostProcessingInput): AiGenerationOutput {
    return {
      ...output,
      sections: output.sections.map((section) => {
        let replaced = 0;
        const content = JSON.parse(JSON.stringify(section.content), (key, value: unknown) => {
          if (key !== 'content' || !Array.isArray(value)) return value;
          return value.flatMap((node: { type?: string; text?: string }) => {
            if (node.type !== 'text' || !node.text?.includes('R$ 1.500,00')) return [node];
            replaced += 1;
            const [before = '', after = ''] = node.text.split('R$ 1.500,00');
            return [
              ...(before ? [{ ...node, text: before }] : []),
              toConfirmNode('valor', 'VALUE'),
              ...(after ? [{ ...node, text: after }] : []),
            ];
          });
        }) as typeof section.content;
        return {
          ...section,
          content,
          groundingReplacements: section.groundingReplacements + replaced,
        };
      }),
    };
  }
}

export function aiRepositoryOf(api: TestApi): InMemoryAiGenerationRepository {
  return api.app.get(AI_GENERATION_REPOSITORY, { strict: false });
}

/** Cabeçalhos de DFD em memória (US-117: contexto do rascunho e "cabeçalho intacto"). */
export function dfdRepositoryOf(api: TestApi): InMemoryDfdRepository {
  return api.app.get(InMemoryDfdRepository, { strict: false });
}

export function jobQueueOf(api: TestApi): InMemoryJobQueue {
  return api.app.get(JOB_QUEUE, { strict: false });
}

/** Registra o gerador de teste no lugar do real do par (ex.: `DfdDraftGenerator` — US-117). */
export function replaceAiGenerator(api: TestApi, generator: AiGenerator): void {
  const generators = api.app.get(AiGeneratorRegistry);
  generators.unregister(generator.targetModule, generator.kind);
  generators.register(generator);
}

/** Registra o gerador, o portão e (opcional) o pós-processador de teste. */
export function installAiTestDoubles(api: TestApi, generator = new TestAiGenerator()) {
  const gate = new TestAiGate();
  replaceAiGenerator(api, generator);
  api.app.get(AiTenantGateRegistry).register(gate);
  return { generator, gate, postProcessors: api.app.get(AiPostProcessorRegistry) };
}

/**
 * Executa o job da geração como o worker: lê o job enfileirado (meta da requisição de origem —
 * tenant, ator, correlação) e chama o `AiGenerationJob` com a tentativa informada.
 */
export function runAiJob(api: TestApi, generationId: string, attempt = 1) {
  const job = jobQueueOf(api).find('ai-generation', generationId);
  if (job === undefined) throw new Error(`Job da geração ${generationId} não enfileirado`);
  return api.app.get(AiGenerationJob).process({
    id: job.jobId,
    queue: job.queue,
    name: job.name,
    attempt,
    data: job.data,
  });
}

/** Como a fila: tenta até `maxAttempts`, relançando só o erro final. */
export async function runAiJobWithRetries(
  api: TestApi,
  generationId: string,
  maxAttempts = 3,
): Promise<{ readonly attempts: number; readonly error: unknown }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runAiJob(api, generationId, attempt);
      return { attempts: attempt, error: null };
    } catch (error) {
      lastError = error;
    }
  }
  return { attempts: maxAttempts, error: lastError };
}

/** Transações das configurações do tenant (US-116: Falha de banco no SET-02). */
export { SETTINGS_TRANSACTIONS } from '#modules/tenancy/application/settings-ports.js';
export type { SettingsTransactions } from '#modules/tenancy/application/settings-ports.js';

/** Perfis padrão que concedem `AI_GENERATE` (RN-AI-21). */
export function rolesGrantingAiGenerate(): string[] {
  return DEFAULT_ROLES.filter((role) => role.permissions.includes('AI_GENERATE')).map(
    (role) => role.key,
  );
}
