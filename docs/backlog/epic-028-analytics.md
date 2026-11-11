---
id: EP-028
title: "Indicadores e gargalos"
mvp: 2
priority: P1
features: [FT-080, FT-081, FT-082]
status: Especificado
---

# EP-028 — Indicadores e gargalos

## Título
Indicadores e gargalos

## Objetivo
Dar à gestão, ao Controle Interno e ao Auditor uma visão confiável de como as contratações andam: tempo de ciclo, devoluções, cumprimento de prazo, volume e valor por secretaria e modalidade, execução do PCA e, sobretudo, onde o processo trava, por etapa, unidade e responsável, com filas, envelhecimento e comparação entre períodos. Tudo sai de um read model próprio, sem pesar na tramitação, e com a mesma segurança do restante do sistema (escopo, visibilidade e sigilo do orçamento).

## Contexto e problema
- A governança das contratações é exigência da Lei 14.133/2021 (art. 11, parágrafo único). O dashboard do MVP 1 (DEC-088) serve a contadores do dia a dia sobre views transacionais, com cache de 60 s; não serve a séries históricas e comparações.
- Perguntas analíticas varrem a história inteira de `ProcessStage`, `ProcessMovement` e `Approval`. Consultá-las no banco transacional disputa I/O com a tramitação, risco registrado no roadmap §4.10.
- DEC-206 e a [ADR-014](../adr/adr-014-indicators-read-model.md) decidem: módulo `analytics` dono de **tabelas de fatos** alimentadas pelos eventos do outbox, **reconstruíveis** por job noturno de reconciliação, com **visões materializadas** para os agregados. **Os relatórios nunca consultam `ProcessStage` ou `ProcessMovement` diretamente em produção**; o dashboard da DEC-088 continua como está.
- **Por que um épico só.** O roadmap §4.2 lista "Indicadores" e "Gargalos" como dois épicos. Aqui são fundidos no EP-028, com uma feature para cada capacidade (FT-081 e FT-082) mais uma para a base comum (FT-080), porque compartilham o módulo `analytics`, o mesmo read model e as mesmas telas SCR-027 e SCR-028 (o roadmap também atribui a SCR-028 aos dois). Separá-los obrigaria dois épicos a depender da mesma infraestrutura e das mesmas permissões.
- Segurança (DEC-206, POL-28): agregados filtrados pelo escopo de `REPORT_VIEW`; detalhamento por processo com o predicado de visibilidade da DEC-024; valores de orçamento sigiloso mascarados (DEC-030) e excluídos das somas para quem não tem a permissão de sigilo.
- Atualidade: quase em tempo real, com alvo de até 5 minutos de defasagem e a data da última atualização exibida; consistência eventual assumida na ADR-014.

## Escopo
- Read model: `AnalyticsStageFact`, `AnalyticsProcessFact`, `AnalyticsPcaItemFact`, controle de idempotência e de reconciliação; projetor no worker alimentado pelo outbox (US-170).
- Reconstrução total e reconciliação noturna com relatório de divergências; visões materializadas `mv_analytics_stage_monthly`, `mv_analytics_process_monthly` e `mv_analytics_pca_execution` (US-171).
- Relatórios (SCR-027): tempo de ciclo, devoluções, cumprimento de prazo, volume e valor por secretaria e modalidade (US-172).
- Relatório detalhado (SCR-028) com detalhamento por processo (US-173).
- Exportação CSV/XLSX auditada pela fila de exportações (US-174).
- Indicadores de execução do PCA: previsto × vinculado × concluído (US-175).
- Gargalos: tempo por etapa, unidade e responsável (US-176); filas, envelhecimento e comparação entre períodos (US-177).

