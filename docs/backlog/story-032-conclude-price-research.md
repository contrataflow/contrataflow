---
id: US-032
title: "Concluir a pesquisa de preços"
epic: EP-004
feature: FT-020
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-029, US-066]
modules: [price-research, document]
screens: [SCR-009]
endpoints: [PRS-23]
permissions: [PRICE_RESEARCH_COMPLETE]
events: [PriceResearchCompleted, DocumentVersionCreated]
---

# US-032 — Concluir a pesquisa de preços

## Título
Concluir a pesquisa de preços

## Descrição
**Como** integrante da equipe de planejamento da contratação, **quero** concluir a pesquisa de preços quando todos os itens tiverem um valor defensável, **para** travar o resultado como evidência formal do processo e propagar o preço de referência para o item do processo (e para o ETP, quando houver), sem precisar copiar valores manualmente entre documentos.

Concluir a pesquisa finaliza o documento `PRICE_RESEARCH` (DEC-018): valida que todo item tem preço calculável ou justificativa para a exceção, cria a versão imutável do documento, bloqueia novas edições e atualiza `ProcessItem.referenceUnitPrice` e `Process.estimatedValue` e publica `PriceResearchCompleted`, que leva o valor ao ETP vinculado (RN-ETP-29, US-022).

## Contexto
- A fase preparatória da Lei 14.133/2021 (art. 18) exige que o orçamento estimado da contratação esteja baseado em pesquisa de preços concluída antes de seguir para a formalização do TR/edital; por isso a conclusão desta pesquisa é o gatilho que "trava" o preço de referência usado pelo restante do processo.
- `PriceResearch` não tem status próprio (DEC-017): "concluir" é finalizar o `Document` — mesmo ciclo de vida usado por DFD, ETP, TR e mapa de riscos (DEC-018), com `requiresApproval = false` nos tipos semeados, inclusive `PRICE_RESEARCH`.
- `ProcessItem.referenceUnitPrice` só é atualizado quando um documento é aprovado/finalizado (DEC-019); esta é a story que faz essa atualização para o preço, assim como `ETPApproved` atualiza o valor a partir do ETP. `Process.estimatedValue` segue a precedência de fontes de DEC-032 (citada em US-001/RN-PROC-10), na qual `PRICE_RESEARCH` tem maior precedência que `MANUAL`/`DFD`.
- Reaproveita o versionamento imutável de US-066 (snapshot com `contentHash` SHA-256) e os cálculos/alertas de US-029/US-030 para decidir o que bloqueia a conclusão.

