---
id: EP-001
title: "Processo de contratação"
mvp: 1
priority: P0
features: [FT-001, FT-002, FT-003, FT-004, FT-005, FT-006, FT-007]
status: Especificado
---

# EP-001 — Processo de contratação

## Título
Processo de contratação

## Objetivo
Entregar o agregado central do produto: abrir, consultar, manter, acompanhar e encerrar o processo de contratação, com controle de acesso explícito (participantes) e sigilo do orçamento estimado — a base sobre a qual todos os demais épicos do planejamento da contratação (DFD, ETP, pesquisa de preços, mapa de riscos, TR, workflow, tramitação) se apoiam.

## Contexto e problema
- Hoje a abertura de demandas nasce em memorandos, e-mails e planilhas; a numeração é manual, gera duplicidade, e não há como responder "onde está o processo e com quem" sem telefonar (dor nº 3 do produto — "invisibilidade situacional").
- Na Lei 14.133/2021 (art. 18), a fase preparatória começa pela formalização da demanda; o processo é o agregado central (DEC-010): todo artefato de negócio — documentos, aprovações, tramitações, timeline, riscos, pesquisas, itens — tem `processId` obrigatório.
- DEC-013 separa o status macro do processo da etapa do workflow; DEC-024 define visibilidade por `ProcessAccess`; DEC-028 define numeração transacional sem lacunas; DEC-030/POL-09 tratam o sigilo do orçamento estimado (art. 24); DEC-036 cria participantes para acesso explícito fora da tramitação.

## Escopo
- Abrir processo com wizard, numeração, resolução de workflow e custódia inicial (FT-001).
- Consultar: lista com busca, filtros, atalhos e ordenação, visões salvas e exportação CSV (FT-002).
- Painel do processo com as "7 perguntas" (painel situacional), ações disponíveis, checklist e stepper de etapas (FT-003).
- Manter dados cadastrais, itens da contratação e etiquetas (FT-004).
- Ciclo de vida: suspender/retomar, cancelar/descartar, concluir (FT-005).
- Duplicar processo existente (FT-006).
- Participantes (observador, colaborador, consultor) e sigilo do orçamento estimado (FT-007).

## Fora de escopo
- Tramitação propriamente dita (encaminhar, devolver, assumir, atribuir, decidir aprovações) — EP-008.
- Definição, versionamento e motor de regras do workflow — EP-007.
- Conteúdo de DFD, ETP, pesquisa de preços, mapa de riscos e TR — EP-002 a EP-006.
- Timeline, comentários, auditoria e caixa de tarefas como capacidades próprias — EP-009, EP-010, EP-012, EP-013.
- Publicação (`PUBLISHED`) e reabertura de processo concluído/cancelado — MVP 3 e PEND-03.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Área requisitante | `REQUISITANTE` | Abre processos da sua unidade, mantém dados e itens, acompanha o painel situacional |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Visão global; gerencia participantes, sigilo, ciclo de vida e duplicação |
| Planejamento | `PLANEJAMENTO` | Cria e mantém processos; usa participantes e visualiza orçamento sigiloso |
| Autoridade competente | `AUTORIDADE_COMPETENTE` | Suspende, cancela e define o sigilo do orçamento |
| Controle Interno / Auditor | `CONTROLE_INTERNO` / `AUDITOR` | Consulta processos e valores mesmo sigilosos (art. 24, I), nunca edita |
| Consultoria externa | `CONSULTOR_EXTERNO` | Participa como consultor em processos específicos, com validade definida |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-001 | Criar processo | US-001 | P0 |
| FT-002 | Consultar processos | US-002, US-003 | P0 |
| FT-003 | Painel do processo | US-004 | P0 |
| FT-004 | Manter dados do processo | US-005, US-006, US-007 | P0 |
| FT-005 | Ciclo de vida do processo | US-008, US-009, US-010 | P0 |
| FT-006 | Duplicar processo | US-011 | P1 |
| FT-007 | Acesso e sigilo | US-012, US-013 | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-001 | Criar processo de contratação | P0 | L | 8 |
| US-002 | Listar, pesquisar, filtrar e ordenar processos | P0 | L | 8 |
| US-003 | Visões salvas e exportação CSV da lista de processos | P2 | M | 5 |
| US-004 | Visualizar detalhe do processo com painel situacional | P0 | L | 8 |
| US-005 | Editar dados do processo | P0 | M | 5 |
| US-006 | Gerenciar itens da contratação | P0 | M | 5 |
| US-007 | Gerenciar etiquetas do processo | P2 | S | 2 |
| US-008 | Suspender e retomar processo | P1 | M | 5 |
| US-009 | Cancelar processo ou descartar rascunho | P0 | M | 5 |
| US-010 | Concluir processo (planejamento da contratação) | P0 | M | 5 |
| US-011 | Duplicar processo | P1 | M | 5 |
| US-012 | Gerenciar participantes do processo | P1 | M | 5 |
| US-013 | Sigilo do orçamento estimado | P1 | M | 5 |
| **Total** | | | | **71** |

