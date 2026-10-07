---
id: FT-010
title: "Reaproveitamento do DFD"
epic: EP-002
mvp: 1
priority: P2
stories: [US-018]
status: Especificada
---

# FT-010 — Reaproveitamento do DFD

## Título
Reaproveitamento do DFD

## Épico
EP-002 — DFD — Documento de Formalização da Demanda

## Descrição
Esta feature entrega a duplicação do DFD (US-018): reaproveitar um DFD já elaborado para iniciar um novo processo semelhante ou para adiantar o DFD de um processo existente que ainda não o tenha, copiando cabeçalho, seções e itens.

## Valor para o usuário e para o órgão
- Reduz o tempo de elaboração de demandas recorrentes (ex.: merenda escolar, combustível, materiais de expediente).
- Preserva a rastreabilidade da origem via `sourceDocumentId`.

## Personas
- Área requisitante (`REQUISITANTE`) — duplica o DFD.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — duplica entre processos de diferentes unidades.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-018 | Duplicar DFD | P2 | S | US-014, US-011 |

## Escopo
- Duplicar para um novo processo (via US-011) ou para um processo existente sem DFD, em etapa que permita o tipo.

## Fora de escopo
- Duplicação de anexos (FA-02 de US-018).
- Duplicação de outros tipos de documento (ETP, TR — outros épicos).

## Regras de negócio da feature
- Exige `DFD_CREATE` no destino, mais `PROCESS_CREATE` se o destino for um novo processo (RN-DFD-72).
- O processo existente deve estar sem DFD ativo e em etapa que permita o tipo (RN-DFD-73).
- Itens são clonados como novos `ProcessItem` no destino, nunca referenciados entre processos (RN-DFD-75, DEC-019).

## Telas
- SCR-113 — Duplicar processo/DFD (diálogo)
- SCR-007 — DFD (destino, após a duplicação)

## Endpoints
- DFD-05 `POST /dfds/{id}/duplicate` — duplicar

## Entidades
- `Dfd`, `Document` — novo documento, com `sourceDocumentId` apontando à origem
- `ProcessItem` — clonados no processo destino

## Eventos
- `ProcessCreated` — quando o destino é um novo processo
- `DocumentCreated` (`DFDCreated`) — sempre
- `ProcessItemsChanged` — quando itens são clonados

## Permissões
- `DFD_CREATE` — duplicar
- `PROCESS_CREATE` — quando o destino é um novo processo

## Dependências
- US-011 (duplicar processo), US-014 (estrutura do DFD), US-006 (`ProcessItem`).

## Critérios de aceite da feature
```gherkin
Feature: Reaproveitamento do DFD
  Scenario: Duplicar um DFD aprovado para um novo processo
    Given que existe um DFD aprovado em um processo concluído
    When a requisitante duplicar o DFD escolhendo "Novo processo"
    Then um novo processo e um novo DFD em rascunho devem existir, com os mesmos itens e cabeçalho de partida
```

## Métricas de sucesso
- % de DFDs criados por duplicação — acompanhar (sem meta definida no MVP 1, feature P2).

## Riscos
- Itens duplicados ficarem inconsistentes entre processos — mitigado pela clonagem explícita (nunca referência cruzada) e por testes de concorrência.

## Definition of Done da feature
- [ ] US-018 concluída e aceita
- [ ] Jornada E2E de duplicação (novo processo e processo existente) automatizada
- [ ] Documentação do fluxo de duplicação atualizada
