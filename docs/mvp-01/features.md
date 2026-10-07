# MVP 1 — Features e Stories (esqueleto canônico do backlog)

> **Documento canônico** de IDs, títulos, prioridades, estimativas, dependências e nomes de arquivo de todas as features e stories do MVP 1. Os cards detalhados ficam em [`../backlog/`](../backlog/README.md). Épicos: [epics.md](epics.md).
> Estimativa: `XS` ≤ ½ dia · `S` 1–2 dias · `M` 3–5 dias · `L` 6–10 dias · `XL` > 10 dias (deve ser quebrada). Prioridade: `P0` bloqueia o MVP · `P1` necessária ao release · `P2` desejável · `P3` oportunidade.
> Pontos de referência para planejamento: XS = 1, S = 2, M = 5, L = 8, XL = 13.

Totais: **19 épicos · 59 features · 114 stories** (P0: 84 · P1: 22 · P2: 8).

### Arquivos dos épicos
| Épico | Título | Área das regras (RN) | Arquivo |
|---|---|---|---|
| EP-001 | Processo de contratação | `PROC` | `epic-001-process.md` |
| EP-002 | DFD | `DFD` | `epic-002-dfd.md` |
| EP-003 | ETP | `ETP` | `epic-003-etp.md` |
| EP-004 | Pesquisa de preços | `PRICE` | `epic-004-price-research.md` |
| EP-005 | Mapa de riscos | `RISK` | `epic-005-risk-map.md` |
| EP-006 | Termo de Referência | `TR` | `epic-006-term-of-reference.md` |
| EP-007 | Workflow | `WF` | `epic-007-workflow.md` |
| EP-008 | Tramitação | `TRAM` | `epic-008-routing.md` |
| EP-009 | Caixa de tarefas | `INBOX` | `epic-009-task-inbox.md` |
| EP-010 | Timeline | `TML` | `epic-010-timeline.md` |
| EP-011 | Documentos | `DOC` | `epic-011-documents.md` |
| EP-012 | Comentários | `CMT` | `epic-012-comments.md` |
| EP-013 | Auditoria | `AUD` | `epic-013-audit.md` |
| EP-014 | Dashboard | `DASH` | `epic-014-dashboard.md` |
| EP-015 | Fundação técnica | `FND` | `epic-015-technical-foundation.md` |
| EP-016 | Identidade, acesso e RBAC | `IAM` | `epic-016-identity-access.md` |
| EP-017 | Tenant e estrutura organizacional | `TEN` | `epic-017-tenancy-organization.md` |
| EP-018 | Templates de documentos | `TPL` | `epic-018-document-templates.md` |
| EP-019 | Notificações | `NTF` | `epic-019-notifications.md` |

---

