---
id: US-029
title: "Calcular estatísticas e valor estimado por item"
epic: EP-004
feature: FT-018
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-026]
modules: [price-research]
screens: [SCR-009]
endpoints: [PRS-04, PRS-05, PRS-07, PRS-20]
permissions: [PRICE_RESEARCH_UPDATE]
events: [PriceResearchRecalculated]
---

# US-029 — Calcular estatísticas e valor estimado por item

## Título
Calcular estatísticas e valor estimado por item

## Descrição
**Como** integrante da equipe de planejamento da contratação, **quero** que o sistema calcule automaticamente as estatísticas de cada item da pesquisa de preços a partir das cotações válidas e sugira o valor estimado, **para** obter um preço de referência defensável sem recalcular manualmente planilhas a cada cotação incluída, excluída ou corrigida.

A cada mudança relevante (cotação criada, editada, excluída, restaurada ou importada; parâmetros da pesquisa alterados), o sistema recalcula, por item (`PriceItem`), a quantidade de cotações válidas, média, mediana, menor, maior, desvio-padrão amostral e coeficiente de variação (CV); define o método efetivo (`effectiveMethod`) conforme o método do item (`methodOverride`) ou o método padrão da pesquisa (`defaultMethod`, inclusive `AUTO_CV`); calcula o preço unitário recomendado e o total; e publica `PriceResearchRecalculated`.

## Contexto
- Lei 14.133/2021, art. 23, §1º: a pesquisa de preços deve ser realizada mediante um ou mais dos parâmetros ali previstos; a literatura e a IN SEGES/ME 65/2021 recomendam o uso de mediana quando há grande dispersão entre as cotações, para reduzir a influência de valores extremos — por isso o método padrão `AUTO_CV` (DEC-020) troca para mediana quando o CV supera o limiar configurado.
- Hoje o cálculo é feito em planilhas soltas, sem rastreabilidade de qual cotação entrou em qual média e sem reação automática a exclusões (US-027) ou importações (US-028).
- `PriceItem` já existe desde US-024 (criação da pesquisa a partir dos itens do processo) com as colunas de estatística vazias; `Quotation` e `PriceSource` existem desde US-026. Esta story implementa o motor de cálculo que preenche essas colunas e mantém `PriceResearch.itemsCount`/`itemsWithAlertsCount` atualizados (DEC-020).
- Valores monetários usam `Decimal(18,2)` e preço unitário `Decimal(18,4)` (DEC-003); todo cálculo usa `decimal.js` — nunca `number`/float, para evitar erro de ponto flutuante em somas e arredondamentos.
- Processos com `isBudgetConfidential = true` mascaram os valores calculados para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia atual (DEC-030, POL-09).

## Objetivo
Garantir que, a qualquer momento após a primeira cotação válida de um item, o `PriceItem` reflita estatísticas corretas e um `recommendedUnitPrice` calculável em até 1 segundo após a mudança que o originou, com 100% dos recálculos registrados em `PriceResearchRecalculated` e sem nenhuma estatística desatualizada em tela.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), Compras (`COMPRAS`) — ajustam método/justificativa manual quando necessário.

## Pré-condições
- Pesquisa de preços (`PriceResearch`) criada (US-024), documento em `DRAFT` ou `RETURNED` (POL-02).
- Usuário com `PRICE_RESEARCH_UPDATE` e custódia/participação conforme POL-02.
- Existem `PriceItem` (um por item do processo) e, para ao menos um deles, cotações (`Quotation`) registradas (US-026).

