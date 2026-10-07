---
id: US-030
title: "Sinalizar outliers e alertas de conformidade"
epic: EP-004
feature: FT-018
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-029]
modules: [price-research]
screens: [SCR-009]
endpoints: [PRS-03, PRS-05]
permissions: []
events: [PriceResearchRecalculated]
---

# US-030 — Sinalizar outliers e alertas de conformidade

## Título
Sinalizar outliers e alertas de conformidade

## Descrição
**Como** integrante da equipe de planejamento da contratação, **quero** que o sistema aponte, sem decidir por mim, quais cotações se destacam das demais e quais itens têm indícios de fragilidade na pesquisa (poucas cotações, dispersão alta, cotações vencidas), **para** revisar esses pontos antes de concluir a pesquisa, com segurança de que nada foi excluído automaticamente.

A cada recálculo (US-029), o sistema compara cada cotação válida com a mediana das demais cotações válidas do mesmo item e marca `outlierFlag` (`LOW`/`HIGH`/`NONE`); calcula `isExpired` por cotação a partir da data da fonte e da validade configurada para aquele tipo de fonte; e consolida, por item, a lista de `alerts` exibida na tela da pesquisa e no mapa comparativo (US-031).

## Contexto
- Lei 14.133/2021, art. 23, §1º, IV e art. 24 orientam prudência na pesquisa de preços; a IN SEGES/ME 65/2021 recomenda observar a dispersão e a atualidade das fontes. Por isso o produto **sinaliza** em vez de excluir automaticamente (DEC-020): a decisão de desconsiderar uma cotação é sempre humana e justificada (US-027).
- Hoje, times de planejamento percebem cotações destoantes "no olho" ou só na auditoria posterior; cotações antigas (ex.: orçamento de fornecedor com mais de 180 dias — art. 23, §1º, IV) muitas vezes só são notadas depois de a pesquisa já estar concluída.
- Reaproveita o motor de cálculo de US-029 (`PriceCalculationService`) e os metadados de validade por tipo de fonte definidos em `CatalogItem.metadata` (`PRICE_SOURCE_TYPE.maxAgeDays`/`ageReference`), já usados por US-026 para exigir campos.