## EP-001 — Processo de contratação

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-001 Criar processo | Abertura do processo com workflow inicial, numeração e vínculos | `feature-001-create-process.md` |
| FT-002 Consultar processos | Lista com busca, filtros, ordenação, visões salvas e exportação | `feature-002-process-search.md` |
| FT-003 Painel do processo | Detalhe com painel situacional ("7 perguntas") | `feature-003-process-cockpit.md` |
| FT-004 Manter dados do processo | Edição de dados, itens e etiquetas | `feature-004-process-maintenance.md` |
| FT-005 Ciclo de vida do processo | Suspender/retomar, cancelar/descartar, concluir | `feature-005-process-lifecycle.md` |
| FT-006 Duplicar processo | Novo processo a partir de existente | `feature-006-process-duplication.md` |
| FT-007 Acesso e sigilo | Participantes e orçamento sigiloso | `feature-007-process-access-confidentiality.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-001 | Criar processo de contratação | FT-001 | P0 | L | US-042, US-059, US-073, US-082, US-097, US-102, US-104, US-105 | `story-001-create-process.md` |
| US-002 | Listar, pesquisar, filtrar e ordenar processos | FT-002 | P0 | L | US-001, US-097 | `story-002-list-search-processes.md` |
| US-003 | Visões salvas e exportação CSV da lista de processos | FT-002 | P2 | M | US-002 | `story-003-saved-views-export.md` |
| US-004 | Visualizar detalhe do processo com painel situacional | FT-003 | P0 | L | US-001, US-041 | `story-004-process-cockpit.md` |
| US-005 | Editar dados do processo | FT-004 | P0 | M | US-001 | `story-005-edit-process.md` |
| US-006 | Gerenciar itens da contratação | FT-004 | P0 | M | US-001, US-104 | `story-006-process-items.md` |
| US-007 | Gerenciar etiquetas do processo | FT-004 | P2 | S | US-005 | `story-007-process-tags.md` |
| US-008 | Suspender e retomar processo | FT-005 | P1 | M | US-047, US-055 | `story-008-suspend-resume-process.md` |
| US-009 | Cancelar processo ou descartar rascunho | FT-005 | P0 | M | US-001, US-051 | `story-009-cancel-discard-process.md` |
| US-010 | Concluir processo (planejamento da contratação) | FT-005 | P0 | M | US-047, US-052 | `story-010-complete-process.md` |
| US-011 | Duplicar processo | FT-006 | P1 | M | US-001, US-065 | `story-011-duplicate-process.md` |
| US-012 | Gerenciar participantes do processo | FT-007 | P1 | M | US-001, US-097 | `story-012-process-participants.md` |
| US-013 | Sigilo do orçamento estimado | FT-007 | P1 | M | US-001, US-097 | `story-013-confidential-budget.md` |

## EP-002 — DFD

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-008 Elaboração do DFD | Wizard de 5 passos, template, rascunho e autosave | `feature-008-dfd-authoring.md` |
| FT-009 Conclusão e decisão do DFD | Revisão, conclusão, envio para aprovação e efeitos da decisão | `feature-009-dfd-conclusion-decision.md` |
| FT-010 Reaproveitamento do DFD | Duplicação de DFD | `feature-010-dfd-reuse.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-014 | Elaborar DFD em wizard a partir de template | FT-008 | P0 | L | US-006, US-065, US-110 | `story-014-dfd-wizard.md` |
| US-015 | Editar DFD com autosave, retomada e tratamento de conflito | FT-008 | P0 | M | US-014 | `story-015-dfd-autosave.md` |
| US-016 | Revisar, concluir e enviar o DFD para aprovação | FT-009 | P0 | M | US-015, US-047, US-051 | `story-016-dfd-conclude-forward.md` |
| US-017 | Tratar decisão sobre o DFD e propagar dados ao processo | FT-009 | P0 | M | US-016, US-052 | `story-017-dfd-decision-effects.md` |
| US-018 | Duplicar DFD | FT-010 | P2 | S | US-014, US-011 | `story-018-duplicate-dfd.md` |