## Módulos e entidades
- Módulos: `process` (dono), `workflow`, `catalog`, `organization`, `access`, `timeline`, `audit`, `platform`, `document`, `approval`, `price-research`, `notification`, `identity` (consumidos).
- Entidades: `Process`, `ProcessItem`, `ProcessParticipant`, `ProcessStage`, `ProcessAssignment`, `ProcessMovement`, `ProcessAccess`, `Tag`, `ProcessTag`, `SavedView` (dono); `WorkflowVersion`/`WorkflowStage`, `Document`, `Approval`, `CatalogItem`, `Department`/`Organization`, `User`, `PriceItem`, `AuditLog`, `OutboxEvent` (consumidas).

## Telas
- SCR-004 — Processos (`/processos`)
- SCR-005 — Novo processo, wizard (`/processos/novo`)
- SCR-006 — Detalhe do processo, painel situacional + abas (`/processos/[id]`)
- SCR-112 — Participantes do processo (aba em SCR-006)
- SCR-113 — Duplicar processo (diálogo)
- SCR-116 — Suspender, retomar, cancelar e concluir (diálogos)
- SCR-109 — Catálogos (aba "Etiquetas", administração compartilhada com outros épicos)

## Integrações
- Interna: `workflow` (resolução e motor de regras), `document` (ciclo de vida e módulos tipados), `approval` (aprovações pendentes/canceladas), `catalog` (tipos, numeração, calendário), `organization` (órgãos e unidades), `access` (RBAC, escopos e vínculos), `timeline`/`audit`/`platform` (projeções, trilha e outbox), `notification` (avisos assíncronos).
- Externa: nenhuma neste épico (integrações externas, como PNCP, ficam em outros épicos/MVPs).

## Eventos principais
- `ProcessCreated`, `ProcessUpdated`, `ProcessNumberAssigned`, `ProcessItemsChanged`
- `ProcessAssigned`, `ProcessStageChanged`, `ProcessStatusChanged`
- `ProcessDuplicated`, `ProcessDraftDiscarded`
- `ProcessParticipantAdded`, `ProcessParticipantRemoved`, `ProcessConfidentialityChanged`
- `ProcessStageDueSoon`, `ProcessStageOverdue`

## Permissões envolvidas
- `PROCESS_VIEW`, `PROCESS_CREATE`, `PROCESS_UPDATE`, `PROCESS_FORWARD`, `PROCESS_RETURN`, `PROCESS_CLAIM`, `PROCESS_ASSIGN`
- `PROCESS_SUSPEND`, `PROCESS_CANCEL`, `PROCESS_COMPLETE`, `PROCESS_DUPLICATE`
- `PROCESS_MANAGE_PARTICIPANTS`, `PROCESS_FOLLOW`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, `PROCESS_SET_CONFIDENTIAL_BUDGET`, `PROCESS_EXPORT`, `TAG_MANAGE`

