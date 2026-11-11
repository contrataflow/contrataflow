---
id: EP-021
title: "Workflow v2"
mvp: 2
priority: P0
features: [FT-063, FT-064, FT-065]
status: Especificado
---

# EP-021 — Workflow v2

## Título
Workflow v2

## Objetivo
Evoluir o motor de workflow do MVP 1 para sustentar a fase preparatória completa: etapas que andam em paralelo, migração segura e auditada de processos em andamento para uma nova versão, contexto de regras versionado (`RuleContext` v2) e a versão 2 do workflow padrão, **oferecida ao órgão e nunca imposta**.

## Contexto e problema
- O MVP 1 entregou um motor sequencial: um processo tem uma única etapa ativa (`Process.currentStageId`) e fixa a versão do workflow na criação (DEC-014). Isso deixou três limites que o MVP 2 precisa vencer: etapas simultâneas (ex.: Jurídico e Controle Interno), levar processos abertos para uma versão nova (DT-02) e incluir Dotação, Edital, Jurídico e Controle Interno no fluxo padrão.
- DEC-194 introduz `PARALLEL_SPLIT` e `PARALLEL_JOIN`; a fonte de verdade das etapas ativas passa a ser `ProcessStage` (`status = ACTIVE`). `Process.currentStageId` continua por compatibilidade e a API ganha `activeStages[]` de forma aditiva (DEC-108). O ADR-005 foi atualizado para o motor com ramos.
- DEC-195 e o ADR-016 definem a migração como ferramenta de plano, simulação obrigatória, decisão humana nos casos ambíguos e execução assíncrona por processo. Nenhuma migração roda sozinha: publicar nova versão não migra nada.
- DEC-204 evolui a DEC-016: o `RuleContext` v2 é um superset do v1 com os namespaces `pca.*`, `budget.*`, `legalReview.*`, `internalControl.*`, `tender.*` e `sla.*`, montados por provedores de cada módulo. Regras v1 seguem avaliadas com o contexto v1.
- DEC-196 fixa a v2 do workflow padrão (lacuna L-04): `DOTACAO` → `MINUTA_EDITAL` → `JURIDICO` → `CONTROLE_INTERNO` → `AUTORIZACAO_LICITACAO`, aceita **a validar com o jurídico do piloto**.

## Escopo
- Modelo e validação de etapas paralelas na definição do workflow (`WF_PARALLEL_INVALID`), runtime com `ProcessBranch`, junção, devolução com cancelamento de ramos e status macro com várias etapas ativas.
- Caixa de tarefas, painel situacional e prazos por ramo (`activeStages[]`, menor `dueAt`).
- `WorkflowMigration` e `WorkflowMigrationItem`: mapeamento de etapas, filtro, simulação (`AUTOMATIC`, `NEEDS_DECISION`, `BLOCKED`), decisões humanas, execução assíncrona idempotente (ação `MIGRATE`, etapa `MIGRATED`).
- Contrato `RuleContext` v2, mecanismo de provedores por módulo e rastreio da `contextVersion` por regra.
- Seeder da v2 do workflow padrão da fase preparatória (e da v2 da contratação direta), publicação automática só para quem usa o padrão sem customização, oferta de adoção aos demais e continuação dos processos concluídos na v1.