## Objetivo
Garantir que 100% das cotações válidas tenham `outlierFlag`/`isExpired` corretos após cada recálculo e que todo `PriceItem` com `validQuotationsCount < minQuotations`, CV acima do limiar, outlier presente, cotação vencida ou nenhuma cotação válida exiba o(s) alerta(s) correspondente(s) em até 1 segundo, sem nenhuma exclusão automática.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`) — revisa os alertas antes de concluir.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), Autoridade competente (`AUTORIDADE`) — veem os alertas ao analisar o processo.

## Pré-condições
- `PriceItem` calculado conforme US-029 (estatísticas presentes quando houver cotações válidas).
- Catálogo `PRICE_SOURCE_TYPE` com metadados de validade (`maxAgeDays`/`ageReference`) configurados para os tipos que a exigem (ex.: pesquisa direta — art. 23, §1º, IV).
- Usuário com `PROCESS_VIEW` (e `PROCESS_VIEW_CONFIDENTIAL_BUDGET` quando o orçamento for sigiloso) para visualizar os alertas.

## Fluxo principal
1. O `PriceCalculationService` (US-029), ao recalcular um item, para cada `Quotation` com `status = VALID`:
   1. calcula a mediana das **demais** cotações válidas do item (excluindo a própria); com menos de 2 outras cotações válidas, `outlierFlag = NONE` (comparação não é confiável);
   2. com 2 ou mais outras, marca `LOW` se `unitPrice` < mediana das demais × `outlierLowerPercent` / 100; `HIGH` se > mediana das demais × `outlierUpperPercent` / 100; senão `NONE`;
   3. calcula `isExpired`: obtém `maxAgeDays`/`ageReference` do `PRICE_SOURCE_TYPE` da fonte da cotação; sem `maxAgeDays` configurado, `isExpired = false`; com `maxAgeDays`, compara `priceResearch.referenceDate` com a data de referência da fonte (`quoteDate` ou `accessedAt`, conforme `ageReference`) — vencida se a diferença exceder `maxAgeDays`.
2. O sistema consolida, no `PriceItem`, o array `alerts` (RN-PRICE-50) e atualiza `PriceResearch.itemsWithAlertsCount`.
3. A tela SCR-009 exibe, por item, os selos de alerta (ex.: "Abaixo do mínimo de cotações", "Dispersão alta", "Há cotações destoantes", "Cotação vencida", "Sem cotações válidas") e, por cotação, o selo de outlier/vencida no card da fonte.
4. O usuário revisa: pode excluir a cotação destoante com justificativa (US-027), buscar cotação adicional (US-026) ou seguir assim mesmo — nenhum alerta bloqueia o cálculo; apenas `NO_VALID_QUOTES` e `BELOW_MINIMUM_QUOTES` sem justificativa bloqueiam a **conclusão** da pesquisa (US-032).

## Fluxos alternativos
- **FA-01 — Cotação deixa de ser outlier após exclusão de outra:** ao excluir (US-027) a cotação que distorcia a mediana, o recálculo (US-029) reavalia `outlierFlag` de todas as cotações restantes do item.
- **FA-02 — Tipo de fonte sem validade configurada:** cotações desse tipo nunca ficam `isExpired = true` (ex.: nota fiscal de contratação similar sem prazo definido pelo tenant).
- **FA-03 — Item com exatamente o mínimo de cotações:** `validQuotationsCount = minQuotations` não gera `BELOW_MINIMUM_QUOTES` (alerta é por `<`, não `≤`).
- **FA-04 — Múltiplos alertas simultâneos:** um item pode exibir `HIGH_CV` e `HAS_OUTLIERS` e `EXPIRED_QUOTES` ao mesmo tempo; a UI lista todos, sem priorização implícita.
- **FA-05 — Processo com orçamento sigiloso:** os selos de outlier continuam visíveis (indicam apenas destaque relativo), mas os valores numéricos ficam mascarados para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia atual (POL-09).

## Regras de negócio
- **RN-PRICE-48** — `outlierFlag` por cotação válida: calculado contra a mediana das **demais** cotações válidas do mesmo item; com menos de 2 outras, `NONE`; abaixo de `outlierLowerPercent`% dessa mediana → `LOW`; acima de `outlierUpperPercent`% → `HIGH`; caso contrário `NONE`. Sinalização apenas — nenhuma cotação é excluída automaticamente (DEC-020).
- **RN-PRICE-49** — `isExpired` por cotação: `false` quando o tipo de fonte (`PRICE_SOURCE_TYPE.metadata`) não define `maxAgeDays`; caso defina, compara `priceResearch.referenceDate` com `quoteDate`/`accessedAt` da fonte (conforme `ageReference`) — vencida quando a diferença excede `maxAgeDays` dias corridos.
- **RN-PRICE-50** — `PriceItem.alerts` (recalculado junto das estatísticas): `NO_VALID_QUOTES` (`validQuotationsCount = 0`); `BELOW_MINIMUM_QUOTES` (`0 < validQuotationsCount < minQuotations`); `HIGH_CV` (`coefficientOfVariation > cvThresholdPercent`, só com `validQuotationsCount ≥ 2`); `HAS_OUTLIERS` (alguma cotação válida com `outlierFlag ≠ NONE`); `EXPIRED_QUOTES` (alguma cotação válida com `isExpired = true`). Os alertas coexistem; nenhum é exclusivo.
- **RN-PRICE-51** — `PriceResearch.itemsWithAlertsCount` = quantidade de `PriceItem` com `alerts` não vazio; recalculado no mesmo evento `PriceResearchRecalculated` do item (US-029).
- **RN-PRICE-52** — `Quotation` com `status = EXCLUDED` não participa do cálculo da mediana das demais nem conta para nenhum alerta; é tratada como inexistente para este cálculo (mas permanece visível e auditável — US-027).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| *(sistema)* Destaque da cotação | `outlierFlag` | enum (`OutlierFlag`) | — | RN-PRICE-48; somente leitura | calculado |
| *(sistema)* Cotação vencida | `isExpired` | booleano | — | RN-PRICE-49; somente leitura | calculado |
| *(sistema)* Alertas do item | `alerts` | lista (jsonb) | — | RN-PRICE-50; somente leitura | calculado |
| *(sistema)* Itens com alerta | `itemsWithAlertsCount` | inteiro | — | RN-PRICE-51; somente leitura | calculado |

Não há campos de entrada nesta story: todos os indicadores são calculados pelo motor de US-029 e expostos somente leitura.

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Tentativa de enviar `outlierFlag`, `isExpired` ou `alerts` no corpo de `PATCH /quotations/{id}` ou `/price-items/{itemId}` | API | "Este campo é calculado pelo sistema e não pode ser alterado diretamente." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-02 | `outlierLowerPercent` ≥ `outlierUpperPercent` ao configurar a pesquisa (herdado de US-024/029) | API | "O limite inferior de destaque deve ser menor que o superior." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |

## Permissões
- **Permissão:** nenhuma permissão de escrita própria — leitura segue `PROCESS_VIEW` (processo visível, DEC-024); valores monetários nos alertas/selos seguem POL-09 (`PROCESS_VIEW_CONFIDENTIAL_BUDGET` ou custódia atual).
- **Políticas:** POL-09 (mascaramento de valores em selos de outlier e nos alertas que exibem percentuais sobre preço).
- **MFA:** não aplicável (não há ação de escrita nesta story).
- **Sem permissão de visualizar o processo:** recurso não aparece (404), conforme DEC-024.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PriceResearchRecalculated` | `price_research.recalculated` | Reaproveitado de US-029 | Mesmo evento; esta story amplia o cálculo que o antecede, sem publicar evento próprio |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: os alertas são sinalizações passivas, visíveis na tela da pesquisa e no mapa comparativo (US-031); não há push assíncrono para não gerar fadiga de notificação a cada recálculo. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Sinalizar outliers e alertas de conformidade

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a pesquisa de preços "PR-01" usa limite inferior de destaque "70" e superior "130", mínimo de cotações "3"
    And o usuário "Marcos" tem "PROCESS_VIEW" sobre o processo "0012/2026"

  Scenario: [Sucesso] Cotação muito abaixo da mediana das demais é sinalizada como baixa
    Given que o "Item 1" tem as cotações válidas "100,00", "100,00" e "40,00"
    When o sistema recalcular o item
    Then a cotação de "40,00" deve ter "outlierFlag" igual a "LOW"
    And o item deve ter o alerta "HAS_OUTLIERS"
    And nenhuma cotação deve ser excluída automaticamente

  Scenario: [Sucesso] Item sem cotações válidas recebe o alerta correspondente
    Given que o "Item 2" não tem nenhuma cotação com status "VALID"
    When o sistema recalcular o item
    Then o item deve ter o alerta "NO_VALID_QUOTES"
    And "recommendedUnitPrice" deve permanecer nulo

  Scenario: [Validação] Tentativa de alterar o destaque calculado diretamente
    When "Marcos" enviar PATCH para uma cotação com o campo "outlierFlag" no corpo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "outlierFlag"

  Scenario: [Permissão] Usuário sem PROCESS_VIEW não enxerga os alertas
    Given que o usuário "Bruno" não tem "PROCESS_VIEW" sobre o processo "0012/2026"
    When "Bruno" tentar abrir a pesquisa "PR-01"
    Then a API deve responder 404 com código "PRICE_RESEARCH_NOT_FOUND"

  Scenario: [Tenant incorreto] Pesquisa de outro tenant
    When "Marcos", no tenant "Prefeitura de São José", solicitar os itens de uma "priceResearchId" existente apenas na "Prefeitura B"
    Then a API deve responder 404 com código "PRICE_RESEARCH_NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Recalcular duas vezes sem nenhuma mudança não duplica alertas
    Given que o "Item 1" já está com o alerta "HAS_OUTLIERS"
    When o recálculo for acionado novamente sem nenhuma cotação alterada
    Then o item deve continuar com exatamente um registro do alerta "HAS_OUTLIERS" na lista
    And "itemsWithAlertsCount" não deve ser contado em duplicidade

  Scenario: [Concorrência] Exclusão de cotação concorrente com o recálculo de outlier
    Given que o "Item 1" tem três cotações válidas e está sendo recalculado
    When uma cotação for excluída (US-027) nesse exato intervalo
    Then o recálculo final deve considerar apenas as cotações "VALID" após a exclusão
    And o "outlierFlag" das cotações restantes deve refletir a mediana sem a cotação excluída

  Scenario: [Falha de banco] Banco indisponível durante o recálculo de alertas
    Given que o banco de dados fica indisponível durante a transação
    When uma cotação for editada e o recálculo de alertas for disparado
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And os alertas anteriores do item devem permanecer inalterados

  Scenario: [Falha de integração] Fila de eventos indisponível ao publicar o recálculo
    Given que a fila "domain-events" está indisponível
    When o recálculo alterar o alerta "HAS_OUTLIERS" do "Item 1"
    Then o alerta já deve estar refletido na leitura síncrona da pesquisa
    And o evento "PriceResearchRecalculated" deve permanecer "PENDING" no outbox até a fila voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo calculado enviado no corpo | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Este campo é calculado pelo sistema." | Ignora/rejeita o campo |
