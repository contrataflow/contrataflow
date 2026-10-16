---
id: US-120
title: "Gerar o rascunho do TR com IA a partir do ETP"
epic: EP-020
feature: FT-061
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-036, US-038, US-117]
modules: [ai, document, dfd, etp, risk, term, price-research, process, tenancy, access, catalog, timeline, notification, audit, platform]
screens: [SCR-012, SCR-117]
endpoints: [AI-01, AI-02, AI-04, AI-05, DOC-26]
permissions: [AI_GENERATE, TERM_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [AiGenerationRequested, AiGenerationCompleted, AiGenerationFailed, AiContentApplied, DocumentVersionCreated]
---

# US-120 — Gerar o rascunho do TR com IA a partir do ETP

## Título
Gerar o rascunho do TR com IA a partir do ETP

## Descrição
**Como** analista de planejamento ou de compras responsável pelo TR, **quero** pedir à IA um rascunho das seções narrativas do TR a partir do ETP, dos riscos, da pesquisa de preços, dos itens e das condições já cadastradas no TR, **para** ganhar tempo na redação sem que a IA invente prazo, garantia, multa ou valor.

Esta story acrescenta ao fluxo genérico da US-117 (solicitar `AI-01`, acompanhar `AI-02`, descartar `AI-04`, aplicar `DOC-26` no painel `SCR-117`) o gerador e o prompt `draft.tr`: exige o ETP, usa os campos tipados do TR como única fonte de prazos, pagamento e garantias, não cria percentual de multa, segue a RN-AI-36 para o valor estimado e convive com a importação do ETP (US-037). A proposta é sempre revisável e seletiva; nada entra no TR sem a aplicação explícita da pessoa, e o conteúdo aplicado fica "gerado por IA" até a revisão (US-122).

## Contexto
- O TR decorre do ETP (Lei 14.133/2021, art. 6º, XXIII, c/c art. 18) e reúne objeto, fundamentação, solução, requisitos, modelo de execução e de gestão, medição e pagamento, seleção do fornecedor, estimativa do valor e adequação orçamentária. As cláusulas de prazo, pagamento, garantia e sanção são as de maior risco se redigidas sem os dados do processo.
- A IA do MVP 1 só redige (DEC-037, princípio 16): não decide, não preenche campo tipado nem item, e o que faltar sai como `[a confirmar: …]`. O módulo `ai` lê os demais módulos por fachadas de leitura e a aplicação é comando do módulo `document` pela porta `AiSuggestionSource` (DEC-079).
- O TR já tem um caminho sem IA: a importação do ETP (US-037, `TRM-05`/`TRM-06`) copia objeto, justificativa, especificações e valor. A IA cobre o restante e coexiste com ela: seções já preenchidas vêm desmarcadas na proposta (RN-AI-28 da US-117). Condições tipadas e itens são mantidos na US-038 (`TRM-04`, `DOC-07`) e a coerência entre texto e campos é validada na US-039.

## Objetivo
Entregar, em até 90 s (p95, medido no endurecimento), uma proposta das seções narrativas do TR com 100% dos prazos, garantias e valores vindos dos campos tipados ou da pesquisa de preços e todo dado ausente marcado como pendência, de modo que a pessoa revise, complete e conclua o TR.

## Persona
- **Principal:** Planejamento (perfil `PLANEJAMENTO`) e Compras (`COMPRAS`), redatores do TR.
- **Secundárias:** Área requisitante (`REQUISITANTE`), Gestor de contratações (`GESTOR_CONTRATACOES`) e Gestor de contrato (`GESTOR_CONTRATO`), que também recebem `AI_GENERATE`; Administrador do órgão (`SETTINGS_MANAGE`), que liga a IA (US-116). `CONSULTOR_EXTERNO` não gera, mas pode revisar o conteúdo aplicado como participante (US-122).

## Pré-condições
- IA ligada no órgão (`ai.enabled = true`), provedor disponível e limites mensal e diário não atingidos (US-115, US-116).
- ETP não cancelado no processo e TR criado (TRM-02, US-036) em `DRAFT`/`RETURNED`, sob custódia ou participação do usuário (POL-02), com o tipo permitido na etapa.
- Usuário com `AI_GENERATE` e `TERM_UPDATE` cobrindo o processo (POL-18).

## Fluxo principal
1. No editor do TR (`SCR-012`), o usuário com `AI_GENERATE` vê **"Gerar rascunho com IA"** (`AiDraftButton`); o front consulta `AI-05` e desabilita a ação, com explicação, se `canGenerate = false`.
2. O painel `SCR-117` abre no formulário (`AiRequestForm`): mostra as entradas previstas (ETP e sua versão, DFD, riscos e tratamentos, pesquisa de preços, itens), as condições tipadas do TR preenchidas e as ausentes (que virarão `[a confirmar]`), as seções já preenchidas, as orientações opcionais e o consumo estimado (40 mil tokens, RN-AI-18 da US-116). O usuário pode preencher `instruction` e clicar em **"Gerar rascunho"**; o TR não usa resumo da necessidade (ela vem do ETP).
3. O front envia `AI-01` (`targetModule = TERM_OF_REFERENCE`, `documentId` do TR, `kind = DRAFT`) com `Idempotency-Key`. A API valida POL-18, o pré-requisito (RN-AI-43), a geração ativa (RN-AI-12) e os limites; grava `AiGeneration` `QUEUED` com `promptKey = draft.tr`, enfileira após o commit e responde 202 com `Location` e `pollAfterMs`.
4. O painel mostra o progresso (`AiGenerationProgress`); o usuário pode continuar editando o TR (RN-AI-30 da US-117).
5. O worker revalida POL-18 e os pré-requisitos, escolhe as versões de origem, monta o contexto da RN-AI-43 por fachadas de leitura (com `ContextSanitizer`), chama o provedor fora de transação, valida o esquema, aplica o GroundingGuard (RN-AI-54) e grava a proposta `SUCCEEDED` com `inputRefs`, `warnings`, `placeholdersCount` e `groundingReplacements`.
6. O solicitante recebe `AI_GENERATION_READY` e o painel exibe a proposta (`AiProposalSectionList`): `[a confirmar]` por seção, avisos, seções `EMPTY` marcadas e `FILLED` (por exemplo, importadas do ETP) desmarcadas com "substituirá o texto atual".
7. O usuário lê a prévia (`AiSectionDiffView` nas já preenchidas), ajusta a seleção e clica em **"Aplicar seleção"**; o front envia `DOC-26` (`generationId`, `sectionKeys`, `confirmReplaceFilled`) com `If-Match` do TR e `Idempotency-Key`.
8. A API aplica conforme a RN-AI-29 da US-117 (proveniência de IA, `revision + 1`, geração `APPLIED`, auditoria `ai.content_apply`, evento `AiContentApplied`). O editor mostra "Gerado por IA · revisão pendente" e os `[a confirmar]` em destaque; condições tipadas e itens seguem como estavam — para resolver uma pendência de prazo ou garantia, a pessoa preenche o campo tipado (US-038) e o texto.

## Fluxos alternativos
- **FA-01 — Sem ETP:** `AI-01` responde 422 `AI_PREREQUISITE_MISSING` (`missing: ['ETP']`); o painel orienta "Elabore o ETP antes de gerar o TR", com atalho para o ETP.
- **FA-02 — Entradas incompletas:** ETP sem versão aprovada nem finalizada usa o rascunho atual com `USED_DRAFT_INPUTS`; DFD ou riscos ausentes são opcionais e a geração segue com `MISSING_OPTIONAL_INPUT`.
- **FA-03 — TR com seções importadas do ETP:** as seções preenchidas pela importação (US-037) vêm desmarcadas; a pessoa mantém o texto importado, aplica só as `EMPTY` ou confirma a substituição de uma seção (cria `DocumentVersion` antes, RN-AI-28 da US-117). Ordem recomendada: importar do ETP e depois gerar o restante.
- **FA-04 — Condições tipadas ausentes:** campo nulo gera `[a confirmar: …]` na seção correspondente (RN-AI-44); o painel lista as ausentes com atalho para as condições do TR.
- **FA-05 — Reimportar o ETP depois da IA, contexto grande, descarte, expiração:** a nova importação (`TRM-06`) pode substituir seção aplicada pela IA (ver "Lacunas"); contexto excedido gera `CONTEXT_TRUNCATED` ou `FAILED`/`CONTEXT_TOO_LARGE`; descarte, expiração e substituição seguem as RN-AI-31, RN-AI-11 e RN-AI-32.

## Regras de negócio
- **RN-AI-43** — O rascunho do TR exige ETP não cancelado no processo (senão 422 `AI_PREREQUISITE_MISSING`, `missing: ['ETP']`) e o TR já criado (TRM-02) em `DRAFT`/`RETURNED` (senão 409 `DOCUMENT_NOT_EDITABLE`). Entradas (cada uma vira `inputRef`): o ETP, pela precedência da RN-AI-33 (aprovada, finalizada, rascunho com `USED_DRAFT_INPUTS`); o DFD, se houver; riscos e tratamentos do processo, se houver (título, descrição, categoria, fase e descrição dos tratamentos — sem responsáveis, prazos nem pessoas); a pesquisa de preços concluída (valor por item e total, método, nº de cotações — nunca fornecedores); os itens do TR com `specification` e `acceptanceCriteria`; as condições tipadas (`contractDurationMonths`, `executionDeadline` e `executionDeadlineType`, `paymentTermDays`, `productWarrantyMonths`, `contractGuaranteePercent`, `allowsSubcontracting`, `selectionCriterionId`, `awardType`, `deliveryLocation`); `instruction` opcional (≤ 500); o template do TR e os catálogos (rótulos). Verificada em `AI-01` e revalidada no worker.
- **RN-AI-44** — Prazos, vigência, pagamento, garantias e local de entrega só aparecem no texto se estiverem preenchidos nos campos tipados do TR; ausentes, saem como `[a confirmar: …]` (por exemplo, `[a confirmar: prazo de pagamento]`) com a categoria mais próxima (`DEADLINE`, `VALUE`, `DATA`, `DECISION`). A IA nunca preenche campo tipado (`TRM-04`) nem item (`DOC-07`), e a aplicação não os toca.
- **RN-AI-45** — Obrigações e sanções são redigidas a partir do template, da base legal das seções (`legalBasis`) e dos riscos e tratamentos, sem criar percentuais nem valores de multa: todo percentual ou valor que não esteja nas entradas (incluindo o texto do template) vira `[a confirmar]` pelo GroundingGuard (RN-AI-54). Citações legais (lei, artigo, inciso) são preservadas.
- **RN-AI-46** — `ESTIMATED_VALUE` segue a RN-AI-36 da US-118: o valor só vem da pesquisa de preços concluída ou do vínculo do TR (ou do ETP) com ela; sem pesquisa concluída, `[a confirmar: valor estimado da pesquisa de preços]` e aviso `MISSING_PRICE_RESEARCH`; orçamento sigiloso omite os valores e traz `BUDGET_CONFIDENTIAL_VALUES_OMITTED`. A seção tem `render` estruturado: a IA só escreve o texto complementar (RN-AI-37 da US-118).
- **Herdadas, sem repetir:** pipeline, fila, limites e minimização (RN-AI-01..24, US-115 e US-116); aplicação seletiva, substituição de seção preenchida, descarte e acompanhamento (RN-AI-25..32, US-117); precedência de versão e `render` ≠ `TEXT` (RN-AI-33 e RN-AI-37, US-118); `toConfirm`, GroundingGuard, proveniência e revisão (RN-AI-53..58, US-122).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Orientações | `instruction` | texto | Não | ≤ 500 caracteres | em branco |
| Seções a aplicar | `sectionKeys` | lista de checkboxes | Sim (mín. 1) | chaves da proposta; `EMPTY` marcadas, `FILLED` desmarcadas | `EMPTY` marcadas |
| Substituir texto atual | `confirmReplaceFilled` | booleano | Condicional | obrigatório se marcar seção `FILLED`/`NOT_APPLICABLE` (RN-AI-28) | `false` |
| *(sistema)* Alvo | `targetModule`, `kind`, `documentId` | enum, enum, uuid | Sim | `TERM_OF_REFERENCE`, `DRAFT`, documento do TR | fixos |
| *(sistema)* Avisos | `warnings[].code` | enum | — | `USED_DRAFT_INPUTS`, `MISSING_PRICE_RESEARCH`, `BUDGET_CONFIDENTIAL_VALUES_OMITTED`, `MISSING_OPTIONAL_INPUT`, `CONTEXT_TRUNCATED` | gerado |

**Condições tipadas e onde aparecem (RN-AI-44):**
| Campo tipado do TR | Seção que o cita | Se ausente |
|---|---|---|
| `contractDurationMonths`, `executionDeadline` + `executionDeadlineType` | `OBJECT`, `DEADLINES`, `DELIVERY` | `[a confirmar: vigência do contrato]` / `[a confirmar: prazo de execução ou entrega]` |
| `paymentTermDays` | `PAYMENT` | `[a confirmar: prazo de pagamento]` |
| `productWarrantyMonths`, `contractGuaranteePercent` | `GUARANTEES` | `[a confirmar: garantia do objeto]` / `[a confirmar: garantia contratual]` |
| `deliveryLocation`, `allowsSubcontracting` | `DELIVERY`, `CONTRACTOR_OBLIGATIONS` | `[a confirmar: local de entrega]` / `[a confirmar: possibilidade de subcontratação]` |
| `selectionCriterionId`, `awardType` | `SELECTION_CRITERIA` | `[a confirmar: critério de julgamento]` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `instruction` acima de 500 caracteres; `documentId` ausente ou que não é o TR do processo | Front + API (Zod) | "Revise as orientações e abra o TR do processo." | `VALIDATION_ERROR` |
| V-02 | Processo sem ETP não cancelado | API | "Elabore o ETP antes de gerar o TR com IA." | `AI_PREREQUISITE_MISSING` |
| V-03 | TR fora de `DRAFT`/`RETURNED` ou tipo não permitido na etapa | API | "O TR não pode ser editado agora." | `DOCUMENT_NOT_EDITABLE` / `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-04 | Já existe geração ativa do TR no processo | API | "Já há um rascunho do TR sendo gerado." | `AI_GENERATION_IN_PROGRESS` |
| V-05 | IA desligada, provedor indisponível ou limite atingido | API | "A IA não está disponível agora." | `AI_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` |
| V-06 | Seção preenchida marcada sem confirmação | Front + API | "Confirme a substituição do texto atual." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-07 | `sectionKeys` vazio/fora da proposta; geração não `SUCCEEDED`, expirada ou de outro documento | Front + API | "Selecione seções de uma proposta ainda válida." | `VALIDATION_ERROR` / `AI_GENERATION_NOT_APPLICABLE` |
| V-08 | `If-Match` ausente ou divergente na aplicação | API | "O TR foi alterado. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `AI_GENERATE` cobrindo o processo, mais `TERM_UPDATE` (permissão de edição do tipo) para gerar e aplicar; `PROCESS_VIEW` para acompanhar (`AI-02`).
- **Políticas:** POL-18 (gerar com IA: `ai.enabled`, provedor e limites); POL-02 sobre o TR; só o solicitante aplica ou descarta (RN-AI-13 da US-115); DEC-030 — o sigilo vale para o contexto da IA mesmo para quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`.
- **MFA:** não exigido (`AI_GENERATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** botão oculto sem `AI_GENERATE`; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`. Aplicar geração de outro usuário: 403 `AI_GENERATION_NOT_OWNED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiGenerationRequested` | `ai.generation_requested` | Commit de `AI-01` | `targetModule = TERM_OF_REFERENCE`, `kind = DRAFT`; sem conteúdo |
| `AiGenerationCompleted` | `ai.generation_completed` | Worker grava `SUCCEEDED` | modelo, `promptKey = draft.tr`, `promptVersion`, tokens, `sectionsCount`; projeta `AI_CONTENT_GENERATED` |
| `AiGenerationFailed` | `ai.generation_failed` | Worker grava `FAILED` | `errorCode`, `attempts` |
| `AiContentApplied` | `document.ai_content_applied.tr` | Commit de `DOC-26` | `sectionKeys[]`, `replacedFilledSections`; projeta `AI_CONTENT_APPLIED` (sem notificação) |
| `DocumentVersionCreated` | `document.version_created.tr` | Mesmo commit, se substituir seção preenchida | `reason = SYSTEM` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_GENERATION_READY` | solicitante | in-app | geração `SUCCEEDED`; link para o TR com `?ia=<id>` |
| `AI_GENERATION_FAILED` | solicitante | in-app | geração `FAILED` após as tentativas |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerar o rascunho do TR com IA a partir do ETP

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com "ai.enabled" igual a "true"
    And o provedor de IA de teste responde com a fixture "draft.tr"
    And o processo "0012/2026" tem um ETP finalizado e uma pesquisa de preços concluída com valor estimado "125000.00"
    And o processo tem um TR em "DRAFT" com "contractDurationMonths" igual a 12, "paymentTermDays" igual a 30 e "deliveryLocation" vazio
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO", com "AI_GENERATE" e "TERM_UPDATE" no processo, e custódia do TR

  Scenario: [Sucesso] Gerar o rascunho do TR a partir do ETP
    When "Carla" solicitar o rascunho do TR com IA com a chave "K1"
    Then a API deve responder 202 e a geração deve ficar "QUEUED" com "promptKey" igual a "draft.tr"
    And deve gerar a auditoria "ai.generation_request" e o evento "AiGenerationRequested"
    When o worker processar a geração
    Then a geração deve ficar "SUCCEEDED" com "inputRefs" do ETP, da pesquisa de preços, dos itens e das condições do TR
    And deve gerar o evento "AiGenerationCompleted" e a notificação "AI_GENERATION_READY" e o TR não deve ser alterado

  Scenario: [Sucesso] Prazos e pagamento só dos campos tipados e sanções sem percentual inventado
    Given que o provedor de teste escreve "multa de 20% sobre o valor do contrato" em "SANCTIONS"
    When o worker concluir a geração e "Carla" aplicar todas as seções
    Then "DEADLINES" deve citar "12 meses", "PAYMENT" deve citar "30 dias" e "DELIVERY" deve conter "[a confirmar: local de entrega]"
    And o percentual "20%" deve virar "[a confirmar]", "groundingReplacements" deve ser maior que 0 e as citações legais devem ser preservadas
    And as condições tipadas e os itens do TR não devem ser alterados

  Scenario: [Sucesso] Convivência com a importação do ETP
    Given que o TR teve "OBJECT" e "JUSTIFICATION" importadas do ETP e essas seções estão "FILLED"
    When o worker concluir a geração
    Then a proposta deve trazer "OBJECT" e "JUSTIFICATION" desmarcadas com o aviso de substituição
    When "Carla" aplicar as seções "EMPTY" sem "confirmReplaceFilled"
    Then "OBJECT" e "JUSTIFICATION" devem permanecer com o texto importado
    When "Carla" aplicar "OBJECT" com "confirmReplaceFilled" igual a "true"
    Then deve existir uma versão do documento com "reason" igual a "SYSTEM" criada antes da substituição

  Scenario: [Sucesso] Valor estimado, sigilo e entradas opcionais
    Given que o orçamento é sigiloso, o processo não tem riscos registrados e o ETP está em "DRAFT"
    When o worker concluir a geração
    Then a proposta deve trazer "BUDGET_CONFIDENTIAL_VALUES_OMITTED", "MISSING_OPTIONAL_INPUT" e "USED_DRAFT_INPUTS"
    And o contexto enviado ao provedor de teste não deve conter valores monetários do processo
    And sem pesquisa de preços concluída "ESTIMATED_VALUE" deve conter "[a confirmar: valor estimado da pesquisa de preços]" e o aviso "MISSING_PRICE_RESEARCH"

  Scenario: [Validação] Processo sem ETP
    Given que o processo não possui ETP não cancelado
    When "Carla" solicitar o rascunho do TR com IA
    Then a API deve responder 422 com código "AI_PREREQUISITE_MISSING" e "meta.missing" igual a ["ETP"] e nenhuma geração deve ser registrada

  Scenario: [Validação] TR não editável e substituição sem confirmação
    Given que o TR está em "IN_REVIEW"
    When "Carla" solicitar o rascunho do TR com IA
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"
    Given que o TR voltou a "DRAFT" e a seção "OBJECT" está "FILLED"
    When "Carla" aplicar "OBJECT" sem "confirmReplaceFilled"
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" e o TR não deve ser alterado

  Scenario: [Permissão] AI_GENERATE sem TERM_UPDATE, geração de outro usuário ou IA desligada
    Given que "Bruno" possui "AI_GENERATE" mas não possui "TERM_UPDATE" para o processo
    When "Bruno" enviar POST para a solicitação de geração
    Then a API deve responder 403 com código "PERMISSION_DENIED", gerar a auditoria "access.denied" e não chamar o provedor de IA
    When "Paula", com "TERM_UPDATE", tentar aplicar uma geração solicitada por "Carla"
    Then a API deve responder 403 com código "AI_GENERATION_NOT_OWNED"
    Given que a IA foi desligada no órgão
    When "Carla" solicitar o rascunho
    Then a API deve responder 403 com código "AI_DISABLED"

  Scenario: [Tenant incorreto] TR e geração de outro tenant
    Given que existe um TR e uma geração no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", solicitar o rascunho para esse TR ou consultar essa geração
    Then a API deve responder 404 com código "NOT_FOUND" e o contexto de nenhuma geração deve conter dados do tenant "Prefeitura B"

  Scenario: [Duplicidade] Reenvio com a mesma chave e geração ativa
    Given que "Carla" solicitou o rascunho com a chave "K1" e recebeu 202
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 202 com "Idempotent-Replayed: true" e existir uma única geração
    When "Carla" solicitar com a chave "K2" enquanto a geração está ativa
    Then a API deve responder 409 com código "AI_GENERATION_IN_PROGRESS" e "meta.generationId" da geração ativa

  Scenario: [Concorrência] Importação do ETP ou edição entre a proposta e a aplicação
    Given que "Carla" abriu a proposta com o TR na versão 3 e a seção "PAYMENT" "EMPTY"
    When outro usuário aplicar a importação do ETP, criando a versão 4, e "Carla" aplicar com "If-Match: \"3\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    When outro usuário preencher "PAYMENT" e "Carla", com o TR recarregado, aplicar a seção sem "confirmReplaceFilled"
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" e o texto do outro usuário deve ser preservado
    And duas aplicações simultâneas da mesma geração devem resultar em uma sucesso e a outra 409 "AI_GENERATION_NOT_APPLICABLE"

  Scenario: [Falha de banco] Banco indisponível durante a aplicação
    Given que o banco de dados fica indisponível durante a transação de aplicação
    When "Carla" aplicar as seções selecionadas
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma seção deve ser alterada e a geração deve continuar "SUCCEEDED"

  Scenario: [Falha de integração] Provedor de IA limitado, indisponível ou com saída inválida
    Given que o provedor de IA de teste responde 429 na primeira tentativa e sucesso na segunda
    When o worker processar a geração
    Then a geração deve ficar "SUCCEEDED" com "attempts" igual a 2
    Given que o provedor responde 503 nas 3 tentativas
    Then a geração deve ficar "FAILED" com "errorCode" igual a "PROVIDER_UNAVAILABLE", "Carla" deve receber "AI_GENERATION_FAILED" e o TR não deve ser alterado
    Given que o provedor devolve uma saída fora do esquema mesmo após o reparo
    Then a geração deve ficar "FAILED" com "errorCode" igual a "OUTPUT_INVALID"

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" aplicar a proposta com sucesso
    Then as seções devem ser atualizadas e a API deve responder 200
    And o evento "AiContentApplied" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem ETP | 422 | `AI_PREREQUISITE_MISSING` | "Elabore o ETP antes de gerar o TR com IA." | Atalho para o ETP |
| Orientação ou `documentId` inválidos | 422 | `VALIDATION_ERROR` | "Revise as orientações." | Marca o campo |
| TR não editável / etapa | 409 / 422 | `DOCUMENT_NOT_EDITABLE` / `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O TR não pode ser editado agora." | Oculta a ação |
| Geração ativa | 409 | `AI_GENERATION_IN_PROGRESS` | "Já há um rascunho do TR sendo gerado." | Abre a geração ativa |
| IA desligada, provedor indisponível ou limite | 403 / 503 / 422 | `AI_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` | "A IA não está disponível agora." | Ação desabilitada com explicação; respeita `Retry-After` |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerar conteúdo com IA neste TR." | Botão oculto |
| Geração de outro usuário | 403 | `AI_GENERATION_NOT_OWNED` | "Só quem pediu a geração pode aplicá-la." | Painel somente leitura |
| Geração inexistente ou de outro tenant | 404 | `AI_GENERATION_NOT_FOUND` / `NOT_FOUND` | "Geração não encontrada." | Fecha o painel |
| Proposta não aplicável | 409 | `AI_GENERATION_NOT_APPLICABLE` | "Esta proposta não pode mais ser aplicada." | Oferece nova geração |
| Falta confirmar substituição | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | "Confirme a substituição do texto atual." | Destaca a seção |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "O TR foi alterado. Recarregue para continuar." | Oferece "Ver versão atual" |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Mantém a seleção |
| Falha da geração (assíncrona) | — | `errorCode` `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `CONTENT_FILTERED`, `CONTEXT_TOO_LARGE`, `OUTPUT_INVALID`, `CANCELED_BY_POLICY` | "Não foi possível gerar o rascunho." | Estado "falhou" com "Tentar de novo" |

## Dependências
- **Stories:** US-117 (fluxo genérico e painel), US-115 (camada de IA), US-116 (ativação e limites), US-122 (marcações e revisão — habilita concluir o TR), US-036 e US-038 (TR, seções, condições e itens), US-037 (importação do ETP, convivência), US-118 (precedência de versão e valor estimado), US-034 (tratamentos de riscos), US-032 (pesquisa concluída). Habilita: US-121 e a validação do TR (US-039).
- **Decisões/ADRs:** DEC-037, DEC-079, DEC-030, DEC-017, DEC-019, DEC-056, DEC-076, DEC-140, DEC-184; ADR-013 (PEND-21).
- **Configurações:** `ai.enabled`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`; plataforma `AI_PROVIDER` e `AI_MODEL_DRAFT`.
- **Lacunas nas fontes canônicas:**
  1. *(Resolvida em entities.md §5.10, 2026-10-16.)* TRM-06: `REPLACE` leva a proveniência da origem (pendente) ou nenhuma; `APPEND` mantém a do destino e fica pendente se a origem estiver pendente.
  2. *(Resolvida em entities.md §5.10.)* Percentual → `VALUE`.
  3. A RN-AI-46 não lista as origens aceitas para o valor do TR; assume-se `estimatedValueSource = PRICE_RESEARCH`, ou `ETP` quando o ETP está vinculado à pesquisa, e nunca `MANUAL`, `DFD` nem `TERM`. Propor explicitar na RN-AI-46.
  4. A seção `BUDGET_ADEQUACY`, semeada no template do TR (US-036), não consta da RN-AI-43 e não há dado de dotação no MVP 1; sai `[a confirmar: dotação orçamentária]`. Propor declará-la na RN-AI-43.
  5. *(Resolvidas — ver US-118, lacunas 2 e 3.)* Pré-requisito perdido → `CANCELED_BY_POLICY`; lista de entradas montada pelo cliente.

## Impacto técnico
- O gerador monta um conjunto de fatos normalizado (`TermDraftContext`) que alimenta o prompt e o GroundingGuard; prazo, garantia e pagamento nascem dos campos tipados, nunca do modelo.
- O prompt `draft.tr` é versionado em `apps/api/src/modules/ai/prompts/draft.tr/`; mudar o texto exige nova `promptVersion`, e o `pnpm ai:eval` deve incluir TR sem condições preenchidas, sem pesquisa de preços e com seções importadas do ETP. Metas p95 de 90 s (rascunho) e 1 s (`AI-01`) vão para a suíte de performance, medidas no endurecimento.
- Sem migração: reaproveita `AiGeneration`, `Document.draftContent` e `AiSuggestionSource`; o único parcial de geração ativa cobre a RN-AI-12. Regra D9: só fachadas de leitura (`ai-read-only`), nenhuma escrita em `term`, `etp`, `risk` ou `price-research`. A aplicação concorre com autosave e importação do ETP, por isso usa `If-Match` e o estado atual da seção.

## Backend
- **Módulo(s):** `ai` (gerador e geração); lê `document`, `dfd`, `etp`, `risk`, `term`, `price-research`, `process`, `catalog`, `tenancy` e `access` por fachadas; `document` aplica (`DOC-26`); `timeline`, `notification`, `audit` e `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `TermDraftGenerator`, registrado no registro de geradores da US-115 para `TERM_OF_REFERENCE`/`DRAFT` (valida o pré-requisito, monta o contexto, renderiza o prompt, mapeia a saída); `AI-01`, `AI-02`, `AI-04` e `DOC-26` são os comandos genéricos das US-115 e US-117.
- **Domínio e integrações:** resolvedor de versão de origem da US-118 (`DfdSourceResolver`), generalizado para ETP e DFD; `TermDraftContext` (fatos, condições tipadas e `inputRefs`); `AiProvider` (`FakeAiProvider` em dev/test/CI); `AuthorizationService.assertCan('AI_GENERATE', { processId })`; `AiSuggestionSource.loadForApply`/`markApplied`.
- **Transação:** `AI-01` grava geração, auditoria e outbox numa transação e enfileira após o commit; o worker lê em transação do tenant, chama o provedor fora dela e grava a proposta em transação curta; `DOC-26` aplica seções, versão, `markApplied`, auditoria e outbox numa única transação.

## Frontend
- **Tela(s):** `SCR-012` (`/processos/[id]/tr/[termId]`) com o painel `SCR-117` (`?ia=<generationId>`).
- **Componentes:** `AiDraftButton`, `AiAssistantPanel`, `AiRequestForm` (entradas, condições do TR preenchidas e ausentes, consumo estimado), `AiGenerationProgress`, `AiProposalSectionList`, `AiSectionDiffView`, `AiDisclaimer`; após aplicar, `AiGeneratedBadge` e `ToConfirmChip` (US-122).
- **Estados:** carregando a disponibilidade (skeleton); formulário; gerando (cancelável); proposta pronta; aplicada; falhou (`errorCode` traduzido); vazio (sem ETP, com atalho); desabilitado com explicação.
- **Acessibilidade e responsividade:** progresso anunciado por `aria-live`; foco movido ao painel e devolvido ao botão; checkboxes e diff por teclado; selos com texto, não só cor; abaixo de 768 px o painel ocupa a tela e o diff vira abas "Atual" / "Sugerido".

## Banco de dados
- **Tabelas:** `ai_generations` (insert/update de status), `documents` (`draftContent`, `draftRevision`), `document_versions` (insert condicional), `audit_logs`, `outbox_events`, `timeline_entries`, `notifications`; `terms_of_reference` e `document_items` só lidas.
- **Migrações e índices:** nenhuma migração (usa as estruturas das US-115 e US-122); único parcial `(tenant_id, process_id, target_module) WHERE kind = 'DRAFT' AND status IN ('QUEUED','RUNNING')`; RLS por `tenant_id` em todo o contexto.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-01` | POST | `/processes/{id}/ai-generations` | `{ targetModule: 'TERM_OF_REFERENCE', documentId, kind: 'DRAFT', instruction? }` + `Idempotency-Key` | `202 { data: AiGeneration, meta: { pollAfterMs } }` + `Location` | 202, 401, 403, 404, 409, 422, 429, 503 |
| `AI-02` | GET | `/ai-generations/{generationId}` | — | `200 { data: AiGeneration }` (com `output` e `warnings`) | 200, 403, 404 |
| `AI-04` | POST | `/ai-generations/{generationId}/discard` | — | `200` | 200, 403, 404, 409 |
| `AI-05` | GET | `/ai/availability?processId=&documentId=` | — | `200 { enabled, canGenerate, reasons[] }` | 200, 401 |
| `DOC-26` | POST | `/documents/{id}/ai-apply` | `{ generationId, sectionKeys, confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` | `200 { data: { document, appliedSectionKeys, versionCreated } }` | 200, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `ai.generation_requested` e `ai.generation_completed` — `generationId`, `processId`, `targetModule`, `kind`, `promptKey`, `promptVersion`, tokens, `latencyMs`, `placeholdersCount`, `groundingReplacements`; `info` `ai.content_applied` — `generationId`, `sectionKeys`.
- `warn` `ai.prerequisite_missing` (`missing`) e `idempotency.store_unavailable`; `error` `ai.generation_failed` — `errorCode`, `attempts`, `correlationId`.
- **Nunca logar:** orientações, contexto enviado, saída do modelo, texto de seções, valores, percentuais, nomes de pessoas ou fornecedores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.generation_request` | `DATA_CHANGE` | Commit de `AI-01` | `metadata`: `generationId`, `targetModule`, `kind`, `promptKey`, `promptVersion` |
| `ai.generation_complete` / `ai.generation_fail` | `SYSTEM` | Fim da geração | `metadata`: `model`, `inputRefs` (ids, versões, hashes), `contextHash`, `outputHash`, tokens, `costUsd`, `errorCode`; nunca texto |
| `ai.content_apply` / `ai.generation_discard` | `DATA_CHANGE` | `DOC-26` / `AI-04` | `changes`: chaves das seções; `metadata`: `generationId`, `replacedFilledSections`, `idempotencyKey` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = AI_GENERATE` ou `TERM_UPDATE` |

## Testes necessários
- **Unitários:** `TermDraftContext` e `ContextSanitizer` (sem pessoas, fornecedores nem sigilo; riscos sem responsáveis); prompt `draft.tr` com fixtures (campo preenchido × ausente, RN-AI-44); GroundingGuard com percentual de multa, prazo e valor inventados e citação legal preservada (RN-AI-45); origem do valor (RN-AI-46).
- **Integração (Testcontainers PostgreSQL + Redis):** worker ponta a ponta com `FakeAiProvider` (sucesso, 429 com nova tentativa, 503, saída inválida, cancelamento por política); aplicação com `DocumentVersion` condicional sobre seção importada do ETP; outbox e timeline na mesma transação; RLS.
- **API/contrato:** `AI-01`, `AI-02`, `AI-04` e `DOC-26` conforme api.md (`Location`, `Idempotent-Replayed`, `If-Match`); contrato do `FakeAiProvider`.
- **RBAC e multi-tenant:** `AI_GENERATE` e `TERM_UPDATE` por perfil e escopo; sigilo (DEC-030); TR e geração de outro tenant → 404; teste novo na suíte `test/tenant-leak` (contexto sem dados de outro tenant).
- **Concorrência:** duas solicitações simultâneas (202 e 409); duas aplicações da mesma geração; importação do ETP ou edição do TR (412); seção preenchida após a proposta (422).
- **E2E e acessibilidade/performance:** Playwright ETP concluído → importar do ETP → gerar → aplicar só as seções vazias → selos e `[a confirmar]`; axe sem violações sérias; p95 de `AI-01` ≤ 1 s e do rascunho ≤ 90 s na suíte de performance (medidos no endurecimento).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `AI_GENERATE`, `TERM_UPDATE`, POL-18 e POL-02 aplicados na API; ação oculta ou desabilitada na UI
- [ ] Testes comprovam que não há chamada ao provedor dentro de transação, que a IA não altera condições tipadas nem itens (RN-AI-44) e que não cria percentual de multa (RN-AI-45)
- [ ] Auditoria e eventos verificados, sem texto no `metadata`; teste de isolamento na suíte "tenant leak"
- [ ] Prompt `draft.tr` versionado e coberto pelo `pnpm ai:eval`; OpenAPI compatível com api.md
- [ ] Logs sem dados sensíveis; métricas `cf_ai_*` presentes; painel acessível (axe) e responsivo (360 px); revisão de código e de segurança aprovadas; documentação atualizada

## Estimativa
**M** — pipeline, fila, painel e aplicação já existem (US-115, US-117) e a precedência de versão vem da US-118; a complexidade está no gerador `draft.tr`: contexto com ETP, riscos e condições tipadas, cláusulas sem dado inventado e convivência com a importação do ETP.

## Prioridade
**P1** — acelera o TR (art. 6º, XXIII, da Lei 14.133/2021) na cadeia assistida da DEC-037, mas o fluxo manual e a importação do ETP seguem completos sem a IA.
