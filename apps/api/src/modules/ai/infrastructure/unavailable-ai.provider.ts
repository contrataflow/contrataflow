import { AiProviderError } from '../application/ai-provider.port.js';
import type { AiProvider, AiProviderResponse } from '../application/ai-provider.port.js';

/*
 * `AI_PROVIDER=none` (RN-AI-14 · FA-03): a IA fica desligada para todos — AI-01 responde 503
 * `AI_PROVIDER_UNAVAILABLE` antes de gravar, e um job que chegue aqui falha como indisponível.
 */
export class UnavailableAiProvider implements AiProvider {
  readonly name = 'none' as const;

  generate(): Promise<AiProviderResponse> {
    return Promise.reject(new AiProviderError('UNAVAILABLE'));
  }
}
