---
id: US-151
title: "Configurar critérios da fila e hipóteses de dispensa"
epic: EP-025
feature: FT-073
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-103, US-104, US-149]
modules: [legal-review, catalog, tenancy, rules, access, audit, platform]
screens: [SCR-120]
endpoints: [LGL-05, LGL-06, LGL-07, LGL-08, CAT-01]
permissions: [LEGAL_REVIEW_CONFIGURE]
events: [TenantSettingsChanged, CatalogItemChanged]
---

# US-151 — Configurar critérios da fila e hipóteses de dispensa

## Título
Configurar critérios da fila e hipóteses de dispensa

## Descrição
**Como** administrador do órgão, **quero** ajustar os fatores, os pesos e a direção que ordenam a fila jurídica e cadastrar, ativar e desativar as hipóteses de dispensa de análise jurídica com a base legal e o ato da autoridade jurídica máxima, **para** que a Procuradoria use critérios objetivos e auditáveis (art. 53, § 1º, I) e só dispense a análise nas hipóteses que o órgão regulamentou (art. 53, § 5º), sem depender de alteração de código.

A story entrega a tela SCR-120 (`/admin/juridico`) com duas áreas: **Critérios da fila** (`legalReview.queueCriteria`, com pré-visualização da nova ordem e recálculo da fila ao salvar) e **Hipóteses de dispensa** (catálogo `LEGAL_WAIVER_HYPOTHESIS`: criar, editar, ativar e desativar). Usar uma hipótese para dispensar uma análise é da US-156; o cálculo do score é da US-149.

## Contexto
- A DEC-199 manda configurar os critérios da fila por tenant e as hipóteses de dispensa "por tenant (ato da autoridade jurídica máxima)"; o overview §7 define que **nenhuma hipótese vem ativa por padrão** e que existem dois modelos prontos (baixo valor e compras com minutas padronizadas) para o ato da autoridade.
- `entities.md §7.5` fixa o schema `LegalQueueCriteria` (fator, peso 0..100, direção) e o padrão semeado; `§7.10` fixa o `metadata` de `LEGAL_WAIVER_HYPOTHESIS` (`legalBasis`, `actReference`, `condition?` como `RuleRef`, `maxEstimatedValue?`); o seed cria `BAIXO_VALOR` e `MINUTA_PADRONIZADA` como itens de sistema **inativos**.
- A chave `legalReview.queueCriteria` é um `TenantSetting` (US-103: registro tipado, `version` por chave, `TenantSettingsChanged`) e a hipótese é um `CatalogItem` (US-104: `code` imutável, itens de sistema não excluídos, ciclo de vida por ativação/desativação, `CatalogItemChanged`). Como o produto trata esta configuração como **sensível** (`LEGAL_REVIEW_CONFIGURE`, risco `H`, só `ADMIN_ORGAO`), a escrita precisa passar por uma única porta com essa permissão, e não pelas rotas genéricas de configurações e catálogos (`SETTINGS_MANAGE`, `CATALOG_MANAGE`) — RN-LGL-84.
- A condição de uma hipótese é uma `RuleRef` sobre o `RuleContext` v2 (US-129): `INLINE` (JSON Logic com `contextVersion`) ou `LIBRARY` (versão publicada da biblioteca de regras). A avaliação da condição contra um processo é da US-156 (POL-26); aqui só se valida a forma e os caminhos.
- Alterar os critérios muda a ordem da fila; o recálculo usa o calculador da US-149 (RN-LGL-34) e o rastro fica em `priorityFactors.criteriaVersion` e na auditoria desta story.

