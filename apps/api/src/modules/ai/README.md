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
  (RN-AI-09), `fact-set.ts` + `grounding-guard.ts` (US-122 — RN-AI-54) e o disjuntor (regra no shared kernel `#shared/ai/ai-circuit-store.ts`, estado na
  chave Redis de plataforma `cf:{env}:ai:circuit`).
- **Porta `AiSuggestionSource`** (`#shared/ai/ai-suggestion-source.ts`): implementada aqui no
  `onModuleInit`; `document` (DOC-26) e `risk` (RSK-11) leem a proposta e marcam a aplicação na
  própria transação (US-117/US-119).

## Extensões (stories seguintes)

| Registro                  | Quem registra  | O quê                                                                                                         |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `AiGeneratorRegistry`     | US-117..US-121 | um `AiGenerator` por `targetModule`/`kind` (prompt, reserva de tokens, pré-requisitos, contexto por fachadas) |
| `AiTenantGateRegistry`    | US-116         | IA ligada, termos, limites e reserva (pedido e revalidação no job)                                            |
| `AiPostProcessorRegistry` | `AiModule`     | `GroundingGuard` (US-122 — troca o que não está nas entradas por `[a confirmar]`), registrado no init         |

## Rascunho do DFD — `draft.dfd` (US-117 · RN-AI-25..27)

- **Gerador** `application/dfd-draft.generator.ts` (`DFD`/`DRAFT`, registrado no `onModuleInit` do
  `AiModule`; testes trocam pelo de teste com `replaceAiGenerator`/`installAiTestDoubles`). Pedido:
  `dfdDraftRequestProblem` (resumo 20..2.000, documento). Job: lê pelas fachadas
  `DocumentFacade.aiDraftSourceIn` (template fixado + guia de redação, estado das seções, itens do
  documento), `DfdFacade.aiDraftHeaderIn` (cabeçalho sem pessoas), `ProcessFacade.aiContextIn`,
  `CatalogFacade`, `OrganizationFacade.departmentNames`, `TenancyFacade.organizationAiProfile` e a
  porta `#shared/process/process-item-catalog` — em sequência (transação interativa).
- **Contexto** `domain/dfd-draft-context.ts` (puro): partes/`inputRefs` `PROCESS`, `CATALOG`,
  `DOCUMENT_DRAFT`, `PROCESS_ITEMS` (opcional — sai primeiro em `CONTEXT_TRUNCATED`), `ORGANIZATION`
  e `TEMPLATE_VERSION` (+ `USER_SUMMARY`/`USER_INSTRUCTION` do pipeline). Só seções narrativas
  (`allowNarrative`); `OPTIONAL` pode vir ausente (`SectionSpec.optional` — FA-08). Avisos do gerador
  (`AiGeneratorContext.warnings`, somados aos da sanitização sem repetir): `MISSING_OPTIONAL_INPUT`
  (`params.input` = `ITEMS`/`EXPECTED_DATE`/`PCA_LINK`) e `BUDGET_CONFIDENTIAL_VALUES_OMITTED`
  (sigilo: nenhum valor entra). Chaves em pt-BR evitam as palavras de pessoa do sanitizador
  (`unidadeRequisitante`, nunca `…Solicitante`).
- **Prompt** `prompts/draft.dfd/prompt.ts` `1.0.0` (impressão digital travada); fixture
  `test/fixtures/ai/draft.dfd/padrao.json` (também a resposta do `AI_PROVIDER=fake` local).
- **Aplicação** é do `document` (DOC-26 — `ApplyAiContentCommand`), que lê a proposta pela porta
  `AiSuggestionSource` (agora com `trace`: modelo, prompt, `inputRefs`, hashes — para a auditoria).
- **Testes:** `domain/dfd-draft-context.spec.ts`, `presentation/dfd-draft.routes.spec.ts` (Gherkin
  completo em memória), `test/tenant-leak/ai-dfd-draft.spec.ts` (PostgreSQL: commit único, falha
  induzida, RLS).

## Rascunho do ETP — `draft.etp` (US-118 · RN-AI-33..37)

- **Gerador** `application/etp-draft.generator.ts` (`ETP`/`DRAFT`, registrado no `onModuleInit`;
  reserva 40 mil tokens; resumo opcional). Pedido: DFD não cancelado
  (`DocumentFacade.aiChainSourceIn`) senão 422 `AI_PREREQUISITE_MISSING` com `meta.missing: ['DFD']`
  (o ETP em `DRAFT`/`RETURNED`, POL-02 e etapa vêm do `aiTargetIn`). Job: o DFD pela precedência
  aprovada → versão → rascunho (é o `DfdSourceResolver` da story — lacuna 4), `DfdFacade.aiDraftHeaderIn`,
  `DocumentFacade.aiDraftSourceIn` (template com `render`, itens com a memória de cálculo em texto),
  `EtpFacade.aiDraftContextIn` (decisões tipadas e alternativas SEM o custo) e
  `PriceResearchFacade.aiCompletedResearchIn` (pesquisa concluída: total, método, cotações válidas
  por item — nunca fornecedores nem cotações). DFD perdido entre o pedido e o job → `CANCELED_BY_POLICY`.
