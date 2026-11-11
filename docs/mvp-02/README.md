# MVP 2 — Governança e Controle

> **Status: especificado em 2026-11-11 (prd-7), versão 1 revisável após o UAT do MVP 1** (DEC-192).
> A especificação veio antes de o MVP 1 estar em produção nos pilotos — desvio consciente do gate de [../product/roadmap.md §2](../product/roadmap.md#2-governança-do-roadmap-um-mvp-detalhado-por-vez) e dos critérios de entrada do [§4.7](../product/roadmap.md#47-critérios-de-entrada). O que dependia do piloto entrou como padrão semeado e configurável, "a validar com o piloto" ([overview.md §7](overview.md#7-a-validar-com-o-piloto)); a implementação começa depois do endurecimento das suítes órfãs, com DT-02 e DT-03 como primeiros cards ([delivery-plan.md §11](delivery-plan.md#11-proposta-de-sequência-de-implementação-em-cards)).

## Resumo

Completa a **fase preparatória** da Lei 14.133/2021 na plataforma — dotação orçamentária, minuta do edital, análise jurídica (art. 53) e manifestação do controle interno — e entrega os instrumentos de governança: **PCA**, **SLA**, **regras condicionais**, **indicadores e gargalos**. Inclui as capacidades habilitadoras postergadas do MVP 1 (etapas paralelas, aprovação com múltiplos aprovadores, migração de processos entre versões de workflow), o backoffice da plataforma, o login gov.br e os débitos DT-13 a DT-17. A IA gera rascunhos do **parecer jurídico** e da **minuta do edital** sobre a camada do EP-020, sem nunca propor a conclusão do parecer (DEC-202).

| Número | Valor |
|---|---|
| Épicos · features · stories | 11 (EP-021..EP-031) · 28 (FT-063..FT-090) · 78 (US-123..US-200) |
| Prioridade | P0: 33 stories / 189 pts · P1: 41 / 223 pts · P2: 4 / 10 pts — **422 pts** (release = P0 + P1 = 412 pts) |
| Plano | Sprint 0 + 10 sprints de desenvolvimento + 1 de release ≈ 24 semanas (squad de referência) |
| Decisões e ADRs | DEC-192 a DEC-210; ADR-014 a ADR-017; PEND-13, PEND-18 e PEND-22 resolvidas |
| Módulos (DEC-040) | `pca`, `budget`, `legal-review`, `internal-control`, `tender`, `sla`, `analytics`, `rules` |
| Telas | SCR-018, 019, 020, 021, 027, 028, 035 (reservadas) e SCR-118 a SCR-123 (complementares) |
| Jornadas de aceite | J-12 a J-20 (mais a regressão J-01 a J-11 do MVP 1) |

## Arquivos

| Documento | Conteúdo |
|---|---|
| [overview.md](overview.md) | Visão, escopo, jornada, personas, relação com o MVP 1, premissas, padrões a validar com o piloto, governança da especificação |
| [epics.md](epics.md) | Os 11 épicos com objetivo, features, pontos, módulos e dependências |
| [features.md](features.md) | **Documento canônico** de IDs, títulos, prioridades, estimativas, dependências e arquivos das features e stories |
| [entities.md](entities.md) | Enums, diagramas ER, entidades novas e alteradas, ciclos de vida, estruturas JSON, chaves de configuração, sementes e migrações M2-01..M2-23 |
| [api.md](api.md) e [api/](api/) | Convenções, erros, catálogo de endpoints e detalhe por endpoint (`11-pca` a `20-workflow-v2`); mudanças aditivas nos contratos do MVP 1 |
| [screens.md](screens.md) | Navegação, telas novas e ampliações das telas do MVP 1; rastreabilidade tela × story |
| [permissions.md](permissions.md) | Permissões novas, matriz perfil × permissão, visibilidade, políticas contextuais (POL-19+), backoffice e testes de autorização |
| [events.md](events.md) | Eventos de domínio, consumidores, timeline, notificações, auditoria e versionamento |
| [acceptance-criteria.md](acceptance-criteria.md) | Critérios transversais, jornadas J-12..J-20, consolidação por épico e por story, dependências de decisão |
| [tests.md](tests.md) | Suítes transversais, matriz RBAC, tenant leak, IA, metas de desempenho, carga, dados de teste |
| [delivery-plan.md](delivery-plan.md) | Estimativas, backlog priorizado, caminho crítico, sequência por sprint, marcos, trilhas, capacidade, postergados, dependências do UAT e a sequência de cards |
| [risks-and-decisions.md](risks-and-decisions.md) | Riscos (do roadmap e por categoria), débitos DT-21..DT-31, ambiguidades, decisões e lacunas pendentes, regras configuráveis, validação para o MVP 3 |
| [release-checklist.md](release-checklist.md) | Definition of Done, postergados e checklist de release com o que muda frente ao MVP 1 |
| [../backlog/](../backlog/README.md) | Cards detalhados (épicos 021–031, features 063–090, stories 123–200) no padrão de 28 seções, verificados por `pnpm docs:check` |

## Checklist de validação (gate do roadmap §2)

- [ ] MVP anterior liberado e estável nos pilotos — **desvio consciente** (DEC-192): revisão na Sprint 0 do MVP 2 ([delivery-plan.md §10](delivery-plan.md#10-o-que-depende-do-uat-do-mvp-1))
- [x] Dependências funcionais e técnicas confirmadas ([features.md](features.md), [delivery-plan.md §4](delivery-plan.md#4-dependências-e-caminho-crítico))
- [x] Entidades existentes reutilizadas, sem duplicar conceitos ([entities.md §11](entities.md#11-rastreabilidade-decisões--entidades), [domains.md](../architecture/domains.md))
- [x] Impactos em workflow, permissões, eventos e telas mapeados
- [x] Mudanças de arquitetura registradas em ADR (ADR-014 a ADR-017; ADR-005 revisada)
- [x] Migrações necessárias planejadas (expand/contract — [entities.md §10](entities.md#10-migrações-expandcontract))
