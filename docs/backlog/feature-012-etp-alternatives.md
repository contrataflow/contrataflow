---
id: FT-012
title: "Alternativas de solução"
epic: EP-003
mvp: 1
priority: P0
stories: [US-021]
status: Especificada
---

# FT-012 — Alternativas de solução

## Título
Alternativas de solução

## Épico
EP-003 — Estudo Técnico Preliminar (ETP)

## Descrição
Permite registrar as alternativas de solução levantadas para a contratação — com vantagens, desvantagens, custo estimado e nível de risco — e decidir qual delas é a recomendada, com justificativa. Fundamenta o levantamento de mercado (art. 18, §1º, V) e a justificativa da solução escolhida (art. 18, §1º, VII) dentro do ETP, alimentando o quadro comparativo exibido na seção `ALTERNATIVES`.

## Valor para o usuário e para o órgão
- Documenta de forma estruturada por que uma solução foi preferida às demais, reduzindo questionamentos do Controle Interno/TCU.
- Evita decisões "soltas" no texto: a recomendação exige justificativa e é única por ETP.

## Personas
- Redator do ETP (`REQUISITANTE`/`PLANEJAMENTO`) — registra alternativas e decide a recomendada.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-021 | Gerenciar alternativas de solução | P0 | M | US-019 |

## Escopo
- CRUD de `EtpAlternative` (nome único por ETP, descrição obrigatória, vantagens/desvantagens/observações opcionais, custo estimado, nível de risco, ordenação).
- Decisão `UNDER_ANALYSIS`\|`RECOMMENDED`\|`DISCARDED`, com justificativa obrigatória ≥ 20 caracteres fora de `UNDER_ANALYSIS`.
- Unicidade da alternativa recomendada, com substituição explícita (`replaceRecommended`).
- Quadro comparativo (seção `ALTERNATIVES`, `render = ALTERNATIVES_TABLE`), recalculado a cada mudança.
- Mascaramento do custo estimado conforme POL-09.

## Fora de escopo
- Edição das demais seções do ETP — FT-011.
- Exigir uma alternativa recomendada para concluir o ETP como viável — FT-014 (US-023).

## Regras de negócio da feature
- RN-ETP-18 a RN-ETP-24 (unicidade de nome e de recomendada, justificativa da decisão, exclusão lógica, quadro comparativo, mascaramento) — US-021.

## Telas
- SCR-008 — ETP (editor por seções), seção "Alternativas" (`/processos/[id]/etp/[etpId]`)

## Endpoints
- ETP-05 `GET /etps/{id}/alternatives` — listar
- ETP-06 `POST /etps/{id}/alternatives` — criar
- ETP-07 `PATCH /etp-alternatives/{alternativeId}` — editar
- ETP-08 `DELETE /etp-alternatives/{alternativeId}` — excluir (lógica)
- ETP-09 `POST /etp-alternatives/{alternativeId}/decide` — decidir (recomendar/descartar)

## Entidades
- `EtpAlternative` — dono desta feature
- `Etp.recommendedAlternativeId` — desnormalizado, atualizado ao decidir

## Eventos
- `EtpAlternativeRecommended` — ao definir/substituir a alternativa recomendada (US-021)

## Permissões
- `ETP_UPDATE` — criar, editar, excluir e decidir alternativas

## Dependências
- Stories: US-019 (criação do ETP, dono da coleção). Relacionadas: US-020 (seção que exibe o quadro comparativo), US-022 (estimativas detalham custo por item), US-023 (completude exige uma alternativa `RECOMMENDED` quando `VIABLE`).
- Decisões: DEC-010, DEC-017, DEC-019.
- Observação herdada de US-021: não há, em api.md §2.2, código de domínio dedicado para nome de alternativa duplicado no mesmo ETP; usa-se `VALIDATION_ERROR`/`DUPLICATE_IN_LIST` como conceito mais próximo (proposta de código dedicado registrada na story).

## Critérios de aceite da feature
```gherkin
Feature: Alternativas de solução
  Scenario: Registrar alternativas e decidir a recomendada
    Given que o ETP tem duas alternativas em análise
    When o usuário decidir a alternativa "Locação de equipamentos" como "RECOMMENDED" com justificativa
    Then o quadro comparativo deve exibir a decisão e a justificativa
    And "Etp.recommendedAlternativeId" deve apontar para essa alternativa
    And deve gerar o evento "EtpAlternativeRecommended"
```

## Métricas de sucesso
- 100% dos ETPs concluídos como viáveis têm exatamente uma alternativa recomendada com justificativa.

## Riscos
- Usuários registrarem uma única alternativa "pro forma" sem comparação real — mitigado por orientação de UX (`helpText` da seção) e checklist de revisão da autoridade.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