## EP-003 — ETP

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-011 Elaboração do ETP | Criação com template e importação do DFD; edição por seções | `feature-011-etp-authoring.md` |
| FT-012 Alternativas de solução | Levantamento e decisão entre alternativas | `feature-012-etp-alternatives.md` |
| FT-013 Estimativas | Quantidades com memória de cálculo e valor estimado | `feature-013-etp-estimates.md` |
| FT-014 Validação e conclusão do ETP | Completude configurável (art. 18) e conclusão | `feature-014-etp-validation.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-019 | Criar ETP a partir de template com importação do DFD | FT-011 | P0 | M | US-014, US-065, US-110 | `story-019-create-etp.md` |
| US-020 | Editar seções do ETP com autosave e "não se aplica" justificado | FT-011 | P0 | L | US-015, US-019 | `story-020-etp-sections.md` |
| US-021 | Gerenciar alternativas de solução | FT-012 | P0 | M | US-019 | `story-021-etp-alternatives.md` |
| US-022 | Estimar quantidades e vincular valor à pesquisa de preços | FT-013 | P0 | M | US-019, US-029 | `story-022-etp-estimates.md` |
| US-023 | Validar completude do ETP e concluí-lo | FT-014 | P0 | M | US-020, US-021, US-022 | `story-023-etp-validate-conclude.md` |

## EP-004 — Pesquisa de preços

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-015 Pesquisa e itens | Criação da pesquisa a partir dos itens do processo | `feature-015-price-research-setup.md` |
| FT-016 Fornecedores | Cadastro de fornecedores do tenant | `feature-016-suppliers.md` |
| FT-017 Fontes e cotações | Registro de fontes/evidências e preços; exclusão justificada; importação | `feature-017-price-sources-quotations.md` |
| FT-018 Cálculos e alertas | Estatísticas, valor recomendado, outliers e conformidade | `feature-018-price-calculations.md` |
| FT-019 Mapa comparativo | Matriz itens × fontes e exportação | `feature-019-comparative-map.md` |
| FT-020 Conclusão da pesquisa | Validação, conclusão e relatório | `feature-020-price-research-conclusion.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-024 | Criar pesquisa de preços a partir dos itens do processo | FT-015 | P0 | M | US-006, US-065, US-110 | `story-024-create-price-research.md` |
| US-025 | Cadastrar e manter fornecedores | FT-016 | P0 | M | US-097, US-100 | `story-025-suppliers.md` |
| US-026 | Registrar fontes de pesquisa e cotações | FT-017 | P0 | L | US-024, US-025, US-068 | `story-026-price-sources-quotations.md` |
| US-027 | Desconsiderar e restaurar cotação com justificativa | FT-017 | P0 | S | US-026 | `story-027-exclude-restore-quotation.md` |
| US-028 | Importar cotações por planilha | FT-017 | P2 | M | US-026, US-068 | `story-028-import-quotations.md` |
| US-029 | Calcular estatísticas e valor estimado por item | FT-018 | P0 | M | US-026 | `story-029-price-statistics.md` |
| US-030 | Sinalizar outliers e alertas de conformidade | FT-018 | P1 | M | US-029 | `story-030-price-outliers-alerts.md` |
| US-031 | Visualizar e exportar o mapa comparativo | FT-019 | P0 | M | US-029, US-067 | `story-031-comparative-map.md` |
| US-032 | Concluir a pesquisa de preços | FT-020 | P0 | M | US-029, US-066 | `story-032-conclude-price-research.md` |

## EP-005 — Mapa de riscos

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-021 Identificação e avaliação | Registro de riscos com P × I e nível | `feature-021-risk-identification.md` |
| FT-022 Tratamento | Ações preventivas e de contingência | `feature-022-risk-treatment.md` |
| FT-023 Matriz e documento | Mapa de calor e documento Mapa de Riscos | `feature-023-risk-matrix-document.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-033 | Registrar e avaliar riscos | FT-021 | P0 | M | US-001, US-104 | `story-033-risk-register.md` |
| US-034 | Gerenciar ações de tratamento de riscos | FT-022 | P0 | M | US-033 | `story-034-risk-treatments.md` |
| US-035 | Visualizar matriz de riscos e emitir o Mapa de Riscos | FT-023 | P1 | M | US-034, US-065, US-110 | `story-035-risk-matrix-document.md` |

## EP-006 — Termo de Referência

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-024 Elaboração do TR | Criação e edição por seções | `feature-024-tr-authoring.md` |
| FT-025 Importação do ETP | Importação com prévia e rastreabilidade | `feature-025-tr-etp-import.md` |
| FT-026 Itens e condições | Itens, especificações e condições contratuais tipadas | `feature-026-tr-items-conditions.md` |
| FT-027 Validação e conclusão | Completude e conclusão do TR | `feature-027-tr-validation.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-036 | Criar TR e editar suas seções | FT-024 | P0 | L | US-015, US-065, US-110 | `story-036-tr-authoring.md` |
| US-037 | Importar dados do ETP para o TR | FT-025 | P0 | M | US-020, US-036 | `story-037-tr-import-etp.md` |
| US-038 | Especificar itens e condições contratuais do TR | FT-026 | P0 | M | US-006, US-036 | `story-038-tr-items-conditions.md` |
| US-039 | Validar e concluir o TR | FT-027 | P0 | M | US-037, US-038 | `story-039-tr-validate-conclude.md` |