## Fora de escopo
- Ramos aninhados e mais de um `PARALLEL_JOIN` por split — um nível apenas (DEC-194).
- Reabertura genérica de processos `COMPLETED`/`CANCELED` (PEND-03, fora do MVP 2 — DEC-195); a continuação v1 → v2 é o único caminho.
- Migração automática ou reversão automática — voltar exige outra migração (ADR-016).
- Regras de saída das etapas de dotação, jurídico, controle interno e edital — pertencem a EP-024, EP-025, EP-026 e EP-027; este épico só as consome na v2 semeada.
- Biblioteca de regras, roteamento e alçadas — EP-031; SLA avançado — EP-030.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Administrador do órgão | `ADMIN_ORGAO` (`WORKFLOW_MANAGE`, `WORKFLOW_PUBLISH`, `WORKFLOW_MIGRATE`) | Modela ramos, adota a v2, planeja e executa migrações |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Acompanha processos com ramos e decide casos de migração em conjunto com o administrador |
| Responsável de etapa | qualquer perfil com `PROCESS_VIEW` | Recebe tarefas por ramo na caixa de tarefas |
| Controle Interno / Auditor | `CONTROLE_INTERNO`, `AUDITOR` | Verificam a trilha de migração e dos ramos |
| Sistema | ator `SYSTEM` | Seeder da v2, execução da migração na fila `maintenance` |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-063 | Etapas paralelas | US-123, US-124, US-125 | P0 |
| FT-064 | Migração entre versões de workflow | US-126, US-127, US-128 | P0 |
| FT-065 | Workflow padrão v2 e `RuleContext` v2 | US-129, US-130, US-131 | P0/P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-123 ⏳ | Modelar etapas paralelas no workflow (ramificação e junção) | P0 | L | 8 |
| US-124 ⏳ | Executar ramos paralelos no processo | P0 | L | 8 |
| US-125 ⏳ | Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos | P0 | M | 5 |
| US-126 ⏳ | Planejar a migração de processos: mapeamento de etapas e filtro | P0 | M | 5 |
| US-127 ⏳ | Simular a migração e decidir os processos que exigem decisão | P0 | L | 8 |
| US-128 ⏳ | Executar a migração de forma assíncrona, idempotente e auditada | P0 | L | 8 |
| US-129 ⏳ | `RuleContext` v2: contrato versionado e provedores por módulo | P0 | M | 5 |
| US-130 ⏳ | Workflow padrão v2 da fase preparatória e oferta de adoção | P0 | M | 5 |
| US-131 ⏳ | Levar à fase preparatória processos concluídos na v1 | P1 | M | 5 |
| **Total** | | | | **57** |

## Módulos e entidades
- Módulos: `workflow` (definição, validação, seeder, `RuleContext`), `process` (runtime, ramos, migração).
- Entidades: `ProcessBranch`, `WorkflowMigration`, `WorkflowMigrationItem` (donas, `process`); `ProcessStage`, `ProcessAssignment`, `ProcessMovement`, `ProcessAccess`, `Process` (alteradas, `process`); `Workflow`, `WorkflowVersion`, `WorkflowStage`, `WorkflowTransition`, `WorkflowRule` (alteradas, `workflow`); `Approval` (consumida — cancelamento de pendentes na devolução e na migração).

## Telas
- SCR-034 — Workflow, ampliado (paralelismo, política de decisão, adoção da v2) — `/admin/workflows/[id]`
- SCR-006 — Detalhe do processo, ampliado (ramos paralelos) — `/processos/[id]`
- SCR-013/014/015 — Caixa de tarefas, aprovações e detalhe da aprovação, ampliados (ramos) — `/tarefas`, `/aprovacoes`, `/aprovacoes/[id]`
- SCR-118 — Migração de processos entre versões de workflow — `/admin/workflows/[id]/migracoes/[migrationId]`

## Integrações
- Internas: `approval` (cancelamento por devolução e por migração), `notification`, `audit`, `inbox`, `platform` (fila `maintenance`, outbox, idempotência), `analytics` (projeta `process.*` e `workflow_migration.*`).
- Provedores do `RuleContext` v2 (`RuleContextContributor`): `process`, `budget`, `legal-review`, `internal-control`, `tender`, `sla` e `pca` (via `process`).
- Nenhuma integração externa.

## Eventos principais
- `ProcessBranchesOpened`, `ProcessBranchArrived`, `ProcessBranchesJoined`, `ProcessBranchesCanceled`
- `WorkflowMigrationSimulated`, `WorkflowMigrationStarted`, `ProcessWorkflowMigrated`, `WorkflowMigrationCompleted`, `WorkflowMigrationCanceled`
- `WorkflowSeedVersionOffered`, `WorkflowSeedVersionAdopted`

