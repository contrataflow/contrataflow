---
id: EP-010
title: "Timeline"
mvp: 1
priority: P0
features: [FT-037]
status: Especificado
---

# EP-010 — Timeline

## Título
Timeline

## Objetivo
Dar a qualquer pessoa que acompanhe um processo de contratação uma narrativa cronológica, confiável e sempre atualizada de tudo que aconteceu nele — tramitações, documentos, aprovações, comentários, anexos e riscos — sem precisar abrir cada módulo separadamente nem depender da auditoria técnica.

## Contexto e problema
- Hoje a "história" de um processo fica fragmentada entre tramitações, documentos, aprovações e comentários; reconstituí-la exige abrir várias telas.
- DEC-025 separa timeline (narrativa de negócio, acessível a quem vê o processo) de auditoria (evidência de conformidade, acessível a quem tem `AUDIT_VIEW`) — este épico implementa somente a primeira.
- DEC-161 estabelece a timeline como um dos dois handlers síncronos in-process disparados na mesma transação de qualquer evento de domínio do processo (o outro é `ProcessAccess`), o que a torna uma peça transversal consumida por praticamente todos os módulos de negócio.
- SCR-006 (painel do processo) já reserva a aba "Timeline" entre as demais abas do processo.

## Escopo
- Projeção síncrona e idempotente de eventos de domínio do processo em entradas de timeline (`ProcessTimelineEntry`), com nomes congelados e visibilidade orçamentária sigilosa.
- Leitura paginada por cursor da timeline, com filtros por grupo, autor e período, agrupada por dia na interface.

## Fora de escopo
- Auditoria de conformidade e segurança (`AuditLog`) — tratada em épico próprio.
- Notificações derivadas dos mesmos eventos — consumidor assíncrono próprio (events.md §6), fora deste épico.
- Exportação da timeline (PDF/CSV) e busca textual dentro da timeline — não previstas no MVP 1.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Requisitante | `REQUISITANTE` | Acompanhar o andamento do próprio processo |
| Gestor de Contratações | `GESTOR_CONTRATACOES` | Entender rapidamente o histórico ao assumir ou revisar um processo |
| Autoridade/aprovador | perfil com aprovação designada | Ver o que levou o processo até a aprovação pendente |
| Planejamento / Controle Interno | `PLANEJAMENTO` | Conferir a narrativa sem acessar a auditoria técnica |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-037 | Timeline do processo | US-059, US-060 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-059 | Projetar eventos do processo na timeline | P0 | M | 5 |
| US-060 | Visualizar timeline com filtros | P0 | M | 5 |
| **Total** | | | | **10** |

## Módulos e entidades
- Módulos: `timeline`
- Entidades: `ProcessTimelineEntry` (dono); `Process` (consumida — todo registro referencia `processId`, DEC-010)

## Telas
- SCR-006 — Detalhe do processo, aba "Timeline" (`/processos/[id]`)

## Integrações
- Interna: consumo síncrono in-process dos eventos publicados por `process`, `document`, `approval`, `comment`, `attachment`, `risk-map`, `price-research` e `term` (DEC-161).

## Eventos principais
- Nenhum publicado por este épico; consome os eventos listados na tabela de mapeamento de US-059 (events.md §5) para gerar `ProcessTimelineEntry`.

## Permissões envolvidas
- `PROCESS_VIEW`
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET`

## Regras configuráveis
- Nenhuma chave de configuração própria neste épico.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| p95 de latência de `GET /processes/{id}/timeline` | < 300 ms | APM (US-060) |
| Entradas de timeline duplicadas por reprocessamento | 0 | Testes de idempotência + monitoramento da constraint única (US-059) |
| Eventos elegíveis sem entrada correspondente | 0 | Auditoria de cobertura do mapeamento `TimelineEntryType` |

## Dependências
- **Depende de:** EP-015 (Fundação — outbox, contexto de tenant/RLS, autorização, base de eventos de domínio).
- **Habilita:** nenhum épico depende exclusivamente deste; diversas stories de outros épicos (ex.: US-001) o referenciam para considerar sua narrativa de processo completa.

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Tabela de mapeamento evento→tipo ficar desatualizada conforme novos eventos surgem em outros épicos | Média | Média | Checklist de Definition of Done de cada nova story de evento incluir "adicionar linha em TimelineEntryType"; teste de cobertura |
| Entrada orçamentária sigilosa exposta indevidamente | Baixa | Alta | Filtro de visibilidade aplicado na cláusula SQL (RN-TML-13) + teste dedicado de POL-09 |
| Degradação de performance da transação hospedeira pela escrita síncrona | Baixa | Média | Escrita única e leve (INSERT com índice simples); monitorar p95 das transações hospedeiras |

## Pontos em aberto
- Nenhum ponto em aberto específico deste épico (a ausência de um enum canônico de agrupamento de `TimelineEntryType` foi resolvida em US-060 como mapeamento estático de apresentação, registrado em suas Dependências).

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando
- [ ] Documentação e treinamento (guia do usuário) atualizados