## EP-007 — Workflow

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-028 Motor de workflow | Modelo versionado e motor de execução | `feature-028-workflow-engine.md` |
| FT-029 Workflow padrão e aplicabilidade | Workflow semeado e seleção automática | `feature-029-default-workflow.md` |
| FT-030 Administração de workflows | Editor, regras, publicação e diagrama | `feature-030-workflow-administration.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-040 | Modelo de definição de workflow versionado | FT-028 | P0 | L | US-061, US-100 | `story-040-workflow-definition-model.md` |
| US-041 | Motor de execução: ações disponíveis e avaliação de regras | FT-028 | P0 | L | US-040 | `story-041-workflow-engine.md` |
| US-042 | Workflow padrão e seleção por aplicabilidade | FT-029 | P0 | M | US-041, US-104 | `story-042-default-workflow-applicability.md` |
| US-043 | Editor de workflow (etapas e transições) | FT-030 | P1 | L | US-040 | `story-043-workflow-editor.md` |
| US-044 | Regras de etapa e de transição | FT-030 | P1 | M | US-041, US-043 | `story-044-workflow-rules.md` |
| US-045 | Publicar, versionar e aposentar workflow | FT-030 | P1 | M | US-043 | `story-045-workflow-publish-versioning.md` |
| US-046 | Visualizar diagrama do workflow | FT-030 | P2 | M | US-043 | `story-046-workflow-diagram.md` |

## EP-008 — Tramitação

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-031 Encaminhamento | Encaminhar com prazo, comentário e documentos | `feature-031-forwarding.md` |
| FT-032 Devolução | Devolver com motivo | `feature-032-returning.md` |
| FT-033 Responsabilidade | Assumir, atribuir e reatribuir | `feature-033-responsibility.md` |
| FT-034 Aprovações | Solicitar, decidir, retirar e redirecionar | `feature-034-approvals.md` |
| FT-035 Registro e prazos | Histórico de tramitação e prazos em dias úteis | `feature-035-movement-history-deadlines.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-047 | Encaminhar processo | FT-031 | P0 | L | US-004, US-041, US-059, US-106 | `story-047-forward-process.md` |
| US-048 | Devolver processo | FT-032 | P0 | M | US-047 | `story-048-return-process.md` |
| US-049 | Assumir processo recebido pela unidade | FT-033 | P0 | S | US-047 | `story-049-claim-process.md` |
| US-050 | Atribuir e reatribuir responsável | FT-033 | P0 | M | US-049 | `story-050-assign-process.md` |
| US-051 | Solicitar aprovação e resolver o aprovador | FT-034 | P0 | L | US-047, US-065 | `story-051-request-approval.md` |
| US-052 | Decidir aprovação (aprovar, devolver, indeferir) | FT-034 | P0 | L | US-051 | `story-052-decide-approval.md` |
| US-053 | Retirar ou redirecionar aprovação pendente | FT-034 | P1 | M | US-052 | `story-053-withdraw-reassign-approval.md` |
| US-054 | Histórico de tramitações | FT-035 | P0 | M | US-047 | `story-054-movement-history.md` |
| US-055 | Prazos em dias úteis e detecção de atrasos | FT-035 | P0 | M | US-047, US-083, US-106 | `story-055-deadlines-overdue.md` |

## EP-009 — Caixa de tarefas

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-036 Caixa de tarefas e aprovações | Caixa unificada, lista de aprovações e ações em lote | `feature-036-task-inbox.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-056 | Caixa de tarefas unificada | FT-036 | P0 | L | US-049, US-051 | `story-056-task-inbox.md` |
| US-057 | Lista de aprovações | FT-036 | P0 | M | US-051 | `story-057-approvals-list.md` |
| US-058 | Ações em lote na caixa de tarefas | FT-036 | P2 | M | US-056 | `story-058-inbox-bulk-actions.md` |

## EP-010 — Timeline

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-037 Timeline do processo | Projeção síncrona e visualização | `feature-037-process-timeline.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-059 | Projetar eventos do processo na timeline | FT-037 | P0 | M | US-082 | `story-059-timeline-projection.md` |
| US-060 | Visualizar timeline com filtros | FT-037 | P0 | M | US-059 | `story-060-timeline-view.md` |