## Fluxo principal
1. O usuário registra, edita, exclui, restaura ou importa uma cotação (US-026/027/028), ou altera o método de um item, ou altera parâmetros da pesquisa (`PATCH` em `PRS-04`).
2. A API, na mesma transação da operação que originou a mudança, recalcula todos os `PriceItem` afetados:
   1. filtra `Quotation` com `status = VALID` do item;
   2. calcula `validQuotationsCount`, `meanPrice`, `medianPrice`, `lowestPrice`, `highestPrice`;
   3. com `validQuotationsCount ≥ 2`, calcula `stdDeviation` (amostral, denominador `n − 1`) e `coefficientOfVariation` (`stdDeviation / meanPrice × 100`); com `< 2`, ambos ficam nulos;
   4. resolve `effectiveMethod`: `methodOverride` do item quando definido; senão `priceResearch.defaultMethod` — se `AUTO_CV`, usa `MEDIAN` quando `coefficientOfVariation > cvThresholdPercent`, senão `MEAN`;
   5. calcula `recommendedUnitPrice` pelo valor correspondente ao `effectiveMethod` (`meanPrice`/`medianPrice`/`lowestPrice`) ou `manualUnitPrice` quando `effectiveMethod = MANUAL`, arredondado para `unitPriceDecimals` casas pelo `roundingMode`;
   6. calcula `totalPrice = round(recommendedUnitPrice × quantity, 2)` pelo `roundingMode`;
   7. grava `calculatedAt = now()`.
3. A API atualiza `PriceResearch.itemsCount`, `itemsWithAlertsCount` (US-030) e `lastCalculatedAt`, grava auditoria `price_research.recalculate` e publica `PriceResearchRecalculated` no outbox.
4. A API responde conforme o endpoint que originou a mudança (ex.: `200` do `PATCH /price-items/{itemId}`), incluindo o `PriceItem` já recalculado.
5. O front atualiza a tela SCR-009 (coluna de estatísticas e card "Valor recomendado") sem recarregar a página, via invalidação da consulta de itens.

## Fluxos alternativos
- **FA-01 — Definir método manual:** o usuário escolhe `methodOverride = MANUAL`, informa `manualUnitPrice` e `manualJustification`; o sistema usa esse valor como `recommendedUnitPrice` e exibe o selo "Valor manual" com a justificativa em tela.
- **FA-02 — Remover a substituição de método:** o usuário limpa `methodOverride` (volta a `null`); o item passa a seguir `priceResearch.defaultMethod` novamente; `manualUnitPrice`/`manualJustification` são apagados.
- **FA-03 — Alterar parâmetros da pesquisa:** o usuário altera `defaultMethod`, `cvThresholdPercent`, `minQuotations`, `unitPriceDecimals` ou `roundingMode` no cabeçalho (`PRS-04`); todos os `PriceItem` da pesquisa são recalculados em lote.
- **FA-04 — Recálculo manual sob demanda:** o usuário aciona "Recalcular agora" (`PRS-20`) — útil após operações externas (ex.: mudança de configuração do tenant que não dispara recálculo automático retroativo).
- **FA-05 — Item sem nenhuma cotação válida:** todas as estatísticas e `recommendedUnitPrice` ficam nulos; a tela exibe "Sem cotações válidas" (ver alerta `NO_VALID_QUOTES`, US-030).
- **FA-06 — Apenas uma cotação válida:** `meanPrice = medianPrice = lowestPrice = highestPrice` = o próprio valor; `stdDeviation`/`coefficientOfVariation` ficam nulos (desvio amostral exige `n ≥ 2`); `effectiveMethod AUTO_CV` resolve para `MEAN` (CV indefinido não é maior que o limiar).

