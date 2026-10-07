---
id: FT-013
title: "Estimativas"
epic: EP-003
mvp: 1
priority: P0
stories: [US-022]
status: Especificada
---

# FT-013 — Estimativas

## Título
Estimativas

## Épico
EP-003 — Estudo Técnico Preliminar (ETP)

## Descrição
Cobre a estimativa de quantidades dos itens do ETP — com memória de cálculo — e a definição do valor estimado total, manualmente ou vinculado à pesquisa de preços do processo. Quando vinculado, o valor é derivado e permanece sincronizado automaticamente com os recálculos e a conclusão da pesquisa, atendendo ao art. 18, §1º, IV e VI, da Lei 14.133/2021.

## Valor para o usuário e para o órgão
- Evita divergência entre o valor do ETP e o valor apurado na pesquisa de preços, sem reentrada manual.
- Documenta a memória de cálculo de cada item, fundamentando a quantidade diante de auditorias.

## Personas
- Redator do ETP (`REQUISITANTE`/`PLANEJAMENTO`) — ajusta quantidades e define a origem do valor.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — acompanha o valor consolidado.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-022 | Estimar quantidades e vincular valor à pesquisa de preços | P0 | M | US-019, US-029 |

## Escopo
- Edição de quantidade e memória de cálculo por item (`DocumentItem`), herdados do DFD.
- Definição do valor estimado total: manual ou vinculado à pesquisa de preços do processo (`priceResearchId`).
- Sincronização automática do valor vinculado ao recalcular/concluir a pesquisa.
- Mascaramento do valor conforme POL-09.

## Fora de escopo
- Elaboração da pesquisa de preços em si (fontes, cotações, estatísticas) — EP-004.
- Exigir item e valor presentes para concluir o ETP — FT-014 (US-023).

## Regras de negócio da feature
- RN-ETP-25 a RN-ETP-32 (itens espelham `ProcessItem`, quantidade/memória de cálculo, origem do valor, sincronização automática, mascaramento) — US-022.

## Telas
- SCR-008 — ETP (editor por seções), seção "Estimativas" (`/processos/[id]/etp/[etpId]`)

## Endpoints
- DOC-06 `GET /documents/{id}/items` — listar itens
- DOC-07 `PUT /documents/{id}/items` — salvar quantidade/memória de cálculo
- ETP-04 `PATCH /etps/{id}` — definir origem/valor/pesquisa vinculada
- PRS-01 `GET /processes/{id}/price-research` — listar pesquisas do processo
- PRS-03 `GET /price-research/{id}` — valor total da pesquisa

## Entidades
- `DocumentItem` — quantidade e memória de cálculo (compartilhada com `document`)
- `Etp` — `estimatedTotalValue`, `estimatedValueSource`, `priceResearchId`
- `PriceResearch` — consumida (origem do valor vinculado)

## Eventos
- Nenhum evento próprio; consome `PriceResearchRecalculated` e `PriceResearchCompleted` (US-029/US-032) para sincronizar o valor vinculado.

## Permissões
- `ETP_UPDATE` — editar itens e valor estimado

## Dependências
- Stories: US-019 (ETP e itens importados), US-029 (cálculo do valor na pesquisa), US-024 (criação da pesquisa de preços).
- Decisões: DEC-016, DEC-017, DEC-018, DEC-019, DEC-020, DEC-032, DEC-056.

## Critérios de aceite da feature
```gherkin
Feature: Estimativas
  Scenario: Vincular o valor do ETP à pesquisa de preços e mantê-lo sincronizado
    Given que a pesquisa de preços do processo está concluída com valor total "R$ 125.000,00"
    When o usuário vincular o ETP a essa pesquisa
    Then o valor estimado do ETP deve ser "R$ 125.000,00" e somente leitura
    When a pesquisa for recalculada com novo valor total "R$ 130.000,00"
    Then o valor estimado do ETP deve ser atualizado automaticamente para "R$ 130.000,00"
```

## Métricas de sucesso
- ≥ 60% dos ETPs concluídos com valor vinculado à pesquisa de preços (vs. manual).
- Tempo de propagação do recálculo da pesquisa ao ETP vinculado ≤ 5 s em ambiente de teste.

## Riscos
- Usuários optarem por valor manual para "travar" um número desatualizado — mitigado por indicação visual da origem do valor e, na conclusão (US-023), exigência apenas de presença (não de uma origem específica) — decisão de produto, não lacuna técnica.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
