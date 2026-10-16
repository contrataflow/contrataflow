---
id: US-119
title: "Gerar a proposta do mapa de riscos com IA"
epic: EP-020
feature: FT-061
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-034, US-035, US-117]
modules: [ai, risk, document, dfd, etp, term, process, catalog, access, timeline, audit, platform]
screens: [SCR-011, SCR-117]
endpoints: [AI-01, AI-02, AI-04, AI-05, RSK-01, RSK-11, RSK-12, DOC-26, DOC-08]
permissions: [AI_GENERATE, RISK_MANAGE, PROCESS_VIEW]
events: [AiGenerationRequested, AiGenerationCompleted, AiGenerationFailed, RiskCreated, AiContentApplied, AiContentReviewed, DocumentVersionCreated]
---

# US-119 — Gerar a proposta do mapa de riscos com IA

## Título
Gerar a proposta do mapa de riscos com IA

## Descrição
**Como** analista de planejamento, **quero** pedir à IA uma proposta de riscos e de tratamentos para o processo, **para** partir de uma lista estruturada em vez de uma tela em branco, escolhendo o que entra no mapa e revisando cada risco antes de concluir.

A IA lê o DFD (e, se existirem, o ETP, o TR e os riscos já registrados) e devolve, de forma assíncrona, até 15 riscos com causa, consequência, probabilidade e impacto sugeridos e de 1 a 3 tratamentos cada. Nada é gravado até a pessoa aplicar a seleção (`RSK-11`); os riscos criados ficam marcados "gerado por IA" até serem revisados (`RSK-12`) e bloqueiam a conclusão do `RISK_MAP` enquanto isso não ocorrer.

## Contexto
- A análise de riscos faz parte da fase preparatória (Lei 14.133/2021, art. 18, X) e alimenta a matriz de riscos do TR; hoje o planejamento parte do zero e tende a repetir listas genéricas de outros processos.
- DEC-037 (prd-3): rascunho assistido em cadeia DFD → ETP → mapa de riscos → TR; princípio 16: a IA nunca decide, aprova nem encaminha. DEC-079: módulo `ai` só lê (fachadas); a criação de `Risk`/`RiskTreatment` é comando do módulo `risk` pela porta `AiSuggestionSource`.
- O `RISK_MAP` é documento `STRUCTURED` singleton (DEC-017, RN-RISK-19/20): o conteúdo tipado é a lista de riscos e tratamentos; só `INTRODUCTION`, `METHODOLOGY` e `NOTES` são narrativos.
- Segue o padrão "prévia + aplicação seletiva" de US-037; o fluxo genérico (solicitar, acompanhar, aplicar, descartar) é o de US-117 (RN-AI-25..32) sobre a camada de US-115 (RN-AI-01..15) e as marcações de US-122 (RN-AI-53..58).

## Objetivo
Reduzir o tempo de montagem do mapa de riscos mantendo controle humano: 100% dos riscos criados por IA exigem revisão explícita e nenhuma proposta vira risco, tratamento, responsável ou prazo sem ação do usuário.

## Persona
- **Principal:** Planejamento (perfil `PLANEJAMENTO`), responsável pelo mapa de riscos.
- **Secundárias:** Compras (`COMPRAS`), Gestor de contratações (`GESTOR_CONTRATACOES`), Gestor de contrato (`GESTOR_CONTRATO`), Requisitante (`REQUISITANTE`) quando custodia o processo; `CONSULTOR_EXTERNO` não vê a ação (sem `AI_GENERATE`).

## Pré-condições
- `ai.enabled = true` no órgão e provedor disponível (US-116, `AI_PROVIDER` ≠ `none`).
- Usuário com `AI_GENERATE` e `RISK_MANAGE` cobrindo o processo, com custódia ou participação (POL-02).
- Processo com DFD não cancelado (RN-AI-38); ETP e TR são opcionais.
- Se o `RISK_MAP` já foi emitido, está em `DRAFT`/`RETURNED`; sem documento, o processo está em etapa editável.

