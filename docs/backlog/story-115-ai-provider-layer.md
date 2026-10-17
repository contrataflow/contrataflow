---
id: US-115
title: "Camada de IA com registro e rastreabilidade das gerações"
epic: EP-020
feature: FT-060
mvp: 1
priority: P1
estimate: L
status: Especificada
depends_on: [US-059, US-065, US-073, US-083, US-097]
modules: [ai, document, dfd, etp, risk, term, process, tenancy, access, timeline, notification, audit, platform]
screens: [SCR-117]
endpoints: [AI-01, AI-02, AI-03, AI-04]
permissions: [AI_GENERATE, PROCESS_VIEW]
events: [AiGenerationRequested, AiGenerationCompleted, AiGenerationFailed]
---

# US-115 — Camada de IA com registro e rastreabilidade das gerações

## Título
Camada de IA com registro e rastreabilidade das gerações

## Descrição
**Como** redator do processo de contratação, **quero** que todo conteúdo gerado por IA seja pedido, executado e registrado por uma camada única, segura e auditável, **para** poder confiar no que a IA produz, saber exatamente o que foi enviado e por quem, e nunca perder o controle sobre o documento.

Esta story entrega a fundação do EP-020: o módulo `ai` (nível 5, só fachadas de leitura), a porta `AiProvider` com o `FakeAiProvider`, a entidade `AiGeneration`, a fila `ai-generation` com o processador do worker, o pipeline genérico (sanitização do contexto → prompt versionado → provedor → validação Zod/reparo → conversão para TipTap → ganchos de pós-processamento), os endpoints `AI-01` a `AI-04`, a porta `AiSuggestionSource` do shared kernel, custo por tabela de preços, disjuntor, expiração das propostas, métricas e o harness `pnpm ai:eval`. Os geradores concretos (DFD, ETP, mapa de riscos, TR, ajuste de seção) entram nas US-117 a US-121; os limites e a ativação por órgão, na US-116; o GroundingGuard e as marcações, na US-122.

## Contexto
- Produto (DEC-037, prd-3): rascunhos e ajustes de DFD, ETP, mapa de riscos e TR com IA, sempre revisados e aprovados por uma pessoa. Princípio 16: a IA nunca aprova, encaminha, publica nem decide.
- Arquitetura (DEC-079): módulo `ai` no MVP 1, regra D9 (nunca executa comando de outro contexto; dependency-cruiser `ai-read-only`); chamada de IA nunca dentro de transação nem da requisição HTTP; aplicação do conteúdo é comando do módulo dono (`document`, `risk`) lido pela porta `AiSuggestionSource`.
- LGPD e sigilo (DEC-140, DEC-030): o provedor é um subprocessador externo; só sai dado do próprio tenant, minimizado, e nunca valor de orçamento sigiloso.
- O provedor real depende da ADR-013 (PEND-21): até a decisão, só a porta, o `FakeAiProvider`, os testes de contrato e o harness `pnpm ai:eval` (que apoia a escolha). O modelo de custo para o cliente é PEND-22 (padrão: sem cobrança; custo registrado por geração).
- Depende da projeção da timeline (US-059), do ciclo de vida do documento (US-065), da auditoria transacional (US-073), do worker e filas (US-083) e da autorização (US-097).

## Objetivo
Toda geração com IA no MVP 1 passa por um único caminho: registrada antes da chamada, executada de forma assíncrona e idempotente, sem dado pessoal desnecessário, com custo e tokens medidos, resultado validado e rastreável em auditoria, timeline e notificação — sem nunca alterar um documento por conta própria.

## Persona
- **Principal:** Redator do processo (perfil `PLANEJAMENTO`).
- **Secundárias:** Área requisitante (`REQUISITANTE`), Gestor de contratações (`GESTOR_CONTRATACOES`), Compras (`COMPRAS`) e Gestor de contrato (`GESTOR_CONTRATO`) como solicitantes; operação da plataforma (diagnóstico, métricas, avaliação de provedores).

## Pré-condições
- Usuário autenticado com vínculo ativo e `AI_GENERATE` cobrindo o processo, mais a permissão de edição do tipo do documento alvo (`DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE` ou `TERM_UPDATE`).
- IA ligada no órgão e dentro dos limites (portão do órgão, US-116); provedor configurado (`AI_PROVIDER` ≠ `none`) e circuito fechado.
- Gerador registrado para o par `targetModule`/`kind` (US-117 a US-121; nos testes, um gerador de teste).
- Documento alvo em `DRAFT`/`RETURNED` e tipo permitido na etapa (POL-02), quando o alvo é um documento.

