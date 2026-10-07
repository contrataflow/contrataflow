---
id: US-038
title: "Especificar itens e condições contratuais do TR"
epic: EP-006
feature: FT-026
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-006, US-036]
modules: [term, document, process, catalog, access, audit, platform]
screens: [SCR-012]
endpoints: [TRM-04, DOC-06, DOC-07, PRC-13, CAT-01]
permissions: [TERM_UPDATE, PROCESS_VIEW]
events: []
---

# US-038 — Especificar itens e condições contratuais do TR

## Título
Especificar itens e condições contratuais do TR

## Descrição
**Como** analista de planejamento (ou profissional de compras) responsável pelo TR, **quero** selecionar os itens da contratação e especificar suas condições contratuais tipadas, **para** que o TR reúna, de forma estruturada, tudo que a Lei 14.133/2021 exige para seguir à seleção do fornecedor: quantidades, especificações, critérios de aceitação, vigência, prazos, pagamento, garantias, subcontratação, critério de julgamento e tipo de adjudicação.

Itens e condições são editados em dois painéis do mesmo editor (SCR-012). O painel **"Itens"** lista os itens ativos do processo (US-006) e permite incluir cada um no TR com quantidade, especificação e critérios de aceitação em rich text. O painel **"Condições contratuais"** é um formulário com os campos tipados do cabeçalho do TR (vigência, prazos, local, pagamento, garantias, subcontratação, critério de julgamento, adjudicação). Ambos seguem a mesma política de edição do restante do documento (POL-02) e **não** criam versão a cada alteração — são ajustes de rascunho (DEC-017); a versão é criada na conclusão (US-039).

## Contexto
- A story-036 criou o TR e seu editor de seções, mas deixou as condições contratuais tipadas e os itens explicitamente para esta story ("as condições contratuais tipadas ficam em US-038").
- Base legal: quantidades e especificações (art. 6º, XXIII, b/d), vigência e prazos (arts. 105–111), garantia contratual limitada a 10% do valor (arts. 96–98), subcontratação (art. 122), critério de julgamento (art. 33) e tipo de adjudicação.
- DEC-019 define `DocumentItem` como a linha do item **neste** documento (quantidade, especificação, critérios de aceitação), separada do `ProcessItem` (identidade do item, mantido por US-006) e do `PriceItem` (pesquisa de preços) — evita duplicar o conceito de item entre DFD, ETP e TR.
- Quantidades podem já vir preenchidas pela importação do ETP (US-037); esta story cobre tanto a entrada manual quanto o ajuste do que foi importado.

## Objetivo
Garantir que todo TR concluído tenha, para cada item selecionado, quantidade e especificação registradas, e que as condições contratuais estejam dentro dos limites legais (vigência, prazos, garantias) antes de seguir para a validação de completude (US-039).

## Persona
- **Principal:** Planejamento (perfil `PLANEJAMENTO`) e Compras (`COMPRAS`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), Área requisitante (`REQUISITANTE`) quando custodia o TR; Consultoria externa (`CONSULTOR_EXTERNO`) como participante `COLLABORATOR`/`CONSULTANT`.

## Pré-condições
- TR criado (US-036), em `DRAFT`/`RETURNED`, sob custódia ou participação do usuário (POL-02).
- Processo possui ao menos um item ativo cadastrado (US-006), quando a contratação tiver itens.
- Usuário com `TERM_UPDATE` cobrindo o processo.
- Catálogo `JUDGMENT_CRITERION` com itens ativos do tenant (US-104).