## Objetivo
Garantir que 100% das alterações de critérios e de hipóteses sejam feitas por quem tem `LEGAL_REVIEW_CONFIGURE` com MFA, validadas por schema, versionadas e auditadas com valor anterior e novo, que a fila seja reordenada de forma consistente após salvar (em até 5 s com 500 análises abertas) e que nenhuma hipótese se torne ativa sem base legal, ato da autoridade e condição objetiva.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`) com `LEGAL_REVIEW_CONFIGURE`.
- **Secundárias:** chefe da assessoria jurídica (consulta o efeito e pede ajustes ao administrador); Auditor (`AUDITOR`: confere a trilha de alterações); procuradores (sentem o efeito na fila e, na US-156, usam as hipóteses ativas).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, com `LEGAL_REVIEW_CONFIGURE` (escopo `TENANT`).
- Sessão com MFA válido quando `security.mfaPolicy` exigir (permissão de risco `H`, POL-14).
- Chave `legalReview.queueCriteria` semeada (padrão de `entities.md §7.5`) e catálogo `LEGAL_WAIVER_HYPOTHESIS` semeado com `BAIXO_VALOR` e `MINUTA_PADRONIZADA` inativas (US-099/US-104).

## Fluxo principal
1. O administrador abre **Administração › Análise jurídica** (SCR-120, `/admin/juridico`); o front chama `GET /legal-review-settings` (LGL-05) e mostra a aba "Critérios da fila" com os quatro fatores (prazo da etapa, urgência, valor estimado, data de entrada), peso (0 a 100) e direção de cada um, a versão da configuração e o selo "Padrão" ou "Personalizado".
2. Ele altera, por exemplo, o peso do valor estimado de 20 para 90 e os demais para 5, 5 e 0, e aciona **"Pré-visualizar"**; o front envia `PUT /legal-review-settings/queue-criteria?dryRun=true` (LGL-06) com `{ criteria }`; a API valida e devolve a nova ordem simulada **sem gravar** (posição atual e nova, apenas das análises que o administrador pode ver, mais o total de análises que mudariam de posição).
3. Satisfeito, ele aciona **"Salvar critérios"** e confirma o aviso "A ordem da fila será recalculada agora."; o front envia `PUT /legal-review-settings/queue-criteria` (LGL-06) com `{ criteria }` e `If-Match` (versão da configuração, lida em LGL-05).
4. A API valida o schema (RN-LGL-75), confere a versão, grava a nova versão de `legalReview.queueCriteria`, reordena a fila (RN-LGL-78), grava a auditoria `legal_review.configure` e publica `TenantSettingsChanged` (`keys: ["legalReview.queueCriteria"]`) no outbox, na mesma transação.
5. A API responde 200 com os critérios, a nova versão e o estado do recálculo; o front mostra "Critérios salvos. A fila foi reordenada." e atualiza o selo para "Personalizado". Na fila (US-149), cada análise passa a registrar a nova `criteriaVersion` em `priorityFactors`.
6. Na aba **"Hipóteses de dispensa"** o administrador vê as hipóteses (com base legal, ato, condição, valor máximo, situação e quantas dispensas já registradas) e aciona **"Nova hipótese"** ou edita um modelo semeado.
7. Ele preenche código, nome, base legal, ato da autoridade jurídica máxima (tipo, número e data), condição (editor de regra da biblioteca de regras) e/ou valor máximo estimado; o front envia `POST /legal-review-settings/waiver-hypotheses` (LGL-07); a API valida (RN-LGL-80), cria o `CatalogItem` **inativo**, audita e publica `CatalogItemChanged` (`CREATED`).
8. Quando a hipótese estiver completa, ele aciona **"Ativar"**; o front envia `PATCH /legal-review-settings/waiver-hypotheses/{id}` (LGL-08) com `{ isActive: true }` e `If-Match`; a API confere os pré-requisitos de ativação (RN-LGL-81), ativa, audita (`legal_review.configure`) e publica `CatalogItemChanged` (`ACTIVATED`). A partir daí a US-156 passa a oferecer a hipótese nas dispensas.
9. Para encerrar o uso, ele aciona **"Desativar"**; o efeito é imediato para novas dispensas e não altera as já registradas (RN-LGL-83).

## Fluxos alternativos
- **FA-01 — Restaurar o padrão:** "Restaurar padrão" preenche o formulário com o padrão do registro (prazo `ASC` 40, urgência `DESC` 30, valor `DESC` 20, entrada `ASC` 10); o salvamento segue o fluxo normal (RN-LGL-76).
- **FA-02 — Todos os pesos zerados:** a API aceita; a UI avisa "Com todos os pesos em 0 a fila segue a ordem de chegada." e exige confirmação (RN-LGL-75).
- **FA-03 — Nenhuma alteração:** critérios iguais aos vigentes devolvem 200 sem nova versão, sem recálculo, sem auditoria e sem evento (RN-LGL-77).
- **FA-04 — Pré-visualização sem permissão de ver processos:** o administrador sem visibilidade sobre as análises vê só os contadores ("12 análises mudariam de posição") e a mensagem "Há análises que você não pode ver."; nenhuma linha de processo invisível é exposta (RN-LGL-79).
- **FA-05 — Versão desatualizada:** outro administrador salvou antes: 412 `VERSION_CONFLICT`; o front recarrega os critérios e mostra o que mudou antes de reenviar.
- **FA-06 — Muitas análises abertas:** acima de 1.000 análises abertas o recálculo roda em job em lotes; a resposta traz `rescoring.status = RUNNING` e a fila mostra "Reordenando a fila…" até terminar (RN-LGL-78).
- **FA-07 — Completar um modelo semeado:** `BAIXO_VALOR` e `MINUTA_PADRONIZADA` chegam sem ato; o administrador os completa com `PATCH` e só então ativa; `code` e `isSystem` não mudam (RN-LGL-80, RN-LGL-82).
- **FA-08 — Hipótese ativa não aceita mudança das condições:** editar `legalBasis`, `actReference`, `condition` ou `maxEstimatedValue` de hipótese ativa responde 409 `LEGAL_WAIVER_HYPOTHESIS_ACTIVE`; a UI orienta "Desative a hipótese para alterar as condições" (RN-LGL-82).
- **FA-09 — Hipótese já usada em dispensa:** as condições ficam travadas para sempre (409 `LEGAL_WAIVER_HYPOTHESIS_IN_USE`); só nome, descrição e situação mudam, e a orientação é criar uma nova hipótese (RN-LGL-82).
- **FA-10 — Ativar hipótese incompleta:** sem base legal, ato ou condição objetiva (condição ou valor máximo), 422 `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) por campo faltante (RN-LGL-81).
- **FA-11 — Condição inválida:** caminho que não existe no `RuleContext` v2, expressão que não é booleana ou versão de biblioteca não publicada: 422 `VALIDATION_ERROR` (`INVALID_FORMAT`/`REFERENCE_NOT_FOUND`) em `condition` (RN-LGL-80).
- **FA-12 — Tentativa pelas rotas genéricas:** `PATCH /settings` com a chave da fila e `POST/PATCH` de catálogo para o tipo `LEGAL_WAIVER_HYPOTHESIS` respondem 403 `PERMISSION_DENIED` (RN-LGL-84).