- **Contexto** `domain/etp-draft-context.ts` (puro): partes/`inputRefs` `PROCESS`, `CATALOG`, o DFD
  (`DOCUMENT_VERSION` com `versionNumber` ou `DOCUMENT_DRAFT` + `USED_DRAFT_INPUTS`), as decisões
  do ETP (`DOCUMENT_DRAFT` do ETP), `PROCESS_ITEMS` e `ETP_ALTERNATIVES` (opcionais — saem primeiro
  no corte) e `PRICE_RESEARCH` (só concluída; senão `MISSING_PRICE_RESEARCH`) e `TEMPLATE_VERSION`.
  Valor estimado só da pesquisa concluída ou do valor do ETP vinculado a ela (RN-AI-36 — manual e
  custo de alternativa nunca). Sigilo: nenhum valor, nem em texto livre (`withoutMoney` troca por
  `[valor omitido]`). Seções `render ≠ TEXT` com narrativa entram como "texto complementar" no
  guia; sem narrativa ficam fora (RN-AI-37). Avisos `MISSING_OPTIONAL_INPUT`: `ETP_ITEMS`,
  `ALTERNATIVES`.
- **A IA não decide** (RN-AI-35/36): `EtpDecisionGuard` — pós-processador do PRÓPRIO gerador
  (`AiGeneratorContext.postProcessors`, roda antes da cadeia global/GroundingGuard) que garante o
  `toConfirm` de `CONCLUSION` (conclusão pendente), `RECOMMENDED_SOLUTION` (sem alternativa
  recomendada), `PARCELING` (sem decisão) e `ESTIMATES` (sem valor da pesquisa ou com sigilo);
  faltando, acrescenta um parágrafo com a marcação. Idempotente. Nada é escrito em `etp`.
- **Prompt** `prompts/draft.etp/prompt.ts` `1.0.0`; fixture `test/fixtures/ai/draft.etp/padrao.json`
  (15 seções — a opcional `OBJECTIVE` fica de fora). `pnpm ai:eval --suite etp` avalia o prompt com
  DFD aprovado, DFD em rascunho, sem pesquisa e sigiloso (`src/cli/ai-eval-etp.ts`).
- **Web:** o assistente do ETP fica no `EtpEditor` (o `DocumentView` recebe
  `showAiAssistant={false}`) para a aplicação ser adotada pelo autosave (`adoptSections`); a
  notificação abre `/processos/{id}/etp/{etpId}?ia=`.
- **Testes:** `domain/etp-draft-context.spec.ts`, `presentation/etp-draft.routes.spec.ts` (Gherkin
  completo em memória), `test/tenant-leak/ai-etp-draft.spec.ts` (PostgreSQL: RLS no contexto e no
  acesso, `etps` intacto).

## Rascunho do TR — `draft.tr` (US-120 · RN-AI-43..46)

- **Gerador** `application/term-draft.generator.ts` (`TERM_OF_REFERENCE`/`DRAFT`, registrado no
  `onModuleInit`; reserva 40 mil tokens; sem resumo da necessidade — vem do ETP). Pedido: ETP não
  cancelado (`DocumentFacade.aiChainSourceIn(…, 'ETP')`) senão 422 `AI_PREREQUISITE_MISSING` com
  `meta.missing: ['ETP']` (TR em `DRAFT`/`RETURNED`, POL-02 com `TERM_UPDATE` e etapa vêm do
  `aiTargetIn`). Job: ETP e DFD pela precedência aprovada → versão → rascunho (o `DfdSourceResolver`
  generalizado é o próprio `aiChainSourceIn`), `TermFacade.aiDraftContextIn` (condições tipadas e
  valor/origem), `EtpFacade.aiDraftContextIn` (origem do valor do ETP), `RiskFacade.aiContextIn`
  (título, descrição, categoria, fase e tratamentos — nunca responsáveis, causa nem prazos),
  `DocumentFacade.aiDraftSourceIn` (itens com `specification`/`acceptanceCriteria` em texto puro) e
  `PriceResearchFacade.aiCompletedResearchIn`. ETP perdido entre o pedido e o job →
  `CANCELED_BY_POLICY`.