## Fluxo principal
1. No editor do TR, o usuário abre o painel **"Itens"**.
2. O sistema chama `PRC-13` (itens ativos do processo) e `DOC-06` (itens já incluídos no TR) e mostra a lista combinada, indicando quais já estão no TR.
3. O usuário marca os itens desejados, informa **quantidade** (pré-preenchida se vier de uma importação — US-037), **especificação** e **critérios de aceitação** (rich text) e ajusta a ordem por arrastar.
4. Ao salvar, o front envia `PUT` para `DOC-07` com a lista completa de itens e `If-Match` da versão do documento; a API substitui as linhas de `DocumentItem` do TR em uma transação e audita `document.items_update`.
5. O usuário abre o painel **"Condições contratuais"**; o sistema chama `CAT-01` para as opções de critério de julgamento.
6. O usuário preenche vigência, prazo de execução/entrega e seu tipo de contagem, local de entrega, prazo de pagamento, garantias, subcontratação, critério de julgamento e tipo de adjudicação.
7. Ao salvar, o front envia `PATCH` para `TRM-04` com os campos alterados e `If-Match`; a API valida os limites (RN-TR-28 a RN-TR-32) e grava no cabeçalho tipado, auditando `document.draft_update`.
8. O indicador de completude do TR (US-036/US-039) é recalculado e refletido no painel lateral do editor.

## Fluxos alternativos
- **FA-01 — Remover item do TR:** desmarcar um item e salvar remove a linha de `DocumentItem` do TR; o `ProcessItem` do processo não é afetado.
- **FA-02 — Item referenciado não pode ser excluído do processo:** enquanto um item estiver no TR (ou em qualquer outro documento), excluí-lo em US-006 é bloqueado com 409 `ITEM_IN_USE`; o item só some do processo depois de removido de todos os documentos.
- **FA-03 — Reordenar itens:** arrastar uma linha atualiza `sortOrder` de todas as linhas afetadas em uma única chamada.
- **FA-04 — Prazo de execução sem tipo de contagem:** o usuário informa `executionDeadline` sem escolher `BUSINESS`/`CALENDAR`; o formulário bloqueia o salvamento até o tipo ser escolhido.
- **FA-05 — Catálogo de critério de julgamento indisponível:** o seletor exibe "Não foi possível carregar as opções. Tentar novamente."; os demais campos permanecem editáveis e salváveis.
- **FA-06 — Edição concorrente das condições:** ver cenário de concorrência nos critérios de aceite.