## EP-011 — Documentos

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-038 Tipos de documento | Tipos de sistema e personalizados | `feature-038-document-types.md` |
| FT-039 Documentos do processo | Painel, documentos livres e externos | `feature-039-process-documents.md` |
| FT-040 Ciclo de vida e versões | Estados, versões imutáveis, comparação | `feature-040-document-lifecycle-versioning.md` |
| FT-041 Geração de PDF | Renderização assíncrona com hash | `feature-041-pdf-generation.md` |
| FT-042 Anexos | Upload seguro, download e presença | `feature-042-attachments.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-061 | Gerenciar tipos de documento | FT-038 | P1 | M | US-100 | `story-061-document-types.md` |
| US-062 | Painel de documentos do processo | FT-039 | P0 | M | US-065 | `story-062-process-documents-panel.md` |
| US-063 | Criar documento livre a partir de template | FT-039 | P1 | M | US-015, US-065 | `story-063-free-text-documents.md` |
| US-064 | Incluir documento externo (upload) com versões | FT-039 | P1 | M | US-065, US-068 | `story-064-uploaded-documents.md` |
| US-065 | Ciclo de vida do documento | FT-040 | P0 | L | US-061, US-108 | `story-065-document-lifecycle.md` |
| US-066 | Versionamento imutável e comparação de versões | FT-040 | P0 | M | US-065 | `story-066-document-versioning.md` |
| US-067 | Gerar PDF de documentos | FT-041 | P0 | L | US-066, US-083 | `story-067-pdf-generation.md` |
| US-068 | Upload seguro de anexos | FT-042 | P0 | L | US-083, US-097 | `story-068-secure-upload.md` |
| US-069 | Visualizar e baixar anexos | FT-042 | P0 | S | US-068 | `story-069-attachment-download.md` |
| US-070 | Indicador de edição concorrente | FT-042 | P2 | M | US-015 | `story-070-editing-presence.md` |

## EP-012 — Comentários

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-043 Comentários e menções | Comentários em processo/documento e menções | `feature-043-comments-mentions.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-071 | Comentar no processo e em documentos | FT-043 | P0 | M | US-001, US-059 | `story-071-comments.md` |
| US-072 | Mencionar usuários e unidades | FT-043 | P1 | M | US-071, US-111 | `story-072-mentions.md` |

## EP-013 — Auditoria

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-044 Registro de auditoria | Registro transacional e selagem | `feature-044-audit-recording.md` |
| FT-045 Consulta de auditoria | Pesquisa e exportação | `feature-045-audit-query.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-073 | Registrar auditoria transacional | FT-044 | P0 | L | US-081, US-084 | `story-073-audit-recording.md` |
| US-074 | Selagem de integridade da trilha de auditoria | FT-044 | P1 | M | US-073, US-083 | `story-074-audit-seal.md` |
| US-075 | Consultar e exportar a trilha de auditoria | FT-045 | P0 | M | US-073, US-097 | `story-075-audit-query-export.md` |

## EP-014 — Dashboard

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-046 Dashboard operacional | Indicadores operacionais por perfil | `feature-046-operational-dashboard.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-076 | Dashboard operacional por perfil | FT-046 | P0 | L | US-002, US-055, US-056 | `story-076-operational-dashboard.md` |

