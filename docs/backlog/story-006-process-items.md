---
id: US-006
title: "Gerenciar itens da contratação"
epic: EP-001
feature: FT-004
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-001, US-104]
modules: [process, catalog, document, price-research, timeline, audit, platform]
screens: [SCR-006]
endpoints: [PRC-13, PRC-14, PRC-15, PRC-16, PRC-17, CAT-01]
permissions: [PROCESS_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [ProcessItemsChanged]
---

# US-006 — Gerenciar itens da contratação

## Título
Gerenciar os itens da contratação

## Descrição
**Como** servidor que está com o processo, **quero** cadastrar, editar, agrupar em lotes, reordenar e excluir os itens da contratação, **para** que DFD, ETP, pesquisa de preços e TR trabalhem sobre a mesma lista canônica de itens, sem redigitação nem divergência de descrição e unidade.

A aba **Itens** do detalhe (SCR-006) mostra a lista canônica (`ProcessItem`) agrupada por lote, com número sequencial, descrição, natureza, unidade de medida, código CATMAT/CATSER opcional e — somente leitura — a quantidade e o preço unitário de referência com a indicação do documento de origem. Cada alteração gera `ProcessItemsChanged`, a entrada `ITEMS_CHANGED` na timeline e a auditoria `process.items_update`, na mesma transação.

## Contexto
- Hoje cada documento repete a lista de itens; quantidades e descrições divergem entre DFD, ETP e TR, o que gera devoluções e achados do controle (personas P04 e P09).
- DEC-019: `ProcessItem` é a identidade do item; quantidades e especificações por documento ficam em `DocumentItem`; preços da pesquisa em `PriceItem`. `referenceQuantity`/`referenceUnitPrice` só mudam quando um documento com itens é aprovado/finalizado (US-017, US-023, US-039) ou a pesquisa é concluída (US-032).
- Catálogo de unidades de medida por tenant (DEC-027, `UNIT_OF_MEASURE`); catálogo eletrônico de padronização federal (Lei 14.133, art. 19, II) refletido no código CATMAT/CATSER opcional.
- Custódia (POL-01) e concorrência otimista (DEC-055, DEC-104) valem como na edição do processo (US-005).

## Objetivo
Permitir manter até 1.000 itens por processo com resposta < 400 ms (p95) por operação, garantindo números de item únicos e estáveis, nenhuma exclusão de item referenciado por documento ou pesquisa e 100% das alterações auditadas e refletidas na timeline.

## Persona
- **Principal:** Área requisitante (`REQUISITANTE`) — define os itens ao formalizar a demanda.
- **Secundárias:** Planejamento (`PLANEJAMENTO`) — refina itens e lotes no ETP/TR; Compras (`COMPRAS`) — ajusta descrições e códigos CATMAT/CATSER para a pesquisa; Gestor de contratações (`GESTOR_CONTRATACOES`) com custódia.

## Pré-condições
- Processo visível; usuário com `PROCESS_UPDATE` no escopo e custódia (POL-01); processo em `DRAFT`, `IN_PROGRESS` ou `RETURNED`.
- Catálogo `UNIT_OF_MEASURE` com itens ativos (US-104).

## Fluxo principal
1. O usuário abre a aba **Itens** (SCR-006, `?aba=itens`); o front consulta `GET /processes/{id}/items` (PRC-13) e guarda o `ETag` (versão do processo).
2. O usuário clica em **"Adicionar item"** e informa descrição, natureza, unidade de medida e, opcionalmente, lote (número e nome), sistema/código de catálogo e observações.
3. O front valida com `processItemSchema` e envia `POST /processes/{id}/items` (PRC-14) com `Idempotency-Key`.
4. A API, em uma transação com `app.tenant_id` e `SELECT … FOR UPDATE` no processo: valida o corpo e a unidade (ativa, catálogo correto); autoriza `PROCESS_UPDATE` + POL-01; verifica o limite de itens (RN-PROC-83); atribui `sequence = máximo + 1` (RN-PROC-73); aplica a regra de lote (RN-PROC-75); grava o item, incrementa a versão do processo (RN-PROC-81); grava auditoria, evento e timeline (RN-PROC-82).
5. A API responde **201** com o item, `Location` e `ETag` do item.
6. O front insere o item na lista, atualiza o contador da aba e refaz PRC-13 para obter o novo `ETag` (versão do processo) usado na reordenação.
7. Para editar, o usuário abre o item, altera os campos e salva: `PATCH /process-items/{itemId}` (PRC-15) com `If-Match` do item.
8. Para reordenar, o usuário arrasta itens (ou usa "Mover para cima/baixo") e clica em **"Salvar ordem"**: `POST /processes/{id}/items/reorder` (PRC-17) com a lista completa e `If-Match` do processo; os números passam a 1..n na nova ordem (RN-PROC-74).
9. Para excluir, o usuário escolhe **"Excluir"** e confirma: `DELETE /process-items/{itemId}` (PRC-16) com `If-Match`; se o item estiver em uso, a API devolve 409 `ITEM_IN_USE` com os documentos que o referenciam (RN-PROC-79).

## Fluxos alternativos
- **FA-01 — Item em uso:** a confirmação de exclusão mostra "Este item está no DFD 0005/2026 (Rascunho) e na Pesquisa de preços 0002/2026 (Rascunho). Remova-o desses documentos antes de excluir." com links; se algum documento não for editável (finalizado, aprovado, em revisão), acrescenta "O DFD 0005/2026 está aprovado; é preciso reabri-lo antes."
- **FA-02 — Numeração com lacunas:** após exclusões, a lista mostra "Os itens têm numeração com lacunas (1, 2, 4)." com o botão **"Renumerar"**, que envia a ordem atual a PRC-17.
- **FA-03 — Item referenciado por documento concluído:** ao salvar descrição, natureza ou código de catálogo, o front pede confirmação: "Os documentos ETP 0003/2026 (Aprovado) e TR 0002/2026 (Finalizado) manterão a descrição anterior nas versões já geradas." (RN-PROC-80).
- **FA-04 — Troca de unidade de item em uso:** o campo "Unidade" fica somente leitura com "A unidade não pode ser alterada porque o item já tem quantidades em documentos."; a API responde 409 `ITEM_IN_USE` (RN-PROC-76).
- **FA-05 — Natureza incomum:** se a natureza não estiver em `metadata.itemKinds` do tipo de contratação, a UI exibe "Natureza incomum para o tipo de contratação Aquisição de bens." sem impedir o salvamento (RN-PROC-78).
- **FA-06 — Preço de referência sigiloso:** para quem não atende POL-09, a coluna "Preço unitário de referência" mostra "Sigiloso" (RN-PROC-84); a quantidade de referência é sempre exibida.
- **FA-07 — Sem custódia ou status não editável:** a aba fica em modo leitura com o motivo ("Somente quem está com o processo pode alterar os itens." ou "Itens não podem ser alterados com o processo aguardando aprovação.").
- **FA-08 — Lista desatualizada:** 412 em qualquer operação → "A lista de itens foi alterada por outra pessoa." e recarga automática, preservando o formulário aberto.

## Regras de negócio
- **RN-PROC-71** — Alterar itens (PRC-14 a PRC-17) exige `PROCESS_UPDATE` com escopo que cubra o processo, custódia (POL-01) e status `DRAFT`, `IN_PROGRESS` ou `RETURNED` (403 `NOT_PROCESS_CUSTODIAN` / 409 `INVALID_PROCESS_STATUS`). Consultar (PRC-13) exige apenas visibilidade.
- **RN-PROC-72** — Campos editáveis: `lotNumber`, `lotName`, `kind`, `description`, `unitOfMeasureId`, `catalogSystem`, `catalogCode`, `notes`. Somente leitura (`errors[].code = "NOT_ALLOWED"`): `sequence` (só por criação e PRC-17), `referenceQuantity`, `referenceQuantitySourceDocumentId`, `referenceUnitPrice` e `referenceUnitPriceSourceDocumentId`, atualizados exclusivamente pelos documentos aprovados/finalizados e pela conclusão da pesquisa (DEC-019).
- **RN-PROC-73** — Numeração: novo item recebe `sequence` = maior número entre itens não excluídos + 1 (1 no primeiro); exclusão não renumera; renumeração só por PRC-17. `sequence` é único por processo entre itens não excluídos.
- **RN-PROC-74** — Reordenação (PRC-17): o corpo traz `itemIds` com **todos** os itens ativos, cada um uma única vez; o sistema grava `sequence` = posição (1..n). Item repetido → `DUPLICATE_IN_LIST`; item inexistente ou excluído → `REFERENCE_NOT_FOUND`; item ativo ausente → `REQUIRED` (todos em `VALIDATION_ERROR`, campo `itemIds`). As versões já geradas de documentos mantêm a numeração do snapshot.
- **RN-PROC-75** — Lotes: `lotNumber` inteiro de 1 a 999; `lotName` (até 150) exige `lotNumber` (`CONDITIONAL_REQUIRED`). Itens do mesmo lote compartilham o nome: ao informar `lotName` diferente, o sistema aplica o novo nome a todos os itens daquele lote na mesma transação (todos listados em `updated` do evento). Itens com e sem lote podem coexistir; a UI agrupa os demais em "Sem lote" e avisa "Há itens sem lote." quando ao menos um item tiver lote.
- **RN-PROC-76** — Unidade de medida: item ativo do catálogo `UNIT_OF_MEASURE` do tenant (validado quando informado ou alterado). Não pode ser alterada se o item for referenciado por `DocumentItem` ou `PriceItem` (409 `ITEM_IN_USE`), pois invalidaria as quantidades registradas.
- **RN-PROC-77** — Catálogo de materiais/serviços: opcional; `catalogCode` exige `catalogSystem` (`CONDITIONAL_REQUIRED`); para `CATMAT` e `CATSER` somente dígitos (até 30); para `OTHER`, letras, dígitos, `.`, `-` e `/` (até 30) — `INVALID_FORMAT`. Não há validação externa no MVP 1.
- **RN-PROC-78** — Natureza (`ItemKind`) obrigatória; se não constar de `metadata.itemKinds` do tipo de contratação do processo, apenas aviso na UI (não bloqueia).
- **RN-PROC-79** — Exclusão lógica (`deletedAt`, `deletedById`). Item referenciado por `DocumentItem` ou `PriceItem` não pode ser excluído: 409 `ITEM_IN_USE` com `meta.references[] { documentId, code, typeCode, status, editable }`. Em documentos em `DRAFT`/`RETURNED` o usuário remove o item do documento antes; nos demais, só após reabertura (US-065).
- **RN-PROC-80** — Alterar descrição, natureza ou código de catálogo de item referenciado por documento em `IN_REVIEW`, `FINALIZED` ou `APPROVED` é permitido; as versões já geradas mantêm os dados do snapshot e os rascunhos passam a exibir os novos dados. A UI exige confirmação listando os documentos afetados.
- **RN-PROC-81** — Itens pertencem ao agregado do processo: toda alteração incrementa `Process.version` e `updatedAt`. PRC-15/PRC-16 exigem `If-Match` com a versão do item; PRC-17 exige `If-Match` com a versão do processo (devolvida como `ETag` em PRC-13); PRC-14 aceita `Idempotency-Key`. Criações concorrentes são serializadas pelo bloqueio do processo, sem números repetidos.
- **RN-PROC-82** — Efeitos na mesma transação: `ProcessItemsChanged` (`added`, `updated`, `removed`, `itemsCount`); timeline `ITEMS_CHANGED`; auditoria `process.items_update` com o diff por item. `RuleContext.process.itemsCount` e `hasLots` refletem o novo estado nas avaliações seguintes.
- **RN-PROC-83** — Limite técnico de 1.000 itens ativos por processo: acima disso, 422 `VALIDATION_ERROR` (`OUT_OF_RANGE`) — "O processo atingiu o limite de 1.000 itens."
- **RN-PROC-84** — Sigilo: `referenceUnitPrice` é mascarado conforme POL-09 (`null` + `referenceUnitPriceMasked: true`); `referenceQuantity` nunca é sigiloso (art. 24 da Lei 14.133/2021: os quantitativos são divulgados).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nº do item | `sequence` | inteiro | — | RN-PROC-73/74; somente leitura | gerado |
| Lote (número) | `lotNumber` | inteiro | Não | 1–999 | — |
| Nome do lote | `lotName` | texto curto | Condicional | até 150; exige lote; RN-PROC-75 | nome do lote existente |
| Natureza | `kind` | `ItemKind` | Sim | Bem, Serviço, Serviço de engenharia, Obra | primeira natureza de `metadata.itemKinds` |
| Descrição | `description` | texto longo | Sim | 3–2.000 caracteres; trim | — |
| Unidade de medida | `unitOfMeasureId` | catálogo `UNIT_OF_MEASURE` | Sim | ativa; RN-PROC-76 | — |
| Sistema de catálogo | `catalogSystem` | `ItemCatalogSystem` | Condicional | obrigatório com código | — |
| Código CATMAT/CATSER | `catalogCode` | texto curto | Não | RN-PROC-77 | — |
| Observações | `notes` | texto longo | Não | até 2.000 | — |
| Quantidade de referência | `referenceQuantity` (+ `referenceQuantitySourceDocumentId`) | decimal(18,4) | — | somente leitura; exibe "Do {documento} v{n}" | documentos (DEC-019) |
| Preço unitário de referência | `referenceUnitPrice` (+ `referenceUnitPriceSourceDocumentId`) | decimal(18,4) | — | somente leitura; mascarável (RN-PROC-84) | pesquisa concluída |
| Ordem (reordenação) | `itemIds` | lista de uuid | Sim (PRC-17) | RN-PROC-74 | ordem atual |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Descrição ausente, curta ou longa | Front + API (Zod) | "Descreva o item (3 a 2.000 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Natureza fora do enum | Front + API | "Selecione a natureza do item." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-03 | Unidade inexistente, de outro tenant ou inativa | API | "Selecione uma unidade de medida válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | Código sem sistema / nome de lote sem número | Front + API | "Informe o sistema do código." / "Informe o número do lote." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-05 | Código CATMAT/CATSER com caracteres inválidos | Front + API | "O código CATMAT/CATSER deve conter apenas números." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-06 | Lote fora de 1–999 / limite de 1.000 itens | Front + API | "Informe um lote entre 1 e 999." / "O processo atingiu o limite de 1.000 itens." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-07 | Campo somente leitura enviado | API | "Quantidade e preço de referência vêm dos documentos e não podem ser alterados aqui." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-08 | Lista de reordenação inválida | API | "A ordem enviada não corresponde aos itens do processo. Recarregue a lista." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`/`REFERENCE_NOT_FOUND`/`REQUIRED`) |
| V-09 | Exclusão ou troca de unidade de item em uso | API | "Este item está em uso em documentos do processo." | `ITEM_IN_USE` |

## Permissões
- **Permissão:** `PROCESS_UPDATE` com escopo que cubra o processo (PRC-14 a PRC-17); `PROCESS_VIEW` (visibilidade) para PRC-13.
- **Políticas:** POL-01 (custódia e status); POL-09 (`referenceUnitPrice`).
- **MFA:** não exigido (`PROCESS_UPDATE` é `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** sem `PROCESS_UPDATE`, os botões de edição não aparecem; sem custódia ou fora dos status editáveis, a aba fica em modo leitura com o motivo (PRC-08, ação `MANAGE_ITEMS`). Participantes `COLLABORATOR`/`CONSULTANT` não alteram itens (participação não concede `PROCESS_UPDATE` — permissions.md §4).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessItemsChanged` | `process.items_changed` | Commit de criação, alteração, exclusão ou reordenação | `added`, `updated`, `removed` (ids) e `itemsCount`; reordenação lista os itens renumerados em `updated` |

Projeção síncrona: timeline `ITEMS_CHANGED` ("{actor} atualizou os itens ({itemsCount})").

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (alteração sob custódia; registrada na timeline). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar itens da contratação

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está "IN_PROGRESS" com "Ana" como responsável e sem itens
    And o catálogo "UNIT_OF_MEASURE" tem os itens ativos "SACO" e "M3"

  Scenario: [Sucesso] Adicionar itens com lote
    When "Ana" adicionar "Cimento CP-II 50 kg" (Bem, SACO, lote 1 "Materiais de construção") e "Areia média" (Bem, M3, lote 1)
    Then os itens devem receber os números 1 e 2 e o mesmo nome de lote
    And a versão do processo deve ser incrementada a cada inclusão
    And devem ser gerados eventos "ProcessItemsChanged" com "added" preenchido e "itemsCount" igual a 2 no último
    And deve existir a entrada "ITEMS_CHANGED" na timeline e o registro de auditoria "process.items_update"

  Scenario: [Sucesso] Renumerar após exclusão
    Given que o processo tem os itens 1, 2 e 3 sem referências em documentos
    When "Ana" excluir o item 2
    Then a lista deve mostrar os itens 1 e 3 e o aviso "Os itens têm numeração com lacunas (1, 3)."
    When "Ana" clicar em "Renumerar"
    Then os itens devem passar a 1 e 2, mantendo a ordem

  Scenario: [Validação] Código de catálogo e campos somente leitura
    When "Ana" informar o código "AB12" com o sistema "CATMAT"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_FORMAT" no campo "catalogCode"
    When "Ana" enviar PATCH com "referenceUnitPrice" igual a "35.0000"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "referenceUnitPrice"

  Scenario: [Permissão] Sem custódia e participante colaborador
    Given que "Juliana" possui o perfil "COMPRAS" com escopo "TENANT" e não está com o processo
    When "Juliana" adicionar um item
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN" e registrar "access.denied"
    Given que "Bruno" é participante "CONSULTANT" do processo
    When "Bruno" abrir a aba "Itens"
    Then a aba deve estar em modo leitura e um POST de "Bruno" deve ser recusado com 403

  Scenario: [Permissão] Preço de referência mascarado
    Given que o processo tem orçamento sigiloso e o item 1 tem preço unitário de referência "32.5000"
    And "Tatiane" não possui "PROCESS_VIEW_CONFIDENTIAL_BUDGET" nem custódia
    When "Tatiane" consultar os itens
    Then o item 1 deve ter "referenceUnitPrice" nulo, "referenceUnitPriceMasked" verdadeiro e "referenceQuantity" visível

  Scenario: [Tenant incorreto] Item ou unidade de outro tenant
    Given que existe o item "X" de um processo da "Prefeitura B"
    When "Ana" enviar PATCH ou DELETE para o item "X"
    Then a API deve responder 404 com código "NOT_FOUND"
    When "Ana" adicionar um item com "unitOfMeasureId" da "Prefeitura B"
    Then a API deve responder 422 com erro "REFERENCE_NOT_FOUND" no campo "unitOfMeasureId"

  Scenario: [Duplicidade] Item em uso e reenvio idempotente
    Given que o item 1 está no DFD "DFD 0005/2026" em rascunho
    When "Ana" excluir o item 1
    Then a API deve responder 409 com código "ITEM_IN_USE" e "meta.references" com "DFD 0005/2026", status "DRAFT" e "editable" verdadeiro
    When "Ana" reenviar a inclusão de um item com a mesma "Idempotency-Key" após falha de rede
    Then a API deve responder 201 com o mesmo item e "Idempotent-Replayed: true", sem criar outro item

  Scenario: [Concorrência] Inclusões simultâneas e ordem desatualizada
    When "Ana" e "Carla" (também lotada na unidade atual, sem responsável definido) adicionarem itens ao mesmo tempo
    Then os itens devem receber números distintos e consecutivos
    Given que "Ana" carregou a lista com "ETag" igual a "14" e "Carla" adicionou um item em seguida
    When "Ana" salvar uma nova ordem com "If-Match" igual a "14"
    Then a API deve responder 412 com código "VERSION_CONFLICT" e a lista deve ser recarregada

  Scenario: [Falha de banco] Banco indisponível ao incluir item
    Given que o banco de dados fica indisponível durante a transação
    When "Ana" adicionar um item
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum item, evento, timeline ou auditoria deve ser persistido e o formulário deve manter os dados

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Ana" alterar a descrição de um item
    Then a API deve responder 200 e o evento "ProcessItemsChanged" deve permanecer "PENDING" até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido / campo somente leitura / lista de ordem inválida | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos; recarrega a lista na ordem inválida |
| Item em uso (exclusão ou troca de unidade) | 409 | `ITEM_IN_USE` | "Este item está em uso em documentos do processo." | Lista os documentos com links (FA-01) |
| Status não editável | 409 | `INVALID_PROCESS_STATUS` | "Itens não podem ser alterados com o processo {status}." | Aba em modo leitura |
| Sem permissão / sem custódia | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Somente quem está com o processo pode alterar os itens." | Aba em modo leitura |
| Processo ou item não visível / de outro tenant | 404 | `PROCESS_NOT_FOUND` / `NOT_FOUND` | "Item não encontrado." | Recarrega a lista |
| Versão divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "A lista de itens foi alterada por outra pessoa." | Recarrega preservando o formulário |
| Chave idempotente reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar o item agora. Tente novamente em instantes." | Mantém dados; "Tentar novamente" |

## Dependências
- **Stories:** US-001 (processo), US-104 (catálogo `UNIT_OF_MEASURE`). Relacionadas: US-005 (versão do agregado e custódia), US-014/US-022/US-038 (`DocumentItem`), US-024 (`PriceItem`), US-017/US-023/US-032/US-039 (atualização das referências), US-065 (reabertura), US-013 (mascaramento).
- **Decisões/ADRs:** DEC-019, DEC-023, DEC-027, DEC-030, DEC-055, DEC-104, DEC-105, DEC-161.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:**
  1. **Itens × participantes:** `COLLABORATOR`/`CONSULTANT` editam documentos (POL-02), mas não podem criar itens canônicos (exige `PROCESS_UPDATE` + custódia); um consultor que redige o ETP depende do custodiante para incluir um item. Decisão de produto em aberto (ver relatório).
  2. **Limite de 1.000 itens** adotado como constante (`PROCESS_ITEMS_MAX`); proposta: chave de configuração em entities.md §6 se houver demanda.

## Impacto técnico
- Itens fazem parte do agregado `Process`: comandos usam `SELECT … FOR UPDATE` no processo, o que serializa criações (números sem repetição) e alinha com a edição de dados (US-005) e a tramitação.
- Verificação de uso por fachadas (`DocumentFacade.findItemReferences`, `PriceResearchFacade.findItemReferences`), sem acesso direto às tabelas de outros módulos (DEC-041). Para evitar corrida com a inclusão de `DocumentItem`/`PriceItem`, a exclusão bloqueia a linha do item (`FOR UPDATE`) e os módulos de documento/pesquisa validam o item com `FOR SHARE` ao referenciá-lo.
- O `ETag` de PRC-13 é a versão do processo, usada como `If-Match` de PRC-17.
- A renumeração altera `sequence` de muitas linhas: atualização em duas fases (valores temporários negativos → definitivos) para não violar o índice único parcial durante a transação.

## Backend
- **Módulo(s):** `process` (dono de `ProcessItem`); `catalog`, `document`, `price-research`, `timeline`, `audit`, `platform` via fachadas.
- **Casos de uso:** `ListProcessItemsQuery`, `AddProcessItemCommand`, `UpdateProcessItemCommand`, `RemoveProcessItemCommand`, `ReorderProcessItemsCommand`.
- **Domínio:** métodos do agregado `Process.addItem`, `updateItem`, `removeItem`, `reorderItems` (RN-PROC-72 a RN-PROC-83), value object `CatalogCode`, política `LotNamePolicy`.
- **Integrações internas:** `CatalogFacade.assertActive('UNIT_OF_MEASURE', id)`, `DocumentFacade.findItemReferences(ids)`, `PriceResearchFacade.findItemReferences(ids)`, `TimelineProjector`, `AuditService`, `OutboxWriter`, `ConfidentialFieldsInterceptor`.
- **Transação:** cada comando em uma transação com `app.tenant_id` e bloqueio do processo; evento, timeline e auditoria no mesmo commit.

## Frontend
- **Tela(s):** SCR-006, aba "Itens" (`?aba=itens`).
- **Componentes:** `ProcessItemsTab` (tabela agrupada por lote), `ProcessItemForm` (drawer; `zodResolver(processItemSchema)`), `UnitOfMeasureSelect`, `CatalogCodeField`, `ReferenceValueCell` (origem em tooltip, `ConfidentialValue` quando mascarado), `SortableItemsList` (dnd-kit com alternativa por teclado "Mover para cima/baixo"), `RenumberBanner`, `ItemInUseDialog`.
- **Dados:** TanStack Query `['t', tenantId, 'processes', id, 'items']`; mutações com `Idempotency-Key`/`If-Match`; após sucesso, invalidar itens, resumo (contador) e timeline.
- **Estados:** skeleton; empty state "Nenhum item ainda. Adicione os itens que serão contratados." com botão (se puder editar); modo leitura com motivo; aviso de lacunas.
- **Acessibilidade:** reordenação acessível por teclado com anúncio "Item 3 movido para a posição 2"; tabela com cabeçalhos de grupo por lote; erros anunciados via `aria-live`.
- **Responsivo:** cartões por item abaixo de 768 px; reordenação por botões.

## Banco de dados
- **Tabelas escritas:** `process_items`, `processes` (versão), `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** criação de `process_items` conforme entities.md §4.4 (colunas padrão + SD, RLS, FKs compostas para `processes`, `catalog_items` e `documents`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id, sequence) WHERE deleted_at IS NULL`; `(tenant_id, process_id)`; checks `reference_quantity IS NULL OR reference_quantity > 0` e `catalog_code IS NULL OR catalog_system IS NOT NULL`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-13 | GET | `/api/v1/processes/{id}/items` | — | `200 { data: ProcessItem[] }` (com `referenceUnitPriceMasked`) + `ETag` = versão do processo | 200, 404 |
| PRC-14 | POST | `/api/v1/processes/{id}/items` | `{ description, kind, unitOfMeasureId, lotNumber?, lotName?, catalogSystem?, catalogCode?, notes? }` + `Idempotency-Key` | `201 { data: ProcessItem }` + `Location`, `ETag` | 201, 403, 404, 409, 422 |
| PRC-15 | PATCH | `/api/v1/process-items/{itemId}` | campos editáveis + `If-Match` (item) | `200 { data: ProcessItem }` | 200, 403, 404, 409, 412, 422, 428 |
| PRC-16 | DELETE | `/api/v1/process-items/{itemId}` | `If-Match` (item) | `204` | 204, 403, 404, 409, 412, 428 |
| PRC-17 | POST | `/api/v1/processes/{id}/items/reorder` | `{ itemIds: uuid[] }` + `If-Match` (processo) | `200 { data: ProcessItem[] }` + `ETag` | 200, 403, 409, 412, 422, 428 |

Exemplo de 409 `ITEM_IN_USE`:
```json
{ "status": 409, "code": "ITEM_IN_USE", "title": "Item em uso", "detail": "O item 1 está em documentos do processo.",
  "meta": { "references": [
    { "documentId": "…", "code": "DFD 0005/2026", "typeCode": "DFD", "status": "DRAFT", "editable": true },
    { "documentId": "…", "code": "PP 0002/2026", "typeCode": "PRICE_RESEARCH", "status": "FINALIZED", "editable": false } ] },
  "correlationId": "c-5d1e77" }
```

## Logs
- `info` `process.items_changed` — `processId`, contagens de `added`/`updated`/`removed`, `itemsCount`, `durationMs`.
- `warn` `process.item_in_use` — `itemId`, quantidade de referências.
- `error` `process.items_change_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** descrições de itens, observações e preços de referência.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.items_update` | `DATA_CHANGE` | Commit de qualquer operação de itens | `changes`: por item — `[{ path: "items[<id>].<campo>", old, new }]` (descrição como hash + tamanho); `metadata`: `processCode`, `operation` (`ADD`, `UPDATE`, `REMOVE`, `REORDER`), `itemsCount` |
| `access.denied` | `ACCESS` | 403 por permissão ou custódia | `reasonCode = PROCESS_UPDATE` ou `NOT_PROCESS_CUSTODIAN` |

## Testes necessários
- **Unitários:** numeração (primeiro item, lacunas, máximo + 1); reordenação (repetido, ausente, inexistente); política de nome de lote; validação de `catalogCode` por sistema; limite de 1.000 itens.
- **Integração (Testcontainers):** `ITEM_IN_USE` com referência em `DocumentItem` e em `PriceItem`; corrida entre exclusão do item e inclusão em documento (um dos dois falha de forma consistente); renumeração em duas fases sem violar o índice único; incremento de versão do processo.
- **API/contrato:** PRC-13 a PRC-17 conforme api.md; `ETag` do processo em PRC-13.
- **RBAC e multi-tenant:** custódia, status, participante sem permissão; unidade de medida e item de outro tenant (suíte "tenant leak").
- **Concorrência:** 20 inclusões paralelas → números 1..20 sem repetição; reordenação com `If-Match` desatualizado → 412.
- **E2E (Playwright):** incluir, editar, agrupar em lote, arrastar e salvar ordem, renumerar, tentativa de exclusão de item em uso.
- **Acessibilidade/performance:** axe na aba; reordenação por teclado; processo com 1.000 itens: PRC-13 p95 < 400 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `ITEM_IN_USE` garantido também sob concorrência com documentos
- [ ] Evento, timeline e auditoria verificados em teste; versão do processo incrementada
- [ ] Mascaramento de `referenceUnitPrice` e quantidade sempre visível verificados
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-13 a PRC-17 compatível com api.md
- [ ] Reordenação acessível por teclado; aba utilizável em 360 px
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — CRUD de entidade filha do agregado com numeração concorrente, reordenação transacional, regra de uso cruzada com dois módulos (documentos e pesquisa), lotes e uma aba com arrastar-e-soltar acessível.

## Prioridade
**P0** — itens canônicos são pré-requisito de DFD, ETP, pesquisa de preços e TR (DEC-019); sem eles os documentos estruturados não podem quantificar nem precificar a contratação.