## Permissões envolvidas
- `WORKFLOW_VIEW`, `WORKFLOW_MANAGE`, `WORKFLOW_PUBLISH` — modelar e publicar versões com ramos e adotar a v2.
- `WORKFLOW_MIGRATE` — criar, simular, decidir e executar migrações (POL-21; MFA sempre).
- `PROCESS_VIEW` — consumir ramos, caixa de tarefas e `activeStages[]`.

## Regras configuráveis
- `workflow.offerSeedUpdates` — o tenant recebe (ou não) a oferta de novas versões do padrão (DEC-196).
- Ordem e paralelismo de Jurídico e Controle Interno — configurados na versão de workflow do tenant, não em chave.
- `WorkflowStage.pauseSlaWhileReturned` e `isLegallyRequired` — semeados na v2 (consumidos por EP-030 e EP-025).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Processos do piloto migrados para a v2 sem redigitação | ≥ 95% dos processos elegíveis | `WorkflowMigrationCompleted` (`totals`) |
| Itens de migração `FAILED` ou `STALE` | ≤ 2% do plano | `workflow_migration_items` |
| Migrações executadas sem simulação válida | 0 | Auditoria `workflow_migration.execute` |
| Tenants sem customização com a v2 publicada ou oferta resolvida | 100% | `WorkflowSeedVersionAdopted` / `WorkflowSeedVersionOffered` |
| Junção de ramos sem etapa ativa órfã | 100% | Teste de invariante + `ProcessBranchesJoined` |

## Dependências
- **Depende de:** EP-007 (motor e versões), EP-008 (tramitação e movimentos), EP-009 (caixa de tarefas), EP-013 (painel situacional e prazos), EP-015 (filas e plataforma); EP-024, EP-025, EP-026 e EP-027 apenas para a v2 semeada (US-130 depende de US-148, US-155, US-161 e US-168).
- **Habilita:** EP-022 (aprovação por ramo), EP-024 a EP-027 (`RuleContext` v2), EP-030 (SLA), EP-031 (regras). FT-063 e FT-064 são os primeiros cards da implementação (DEC-192).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Paralelismo aumenta a complexidade do motor e da experiência (roadmap §4.10) | Média | Alto | Um nível de ramos, validação no publicar, uso opcional por tenant; v2 padrão sequencial |
| Processo migrado para etapa errada | Média | Alto | Simulação obrigatória, revisão do mapa, decisão humana com justificativa nos ambíguos (ADR-016) |
| Corrida entre migração e tramitação em curso | Média | Médio | Trava por processo e `expectedProcessStageIds`; item vira `STALE` sem efeito |
| `Process.currentStageId` lido como etapa única por leitores antigos | Média | Médio | Compatibilidade (aponta para o split) e `activeStages[]` aditivo; teste de contrato |
| Ordem Jurídico e Controle Interno da v2 não confirmada pelo jurídico do piloto | Média | Médio | Ordem configurável por tenant (inverter ou paralelizar); validação com o piloto |
| Falha no meio de lote de migração | Média | Médio | Transação por processo e idempotência por item; reexecutar retoma só pendentes |

## Pontos em aberto
- A ordem `JURIDICO` → `CONTROLE_INTERNO` e a posição de `MINUTA_EDITAL` (L-04, DEC-196) seguem "a validar com o jurídico do piloto" ([overview §7](../mvp-02/overview.md)).
- IDs e contratos dos endpoints de ramos, migração e adoção da v2, e o desenho de SCR-118 (simulação, decisão por processo, relatório), serão fechados no `api.md` e no detalhamento de telas do MVP 2.
- PEND-03 (reabertura genérica de processos) permanece fora do MVP 2; a continuação v1 → v2 é a única exceção (DEC-195).

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando (ramificação e junção, devolução antes do split, simulação e execução de migração, adoção da v2)
- [ ] Documentação e treinamento (guia do usuário) atualizados
