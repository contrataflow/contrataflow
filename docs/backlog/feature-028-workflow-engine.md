---
id: FT-028
title: "Motor de workflow"
epic: EP-007
mvp: 1
priority: P0
stories: [US-040, US-041]
status: Especificada
---

# FT-028 — Motor de workflow

## Título
Motor de workflow

## Épico
EP-007 — Workflow

## Descrição
Esta feature entrega a fundação de todo o épico: o modelo declarativo versionado (`Workflow` → `WorkflowVersion` → `WorkflowStage`/`WorkflowTransition`/`WorkflowRule`), com validação completa do grafo, imutabilidade garantida após a publicação e snapshot canônico com hash; e o motor de execução — puro, determinístico e somente leitura — que calcula quais ações estão disponíveis em cada etapa e avalia as regras configuradas. É consumida diretamente pelo módulo `process` (tramitação, fora deste épico) e pelas demais features deste épico (FT-029, FT-030), que constroem sobre este modelo.

## Valor para o usuário e para o órgão
- Garante que processos em andamento nunca tenham suas regras alteradas "por baixo" (versão publicada imutável e fixada no processo).
- Garante que toda decisão de "pode avançar ou não" é determinística, auditável e nunca diverge entre o que a interface mostra e o que o backend aceita (mesma fachada usada pelos dois).

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — consumidor indireto: toda configuração das demais features repousa neste modelo.
- Responsável/colaborador de etapa (qualquer perfil com `PROCESS_VIEW`) — usa o motor para saber o que pode fazer agora e o que falta.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-040 | Modelo de definição de workflow versionado | P0 | L | US-061, US-100 |
| US-041 | Motor de execução: ações disponíveis e avaliação de regras | P0 | L | US-040 |

## Escopo
- Entidades, migrações, RLS, FKs compostas e triggers de imutabilidade do modelo de workflow.
- Validador completo do grafo (`WorkflowDefinitionValidator`, códigos `WF_*`) e serviço interno de publicação (`WorkflowVersionPublisher`, snapshot canônico + `definitionHash`).
- `WorkflowFacade.getAvailableActions` e `WorkflowFacade.evaluateRules`, expostos por `PRC-08`/`PRC-09`.

## Fora de escopo
- Interface de administração (editor, regras, publicação, diagrama) — FT-030.
- Seeding dos workflows padrão e resolução por aplicabilidade — FT-029.
- Execução de fato da tramitação (encaminhar/devolver/aprovar) — EP-008.

## Regras de negócio da feature
- RN-WF-05 — etapas, transições e regras só mudam em versão `DRAFT`.
- RN-WF-11/RN-WF-12 — toda etapa é alcançável a partir do `START` e tem caminho até um `END`.
- RN-WF-20 — publicação interna exige validação sem erros, grava snapshot/hash e torna a versão anterior `RETIRED`.
- RN-WF-24/RN-WF-25 — regra `BLOCKING` não satisfeita desabilita a ação; `WARNING` nunca desabilita.
- RN-WF-33 — todo cálculo do motor usa exclusivamente a `WorkflowVersion` fixada no processo, nunca o rascunho corrente.

## Telas
- Nenhuma tela própria; consumida pelo painel situacional do processo (SCR-006, EP-001) e pelas telas de administração (FT-030).

## Endpoints
- WF-02 `POST /workflows` — criar workflow (com primeira versão em `DRAFT`)
- WF-03 `GET /workflows/{id}` — consultar workflow
- WF-04 `PATCH /workflows/{id}` — editar nome/descrição
- WF-07 a WF-18 `GET/POST/PATCH/DELETE` — manutenção de versões, etapas, transições e regras do rascunho (back-end entregue aqui; interface nas stories de FT-030)
- PRC-08 `GET /processes/{id}/available-actions` — ações disponíveis
- PRC-09 `GET /processes/{id}/checklist` — pendências da etapa atual

## Entidades
- `Workflow`, `WorkflowVersion`, `WorkflowStage`, `WorkflowTransition`, `WorkflowRule` — dono.
- `ProcessStage`, `ProcessAssignment`, `ProcessMovement` — consumidas (só leitura) para resolver histórico de etapas percorridas e responsáveis.

## Eventos
- `WorkflowCreated` — ao criar um workflow (`WF-02`).
- `WorkflowVersionPublished` — ao publicar uma versão (serviço interno; acionado pela UI em US-045).
- `WorkflowVersionRetired` — ao aposentar/superseder uma versão.

## Permissões
- `WORKFLOW_VIEW` — leitura do modelo e das ações/checklist (via `PROCESS_VIEW`, que é a permissão efetiva de `PRC-08`/`PRC-09`).
- `WORKFLOW_MANAGE` — manutenção do rascunho.

## Dependências
- US-061 (tipos de documento), US-100 (tenant/RLS) — pré-requisitos de US-040.
- Consumida por: FT-029, FT-030 (deste épico); EP-001 e EP-008 (outros épicos).

## Critérios de aceite da feature
```gherkin
Feature: Motor de workflow
  Scenario: Modelo versionado sustenta o cálculo de ações disponíveis
    Given que existe um "Workflow" com uma "WorkflowVersion" publicada, válida e com etapas e regras
    And um processo foi criado fixando essa versão
    When o painel do processo consultar as ações disponíveis e o checklist da etapa atual
    Then o motor deve retornar as ações habilitadas conforme as regras "BLOCKING" satisfeitas
    And deve listar como pendência qualquer regra "BLOCKING" não satisfeita, sem nunca contradizer o que o comando de transição aceitaria
```

## Métricas de sucesso
- Latência p95 de `getAvailableActions`/`evaluateRules` < 300 ms.
- 0 divergências entre UI (botões habilitados) e API (transições aceitas) em testes de regressão.

## Riscos
- Validador de grafo incompleto permite publicar workflow com etapa inalcançável — mitigado com testes de propriedade (fast-check) cobrindo combinações de etapas/transições.
- Allowlist de JSON Logic insuficiente permite expressão perigosa — mitigado por lista fechada de operadores (DEC-016) e revisão de segurança.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