## EP-015 — Fundação técnica

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-047 Monorepo e ambiente | Monorepo, ambiente local e CI | `feature-047-monorepo-environment.md` |
| FT-048 Arquitetura base da API | Esqueleto, persistência, outbox e worker | `feature-048-api-foundation.md` |
| FT-049 Observabilidade | Logs, tracing, métricas e health | `feature-049-observability.md` |
| FT-050 Frontend base | Shell, design system e cliente de API | `feature-050-web-foundation.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-077 | Configurar monorepo e padrões de código | FT-047 | P0 | M | — | `story-077-monorepo-setup.md` |
| US-078 | Ambiente local com Docker Compose | FT-047 | P0 | M | US-077 | `story-078-local-environment.md` |
| US-079 | Pipeline de CI com quality gates | FT-047 | P0 | M | US-077 | `story-079-ci-pipeline.md` |
| US-080 | Esqueleto da API modular | FT-048 | P0 | L | US-077 | `story-080-api-foundation.md` |
| US-081 | Persistência com Prisma e concorrência otimista | FT-048 | P0 | M | US-078, US-080 | `story-081-persistence-prisma.md` |
| US-082 | Eventos de domínio com outbox transacional | FT-048 | P0 | L | US-081 | `story-082-domain-events-outbox.md` |
| US-083 | Worker com filas, retries e dead letter | FT-048 | P0 | M | US-082 | `story-083-worker-queues.md` |
| US-084 | Logs estruturados, correlationId e tracing | FT-049 | P0 | M | US-080 | `story-084-logging-tracing.md` |
| US-085 | Health checks, métricas e dashboards técnicos | FT-049 | P1 | M | US-080, US-083 | `story-085-health-metrics.md` |
| US-086 | Shell da aplicação web, design system e cliente de API | FT-050 | P0 | L | US-077 | `story-086-web-shell-design-system.md` |

## EP-016 — Identidade, acesso e RBAC

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-051 Autenticação | Login OIDC/PKCE, sessão, logout, recuperação de senha, MFA | `feature-051-authentication.md` |
| FT-052 Usuários e vínculos | Convite, gestão de usuários e troca de órgão | `feature-052-users-memberships.md` |
| FT-053 Perfis e permissões | Catálogo, perfis, atribuições e enforcement | `feature-053-roles-permissions.md` |
| FT-054 Perfil do usuário | Meu perfil e preferências | `feature-054-user-profile.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-087 | Login OIDC com Authentik e sessão segura no BFF | FT-051 | P0 | L | US-078, US-080, US-086 | `story-087-oidc-login-bff.md` |
| US-088 | Logout, expiração e renovação de sessão | FT-051 | P0 | M | US-087 | `story-088-logout-session-expiry.md` |
| US-089 | Recuperação de senha | FT-051 | P0 | S | US-087 | `story-089-password-recovery.md` |
| US-090 | Política de MFA por tenant com step-up | FT-051 | P1 | M | US-087, US-097 | `story-090-mfa-policy.md` |
| US-091 | Convidar usuário e ativar vínculo | FT-052 | P0 | M | US-087, US-102, US-112 | `story-091-invite-user.md` |
| US-092 | Gerenciar usuários e lotações | FT-052 | P0 | M | US-091 | `story-092-manage-users.md` |
| US-093 | Selecionar órgão ativo | FT-052 | P1 | S | US-087 | `story-093-tenant-switch.md` |
| US-094 | Catálogo de permissões e perfis padrão | FT-053 | P0 | M | US-100 | `story-094-permission-catalog-default-roles.md` |
| US-095 | Gerenciar perfis e matriz de permissões | FT-053 | P0 | M | US-094 | `story-095-manage-roles.md` |
| US-096 | Atribuir perfis com escopo e vigência | FT-053 | P0 | M | US-091, US-094 | `story-096-assign-roles.md` |
| US-097 | Autorização na API e no frontend | FT-053 | P0 | L | US-094, US-096, US-100 | `story-097-authorization-enforcement.md` |
| US-098 | Meu perfil e preferências | FT-054 | P1 | S | US-087 | `story-098-my-profile.md` |