## Fluxo principal
1. Na tela de riscos (SCR-011), o usuário aciona **"Gerar rascunho com IA"** (`AiDraftButton`); o front consulta `AI-05` e abre o painel SCR-117.
2. O `AiRequestForm` mostra orientações opcionais (`needSummary`), as entradas que serão usadas (DFD, ETP/TR se houver, riscos já registrados, categorias e escala), os avisos e o consumo estimado (25 mil tokens).
3. O usuário clica em **"Gerar proposta"**; o front envia `AI-01` (`targetModule = RISK_MAP`, `kind = DRAFT`) com `Idempotency-Key`.
4. A API valida POL-18, o pré-requisito, os limites e a unicidade (RN-AI-12), grava a `AiGeneration` em `QUEUED` com reserva de tokens, audita `ai.generation_request`, enfileira após o commit e responde 202 com `Location` e `pollAfterMs`.
5. O `AiGenerationProgress` consulta `AI-02` (RN-AI-30); o usuário pode continuar editando os riscos.
6. O worker (US-115) monta o contexto, chama o provedor, valida a saída, aplica o GroundingGuard, grava `SUCCEEDED` e notifica `AI_GENERATION_READY`.
7. O painel exibe a `AiRiskProposalList`: um cartão por risco (título, categoria, fase, P×I com nível calculado pela escala vigente, causa, consequência, justificativa) com os tratamentos e as seções narrativas (se o documento existir) em `AiProposalSectionList`.
8. O usuário marca riscos e tratamentos e aciona **"Aplicar selecionados"**; o front envia `RSK-11` (e `DOC-26` para as seções marcadas) com `Idempotency-Key`.
9. A API cria os riscos e tratamentos em uma transação, audita, publica os eventos e responde 201; a lista de riscos exibe `AiGeneratedBadge` em cada risco criado.
10. O usuário ajusta P×I e textos, resolve cada "[a confirmar]" e aciona **"Marcar como revisado"** (`RSK-12`), por risco ou em lote (`ReviewAllDialog`, reaproveitado de US-122). Ao emitir ou finalizar o mapa, `DOC-08` só libera quando não restam `RISK_AI_REVIEW_PENDING` nem `RISK_PLACEHOLDER_PENDING`.

## Fluxos alternativos
- **FA-01 — Sem DFD:** `AI-01` responde 422 `AI_PREREQUISITE_MISSING` (`missing: ['DFD']`); o painel orienta criar o DFD e oferece o link.
- **FA-02 — Risco semelhante a um existente:** o cartão com `similarToRiskId` vem desmarcado, com o selo "Parecido com R03" e link para o risco existente.
- **FA-03 — Mapa ainda não emitido:** a proposta traz só riscos (`documentId` nulo); as seções narrativas não aparecem (RN-AI-41).
- **FA-04 — Mapa emitido em `DRAFT`/`RETURNED`:** as seções vazias vêm marcadas; as preenchidas vêm desmarcadas com o aviso "substituirá o texto atual" (RN-AI-28).
- **FA-05 — Mapa bloqueado:** com `RISK_MAP` em `FINALIZED`/`IN_REVIEW`/`APPROVED`, `AI-05` informa `DOCUMENT_NOT_EDITABLE` e a ação fica desabilitada; se o bloqueio ocorrer antes de aplicar, `RSK-11` responde 409.
- **FA-06 — Risco alto sem tratamento:** ao aplicar risco `HIGH`/`EXTREME` sem tratamento marcado, o painel avisa que a conclusão do mapa exigirá um tratamento (RN-RISK-21).