## Fluxo principal
1. No editor do documento (SCR-007, SCR-008, SCR-011 ou SCR-012), o usuário aciona **"Gerar com IA"**; o painel `AiAssistantPanel` (SCR-117) coleta os dados do pedido (formulário específico de cada gerador) e envia `AI-01` com `Idempotency-Key`.
2. A API valida o corpo, autoriza (POL-18: `AI_GENERATE` + permissão do tipo + POL-02 sobre o alvo), confere a disponibilidade do provedor/disjuntor, consulta o portão do órgão (US-116) e pede ao gerador a validação específica (pré-requisitos, `baseRevision`, estimativa de tokens).
3. Em uma transação curta, grava `AiGeneration` em `QUEUED` (RN-AI-01), audita `ai.generation_request`, grava `AiGenerationRequested` no outbox; **após o commit**, enfileira `ai-generation` com `jobId = generationId` (RN-AI-02) e responde `202` com `Location` e `meta.pollAfterMs`.
4. O worker assume o job: transição condicional `QUEUED → RUNNING` (RN-AI-03), revalida o portão do órgão e a autorização do solicitante (RN-AI-22/US-116) e monta o contexto por fachadas de leitura na transação do tenant (RN-AI-04).
5. O `ContextSanitizer` minimiza os dados (RN-AI-05) e produz `inputRefs` e `contextHash`; o `PromptRegistry` entrega o prompt da `promptKey`/`promptVersion` do gerador (RN-AI-06).
6. Fora de qualquer transação, o worker chama a porta `AiProvider` (`generate`) com timeout de 120 s (RN-AI-02/08).
7. A resposta é validada por Zod e convertida para TipTap (RN-AI-07); em caso de saída inválida, há uma tentativa de reparo. Em seguida rodam os ganchos de pós-processamento em ordem (a US-122 registra o GroundingGuard).
8. Em transação curta, o worker grava `SUCCEEDED` com `output`, `outputHash`, tokens, custo, latência, `expiresAt` (7 dias) e contadores; audita `ai.generation_complete`; grava `AiGenerationCompleted` no outbox; a timeline projeta `AI_CONTENT_GENERATED` e o consumidor cria `AI_GENERATION_READY` para o solicitante.
9. O painel (polling de `AI-02`) mostra a proposta; a pessoa aplica pelo comando do módulo dono (US-117 a US-121, via `AiSuggestionSource`) ou descarta por `AI-04`. `AI-03` alimenta a aba `AiHistoryTab`.

## Fluxos alternativos
- **FA-01 — Falha definitiva:** esgotadas as tentativas (ou saída inválida após reparo), a geração vai a `FAILED` com `errorCode`; o solicitante recebe `AI_GENERATION_FAILED` e o painel oferece "Tentar novamente".
- **FA-02 — Cancelar:** `AI-04` em `QUEUED`/`RUNNING` marca `CANCELED`; o worker não chama o provedor ou descarta a resposta (tokens da resposta descartada são registrados).
- **FA-03 — Provedor indisponível:** `AI_PROVIDER=none` ou circuito aberto → `503 AI_PROVIDER_UNAVAILABLE` com `Retry-After`; o painel desabilita a ação com explicação.
- **FA-04 — Já existe geração ativa para o alvo:** `409 AI_GENERATION_IN_PROGRESS` com `meta.generationId`; o painel abre a geração em andamento.
- **FA-05 — Fila indisponível após o commit:** o registro permanece `QUEUED`; o reconciliador do padrão B (DEC-163) reenfileira o job sem ativo; o usuário vê "gerando" até lá.
- **FA-06 — Política mudou antes da execução:** permissão revogada, IA desligada ou limite atingido antes da chamada → `CANCELED` com `errorCode = CANCELED_BY_POLICY`, sem chamar o provedor.
- **FA-07 — Contexto grande ou conteúdo filtrado:** partes opcionais são omitidas com aviso `CONTEXT_TRUNCATED`; se o obrigatório não couber → `FAILED`/`CONTEXT_TOO_LARGE`; filtro do provedor → `FAILED`/`CONTENT_FILTERED`.
- **FA-08 — Proposta vencida:** após 7 dias a proposta `SUCCEEDED` vira `EXPIRED`; permanece consultável, mas não pode ser aplicada.