## EP-017 — Tenant e estrutura organizacional

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-055 Provisionamento e isolamento | Provisionamento e isolamento de dados | `feature-055-tenant-provisioning-isolation.md` |
| FT-056 Estrutura organizacional | Órgãos/entidades, secretarias e setores | `feature-056-organizational-structure.md` |
| FT-057 Parametrização | Configurações, catálogos, numeração e calendário | `feature-057-tenant-configuration.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-099 | Provisionar tenant com dados padrão | FT-055 | P0 | M | US-081, US-100 | `story-099-tenant-provisioning.md` |
| US-100 | Contexto de tenant e isolamento de dados | FT-055 | P0 | L | US-080, US-081 | `story-100-tenant-isolation.md` |
| US-101 | Gerenciar órgãos/entidades | FT-056 | P0 | S | US-100 | `story-101-organizations.md` |
| US-102 | Gerenciar secretarias e setores | FT-056 | P0 | M | US-101 | `story-102-departments.md` |
| US-103 | Configurações gerais do tenant | FT-057 | P0 | M | US-100 | `story-103-tenant-settings.md` |
| US-104 | Catálogos parametrizáveis | FT-057 | P0 | M | US-100 | `story-104-catalogs.md` |
| US-105 | Numeração configurável e segura sob concorrência | FT-057 | P0 | M | US-103 | `story-105-numbering.md` |
| US-106 | Calendário de dias úteis e feriados | FT-057 | P1 | S | US-100 | `story-106-business-calendar.md` |

## EP-018 — Templates de documentos

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-058 Templates de documentos | Editor, publicação, layout e biblioteca padrão | `feature-058-document-templates.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-107 | Criar e editar template de documento | FT-058 | P0 | L | US-061 | `story-107-template-editor.md` |
| US-108 | Publicar versão de template e definir padrão do tipo | FT-058 | P0 | M | US-107 | `story-108-template-publishing.md` |
| US-109 | Layout de impressão (timbre, cabeçalho, rodapé) | FT-058 | P1 | M | US-067, US-107 | `story-109-print-layout.md` |
| US-110 | Biblioteca de templates padrão | FT-058 | P0 | M | US-108 | `story-110-default-template-library.md` |

