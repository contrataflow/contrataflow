---
id: FT-018
title: "Cálculos e alertas"
epic: EP-004
mvp: 1
priority: P0
stories: [US-029, US-030]
status: Especificada
---

# FT-018 — Cálculos e alertas

## Título
Cálculos e alertas

## Épico
EP-004 — Pesquisa de preços

## Descrição
Cobre o motor de cálculo das estatísticas de cada item (quantidade de cotações válidas, média, mediana, menor, maior, desvio-padrão amostral, coeficiente de variação), a definição do método efetivo e do preço recomendado, e a sinalização — nunca exclusão automática — de outliers por cotação e de alertas de conformidade por item (poucas cotações, CV alto, outliers, cotações vencidas, nenhuma cotação válida).

## Valor para o usuário e para o órgão
- Produz um preço de referência defensável sem recálculo manual em planilha a cada cotação alterada.
- Aponta fragilidades da pesquisa, sem decidir por excluir nada, reduzindo o risco de questionamento posterior por controle externo.

## Personas
- Integrante da equipe de planejamento da contratação (`PLANEJAMENTO`) — acompanha estatísticas e revisa alertas antes de concluir.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-029 | Calcular estatísticas e valor estimado por item | P0 | M | US-026 |
| US-030 | Sinalizar outliers e alertas de conformidade | P1 | M | US-029 |

## Escopo
- Recálculo síncrono (mesma transação) a cada mudança em cotações, fontes ou parâmetros da pesquisa.
- Método efetivo por item (`methodOverride` ou `defaultMethod`, inclusive `AUTO_CV`) e preço recomendado com arredondamento via `decimal.js`.
- `outlierFlag` por cotação contra a mediana das demais cotações válidas do item; `isExpired` por validade do tipo de fonte; `alerts` consolidados por item.

## Fora de escopo
- Lançamento de fontes/cotações que disparam o recálculo — FT-017.
- Exibição consolidada no mapa comparativo — FT-019.
- Bloqueio de conclusão por alerta — FT-020 (alertas não bloqueiam; apenas exigem justificativa específica quando abaixo do mínimo).

## Regras de negócio da feature
- RN-PRICE-41 a RN-PRICE-47 — US-029.
- RN-PRICE-48 a RN-PRICE-52 — US-030.

## Telas
- SCR-009 — Pesquisa de preços (`/processos/[id]/pesquisa-precos/[researchId]`)

## Endpoints
- PRS-04 `PATCH /price-research/{id}` — alterar parâmetros (dispara recálculo geral)
- PRS-05 `GET /price-research/{id}/items` — estatísticas e alertas por item
- PRS-07 `PATCH /price-items/{itemId}` — método do item (`methodOverride`, inclusive `MANUAL`)
- PRS-20 `POST /price-research/{id}/recalculate` — recálculo sob demanda

## Entidades
- `PriceItem` — estatísticas, método e alertas (dono)
- `Quotation` — `outlierFlag` / `isExpired` (estendida por esta feature)
- `PriceResearch` — `lastCalculatedAt`, `itemsWithAlertsCount`

## Eventos
- `PriceResearchRecalculated` — a cada recálculo (automático ou via `PRS-20`)

## Permissões
- `PRICE_RESEARCH_UPDATE` — alterar método do item ou parâmetros que disparam recálculo

## Dependências
- Stories: US-024 (cria `PriceItem`), US-026 (cotações/fontes), US-027 (exclusão dispara recálculo), US-028 (importação dispara recálculo).
- Decisões: DEC-003, DEC-017, DEC-018, DEC-019, DEC-020, DEC-030.
- Habilitada por esta feature: US-031 (mapa exibe estatísticas/alertas), US-032 (conclusão valida com base no preço recomendado e nos alertas).

## Critérios de aceite da feature
```gherkin
Feature: Cálculos e alertas
  Scenario: Recalcular estatísticas e sinalizar um outlier após lançar uma cotação muito alta
    Given um item com 3 cotações válidas próximas entre si
    When o usuário lançar uma 4ª cotação muito acima das demais
    Then o item deve recalcular média, mediana, desvio e coeficiente de variação, e a nova cotação deve ficar com "outlierFlag: HIGH"
    And, se o CV passar do limite configurado e o método padrão for "AUTO_CV", o preço recomendado deve passar a usar a mediana
```

## Métricas de sucesso
- Recálculo refletido na tela em até 1 requisição após qualquer mudança em cotação/fonte, sem passo manual de "recalcular".

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Usuário interpretar alerta como bloqueio e não entender por que ainda pode concluir | Média | Baixo | Mensagens de alerta na UI explicam que são indicativos; a conclusão só exige justificativa específica para `BELOW_MINIMUM_QUOTES` (US-032) |
| Item com `methodOverride = MANUAL` não refletir mudanças de política do tenant no método padrão | Baixa | Baixo | Comportamento intencional (RN-PRICE-47): preço manual não é afetado pelo método padrão, por desenho |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