## Regras de negócio
- **RN-PRICE-41** — Estatísticas calculadas somente sobre `Quotation` com `status = VALID` do item: `validQuotationsCount`, `meanPrice`, `medianPrice`, `lowestPrice`, `highestPrice` sempre que `validQuotationsCount ≥ 1`; `stdDeviation` (amostral, `n − 1`) e `coefficientOfVariation` (`%`) somente com `validQuotationsCount ≥ 2`.
- **RN-PRICE-42** — `effectiveMethod`: `methodOverride` do item quando definido (inclusive `MANUAL`); senão `priceResearch.defaultMethod`; quando este for `AUTO_CV`, resolve para `MEDIAN` se `coefficientOfVariation > cvThresholdPercent`, senão `MEAN`. Sem cotações válidas suficientes para o método resolvido, `effectiveMethod` é gravado mas `recommendedUnitPrice` fica nulo.
- **RN-PRICE-43** — `recommendedUnitPrice` = o valor de `meanPrice`/`medianPrice`/`lowestPrice` correspondente ao `effectiveMethod`, ou `manualUnitPrice` quando `MANUAL`; `MANUAL` exige `manualUnitPrice` e `manualJustification` preenchidos (constraint de banco já existente desde US-026/entities.md).
- **RN-PRICE-44** — Arredondamento: `recommendedUnitPrice` com `unitPriceDecimals` (2 ou 4) casas pelo `roundingMode` (`HALF_UP` padrão); `totalPrice = round(recommendedUnitPrice × quantity, 2)` sempre com 2 casas, mesmo `roundingMode`. Todo cálculo usa `decimal.js`.
- **RN-PRICE-45** — Recálculo é automático e síncrono (mesma transação) a cada mudança em cotações, fontes (exclusão em cascata), método do item ou parâmetros da pesquisa; publica `PriceResearchRecalculated` com `itemsCount`/`itemsWithAlertsCount` atuais; também disponível sob demanda via `PRS-20`.
- **RN-PRICE-46** — `validQuotationsCount < priceResearch.minQuotations` não bloqueia o cálculo (estatísticas são geradas com o que houver); apenas sinaliza alerta (US-030) e exige `belowMinimumJustification` para concluir a pesquisa (US-032).
- **RN-PRICE-47** — Alterar `defaultMethod`, `cvThresholdPercent`, `minQuotations`, `outlierLowerPercent`, `outlierUpperPercent`, `unitPriceDecimals` ou `roundingMode` no cabeçalho da pesquisa (`PRS-04`) recalcula todos os `PriceItem`, exceto os que têm `methodOverride = MANUAL` (preço manual não é afetado pelo método padrão).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Método do item | `methodOverride` | seleção (`PriceCalculationMethod`) | Não | `MEAN`\|`MEDIAN`\|`LOWEST`\|`MANUAL`; vazio = segue o padrão da pesquisa | vazio |
| Valor manual | `manualUnitPrice` | moeda (BRL, 2–4 casas) | Condicional (`methodOverride = MANUAL`) | > 0; string decimal na API | — |
| Justificativa do valor manual | `manualJustification` | texto longo | Condicional (`methodOverride = MANUAL`) | ≥ 20 caracteres (RN-PRICE-43) | — |
| Quantidade | `quantity` | decimal(18,4) | Sim (já existe desde US-024) | > 0 | `processItem.referenceQuantity` |
| *(sistema)* Estatísticas | `validQuotationsCount`, `meanPrice`, `medianPrice`, `lowestPrice`, `highestPrice`, `stdDeviation`, `coefficientOfVariation` | — | — | RN-PRICE-41 | calculados |
| *(sistema)* Método efetivo, recomendado e total | `effectiveMethod`, `recommendedUnitPrice`, `totalPrice`, `calculatedAt` | — | — | RN-PRICE-42..44 | calculados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `methodOverride = MANUAL` sem `manualUnitPrice` ou `manualJustification` | Front + API (Zod) | "Informe o valor manual e a justificativa (mín. 20 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-02 | `manualUnitPrice` ≤ 0 ou com mais casas que `unitPriceDecimals` | Front + API | "Informe um valor válido, com até {N} casas decimais." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-03 | `methodOverride` fora do enum | API | "Selecione um método válido." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-04 | Campos calculados (`effectiveMethod`, `recommendedUnitPrice`, estatísticas) enviados no corpo | API | "Este campo é calculado pelo sistema e não pode ser alterado diretamente." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-05 | `quantity` ≤ 0 | Front + API | "Informe uma quantidade maior que zero." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-06 | `If-Match` ausente em `PATCH` | API | "Não foi possível salvar: recarregue a página e tente novamente." | `PRECONDITION_REQUIRED` |

