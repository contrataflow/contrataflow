---
id: FT-021
title: "Identificação e avaliação"
epic: EP-005
mvp: 1
priority: P0
stories: [US-033]
status: Especificada
---

# FT-021 — Identificação e avaliação

## Título
Identificação e avaliação de riscos

## Épico
EP-005 — Mapa de riscos

## Descrição
Entrega o cadastro de riscos do processo: registro com código sequencial, categoria, fase, causa, consequência, responsável e avaliação por probabilidade × impacto numa escala configurável por tenant. O sistema calcula automaticamente score e nível, preservando a escala usada em cada avaliação (`scaleSnapshot`) para rastreabilidade histórica. É a base de dados consumida pelo tratamento (FT-022) e pela matriz/documento (FT-023).

## Valor para o usuário e para o órgão
- Substitui planilhas avulsas por um cadastro único, vinculado ao processo, com histórico de reavaliação.
- Padroniza a escala de probabilidade × impacto por tenant, permitindo comparar riscos entre processos.
- Dá visibilidade imediata do nível de risco (cor/selo) sem depender de cálculo manual.

## Personas
- Gestor de contratações (`GESTOR_CONTRATACOES`) — registra e avalia riscos.
- Planejamento (`PLANEJAMENTO`) / Área requisitante (`REQUISITANTE`) — contribuem com causas, consequências e dados do objeto.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-033 | Registrar e avaliar riscos | P0 | M | US-001, US-104 |

## Escopo
- Cadastro de `Risk` com código sequencial por processo (`R01`, `R02`…), categoria (`RISK_CATEGORY`), fase (`RiskPhase`), causa, consequência e responsável (usuário ou unidade).
- Avaliação por grade de probabilidade × impacto (`risk.scale`), cálculo de `score`/`level` pelas faixas vigentes (`risk.levelThresholds`) e registro de `scaleSnapshot`.
- Reavaliação (alteração de probabilidade/impacto) com emissão de `RiskAssessed`.
- Risco residual opcional (probabilidade/impacto/score/nível residuais).
- Bloqueio de criação/edição/exclusão quando o Mapa de Riscos do processo estiver fora de `DRAFT`/`RETURNED`.

## Fora de escopo
- Cadastro e acompanhamento de ações de tratamento — FT-022.
- Matriz de calor consolidada e emissão do documento Mapa de Riscos — FT-023.

## Regras de negócio da feature
- RN-RISK-01 a RN-RISK-10 (ver US-033): obrigatoriedade de campos, geração de `code`, cálculo de `score`/`level`, `scaleSnapshot`, ativação do catálogo `RISK_CATEGORY`, risco residual e condição de editabilidade.

## Telas
- SCR-011 — Riscos (mapa de riscos) (`/processos/[id]/riscos`)

## Endpoints
- RSK-01 `GET /processes/{id}/risks` — listar riscos do processo
- RSK-02 `POST /processes/{id}/risks` — criar risco
- RSK-03 `GET /risks/{id}` — detalhar risco
- RSK-04 `PATCH /risks/{id}` — editar/reavaliar risco
- RSK-05 `DELETE /risks/{id}` — excluir risco
- CAT-01 `GET /catalogs/{catalogType}/items` — itens ativos de `RISK_CATEGORY` (leitura de apoio)

## Entidades
- `Risk` — dono da feature.
- `CatalogItem` (`RISK_CATEGORY`) — consumida para categorização.

## Eventos
- `RiskCreated` — na criação de um risco.
- `RiskAssessed` — quando probabilidade e/ou impacto mudam.
- `RiskDeleted` — na exclusão de um risco.

## Permissões
- `RISK_MANAGE` — criar, editar, reavaliar e excluir riscos.

## Dependências
- Stories: US-001 (processo precisa existir), US-104 (catálogo `RISK_CATEGORY` ativo).
- Decisões: DEC-010, DEC-021, DEC-024.

## Critérios de aceite da feature
```gherkin
Feature: Identificação e avaliação de riscos
  Scenario: Registrar e reavaliar um risco ao longo do processo
    Given que o processo "0012/2026" está em andamento
    When o usuário registrar o risco "R01" com probabilidade 4 e impacto 4
    Then o risco deve ter score 16 e nível "HIGH"
    When o usuário reavaliar "R01" com probabilidade 2
    Then o risco deve passar a ter score 8 e nível "MEDIUM"
    And o histórico de avaliação deve preservar a escala usada em cada avaliação
```

## Métricas de sucesso
- Tempo médio para registrar o primeiro risco do processo ≤ 5 dias úteis após a criação do processo.
- 100% dos riscos criados com `score`/`level` consistentes com a escala vigente no momento da avaliação.

## Riscos
- Mudança de `risk.scale`/`risk.levelThresholds` pelo tenant confundir a leitura de riscos antigos — mitigado por `scaleSnapshot` (RN-RISK-04) e por a matriz (FT-023) sempre usar a escala vigente.

## Definition of Done da feature
- [ ] US-033 concluída e aceita
- [ ] Jornada E2E de registrar e reavaliar um risco automatizada
- [ ] Documentação (este card e fontes canônicas) atualizada