## Regras configuráveis
- `numbering.process.mask`, `numbering.process.scope`, `numbering.process.assignOn` — máscara, escopo e momento da numeração (DEC-028)
- `process.duplicateDetectionWindowMinutes` — janela da heurística de duplicidade na criação
- `process.requireInternalCode` — exige código interno
- `access.historicalDepartmentsCanView` — mantém acesso histórico de unidades (DEC-024)
- `labels.secretariat`, `labels.department` — rótulos dos níveis de unidade
- `security.mfaPolicy` — exige MFA em permissões de risco alto (POL-14), ex.: `PROCESS_SET_CONFIDENTIAL_BUDGET`
- `deadlines.warnBeforeBusinessDays`, `calendar.optionalHolidaysAreNonBusiness` — prazos e calendário (DEC-031)

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| A4 — Cobertura de processos | ≥ 70% em 6 meses | `Process` × linha de base |
| A6 — Tempo até o primeiro processo | ≤ 10 dias úteis | Onboarding |
| A7 — Tempo até o valor (1º processo `COMPLETED`) | ≤ 60 dias | Onboarding |
| E1 — Tempo de ciclo do planejamento | −30% sobre a linha de base em 6 meses | `ProcessMovement` |
| E6 — Tempo sem responsável | ≤ 1 dia útil | `ProcessAssignment` |
| Q1 — Taxa de devolução | −40% em 6 meses | `ProcessMovement` |
| C2 — Latência p95 (painel situacional) | ≤ 800 ms | `GET /processes/{id}/summary` |

## Dependências
- **Depende de:** EP-007 (workflow aplicável e etapa inicial), EP-013 (auditoria), EP-016 (identidade, acesso e RBAC), EP-017 (tenant, órgãos, unidades, catálogos, numeração e calendário).
- **Habilita:** EP-002 (DFD), EP-004 (pesquisa de preços), EP-005 (mapa de riscos), EP-008 (tramitação), EP-012 (comentários), EP-014 (dashboard).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Vazamento de orçamento sigiloso (art. 24) | Baixa | Alta | POL-09 centralizada no serializador (`ConfidentialFieldsInterceptor`), renditions `RESTRICTED`, testes específicos, auditoria `process.confidential_view` (RL-04) |
| Contenção na sequência de numeração sob carga | Baixa | Média | Transações curtas; meta p95 < 600 ms na criação; métrica `numbering.lock_wait` (RP-04) |
| Falsos positivos/negativos na heurística de duplicidade na criação | Média | Baixa | Limiar configurável (trigram ≥ 0,6), janela ajustável (`process.duplicateDetectionWindowMinutes`), confirmação explícita registrada em auditoria |
| Uso de participantes para contornar a custódia (edição indevida) | Baixa | Média | Participantes nunca tramitam/aprovam (DEC-036); `COLLABORATOR`/`CONSULTANT` só editam documentos em `DRAFT`/`RETURNED` (POL-02); auditoria de concessão/revogação |

## Pontos em aberto
- ~~PEND-01~~ — decidida em 2026-10-07: numeração na criação (`CREATE`) como padrão, configurável para `START` (DEC-028).
- PEND-03 — Reabertura de processo concluído/cancelado (padrão adotado: não permitida; decidir até Sprint 10)
- PEND-05 — Arredondamento de totais monetários (padrão adotado: `HALF_UP`; decidir até Sprint 11)
- PEND-07 — Retenção/temporalidade de anexos e documentos (padrão adotado: sem eliminação; decidir antes do MVP 3)

## Definition of Done do épico
- [ ] Todas as features (FT-001 a FT-007) concluídas, com as stories P0/P1 aceitas
- [ ] KPIs A4, A6, A7, E1, E6, Q1 e C2 instrumentados a partir de eventos de domínio
- [ ] Testes E2E das jornadas: criar, consultar, manter, suspender/retomar, cancelar, concluir, duplicar, gerenciar participantes e sigilo
- [ ] Isolamento de tenant (RLS + FK composta) coberto pela suíte "tenant leak" em todas as stories
- [ ] Documentação e guia do usuário atualizados