## Regras de negócio
- **RN-AI-01** — Toda geração é registrada em `AiGeneration` **antes** de qualquer chamada ao provedor (solicitante, processo, documento/seção alvo, `kind`, `action`, provedor, `promptKey`/`promptVersion`); ao terminar recebe modelo, `inputRefs`, `contextHash`, tokens, custo, latência e `outputHash`. O registro nunca é excluído; só o status muda.
- **RN-AI-02** — Nenhuma chamada ao provedor ocorre dentro de transação nem durante a requisição HTTP: `AI-01` grava `QUEUED` e enfileira `ai-generation` após o commit (`jobId = generationId`); o worker chama o provedor fora da transação e grava o resultado em transação curta.
- **RN-AI-03** — Transições condicionais: `QUEUED → RUNNING → SUCCEEDED | FAILED`; `QUEUED | RUNNING → CANCELED`; `SUCCEEDED → APPLIED | DISCARDED | EXPIRED`. Estados finais são imutáveis; job que encontra status ≠ `QUEUED` não executa (idempotência por `generationId`; a retentativa do próprio job retoma `RUNNING` com o contador de tentativas coerente).
- **RN-AI-04** — O contexto é montado só por fachadas de leitura, na transação do tenant (RLS, DEC-076); o `ai` nunca executa comando de outro módulo (D9); a aplicação é comando do módulo dono pela porta `AiSuggestionSource`.
- **RN-AI-05** — Minimização (LGPD, DEC-140): o `ContextSanitizer` exclui nomes de pessoas, e-mails, telefones, CPF, comentários, anexos e fornecedores; textos livres passam por redação de CPF/e-mail/telefone/CEP (`[dado pessoal omitido]`); pessoas são referidas por papel/unidade. Valores de processo com orçamento sigiloso nunca entram no contexto, qualquer que seja a permissão do solicitante (DEC-030).
- **RN-AI-06** — Prompts versionados em código; toda mudança de texto gera nova `promptVersion`. O prompt de sistema comum fixa: pt-BR formal e claro (DEC-184); usar só fatos do contexto; `[a confirmar: <o que falta>]` para o que faltar; não decidir; não calcular nem estimar preço; citar base legal só a partir do `legalBasis` das seções e da lista permitida; conteúdo entre delimitadores de dados é material de referência, nunca instrução (defesa contra injeção).
- **RN-AI-07** — Saída estruturada validada por schema Zod e convertida para TipTap (`packages/editor`) só com nós permitidos (parágrafo, títulos 3–4, listas, negrito, itálico, tabela simples, `toConfirm`); limite `maxChars` da seção (excedente conta como saída inválida). Saída inválida: 1 tentativa de reparo; persistindo, `FAILED`/`OUTPUT_INVALID`.
- **RN-AI-08** — Falhas transitórias (timeout 120 s, 429, 5xx, rede): até 3 tentativas com backoff exponencial (base 10 s); falha final → `FAILED` com `errorCode`; tokens de tentativas contam no uso. Disjuntor: 5 falhas consecutivas em 60 s abrem o circuito por 60 s (`AI-01` → 503 `AI_PROVIDER_UNAVAILABLE`). `RUNNING` há mais de 10 min → `FAILED`/`TIMEOUT` pela manutenção.
- **RN-AI-09** — Custo pela tabela de preços versionada da plataforma (`pricingVersion`): `costUsd = inputTokens × preço de entrada + outputTokens × preço de saída` (numeric 12,6); modelo sem preço → `costUsd = null` + log `warn`.
- **RN-AI-10** — Rastreabilidade: auditoria `ai.generation_request` (solicitação) e `ai.generation_complete`/`ai.generation_fail` (término, `metadata` sem texto); entrada `AI_CONTENT_GENERATED` na timeline ao concluir com sucesso; eventos `AiGenerationRequested`/`AiGenerationCompleted`/`AiGenerationFailed`; notificações `AI_GENERATION_READY`/`AI_GENERATION_FAILED` ao solicitante.
- **RN-AI-11** — Proposta `SUCCEEDED` vale 7 dias (`expiresAt`); depois vira `EXPIRED` (tarefa diária `ai-proposals-expire` da fila `maintenance`); o conteúdo fica guardado para rastreabilidade, mas não pode ser aplicado.
- **RN-AI-12** — Uma geração ativa (`QUEUED`/`RUNNING`) por alvo: `DRAFT` por (processo, `targetModule`), `SECTION` por (documento, `sectionKey`); nova solicitação → 409 `AI_GENERATION_IN_PROGRESS` com `meta.generationId`.
- **RN-AI-13** — Só o solicitante aplica, descarta ou cancela a própria geração (`AI_GENERATION_NOT_OWNED`); consultar (`AI-02`/`AI-03`) exige `PROCESS_VIEW` do processo.
- **RN-AI-14** — Provedor e modelos são configuração de plataforma (`AI_PROVIDER`, `AI_MODEL_DRAFT`, `AI_MODEL_SECTION`; segredos no Secrets Manager); `fake` em dev/test/CI; `none` desliga para todos (503 `AI_PROVIDER_UNAVAILABLE`). O provedor real segue a ADR-013 (PEND-21) — o adaptador real entra quando o usuário decidir; até lá, só a porta, o `FakeAiProvider` e testes de contrato.
- **RN-AI-15** — O modelo não recebe ferramentas nem aciona ações do sistema; a resposta é só texto estruturado (princípio 16 por construção).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo de documento | `targetModule` | enum `SystemDocumentModule` (`DFD`, `ETP`, `RISK_MAP`, `TERM_OF_REFERENCE`) | Sim | deve ter gerador registrado | editor de origem |
| Documento | `documentId` | uuid | Condicional | obrigatório em `SECTION`; nulo só em `RISK_MAP` sem documento emitido; pertence ao processo e ao `targetModule` | documento aberto |
| Tipo de geração | `kind` | enum `AiGenerationKind` (`DRAFT`, `SECTION`) | Sim | — | ação escolhida |
| Ação sobre a seção | `action` | enum `AiSectionAction` (`REWRITE`, `COMPLETE`, `SUMMARIZE`) | Condicional | obrigatória em `SECTION`; proibida em `DRAFT` | menu da seção |
| Seção | `sectionKey` | string | Condicional | obrigatória em `SECTION`; proibida em `DRAFT` | seção aberta |
| Resumo da necessidade | `needSummary` | text | Condicional | ausente/vazio ou 20..2.000 caracteres; cada gerador define se é obrigatório | `AiRequestForm` |
| Orientações | `instruction` | varchar(500) | Não | ≤ 500 caracteres | — |
| *(cabeçalho)* Chave de idempotência | `Idempotency-Key` | uuid | Recomendado | o front sempre envia | gerado |
| *(sistema)* Situação | `status` | enum `AiGenerationStatus` | — | RN-AI-03 | `QUEUED` |
| *(sistema)* Provedor, modelo, prompt | `provider`, `model`, `promptKey`, `promptVersion` | string | — | gravados no registro (RN-AI-01) | `AI_PROVIDER`, `AI_MODEL_*` |
| *(sistema)* Entradas e hashes | `inputRefs`, `contextHash`, `outputHash` | jsonb / string | — | só ids, versões e hashes; nunca texto | worker |
| *(sistema)* Consumo | `reservedTokens`, `inputTokens`, `outputTokens`, `totalTokens`, `costUsd`, `pricingVersion`, `latencyMs`, `attempts` | int / numeric(12,6) | — | RN-AI-08/09 | worker |
| *(sistema)* Resultado | `output`, `placeholdersCount`, `groundingReplacements`, `errorCode`, `expiresAt` | jsonb / int / enum | — | `errorCode` obrigatório em `FAILED` | worker |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `targetModule`/`kind` ausente, inválido ou sem gerador registrado | Front + API (Zod) | "Este tipo de geração não está disponível." | `VALIDATION_ERROR` |
| V-02 | `kind = SECTION` sem `action`, `sectionKey` ou `documentId`; ou `DRAFT` com `action`/`sectionKey` | Front + API (Zod) | "Revise os dados do pedido." | `VALIDATION_ERROR` |
| V-03 | `needSummary` fora de 20..2.000 caracteres | Front + API (Zod) | "Descreva a necessidade com 20 a 2.000 caracteres." | `VALIDATION_ERROR` |
| V-04 | `instruction` acima de 500 caracteres | Front + API (Zod) | "As orientações aceitam até 500 caracteres." | `VALIDATION_ERROR` |
| V-05 | `documentId` de tipo diferente do `targetModule` | API | "O documento não corresponde ao tipo escolhido." | `VALIDATION_ERROR` |
| V-06 | Documento fora de `DRAFT`/`RETURNED` | API | "O documento não pode ser editado no status atual." | `DOCUMENT_NOT_EDITABLE` |
| V-07 | Tipo do documento não permitido na etapa | API | "Este documento não pode ser editado nesta etapa do processo." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-08 | Geração ativa para o mesmo alvo | API | "Já existe uma geração em andamento para este alvo." | `AI_GENERATION_IN_PROGRESS` |
| V-09 | Descartar/cancelar geração que não está em `QUEUED`, `RUNNING` ou `SUCCEEDED` | API | "Esta geração não pode mais ser descartada." | `AI_GENERATION_NOT_APPLICABLE` |