## EP-019 — Notificações

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-059 Notificações | Central in-app, e-mails, preferências e lembretes | `feature-059-notifications.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-111 | Central de notificações in-app | FT-059 | P0 | M | US-083, US-086 | `story-111-notification-center.md` |
| US-112 | E-mails transacionais | FT-059 | P0 | M | US-078, US-083 | `story-112-transactional-emails.md` |
| US-113 | Preferências de notificação | FT-059 | P2 | S | US-111 | `story-113-notification-preferences.md` |
| US-114 | Lembretes de prazo e alertas de atraso | FT-059 | P1 | M | US-055, US-111, US-112 | `story-114-deadline-reminders.md` |

---

## Apêndice A — Inventário canônico de telas do MVP 1

IDs `SCR-001`…`SCR-041` seguem a numeração das 41 telas pedidas pelo produto (as que pertencem a MVPs futuros não são especificadas agora). `SCR-1xx` são telas/diálogos adicionais do MVP 1. Rotas web em pt-BR (DEC-001). Especificação completa em [screens.md](screens.md).

| ID | Tela | Rota | Stories principais |
|---|---|---|---|
| SCR-001 | Login (entrada) | `/entrar` → fluxo Authentik | US-087 |
| SCR-002 | Recuperar senha | `/recuperar-senha` → fluxo Authentik | US-089 |
| SCR-003 | Dashboard | `/painel` | US-076 |
| SCR-004 | Processos | `/processos` | US-002, US-003 |
| SCR-005 | Novo processo (wizard) | `/processos/novo` | US-001 |
| SCR-006 | Detalhe do processo (painel situacional + abas Resumo, Documentos, Itens, Tramitação, Timeline, Comentários, Participantes) | `/processos/[id]` | US-004, US-005, US-006, US-054, US-060, US-062, US-071 |
| SCR-007 | DFD (wizard/editor) | `/processos/[id]/dfd/[dfdId]` | US-014, US-015, US-016 |
| SCR-008 | ETP (editor por seções) | `/processos/[id]/etp/[etpId]` | US-019 a US-023 |
| SCR-009 | Pesquisa de preços | `/processos/[id]/pesquisa-precos/[researchId]` | US-024 a US-030, US-032 |
| SCR-010 | Mapa comparativo | `/processos/[id]/pesquisa-precos/[researchId]/mapa` | US-031 |
| SCR-011 | Riscos (mapa de riscos) | `/processos/[id]/riscos` | US-033 a US-035 |
| SCR-012 | TR (editor) | `/processos/[id]/tr/[termId]` | US-036 a US-039 |
| SCR-013 | Caixa de tarefas | `/tarefas` | US-056, US-058 |
| SCR-014 | Aprovações | `/aprovacoes` | US-057 |
| SCR-015 | Detalhe da aprovação | `/aprovacoes/[id]` | US-052, US-053 |
| SCR-029 | Usuários | `/admin/usuarios` e `/admin/usuarios/[userId]` | US-091, US-092, US-096 |
| SCR-030 | Perfis | `/admin/perfis` | US-095 |
| SCR-031 | Permissões (matriz do perfil) | `/admin/perfis/[roleId]` | US-094, US-095 |
| SCR-032 | Secretarias (estrutura: órgãos, secretarias, setores) | `/admin/estrutura` | US-101, US-102 |
| SCR-033 | Templates | `/admin/templates` | US-107, US-108 |
| SCR-034 | Workflow (lista e editor) | `/admin/workflows` e `/admin/workflows/[id]` | US-042 a US-046 |
| SCR-035 | Regras (painel de regras do workflow) | `/admin/workflows/[id]/regras` | US-044 |
| SCR-036 | Notificações | `/notificacoes` | US-111 (atalho para preferências: US-113) |
| SCR-037 | Auditoria | `/auditoria` | US-074, US-075 |
| SCR-039 | Perfil (meu perfil) | `/perfil` | US-098, US-113, US-090 |
| SCR-041 | Configurações gerais | `/admin/configuracoes` | US-103, US-105 |
| SCR-101 | Seleção de órgão | `/selecionar-orgao` | US-093 |
| SCR-102 | Aceite de convite / primeiro acesso | `/convite/[token]` | US-091 |
| SCR-103 | Encaminhar processo (painel lateral) | diálogo em SCR-006 | US-047, US-016 |
| SCR-104 | Devolver processo (diálogo) | diálogo em SCR-006 | US-048 |
| SCR-105 | Documento livre/externo (editor e visualizador) | `/processos/[id]/documentos/[docId]` | US-063, US-064, US-065 |
| SCR-106 | Versões e comparação | `/processos/[id]/documentos/[docId]/versoes` | US-066, US-067 |
| SCR-107 | Fornecedores | `/fornecedores` | US-025 |
| SCR-108 | Tipos de documento | `/admin/tipos-documento` | US-061 |
| SCR-109 | Catálogos (inclui aba Etiquetas) | `/admin/catalogos` | US-104, US-007 |
| SCR-110 | Calendário de dias úteis | `/admin/calendario` | US-106 |
| SCR-111 | Páginas de erro e estados globais (403, 404, 500, sessão expirada, manutenção, sem vínculo) | `/erro/*` | US-086, US-088 |
| SCR-112 | Participantes do processo (painel) | aba em SCR-006 | US-012 |
| SCR-113 | Duplicar processo (diálogo) | diálogo em SCR-006 | US-011, US-018 |
| SCR-114 | Editor de template (seções e layout) | `/admin/templates/[id]/versoes/[versionId]` | US-107, US-109 |
| SCR-115 | Atribuir responsável / assumir (diálogo) | diálogo em SCR-006 e SCR-013 | US-049, US-050, US-058 |
| SCR-116 | Suspender, retomar, cancelar e concluir (diálogos) | diálogos em SCR-006 | US-008, US-009, US-010 |
