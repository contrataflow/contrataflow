---
id: FT-004
title: "Manter dados do processo"
epic: EP-001
mvp: 1
priority: P0
stories: [US-005, US-006, US-007]
status: Especificada
---

# FT-004 — Manter dados do processo

## Título
Manter dados do processo

## Épico
EP-001 — Processo de contratação

## Descrição
Manutenção dos dados do processo depois de criado: edição dos campos cadastrais (US-005), gestão dos itens canônicos da contratação que alimentam DFD, ETP, pesquisa de preços e TR (US-006) e etiquetas livres do órgão aplicadas ao processo (US-007). Todas exigem custódia (POL-01) e status editável.

## Valor para o usuário e para o órgão
- Corrige e completa dados sem recriar o processo.
- Mantém uma lista única de itens, evitando divergência de descrição e unidade entre documentos.
- Classifica processos por temas que não existem nos catálogos formais.

## Personas
- Servidor que está com o processo (responsável atual ou unidade atual) — edição.
- Gestor de contratações — cadastro de etiquetas (`TAG_MANAGE`).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-005 | Editar dados do processo | P0 | M | US-001 |
| US-006 | Gerenciar itens da contratação | P0 | M | US-001, US-104 |
| US-007 | Gerenciar etiquetas do processo | P2 | S | US-005 |

## Escopo
- `PATCH` parcial dos dados cadastrais, com política de bloqueio por status e por campo.
- CRUD e reordenação de itens, com agrupamento em lotes.
- Cadastro de etiquetas (nome/cor) e aplicação ao processo (até 10).

## Fora de escopo
- Campos de runtime (status, etapa, responsável, numeração) — nunca editáveis por `PATCH` (RN-PROC-65).
- Quantidade e preço de referência dos itens — somente leitura, atualizados por documentos aprovados (DEC-019).

## Regras de negócio da feature
- RN-PROC-59 a RN-PROC-70 (US-005): custódia, bloqueio por status/campo, valor estimado manual (DEC-032), concorrência otimista, `PATCH` sem diferença não gera versão/evento.
- RN-PROC-71 a RN-PROC-84 (US-006): campos editáveis vs. somente leitura, numeração de itens, reordenação, lotes, `ITEM_IN_USE`, limite de 1.000 itens, mascaramento do preço de referência.
- RN-PROC-85 a RN-PROC-92 (US-007): unicidade de nome, desativação sem exclusão, substituição do conjunto completo, limite de 10 etiquetas por processo.

## Telas
- SCR-006 — Detalhe do processo (cabeçalho e aba Itens)
- SCR-004 — Processos (filtro e exibição de etiquetas)
- SCR-109 — Catálogos (cadastro de etiquetas)

## Endpoints
- PRC-05 `PATCH /processes/{id}`
- PRC-13, PRC-14, PRC-15, PRC-16, PRC-17 — itens (listar, criar, editar, excluir, reordenar)
- PRC-18 `PUT /processes/{id}/tags`
- TAG-01, TAG-02, TAG-03 — cadastro de etiquetas

## Entidades
- `Process` (dados cadastrais), `ProcessItem`, `Tag`, `ProcessTag`

## Eventos
- `ProcessUpdated` (dados e etiquetas), `ProcessItemsChanged` (itens)

## Permissões
- `PROCESS_UPDATE`, `PROCESS_VIEW`, `TAG_MANAGE`

## Dependências
- US-001 (processo), US-104 (catálogo de unidade de medida), US-005 (base de versão do agregado para US-007).
- Decisões: DEC-019, DEC-023, DEC-025, DEC-027, DEC-028, DEC-029, DEC-032, DEC-055, DEC-104, DEC-105, DEC-161.

## Critérios de aceite da feature
```gherkin
Feature: Manter dados do processo
  Scenario: Editar dados, ajustar itens e aplicar etiquetas
    Given que "Diego" está com o processo "0012/2026" em "IN_PROGRESS"
    When ele corrigir o valor estimado manual, adicionar um item e aplicar a etiqueta "Obras emergenciais"
    Then o processo deve refletir os novos dados, o novo item e a etiqueta
    And cada alteração deve gerar o respectivo evento, timeline e auditoria
```

## Métricas de sucesso
- 100% das alterações com `changedFields`/diff registrado em auditoria (nenhuma edição silenciosa).

## Riscos
- Alterar unidade/natureza de item já referenciado por documento aprovado gerando divergência — mitigado por confirmação explícita listando os documentos afetados (RN-PROC-80).

## Definition of Done da feature
- [ ] US-005 e US-006 (P0) concluídas e aceitas; US-007 (P2) concluída
- [ ] Jornada E2E (editar, gerenciar itens, aplicar etiquetas) automatizada
- [ ] Documentação atualizada