## Permissões
- **Permissão:** `AI_GENERATE` (risco `M`, escopável) cobrindo o processo, mais a permissão de edição do tipo do documento alvo; `PROCESS_VIEW` para consultar (`AI-02`/`AI-03`).
- **Políticas:** POL-18 (avaliada em `AI-01` e revalidada no worker); POL-02 sobre o alvo (custódia ou participação `COLLABORATOR`/`CONSULTANT` + documento `DRAFT`/`RETURNED` + tipo permitido na etapa). `AI-04` exige ser o solicitante (RN-AI-13) e não depende de `AI_GENERATE` nem da IA ligada: quem pediu sempre pode descartar ou cancelar.
- **MFA:** não exigido (risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Gerar com IA" não é exibido; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`. `AI_GENERATE` não vem por participação no processo nem para `CONSULTOR_EXTERNO`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiGenerationRequested` | `ai.generation_requested` | Commit de `AI-01` | `generationId`, `processId`, `documentId?`, `targetModule`, `kind`, `action?`, `sectionKey?`; consumo para métricas |
| `AiGenerationCompleted` | `ai.generation_completed` | Commit do `SUCCEEDED` no worker | `requestedById`, `model`, `promptKey`, `promptVersion`, `totalTokens`, `sectionsCount`, `risksCount`, `placeholdersCount`; projeta `AI_CONTENT_GENERATED` e dispara `AI_GENERATION_READY` |
| `AiGenerationFailed` | `ai.generation_failed` | Commit do `FAILED` no worker | `requestedById`, `errorCode`, `attempts`; dispara `AI_GENERATION_FAILED` |
- Payloads nunca levam resumo, instrução, contexto, saída nem valores. O ator do envelope é o solicitante (o job carrega o ator — DEC-164). Descartes e cancelamentos não geram evento (apenas auditoria).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_GENERATION_READY` | Solicitante (`requestedById`) | In-app (sem e-mail; não obrigatória) | `AiGenerationCompleted`; link para o editor com `?ia=<generationId>` |
| `AI_GENERATION_FAILED` | Solicitante | In-app (sem e-mail; não obrigatória) | `AiGenerationFailed` |
- Exceção registrada à regra "nunca notificar o próprio ator": avisam o autor do trabalho assíncrono que ele mesmo pediu.

## Critérios de aceite em Gherkin
```gherkin
Feature: Camada de IA com registro e rastreabilidade das gerações

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com a IA ligada e o provedor de IA de teste (FakeAiProvider)
    And o processo "0012/2026" tem um DFD em "DRAFT" sob custódia de "Carla"
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO" e "AI_GENERATE"
    And existe um gerador de teste registrado para "DFD" e "DRAFT"

  Scenario: [Sucesso] Solicitar e concluir uma geração
    When "Carla" enviar AI-01 com "targetModule" "DFD", "kind" "DRAFT" e um resumo válido
    Then a API deve responder 202 com o cabeçalho "Location" e "meta.pollAfterMs" igual a 2000
    And deve existir uma "AiGeneration" "QUEUED" criada antes de qualquer chamada ao provedor, com "promptKey" e "promptVersion"
    And deve gerar o evento "AiGenerationRequested" e registro de auditoria "ai.generation_request"
    When o worker processar o job "ai-generation" cujo "jobId" é o "generationId"
    Then a geração deve ficar "SUCCEEDED" com "inputRefs", "contextHash", "outputHash", tokens, "costUsd", "latencyMs" e "expiresAt" em 7 dias
    And deve gerar o evento "AiGenerationCompleted" e registro de auditoria "ai.generation_complete"
    And a timeline deve ter a entrada "AI_CONTENT_GENERATED" com "Carla" como ator
    And "Carla" deve receber a notificação "AI_GENERATION_READY" com link "?ia=<generationId>"
    And o documento DFD não deve ter sido alterado

  Scenario: [Sucesso] Pós-processamento registrado altera a saída antes de gravar
    Given que um gancho de pós-processamento de teste troca um valor da saída por "[a confirmar]"
    When o worker concluir a geração
    Then a saída gravada deve conter a troca e "groundingReplacements" deve ser 1

  Scenario: [Sucesso] Consultar, listar e descartar
    Given que a geração está "SUCCEEDED"
    When "Carla" consultar AI-02 e listar AI-03 do processo
    Then AI-02 deve trazer "output" e "usage" sem "costUsd", e AI-03 não deve trazer "output"
    When "Carla" descartar a geração por AI-04
    Then a geração deve ficar "DISCARDED" e deve existir auditoria "ai.generation_discard"

  Scenario: [Sucesso] Proposta vence após 7 dias
    Given que existe uma geração "SUCCEEDED" com "expiresAt" no passado
    When a tarefa "ai-proposals-expire" executar
    Then a geração deve ficar "EXPIRED" e o "output" deve ser mantido

  Scenario: [Validação] Seção sem ação ou chave
    When "Carla" enviar AI-01 com "kind" "SECTION" sem "sectionKey"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "sectionKey"
    And nenhuma "AiGeneration" deve ser criada

  Scenario: [Validação] Contexto minimizado antes de sair
    Given que o resumo contém um CPF e um e-mail e o processo tem comentários e fornecedores
    When o worker montar o contexto
    Then o texto enviado ao provedor deve conter "[dado pessoal omitido]" no lugar do CPF e do e-mail
    And não deve conter comentários, anexos nem fornecedores
    And os valores de orçamento sigiloso não devem estar no contexto

  Scenario: [Validação] Saída inválida com um reparo
    Given que o provedor de IA de teste responde uma saída fora do schema na 1ª chamada e válida no reparo
    When o worker processar a geração
    Then a geração deve ficar "SUCCEEDED" e os tokens das duas chamadas devem ser somados
    Given que a saída continua inválida após o reparo
    Then a geração deve ficar "FAILED" com "errorCode" "OUTPUT_INVALID"

  Scenario: [Permissão] Usuário sem AI_GENERATE
    Given que "Bruno" não possui "AI_GENERATE" para o processo
    When "Bruno" enviar AI-01
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Permissão] Outra pessoa tenta descartar a geração
    When "Bruno", com "PROCESS_VIEW", enviar AI-04 para a geração de "Carla"
    Then a API deve responder 403 com código "AI_GENERATION_NOT_OWNED"
    And a geração não deve mudar de status

  Scenario: [Tenant incorreto] Geração e processo de outro tenant
    Given que existe uma geração e um processo no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", consultar a geração e solicitar AI-01 no processo de "Prefeitura B"
    Then a API deve responder 404 com código "AI_GENERATION_NOT_FOUND" e 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Carla" enviou AI-01 com a chave "K1" e recebeu 202
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 202 com o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única "AiGeneration" e um único job

  Scenario: [Duplicidade] Segunda geração ativa para o mesmo alvo
    Given que existe uma geração "RUNNING" de "DRAFT" do DFD do processo
    When "Carla" enviar AI-01 com outra chave de idempotência para o mesmo alvo
    Then a API deve responder 409 com código "AI_GENERATION_IN_PROGRESS" e "meta.generationId" da geração ativa

  Scenario: [Concorrência] Cancelamento durante a execução
    Given que o provedor de IA de teste demora a responder e a geração está "RUNNING"
    When "Carla" cancelar por AI-04 e depois o provedor responder
    Then a geração deve permanecer "CANCELED", sem "output", e os tokens da resposta descartada devem ser registrados

  Scenario: [Concorrência] Job duplicado e aplicação simultânea
    Given que o mesmo "generationId" é entregue a dois workers
    Then somente um deve chamar o provedor e o outro deve encerrar sem executar
    Given que duas aplicações simultâneas usam "AiSuggestionSource.markApplied" na mesma geração "SUCCEEDED"
    Then uma deve vencer e a outra deve receber "AI_GENERATION_NOT_APPLICABLE"

  Scenario: [Falha de banco] Banco indisponível na solicitação
    Given que o banco de dados fica indisponível durante a transação de AI-01
    When "Carla" enviar AI-01
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum registro deve ser criado e nenhum job deve ser enfileirado

  Scenario: [Falha de banco] Banco indisponível ao gravar o resultado
    Given que o provedor respondeu e o banco falha ao gravar o resultado
    When o job for retentado
    Then nenhuma proposta parcial deve ficar visível e a geração não deve ficar "SUCCEEDED" sem "output"

  Scenario: [Falha de integração] Provedor com 429 e depois sucesso
    Given que o provedor de IA de teste responde 429 duas vezes e depois uma saída válida
    When o worker processar a geração com backoff exponencial
    Then a geração deve ficar "SUCCEEDED" com "attempts" igual a 3

  Scenario: [Falha de integração] Timeout esgota as tentativas
    Given que o provedor de IA de teste excede o timeout em todas as tentativas
    When o worker processar a geração
    Then a geração deve ficar "FAILED" com "errorCode" "TIMEOUT"
    And deve gerar o evento "AiGenerationFailed", auditoria "ai.generation_fail" e a notificação "AI_GENERATION_FAILED"

  Scenario: [Falha de integração] Disjuntor aberto
    Given que houve 5 falhas consecutivas do provedor em 60 segundos
    When "Carla" enviar AI-01
    Then a API deve responder 503 com código "AI_PROVIDER_UNAVAILABLE" e o cabeçalho "Retry-After"

  Scenario: [Falha de integração] Fila ou relay do outbox indisponível
    Given que o Redis está indisponível no momento do enfileiramento
    When "Carla" enviar AI-01
    Then a API deve responder 202 e a geração deve permanecer "QUEUED" até o reconciliador reenfileirar
    Given que o relay do outbox está indisponível
    Then os eventos devem permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerar conteúdo com IA neste processo." | Botão oculto; API bloqueia |