## Fora de escopo
- Análise preditiva, previsão de prazo, saúde do processo e recomendações por IA (MVP 5).
- BI externo, conector para ferramentas de terceiros e data warehouse (rejeitado no MVP 2 pela ADR-014).
- Réplica de leitura do PostgreSQL (opção de escala, adiada).
- Alterações no dashboard operacional (DEC-088, EP-014).
- Definição das políticas de SLA em si (EP-030); aqui só o cumprimento de prazo medido sobre elas.
- Relatórios sobre contratos e execução contratual (MVP 4).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Gestor de contratações | `GESTOR_CONTRATACOES` | Achar gargalos, comparar períodos, acompanhar prazos e volume |
| Controle interno | `CONTROLE_INTERNO` | Relatórios com detalhamento por processo e exportação |
| Auditor | `AUDITOR` | Consultar indicadores e o detalhamento com rastreabilidade |
| Autoridade competente | `AUTORIDADE_COMPETENTE` | Visão do exercício e da execução do PCA |
| Planejamento | `PLANEJAMENTO` | Execução do PCA por item, secretaria e categoria |
| Administrador do órgão | `ADMIN_ORGAO` | Definir o início do exercício fiscal (`analytics.fiscalYearStartMonth`); acesso a relatórios só se o tenant conceder |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-080 | Read model de indicadores | US-170 ⏳, US-171 ⏳ | P1 |
| FT-081 | Indicadores e relatórios | US-172 ⏳, US-173 ⏳, US-174 ⏳, US-175 ⏳ | P1 |
| FT-082 | Gargalos | US-176 ⏳, US-177 ⏳ | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-170 ⏳ | Alimentar o read model de indicadores pelos eventos | P1 | L | 8 |
| US-171 ⏳ | Reconstruir e reconciliar o read model | P1 | M | 5 |
| US-172 ⏳ | Relatórios de indicadores | P1 | L | 8 |
| US-173 ⏳ | Relatório detalhado com detalhamento por processo | P1 | M | 5 |
| US-174 ⏳ | Exportar relatórios | P1 | M | 5 |
| US-175 ⏳ | Indicadores de execução do PCA | P1 | S | 2 |
| US-176 ⏳ | Análise de gargalos por etapa, unidade e responsável | P1 | L | 8 |
| US-177 ⏳ | Filas, envelhecimento e comparação entre períodos | P1 | M | 5 |
| **Total** | | | | **46** |

## Módulos e entidades
- Módulos: `analytics` (novo); leitura de eventos de `process`, `approval`, `document`, `pca`, `legal-review`, `internal-control`, `budget` e `workflow`; `access` (escopo e visibilidade); transversais `audit`, `platform` (fila e worker) e `notification`.
- Entidades: `AnalyticsStageFact`, `AnalyticsProcessFact`, `AnalyticsPcaItemFact`, `AnalyticsProcessedEvent` e `AnalyticsReconciliationRun` (donos `analytics`; entities.md §4.11); visões materializadas `mv_analytics_stage_monthly`, `mv_analytics_process_monthly` e `mv_analytics_pca_execution`; `TenantSetting` `analytics.fiscalYearStartMonth`.

## Telas
- SCR-027 — Relatórios (`/relatorios`).
- SCR-028 — Relatório detalhado e gargalos (`/relatorios/[relatorio]`).
- SCR-003 — Dashboard continua sobre as views do MVP 1 (DEC-088); o MVP 2 só acrescenta indicadores onde o roadmap prevê, sem tocar o read model.

## Integrações
- Internas: outbox e relay (ADR-004), worker e fila de exportações, projetor `AnalyticsProjector`, job noturno de reconciliação, `access` (predicado de visibilidade DEC-024 e mascaramento POL-09), `audit`.
- Nenhuma integração externa; BI externo fora do escopo.

## Eventos principais
- Consumidos pelo `AnalyticsProjector`: `process.*`, `approval.*`, `document.*`, `pca.*`, `legal_review.*`, `internal_control_review.*`, `budget_allocation.*`, `workflow_migration.*` (events.md, projetor `AnalyticsProjector`).
- Publicado: `AnalyticsReconciliationCompleted` (`analytics.reconciliation_completed`).
- Auditoria: `report.view_detail` (acesso ao detalhamento por processo), `report.export` (exportação) e `analytics.rebuild` (reconstrução).