## Regras de negócio
- **RN-LGL-02** — A fila usa critérios objetivos configuráveis (prazo da etapa, urgência, valor estimado, data de entrada), com pesos de 0 a 100 e direção; o padrão semeado segue essa ordem (DEC-199, overview §7). *(regra da feature, adotada)*
- **RN-LGL-08** — Configurar critérios e hipóteses de dispensa exige `LEGAL_REVIEW_CONFIGURE` (permissão sensível); hipótese só vale com ato da autoridade jurídica máxima registrado e nenhuma vem ativa por padrão (DEC-199, overview §7). *(regra da feature, adotada)*
- **RN-LGL-75** — Schema dos critérios (`legalQueueCriteriaSchema`): lista com **exatamente quatro** itens, um por fator (`STAGE_DUE_AT`, `URGENCY`, `ESTIMATED_VALUE`, `ENTERED_QUEUE_AT`), sem repetição; `weight` inteiro de 0 a 100; `direction` `ASC` ou `DESC`. A soma dos pesos pode ser 0 (a fila segue a ordem de chegada, com aviso). A ordem da lista é a de exibição; não influencia o cálculo.
- **RN-LGL-76** — Padrão e restauração: o padrão do registro é prazo `ASC` 40, urgência `DESC` 30, valor `DESC` 20, entrada `ASC` 10 (RN-LGL-32 da US-149). "Restaurar padrão" é apenas um `PUT` com esses valores; não há histórico navegável nesta entrega (a trilha está na auditoria).
- **RN-LGL-77** — Versão e concorrência: a chave `legalReview.queueCriteria` tem `version` do `TenantSetting`; LGL-06 exige `If-Match` com essa versão (428 sem ele, 412 se divergente); critérios iguais aos vigentes são no-op (200, sem nova versão, recálculo, auditoria nem evento). `dryRun=true` não exige `If-Match`, não grava e não gera auditoria nem evento.
- **RN-LGL-78** — Efeito sobre a fila: ao salvar, as análises `PENDING` e `IN_REVIEW` do tenant são recalculadas com os novos critérios (calculador da US-149); até 1.000 análises abertas o recálculo ocorre **na mesma transação** da gravação (a fila nunca fica com scores de duas versões); acima disso um job em lotes de 200 faz o recálculo, idempotente por `criteriaVersion`, e LGL-05 expõe `rescoring { status: IDLE|RUNNING, processed, total }`. O recálculo não altera `version` das análises (RN-LGL-34) nem gera auditoria por análise; análises finais não são recalculadas.
- **RN-LGL-79** — Pré-visualização: simula o novo score de todas as análises abertas do tenant e devolve `preview { total, movedCount, hiddenCount, items[] }`, com até 20 itens **visíveis ao administrador** (DEC-024) ordenados pela nova posição, cada um com `legalReviewId`, `processCode`, `positionBefore`, `positionAfter`. Não devolve valor, faixa nem objeto; as posições consideram todo o tenant, e `hiddenCount` informa só quantas análises o usuário não vê.
- **RN-LGL-80** — Hipótese de dispensa (`CatalogItem` `LEGAL_WAIVER_HYPOTHESIS`): `code` em `SCREAMING_SNAKE` (`^[A-Z][A-Z0-9_]{2,39}$`), único no tenant e imutável; `label` 3..120; `description` até 500; `metadata`: `legalBasis` 5..300 (por exemplo, "art. 53, § 5º, da Lei 14.133/2021"), `actReference` 5..300 (tipo, número e data do ato da autoridade jurídica máxima), `condition?` (`RuleRef`: `INLINE` com `contextVersion` 2 e caminhos válidos do `RuleContext` v2, ou `LIBRARY` com versão `PUBLISHED`), `maxEstimatedValue?` maior que 0 com 2 casas. O valor máximo é parâmetro de configuração, não valor de processo; a comparação com o valor real, inclusive sigiloso, ocorre só no servidor, na US-156.
- **RN-LGL-81** — Ativação: exige `legalBasis` e `actReference` não vazios **e** ao menos um critério objetivo (`condition` ou `maxEstimatedValue`); a `condition` é revalidada no ato (versão de biblioteca ainda `PUBLISHED`). Nenhuma hipótese nasce ativa (LGL-07 sempre cria `isActive = false`) e não há ativação em lote. Ativar e desativar por LGL-08 (`isActive`).
- **RN-LGL-82** — Edição: `label` e `description` sempre editáveis; `legalBasis`, `actReference`, `condition` e `maxEstimatedValue` só com a hipótese **inativa** antes da chamada (senão 409 `LEGAL_WAIVER_HYPOTHESIS_ACTIVE`) e **nunca** quando já houver dispensa registrada com ela (409 `LEGAL_WAIVER_HYPOTHESIS_IN_USE`, que prevalece); `code` não muda (item de sistema: 409 `CATALOG_ITEM_SYSTEM`; comum: 422 `VALIDATION_ERROR` `NOT_ALLOWED`); não há exclusão (RN-TEN-64). `metadata` editada é substituída por inteiro e revalidada.
- **RN-LGL-83** — Desativar: sempre permitido; vale para novas dispensas a partir do commit (a hipótese some da lista da US-156; dispensa em andamento recebe `LEGAL_WAIVER_NOT_APPLICABLE`); dispensas registradas continuam válidas e exibem a hipótese pelo `waiverHypothesisId`, incluindo inativa (RN-TEN-61). Reativar exige de novo os pré-requisitos de RN-LGL-81. Já no estado pedido: 200 sem nova versão, auditoria nem evento.
- **RN-LGL-84** — Porta única, sigilo e trilha: a escrita de `legalReview.queueCriteria` e de itens `LEGAL_WAIVER_HYPOTHESIS` só é aceita por LGL-06/07/08 (com `LEGAL_REVIEW_CONFIGURE`); `PATCH /settings` (SET-02) e `CAT-02` a `CAT-06` recusam essa chave e esse tipo com 403 `PERMISSION_DENIED`, e a leitura por `CAT-01` e `SET-01` continua como nas demais configurações. Cada gravação gera `legal_review.configure` (`CONFIGURATION`) com valores anterior e novo, e o evento do MVP 1 correspondente (`TenantSettingsChanged` ou `CatalogItemChanged`) com `keys[]`/`change`, sem texto do ato nem da condição nos payloads de evento e de log.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Fator | `criteria[].factor` | enum | Sim | os quatro fatores, uma vez cada (RN-LGL-75) | padrão semeado |
| Peso | `criteria[].weight` | inteiro | Sim | 0..100 | 40 / 30 / 20 / 10 |
| Direção | `criteria[].direction` | `ASC` \| `DESC` | Sim | RN-LGL-75 | conforme o fator |
| Versão da configuração | `If-Match` | texto | Sim (gravação) | versão de `legalReview.queueCriteria` | LGL-05 |
| Somente simular | `dryRun` (query) | booleano | Não | RN-LGL-77 | `false` |
| Código | `code` | texto | Sim (criação) | `^[A-Z][A-Z0-9_]{2,39}$`, único, imutável | — |
| Nome | `label` | texto | Sim | 3..120 | — |
| Descrição | `description` | texto | Não | até 500 | — |
| Base legal | `metadata.legalBasis` | texto | Sim | 5..300 | — |
| Ato da autoridade jurídica máxima | `metadata.actReference` | texto | Sim | 5..300 | em branco nos modelos semeados |
| Condição | `metadata.condition` | `RuleRef` | Condicional | RN-LGL-80/81 | — |
| Valor máximo estimado | `metadata.maxEstimatedValue` | decimal | Condicional | > 0, 2 casas | — |
| Ativa | `isActive` | booleano | Não (PATCH) | RN-LGL-81/83 | `false` |
| *(saída)* Dispensas registradas | `usageCount` | inteiro | — | RN-LGL-82 | derivado |
| *(saída)* Recálculo | `rescoring` | objeto | — | RN-LGL-78 | servidor |
| *(saída)* Pré-visualização | `preview` | objeto | — | RN-LGL-79 | derivado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Critérios sem os quatro fatores, com fator repetido ou desconhecido | Front + API (Zod) | "Informe os quatro fatores, uma vez cada." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-02 | Peso fora de 0..100 ou não inteiro; direção inválida | Front + API | "O peso deve ser um número inteiro de 0 a 100." | `VALIDATION_ERROR` |
| V-03 | `If-Match` ausente / divergente | API | "Recarregue a página e tente de novo." / "Os critérios foram alterados por outra pessoa. Recarregue para ver as mudanças." | `PRECONDITION_REQUIRED` (428) / `VERSION_CONFLICT` (412) |
| V-04 | `code` fora do padrão ou já existente no tenant | Front + API | "Use letras maiúsculas, números e sublinhado, sem repetir um código existente." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-05 | `label`, `legalBasis` ou `actReference` ausentes ou fora do tamanho | Front + API | "Informe {campo} com o tamanho permitido." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-06 | `maxEstimatedValue` menor ou igual a 0 ou com mais de 2 casas | Front + API | "Informe um valor maior que zero, com até duas casas decimais." | `VALIDATION_ERROR` |
| V-07 | `condition` com caminho inexistente, não booleana ou de biblioteca não publicada | API | "A condição não é válida. Revise a regra." | `VALIDATION_ERROR` (`INVALID_FORMAT`/`REFERENCE_NOT_FOUND`) |
| V-08 | Ativar sem base legal, ato ou critério objetivo | API | "Complete a base legal, o ato da autoridade e a condição ou o valor máximo para ativar." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-09 | Alterar condições de hipótese ativa / já usada em dispensa | API | "Desative a hipótese para alterar as condições." / "Esta hipótese já foi usada em dispensas. Crie uma nova hipótese." | `LEGAL_WAIVER_HYPOTHESIS_ACTIVE` / `LEGAL_WAIVER_HYPOTHESIS_IN_USE` (409) |
| V-10 | Alterar `code` | API | "O código não pode ser alterado." | `CATALOG_ITEM_SYSTEM` (409, item de sistema) / `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-11 | Hipótese inexistente ou de outro tenant | API | "Hipótese de dispensa não encontrada." | `LEGAL_WAIVER_HYPOTHESIS_NOT_FOUND` (404) |
| V-12 | Sem `LEGAL_REVIEW_CONFIGURE` / sem MFA exigido | API | "Você não tem permissão para configurar a análise jurídica." / "Confirme sua identidade (MFA) para continuar." | `PERMISSION_DENIED` / `MFA_REQUIRED` (403) |

## Permissões
- **Permissão:** `LEGAL_REVIEW_CONFIGURE` (escopo `TENANT`; perfil `ADMIN_ORGAO` — `permissions.md §3`) em todas as rotas desta story, inclusive a leitura LGL-05 e a pré-visualização. A leitura das hipóteses ativas para a dispensa (US-156) usa `CAT-01`, aberto a qualquer vínculo `ACTIVE`.
- **Políticas:** POL-14 (MFA), DEC-024 (a pré-visualização só expõe processos visíveis), RN-TEN-60/61/64 (regras de itens de catálogo).
- **MFA:** `LEGAL_REVIEW_CONFIGURE` tem risco `H`: com `security.mfaPolicy = ADMINS` ou `ALL` a sessão precisa de MFA, senão 403 `MFA_REQUIRED`.
- **Sem permissão:** o item "Administração › Análise jurídica" fica oculto; a API responde 403 `PERMISSION_DENIED` com auditoria `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantSettingsChanged` | `tenant.settings_changed` | Commit de LGL-06 (sem `dryRun` e com alteração) | `keys: ["legalReview.queueCriteria"]`; consumidor da US-149 dispara o recálculo em lote quando o job é necessário |
| `CatalogItemChanged` | `catalog.item_changed` | Commit de LGL-07 e de LGL-08 | `change` = `CREATED`, `UPDATED`, `ACTIVATED` ou `DEACTIVATED`; sem texto do ato nem da condição |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação nesta story (`events.md §6` não prevê tipo para alteração de critérios ou de hipóteses; a trilha é a auditoria) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Configurar critérios da fila e hipóteses de dispensa

  Background:
    Given que o tenant "Prefeitura A" está ativo e usa os critérios padrão da fila
    And "Marina Costa" é "ADMIN_ORGAO" com "LEGAL_REVIEW_CONFIGURE" e MFA válido na sessão
    And a análise "LR-0045" (processo "0045/2026") tem score 82.3333 e está na posição 1
    And a análise "LR-0048" (processo "0048/2026", urgência "HIGH", faixa "B5", prazo em 25 dias) tem score 48.3333 e está na posição 2
    And as hipóteses "BAIXO_VALOR" e "MINUTA_PADRONIZADA" existem inativas, sem ato registrado

  Scenario: [Sucesso] Alterar os pesos reordena a fila e audita
    When "Marina Costa" salvar os critérios prazo 5, urgência 5, valor 90 e entrada 0 com a versão atual
    Then a API deve responder 200 com a nova versão e "rescoring" com status "IDLE"
    And o score de "LR-0048" deve ser 94.1667 e o de "LR-0045" 77.1667, com "LR-0048" na posição 1
    And a "version" das duas análises não deve ter mudado
    And deve gerar auditoria "legal_review.configure" com os critérios anterior e novo e o evento "TenantSettingsChanged" com a chave "legalReview.queueCriteria"

  Scenario: [Sucesso] Pré-visualizar a nova ordem sem gravar
    When "Marina Costa" enviar os mesmos critérios com "dryRun=true"
    Then a API deve responder 200 com "preview" mostrando "LR-0048" da posição 2 para a 1
    And a versão da configuração, os scores e a fila não devem mudar e não deve haver auditoria nem evento

  Scenario: [Sucesso] Completar um modelo, ativar e depois desativar
    When "Marina Costa" completar "BAIXO_VALOR" com base "art. 53, § 5º, da Lei 14.133/2021", ato "Portaria PGM nº 12/2026, de 03/02/2026" e valor máximo "50000.00"
    And ativar a hipótese
    Then a API deve responder 200 com "isActive" verdadeiro e gerar o evento "CatalogItemChanged" com "ACTIVATED"
    When "Marina Costa" desativar a hipótese
    Then a hipótese deve sair das opções de nova dispensa e as dispensas já registradas devem continuar exibindo-a

  Scenario: [Sucesso] Criar hipótese própria sempre inativa
    When "Marina Costa" criar a hipótese "ENTREGA_IMEDIATA" com base legal, ato e condição válida
    Then a API deve responder 201 com "isActive" falso e "isSystem" falso
    And deve gerar auditoria "legal_review.configure" e o evento "CatalogItemChanged" com "CREATED"

  Scenario: [Validação] Critérios, hipótese e condição inválidos
    When "Marina Costa" enviar critérios com o fator "URGENCY" repetido e peso 120
    Then a API deve responder 422 com código "VALIDATION_ERROR" e nada deve ser gravado
    When "Marina Costa" ativar "MINUTA_PADRONIZADA" sem ato nem critério objetivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" em "actReference" e em "condition"
    When "Marina Costa" criar hipótese com condição que referencia o caminho "process.inexistente"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "condition"

  Scenario: [Permissão] Sem a permissão, sem MFA e pelas rotas genéricas
    Given que "Bruno Lopes" tem "SETTINGS_MANAGE" e "CATALOG_MANAGE", mas não "LEGAL_REVIEW_CONFIGURE"
    When "Bruno Lopes" chamar "PUT /legal-review-settings/queue-criteria", "PATCH /settings" com a chave da fila e "POST /catalogs/LEGAL_WAIVER_HYPOTHESIS/items"
    Then a API deve responder 403 com código "PERMISSION_DENIED" nas três chamadas e gerar auditoria "access.denied"
    Given que a política de MFA exige e a sessão de "Marina Costa" não tem MFA
    When "Marina Costa" salvar os critérios
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Hipótese de outro órgão
    Given que a hipótese "BAIXO_VALOR" da "Prefeitura B" tem outro identificador
    When "Marina Costa" chamar "PATCH /legal-review-settings/waiver-hypotheses/{id-da-Prefeitura-B}"
    Then a API deve responder 404 com código "LEGAL_WAIVER_HYPOTHESIS_NOT_FOUND"
    And "GET /legal-review-settings" não deve conter hipótese nem critério da "Prefeitura B"

  Scenario: [Duplicidade] Código repetido, critérios iguais e hipótese já ativa
    When "Marina Costa" criar a hipótese com o código "BAIXO_VALOR"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "code"
    When "Marina Costa" salvar critérios idênticos aos vigentes
    Then a API deve responder 200 sem nova versão, sem recálculo, sem auditoria e sem evento
    Given que a hipótese "BAIXO_VALOR" já está ativa
    When "Marina Costa" ativá-la de novo
    Then a API deve responder 200 sem nova versão, sem auditoria e sem evento

  Scenario: [Concorrência] Dois administradores salvando e edição de hipótese travada
    Given que dois administradores leram a mesma versão dos critérios
    When ambos salvarem critérios diferentes ao mesmo tempo
    Then exatamente um deve receber 200 e o outro 412 com código "VERSION_CONFLICT"
    And a fila deve ter scores de uma única versão de critérios
    Given que a hipótese "BAIXO_VALOR" está ativa e já foi usada em uma dispensa
    When "Marina Costa" tentar alterar o valor máximo
    Then a API deve responder 409 com código "LEGAL_WAIVER_HYPOTHESIS_IN_USE"

  Scenario: [Falha de banco] Falha ao gravar os critérios
    Given que o banco de dados fica indisponível durante a transação de "PUT /legal-review-settings/queue-criteria"
    When "Marina Costa" salvar os critérios
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a versão dos critérios e os scores da fila devem continuar como antes, sem auditoria nem evento

  Scenario: [Falha de integração] Biblioteca de regras e relay do outbox indisponíveis
    Given que o serviço de regras não consegue resolver a versão de biblioteca da condição
    When "Marina Costa" criar uma hipótese com condição "LIBRARY"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e nada deve ser gravado
    Given que o relay do outbox está indisponível
    When "Marina Costa" salvar critérios válidos
    Then a API deve responder 200 e o evento "TenantSettingsChanged" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Critérios ou hipótese inválidos | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca os campos com `errors[]` |
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente de novo." | Recarrega LGL-05 |
| Versão divergente | 412 | `VERSION_CONFLICT` | "Os critérios foram alterados por outra pessoa. Recarregue para ver as mudanças." | Recarrega e mostra o que mudou |
| Condições de hipótese ativa | 409 | `LEGAL_WAIVER_HYPOTHESIS_ACTIVE` | "Desative a hipótese para alterar as condições." | Oferece "Desativar" |
| Condições de hipótese já usada | 409 | `LEGAL_WAIVER_HYPOTHESIS_IN_USE` | "Esta hipótese já foi usada em dispensas. Crie uma nova hipótese." | Oferece "Duplicar como nova" |
| Alterar `code` de item de sistema | 409 | `CATALOG_ITEM_SYSTEM` | "O código de um item padrão não pode ser alterado." | Campo bloqueado |
| Hipótese inexistente ou de outro tenant | 404 | `LEGAL_WAIVER_HYPOTHESIS_NOT_FOUND` | "Hipótese de dispensa não encontrada." | Recarrega a lista |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para configurar a análise jurídica." | Oculta a administração |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade (MFA) para continuar." | Abre o desafio e repete a chamada |
| Excesso de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas seguidas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco ou serviço de regras indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém o formulário; "Tentar novamente" |

## Dependências
- **Stories:** US-103 (registro tipado de chaves do tenant, `version` por chave e `TenantSettingsChanged`); US-104 (`CatalogItem`, `CatalogType` e regras de ativação/desativação); US-149 (calculador de score, recálculo e `priorityFactors.criteriaVersion` consumidos aqui). Indiretas: US-156 (usa as hipóteses ativas e avalia a `condition`), US-129 (`RuleContext` v2 e validador de `RuleRef`), US-097 (autorização), US-099 (semeadura dos modelos).
- **Decisões/ADRs:** DEC-024, DEC-199; POL-14, POL-26; RN-LGL-02, RN-LGL-08.
- **Configurações:** `legalReview.queueCriteria` (editada aqui); `inbox.bulkMaxItems` não se aplica.
- **Lacunas nas fontes canônicas:**
  1. **Dependência de US-129 não declarada:** a validação da `RuleRef` da condição usa o validador do `RuleContext` v2 (US-129) e a biblioteca de regras (EP-023), que não constam em `depends_on` da tabela de `features.md`. A story assume o validador como biblioteca compartilhada; ajustar o `depends_on` ou entregar a edição de `condition` depois. **Dúvida de produto:** liberar a hipótese só com valor máximo enquanto o editor de condições não estiver disponível?
  2. **Tipo de regra da biblioteca:** `RuleDefinitionKind` (`VALIDATION`, `ROUTING`, `APPROVAL_THRESHOLD`, `SLA`, `NOTIFICATION`) não tem tipo para condição de dispensa; a story admite `LIBRARY` com `kind = VALIDATION` (o mais próximo). A confirmar com o módulo `rules`.
  3. **Códigos de erro novos:** `LEGAL_WAIVER_HYPOTHESIS_ACTIVE`, `LEGAL_WAIVER_HYPOTHESIS_IN_USE` e `LEGAL_WAIVER_HYPOTHESIS_NOT_FOUND` não constam em `permissions.md` nem em `events.md`; a consolidar no `api.md` do MVP 2.
  4. **Porta única de escrita:** a escrita genérica (`SET-02`, `CAT-02` a `CAT-06`) precisa recusar `legalReview.queueCriteria` e o tipo `LEGAL_WAIVER_HYPOTHESIS`; o registro de chaves (US-103) precisa de permissão de escrita por chave e o catálogo (US-104) de tipo "gerido por módulo". Exige ajuste nessas duas stories do MVP 1.
  5. **Pré-requisito de ativação (`condition` ou `maxEstimatedValue`) e travas de edição (hipótese ativa ou em uso):** não constam das fontes; escolha desta story para evitar dispensa sem critério objetivo e alteração retroativa. **Dúvida de produto:** validar com a assessoria jurídica do piloto (e se o ato precisa de anexo, hoje apenas texto).
  6. **LGL-06 com `dryRun`:** a pré-visualização da feature não tem endpoint próprio nos IDs reservados; usa-se o `PUT` com `dryRun=true`. A consolidar no `api.md`.
  7. **Auditoria e chaves:** a ação `legal_review.configure` já existe em `events.md §7`; o schema do `changes` (critérios anterior/novo, `metadata` da hipótese) é definido aqui.

## Impacto técnico
- **Consistência:** gravação do `TenantSetting`, recálculo (até 1.000 análises), auditoria e outbox na mesma transação; o job só entra acima do limite.
- **Desempenho:** pré-visualização calculada em memória sobre as análises abertas (sem escrita); gravação de 500 análises < 5 s; LGL-05 p95 < 300 ms.
- **Contrato:** `legalQueueCriteriaSchema` e o `metadata` de `LEGAL_WAIVER_HYPOTHESIS` ficam em `packages/validation` e são compartilhados com a SCR-120 e com a US-149/US-156.
- **Compatibilidade:** sem mudança de contrato do MVP 1 além de SET-02 e CAT-02..06 passarem a recusar a chave e o tipo gerenciados por módulo (RN-LGL-84).
- **Sigilo:** o payload dos eventos e dos logs não leva texto de ato nem de condição; a pré-visualização não expõe valor nem faixa.

## Backend
- **Módulo(s):** `legal-review` (dono), `tenancy` (`SettingsFacade` para a chave), `catalog` (`CatalogFacade` para o item), `rules` (validador de `RuleRef`), `access`, `audit`, `platform` (outbox, jobs).
- **Casos de uso:** `GetLegalReviewSettingsQuery` (LGL-05), `UpdateLegalQueueCriteriaCommand` (LGL-06, com modo `dryRun`), `CreateWaiverHypothesisCommand` (LGL-07), `UpdateWaiverHypothesisCommand` (LGL-08), `RescoreLegalQueueJob` (acima do limite síncrono).
- **Domínio:** `LegalQueueCriteria` (schema e padrão), `WaiverHypothesis` (completude, ativação e travas), `LegalQueuePreview`.
- **Integrações internas:** `LegalQueueScoreCalculator` (US-149), `SettingsFacade`, `CatalogFacade`, `RuleRefValidator`, `OutboxWriter`, `AuditService`.
- **Transação:** LGL-06 (setting, recálculo síncrono, auditoria, outbox); LGL-07/LGL-08 (item de catálogo, auditoria, outbox).

## Frontend
- **Tela(s):** SCR-120 (`/admin/juridico`), com as abas "Critérios da fila" e "Hipóteses de dispensa".
- **Componentes:** `QueueCriteriaForm` (peso e direção por fator, "Restaurar padrão"), `QueuePreviewTable` (posição atual x nova), `WaiverHypothesisList`, `WaiverHypothesisForm` (base legal, ato, editor de condição, valor máximo), `ActivationChecklist`, `ConfirmDialog`.
- **Estados:** skeleton; vazio ("Nenhuma hipótese cadastrada" mostra os modelos); erro com "Tentar novamente"; "Reordenando a fila…" quando o job estiver rodando; aviso de pesos zerados.
- **Acessibilidade e responsividade:** peso com `input` numérico rotulado e erro associado; pré-visualização com cabeçalhos associados e mudança de posição em texto (não só seta ou cor); checklist de ativação anunciado; diálogos com foco preso; abaixo de 768 px as abas viram acordeões.

## Banco de dados
- **Tabelas:** `tenant_settings` (chave `legalReview.queueCriteria`), `catalog_items` (`catalogType = LEGAL_WAIVER_HYPOTHESIS`), leitura de `legal_reviews` (recálculo e `usageCount` por `waiver_hypothesis_id`), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova; o enum `CatalogType` com `LEGAL_WAIVER_HYPOTHESIS` e o seed dos modelos inativos vêm da migração do MVP 2 (M2-15/seed).
- **Índices/constraints relevantes:** unique `(tenant_id, catalog_type, code)` em `catalog_items`; `legal_reviews (tenant_id, waiver_hypothesis_id)` para o contador de uso (a confirmar com o card de migração).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `LGL-05` | GET | `/api/v1/legal-review-settings` | — | `200 { data: { queueCriteria: { value, default, version, isDefault }, rescoring, waiverHypotheses: [ { id, code, label, description?, isActive, isSystem, version, metadata, usageCount, canActivate, missing[] } ] } }` | 200, 401, 403, 429, 503 |
| `LGL-06` | PUT | `/api/v1/legal-review-settings/queue-criteria` | `{ criteria: [ { factor, weight, direction } ] }` + `If-Match`; `?dryRun=true` | `200 { data: { criteria, version, rescoring }, meta: { preview? } }` | 200, 401, 403, 412, 422, 428, 429, 503 |
| `LGL-07` | POST | `/api/v1/legal-review-settings/waiver-hypotheses` | `{ code, label, description?, legalBasis, actReference, condition?, maxEstimatedValue? }` + `Idempotency-Key` | `201 { data: WaiverHypothesis }` + `ETag` (sempre `isActive = false`) | 201, 401, 403, 422, 429, 503 |
| `LGL-08` | PATCH | `/api/v1/legal-review-settings/waiver-hypotheses/{id}` | `{ label?, description?, legalBasis?, actReference?, condition?, maxEstimatedValue?, isActive? }` + `If-Match` | `200 { data: WaiverHypothesis }` + `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `CAT-01` | GET | `/api/v1/catalogs/LEGAL_WAIVER_HYPOTHESIS/items` | `isActive?` (MVP 1) | leitura das hipóteses para a dispensa (US-156) | 200 |