## Objetivo
Garantir que toda pesquisa concluída tenha 100% dos itens com preço definido (calculado ou manual) ou justificativa de exceção registrada, que a conclusão seja atômica (documento + itens do processo + valor estimado do processo) e que o evento `PriceResearchCompleted` seja publicado em até 1 segundo após o commit.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`) — mesma custodiante que edita a pesquisa.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) — acompanha a conclusão como etapa do planejamento.

## Pré-condições
- Documento da pesquisa em `DRAFT` ou `RETURNED` (POL-02); pesquisa com ao menos um `PriceItem`.
- Estatísticas calculadas conforme US-029/US-030 (alertas já refletidos).
- Usuário com `PRICE_RESEARCH_COMPLETE` e custódia/participação conforme POL-02.

## Fluxo principal
1. O usuário abre a pesquisa (SCR-009), revisa os alertas (US-030) e clica em **"Concluir pesquisa"**.
2. O front envia `POST /price-research/{id}/complete` com `Idempotency-Key` e `If-Match` (versão atual do documento).
3. A API, em uma transação:
   1. autoriza `PRICE_RESEARCH_COMPLETE` + POL-02;
   2. valida a completude de cada `PriceItem` (RN-PRICE-58); se houver pendência, aborta com `422 PRICE_RESEARCH_INCOMPLETE` e `violations[]` (RN-PRICE-59) — nada é alterado;
   3. finaliza o `Document` (DRAFT/RETURNED → `FINALIZED`), cria a `DocumentVersion` (snapshot do cabeçalho + itens + fontes + cotações, `reason = FINALIZATION`);
   4. grava `PriceResearch.completedAt`/`completedById`;
   5. para cada `PriceItem`, atualiza `ProcessItem.referenceUnitPrice` e `referenceUnitPriceSourceDocumentId` (RN-PRICE-61);
   6. recalcula `Process.estimatedValue` (soma dos `totalPrice`) com `estimatedValueSource = PRICE_RESEARCH`; o ETP cujo `priceResearchId` aponta para esta pesquisa é atualizado depois, pelo consumidor de `PriceResearchCompleted` do módulo `etp` (RN-ETP-29, US-022);
   7. grava auditoria `price_research.complete` e publica `DocumentVersionCreated` e `PriceResearchCompleted` no outbox;
   8. confirma a transação.
4. A API responde `200` com a pesquisa concluída (`completedAt`, documento `FINALIZED`).
5. O front bloqueia os controles de edição da pesquisa, exibe o selo "Concluída" e o toast "Pesquisa de preços concluída — valor estimado atualizado para R$ 9.000,00" (ou "Sigiloso", conforme POL-09), atualizando o painel do processo.

## Fluxos alternativos
- **FA-01 — Pendências de completude:** a API responde `422 PRICE_RESEARCH_INCOMPLETE` com um item na lista de `violations[]` por `PriceItem` pendente; a tela lista os itens com link direto para cada um, sem bloquear a edição da pesquisa.
- **FA-02 — Item abaixo do mínimo, mas justificado:** item com `validQuotationsCount < minQuotations` e `belowMinimumJustification` preenchida não bloqueia; a conclusão segue normalmente e a justificativa fica registrada na versão.
- **FA-03 — Pesquisa com alertas pendentes (`HIGH_CV`, `HAS_OUTLIERS`, `EXPIRED_QUOTES`):** não bloqueiam a conclusão (são avisos); a tela exibe um resumo "Esta pesquisa será concluída com N item(ns) com alerta" antes da confirmação final, mas o usuário pode seguir.
- **FA-04 — Nenhum ETP vinculado à pesquisa:** nenhum `Etp` tem `priceResearchId` desta pesquisa; o consumidor de RN-ETP-29 não altera nada; apenas `Process.estimatedValue` e os `ProcessItem` são atualizados.
- **FA-05 — Reabertura após conclusão:** fora do escopo desta story (`DOCUMENT_REOPEN`, DEC-018) — reverte o documento para `DRAFT` a partir da última versão; `referenceUnitPrice`/`estimatedValue` só mudam se a pesquisa for concluída novamente.

## Regras de negócio
- **RN-PRICE-58** — Completude para concluir, por `PriceItem`: `recommendedUnitPrice` definido (calculado ou `manualUnitPrice`) **e** (`validQuotationsCount ≥ minQuotations` **ou** `belowMinimumJustification` preenchida). Item com `validQuotationsCount = 0` (alerta `NO_VALID_QUOTES`) sempre bloqueia — não há justificativa que substitua a ausência total de cotação válida.
- **RN-PRICE-59** — Violações de completude (prefixo `PRICE_*`, api.md §2.1.2 — esta story é a dona do catálogo): `PRICE_ITEM_WITHOUT_PRICE` (sem `recommendedUnitPrice`) e `PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED` (abaixo do mínimo sem justificativa); erro `422 PRICE_RESEARCH_INCOMPLETE` com `violations[]` (`itemId`, `code`, `message`, `severity = BLOCKING`) — uma entrada por item pendente, todas listadas de uma vez.
- **RN-PRICE-60** — Concluir = finalizar o `Document` (DEC-018): `DRAFT`/`RETURNED` → `FINALIZED`; cria `DocumentVersion` imutável (cabeçalho + itens + fontes + cotações, `reason = FINALIZATION`, `contentHash` SHA-256 RFC 8785 — DEC-017); bloqueia novas edições (POL-02 passa a negar `DOCUMENT_NOT_EDITABLE`); grava `PriceResearch.completedAt`/`completedById`.
- **RN-PRICE-61** — Ao concluir, para cada `PriceItem`: `ProcessItem.referenceUnitPrice = recommendedUnitPrice` (ou `manualUnitPrice` quando `MANUAL`) e `referenceUnitPriceSourceDocumentId = documentId` da pesquisa (DEC-019).
- **RN-PRICE-62** — `Process.estimatedValue` é recalculado como a soma dos `totalPrice` dos `PriceItem` da pesquisa concluída, com `estimatedValueSource = PRICE_RESEARCH` (precedência sobre `MANUAL`/`DFD` — DEC-032); o `Etp` vinculado (`priceResearchId` desta pesquisa) recebe o valor de forma assíncrona e idempotente pelo consumidor de `PriceResearchCompleted` (RN-ETP-29, US-022).
- **RN-PRICE-63** — Evento `PriceResearchCompleted` (forma tipada de `DocumentFinalized` para `PRICE_RESEARCH`) com `typedSummary: { totalEstimatedValueMasked, itemsCount, itemsWithAlertsCount }`; `totalEstimatedValueMasked` segue POL-09. Conclusão exige `Idempotency-Key` e `If-Match`; `itemsWithAlertsCount > 0` não bloqueia (alertas são avisos, não regra bloqueante), mas é registrado no `typedSummary` e na auditoria para rastreabilidade.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Justificativa de cotações insuficientes | `belowMinimumJustification` | texto longo (por item) | Condicional (RN-PRICE-58) | ≥ 20 caracteres (ver Lacunas em US-029) | — |
| *(sistema)* Conclusão | `completedAt`, `completedById` | timestamptz / uuid | — | RN-PRICE-60 | gerados |
| *(sistema)* Valor propagado | `Process.estimatedValue`, `estimatedValueSource`, `ProcessItem.referenceUnitPrice` | — | — | RN-PRICE-61/62 | gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Item sem `recommendedUnitPrice` | API | "O item \"{item}\" não tem preço calculado. Registre cotações ou um valor manual." | `PRICE_RESEARCH_INCOMPLETE` (`violations[].code = PRICE_ITEM_WITHOUT_PRICE`) |
| V-02 | Item abaixo do mínimo sem justificativa | API | "O item \"{item}\" tem menos cotações que o mínimo exigido. Informe a justificativa." | `PRICE_RESEARCH_INCOMPLETE` (`violations[].code = PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED`) |
| V-03 | Documento não está em `DRAFT`/`RETURNED` | API | "Esta pesquisa já foi concluída ou não pode ser concluída agora." | `DOCUMENT_NOT_EDITABLE` |
| V-04 | `If-Match` ausente | API | "Recarregue a página e tente novamente." | `PRECONDITION_REQUIRED` |

## Permissões
- **Permissão:** `PRICE_RESEARCH_COMPLETE` com escopo que cubra o processo (permissions.md §5).
- **Políticas:** POL-02 (documento em `DRAFT`/`RETURNED`, custódia/participação, etapa permite `PRICE_RESEARCH`, processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`).
- **MFA:** não exigido (`PRICE_RESEARCH_COMPLETE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** botão "Concluir pesquisa" não aparece; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PriceResearchCompleted` | `document.finalized.price_research` | Commit da conclusão | Forma tipada de `DocumentFinalized`; `typedSummary: { totalEstimatedValueMasked, itemsCount, itemsWithAlertsCount }` |
| `DocumentVersionCreated` | `document.version_created.price_research` | Commit da conclusão | `reason = FINALIZATION`, `contentHash` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: a conclusão é uma ação deliberada do próprio custodiante; o impacto no valor do processo aparece no painel e na timeline. Notificações de aprovação formal (quando a etapa do workflow exigir aprovação da pesquisa) pertencem ao fluxo de aprovações do processo, fora desta story. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Concluir a pesquisa de preços

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a pesquisa de preços "PR-01" do processo "0012/2026" está com o documento em "DRAFT"
    And o "Item 1" tem "recommendedUnitPrice" "100,00" e quantidade "50" (total "5000,00")
    And o "Item 2" tem "recommendedUnitPrice" "40,00" e quantidade "100" (total "4000,00")
    And o usuário "Marcos" tem "PRICE_RESEARCH_COMPLETE" e custódia do processo

  Scenario: [Sucesso] Concluir pesquisa com todos os itens completos
    When "Marcos" clicar em "Concluir pesquisa"
    Then o documento da pesquisa deve passar para o status "FINALIZED"
    And "completedAt" e "completedById" devem ser preenchidos
    And "ProcessItem.referenceUnitPrice" do "Item 1" deve ser "100,00" e do "Item 2" deve ser "40,00"
    And "Process.estimatedValue" deve ser "9000,00" com "estimatedValueSource" igual a "PRICE_RESEARCH"
    And deve gerar os eventos "PriceResearchCompleted" e "DocumentVersionCreated"
    And deve gerar registro de auditoria "price_research.complete"
    And a API deve responder 200

  Scenario: [Sucesso] Concluir com item abaixo do mínimo de cotações, mas justificado
    Given que o "Item 2" tem apenas 1 cotação válida e "belowMinimumJustification" preenchida com 25 caracteres
    When "Marcos" clicar em "Concluir pesquisa"
    Then a pesquisa deve ser concluída normalmente
    And a justificativa deve constar na versão criada do documento

  Scenario: [Validação] Item sem nenhuma cotação válida bloqueia a conclusão
    Given que o "Item 2" não tem nenhuma cotação com status "VALID"
    When "Marcos" clicar em "Concluir pesquisa"
    Then a API deve responder 422 com código "PRICE_RESEARCH_INCOMPLETE"
    And "violations[]" deve conter o código "PRICE_ITEM_WITHOUT_PRICE" para o "Item 2"
    And o documento deve permanecer em "DRAFT"

  Scenario: [Validação] Item abaixo do mínimo sem justificativa bloqueia a conclusão
    Given que o "Item 2" tem 1 cotação válida e nenhuma "belowMinimumJustification"
    When "Marcos" clicar em "Concluir pesquisa"
    Then a API deve responder 422 com código "PRICE_RESEARCH_INCOMPLETE"
    And "violations[]" deve conter o código "PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED" para o "Item 2"

  Scenario: [Permissão] Usuário sem PRICE_RESEARCH_COMPLETE
    Given que o usuário "Bruno" possui apenas "PRICE_RESEARCH_UPDATE"
    When "Bruno" enviar POST para concluir a pesquisa "PR-01"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PRICE_RESEARCH_COMPLETE"
    And o documento deve permanecer em "DRAFT"

  Scenario: [Tenant incorreto] Concluir pesquisa de outro tenant
    When "Marcos", no tenant "Prefeitura de São José", enviar POST para concluir uma "priceResearchId" existente apenas na "Prefeitura B"
    Then a API deve responder 404 com código "PRICE_RESEARCH_NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser lido ou alterado

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Marcos" concluiu a pesquisa "PR-01" com a chave de idempotência "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas uma "DocumentVersion" criada pela conclusão

  Scenario: [Concorrência] If-Match divergente por edição concorrente
    Given que outra pessoa alterou uma cotação da pesquisa "PR-01" após "Marcos" abrir a tela
    When "Marcos" enviar a conclusão com o "If-Match" da versão antiga
    Then a API deve responder 412 com código "VERSION_CONFLICT" e "currentVersion" atual
    And nenhuma alteração deve ser persistida

  Scenario: [Falha de banco] Banco indisponível durante a conclusão
    Given que o banco de dados fica indisponível no meio da transação de conclusão
    When "Marcos" clicar em "Concluir pesquisa"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o documento, os "ProcessItem" e o "Process.estimatedValue" devem permanecer como estavam antes
    And nenhum evento deve ser publicado

  Scenario: [Falha de integração] Outbox indisponível ao publicar a conclusão
    Given que o relay do outbox está indisponível
    When "Marcos" concluir a pesquisa "PR-01" com sucesso
    Then a pesquisa deve ser concluída e a API deve responder 200
    And os eventos "PriceResearchCompleted" e "DocumentVersionCreated" devem permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Item sem preço | 422 | `PRICE_RESEARCH_INCOMPLETE` | "Há itens sem preço definido. Revise antes de concluir." | Lista os itens com link direto |
| Item abaixo do mínimo sem justificativa | 422 | `PRICE_RESEARCH_INCOMPLETE` | "Há itens com cotações insuficientes sem justificativa." | Lista os itens com link ao campo de justificativa |
| Documento não editável/já concluído | 409 | `DOCUMENT_NOT_EDITABLE` | "Esta pesquisa já foi concluída ou não pode ser concluída agora." | Mostra o estado atual; esconde o botão |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega antes de reenviar |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Esta pesquisa foi alterada por outra pessoa. Recarregue para revisar." | Recarrega os dados |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para concluir esta pesquisa." | Esconde o botão |
| Requisição idêntica em processamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "Estamos concluindo a pesquisa. Aguarde." | Repete a consulta após 2 s |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém a pesquisa em `DRAFT`; botão "Tentar novamente" |

## Dependências
- **Stories:** US-029 (estatísticas e preço recomendado), US-030 (alertas consultados antes de concluir, não bloqueantes), US-066 (versionamento imutável), US-065 (ciclo de vida do documento). Impacta US-039 (comparação de quantidade ETP × TR não é afetada, mas o valor do ETP é sincronizado).
- **Decisões/ADRs:** DEC-017, DEC-018 (ciclo de vida do documento e finalização), DEC-019 (atualização de `referenceUnitPrice`), DEC-020 (estatísticas), DEC-030/POL-09 (sigilo), DEC-032 (precedência de fontes do valor estimado).
- **Configurações:** nenhuma nova; reaproveita `priceResearch.minQuotations` (US-029).
- **Lacunas nas fontes canônicas:** nenhuma (sincronização do ETP vinculado definida em US-022, RN-ETP-29, sobre `Etp.estimatedTotalValue`/`estimatedValueSource`/`priceResearchId`). Decisões da implementação: `belowMinimumJustification` é gravada pelo PRS-07 (api/07); o 404 do PRS-23 é `PRICE_RESEARCH_NOT_FOUND` (cenário [Tenant incorreto]); `If-Match` = versão da pesquisa (o `ETag` do PRS-03, que sobe a cada gravação de cotação — cenário [Concorrência]); com `estimatedValueSource = TERM` o valor do processo é mantido (DEC-032) e só os itens recebem o preço de referência.

## Impacto técnico
- Reaproveita o padrão `TransactionalCommandHandler` (US-001): autorização por escopo → validação de completude → domínio (finalização do documento + propagação de valor) → auditoria → outbox → commit; a propagação para `ProcessItem`/`Process` deve ocorrer na **mesma** transação da finalização, nunca por evento assíncrono (para não haver janela em que o documento está `FINALIZED` com valores desatualizados no processo); o `Etp` é atualizado pelo consumidor do evento (RN-ETP-29), com consistência eventual.
- `Process.estimatedValue`/`ProcessItem.referenceUnitPrice` só podem ser escritos pelo serviço de conclusão (ou pelos equivalentes de DFD/ETP) — nunca por `PATCH` direto, mantendo a mesma garantia de DEC-013/DEC-019.
- Conclusão é uma operação rara por pesquisa (uma vez, salvo reabertura); não há requisito de alta concorrência, mas a transação deve permanecer curta mesmo com muitos itens (reaproveitar os mesmos agregados já calculados por US-029, sem recalcular tudo de novo na conclusão).

## Backend
- **Módulo(s):** `price-research` (dono); usa `document` (`DocumentLifecycleService.finalize`), `process` (`ProcessItemFacade.updateReferencePrice`, atualização de `estimatedValue`), `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CompletePriceResearchCommand` → `CompletePriceResearchHandler`.
- **Domínio:** `PriceResearch.complete(items)` valida RN-PRICE-58/59 e emite `PriceResearchCompleted`; `Document.finalize()` (DEC-018); `ProcessItem.updateReferenceUnitPrice(value, sourceDocumentId)` (DEC-019).
- **Integrações internas:** `process` para atualizar `ProcessItem`/`Process.estimatedValue`; `document` para a transição de status e criação de versão (US-066); ETP vinculado via fachada do módulo `etp` (fora de EP-004).
- **Transação:** passos 3.1–3.8 do fluxo principal em uma única transação; isolamento `READ COMMITTED`.

## Frontend
- **Tela(s):** SCR-009 (`/processos/[id]/pesquisa-precos/[researchId]`).
- **Componentes:** `CompleteResearchDialog` (resumo de itens pendentes/alertas antes de confirmar), `IncompleteItemsList` (links aos itens com `violations[]`), `CompletedBadge`.
- **Estados:** loading (botão "Concluindo…"), erro (lista de pendências ou toast com `correlationId`), sucesso (selo "Concluída" + toast com valor atualizado).
- **Acessibilidade e responsividade:** foco movido para a lista de pendências quando houver erro; diálogo de confirmação navegável por teclado.

## Banco de dados
- **Tabelas escritas:** `documents`, `document_versions`, `price_research`, `process_items`, `processes`, `audit_logs`, `outbox_events` (e, quando houver ETP vinculado, a tabela de cabeçalho do ETP).
- **Migrações:** nenhuma (todas as colunas envolvidas já existem desde US-001/US-024/US-029/US-066).
- **Índices/constraints relevantes:** nenhum novo; reaproveita `UNIQUE (tenant_id, process_id, singleton_key) WHERE … AND status <> 'CANCELED'` em `documents` e os checks já existentes de `price_items`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRS-23 | POST | `/price-research/{id}/complete` | `{}` + `If-Match` + `Idempotency-Key` | `200 { data: PriceResearch }` com `completedAt`, `document: { status: "FINALIZED", currentVersionId }` | 200, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `price_research.completed` — `priceResearchId`, `documentVersionId`, `itemsCount`, `itemsWithAlertsCount`, `durationMs`, `correlationId`.
- `warn` `price_research.etp_sync_skipped` — quando não há ETP vinculado para sincronizar.
- `error` `price_research.complete_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** valores unitários/totais, justificativas de exceção.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `price_research.complete` | `DATA_CHANGE` | Commit da conclusão | `changes`: `estimatedValue` anterior/novo (ou hash+mascarado se sigiloso); `metadata`: `documentVersionId`, `itemsCount`, `itemsWithAlertsCount`, `idempotencyKey` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = PRICE_RESEARCH_COMPLETE` |

## Testes necessários
- **Unitários:** `PriceResearch.complete` com todos os itens completos, com exceção justificada, e com cada violação (RN-PRICE-58/59); cálculo da soma de `totalPrice`.
- **Integração (Testcontainers):** atomicidade (falha simulada após finalizar o documento → `ProcessItem`/`Process` não mudam e o documento volta a `DRAFT`); sincronização do valor do ETP vinculado; `DocumentVersion` com `contentHash` estável.
- **API/contrato:** `PRS-23` conforme api.md; cabeçalhos `If-Match`, `Idempotency-Key`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** `PRICE_RESEARCH_COMPLETE` ausente → 403; pesquisa de outro tenant → 404.
- **Concorrência:** duas conclusões simultâneas da mesma pesquisa → uma 200, outra 412 ou replay idempotente.
- **E2E (Playwright):** concluir pesquisa completa e ver o valor estimado atualizado no painel do processo; tentar concluir com pendência e navegar pelos links de erro.
- **Acessibilidade/performance:** axe no diálogo de confirmação; conclusão de pesquisa com 500 itens → p95 < 1,5 s.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PRICE_RESEARCH_COMPLETE` e POL-02 aplicados na API; botão oculto sem permissão
- [ ] Transação única comprovada por teste de falha induzida (documento + itens + processo)
- [ ] Auditoria `price_research.complete` e eventos `PriceResearchCompleted`/`DocumentVersionCreated` verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRS-23 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de duração da conclusão
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — a lógica de completude é direta, mas a propagação atômica para `ProcessItem`, `Process.estimatedValue` e o ETP vinculado, somada ao versionamento imutável, exige testes de integração cuidadosos.

## Prioridade
**P0** — sem a conclusão não há preço de referência oficial para o processo seguir para o TR/edital.