## Permissões envolvidas
- `REPORT_VIEW` (SCR-027, SCR-028 e gargalos, recortados pelo escopo) e `REPORT_EXPORT` (CSV/XLSX).
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — ver valores sigilosos agregados e por linha.
- Políticas: POL-28 (relatórios e sigilo), POL-09 (orçamento sigiloso, estendida aos fatos e agregados) e o predicado de visibilidade da DEC-024 no detalhamento.

## Regras configuráveis
- `analytics.fiscalYearStartMonth` — mês de início do exercício para os recortes (padrão 1, faixa 1 a 12).
- Políticas de SLA do tenant (EP-030) — definem o prazo contra o qual o cumprimento é medido (`dueAt`, `slaPolicyId`).
- Matriz de perfis — quem tem `REPORT_VIEW` e `REPORT_EXPORT` e em qual escopo.
- Definição dos indicadores (dias úteis, descontadas as pausas de SLA) — fixada em código versionado; mudar exige reconstrução dos fatos (ADR-014).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Defasagem do read model (p95) | ≤ 5 min | `projectedAt` × data do evento, métrica do projetor |
| Divergências na reconciliação noturna | 0 não explicadas (≤ 0,1% dos fatos corrigidos) | `AnalyticsReconciliationRun.divergencesFixed` ÷ `factsChecked` |
| Relatório do exercício, p95 de resposta | ≤ 2 s | Métrica de latência das rotas de relatório |
| Gestores que usam gargalos ao menos 1× por mês | ≥ 60% | Auditoria `report.view_detail` e logs de acesso às telas |
| Consultas de relatório em `ProcessStage`/`ProcessMovement` em produção | 0 | Teste de arquitetura e revisão de consultas |
| Meta E3 e Q1 do roadmap medidas com o read model | 100% | Relatórios do próprio épico |

## Dependências
- **Depende de:** EP-010 (timeline e eventos), EP-013 (auditoria), EP-014 (dashboard, base dos indicadores), EP-015 (worker e outbox), EP-016 (escopo e visibilidade); EP-023 (execução do PCA, na US-175).
- **Habilita:** EP-030 (cumprimento de prazo por etapa e unidade sai deste read model — DEC-205); MVP 5 (saúde do processo e previsão sobre o mesmo read model).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Projeção perde evento ou aplica fora de ordem | Média | Alto | Idempotência por `eventId`, chave natural por passagem de etapa e reconciliação noturna com relatório de divergências |
| Vazamento entre tenants ou de processo não visível | Baixa | Alto | RLS nas tabelas de fatos, predicado de visibilidade no detalhamento, casos na suíte de tenant leak e na de autorização |
| Orçamento sigiloso exposto por diferença entre somas | Média | Alto | Mascaramento por linha antes de agregar; totais sem sigilosos e `confidentialExcluded: true` (POL-28) |
| Refresh das visões competindo com a tramitação | Média | Médio | `REFRESH ... CONCURRENTLY` fora do pico e meta de duração monitorada |
| Mudança de definição de indicador exigir reconstrução | Média | Médio | Reconstrução pela mesma rotina da reconciliação; definição versionada |
| Consistência eventual confundir o usuário | Média | Baixo | "Dados atualizados em ..." sempre visível |

## Pontos em aberto
- Definições exatas dos indicadores (início e fim do ciclo, tratamento de cancelados, faixas de envelhecimento, granularidade da comparação entre períodos): a fixar no `api.md` e nos cards de story do card 9.
- Identificador das telas de administração/configuração do exercício (se houver): sem SCR entre as 41; fixar no card de telas.
- Nenhuma PEND aberta do §10 de decisions.md incide sobre este épico.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados (defasagem do projetor, divergências da reconciliação e latência dos relatórios)
- [ ] Testes E2E das jornadas do épico passando (evento → fato → relatório → exportação; gargalos e comparação)
- [ ] Testes de tenant leak e de autorização dos fatos, agregados, detalhamento e exportação (POL-28, POL-09)
- [ ] Teste de reconciliação (fatos × tabelas transacionais) e teste de que relatórios não leem `ProcessStage`/`ProcessMovement`
- [ ] Documentação e treinamento (guia do usuário) atualizados
