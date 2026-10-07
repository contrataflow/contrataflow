---
id: EP-014
title: "Dashboard"
mvp: 1
priority: P0
features: [FT-046]
status: Especificado
---

# EP-014 — Dashboard

## Título
Dashboard

## Objetivo
Dar a qualquer usuário com vínculo ativo uma visão operacional imediata — pendências, atrasos, volume e valores das contratações que ele pode ver — sem precisar montar filtros manualmente a cada acesso, com números consistentes com os das demais telas (caixa de tarefas, lista de processos).

## Contexto e problema
- Hoje não há visão consolidada do andamento das contratações: cada gestor abre a lista de processos e aplica filtros manualmente para saber quantos processos estão atrasados ou qual o volume por secretaria.
- A caixa de tarefas (EP-009) já responde "o que eu preciso fazer"; faltava responder "como está a operação", olhando o conjunto de processos visíveis ao usuário, não apenas os atribuídos a ele.
- DEC-180 estabeleceu o padrão de "responder sem cliques" no detalhe do processo (painel situacional); este épico aplica a mesma filosofia no nível agregado do tenant/secretaria.
- O sigilo do orçamento estimado (art. 24 da Lei 14.133/2021; DEC-030/POL-09) precisa ser respeitado também em agregados (somas por secretaria), não só em campos individuais.

## Escopo
- Resumo rápido (pendências, atrasados, próximos do prazo, abertos) na tela inicial do produto.
- Indicadores por perfil: processos por status, por etapa, atrasados, próximos do prazo, tempo médio por etapa (90 dias), abertos por mês, valor estimado por secretaria (respeitando POL-09) e atividade recente.
- Filtro por secretaria/unidade, sempre dentro da visibilidade de processos do usuário (DEC-024).
- Cache de 60 s e meta de desempenho p95 < 1 s por indicador.

## Fora de escopo
- Entidade própria de "Task" ou persistência de indicadores (tudo é consulta agregada sobre dados de EP-001/EP-008/EP-009 — DEC-026).
- Dashboards específicos por papel/tela separada por perfil (o mesmo endpoint se adapta pela visibilidade do usuário).
- Exportação de indicadores e relatórios gerenciais aprofundados (outro épico/MVP).
- Indicadores de contratos, fornecedores ou fase de execução (fora do MVP 1).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Área requisitante | `REQUISITANTE` | Ver suas pendências e processos em andamento |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Visão geral de status, atrasos e volume por secretaria |
| Planejamento | `PLANEJAMENTO` | Volume de processos abertos por mês e por etapa |
| Compras | `COMPRAS` | Pendências e atrasados na sua unidade |
| Gestor de contrato | `GESTOR_CONTRATO` | Atividade recente e processos atrasados |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-046 | Dashboard operacional | US-076 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-076 | Dashboard operacional por perfil | P0 | L | 8 |
| **Total** | | | | **8** |

## Módulos e entidades
- Módulos: `dashboard` (dono); `process`, `workflow`, `timeline`, `access` (consumidos)
- Entidades: nenhuma entidade própria (consulta agregada); consome `Process`, `ProcessStage`, `ProcessTimelineEntry`, `Approval` (de EP-001/EP-008)

## Telas
- SCR-003 — Dashboard (`/painel`)

## Integrações
- Interna: Redis (cache de agregações, TTL 60 s)

## Eventos principais
- Nenhum — épico somente leitura; reaproveita dados e eventos já publicados por EP-001/EP-008.

## Permissões envolvidas
- `DASHBOARD_VIEW`
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET`

## Regras configuráveis
- `deadlines.warnBeforeBusinessDays` — define o que é "próximo do prazo" no indicador de prazos.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Latência p95 por indicador | < 1 s | Métricas de API (`dashboard_widget_duration_ms`) |
| Taxa de acerto do cache | > 70% em uso normal | Métricas de cache (Redis) |
| Consistência "Pendências" × caixa de tarefas | 100% (sem divergência) | Teste de integração contínuo |
| Adoção | > 80% dos usuários ativos abrem o painel por semana | Analytics de produto |

## Dependências
- **Depende de:** EP-001 (processo é a fonte de todos os indicadores — status, valores, prazos); EP-008 (tramitação/etapas/prazos — base de atrasados, próximos do prazo e tempo médio por etapa); EP-009 (caixa de tarefas — contadores de pendências reaproveitados no indicador de pendências).
- **Habilita:** nenhum épico depende deste no MVP 1 (é consumidor terminal).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Consulta de tempo médio por etapa (90 dias) degradar com o crescimento da base | Média | Médio | Índice dedicado em `process_stages`; monitorar como débito técnico (possível read model) |
| Chave de cache mal construída vazar dados entre usuários/tenants | Baixa | Alto | Revisão de segurança dedicada à chave de cache; testes de isolamento "tenant leak" |
| Mascaramento agregado (POL-09) incorreto expor valor sigiloso somado | Baixa | Alto | Teste automatizado específico de `confidentialExcluded`; revisão de produto da regra |

## Pontos em aberto
- Nenhum ponto em aberto específico deste épico (ver lacunas de nomenclatura registradas em `docs/backlog/story-076-operational-dashboard.md` § Dependências).

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando
- [ ] Documentação e treinamento (guia do usuário) atualizados