| Faixas de outlier inválidas | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | "O limite inferior de destaque deve ser menor que o superior." | Marca os dois campos |
| Processo/pesquisa não visível | 404 | `PRICE_RESEARCH_NOT_FOUND` | "Pesquisa não encontrada." | Redireciona à lista de processos |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível calcular os alertas agora. Tente novamente em instantes." | Mantém alertas anteriores visíveis |

## Dependências
- **Stories:** US-029 (motor de cálculo que esta story estende), US-026 (metadados de validade por tipo de fonte, cotações), US-027 (exclusão/restauração reabre o cálculo de outlier). US-031 e US-032 consomem `alerts`/`itemsWithAlertsCount`.
- **Decisões/ADRs:** DEC-020 (outliers sinalizados, nunca excluídos automaticamente), DEC-024 (visibilidade), DEC-030/POL-09 (sigilo).
- **Configurações:** `priceResearch.outlierLowerPercent`, `priceResearch.outlierUpperPercent`, `priceResearch.minQuotations`, `priceResearch.cvThresholdPercent`, `priceResearch.directQuoteMaxAgeDays`, `priceResearch.similarContractMaxAgeDays`.
- **Lacunas nas fontes canônicas:** nenhuma — todos os nomes de alerta (`BELOW_MINIMUM_QUOTES`, `HIGH_CV`, `HAS_OUTLIERS`, `EXPIRED_QUOTES`, `NO_VALID_QUOTES`) já estão definidos nas notas de domínio do pacote do épico.