## Regras de negócio
- Fluxo genérico e governança: RN-AI-01..15 (US-115), RN-AI-16..24 (US-116), RN-AI-25..32 (US-117), RN-AI-53..58 (US-122); abaixo, só o que é próprio do mapa de riscos.
- **RN-AI-38** — A proposta exige DFD não cancelado (`AI_PREREQUISITE_MISSING`, `missing: ['DFD']`); ETP e TR são opcionais e entram com a precedência de versão da RN-AI-33 (aprovada, finalizada, rascunho com aviso `USED_DRAFT_INPUTS`); ausentes geram `MISSING_OPTIONAL_INPUT`. Alvo = processo (`targetModule = RISK_MAP`; `documentId` = `RISK_MAP` se já emitido). Riscos já registrados (título, categoria, fase, nível e tratamentos) entram no contexto para evitar duplicidade. Valores monetários, responsáveis e nomes não entram no contexto (RN-AI-05); `needSummary` é opcional (0..2.000).
- **RN-AI-39** — A saída traz até 15 riscos com título, descrição, `categoryCode` (código ativo de `RISK_CATEGORY`; desconhecido → `OUTRO`), `phase` (`RiskPhase`), causa, consequência, `probability` e `impact` (1..`risk.scale.max`), `rationale` curta e de 1 a 3 tratamentos (`PREVENTIVE`/`CONTINGENCY`, descrição); nunca responsável, prazo, data ou valor; `similarToRiskId` quando parecido com risco existente. Excesso de riscos, risco sem tratamento ou valor fora da escala é saída inválida (RN-AI-07).
- **RN-AI-40** — `RSK-11` aplica por risco e por tratamento: cria `Risk` (código sequencial, `score`/`level` pelas faixas vigentes, `scaleSnapshot`, `aiGenerationId`, sem responsável) e `RiskTreatment` (`aiGenerationId`, `status = PLANNED`, `dueDate` e responsáveis nulos); um `RiskCreated` por risco, um `RiskTreatmentChanged` (`CREATED`) por tratamento e um `AiContentApplied`; auditoria `risk.create` por risco, `risk.treatment_create` por tratamento e `ai.content_apply`. Exige `RISK_MANAGE` + POL-02, geração `SUCCEEDED`, não expirada, do próprio usuário e do mesmo processo; bloqueada com `RISK_MAP` em `FINALIZED`/`IN_REVIEW`/`APPROVED`. Cada parte da proposta (riscos por `RSK-11`, seções por `DOC-26`) é aplicada uma única vez; a geração vai a `APPLIED` na primeira aplicação e aceita a outra parte enquanto não expirar (`appliedTargets` acumula — entities.md §4.11).
- **RN-AI-41** — `INTRODUCTION`, `METHODOLOGY` e `NOTES` entram na proposta só se o `RISK_MAP` existir; são aplicadas por `DOC-26` (RN-AI-28/29), com proveniência `ai` por seção e revisão por `DOC-27` (US-122).
- **RN-AI-42** — O risco criado pela IA fica "gerado por IA" até `RSK-12` (`aiReviewedAt`/`aiReviewedById`, `AiContentReviewed`, auditoria `ai.content_review`); editar P×I ou textos não revisa. Os tratamentos são revisados com o risco. A validação do `RISK_MAP` (US-035, RN-RISK-21) acrescenta `RISK_AI_REVIEW_PENDING` (risco com `aiGenerationId` e sem `aiReviewedAt`) e `RISK_PLACEHOLDER_PENDING` (texto do risco ou do tratamento com "[a confirmar"), ambos bloqueantes (`DOCUMENT_INCOMPLETE`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Orientações | `needSummary` | texto longo | Não | 0..2.000 caracteres, contador; sem dado pessoal | vazio |
| Alvo / tipo | `targetModule` / `kind` | enum | Sim | fixos `RISK_MAP` / `DRAFT`; sem `action`, `sectionKey` nem `instruction` | derivados de SCR-011 |
| Documento | `documentId` | uuid | Não | `RISK_MAP` do mesmo processo, se emitido | preenchido pela UI |
| Riscos a criar | `risks[].proposalKey` | checkboxes | Sim (mín. 1) | chave existente em `output.risks`; proposta somente leitura (ajustes após aplicar, `RSK-04`); `similarToRiskId` desmarcado | demais marcados |
| Tratamentos | `risks[].treatments` | `proposalKey[]` | Não | só do próprio risco; pode ser vazio | todos marcados |
| Seções narrativas | `sectionKeys` (`DOC-26`) | checkboxes | Não | só `INTRODUCTION`, `METHODOLOGY`, `NOTES` | `EMPTY` marcadas |
| Riscos a revisar | `riskIds` + `expectedVersions` | `uuid[]` + mapa | Sim (mín. 1) | riscos do processo com `aiGenerationId` | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `needSummary` acima de 2.000 caracteres ou campos de `SECTION` enviados | Front + API (Zod) | "Resuma em até 2.000 caracteres." | `VALIDATION_ERROR` |
| V-02 | Processo sem DFD não cancelado | API | "Crie o DFD antes de gerar a proposta de riscos." | `AI_PREREQUISITE_MISSING` |
| V-03 | Já existe geração ativa para o processo | API | "Já há uma proposta sendo gerada." | `AI_GENERATION_IN_PROGRESS` |
| V-04 | IA desligada, provedor indisponível ou limites do órgão/usuário | API | conforme US-115/US-116 | `AI_DISABLED`, `AI_PROVIDER_UNAVAILABLE`, `AI_USAGE_LIMIT_REACHED`, `AI_USER_DAILY_LIMIT_REACHED` |
| V-05 | `RISK_MAP` fora de `DRAFT`/`RETURNED` | API | "Os riscos estão bloqueados porque o Mapa de Riscos foi concluído." | `DOCUMENT_NOT_EDITABLE` |
| V-06 | Geração não `SUCCEEDED`, expirada, de outro processo ou já aplicada | API | "Esta proposta não pode mais ser aplicada. Gere outra." | `AI_GENERATION_NOT_APPLICABLE` |
| V-07 | Seleção vazia, `proposalKey` inexistente ou tratamento de outro risco | Front + API (Zod) | "Selecione ao menos um risco da proposta." | `VALIDATION_ERROR` |
| V-08 | `expectedVersions` divergente em `RSK-12` | API | "O risco foi alterado por outra pessoa. Recarregue." | `VERSION_CONFLICT` |
| V-09 | Concluir o mapa com risco pendente de revisão ou com "[a confirmar" | API | "Revise os riscos gerados por IA e resolva os itens a confirmar." | `DOCUMENT_INCOMPLETE` |

## Permissões
- **Permissão:** `AI_GENERATE` e `RISK_MANAGE` cobrindo o processo (POL-18) para gerar; `RISK_MANAGE` para aplicar e revisar; `PROCESS_VIEW` para consultar (`AI-02`).
- **Políticas:** POL-18 (inclui `ai.enabled`, provedor e limites; revalidada no worker); POL-02 (custódia ou participação `COLLABORATOR`/`CONSULTANT`, `RISK_MAP` editável); só o solicitante aplica ou descarta (RN-AI-13); a revisão pode ser feita por qualquer pessoa com `RISK_MANAGE` + POL-02.
- **MFA:** não exigido (`AI_GENERATE` e `RISK_MANAGE` são risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** sem `AI_GENERATE` o botão não aparece; com `AI_GENERATE` e `canGenerate = false` aparece desabilitado com o motivo; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiGenerationRequested` / `AiGenerationCompleted` / `AiGenerationFailed` | `ai.generation_requested` / `_completed` / `_failed` | `AI-01` e worker | Produzidos por US-115; payload sem conteúdo |
| `RiskCreated` | `risk.created` | Commit de `RSK-11`, um por risco | `riskId`, `code`, `level`, `phase`, `categoryCode` |
| `RiskTreatmentChanged` | `risk.treatment_changed` | Commit de `RSK-11`, um por tratamento criado | `riskId`, `treatmentId`, `change = CREATED`, `status = PLANNED` |
| `AiContentApplied` | `document.ai_content_applied.risk_map` | Commit de `RSK-11` e de `DOC-26` | `generationId`, `documentId?`, `targetModule`, `sectionKeys[]`, `riskIds[]`, `replacedFilledSections`; timeline `AI_CONTENT_APPLIED` |
| `AiContentReviewed` | `document.ai_content_reviewed.risk_map` | Commit de `RSK-12` | `riskIds[]`, `generationIds[]`; timeline `AI_CONTENT_REVIEWED` |
| `DocumentVersionCreated` | `document.version_created.risk_map` | `DOC-26` ao substituir seção preenchida (RN-AI-28) | `reason = SYSTEM` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_GENERATION_READY` | solicitante | in-app | Proposta `SUCCEEDED` (link `?ia=<id>` para SCR-011); definida em US-115 |
| `AI_GENERATION_FAILED` | solicitante | in-app | Geração `FAILED`; definida em US-115 |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerar a proposta do mapa de riscos com IA

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com "ai.enabled" verdadeiro e termos aceitos
    And o processo "0012/2026" tem um DFD finalizado e nenhum risco registrado
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO", "AI_GENERATE", "RISK_MANAGE" e custódia do processo
    And o provedor de IA de teste responde com uma proposta de 6 riscos, cada um com 2 tratamentos

  Scenario: [Sucesso] Gerar a proposta sem criar riscos
    When "Carla" solicitar a proposta do mapa de riscos
    Then a API deve responder 202 com "Location" da geração e status "QUEUED"
    And deve gerar registro de auditoria "ai.generation_request" e o evento "AiGenerationRequested"
    When o worker concluir a geração
    Then a geração deve ficar "SUCCEEDED" com 6 riscos em "output.risks" e "AI_GENERATION_READY" deve ser enviada a "Carla"
    And nenhum risco nem tratamento deve existir no processo

  Scenario: [Sucesso] Aplicar seletivamente riscos e tratamentos
    Given que a proposta está "SUCCEEDED"
    When "Carla" aplicar 4 riscos com 7 dos seus tratamentos
    Then a API deve responder 201 com os riscos "R01" a "R04", "aiReviewedAt" nulo e "aiGenerationId" preenchido
    And "level" deve seguir as faixas vigentes e os tratamentos devem ter "status" "PLANNED" sem responsável nem prazo
    And devem ser gerados 4 eventos "RiskCreated" e o evento "AiContentApplied" com 4 "riskIds"
    And devem existir 4 registros "risk.create" e o registro "ai.content_apply"

  Scenario: [Sucesso] Aplicar seção narrativa do mapa de riscos emitido e revisar os riscos
    Given que o "RISK_MAP" do processo está em "DRAFT" com "INTRODUCTION" vazia e a proposta traz essa seção
    When "Carla" aplicar a seção "INTRODUCTION" pelo "DOC-26"
    Then a seção deve ficar "FILLED" com proveniência "ai" sem revisão
    When "Carla" revisar os riscos "R01" e "R02" com as versões esperadas
    Then os riscos devem ter "aiReviewedAt" e "aiReviewedById" e o evento "AiContentReviewed" deve ser gerado com auditoria "ai.content_review"

  Scenario: [Validação] Processo sem DFD
    Given que o processo não tem DFD
    When "Carla" solicitar a proposta
    Then a API deve responder 422 com código "AI_PREREQUISITE_MISSING" e "missing" igual a "DFD"
    And nenhuma geração deve ser criada

  Scenario: [Validação] Categoria desconhecida, seleção vazia e conclusão bloqueada
    Given que o provedor propõe um risco com "categoryCode" inexistente
    Then a proposta deve registrar a categoria "OUTRO"
    When "Carla" aplicar a proposta sem selecionar nenhum risco
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    Given que a proposta foi aplicada e "R01" não foi revisado, e "R02" tem "[a confirmar: prazo]" na causa
    When "Carla" finalizar o mapa de riscos
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" com as violações "RISK_AI_REVIEW_PENDING" e "RISK_PLACEHOLDER_PENDING"

  Scenario: [Permissão] Usuário sem AI_GENERATE e solicitante diferente
    Given que "Bruno" tem "RISK_MANAGE" mas não tem "AI_GENERATE"
    When "Bruno" solicitar a proposta
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar "access.denied"
    Given que "Marta" tem "RISK_MANAGE" e "AI_GENERATE" e a proposta é de "Carla"
    When "Marta" aplicar a proposta de "Carla"
    Then a API deve responder 403 com código "AI_GENERATION_NOT_OWNED"

  Scenario: [Tenant incorreto] Geração e processo de outro tenant
    Given que existe uma proposta no tenant "Prefeitura B"
    When "Carla" tentar aplicar essa proposta
    Then a API deve responder 404 com código "AI_GENERATION_NOT_FOUND"
    And o contexto enviado ao provedor de teste não deve conter riscos, itens nem textos de outro tenant

  Scenario: [Duplicidade] Reenvio, proposta aplicada duas vezes e risco parecido
    Given que "Carla" aplicou a proposta com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o cabeçalho "Idempotent-Replayed: true" e nenhum risco deve ser duplicado
    When "Carla" enviar a mesma aplicação com a chave "K2"
    Then a API deve responder 409 com código "AI_GENERATION_NOT_APPLICABLE"

  Scenario: [Concorrência] Duas aplicações simultâneas e revisão com versão antiga
    Given que "Carla" envia duas aplicações da mesma proposta ao mesmo tempo
    Then exatamente uma deve responder 201 e a outra 409 com código "AI_GENERATION_NOT_APPLICABLE"
    And os códigos dos riscos devem ser sequenciais e sem repetição
    Given que outra pessoa editou "R01" depois que "Carla" carregou a lista
    When "Carla" revisar "R01" com a versão antiga
    Then a API deve responder 412 com código "VERSION_CONFLICT" e "R01" não deve ser marcado como revisado

  Scenario: [Falha de banco] Banco indisponível durante a aplicação
    Given que o banco fica indisponível durante a transação do "RSK-11"
    When "Carla" aplicar a proposta
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum risco ou tratamento deve ser criado e a geração deve continuar "SUCCEEDED"

  Scenario: [Falha de integração] Provedor de IA com erro, saída inválida ou circuito aberto
    Given que o provedor de teste responde 503 nas 3 tentativas
    When o worker processar a geração
    Then a geração deve ficar "FAILED" com "errorCode" "PROVIDER_UNAVAILABLE" e "AI_GENERATION_FAILED" deve ser enviada
    Given que o provedor responde com "probability" 7 numa escala de 1 a 5, mesmo após o reparo
    Then a geração deve ficar "FAILED" com "errorCode" "OUTPUT_INVALID"
    Given que o circuito do provedor está aberto
    When "Carla" solicitar a proposta
    Then a API deve responder 503 com código "AI_PROVIDER_UNAVAILABLE" e o cabeçalho "Retry-After"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem DFD | 422 | `AI_PREREQUISITE_MISSING` | "Crie o DFD antes de gerar a proposta de riscos." | Link para o DFD |
| Provedor indisponível | 503 | `AI_PROVIDER_UNAVAILABLE` | "A IA está indisponível. Tente novamente em instantes." | Desabilita com `Retry-After` |
| Geração ativa | 409 | `AI_GENERATION_IN_PROGRESS` | "Já há uma proposta sendo gerada." | Abre o painel na geração (`meta.generationId`) |
| Mapa bloqueado | 409 | `DOCUMENT_NOT_EDITABLE` | "Os riscos estão bloqueados porque o Mapa de Riscos foi concluído." | Desabilita aplicar |
| Proposta não aplicável | 409 | `AI_GENERATION_NOT_APPLICABLE` | "Esta proposta não pode mais ser aplicada. Gere outra." | Oferece "Gerar nova proposta" |
| Não é o solicitante | 403 | `AI_GENERATION_NOT_OWNED` | "Só quem pediu a proposta pode aplicá-la." | Oculta aplicar |
| Geração inexistente ou de outro tenant | 404 | `AI_GENERATION_NOT_FOUND` | "Proposta não encontrada." | Fecha o painel |
| Seleção inválida | 422 | `VALIDATION_ERROR` | "Selecione ao menos um risco da proposta." | Marca a lista |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Botão oculto; API bloqueia |
| Versão do risco divergente | 412 | `VERSION_CONFLICT` | "O risco foi alterado por outra pessoa. Recarregue." | Recarrega a lista |
| Mapa incompleto | 422 | `DOCUMENT_INCOMPLETE` | "Revise os riscos gerados por IA e resolva os itens a confirmar." | Abre `RiskMapCompletenessPanel` |
| Chave de idempotência reutilizada / em curso | 422 / 409 | `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` | "Esta solicitação já foi enviada." / "Estamos concluindo. Aguarde." | Nova chave / repete após 2 s |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Mantém a seleção |
| Falha da geração (campo `errorCode`) | — | `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `TIMEOUT`, `CONTENT_FILTERED`, `CONTEXT_TOO_LARGE`, `OUTPUT_INVALID` | "Não foi possível gerar a proposta." | Painel "falhou" com "Tentar novamente" |

## Dependências
- **Stories:** US-034 e US-035 (riscos, tratamentos, matriz e emissão do `RISK_MAP`); US-117 (fluxo genérico, painel SCR-117, `DOC-26`); US-115 (camada de IA, `AI-01`..`AI-04`), US-116 (ativação e limites), US-122 (marcações, revisão de seções e `DOC-27`) e US-033 (cadastro de riscos) como base.
- **Decisões/ADRs:** DEC-017, DEC-030, DEC-037, DEC-079, DEC-140; ADR-013 (provedor, pendente — PEND-21).
- **Configurações:** `ai.enabled`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`, `risk.scale`, `risk.levelThresholds`, `AI_MODEL_DRAFT`.
- **Lacunas nas fontes canônicas:**
  1. *(Resolvida, 2026-10-16 — DOC-26/RSK-11 e entities.md §4.11.)* A proposta do mapa tem duas partes; cada uma é aplicada uma vez, a geração vai a `APPLIED` na primeira aplicação e aceita a outra parte até expirar.
  2. *(Resolvida em entities.md §5.10.)* Campos de texto de `Risk`/`RiskTreatment` recebem o marcador literal "[a confirmar: …]", detectado por `RISK_PLACEHOLDER_PENDING`.
  3. `rationale` e `similarToRiskId` ficam só em `AiGeneration.output` no MVP 1 (sem coluna em `Risk`).
  4. *(Resolvida.)* Para manter a semântica do RSK-06, cada tratamento criado publica `RiskTreatmentChanged` (`CREATED`) e é auditado como `risk.treatment_create`; o risco que nasce com tratamento entra em `IN_TREATMENT` (RN-RISK-14).
  5. *(Resolvida.)* RSK-11/RSK-12 detalhados em `api/08-risks.md`.

## Impacto técnico
- O `ai` só lê (fachadas `risk`, `process`, `dfd`, `etp`, `term`, `catalog`; dependency-cruiser `ai-read-only`); a criação é do `risk` via `AiSuggestionSource` (`loadForApply` + `markApplied` na mesma transação); sem provedor da porta, falha fechada.
- Contexto minimizado (RN-AI-05): sem nomes, responsáveis, valores ou comentários; seções de valor (`ESTIMATES`, `ESTIMATED_VALUE`) ficam fora, então o sigilo do orçamento não é afetado.
- Concorrência: o código `R{nn}` é gerado sob lock por processo (RN-RISK-02); a aplicação usa atualização condicional do status da geração.

## Backend
- **Módulo(s):** `ai` (gerador `draft.risk_map`, dono de `AiGeneration`), `risk` (dono de `Risk`/`RiskTreatment`; aplicação e revisão), `document` (`DOC-26`, `DOC-08`), com fachadas de leitura de `process`, `dfd`, `etp`, `term`, `catalog`.
- **Casos de uso:** `RequestAiGenerationCommand` (US-115), `GenerateRiskMapProposalHandler` (worker), `ApplyAiRiskProposalCommand`, `ReviewAiRisksCommand`.
- **Domínio:** `Risk.createFromAiProposal(...)`, `Risk.markAiReviewed(...)`, política de normalização de categoria (`OUTRO`), regra de completude `RISK_AI_REVIEW_PENDING`/`RISK_PLACEHOLDER_PENDING`.
- **Integrações internas:** `AiSuggestionSource`, `AuthorizationService.assertCan('RISK_MANAGE', { processId })`, `DocumentFacade` (DOC-26), `CatalogFacade` (`RISK_CATEGORY`), `OutboxWriter`.
- **Transação:** `RSK-11` = validações → `Risk` + `RiskTreatment` → `markApplied` → auditoria → outbox, em uma só transação com `app.tenant_id`; nenhuma chamada de IA dentro dela.

## Frontend
- **Tela(s):** SCR-011 (`/processos/[id]/riscos`) com o painel SCR-117; `?ia=<generationId>` abre a proposta.
- **Componentes:** `AiDraftButton`, `AiAssistantPanel`, `AiRequestForm`, `AiGenerationProgress`, `AiRiskProposalList` (cartões de risco com tratamentos, P×I, `LevelBadge`, selo de semelhança), `AiProposalSectionList` e `AiSectionDiffView` (seções do `RISK_MAP`), `AiGeneratedBadge`, `MarkReviewedButton`, `ReviewAllDialog`, `AiDisclaimer`.
- **Estados:** formulário, gerando (skeleton), proposta pronta, aplicada, falhou, expirada.
- **Acessibilidade e responsividade:** cartões navegáveis por teclado; progresso e resultado anunciados por `aria-live`; checkboxes rotulados; em telas < 768 px o painel ocupa a tela inteira.

## Banco de dados
- **Tabelas:** `ai_generations` (status, `appliedTargets`), `risks` e `risk_treatments` (inserção), `documents` (seções via `DOC-26`), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova nesta story — `Risk`/`RiskTreatment` já têm `aiGenerationId`; `aiReviewedAt`/`aiReviewedById` em `Risk` vêm da camada de IA (US-115).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id, code)` em `risks`; FK composta → `ai_generations`; único parcial de geração `DRAFT` ativa por (processo, `targetModule`).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-01` | POST | `/processes/{id}/ai-generations` | `{ targetModule: 'RISK_MAP', kind: 'DRAFT', documentId?, needSummary? }` + `Idempotency-Key` | `202 { data: AiGeneration, meta: { pollAfterMs } }` | 202, 403, 404, 409, 422, 429, 503 |
| `AI-02` | GET | `/ai-generations/{generationId}` | — | `200` com `output.risks` e `warnings` | 200, 403, 404 |
| `AI-04` | POST | `/ai-generations/{generationId}/discard` | — | `200` | 200, 403, 404, 409 |
| `AI-05` | GET | `/ai/availability?processId=&documentId=` | — | `200 { canGenerate, reasons[] }` | 200 |
| `RSK-11` | POST | `/processes/{id}/risks/ai-apply` | `{ generationId, risks: [{ proposalKey, treatments }] }` + `Idempotency-Key` | `201 { data: { risks: Risk[] } }` | 201, 403, 404, 409, 410, 422, 503 |
| `RSK-12` | POST | `/processes/{id}/risks/ai-review` | `{ riskIds, expectedVersions }` | `200 { data: { risks: Risk[] } }` | 200, 403, 404, 412, 422 |
| `DOC-26` | POST | `/documents/{id}/ai-apply` | `{ generationId, sectionKeys, confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` | `200` (RN-AI-28/29) | 200, 403, 409, 412, 422 |
| `DOC-08` | GET | `/documents/{id}/validation` | — | `200` com `violations[]` (`RISK_AI_REVIEW_PENDING`, `RISK_PLACEHOLDER_PENDING`) | 200, 403, 404 |

## Logs
- `info` `ai.risk_proposal_applied` — `generationId`, `risksCount`, `treatmentsCount`, `durationMs`.
- `warn` `ai.risk_proposal_not_applicable` — recusa por status, expiração ou dono; `warn` `idempotency.store_unavailable`.
- `error` `ai.risk_proposal_apply_failed` — `errorCode`, `correlationId`.
- Nunca logar: `needSummary`, contexto enviado, títulos, descrições, causas, consequências ou tratamentos propostos, saída do modelo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.generation_complete` / `ai.generation_fail` | `SYSTEM` | Término do worker | modelo, tokens, `costUsd`, `inputRefs`, `contextHash`, `outputHash`, `errorCode`; nunca texto |
| `risk.create` | `DATA_CHANGE` | Por risco criado em `RSK-11` | `riskId`, `code`, `level`, `generationId`, quantidade de tratamentos |
| `risk.treatment_create` | `DATA_CHANGE` | Por tratamento criado em `RSK-11` | `riskId`, `treatmentId`, `type`, `generationId` |
| `ai.content_apply` | `DATA_CHANGE` | Commit de `RSK-11` e `DOC-26` | `generationId`, `riskIds`, `sectionKeys`, `replacedFilledSections` |
| `ai.content_review` | `DATA_CHANGE` | Commit de `RSK-12` | `riskIds`, `generationIds` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = AI_GENERATE` ou `RISK_MANAGE` |

## Testes necessários
- **Unitários:** montagem e minimização do contexto do mapa; schema Zod da saída (limite de 15, escala, tratamentos 1..3); categoria desconhecida → `OUTRO`; cálculo de `score`/`level`; GroundingGuard em texto simples; regras de completude.
- **Integração (Testcontainers PostgreSQL + Redis):** `RSK-11` atômico (riscos, tratamentos, geração, auditoria, outbox); falha fechada sem provedor de `AiSuggestionSource`; worker com `FakeAiProvider` (sucesso, 429, 5xx, saída inválida); RLS.
- **API/contrato:** `AI-01`, `RSK-11`, `RSK-12` e códigos conforme api.md; `Idempotency-Key`/`Idempotent-Replayed`; contrato do `AiProvider`.
- **RBAC e multi-tenant:** `AI_GENERATE` e `RISK_MANAGE` por perfil e escopo; POL-02; geração de outro tenant → 404; teste novo na suíte `test/tenant-leak` (contexto sem dados de outro tenant).
- **Concorrência:** duas aplicações simultâneas; `RSK-12` com versão antiga; códigos `R{nn}` sob criação concorrente.
- **E2E (Playwright):** gerar → selecionar → aplicar → revisar → finalizar o mapa; bloqueio por `RISK_AI_REVIEW_PENDING`.
- **Acessibilidade/performance:** axe no painel e na lista de propostas; meta p95 de `AI-01` ≤ 1 s e da proposta ≤ 90 s na suíte de performance.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI do lote
- [ ] `AI_GENERATE`, `RISK_MANAGE`, POL-18 e POL-02 aplicados na API; ação oculta/desabilitada na UI
- [ ] Aplicação atômica comprovada por teste de falha induzida
- [ ] Auditoria, eventos e timeline verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `AI-01`, `RSK-11` e `RSK-12` compatível com api.md; lacunas 1 a 5 resolvidas nas fontes
- [ ] Logs sem conteúdo gerado; métricas `cf_ai_*` e trace presentes
- [ ] Painel acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita a camada de IA (US-115) e o painel e a aplicação genérica (US-117); a complexidade está no gerador estruturado, na aplicação seletiva em `risk` e na revisão por risco, sem entidade nova.

## Prioridade
**P1** — o mapa de riscos é etapa obrigatória da fase preparatória (art. 18, X) e, com a IA, reduz o retrabalho de planejamento sem tirar a decisão da pessoa; depende do fluxo genérico de US-117.
