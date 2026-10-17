# `ai`

Geração assistida de documentos do planejamento (DEC-040 · DEC-037 · DEC-079): dono de
`AiGeneration` (`ai_generations`). Módulo de **nível 5** que só **lê** outros módulos por fachadas
(regra D9 — dependency-cruiser `ai-read-only`); nunca executa comando de outro contexto.

## Camada de IA (US-115)

- **API:** AI-01 (pedido, `202` + `Location`), AI-02 (consulta para o polling, `ETag`), AI-03
  (histórico do processo, cursor, sem `output`) e AI-04 (descartar proposta / cancelar geração, só o
  solicitante) — `presentation/ai-generation.controller.ts`. Sem custo, resumo nem instrução nas
  respostas (o custo é de AI-06, US-116).
- **Pedido (`RequestAiGenerationCommand`):** provedor configurado e circuito fechado (503
  `AI_PROVIDER_UNAVAILABLE` + `Retry-After`) → gerador registrado (V-01) → `AI_GENERATE` sobre o
  processo (guard) → POL-02 do alvo pela fachada do `document` (`DocumentFacade.aiTargetIn`) →
  portão do órgão (`AiTenantGateRegistry`; **sem portão registrado = 403 `AI_DISABLED`**, US-116) →
  validação do gerador → uma ativa por alvo (409 `AI_GENERATION_IN_PROGRESS` + `meta.generationId`)
  → `AiGeneration` `QUEUED` + auditoria `ai.generation_request` + outbox `AiGenerationRequested` na
  MESMA transação → **depois do commit** enfileira `ai-generation/generate` com
  `jobId = generationId` (porta `JOB_QUEUE` do `platform`; fila fora → fica `QUEUED`, FA-05).
- **Pipeline (`AiGenerationProcessor`, job `AiGenerationJob` — base `TenantJob`):** claim condicional
  (`QUEUED → RUNNING`; retentativa do próprio job com `attempts` coerente; outra entrega = encerra) →
  revalidação (gerador, portão, POL-02 do solicitante; recusa = `CANCELED`/`CANCELED_BY_POLICY`) e
  contexto pelas fachadas na transação de leitura → `ContextSanitizer` → prompt versionado →
  provedor **fora de transação** com timeout → Zod + conversão TipTap (1 reparo) → ganchos de
  pós-processamento → `SUCCEEDED` + `ai.generation_complete` + `AiGenerationCompleted` (timeline
  `AI_CONTENT_GENERATED` no mesmo `tx`; notificação `AI_GENERATION_READY` no worker) — ou `FAILED` +
  `ai.generation_fail` + `AiGenerationFailed` (`AI_GENERATION_FAILED`). Falha transitória antes da
  última tentativa → `AiRetryableError` (a fila tenta de novo, 3 tentativas, base 10 s).
- **Porta `AiProvider`** (`application/ai-provider.port.ts`, sem SDK): `FakeAiProvider`
  (determinístico por fixture em `apps/api/test/fixtures/ai/<promptKey>/`, roteirizável para 429,
  5xx, timeout, filtro e saída inválida) e `UnavailableAiProvider` (`AI_PROVIDER=none`). O adaptador
  real entra com a ADR-013 (PEND-21) e deve passar no contrato `test/support/ai-provider-contract.ts`.
- **Domínio:** `ai-generation.ts` (máquina de estados — RN-AI-03), `context-sanitizer.ts` (LGPD e
  sigilo — RN-AI-05), `prompts.ts` + `prompts/common/system-prompt.ts` (versionados; impressões
  digitais travadas em `prompts/prompt-fingerprints.ts`), `structured-output.ts` +
  `output-converter.ts` (RN-AI-07), `post-processing.ts`, `ai-pricing.ts` + `pricing-table.ts`
  (RN-AI-09) e o disjuntor (regra no shared kernel `#shared/ai/ai-circuit-store.ts`, estado na
  chave Redis de plataforma `cf:{env}:ai:circuit`).
- **Porta `AiSuggestionSource`** (`#shared/ai/ai-suggestion-source.ts`): implementada aqui no
  `onModuleInit`; `document` (DOC-26) e `risk` (RSK-11) leem a proposta e marcam a aplicação na
  própria transação (US-117/US-119).

## Extensões (stories seguintes)

| Registro                  | Quem registra  | O quê                                                                                                         |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `AiGeneratorRegistry`     | US-117..US-121 | um `AiGenerator` por `targetModule`/`kind` (prompt, reserva de tokens, pré-requisitos, contexto por fachadas) |
| `AiTenantGateRegistry`    | US-116         | IA ligada, termos, limites e reserva (pedido e revalidação no job)                                            |
| `AiPostProcessorRegistry` | US-122         | `GroundingGuard` (troca o que não está nas entradas por `[a confirmar]`)                                      |

## Nunca

- Logar, auditar ou publicar resumo, instrução, contexto, prompt ou saída — só ids, versões,
  hashes (`contextHash`, `outputHash`, `inputRefs[].contentHash`) e contagens.
- Chamar o provedor dentro de transação ou da requisição HTTP.
- Dar ferramentas ao modelo ou aplicar conteúdo por conta própria (princípio 16).
