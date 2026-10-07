---
id: FT-NNN
title: "<Título da feature>"
epic: EP-NNN
mvp: 1
priority: P0
stories: [US-NNN]
status: Especificada
---

# FT-NNN — <Título da feature>

## Título
<Título>

## Épico
EP-NNN — <título do épico>

## Descrição
<O que a feature entrega, em 1–3 parágrafos.>

## Valor para o usuário e para o órgão
- <benefício mensurável>

## Personas
- <persona> (`<ROLE_KEY>`) — <como usa>

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-NNN | | | | |

## Escopo
- <incluído>

## Fora de escopo
- <excluído e onde será tratado>

## Regras de negócio da feature
- <regras que atravessam as stories, com referência RN-…>

## Telas
- SCR-NNN — <nome> (`/rota`)

## Endpoints
- <ID> `MÉTODO /rota` — <propósito>

## Entidades
- `<Entidade>` — <papel na feature>

## Eventos
- `<Evento>` — <quando>

## Permissões
- `<PERMISSAO>` — <uso>

## Dependências
- <features/stories/decisões>

## Critérios de aceite da feature
```gherkin
Feature: <nome>
  Scenario: <jornada ponta a ponta da feature>
    Given …
    When …
    Then …
```

## Métricas de sucesso
- <métrica + meta>

## Riscos
- <risco> — <mitigação>

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