## Regras de negócio
- **RN-TR-25** — Os itens do TR espelham o catálogo de itens do processo (`ProcessItem`, US-006): cada item ativo do processo pode ter uma linha `DocumentItem` no TR; incluir ou remover no TR não altera o `ProcessItem`.
- **RN-TR-26** — `quantity` é obrigatória (> 0, até 4 casas decimais) para cada item incluído; `specification` e `acceptanceCriteria` em rich text (TipTap/ProseMirror, DEC-056; até 50.000 caracteres e 1 MB cada); `notes` é texto livre opcional (até 5.000 caracteres).
- **RN-TR-27** — Edição de itens segue POL-02 (`TERM_UPDATE` + custódia **ou** participação `COLLABORATOR`/`CONSULTANT` + TR `DRAFT`/`RETURNED` + tipo permitido na etapa + processo editável); unicidade `(tenant_id, document_id, process_item_id)`; item de outro processo ou tenant → 422 `REFERENCE_NOT_FOUND`; item inativo → `REFERENCE_INACTIVE`.
- **RN-TR-28** — Vigência do contrato (`contractDurationMonths`): opcional, entre 1 e 120 meses.
- **RN-TR-29** — Prazo de execução/entrega: `executionDeadline` e `executionDeadlineType` (`DayCountType`: `BUSINESS`/`CALENDAR`) são obrigatórios em conjunto — um exige o outro; `deliveryLocation` é texto livre, independente dos dois.
- **RN-TR-30** — Prazo de pagamento (`paymentTermDays`): opcional, entre 1 e 90 dias.
- **RN-TR-31** — Garantias (Lei 14.133, arts. 96–98): `productWarrantyMonths` (garantia do objeto) entre 0 e 120 meses; `contractGuaranteePercent` (garantia contratual) entre 0 e 10%; `allowsSubcontracting` booleano, padrão falso.
- **RN-TR-32** — Critério de julgamento (`selectionCriterionId`, catálogo `JUDGMENT_CRITERION`, art. 33) e tipo de adjudicação (`awardType`: `BY_ITEM`/`BY_LOT`/`GLOBAL`); o catálogo referenciado deve ser item ativo do tenant.
- **RN-TR-33** — Alterar itens ou condições contratuais não cria nova versão do documento (ajuste de rascunho — DEC-017); é registrado em auditoria coalescida: `document.items_update` (itens) e `document.draft_update` (condições).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Item incluído | `items[].processItemId` | seleção (itens do processo) | Sim por linha incluída | item ativo do processo e do tenant | — |
| Quantidade | `items[].quantity` | número decimal | Sim por linha incluída | > 0; até 4 casas | quantidade do ETP, se importado (US-037) |
| Especificação | `items[].specification` | rich text | Não | até 50.000 caracteres/1 MB | memória do ETP, se importado |
| Critérios de aceitação | `items[].acceptanceCriteria` | rich text | Não | até 50.000 caracteres/1 MB | — |
| Observações do item | `items[].notes` | texto longo | Não | até 5.000 caracteres | — |
| Ordem | `items[].sortOrder` | número (arrastar) | Não | — | ordem de inclusão |
| Vigência do contrato (meses) | `contractDurationMonths` | número | Não | 1–120 | — |
| Prazo de execução/entrega | `executionDeadline` | número | Condicional (RN-TR-29) | exige `executionDeadlineType` | — |
| Tipo de contagem do prazo | `executionDeadlineType` | seleção (`DayCountType`) | Condicional (RN-TR-29) | `BUSINESS`/`CALENDAR` | — |
| Local de entrega | `deliveryLocation` | texto longo | Não | — | — |
| Prazo de pagamento (dias) | `paymentTermDays` | número | Não | 1–90 | — |
| Garantia do objeto (meses) | `productWarrantyMonths` | número | Não | 0–120 | — |
| Garantia contratual (%) | `contractGuaranteePercent` | percentual | Não | 0–10 (arts. 96–98) | — |
| Permite subcontratação | `allowsSubcontracting` | interruptor | Não | — | falso |
| Critério de julgamento | `selectionCriterionId` | seleção (catálogo `JUDGMENT_CRITERION`) | Não | item ativo (art. 33) | — |
| Tipo de adjudicação | `awardType` | seleção (`AwardType`) | Não | `BY_ITEM`/`BY_LOT`/`GLOBAL` | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Quantidade ausente, zero/negativa ou com mais de 4 casas | Front + API | "Informe uma quantidade válida, maior que zero." | `VALIDATION_ERROR` (`INVALID_DECIMAL`/`OUT_OF_RANGE`) |
| V-02 | Item repetido na lista enviada | API | "Este item já está na lista." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-03 | Item inexistente, inativo ou de outro processo/tenant | API | "Selecione um item válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | Rich text fora do schema permitido | API | "Conteúdo não suportado no editor." | `RICH_TEXT_INVALID` |
| V-05 | Prazo de execução sem o tipo de contagem (ou vice-versa) | Front + API | "Informe o tipo de contagem do prazo." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-06 | Vigência fora de 1–120 meses | Front + API | "A vigência deve estar entre 1 e 120 meses." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-07 | Prazo de pagamento fora de 1–90 dias | Front + API | "O prazo de pagamento deve estar entre 1 e 90 dias." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-08 | Garantia contratual fora de 0–10% | Front + API | "A garantia contratual não pode superar 10% (arts. 96–98)." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-09 | Critério de julgamento inexistente/inativo | API | "Selecione um critério de julgamento válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-10 | TR não está em `DRAFT`/`RETURNED` | API | "O TR não pode ser editado no status atual." | `DOCUMENT_NOT_EDITABLE` |
| V-11 | Tipo TR não permitido na etapa atual | API | "O TR não pode ser editado nesta etapa." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-12 | `If-Match` divergente | API | "O TR foi alterado por outra pessoa. Recarregue para continuar." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `TERM_UPDATE` com escopo que cubra o processo (permissions.md §2.3).
- **Políticas:** POL-02 (custódia **ou** participação `COLLABORATOR`/`CONSULTANT` + TR `DRAFT`/`RETURNED` + tipo permitido na etapa + processo editável) — vale para o cabeçalho e para a coleção `DocumentItem`.
- **MFA:** não exigido (`TERM_UPDATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** os painéis "Itens" e "Condições contratuais" ficam somente leitura; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio: alterações de itens e condições são ajuste de rascunho (RN-TR-33), registradas só em auditoria. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: ajustes de rascunho não notificam (mesmo padrão de RN-TR-15). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Especificar itens e condições contratuais do TR

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" tem os itens ativos "1 — Cimento CP-II" e "2 — Areia média"
    And o processo tem um TR em "DRAFT"
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO" e custódia do TR

  Scenario: [Sucesso] Incluir itens com quantidade e especificação
    When "Carla" incluir os itens "1" e "2" no TR com quantidade "100" e "50" e especificação preenchida
    Then o TR deve ter 2 itens com as quantidades informadas
    And deve gerar registro de auditoria "document.items_update"

  Scenario: [Sucesso] Definir as condições contratuais
    When "Carla" informar vigência "12" meses, prazo de entrega "30" dias corridos, pagamento em "30" dias, garantia contratual "5", critério "MENOR_PRECO" e adjudicação "BY_ITEM"
    Then o TR deve salvar as condições informadas
    And deve gerar registro de auditoria "document.draft_update"

  Scenario: [Validação] Quantidade inválida
    When "Carla" informar quantidade "0" para o item "1"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "quantity"

  Scenario: [Validação] Prazo de execução sem o tipo de contagem
    When "Carla" informar "executionDeadline" sem informar "executionDeadlineType"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "executionDeadlineType"

  Scenario: [Validação] Garantia contratual acima do limite legal
    When "Carla" informar "contractGuaranteePercent" igual a "15"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" no campo "contractGuaranteePercent"

  Scenario: [Permissão] Usuário sem TERM_UPDATE
    Given que "Bruno" não possui "TERM_UPDATE" para o processo
    When "Bruno" enviar PATCH para as condições do TR
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Item de outro tenant
    When "Carla" enviar um "processItemId" pertencente ao tenant "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "processItemId"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Item repetido na lista enviada
    When "Carla" enviar o item "1" duas vezes na lista de itens do TR
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DUPLICATE_IN_LIST"

  Scenario: [Concorrência] Edição simultânea das condições contratuais
    Given que "Carla" carregou o TR na versão "2"
    When outro usuário salvar as condições, criando a versão "3"
    And "Carla" enviar PATCH com "If-Match: \"2\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao salvar itens
    Given que o banco de dados fica indisponível durante a transação
    When "Carla" salvar a lista de itens
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum item do TR deve ser alterado

  Scenario: [Falha de integração] Catálogo de critério de julgamento indisponível
    Given que o serviço de catálogos está indisponível
    When "Carla" abrir o painel de condições contratuais
    Then o sistema deve exibir "Não foi possível carregar as opções. Tentar novamente." no campo "Critério de julgamento"
    And os demais campos devem permanecer editáveis e salváveis
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Quantidade inválida | 422 | `VALIDATION_ERROR` | "Informe uma quantidade válida, maior que zero." | Marca o campo na linha do item |
| Item repetido na lista | 422 | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) | "Este item já está na lista." | Remove a duplicata antes de reenviar |
| Item inexistente/inativo/outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um item válido." | Recarrega a lista de itens |
| Rich text inválido | 422 | `RICH_TEXT_INVALID` | "Conteúdo não suportado no editor." | Reverte para o último conteúdo válido |
| Condição fora do limite legal | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | "O valor informado está fora do limite permitido." | Marca o campo; exibe o limite |
| TR não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "O TR não pode ser editado no status atual." | Painéis ficam somente leitura |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O TR não pode ser editado nesta etapa." | Painéis ficam somente leitura |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar este TR." | Painéis somente leitura |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "O TR foi alterado por outra pessoa. Recarregue para continuar." | Oferece "Ver versão atual" |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém os dados preenchidos |

## Dependências
- **Stories:** US-006 (itens do processo), US-036 (cria o TR e o editor). Indiretas: US-037 (quantidades podem vir da importação do ETP), US-104 (catálogo `JUDGMENT_CRITERION`). Habilita: US-039.
- **Decisões/ADRs:** DEC-001, DEC-017, DEC-019, DEC-056, DEC-104; ADR-006.
- **Configurações:** nenhuma específica desta story.
- **Lacunas nas fontes canônicas:** nenhuma — campos e limites seguem entities.md §4.8; a proteção contra remoção de item em uso é a já documentada `ITEM_IN_USE` (api.md §2.2).

## Impacto técnico
- Reaproveita a mesma coleção `DocumentItem` e os mesmos endpoints genéricos (`DOC-06`/`DOC-07`) já usados por DFD (US-014) e ETP (US-022); nenhuma entidade ou migração nova.
- `sortOrder` definido aqui é o mesmo usado na renderização do PDF (US-067) e na impressão do TR — alterar a ordem não gera versão, mas afeta a próxima geração de rendition.
- Validações de faixa (vigência, prazos, garantias) ficam no mesmo `UpdateTermConditionsCommand`, reaproveitável caso o MVP 5 introduza sugestões por IA.

## Backend
- **Módulo(s):** `term` (dono das condições); usa `document` (coleção `DocumentItem`, reaproveitada de US-014/US-022), `process` (leitura de `ProcessItem` via `PRC-13`), `catalog` (`CatalogFacade.assertActive`), `access`, `audit`.
- **Casos de uso:** `UpdateTermConditionsCommand` → `UpdateTermConditionsHandler` (`TRM-04`); `ReplaceDocumentItemsCommand` → `ReplaceDocumentItemsHandler` (genérico, `DOC-07`).
- **Domínio:** `TermOfReference.updateConditions(fields)` (aplica RN-TR-28..32); `DocumentItem.replaceCollection(items)` (upsert por `processItemId`, remove os ausentes).
- **Integrações internas:** `ProcessItemFacade.listActive(processId)`; `CatalogFacade.assertActive('JUDGMENT_CRITERION', id)`; `AuthorizationService.assertCan('TERM_UPDATE', { processId })`.
- **Transação:** `PATCH` das condições e `PUT` dos itens são comandos independentes, cada um atômico (valida → grava cabeçalho/coleção → audita → commit); nenhum dos dois cria `DocumentVersion`.

## Frontend
- **Tela(s):** SCR-012 (`/processos/[id]/tr/[termId]`), painéis "Itens" e "Condições contratuais".
- **Componentes:** `ItemsPickerTable` (seleção + quantidade + arrastar), `RichTextCell` (especificação/critérios de aceitação inline), `ConditionsForm` (React Hook Form + `zodResolver`), `JudgmentCriterionSelect` (`CAT-01`), `AwardTypeSelect`, `DayCountFieldset`.
- **Estados:** skeleton ao carregar itens/catálogo; vazio ("Nenhum item cadastrado no processo — adicione em Itens do processo"); erro de catálogo com "Tentar novamente"; indicador "Salvando…/Salvo" por painel.
- **Acessibilidade e responsividade:** tabela de itens navegável por teclado (seleção e reordenar com atalhos, alternativa ao arrastar); rótulos associados a cada campo; em telas < 768 px a tabela de itens vira cartões por item.

## Banco de dados
- **Tabelas:** `document_items` (upsert/remoção pela nova lista), `terms_of_reference` (update das condições), `audit_logs`.
- **Migrações:** nenhuma — reaproveita entidades existentes (entities.md §4.8).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id, process_item_id)` em `document_items`; `CHECK (contract_guarantee_percent BETWEEN 0 AND 10)` e `CHECK (execution_deadline IS NULL OR execution_deadline_type IS NOT NULL)` em `terms_of_reference`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TRM-04` | PATCH | `/terms/{id}` | `{ contractDurationMonths?, executionDeadline?, executionDeadlineType?, deliveryLocation?, paymentTermDays?, productWarrantyMonths?, contractGuaranteePercent?, allowsSubcontracting?, selectionCriterionId?, awardType? }` + `If-Match` | `200 { data: TermOfReference }` | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| `DOC-06` | GET | `/documents/{id}/items` | — | `200 { data: [{ processItemId, sequence, description, unit, quantity, specification, acceptanceCriteria, notes, sortOrder }] }` | 200, 403, 404 |
| `DOC-07` | PUT | `/documents/{id}/items` | `{ items: [{ processItemId, quantity, specification?, acceptanceCriteria?, notes?, sortOrder }] }` + `If-Match` | `200 { data: [...] }` | 200, 403, 404, 409, 412, 422 |
| `PRC-13` | GET | `/processes/{id}/items` | — | `200 { data: [{ id, sequence, description, unit, kind }] }` | 200, 403, 404 |
| `CAT-01` | GET | `/catalogs/{catalogType}/items` | `catalogType = JUDGMENT_CRITERION` | `200 { data: [{ id, code, label, metadata }] }` | 200 |

## Logs
- `info` `document.items_updated` — `documentId`, `itemsCount`, `durationMs`.
- `info` `term.conditions_updated` — `termId`, `fieldsChanged[]`, `durationMs`.
- `warn` `rich_text.schema_rejected` — nó/mark desconhecido.
- `error` `term.update_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** especificação, critérios de aceitação, observações do item, local de entrega.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.items_update` | `DATA_CHANGE` | Commit do `PUT` de itens | `changes`: itens incluídos/removidos/alterados (quantidades; texto como hash + tamanho); `metadata`: `itemsCount` |
| `document.draft_update` | `DATA_CHANGE` (coalescida, 10 min) | Commit do `PATCH` das condições | `changes`: campos alterados e novos valores (não sensíveis) |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = TERM_UPDATE` |

## Testes necessários
- **Unitários:** faixas de validação (vigência, pagamento, garantias); obrigatoriedade condicional de `executionDeadlineType`; replace da coleção de itens (upsert/remoção).
- **Integração (Testcontainers PostgreSQL):** unicidade `(tenant_id, document_id, process_item_id)`; `ITEM_IN_USE` ao tentar excluir item referenciado (US-006); RLS entre tenants.
- **API/contrato:** respostas e erros de `TRM-04`/`DOC-06`/`DOC-07` conforme api.md; cabeçalhos `If-Match`.
- **RBAC e multi-tenant:** `TERM_UPDATE` por perfil e escopo; item/catálogo de outro tenant → `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas edições simultâneas das condições com o mesmo `If-Match` → uma 200, outra 412.
- **E2E (Playwright):** incluir itens, especificar, reordenar, preencher condições e verificar o indicador de completude.
- **Acessibilidade/performance:** axe sem violações sérias nos dois painéis; salvar 50 itens em lote com p95 < 500 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `TERM_UPDATE` e POL-02 aplicados na API; painéis somente leitura sem permissão
- [ ] Limites legais (vigência, prazos, garantias) cobertos por teste automatizado
- [ ] Auditoria `document.items_update`/`document.draft_update` verificada em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `TRM-04`/`DOC-06`/`DOC-07` compatível com api.md
- [ ] Logs sem dados sensíveis
- [ ] Painéis acessíveis (axe) e responsivos (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card) atualizada

## Estimativa
**M** — reaproveita endpoints e coleções já existentes (`DOC-06`/`DOC-07`, `TRM-04`); a complexidade está no conjunto de validações tipadas e na tabela de itens, sem novas entidades.

## Prioridade
**P0** — sem itens especificados e condições contratuais, o TR não tem conteúdo suficiente para seguir à fase de seleção do fornecedor.
