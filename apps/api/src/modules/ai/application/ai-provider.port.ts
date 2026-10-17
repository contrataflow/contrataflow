import type { AiProviderName } from '@contrataflow/types';

/*
 * Porta `AiProvider` (ACL — DEC-079 · RN-AI-14/15): o pipeline não conhece SDK de provedor. O
 * adaptador do provedor escolhido na ADR-013 (PEND-21) entra sem mudar o pipeline; até lá, só o
 * `FakeAiProvider` (dev/test/CI) e o `UnavailableAiProvider` (`AI_PROVIDER=none`). O modelo não
 * recebe ferramentas: a resposta é só texto estruturado (princípio 16 por construção).
 */

export interface AiProviderMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AiProviderRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly AiProviderMessage[];
  /** JSON Schema da resposta (saída estruturada). */
  readonly responseSchema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly timeoutMs: number;
  /** Cancela a chamada (timeout do pipeline). */
  readonly signal?: AbortSignal;
  /**
   * Metadados FORA do prompt: telemetria e escolha da fixture do `FakeAiProvider` (por
   * `promptKey` + `contextHash`). Um adaptador real não os envia ao modelo.
   */
  readonly metadata: {
    readonly promptKey: string;
    readonly promptVersion: string;
    readonly contextHash: string;
    readonly sectionKeys: readonly string[];
    readonly call: 'initial' | 'repair';
  };
}

export interface AiTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiProviderResponse {
  /** JSON produzido pelo modelo (objeto ou texto a interpretar). */
  readonly output: unknown;
  readonly usage: AiTokenUsage;
  readonly model: string;
  readonly finishReason: 'stop' | 'length' | 'content_filter' | 'other';
  readonly providerRequestId: string | null;
}

/** Classe da falha do provedor (mapeada para o `errorCode` da geração). */
export type AiProviderErrorKind =
  'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT' | 'CONTENT_FILTERED' | 'CONTEXT_TOO_LARGE';

const TRANSIENT: ReadonlySet<AiProviderErrorKind> = new Set([
  'RATE_LIMITED',
  'UNAVAILABLE',
  'TIMEOUT',
]);

/** Falha do provedor: 429, 5xx, rede e timeout são transitórias (RN-AI-08); as demais, finais. */
export class AiProviderError extends Error {
  readonly transient: boolean;
  readonly usage: AiTokenUsage;
  readonly retryAfterMs: number | null;

  constructor(
    readonly kind: AiProviderErrorKind,
    options: {
      readonly usage?: AiTokenUsage;
      readonly retryAfterMs?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      `Provedor de IA: ${kind}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AiProviderError';
    this.transient = TRANSIENT.has(kind);
    this.usage = options.usage ?? { inputTokens: 0, outputTokens: 0 };
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface AiProvider {
  /** `none` = IA desligada para todos (`AI_PROVIDER=none` → 503 `AI_PROVIDER_UNAVAILABLE`). */
  readonly name: AiProviderName | 'none';
  generate(request: AiProviderRequest): Promise<AiProviderResponse>;
}

export const AI_PROVIDER = Symbol('AiProvider');
