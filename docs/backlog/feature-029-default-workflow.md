---
id: FT-029
title: "Workflow padrão e aplicabilidade"
epic: EP-007
mvp: 1
priority: P0
stories: [US-042]
status: Especificada
---

# FT-029 — Workflow padrão e aplicabilidade

## Título
Workflow padrão e aplicabilidade

## Épico
EP-007 — Workflow

## Descrição
Esta feature garante que todo tenant provisionado já nasce com workflow funcionando, sem configuração manual: dois workflows são semeados diretamente publicados — "Fase preparatória — Lei 14.133/2021" (padrão, 7 etapas, DEC-015) e "Contratação direta — Lei 14.133/2021, art. 72" (para modalidades `DISPENSA`/`INEXIGIBILIDADE`) — e a resolução de qual workflow se aplica a cada processo novo é automática, por `applicabilityRule` (JSON Logic) em ordem de prioridade, com o workflow padrão como rede de segurança.

## Valor para o usuário e para o órgão
- Nenhum processo fica sem workflow aplicável desde o primeiro dia do tenant.
- Contratações diretas seguem automaticamente um rito mais simples, sem o administrador precisar configurar nada.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`, com `WORKFLOW_PUBLISH`) — revisa/troca qual workflow é o padrão.
- Qualquer usuário que cria um processo — consumidor indireto, via a resolução automática (`WF-06`).
- Sistema de provisionamento (ator `SYSTEM`) — executa o seeder.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-042 | Workflow padrão e seleção por aplicabilidade | P0 | M | US-041, US-104 |

## Escopo
- Seeder idempotente dos dois workflows publicados no provisionamento do tenant.
- Endpoint de resolução de workflow aplicável (`WF-06`), consumido pela criação do processo (EP-001).
- Troca do workflow padrão (`WF-05`) pelo administrador.

## Fora de escopo
- Edição dos workflows semeados (usa o editor da FT-030).
- Criação de novos workflows pelo administrador (FT-030).

## Regras de negócio da feature
- RN-WF-34 — seeder cria exatamente dois workflows por tenant, com chaves estáveis; reexecução é no-op.
- RN-WF-39 — resolução avalia workflows ativos com versão publicada em ordem de `applicabilityPriority`; sem correspondência, usa o `isDefault`; sem nenhum, `NO_APPLICABLE_WORKFLOW`.
- RN-WF-40 — exatamente um workflow é `isDefault = true` por tenant; `set-default` troca atomicamente.

## Telas
- SCR-034 — Workflow (lista e editor) — `/admin/workflows` (seleção/indicação do padrão).

## Endpoints
- WF-05 `POST /workflows/{id}/set-default` — define o workflow padrão
- WF-06 `POST /workflows/resolve` — resolve o workflow aplicável a um conjunto de atributos do processo

## Entidades
- `Workflow` (`isDefault`, `applicabilityRule`, `applicabilityPriority`) — dono da configuração de aplicabilidade.
- `WorkflowVersion` — semeada diretamente em `PUBLISHED`.

## Eventos
- `WorkflowDefaultChanged` — ao trocar o workflow padrão.

## Permissões
- `WORKFLOW_VIEW` — consulta/resolução.
- `WORKFLOW_PUBLISH` — troca do padrão.

## Dependências
- US-041 (motor que avalia `applicabilityRule`), US-104 (catálogo `MODALITY` com `DISPENSA`/`INEXIGIBILIDADE`).
- Indiretas: US-099 (provisionamento, executa o seeder), US-040 (modelo que o seeder povoa), US-001 (consumidor de `WF-06`, EP-001).

## Critérios de aceite da feature
```gherkin
Feature: Workflow padrão e aplicabilidade
  Scenario: Processo de contratação direta resolve o workflow simplificado automaticamente
    Given que o tenant foi provisionado com os dois workflows padrão publicados
    When um processo for criado com modalidade "DISPENSA"
    Then o sistema deve resolver o workflow "Contratação direta — Lei 14.133/2021, art. 72"
    And um processo criado com outra modalidade deve resolver o workflow padrão "Fase preparatória — Lei 14.133/2021"
```

## Métricas de sucesso
- 0% de tenants provisionados sem os dois workflows padrão publicados.
- 0% de processos criados retornando `NO_APPLICABLE_WORKFLOW` no fluxo padrão.

## Riscos
- Seeder não idempotente duplica workflows em reprovisionamento — mitigado por chave estável e verificação de existência antes de criar (RN-WF-34).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