## Impacto técnico
- Estende `PriceCalculationService` (US-029) com os sub-cálculos de outlier e expiração; não introduz nova transação nem novo evento — roda sempre junto do recálculo de estatísticas para evitar dois estados intermediários inconsistentes (estatística nova com alerta antigo).
- Cálculo de outlier é O(n²) por item no pior caso (mediana das demais, por cotação); com o limite prático de fontes por item (dezenas, não centenas — mesmo teto de US-031), o custo é desprezível.
- `isExpired` depende de `CatalogItem.metadata` de `PRICE_SOURCE_TYPE`; mudança de metadados do catálogo não recalcula retroativamente até o próximo recálculo do item (aceitável — recálculo manual via `PRS-20` cobre o caso).

## Backend
- **Módulo(s):** `price-research` (dono, estende `PriceCalculationService`); usa `catalog` (`CatalogFacade.getMetadata('PRICE_SOURCE_TYPE', id)`).
- **Casos de uso:** nenhum novo comando; estende `RecalculatePriceItemCommand` (US-029) com a etapa de outlier/expiração.
- **Domínio:** `Quotation.flagOutlier(medianOfOthers, thresholds)`; `Quotation.computeExpiration(sourceMetadata, referenceDate)`; `PriceItem.consolidateAlerts()`.
- **Integrações internas:** `catalog` para metadados do tipo de fonte.
- **Transação:** mesma transação do recálculo de US-029 (nenhuma transação adicional).

