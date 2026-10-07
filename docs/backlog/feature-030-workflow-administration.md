---
id: FT-030
title: "Administração de workflows"
epic: EP-007
mvp: 1
priority: P1
stories: [US-043, US-044, US-045, US-046]
status: Especificada
---

# FT-030 — Administração de workflows

## Título
Administração de workflows

## Épico
EP-007 — Workflow

## Descrição
Esta feature entrega a interface completa de administração de workflows: um editor visual de etapas e transições sobre um rascunho seguro (US-043), um painel de regras com construtor de condições e teste contra processo real antes de publicar (US-044), o ciclo de validação, publicação, versionamento e aposentadoria (US-045), e um diagrama somente leitura para visualizar o fluxo completo (US-046). Juntas, essas quatro stories permitem que o administrador do órgão configure e evolua o rito de contratação do seu jeito, sem depender de código.

## Valor para o usuário e para o órgão
- O administrador adapta o fluxo da fase preparatória (ou cria ritos específicos) sem abrir chamado com o fornecedor do sistema.
- Alterações são seguras: trabalham sempre em um rascunho isolado, validado antes de publicar, nunca afetando processos já em andamento.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`, `WORKFLOW_MANAGE`/`WORKFLOW_PUBLISH`) — edita, testa, publica, aposenta.
- Gestor de contratações (`WORKFLOW_MANAGE`) — colabora na configuração, sem publicar.
- Demais perfis (`WORKFLOW_VIEW`): Planejamento, Compras, Licitações, Controle Interno, Autoridade competente, Auditor — consultam etapas, regras e diagrama.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-043 | Editor de workflow (etapas e transições) | P1 | L | US-040 |
| US-044 | Regras de etapa e de transição | P1 | M | US-041, US-043 |
| US-045 | Publicar, versionar e aposentar workflow | P1 | M | US-043 |
| US-046 | Visualizar diagrama do workflow | P2 | M | US-043 |

## Escopo
- CRUD de workflow, etapas e transições sobre versão `DRAFT` (US-043).
- CRUD de regras (`REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL`, `CONDITION`) com construtor de condições e teste dry-run (US-044).
- Validação do grafo, publicação, versionamento e aposentadoria (US-045).
- Diagrama somente leitura com layout automático (US-046).

## Fora de escopo
- Modelo de dados e validador de grafo em si — FT-028 (esta feature só os opera pela interface).
- Seeding e resolução automática de aplicabilidade — FT-029.
- Execução da tramitação sobre o workflow publicado — EP-008.

## Regras de negócio da feature
- RN-WF-43 — toda escrita em etapa/transição só é aceita com a versão em `DRAFT`.
- RN-WF-46/RN-WF-47 — no máximo uma versão `DRAFT` por workflow; criar nova versão copia a publicada.
- RN-WF-54 — regras também só mudam em versão `DRAFT`.
- RN-WF-61/RN-WF-65 — publicar exige validação sem erros; versão publicada fica imutável.
- RN-WF-66 — aposentar a versão corrente sem substituta é bloqueado (`WORKFLOW_IN_USE`).
- RN-WF-70 — o diagrama é somente leitura; nenhuma edição a partir dele.

## Telas
- SCR-034 — Workflow (lista e editor) (`/admin/workflows`, `/admin/workflows/[id]`) — abas Etapas, Transições, Versões, Diagrama.
- SCR-035 — Regras (painel de regras do workflow) (`/admin/workflows/[id]/regras`).

## Endpoints
- WF-01 a WF-04, WF-08 a WF-15 — workflow, versões, etapas e transições (US-043).
- WF-16 a WF-19, WF-23 *(proposto)* — regras e teste (US-044).
- WF-07, WF-20, WF-21, WF-22 — histórico, validação, publicação e aposentadoria (US-045).
- WF-09, WF-07 — leitura para o diagrama (US-046).
- PRC-01 — busca de processo para "Testar regra" (US-044).

## Entidades
- `Workflow`, `WorkflowVersion`, `WorkflowStage`, `WorkflowTransition`, `WorkflowRule` — todas operadas (criadas/editadas/publicadas) por esta feature.

## Eventos
- `WorkflowCreated` — ao criar um workflow pela interface (US-043).
- `WorkflowVersionPublished` / `WorkflowVersionRetired` — ao publicar/aposentar (US-045).

## Permissões
- `WORKFLOW_VIEW` — consulta (editor em modo leitura, regras, diagrama).
- `WORKFLOW_MANAGE` — editar workflow/etapas/transições/regras.
- `WORKFLOW_PUBLISH` — publicar e aposentar versões.

## Dependências
- FT-028 (modelo e validador de grafo que esta feature opera pela interface).
- US-104/catálogo de tipos de documento (EP-011) para as opções de `REQUIRED_DOCUMENT`.

## Critérios de aceite da feature
```gherkin
Feature: Administração de workflows
  Scenario: Jornada completa de configuração até a publicação
    Given que o administrador "Carla" cria um novo workflow
    When ela adicionar etapas e transições, criar uma regra obrigatória, testá-la contra um processo existente
    And validar e publicar a nova versão
    Then o workflow deve ficar disponível, com a versão publicada imutável
    And o diagrama da versão publicada deve refletir exatamente as etapas e transições configuradas
```

## Métricas de sucesso
- 100% das publicações de versão sem erro bloqueante pendente no momento de publicar.
- 0 processos em andamento afetados por aposentadoria de versões antigas (RN-WF-67).

## Riscos
- Complexidade da UI (editor, regras, diagrama) atrasar a entrega — mitigado ao dividir em quatro stories incrementais, com US-046 (P2) podendo seguir depois das demais (P1).
- Regra `CONDITION` mal configurada publicada sem revisão — mitigado pelo "Testar regra" (US-044) antes de publicar e pela validação bloqueante (US-045).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