| Não é custodiante nem participante | 403 | `NOT_PROCESS_CUSTODIAN` | "Somente quem custodia ou participa do processo pode gerar conteúdo." | Ação oculta |
| IA desligada no órgão (US-116) | 403 | `AI_DISABLED` | "A IA está desligada neste órgão." | Ação desabilitada com explicação |
| Limite de uso (US-116) | 422 | `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` | "O limite de uso de IA foi atingido." | Ação desabilitada com explicação |
| Provedor indisponível | 503 | `AI_PROVIDER_UNAVAILABLE` | "A IA está indisponível agora. Tente novamente em instantes." | Desabilita e reabilita após `Retry-After` |
| Geração ativa no alvo | 409 | `AI_GENERATION_IN_PROGRESS` | "Já existe uma geração em andamento." | Abre a geração ativa |
| Antecessor da cadeia ausente | 422 | `AI_PREREQUISITE_MISSING` | "Falta um documento anterior para gerar este." | Lista `meta.missing[]` |
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os dados do pedido." | Marca o campo |
| Documento não editável / fora da etapa | 409 / 422 | `DOCUMENT_NOT_EDITABLE` / `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O documento não pode ser editado agora." | Oculta a ação |
| Geração inexistente ou de outro tenant | 404 | `AI_GENERATION_NOT_FOUND` | "Geração não encontrada." | Fecha o painel |
| Não é o solicitante | 403 | `AI_GENERATION_NOT_OWNED` | "Só quem pediu a geração pode descartá-la." | Oculta "Descartar" |
| Geração não descartável | 409 | `AI_GENERATION_NOT_APPLICABLE` | "Esta geração não pode mais ser descartada." | Atualiza o status |
| Muitas solicitações | 429 | `RATE_LIMITED` | "Muitos pedidos de IA. Aguarde um instante." | Reabilita após `Retry-After` |
| Chave de idempotência reutilizada / em curso | 422 / 409 | `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` | "Esta solicitação já foi enviada." | Gera nova chave / repete a consulta |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível solicitar agora. Tente novamente." | Mantém o formulário |
- `errorCode` da geração (campo, não HTTP): `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `TIMEOUT`, `CONTENT_FILTERED`, `CONTEXT_TOO_LARGE`, `OUTPUT_INVALID`, `CANCELED_BY_POLICY`; no painel, "Não foi possível gerar. Tente novamente" com o motivo resumido.