## Frontend
- **Tela(s):** SCR-009 (`/processos/[id]/pesquisa-precos/[researchId]`); selos reaproveitados em SCR-010 (mapa comparativo, US-031).
- **Componentes:** `AlertBadgeList` (por item), `OutlierBadge`/`ExpiredBadge` (por cotação, com tooltip explicando o motivo e o percentual comparado).
- **Estados:** nenhum estado de carregamento próprio (acompanha o do recálculo de US-029); empty state "Sem alertas" quando `alerts` vazio.
- **Acessibilidade e responsividade:** selos com texto alternativo (não só cor) para leitores de tela e para daltonismo; tooltips acessíveis por teclado.

## Banco de dados
- **Tabelas:** `quotations` (escrita de `outlier_flag`, `is_expired`), `price_items` (escrita de `alerts`), `price_research` (escrita de `items_with_alerts_count`).
- **Migrações:** nenhuma (colunas já existem desde US-026/US-024 — entities.md §`Quotation`/§`PriceItem`).
- **Índices/constraints relevantes:** nenhum novo; `alerts` é `jsonb`, sem índice dedicado (volume por item é pequeno).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRS-05 | GET | `/price-research/{id}/items` | — | `200 { data: PriceItem[] }` com `alerts[]` e cotações aninhadas com `outlierFlag`/`isExpired` | 200, 403, 404 |
| PRS-03 | GET | `/price-research/{id}` | — | `200 { data: PriceResearch }` com `itemsWithAlertsCount` | 200, 403, 404 |

## Logs
- `info` `price_research.alerts_changed` — `priceResearchId`, `priceItemId`, `alertsBefore[]`, `alertsAfter[]`, `correlationId`.
- `warn` `price_research.outlier_calc_slow` — cálculo de outlier de um item acima de 300 ms.
- **Nunca logar:** preços unitários ou o percentual exato comparado (apenas o fato de ter mudado o conjunto de alertas).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `price_research.recalculate` | `DATA_CHANGE` | Reaproveitado de US-029 | `metadata` passa a incluir `alertsChanged: boolean` |

## Testes necessários
- **Unitários:** `flagOutlier` nas três faixas (`LOW`/`NONE`/`HIGH`) e com `< 2` outras cotações; `computeExpiration` com e sem `maxAgeDays`; consolidação dos cinco alertas isolados e combinados.
- **Integração (Testcontainers):** alerta `HAS_OUTLIERS` desaparece após excluir a cotação destoante; `EXPIRED_QUOTES` aparece ao avançar `referenceDate` além do prazo.
- **API/contrato:** `PRS-03`/`PRS-05` retornam `alerts`/`outlierFlag`/`isExpired` conforme api.md/entities.md.
- **RBAC e multi-tenant:** processo de outro tenant → 404; sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` → valores mascarados nos selos.
- **Concorrência:** exclusão de cotação concorrente com leitura do mapa não retorna estado parcial (transação única).
- **E2E (Playwright):** cadastrar cotação destoante e ver o selo aparecer na tela sem reload.
- **Acessibilidade/performance:** axe nos selos (contraste e texto alternativo); cálculo de outlier para 50 fontes por item < 300 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Nenhuma cotação é excluída automaticamente em nenhum teste (asserção explícita)
- [ ] `alerts`/`outlierFlag`/`isExpired` recalculados nos mesmos gatilhos de US-029, verificado em teste de integração
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRS-03/05 compatível com api.md (campos `alerts`, `outlierFlag`, `isExpired`)
- [ ] Logs sem dados sensíveis
- [ ] Selos acessíveis (axe sem violações sérias) e responsivos
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — lógica de comparação e consolidação de alertas é direta, mas multiplica casos de borda (contagem de cotações, combinações de alerta) que exigem cobertura de teste cuidadosa.

## Prioridade
**P1** — importante para a qualidade da pesquisa e para a defensabilidade do preço estimado, mas o cálculo básico (US-029) já entrega valor sem esta sinalização.
