---
id: FT-020
title: "Conclusão da pesquisa"
epic: EP-004
mvp: 1
priority: P0
stories: [US-032]
status: Especificada
---

# FT-020 — Conclusão da pesquisa

## Título
Conclusão da pesquisa

## Épico
EP-004 — Pesquisa de preços

## Descrição
Cobre a validação de completude e a conclusão da pesquisa de preços: finaliza o documento (DEC-018), cria a versão imutável, bloqueia novas edições e propaga o preço de referência para o item do processo, para `Process.estimatedValue` e, de forma assíncrona, para o ETP vinculado.

## Valor para o usuário e para o órgão
- Trava o resultado da pesquisa como evidência formal, com rastreabilidade (versão imutável, hash de conteúdo).
- Elimina a cópia manual do valor estimado entre pesquisa, processo e ETP.

## Personas
- Integrante da equipe de planejamento da contratação (`PLANEJAMENTO`) — conclui a pesquisa quando os itens estiverem prontos.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-032 | Concluir a pesquisa de preços | P0 | M | US-029, US-066 |

## Escopo
- Validação de completude por item (preço calculável ou justificado; mínimo de cotações ou justificativa específica).
- Finalização do documento, versão imutável e atualização de `ProcessItem.referenceUnitPrice`/`Process.estimatedValue`.
- Publicação de `PriceResearchCompleted` para sincronizar o ETP vinculado.

## Fora de escopo
- Cálculo do preço recomendado por item — FT-018.
- Aprovação formal da pesquisa, quando exigida pela etapa do workflow — fora deste épico.

## Regras de negócio da feature
- RN-PRICE-58 a RN-PRICE-63 — US-032.

## Telas
- SCR-009 — Pesquisa de preços (`/processos/[id]/pesquisa-precos/[researchId]`)

## Endpoints
- PRS-23 `POST /price-research/{id}/complete` — concluir

## Entidades
- `PriceResearch`, `PriceItem` — conclusão (dono)
- `Document` / `DocumentVersion` — finalização e versionamento (EP-011)
- `ProcessItem`, `Process` — valores atualizados (EP-001)
- `Etp` — sincronização assíncrona do valor (EP-003, RN-ETP-29)

## Eventos
- `PriceResearchCompleted` (forma tipada de `DocumentFinalized`)
- `DocumentVersionCreated`

## Permissões
- `PRICE_RESEARCH_COMPLETE` — concluir

## Dependências
- Stories: US-029 (preço recomendado), US-030 (alertas revisados, não bloqueantes), US-065 (ciclo de vida), US-066 (versionamento imutável). Impacta US-039 (quantidade ETP × TR não afetada; valor do ETP sincronizado).
- Decisões: DEC-017, DEC-018, DEC-019, DEC-020, DEC-030/POL-09, DEC-032 (precedência de fontes do valor estimado).
- Habilita: EP-003 ETP (valor sincronizado), EP-006 Termo de Referência (consome o valor adiante).

## Critérios de aceite da feature
```gherkin
Feature: Conclusão da pesquisa
  Scenario: Concluir a pesquisa com todos os itens completos
    Given uma pesquisa com todos os itens com preço recomendado e cotações suficientes
    When o usuário concluir a pesquisa
    Then o documento deve finalizar, criar uma versão imutável, atualizar o preço de referência de cada item do processo e o valor estimado do processo

  Scenario: Tentar concluir com item sem cotação válida
    Given um item da pesquisa sem nenhuma cotação válida
    When o usuário tentar concluir a pesquisa
    Then a API deve responder 422 "PRICE_RESEARCH_INCOMPLETE" com a violação "PRICE_ITEM_WITHOUT_PRICE" para esse item
```

## Métricas de sucesso
- 100% das pesquisas concluídas propagam o valor ao `ProcessItem`/`Process` na mesma transação, sem reconciliação manual.

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| ETP vinculado não ser atualizado por falha no consumidor assíncrono do evento | Baixa | Médio | Consumidor idempotente (RN-PRICE-62); reentrega padrão de outbox do sistema |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