## Permissões
- **Permissão:** `PRICE_RESEARCH_UPDATE` com escopo que cubra o processo (permissions.md §5).
- **Políticas:** POL-02 (documento em `DRAFT`/`RETURNED`, custódia/participação, etapa permite o tipo `PRICE_RESEARCH`, processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`); POL-09 nas leituras com valores monetários.
- **MFA:** não exigido (`PRICE_RESEARCH_UPDATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** campos de método e valor manual somem da UI (somente leitura); API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PriceResearchRecalculated` | `price_research.recalculated` | Commit de qualquer recálculo (RN-PRICE-45) | Payload: `priceResearchId`, `itemsCount`, `itemsWithAlertsCount` |

Auditoria complementar (sem projeção na timeline): `price_research.method_change` quando `methodOverride` muda; `price_research.recalculate` a cada recálculo.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: o recálculo é refletido em tela e no painel do item; não há alerta assíncrono nesta story (ver US-030 para sinalização de conformidade). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Calcular estatísticas e valor estimado por item

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a pesquisa de preços "PR-01" do processo "0012/2026" usa método padrão "AUTO_CV", limiar de CV "25", mínimo de cotações "3", "2" casas decimais e arredondamento "HALF_UP"
    And o usuário "Marcos" tem "PRICE_RESEARCH_UPDATE" e custódia do processo

  Scenario: [Sucesso] Calcular com CV baixo e método automático escolhendo a média
    Given que o item "Item 1 — Papel A4" tem as cotações válidas "100,00", "110,00" e "90,00" com quantidade "50"
    When o sistema recalcular o item
    Then "meanPrice" deve ser "100,0000" e "medianPrice" deve ser "100,0000"
    And "coefficientOfVariation" deve ser "10,0000" (menor ou igual ao limiar de 25)
    And "effectiveMethod" deve ser "MEAN" e "recommendedUnitPrice" deve ser "100,00"
    And "totalPrice" deve ser "5000,00"
    And deve gerar o evento "PriceResearchRecalculated"

  Scenario: [Sucesso] CV acima do limiar troca automaticamente para a mediana
    Given que o item "Item 2 — Caneta" tem as cotações válidas "100,00", "200,00" e "90,00"
    When o sistema recalcular o item
    Then "coefficientOfVariation" deve ser maior que "25"
    And "effectiveMethod" deve ser "MEDIAN" e "recommendedUnitPrice" deve ser "100,00"

  Scenario: [Validação] Método manual sem justificativa
    When "Marcos" definir "methodOverride" "MANUAL" para o "Item 1" sem informar "manualJustification"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "manualJustification"
    And o item deve manter o método efetivo anterior

  Scenario: [Permissão] Usuário sem PRICE_RESEARCH_UPDATE
    Given que o usuário "Bruno" possui apenas "PROCESS_VIEW"
    When "Bruno" enviar PATCH para o "Item 1" alterando o método
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And nenhuma estatística deve ser alterada

  Scenario: [Tenant incorreto] Item de outro tenant
    When "Marcos", no tenant "Prefeitura de São José", enviar PATCH para um "priceItemId" existente apenas no tenant "Prefeitura B"
    Then a API deve responder 404 com código "PRICE_ITEM_NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser lido ou alterado

  Scenario: [Duplicidade] Reenviar o mesmo método sem mudança real não duplica o histórico
    Given que o "Item 1" já está com "methodOverride" "MEAN"
    When "Marcos" enviar novamente o mesmo valor "MEAN" para "methodOverride"
    Then a API deve responder 200 sem gerar um novo registro de auditoria "price_research.method_change"

  Scenario: [Concorrência] Duas edições simultâneas do mesmo item
    Given que o "Item 1" está na versão "3"
    When duas requisições enviarem PATCH simultaneamente com "If-Match: \"3\""
    Then uma deve responder 200 com a versão "4"
    And a outra deve responder 412 com código "VERSION_CONFLICT" e "currentVersion" igual a "4"

  Scenario: [Falha de banco] Banco indisponível durante o recálculo
    Given que o banco de dados fica indisponível durante a transação
    When uma cotação for excluída e o recálculo for disparado
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And as estatísticas anteriores do item devem permanecer inalteradas

  Scenario: [Falha de integração] Outbox indisponível ao publicar o recálculo
    Given que o relay do outbox está indisponível
    When o recálculo do "Item 1" for concluído com sucesso
    Then as estatísticas devem ser persistidas e a API deve responder 200
    And o evento "PriceResearchRecalculated" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| `MANUAL` sem valor/justificativa | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | "Informe o valor manual e a justificativa (mín. 20 caracteres)." | Foca os dois campos |
| Valor manual inválido | 422 | `VALIDATION_ERROR` (`INVALID_DECIMAL`) | "Informe um valor válido, com até {N} casas decimais." | Marca o campo |
| Campo calculado no corpo | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Este campo é calculado pelo sistema." | Ignora o campo e segue com o restante (ou rejeita, conforme política de schema estrito) |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar esta pesquisa." | Campos somente leitura |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Esta pesquisa não pode ser editada no status atual." | Esconde ações de edição |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Este item foi alterado por outra pessoa. Recarregue para ver a versão atual." | Recarrega o item |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega antes de reenviar |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível calcular agora. Tente novamente em instantes." | Mantém valores anteriores; botão "Tentar novamente" |

## Dependências
- **Stories:** US-024 (cria `PriceItem`/pesquisa), US-026 (cotações e fontes), US-027 (exclusão dispara recálculo), US-028 (importação dispara recálculo). US-030 consome `itemsWithAlertsCount` e os indicadores por cotação.
- **Decisões/ADRs:** DEC-003 (decimais e `decimal.js`), DEC-017, DEC-018 (documento editável), DEC-019 (itens canônicos), DEC-020 (estatísticas e método), DEC-030 (sigilo).
- **Configurações:** `priceResearch.defaultMethod`, `priceResearch.cvThresholdPercent`, `priceResearch.minQuotations`, `priceResearch.unitPriceDecimals`, `priceResearch.roundingMode`.
- **Lacunas nas fontes canônicas:** nenhuma (mínimo de 20 caracteres de `manualJustification` registrado em entities.md).

## Impacto técnico
- Estabelece o **motor de recálculo** (`PriceCalculationService`) reutilizado por US-026/027/028/030; deve expor `recalculateItem(priceItemId)` e `recalculateResearch(priceResearchId)`, ambos idempotentes e chamáveis dentro de uma transação já aberta (sem abrir transação própria) para permitir o recálculo síncrono nas operações de cotação.
- Risco de performance: pesquisas com muitos itens e fontes podem tornar o recálculo em lote (FA-03/FA-04) custoso; meta p95 < 1 s para pesquisas de até 500 itens × 50 fontes (mesmo limite de US-031).
- Toda aritmética usa `decimal.js` com contexto de precisão fixo (ex.: 28 dígitos) para evitar divergência de arredondamento entre ambientes.

## Backend
- **Módulo(s):** `price-research` (dono); usa `platform` (`OutboxWriter`, `AuditService`).
- **Casos de uso:** `RecalculatePriceItemCommand`/`RecalculatePriceResearchCommand` → `PriceCalculationService`; `UpdatePriceItemMethodCommand`.
- **Domínio:** `PriceItem.recalculate(quotations, research.params)` (função pura sobre value objects `Money`, `Percentage`); `PriceItem.setMethodOverride(method, manual?)` aplica RN-PRICE-42/43.
- **Integrações internas:** chamado por `price-research` ao término das transações de `Quotation`/`PriceSource` (US-026/027/028) e pelo `PRS-04`/`PRS-20`.
- **Transação:** recálculo ocorre dentro da mesma transação da operação que o originou (sem transação própria); `PRS-20` abre sua própria transação dedicada ao lote.

## Frontend
- **Tela(s):** SCR-009 (`/processos/[id]/pesquisa-precos/[researchId]`).
- **Componentes:** `PriceItemStatsCard` (média, mediana, menor, maior, desvio, CV), `MethodSelect` (com badge "Automático"/"Manual"), `ManualPriceFieldset` (valor + justificativa), `RecalculateButton`.
- **Estados:** loading (skeleton nas estatísticas enquanto calcula), vazio ("Sem cotações válidas"), erro (toast com `correlationId`), sucesso (animação sutil ao atualizar valores).
- **Acessibilidade e responsividade:** valores recalculados anunciados via `aria-live="polite"`; cards em coluna única < 768 px.

## Banco de dados
- **Tabelas:** `price_items` (leitura/escrita das colunas de estatística), `quotations` (leitura), `price_research` (leitura de parâmetros e escrita de `items_count`/`items_with_alerts_count`/`last_calculated_at`).
- **Migrações:** nenhuma (colunas já existem desde US-024/026 — entities.md §`PriceItem`/`PriceResearch`).
- **Índices/constraints relevantes:** check já existente `method_override IS DISTINCT FROM 'MANUAL' OR (manual_unit_price IS NOT NULL AND manual_justification IS NOT NULL)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRS-07 | PATCH | `/price-items/{itemId}` | `{ quantity?, methodOverride?, manualUnitPrice?, manualJustification? }` + `If-Match` | `200 { data: PriceItem }` com estatísticas recalculadas | 200, 403, 404, 409, 412, 422, 428 |
| PRS-04 | PATCH | `/price-research/{id}` | `{ defaultMethod?, cvThresholdPercent?, minQuotations?, unitPriceDecimals?, roundingMode? }` + `If-Match` | `200 { data: PriceResearch }` | 200, 403, 404, 409, 412, 422 |
| PRS-05 | GET | `/price-research/{id}/items` | — | `200 { data: PriceItem[] }` ordenado por `sortOrder` | 200, 403, 404 |
| PRS-20 | POST | `/price-research/{id}/recalculate` | `{}` | `200 { data: { itemsCount, itemsWithAlertsCount, lastCalculatedAt } }` | 200, 403, 404, 503 |

## Logs
- `info` `price_research.recalculated` — `priceResearchId`, `itemsCount`, `itemsWithAlertsCount`, `durationMs`, `correlationId`.
- `warn` `price_research.recalculate_slow` — recálculo em lote acima de 1 s.
- `error` `price_research.recalculate_failed` — `errorCode`, `priceItemId`, `correlationId`.
- **Nunca logar:** valores unitários, totais ou justificativas (dados comerciais/sigilosos — DEC-030).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `price_research.method_change` | `DATA_CHANGE` | `methodOverride` do item alterado | `changes`: método anterior/novo; `metadata`: `priceItemId` |
| `price_research.recalculate` | `DATA_CHANGE` | Qualquer recálculo concluído | `metadata`: `itemsCount`, `itemsWithAlertsCount`, `trigger` (cotação/método/parâmetros/manual) |

## Testes necessários
- **Unitários:** `PriceItem.recalculate` com 0, 1, 2 e N cotações válidas; `AUTO_CV` nos dois ramos; arredondamento com `unitPriceDecimals` 2 e 4 e os dois `roundingMode`; constraint de `MANUAL`.
- **Integração (Testcontainers):** recálculo disparado por exclusão/restauração de cotação (US-027) e por importação (US-028); atualização de `itemsCount`/`lastCalculatedAt`.
- **API/contrato:** `PRS-04`, `PRS-05`, `PRS-07`, `PRS-20` conforme api.md; cabeçalhos `ETag`/`If-Match`.
- **RBAC e multi-tenant:** `PRICE_RESEARCH_UPDATE` ausente → 403; item de outro tenant → 404.
- **Concorrência:** duas edições simultâneas do mesmo item → uma 200, outra 412.
- **E2E (Playwright):** alterar cotação e ver as estatísticas atualizarem na tela sem reload; definir valor manual.
- **Acessibilidade/performance:** k6 simulando recálculo em pesquisa com 500 itens × 50 fontes → p95 < 1 s.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PRICE_RESEARCH_UPDATE` e POL-02 aplicados na API; UI em somente leitura sem permissão
- [ ] `PriceCalculationService` cobre os quatro métodos e os casos de borda (0/1/N cotações)
- [ ] Auditoria `price_research.method_change`/`recalculate` e evento `PriceResearchRecalculated` verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRS-04/05/07/20 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de duração do recálculo
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — motor de cálculo com várias regras combinadas (estatística, método automático, arredondamento), mas reaproveitando estruturas de dados e padrões transacionais já estabelecidos em US-001/US-024/US-026.

## Prioridade
**P0** — sem o valor estimado por item não há preço de referência para o processo nem conclusão da pesquisa (US-032).
