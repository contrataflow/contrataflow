---
id: US-118
title: "Gerar o rascunho do ETP com IA a partir do DFD"
epic: EP-020
feature: FT-061
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-020, US-022, US-117]
modules: [ai, document, dfd, etp, price-research, process, tenancy, access, catalog, timeline, notification, audit, platform]
screens: [SCR-008, SCR-117]
endpoints: [AI-01, AI-02, AI-04, AI-05, DOC-26]
permissions: [AI_GENERATE, ETP_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [AiGenerationRequested, AiGenerationCompleted, AiGenerationFailed, AiContentApplied, DocumentVersionCreated]
---

# US-118 — Gerar o rascunho do ETP com IA a partir do DFD

## Título
Gerar o rascunho do ETP com IA a partir do DFD

## Descrição
**Como** analista de planejamento responsável pelo ETP, **quero** pedir à IA um rascunho das seções narrativas do ETP a partir do DFD do processo e dos dados já cadastrados (itens, alternativas, pesquisa de preços), **para** reduzir o tempo de redação e manter a coerência DFD → ETP, sem abrir mão de decidir a conclusão, a solução recomendada e o parcelamento.

Esta story acrescenta ao fluxo genérico da US-117 (solicitar `AI-01`, acompanhar `AI-02`, descartar `AI-04`, aplicar `DOC-26` no painel `SCR-117`) o gerador e o prompt `draft.etp`: encadeamento com o DFD (precedência de versão e pré-requisito), entradas do ETP, a regra de que a IA não decide, a origem do valor estimado e o tratamento das seções de renderização estruturada. O resultado é sempre uma proposta; nada entra no ETP sem a aplicação seletiva da pessoa, e o conteúdo aplicado fica "gerado por IA" até ser revisado (US-122).

## Contexto
- O ETP segue o DFD na cadeia DFD → ETP → mapa de riscos → TR (DEC-037). A Lei 14.133/2021, art. 18, §1º, enumera os elementos do ETP (incisos I a XIII) e o §2º exige ao menos os dos incisos I, IV, VI, VIII e XIII, com justificativa para os demais; boa parte do tempo vai em reescrever no ETP o que já está no DFD.
- A IA do MVP 1 só redige (DEC-037, princípio 16): não aprova, não encaminha, não decide e não inventa quantidade, valor, prazo ou dado do órgão — o que faltar sai como `[a confirmar: …]`. O módulo `ai` lê os demais módulos por fachadas de leitura e a aplicação é comando do módulo `document` pela porta `AiSuggestionSource` (DEC-079).
- A criação do ETP com importação do DFD (US-019, `importedFromDfdVersionId`) continua independente: seções já preenchidas por ela vêm desmarcadas na proposta (RN-AI-28 da US-117). O sigilo do orçamento segue a DEC-030 e a RN-AI-05 da US-115.

## Objetivo
Entregar, em até 90 s (p95, medido no endurecimento), uma proposta das seções narrativas do ETP rastreável até as versões de entrada, com 100% das decisões e dados ausentes marcados como pendência, de modo que a pessoa só precise revisar, decidir e completar.

## Persona
- **Principal:** Planejamento (perfil `PLANEJAMENTO`), redator do ETP.
- **Secundárias:** Área requisitante (`REQUISITANTE`), Compras (`COMPRAS`), Gestor de contratações (`GESTOR_CONTRATACOES`) e Gestor de contrato (`GESTOR_CONTRATO`), que também recebem `AI_GENERATE`; Administrador do órgão (`SETTINGS_MANAGE`), que liga a IA (US-116). `CONSULTOR_EXTERNO` não gera, mas pode revisar o conteúdo aplicado como participante (US-122).

## Pré-condições
- IA ligada no órgão (`ai.enabled = true`), provedor disponível e limites mensal e diário não atingidos (US-115, US-116).
- DFD não cancelado no processo e ETP criado (ETP-02, US-019) em `DRAFT`/`RETURNED`, sob custódia ou participação do usuário (POL-02), com o tipo permitido na etapa.
- Usuário com `AI_GENERATE` e `ETP_UPDATE` cobrindo o processo (POL-18).

## Fluxo principal
1. No editor do ETP (`SCR-008`), o usuário com `AI_GENERATE` vê **"Gerar rascunho com IA"** (`AiDraftButton`); o front consulta `AI-05` e desabilita a ação, com explicação, se `canGenerate = false`.
2. O painel `SCR-117` abre no formulário (`AiRequestForm`): lista as entradas previstas (DFD e sua versão, itens, alternativas, pesquisa de preços), as decisões que continuam com a pessoa (conclusão, solução, parcelamento), o resumo opcional, as orientações opcionais e o consumo estimado (40 mil tokens, RN-AI-18 da US-116).
3. O usuário preenche, se quiser, `needSummary` e `instruction` e clica em **"Gerar rascunho"**.
4. O front envia `AI-01` (`targetModule = ETP`, `documentId` do ETP, `kind = DRAFT`) com `Idempotency-Key`. A API valida POL-18, o pré-requisito (RN-AI-33), a geração ativa (RN-AI-12) e os limites; grava `AiGeneration` `QUEUED` com `promptKey = draft.etp`, enfileira após o commit e responde 202 com `Location` e `pollAfterMs`.
5. O painel mostra o progresso (`AiGenerationProgress`); o usuário pode continuar editando o ETP (RN-AI-30 da US-117).
6. O worker revalida POL-18 e os pré-requisitos, escolhe a versão do DFD, monta o contexto da RN-AI-34 por fachadas de leitura (com `ContextSanitizer`), chama o provedor fora de transação, valida o esquema, aplica o GroundingGuard (RN-AI-54) e grava a proposta `SUCCEEDED` com `inputRefs`, `warnings`, `placeholdersCount` e `groundingReplacements`.
7. O solicitante recebe `AI_GENERATION_READY` e o painel exibe a proposta (`AiProposalSectionList`): `[a confirmar]` por seção, avisos (`USED_DRAFT_INPUTS`, `MISSING_PRICE_RESEARCH`, `BUDGET_CONFIDENTIAL_VALUES_OMITTED`), seções `EMPTY` marcadas e `FILLED` desmarcadas com "substituirá o texto atual".
8. O usuário lê a prévia (`AiSectionDiffView` nas já preenchidas), ajusta a seleção e clica em **"Aplicar seleção"**; o front envia `DOC-26` (`generationId`, `sectionKeys`, `confirmReplaceFilled`) com `If-Match` do ETP e `Idempotency-Key`.
9. A API aplica conforme a RN-AI-29 da US-117 (proveniência de IA, `revision + 1`, geração `APPLIED`, auditoria `ai.content_apply`, evento `AiContentApplied`). O editor mostra "Gerado por IA · revisão pendente" e os `[a confirmar]` em destaque; conclusão, solução e parcelamento seguem como estavam, para decisão humana.

## Fluxos alternativos
- **FA-01 — Sem DFD:** `AI-01` responde 422 `AI_PREREQUISITE_MISSING` (`missing: ['DFD']`); o painel orienta "Elabore o DFD antes de gerar o ETP", com atalho para o DFD.
- **FA-02 — DFD em elaboração:** sem versão aprovada nem finalizada, usa-se o rascunho atual do DFD e a proposta traz `USED_DRAFT_INPUTS`.
- **FA-03 — Sem pesquisa de preços concluída ou orçamento sigiloso:** conforme a RN-AI-36 (avisos `MISSING_PRICE_RESEARCH` e `BUDGET_CONFIDENTIAL_VALUES_OMITTED`), qualquer que seja a permissão do solicitante.
- **FA-04 — Substituir seção preenchida:** marcar uma `FILLED` exige `confirmReplaceFilled: true` e cria antes uma `DocumentVersion` (RN-AI-28 da US-117).
- **FA-05 — Contexto grande, descarte, expiração, nova solicitação:** itens ou alternativas em excesso são truncados com `CONTEXT_TRUNCATED` (se ainda excede, `FAILED`/`CONTEXT_TOO_LARGE`); descarte, expiração e substituição seguem as RN-AI-31, RN-AI-11 e RN-AI-32.

## Regras de negócio
- **RN-AI-33** — Encadeamento. O rascunho do ETP exige DFD não cancelado no processo; sem ele, 422 `AI_PREREQUISITE_MISSING` com `missing: ['DFD']`. A entrada usa a versão **aprovada** mais recente do DFD; sem aprovada, a **finalizada**; sem nenhuma, o rascunho atual (`draftContent`), com o aviso `USED_DRAFT_INPUTS`. A versão escolhida vai em `inputRefs` (`kind = DOCUMENT_VERSION` com `versionNumber` e `contentHash`, ou `kind = DOCUMENT_DRAFT` com `revision`). Exige também o ETP já criado (ETP-02) em `DRAFT`/`RETURNED` (senão 409 `DOCUMENT_NOT_EDITABLE`). Verificada em `AI-01` e revalidada no worker.
- **RN-AI-34** — Entradas do ETP (cada uma vira `inputRef`): seções e cabeçalho do DFD; processo (objeto, tipo de contratação, modalidade, situação no PCA, unidade requisitante por nome); itens com quantidades e memórias de cálculo do ETP (`DocumentItem`); alternativas cadastradas (nome, descrição, vantagens e desvantagens, decisão — não o custo informado); pesquisa de preços **concluída** (valor por item e total, método, nº de cotações válidas — nunca fornecedores nem cotações individuais); `Etp.parcelingDecision` e `Etp.conclusion` quando definidos; `needSummary` opcional (0..2.000) e `instruction` opcional (≤ 500); catálogos (rótulos) e o template do ETP (`title`, `helpText`, `legalBasis`, `defaultContent`, `maxChars`). Pessoas, comentários e anexos nunca entram (RN-AI-05).
- **RN-AI-35** — A IA não decide. Com `conclusion = PENDING`, `CONCLUSION` traz `[a confirmar: conclusão sobre a viabilidade]`; sem alternativa `RECOMMENDED`, `RECOMMENDED_SOLUTION` descreve as alternativas e marca `[a confirmar: solução escolhida]`; sem `parcelingDecision`, `PARCELING` marca a decisão como a confirmar (categoria `DECISION`). Com decisão já registrada, o texto a descreve sem alterá-la, e justificativa que não conste das entradas vira `[a confirmar]`. Geração e aplicação nunca criam nem alteram `EtpAlternative`, `recommendedAlternativeId`, `parcelingDecision`, `conclusion` nem outro campo tipado do ETP.
- **RN-AI-36** — Valor estimado. Só aparece o valor da pesquisa de preços concluída ou o `Etp.estimatedTotalValue` com `estimatedValueSource = PRICE_RESEARCH`; valor manual e custo estimado de alternativa nunca valem como estimativa. Sem pesquisa concluída, o texto traz `[a confirmar: valor estimado da pesquisa de preços]` (categoria `VALUE`) e a proposta, o aviso `MISSING_PRICE_RESEARCH`. Com orçamento sigiloso, os valores são omitidos do contexto e do texto e a proposta traz `BUDGET_CONFIDENTIAL_VALUES_OMITTED`; valor que mesmo assim apareça é trocado por `toConfirm` pelo GroundingGuard.
- **RN-AI-37** — Seções com `render` ≠ `TEXT` (itens, alternativas, riscos, valor) recebem só texto complementar, e apenas com `allowNarrative = true`; com `false` a seção fica fora da proposta ("não coberta pela IA"). Tabelas e valores continuam vindo dos dados estruturados, e a aplicação não os toca.
- **Herdadas, sem repetir:** pipeline, fila, limites e minimização (RN-AI-01..24, US-115 e US-116); aplicação seletiva, descarte e acompanhamento (RN-AI-25..32, US-117); `toConfirm`, GroundingGuard, proveniência e revisão (RN-AI-53..58, US-122).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Resumo da necessidade | `needSummary` | texto longo | Não | vazio, ou 20..2.000 caracteres; contador na tela | em branco |
| Orientações | `instruction` | texto | Não | ≤ 500 caracteres | em branco |
| Seções a aplicar | `sectionKeys` | lista de checkboxes | Sim (mín. 1) | chaves da proposta; `EMPTY` marcadas, `FILLED` desmarcadas | `EMPTY` marcadas |
| Substituir texto atual | `confirmReplaceFilled` | booleano | Condicional | obrigatório se marcar seção `FILLED`/`NOT_APPLICABLE` (RN-AI-28) | `false` |
| *(sistema)* Alvo | `targetModule`, `kind`, `documentId` | enum, enum, uuid | Sim | `ETP`, `DRAFT`, `Etp.documentId` | fixos |
| *(sistema)* Avisos | `warnings[].code` | enum | — | `USED_DRAFT_INPUTS`, `MISSING_PRICE_RESEARCH`, `BUDGET_CONFIDENTIAL_VALUES_OMITTED`, `MISSING_OPTIONAL_INPUT`, `CONTEXT_TRUNCATED` | gerado |

**Mapa de seções (padrão semeado; vale o template fixado no documento):**
| Seção do ETP | Fontes principais | Tratamento |
|---|---|---|
| `NEED_DESCRIPTION`, `PROBLEM`, `OBJECTIVE`, `EXPECTED_RESULTS`, `PCA_ALIGNMENT` | seções e cabeçalho do DFD, situação no PCA, resumo | reescreve o que o DFD diz; ausente → `[a confirmar]` |
| `REQUIREMENTS`, `MARKET_SURVEY` | itens, `helpText`; método e nº de cotações da pesquisa | sem requisito técnico nem fornecedor inventado |
| `ALTERNATIVES`, `ESTIMATES`, `RISKS` | alternativas, itens, pesquisa | `render` estruturado: só complemento (RN-AI-37) |
| `RECOMMENDED_SOLUTION`, `PARCELING`, `CONCLUSION` | alternativa `RECOMMENDED`, `parcelingDecision`, `conclusion` | RN-AI-35 |
| `RELATED_CONTRACTS`, `ENVIRONMENTAL_IMPACTS`, `PRIOR_MEASURES` | sem fonte estruturada | só o que vier do resumo ou das orientações; senão `[a confirmar]` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `needSummary` com 1..19 ou mais de 2.000 caracteres | Front + API (Zod) | "Descreva a necessidade com 20 a 2.000 caracteres ou deixe em branco." | `VALIDATION_ERROR` |
| V-02 | `instruction` acima de 500 caracteres | Front + API (Zod) | "As orientações aceitam até 500 caracteres." | `VALIDATION_ERROR` |
| V-03 | Processo sem DFD não cancelado | API | "Elabore o DFD antes de gerar o ETP com IA." | `AI_PREREQUISITE_MISSING` |
| V-04 | ETP fora de `DRAFT`/`RETURNED` ou tipo não permitido na etapa | API | "O ETP não pode ser editado agora." | `DOCUMENT_NOT_EDITABLE` / `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-05 | Já existe geração ativa do ETP no processo | API | "Já há um rascunho do ETP sendo gerado." | `AI_GENERATION_IN_PROGRESS` |
| V-06 | IA desligada, provedor indisponível ou limite atingido | API | "A IA não está disponível agora." | `AI_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` |
| V-07 | Seção preenchida marcada sem confirmação | Front + API | "Confirme a substituição do texto atual." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-08 | `sectionKeys` vazio/fora da proposta; geração não `SUCCEEDED`, expirada ou de outro documento | Front + API | "Selecione seções de uma proposta ainda válida." | `VALIDATION_ERROR` / `AI_GENERATION_NOT_APPLICABLE` |
| V-09 | `If-Match` ausente ou divergente na aplicação | API | "O ETP foi alterado. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `AI_GENERATE` cobrindo o processo, mais `ETP_UPDATE` (permissão de edição do tipo) para gerar e aplicar; `PROCESS_VIEW` para acompanhar (`AI-02`).
- **Políticas:** POL-18 (gerar com IA: `ai.enabled`, provedor e limites); POL-02 sobre o ETP; só o solicitante aplica ou descarta (RN-AI-13 da US-115); DEC-030 — o sigilo vale para o contexto da IA mesmo para quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`.
- **MFA:** não exigido (`AI_GENERATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** botão oculto sem `AI_GENERATE`; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`. Aplicar geração de outro usuário: 403 `AI_GENERATION_NOT_OWNED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiGenerationRequested` | `ai.generation_requested` | Commit de `AI-01` | `targetModule = ETP`, `kind = DRAFT`; sem conteúdo |
| `AiGenerationCompleted` | `ai.generation_completed` | Worker grava `SUCCEEDED` | modelo, `promptKey = draft.etp`, `promptVersion`, tokens, `sectionsCount`; projeta `AI_CONTENT_GENERATED` |
| `AiGenerationFailed` | `ai.generation_failed` | Worker grava `FAILED` | `errorCode`, `attempts` |
| `AiContentApplied` | `document.ai_content_applied.etp` | Commit de `DOC-26` | `sectionKeys[]`, `replacedFilledSections`; projeta `AI_CONTENT_APPLIED` (sem notificação) |
| `DocumentVersionCreated` | `document.version_created.etp` | Mesmo commit, se substituir seção preenchida | `reason = SYSTEM` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_GENERATION_READY` | solicitante | in-app | geração `SUCCEEDED`; link para o ETP com `?ia=<id>` |
| `AI_GENERATION_FAILED` | solicitante | in-app | geração `FAILED` após as tentativas |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerar o rascunho do ETP com IA a partir do DFD

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com "ai.enabled" igual a "true"
    And o provedor de IA de teste responde com a fixture "draft.etp"
    And o processo "0012/2026" tem um DFD aprovado na versão 2 e um ETP em "DRAFT" com as seções "EMPTY"
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO", com "AI_GENERATE" e "ETP_UPDATE" no processo, e custódia do ETP

  Scenario: [Sucesso] Gerar o rascunho a partir do DFD aprovado
    Given que a pesquisa de preços do processo está concluída com valor estimado "125000.00"
    When "Carla" solicitar o rascunho do ETP com IA com a chave "K1"
    Then a API deve responder 202 e a geração deve ficar "QUEUED" com "promptKey" igual a "draft.etp"
    And deve gerar a auditoria "ai.generation_request" e o evento "AiGenerationRequested"
    When o worker processar a geração
    Then a geração deve ficar "SUCCEEDED" com "inputRefs" da versão 2 do DFD, dos itens e da pesquisa de preços
    And deve gerar o evento "AiGenerationCompleted" e a notificação "AI_GENERATION_READY" e o ETP não deve ser alterado

  Scenario: [Sucesso] Aplicar a seleção padrão preservando seção preenchida
    Given que a seção "PROBLEM" está "FILLED" e há uma geração "SUCCEEDED" com 14 seções
    When "Carla" aplicar as seções "EMPTY" sem "confirmReplaceFilled"
    Then as seções aplicadas devem ficar "FILLED" com proveniência de IA pendente de revisão e "PROBLEM" não deve ser alterada
    And a geração deve ficar "APPLIED", sem nova versão do documento, com o evento "AiContentApplied" e a auditoria "ai.content_apply"

  Scenario: [Sucesso] A IA não decide conclusão, solução nem parcelamento
    Given que o ETP tem "conclusion" igual a "PENDING", nenhuma alternativa "RECOMMENDED" e "parcelingDecision" vazio
    When o worker concluir a geração e "Carla" aplicar todas as seções
    Then o texto deve conter "[a confirmar: conclusão sobre a viabilidade]", "[a confirmar: solução escolhida]" e uma decisão de parcelamento a confirmar
    And "conclusion" deve continuar "PENDING", "parcelingDecision" vazio e nenhuma alternativa deve ser alterada

  Scenario: [Sucesso] Valor só da pesquisa de preços, DFD em rascunho e sigilo
    Given que o DFD está em "DRAFT" e o provedor de teste devolve o valor "R$ 99.999,00" que não consta das entradas
    When o worker concluir a geração
    Then a proposta deve trazer "USED_DRAFT_INPUTS" e o valor "R$ 99.999,00" deve virar "[a confirmar]" com "groundingReplacements" maior que 0
    And sem pesquisa de preços concluída o texto deve conter "[a confirmar: valor estimado da pesquisa de preços]" e o aviso "MISSING_PRICE_RESEARCH"
    Given que o orçamento é sigiloso e "Carla" tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    Then o contexto enviado ao provedor não deve conter valores monetários e a proposta deve trazer "BUDGET_CONFIDENTIAL_VALUES_OMITTED"

  Scenario: [Validação] Processo sem DFD
    Given que o processo não possui DFD não cancelado
    When "Carla" solicitar o rascunho do ETP com IA
    Then a API deve responder 422 com código "AI_PREREQUISITE_MISSING" e "meta.missing" igual a ["DFD"]
    And nenhuma geração deve ser registrada

  Scenario: [Validação] Resumo curto e substituição sem confirmação
    When "Carla" solicitar o rascunho com "needSummary" de 10 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "needSummary"
    When "Carla" aplicar a seção "PROBLEM" já "FILLED" sem "confirmReplaceFilled"
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" e o ETP não deve ser alterado

  Scenario: [Permissão] Sem AI_GENERATE, geração de outro usuário ou IA desligada
    Given que "Bruno" não possui "AI_GENERATE" para o processo
    When "Bruno" enviar POST para a solicitação de geração
    Then a API deve responder 403 com código "PERMISSION_DENIED", gerar a auditoria "access.denied" e não chamar o provedor de IA
    When "Paula", com "ETP_UPDATE", tentar aplicar uma geração solicitada por "Carla"
    Then a API deve responder 403 com código "AI_GENERATION_NOT_OWNED"
    Given que a IA foi desligada no órgão
    When "Carla" solicitar o rascunho
    Then a API deve responder 403 com código "AI_DISABLED"

  Scenario: [Tenant incorreto] ETP e geração de outro tenant
    Given que existe um ETP e uma geração no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", solicitar o rascunho para esse ETP ou consultar essa geração
    Then a API deve responder 404 com código "NOT_FOUND"
    And o contexto de nenhuma geração deve conter dados do tenant "Prefeitura B"

  Scenario: [Duplicidade] Reenvio com a mesma chave e geração ativa
    Given que "Carla" solicitou o rascunho com a chave "K1" e recebeu 202
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 202 com "Idempotent-Replayed: true" e existir uma única geração
    When "Carla" solicitar com a chave "K2" enquanto a geração está ativa
    Then a API deve responder 409 com código "AI_GENERATION_IN_PROGRESS" e "meta.generationId" da geração ativa

  Scenario: [Concorrência] ETP ou seção alterados entre a proposta e a aplicação
    Given que "Carla" abriu a proposta com o ETP na versão 3 e a seção "OBJECTIVE" "EMPTY"
    When outro usuário preencher "OBJECTIVE", criando a versão 4, e "Carla" aplicar com "If-Match: \"3\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    When "Carla" recarregar e aplicar "OBJECTIVE" sem "confirmReplaceFilled"
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" e o texto do outro usuário deve ser preservado
    And duas aplicações simultâneas da mesma geração devem resultar em uma sucesso e a outra 409 "AI_GENERATION_NOT_APPLICABLE"

  Scenario: [Falha de banco] Banco indisponível durante a aplicação
    Given que o banco de dados fica indisponível durante a transação de aplicação
    When "Carla" aplicar as seções selecionadas
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma seção deve ser alterada e a geração deve continuar "SUCCEEDED"

  Scenario: [Falha de integração] Provedor de IA com timeout ou saída inválida
    Given que o provedor de IA de teste excede o tempo limite nas 3 tentativas
    When o worker processar a geração
    Then a geração deve ficar "FAILED" com "errorCode" igual a "TIMEOUT", "Carla" deve receber "AI_GENERATION_FAILED" e o ETP não deve ser alterado
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
| Sem DFD | 422 | `AI_PREREQUISITE_MISSING` | "Elabore o DFD antes de gerar o ETP com IA." | Atalho para o DFD |
| Resumo ou orientação inválidos | 422 | `VALIDATION_ERROR` | "Revise o resumo e as orientações." | Marca o campo |
| ETP não editável / etapa | 409 / 422 | `DOCUMENT_NOT_EDITABLE` / `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O ETP não pode ser editado agora." | Oculta a ação |
| Geração ativa | 409 | `AI_GENERATION_IN_PROGRESS` | "Já há um rascunho do ETP sendo gerado." | Abre a geração ativa |
| IA desligada, provedor indisponível ou limite | 403 / 503 / 422 | `AI_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` | "A IA não está disponível agora." | Ação desabilitada com explicação; respeita `Retry-After` |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerar conteúdo com IA neste ETP." | Botão oculto |
| Geração de outro usuário | 403 | `AI_GENERATION_NOT_OWNED` | "Só quem pediu a geração pode aplicá-la." | Painel somente leitura |
| Geração inexistente ou de outro tenant | 404 | `AI_GENERATION_NOT_FOUND` / `NOT_FOUND` | "Geração não encontrada." | Fecha o painel |
| Proposta não aplicável | 409 | `AI_GENERATION_NOT_APPLICABLE` | "Esta proposta não pode mais ser aplicada." | Oferece nova geração |
| Falta confirmar substituição | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | "Confirme a substituição do texto atual." | Destaca a seção |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "O ETP foi alterado. Recarregue para continuar." | Oferece "Ver versão atual" |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Mantém a seleção |
| Falha da geração (assíncrona) | — | `errorCode` `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `CONTENT_FILTERED`, `CONTEXT_TOO_LARGE`, `OUTPUT_INVALID`, `CANCELED_BY_POLICY` | "Não foi possível gerar o rascunho." | Estado "falhou" com "Tentar de novo" |

## Dependências
- **Stories:** US-117 (fluxo genérico e painel), US-115 (camada de IA), US-116 (ativação e limites), US-122 (marcações e revisão — habilita concluir o ETP), US-019, US-020 e US-021 (ETP, seções e alternativas), US-022 e US-032 (valor estimado e pesquisa concluída), US-016 (DFD finalizado/aprovado). Habilita: US-119, US-120 e US-121.
- **Decisões/ADRs:** DEC-037, DEC-079, DEC-030, DEC-017, DEC-019, DEC-056, DEC-076, DEC-140, DEC-184; ADR-013 (PEND-21).
- **Configurações:** `ai.enabled`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`; plataforma `AI_PROVIDER` e `AI_MODEL_DRAFT`.
- **Lacunas nas fontes canônicas:**
  1. *(Resolvida em entities.md §4.11 e api/16-ai.md, 2026-10-16.)* `needSummary` é opcional fora do DFD; quando informado, 20..2.000 caracteres.
  2. *(Decidida, sem novo endpoint.)* O cliente monta a lista de entradas e avisos com os dados já carregados (DFD-01, ETP-05, PRS-01); a API valida os pré-requisitos no AI-01 (`AI_PREREQUISITE_MISSING`) e devolve os avisos definitivos em `output.warnings`.
  3. *(Resolvida em entities.md §4.11.)* Pré-requisito perdido entre o pedido e a execução → `CANCELED` com `CANCELED_BY_POLICY`.
  4. entities.md não define como localizar a "versão aprovada mais recente" nem a "finalizada" de um documento; assume-se a última `DocumentVersion` gerada com o documento em `APPROVED`/`FINALIZED`. Propor uma consulta na fachada de leitura do `document`.

## Impacto técnico
- O gerador monta um conjunto de fatos normalizado (`EtpDraftContext`) que também alimenta o GroundingGuard: "valor que não está nas entradas" é decidido pelo mesmo conjunto enviado ao provedor.
- O prompt `draft.etp` é versionado em `apps/api/src/modules/ai/prompts/draft.etp/`; mudar o texto exige nova `promptVersion`, e o `pnpm ai:eval` deve incluir DFD só em rascunho, ETP sem pesquisa de preços e orçamento sigiloso.
- Sem migração: reaproveita `AiGeneration`, `Document.draftContent` e `AiSuggestionSource`; o único parcial de geração ativa cobre a RN-AI-12. Regra D9: só fachadas de leitura (`ai-read-only`), nenhuma escrita em `etp`, `price-research` ou `dfd`.

## Backend
- **Módulo(s):** `ai` (gerador e geração); lê `document`, `dfd`, `etp`, `price-research`, `process`, `catalog`, `tenancy` e `access` por fachadas; `document` aplica (`DOC-26`); `timeline`, `notification`, `audit` e `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `EtpDraftGenerator`, registrado no registro de geradores da US-115 para `ETP`/`DRAFT` (valida o pré-requisito, monta o contexto, renderiza o prompt, mapeia a saída); `AI-01`, `AI-02`, `AI-04` e `DOC-26` são os comandos genéricos das US-115 e US-117.
- **Domínio e integrações:** `DfdSourceResolver` (aprovada > finalizada > rascunho, com `USED_DRAFT_INPUTS`); `EtpDraftContext` (fatos e `inputRefs`); `AiProvider` (`FakeAiProvider` em dev/test/CI); `AuthorizationService.assertCan('AI_GENERATE', { processId })`; `AiSuggestionSource.loadForApply`/`markApplied`.
- **Transação:** `AI-01` grava geração, auditoria e outbox numa transação e enfileira após o commit; o worker lê em transação do tenant, chama o provedor fora dela e grava a proposta em transação curta; `DOC-26` aplica seções, versão, `markApplied`, auditoria e outbox numa única transação.

## Frontend
- **Tela(s):** `SCR-008` (`/processos/[id]/etp/[etpId]`) com o painel `SCR-117` (`?ia=<generationId>`).
- **Componentes:** `AiDraftButton`, `AiAssistantPanel`, `AiRequestForm` (entradas, decisões que ficam com a pessoa, consumo estimado), `AiGenerationProgress`, `AiProposalSectionList`, `AiSectionDiffView`, `AiDisclaimer`; após aplicar, `AiGeneratedBadge` e `ToConfirmChip` (US-122).
- **Estados:** carregando a disponibilidade (skeleton); formulário; gerando (cancelável); proposta pronta; aplicada; falhou (`errorCode` traduzido); vazio (sem DFD, com atalho); desabilitado com explicação.
- **Acessibilidade e responsividade:** progresso anunciado por `aria-live`; foco movido ao painel e devolvido ao botão; checkboxes e diff por teclado; selos com texto, não só cor; abaixo de 768 px o painel ocupa a tela e o diff vira abas "Atual" / "Sugerido".

## Banco de dados
- **Tabelas:** `ai_generations` (insert/update de status), `documents` (`draftContent`, `draftRevision`), `document_versions` (insert condicional), `audit_logs`, `outbox_events`, `timeline_entries`, `notifications`.
- **Migrações e índices:** nenhuma migração (usa as estruturas das US-115 e US-122); único parcial `(tenant_id, process_id, target_module) WHERE kind = 'DRAFT' AND status IN ('QUEUED','RUNNING')`; `(tenant_id, process_id, created_at DESC)`; RLS por `tenant_id` em todo o contexto.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-01` | POST | `/processes/{id}/ai-generations` | `{ targetModule: 'ETP', documentId, kind: 'DRAFT', needSummary?, instruction? }` + `Idempotency-Key` | `202 { data: AiGeneration, meta: { pollAfterMs } }` + `Location` | 202, 401, 403, 404, 409, 422, 429, 503 |
| `AI-02` | GET | `/ai-generations/{generationId}` | — | `200 { data: AiGeneration }` (com `output` e `warnings`) | 200, 403, 404 |
| `AI-04` | POST | `/ai-generations/{generationId}/discard` | — | `200` | 200, 403, 404, 409 |
| `AI-05` | GET | `/ai/availability?processId=&documentId=` | — | `200 { enabled, canGenerate, reasons[] }` | 200, 401 |
| `DOC-26` | POST | `/documents/{id}/ai-apply` | `{ generationId, sectionKeys, confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` | `200 { data: { document, appliedSectionKeys, versionCreated } }` | 200, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `ai.generation_requested` e `ai.generation_completed` — `generationId`, `processId`, `targetModule`, `kind`, `promptKey`, `promptVersion`, tokens, `latencyMs`, `placeholdersCount`, `groundingReplacements`.
- `warn` `ai.prerequisite_missing` (`missing`) e `idempotency.store_unavailable`; `error` `ai.generation_failed` — `errorCode`, `attempts`, `correlationId`.
- **Nunca logar:** resumo, orientações, contexto enviado, saída do modelo, texto de seções, valores, nomes de pessoas ou fornecedores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.generation_request` | `DATA_CHANGE` | Commit de `AI-01` | `metadata`: `generationId`, `targetModule`, `kind`, `promptKey`, `promptVersion` |
| `ai.generation_complete` / `ai.generation_fail` | `SYSTEM` | Fim da geração | `metadata`: `model`, `inputRefs` (ids, versões, hashes), `contextHash`, `outputHash`, tokens, `costUsd`, `errorCode`; nunca texto |
| `ai.content_apply` / `ai.generation_discard` | `DATA_CHANGE` | `DOC-26` / `AI-04` | `changes`: chaves das seções; `metadata`: `generationId`, `replacedFilledSections`, `idempotencyKey` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = AI_GENERATE` ou `ETP_UPDATE` |

## Testes necessários
- **Unitários:** `DfdSourceResolver` (aprovada, finalizada, rascunho); `EtpDraftContext` e `ContextSanitizer` (sem pessoas, fornecedores nem sigilo); prompt `draft.etp` com fixtures (RN-AI-35); GroundingGuard com valor, prazo e percentual inventados; `render` ≠ `TEXT` (RN-AI-37).
- **Integração (Testcontainers PostgreSQL + Redis):** worker ponta a ponta com `FakeAiProvider` (sucesso, timeout, saída inválida, cancelamento por política); aplicação com `DocumentVersion` condicional; outbox e timeline na mesma transação; RLS.
- **API/contrato:** `AI-01`, `AI-02`, `AI-04` e `DOC-26` conforme api.md (`Location`, `Idempotent-Replayed`, `If-Match`); contrato do `FakeAiProvider`.
- **RBAC e multi-tenant:** `AI_GENERATE` e `ETP_UPDATE` por perfil e escopo; sigilo (DEC-030); ETP e geração de outro tenant → 404; teste novo na suíte `test/tenant-leak` (contexto sem dados de outro tenant).
- **Concorrência:** duas solicitações simultâneas (202 e 409); duas aplicações da mesma geração; ETP editado (412); seção preenchida após a proposta (422).
- **E2E e acessibilidade/performance:** Playwright DFD aprovado → gerar → aplicação parcial → selos e `[a confirmar]` no editor; axe sem violações sérias; p95 de `AI-01` ≤ 1 s e do rascunho ≤ 90 s na suíte de performance (medidos no endurecimento).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `AI_GENERATE`, `ETP_UPDATE`, POL-18 e POL-02 aplicados na API; ação oculta ou desabilitada na UI
- [ ] Testes comprovam que não há chamada ao provedor dentro de transação e que a IA não altera campos tipados nem alternativas do ETP (RN-AI-35)
- [ ] Auditoria e eventos verificados, sem texto no `metadata`; teste de isolamento na suíte "tenant leak"
- [ ] Prompt `draft.etp` versionado e coberto pelo `pnpm ai:eval`; OpenAPI compatível com api.md
- [ ] Logs sem dados sensíveis; métricas `cf_ai_*` presentes; painel acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas; documentação (este card e as lacunas) atualizada

## Estimativa
**M** — pipeline, fila, painel e aplicação já existem (US-115, US-117); a complexidade está no gerador `draft.etp`: precedência de versão do DFD, contexto do ETP com sigilo, regras de não decisão e tratamento das seções estruturadas.

## Prioridade
**P1** — acelera o ETP (art. 18 da Lei 14.133/2021) na cadeia assistida da DEC-037, mas o fluxo manual segue completo sem a IA.