- **Contexto** `domain/term-draft-context.ts` (puro): partes/`inputRefs` `PROCESS`, `CATALOG`, o ETP
  (`DOCUMENT_VERSION`/`DOCUMENT_DRAFT` + `USED_DRAFT_INPUTS`), `TERM_CONDITIONS` (condições como texto
  — "12 meses", "30 dias", "5% do valor do contrato" — que viram fatos do GroundingGuard; as ausentes
  listadas como `[a confirmar: …]`), `PROCESS_ITEMS`, DFD e `RISKS` (opcionais —
  `MISSING_OPTIONAL_INPUT` `DFD`/`RISKS`/`TERM_ITEMS`), `PRICE_RESEARCH` (só concluída) e
  `TEMPLATE_VERSION`. Valor (RN-AI-46, lacuna 3): total da pesquisa concluída; senão o valor do TR com
  origem `PRICE_RESEARCH`, ou `ETP` quando o ETP está vinculado à pesquisa — nunca `MANUAL`. Sigilo:
  `withoutMoney` como no ETP.
- **Guarda** `TermConditionGuard` (pós-processador do gerador, antes do GroundingGuard — mesma
  mecânica da `EtpDecisionGuard`): condição tipada ausente → `[a confirmar]` na seção que a cita
  (`OBJECT`/`DEADLINES` vigência; `DEADLINES`/`DELIVERY` prazo; `PAYMENT`; `GUARANTEES` garantias;
  `DELIVERY` local; `CONTRACTOR_OBLIGATIONS` subcontratação; `SELECTION_CRITERIA` critério e
  adjudicação), `ESTIMATED_VALUE` sem valor da pesquisa e `BUDGET_ADEQUACY` sempre (lacuna 4 — sem
  dotação no MVP 1). Multa com percentual fora das entradas: o GroundingGuard troca (RN-AI-45).
- **Prompt** `prompts/draft.tr/prompt.ts` `1.0.0`; fixture `test/fixtures/ai/draft.tr/padrao.json`
  (as 15 seções). `pnpm ai:eval --suite tr` (`src/cli/ai-eval-tr.ts`): condições preenchidas, TR sem
  condições, sem pesquisa e com seções importadas do ETP.
- **Web:** o assistente do TR fica no `TermEditor` (o `DocumentView` recebe
  `showAiAssistant={false}`), com o `TermAiRequestGuide` (entradas, condições preenchidas e
  ausentes) no `requestGuide` do painel e a adoção pelo autosave; a notificação abre
  `/processos/{id}/tr/{termId}?ia=`.
- **Testes:** `domain/term-draft-context.spec.ts`, `presentation/term-draft.routes.spec.ts` (Gherkin
  completo em memória), `test/tenant-leak/ai-term-draft.spec.ts` (PostgreSQL: RLS no contexto e no
  acesso, `terms_of_reference` e `document_items` intactos).

## Proposta do mapa de riscos — `draft.risk_map` (US-119 · RN-AI-38..41)

- **Gerador** `application/risk-map-draft.generator.ts` (`RISK_MAP`/`DRAFT`, registrado no
  `onModuleInit`; reserva 25 mil tokens; resumo opcional). Pedido: DFD não cancelado
  (`DocumentFacade.aiChainSourceIn`) senão 422 `AI_PREREQUISITE_MISSING` com `meta.missing: ['DFD']`;
  com o `RISK_MAP` já emitido, o pedido precisa apontá-lo (`documentId`). Job: DFD/ETP/TR pela
  precedência aprovada → versão → rascunho (`USED_DRAFT_INPUTS`), riscos registrados
  (`RiskFacade.aiContextIn`), categorias ativas (`CatalogFacade.activeItemsOf`) e `risk.scale`.
- **Contexto e normalização** `domain/risk-map-draft-context.ts` (puro): seções de valor
  (`ESTIMATES`, `ESTIMATED_VALUE`) nunca entram; sem documento, as seções da resposta são
  descartadas (`ignoreUnknownSections`). `riskMapResponseSchema` (1..15 riscos, 1..3 tratamentos,
  sem responsável/prazo/valor) + `normalizeRiskProposal` (`AiGeneratorContext.refineRisks`, dentro
  do reparo): grau acima da escala vigente = saída inválida; categoria desconhecida → `OUTRO`;
  chaves `R1`/`R1.T1`. **Semelhança pelo código** (`similarToRiskCode: 'R03'` → `similarToRiskId`):
  ids não vão ao modelo porque a sanitização mascara sequências numéricas longas dos UUIDs.
- **GroundingGuard nos riscos:** texto simples → marcador LITERAL "[a confirmar: …]"
  (`groundPlainText`); as trocas contam por diferença de marcadores (`runPostProcessors`).
- **Aplicação** é do `risk` (RSK-11/RSK-12); as seções narrativas seguem pelo DOC-26 (cada parte
  uma vez — `appliedTargets` acumula). Notificação `AI_GENERATION_READY` do mapa abre
  `/processos/{id}/riscos?ia=`.