## Dependências
- **Stories:** US-059 (projeção `AI_CONTENT_GENERATED`), US-065 (estado e tipo editáveis do documento), US-073 (auditoria transacional), US-083 (worker, filas, retries), US-097 (autorização). Habilita: US-116 (portão do órgão), US-117 a US-121 (geradores), US-122 (GroundingGuard e `toConfirm`). Indiretas: US-103, US-111.
- **Decisões/ADRs:** DEC-017, DEC-030, DEC-037, DEC-056, DEC-076, DEC-079, DEC-105, DEC-137, DEC-140, DEC-163, DEC-164, DEC-184; ADR-013 (PEND-21); PEND-22.
- **Configurações:** `AI_PROVIDER`, `AI_MODEL_DRAFT`, `AI_MODEL_SECTION`, `AI_REQUEST_TIMEOUT_MS`, tabela de preços versionada por modelo (plataforma, por ambiente). `AI_TENANT_MAX_MONTHLY_TOKENS`, `AI_TERMS_VERSION` e `ai.*` são da US-116.
- **Lacunas nas fontes canônicas:**
  1. *(Resolvida em queues.md §4 e §4.5.1, 2026-10-16.)* Fila `ai-generation` e tarefas `ai-proposals-expire` e `ai-generations-timeout` da `maintenance`.
  2. *(Resolvida em api/16-ai.md.)* AI-04 descarta (`SUCCEEDED`) ou cancela (`QUEUED`/`RUNNING`); `CANCELED_BY_POLICY` não gera evento nem notificação.
  3. *(Resolvida na DEC-079.)* Disjuntor em chave Redis de plataforma `cf:{env}:ai:circuit`, compartilhada entre API e worker.
  4. *(Resolvida na DEC-079.)* Tabela de preços em arquivo versionado no módulo `ai`; valores preenchidos com a decisão da ADR-013.
  5. O nó `toConfirm` e o GroundingGuard chegam com a US-122 (mesma sprint 16); aqui a conversão TipTap aceita o nó e a cadeia de ganchos de pós-processamento nasce vazia, com stubs nos testes.
  6. *(Implementação, 2026-10-16.)* AI-01 de processo de outro tenant responde 404 `PROCESS_NOT_FOUND` (o guard de `AI_GENERATE` com o processo do caminho — RN-IAM-104), não `NOT_FOUND`. O `ETag` de AI-02 é enviado, mas o `304` por `If-None-Match` fica para quando o pipeline HTTP tratar consultas condicionais. A ligação do job ao worker está pendente (queues.md §4.5.1).

## Impacto técnico
- Padrão B (DEC-163): registro e outbox no commit, enfileiramento após o commit, reconciliador como rede de segurança; claim condicional (`UPDATE … WHERE status = 'QUEUED'`) torna o worker idempotente por `generationId`. Concorrência: 4 por worker e 2 por tenant (semáforo por tenant; excedente é reagendado sem consumir tentativa).
- Portões extensíveis: o `AiTenantGate` (flag, termos, limites e reserva — US-116) é uma porta obrigatória; sem implementação, `AI-01` falha fechada com `AI_DISABLED`. Os testes desta story registram um portão de teste.
- Segurança: dependency-cruiser `ai-read-only` impede importar comandos de outros módulos; o prompt isola dados em delimitadores; nenhum log, métrica ou evento contém texto de entrada ou saída; segredos do provedor só no Secrets Manager (DEC-137).
- Performance: `AI-01` p95 ≤ 1 s (sem chamada ao provedor); rascunho completo p95 ≤ 90 s e ajuste de seção p95 ≤ 20 s — escritos como teste da suíte de performance e medidos no endurecimento.
- Compatibilidade: a porta `AiProvider` não depende de SDK de provedor; o adaptador real (ADR-013) entra sem alterar o pipeline. `contextHash`/`outputHash` usam SHA-256 do JSON canônico (RFC 8785, como em DEC-017).