## Logs
- `info` `legal_review.settings_updated` — `criteriaVersion`, `changedFactors[]`, `rescoredCount`, `mode` (`SYNC`, `JOB`), `durationMs`, `correlationId`.
- `info` `legal_review.waiver_hypothesis_changed` — `hypothesisId`, `code`, `change` (`CREATED`, `UPDATED`, `ACTIVATED`, `DEACTIVATED`).
- `warn` `legal_review.settings_denied` — `reasonCode`; `warn` `legal_review.rescore_job_started`.
- `error` `legal_review.settings_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** texto do ato, da base legal, da condição nem valores máximos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `legal_review.configure` | `CONFIGURATION` | Commit de LGL-06 (sem `dryRun`, com alteração) | `changes.queueCriteria`: critérios anterior e novo; `metadata`: `criteriaVersion`, `rescoredCount`, `mode` |
| `legal_review.configure` | `CONFIGURATION` | Commit de LGL-07 e LGL-08 | `changes`: campos alterados (e `isActive` anterior e novo); `metadata`: `hypothesisId`, `code`, `change` |
| `access.denied` | `ACCESS` | 403 em LGL-05 a LGL-08 e nas rotas genéricas recusadas | `reasonCode`, `target` |

## Testes necessários
- **Unitários:** schema dos critérios (quatro fatores, faixa, direção), no-op por igualdade, pré-visualização (posições antes e depois, itens ocultos), schema e completude da hipótese, travas de edição (ativa x em uso), validação de `RuleRef` (caminhos, booleana, biblioteca).
- **Integração (Testcontainers):** gravação + recálculo síncrono atômicos e rollback na falha; recálculo por job acima do limite e idempotência por `criteriaVersion`; criação, ativação e desativação com `CatalogItemChanged`; recusa de `legalReview.queueCriteria` em SET-02 e do tipo em CAT-02..06; contador `usageCount`.
- **API/contrato:** LGL-05 a LGL-08 (códigos, `ETag`, `If-Match`, `dryRun`); SET-02 e CAT-02..06 inalterados para as demais chaves e tipos.
- **RBAC e multi-tenant:** suíte "tenant leak" com LGL-05 a LGL-08; matriz de autorização (gerada) com `LEGAL_REVIEW_CONFIGURE`; MFA; ausência de processo invisível na pré-visualização.
- **Concorrência:** dois administradores salvando com a mesma versão (um efetivo); salvar x distribuição/início de análise (sem 412 espúrio); ativação x dispensa em andamento.
- **E2E (Playwright):** alterar pesos, pré-visualizar, salvar e ver a fila reordenada; completar, ativar e desativar uma hipótese.
- **Acessibilidade/performance:** axe em formulário, pré-visualização e lista; 360 px; metas de p95 na suíte de performance.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Porta única de escrita comprovada: SET-02 e CAT-02..06 recusam a chave e o tipo gerenciados por esta story
- [ ] Nenhuma hipótese ativa por padrão e nenhuma ativação sem base legal, ato e critério objetivo, comprovadas por teste
- [ ] Gherkin das 8 categorias automatizado, incluindo pré-visualização sem gravação e recálculo consistente

## Estimativa
**M** — duas áreas de configuração (critérios com recálculo e pré-visualização; hipóteses com ativação e travas) sobre mecanismos existentes de configuração e catálogo; o esforço está na consistência do recálculo, na porta única de escrita e na validação da `RuleRef`.

## Prioridade
**P0** — sem critérios configuráveis a fila usa só o padrão e sem hipóteses cadastradas a dispensa (US-156) não pode existir; bloqueia a US-156.