- **Testes:** `domain/risk-map-draft-context.spec.ts`, `presentation/risk-map-draft.routes.spec.ts`
  (Gherkin completo em memória), `test/tenant-leak/ai-risk-map-draft.spec.ts` (PostgreSQL).

## Ajuste de seção — `section.rewrite`/`complete`/`summarize` (US-121 · RN-AI-47..52)

- **Gerador** `application/section-adjust.generator.ts`: uma instância de `SectionAdjustGenerator`
  por `targetModule` (`DFD`, `ETP`, `RISK_MAP`, `TERM_OF_REFERENCE`), `kind = SECTION`, registradas
  no `onModuleInit`. Reserva 6 mil tokens (`AI_SECTION_RESERVED_TOKENS`); o prompt é o da ação
  (`AiGenerator.actionPrompts` + `promptOf` — o `promptKey` gravado e o renderizado no job). Modelo
  `AI_MODEL_SECTION` (`settings.models.section`).
- **Pedido** (`SectionAdjustPolicy`, regra comum ao web em `@contrataflow/validation`
  `aiSectionAdjustProblem`): seção fora do template, sem narrativa (`render ≠ TEXT` e
  `allowNarrative = false`) ou `NOT_APPLICABLE` → 422 `AI_SECTION_NOT_SUPPORTED`;
  `REWRITE`/`SUMMARIZE` com menos de 50 caracteres → 422 `AI_SECTION_EMPTY`. `baseRevision` = revisão
  da seção lida por `DocumentFacade.aiSectionSourceIn`. Uma ativa por seção (índice parcial
  `ai_generations_active_section_key`); seções diferentes em paralelo.
- **Contexto** `domain/section-adjust-context.ts` (puro): `SECTION` (texto atual, com a revisão —
  obrigatório; o GroundingGuard o trata como fato, então valores escritos pela pessoa ficam) →
  `TEMPLATE_VERSION` (guia da seção) → `PROCESS` → `DOCUMENT_DRAFT` (demais seções, opcional) →
  antecessores da cadeia que existirem (`SECTION_ADJUST_CHAIN`: ETP ← DFD; mapa ← DFD, ETP; TR ← DFD,
  ETP, mapa — sem `AI_PREREQUISITE_MISSING`; falta = `MISSING_OPTIONAL_INPUT`) → `ORGANIZATION`.
  Seções de valor da cadeia nunca entram. Seção que deixou de ser ajustável no job →
  `CANCELED_BY_POLICY`. A saída é UMA seção, a pedida, no `maxChars`.
- **Aplicação** é do `document` (DOC-26): só a seção da geração (422 `NOT_ALLOWED`), `If-Match`
  primeiro (412) e então a revisão da seção = `baseRevision` (senão 410 `AI_SUGGESTION_STALE` + log
  `warn ai.section_adjust_stale`); nunca cria versão. "Desfazer" é do painel, pelo DOC-05.
- **Testes:** `domain/section-adjust-context.spec.ts`, `prompts/section/prompts.spec.ts`,
  `presentation/section-adjust.routes.spec.ts` (Gherkin completo em memória, quatro documentos),
  `test/tenant-leak/ai-section-adjust.spec.ts` (PostgreSQL: 410 sem efeito, commit único, falha
  induzida, RLS).

## GroundingGuard (US-122 · RN-AI-54)

Pós-processador determinístico registrado pelo `AiModule`: todo valor monetário, quantidade com
unidade, prazo/duração, data e percentual do texto gerado precisa existir no `FactSet` das entradas
(contexto sanitizado, normalizado: centavos, dias/meses, ISO, algarismos e extenso pt-BR); o que
faltar vira `toConfirm` (`VALUE`/`QUANTITY`/`DEADLINE`/`DATE`) e conta em `groundingReplacements`.
Citações legais ficam. Idempotente. Depois da cadeia, `postProcessingIssues` confere de novo o
schema do editor e o `maxChars`; exceção ou problema → `FAILED`/`OUTPUT_INVALID` sem `output`
(falha fechada) e log `error ai.grounding_failed`. Número de campo estruturado das entradas
sustenta também o valor em reais (`c:`): trade-off aceito para não marcar o valor estimado que vem
da pesquisa de preços como número.

## Nunca

- Logar, auditar ou publicar resumo, instrução, contexto, prompt ou saída — só ids, versões,
  hashes (`contextHash`, `outputHash`, `inputRefs[].contentHash`) e contagens.
- Chamar o provedor dentro de transação ou da requisição HTTP.
- Dar ferramentas ao modelo ou aplicar conteúdo por conta própria (princípio 16).