## Backend
- **Módulo(s):** `ai` (dono de `AiGeneration`); lê por fachadas `ProcessFacade`, `DocumentFacade`/`DocumentTypeFacade`, `DfdFacade`, `EtpFacade`, `PriceResearchFacade`, `RiskFacade`, `TenancyFacade`, `CatalogFacade`; usa `access` (`AuthorizationService`), `audit`, `timeline`, `notification`, `platform` (`OutboxWriter`, `IdempotencyService`, filas).
- **Casos de uso:** `RequestAiGenerationCommand` (`AI-01`), `GetAiGenerationQuery` (`AI-02`), `ListAiGenerationsQuery` (`AI-03`), `DiscardAiGenerationCommand` (`AI-04`); `AiGenerationProcessor` (worker `ai-generation`); `ExpireAiProposalsJob` (`ai-proposals-expire`); script `pnpm ai:eval`.
- **Domínio:** `AiGeneration` (máquina de estados condicional); `AiGenerator` e `AiGeneratorRegistry` por `targetModule`/`kind`; porta `AiProvider` (`generate`) + `FakeAiProvider` (determinístico por fixture; roteirizável para timeout, 429, 5xx, saída inválida e filtro); `ContextSanitizer`; `PromptRegistry`; `OutputConverter` (Zod → TipTap); cadeia `AiOutputPostProcessor`; `AiCircuitBreaker`; `AiPricing`; porta `AiSuggestionSource` (`loadForApply`, `markApplied`) em `apps/api/src/shared/ai/ai-suggestion-source.ts`, implementada pelo `ai` no `onModuleInit` (sem implementação, `DOC-26`/`RSK-11` falham fechado com `DEPENDENCY_UNAVAILABLE`).
- **Integrações internas:** `AuthorizationService.assertCan('AI_GENERATE', { processId })` e permissão do tipo; `ProcessFacade.assertEditable`; `TenantContextService` no job (DEC-164); `AuditService.record`.
- **Transação:** `AI-01`: registro `QUEUED` + auditoria + outbox + idempotência em uma transação; enfileiramento após o commit. Worker: claim (curta) → leitura do contexto (transação do tenant, RLS) → chamada ao provedor **fora** de transação → gravação do resultado + auditoria + outbox + projeção da timeline (curta).

## Frontend
- **Tela(s):** SCR-117 (painel lateral nos editores SCR-007, SCR-008, SCR-011 e SCR-012; `?ia=<generationId>` abre o painel na geração).
- **Componentes:** `AiDraftButton`, `AiAssistantPanel` (estados formulário → gerando → proposta pronta → aplicada/falhou; conteúdo de cada estado vem das US-117 a US-121), `AiGenerationProgress` (continuar editando; "Cancelar" via `AI-04`), `AiHistoryTab` (`AI-03`: quem, quando, tipo, modelo, versão do prompt, tokens, status; acesso ao detalhe por `AI-02`), `AiDisclaimer`; hook de acompanhamento por `AI-02` (a cada 2 s, recuando até 5 s).
- **Estados:** carregando (skeleton do histórico); vazio ("Nenhuma geração neste processo"); erro (falha com motivo e "Tentar novamente"); sucesso (proposta pronta). Ações ocultas sem `AI_GENERATE`.
- **Acessibilidade e responsividade:** mudanças de estado anunciadas por `aria-live`; foco no painel ao abrir; painel em tela cheia abaixo de 768 px; histórico como lista de cartões em 360 px.

## Banco de dados
- **Tabelas:** `ai_generations` (nova, com os campos de entities.md §4.11), `audit_logs`, `outbox_events`, `timeline_entries`, `notifications`.
- **Migrações:** criar os enums `AiGenerationKind`, `AiSectionAction`, `AiGenerationStatus` e a tabela `ai_generations` com `tenant_id`, RLS (DEC-076) e FKs compostas com `tenant_id`; sem `DELETE` concedido ao papel da aplicação (RN-AI-01).
- **Índices/constraints relevantes:** únicos parciais `(tenant_id, process_id, target_module) WHERE kind = 'DRAFT' AND status IN ('QUEUED','RUNNING')` e `(tenant_id, document_id, section_key) WHERE kind = 'SECTION' AND status IN ('QUEUED','RUNNING')` (RN-AI-12); índices `(tenant_id, process_id, created_at DESC)`, `(tenant_id, created_by_id, created_at)`, `(tenant_id, created_at)`, `(tenant_id, status, expires_at)`; checks: `SECTION` ⇒ `action`, `section_key`, `document_id` não nulos; `FAILED` ⇒ `error_code`; `document_id IS NOT NULL OR target_module = 'RISK_MAP'`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-01` | POST | `/processes/{id}/ai-generations` | `{ targetModule, documentId?, kind, action?, sectionKey?, needSummary?, instruction? }` + `Idempotency-Key`; classe de limite "Geração com IA" (10 req/min por usuário + tenant) | `202 { data: AiGeneration, meta: { pollAfterMs: 2000 } }` + `Location: /api/v1/ai-generations/{id}` | 202, 401, 403, 404, 409, 422, 429, 503 |
| `AI-02` | GET | `/ai-generations/{generationId}` | — | `200 { data: { id, processId, documentId, targetModule, kind, action, sectionKey, baseRevision, status, requestedBy: { id, name }, createdAt, startedAt, completedAt, expiresAt, provider, model, promptKey, promptVersion, usage: { inputTokens, outputTokens, totalTokens }, placeholdersCount, groundingReplacements, inputRefs, output, errorCode } }` (sem custo; sem resumo nem instrução) | 200, 401, 403, 404 |
| `AI-03` | GET | `/processes/{id}/ai-generations` | `?documentId&targetModule&kind&status&requestedById&page&pageSize` | `200` lista paginada sem `output` | 200, 401, 403, 404 |
| `AI-04` | POST | `/ai-generations/{generationId}/discard` | `{}` | `200 { data: AiGeneration }` (`DISCARDED` ou `CANCELED`; repetir em estado já descartado/cancelado devolve 200 sem novo efeito) | 200, 401, 403, 404, 409 |

## Logs
- `info` `ai.generation_requested` — `generationId`, `targetModule`, `kind`, `action`, `reservedTokens`.
- `info` `ai.generation_completed` — `generationId`, `model`, `promptKey`, `promptVersion`, `totalTokens`, `costUsd`, `latencyMs`, `attempts`, `groundingReplacements`, `placeholdersCount`.
- `warn` `ai.provider_retry` (tentativa, `errorCode`), `ai.output_repair`, `ai.pricing_missing` (modelo sem preço), `ai.circuit_opened`, `idempotency.store_unavailable`, `ai.enqueue_deferred` (fila indisponível após o commit).
- `error` `ai.generation_failed` — `generationId`, `errorCode`, `attempts`, `correlationId`.
- **Nunca logar:** resumo, instrução, contexto montado, prompt renderizado, texto da saída, chaves e segredos do provedor, dados pessoais. Métricas: `cf_ai_generations_total{target,kind,status}`, `cf_ai_tokens_total{direction,model}`, `cf_ai_cost_usd_total{model}`, `cf_ai_generation_duration_seconds`, `cf_ai_grounding_replacements_total`, `cf_ai_provider_errors_total{code}`; trace com um span por etapa do pipeline, sem conteúdo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.generation_request` | `DATA_CHANGE` | Commit de `AI-01` | `metadata`: `generationId`, `targetModule`, `kind`, `action`, `sectionKey`, `promptKey`, `promptVersion`, `idempotencyKey` |
| `ai.generation_discard` | `DATA_CHANGE` | `AI-04` | `metadata`: `generationId`, `statusBefore`, `statusAfter` |
| `ai.generation_complete` | `SYSTEM` | `SUCCEEDED` | `metadata`: `generationId`, `model`, `promptKey`, `promptVersion`, `inputRefs` (ids/versões/hashes), `contextHash`, `outputHash`, tokens, `costUsd` |
| `ai.generation_fail` | `SYSTEM` | `FAILED` | `metadata`: `generationId`, `errorCode`, `attempts`, tokens |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = AI_GENERATE` |
- Nunca gravar o texto do resumo, da instrução, do contexto nem da saída.

## Testes necessários
- **Unitários:** máquina de estados (RN-AI-03); `ContextSanitizer` (exclusões, redação, sigilo); `PromptRegistry` (teste que falha se o texto do prompt mudar sem nova `promptVersion`); validação Zod e reparo; conversão para TipTap (nós permitidos, `maxChars`); custo e modelo sem preço; disjuntor; `FakeAiProvider` determinístico; regra `ai-read-only` do dependency-cruiser.
- **Integração (Testcontainers PostgreSQL + Redis):** registro antes da chamada; únicos parciais; job idempotente por `jobId`; transação única de resultado + auditoria + outbox + timeline; reconciliador; `ai-proposals-expire`; RLS; teste de contrato do `AiProvider` (reutilizável pelo adaptador real) e da porta `AiSuggestionSource`.
- **API/contrato:** `AI-01` a `AI-04` conforme api.md §3.16; `202` + `Location`; `Idempotent-Replayed`; limite "Geração com IA".
- **RBAC e multi-tenant:** `AI_GENERATE` por perfil e escopo; sem participação nem `CONSULTOR_EXTERNO`; `AI-02`/`AI-03`/`AI-04` e job com tenant incorreto → 404; teste novo na suíte `test/tenant-leak`.
- **Concorrência:** job duplicado; cancelar × concluir; aplicações simultâneas; duas solicitações para o mesmo alvo.
- **E2E (Playwright):** com o `FakeAiProvider` e o gerador de teste: solicitar → gerando → proposta pronta → descartar; aba de histórico; falha e "Tentar novamente".
- **Acessibilidade/performance:** axe sem violações sérias no painel e no histórico; teste de performance de `AI-01` (p95 ≤ 1 s) e do pipeline com fixtures, sem rodar benchmarks no card; harness `pnpm ai:eval` com 10 processos sintéticos, fora do CI, comparando provedores e versões de prompt (validade do schema, `OUTPUT_INVALID`, `groundingReplacements`, `[a confirmar]`, tokens, custo, latência).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI do lote
- [ ] `AI_GENERATE`, POL-18 e POL-02 aplicados na API; ação oculta sem permissão
- [ ] Nenhuma chamada ao provedor dentro de transação ou da requisição (comprovado por teste)
- [ ] Registro anterior à chamada, transições condicionais e idempotência por `generationId` comprovados
- [ ] `ContextSanitizer` e sigilo do orçamento cobertos por testes; logs sem conteúdo
- [ ] Auditoria, eventos, timeline e notificações verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `AI-01` a `AI-04` compatível com api.md; `pnpm ai:eval` documentado
- [ ] Painel acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas (LGPD, subprocessador)
- [ ] Documentação (este card e queues.md quanto às lacunas) atualizada

## Estimativa
**L** — nova entidade com máquina de estados, módulo de nível 5 com regra de dependência própria, porta com adaptador de teste, fila e processador com retentativas/disjuntor, pipeline de seis etapas, sanitização LGPD, quatro endpoints, painel base e harness de avaliação; sem o provedor real, que depende da ADR-013.

## Prioridade
**P1** — fundação de todo o EP-020 (US-116 a US-122) e do diferencial de produto do prd-3; sem ela nenhuma geração pode ser feita com rastreabilidade e minimização de dados.
