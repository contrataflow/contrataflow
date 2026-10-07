# Backlog — Índice

> Índice navegável dos cards. Fonte canônica de IDs, prioridades, estimativas e dependências: [`../mvp-01/features.md`](../mvp-01/features.md). Modelos: [`_templates/`](_templates/). Exemplo de referência: [US-001](story-001-create-process.md).
> Cada story segue o padrão de card de 28 seções com critérios de aceite em Gherkin (8 categorias de cenário). ⏳ = card ainda não escrito.

## Convenções

- Arquivos: `epic-NNN-slug.md`, `feature-NNN-slug.md`, `story-NNN-slug.md` (numeração global e contínua entre MVPs).
- Front matter YAML de cada card: `id`, `epic`, `feature`, `priority`, `estimate`, `depends_on`, `screens`, `endpoints`, `permissions`, `events`.
- Estimativa: XS = 1 · S = 2 · M = 5 · L = 8 · XL = 13 pontos.

## Épicos

| Épico | Título | Área RN | Stories | Pontos |
|---|---|---|---|---|
| [EP-001](epic-001-process.md) | Processo de contratação | `PROC` | 13 | 71 |
| [EP-002](epic-002-dfd.md) | DFD | `DFD` | 5 | 25 |
| [EP-003](epic-003-etp.md) | ETP | `ETP` | 5 | 28 |
| [EP-004](epic-004-price-research.md) | Pesquisa de preços | `PRICE` | 9 | 45 |
| [EP-005](epic-005-risk-map.md) | Mapa de riscos | `RISK` | 3 | 15 |
| [EP-006](epic-006-term-of-reference.md) | Termo de Referência | `TR` | 4 | 23 |
| [EP-007](epic-007-workflow.md) | Workflow | `WF` | 7 | 44 |
| [EP-008](epic-008-routing.md) | Tramitação | `TRAM` | 9 | 51 |
| [EP-009](epic-009-task-inbox.md) | Caixa de tarefas | `INBOX` | 3 | 18 |
| [EP-010](epic-010-timeline.md) | Timeline | `TML` | 2 | 10 |
| [EP-011](epic-011-documents.md) | Documentos | `DOC` | 10 | 56 |
| [EP-012](epic-012-comments.md) | Comentários | `CMT` | 2 | 10 |
| [EP-013](epic-013-audit.md) | Auditoria | `AUD` | 3 | 18 |
| [EP-014](epic-014-dashboard.md) | Dashboard | `DASH` | 1 | 8 |
| [EP-015](epic-015-technical-foundation.md) | Fundação técnica | `FND` | 10 | 59 |
| [EP-016](epic-016-identity-access.md) | Identidade, acesso e RBAC | `IAM` | 12 | 57 |
| [EP-017](epic-017-tenancy-organization.md) | Tenant e estrutura organizacional | `TEN` | 8 | 37 |
| [EP-018](epic-018-document-templates.md) | Templates de documentos | `TPL` | 4 | 23 |
| [EP-019](epic-019-notifications.md) | Notificações | `NTF` | 4 | 17 |
| **Total** | | | **114** | **615** |

## Features

| Feature | Título | Épico | Stories |
|---|---|---|---|
| [FT-001](feature-001-create-process.md) | Criar processo | EP-001 | US-001 |
| [FT-002](feature-002-process-search.md) | Consultar processos | EP-001 | US-002, US-003 |
| [FT-003](feature-003-process-cockpit.md) | Painel do processo | EP-001 | US-004 |
| [FT-004](feature-004-process-maintenance.md) | Manter dados do processo | EP-001 | US-005, US-006, US-007 |
| [FT-005](feature-005-process-lifecycle.md) | Ciclo de vida do processo | EP-001 | US-008, US-009, US-010 |
| [FT-006](feature-006-process-duplication.md) | Duplicar processo | EP-001 | US-011 |
| [FT-007](feature-007-process-access-confidentiality.md) | Acesso e sigilo | EP-001 | US-012, US-013 |
| [FT-008](feature-008-dfd-authoring.md) | Elaboração do DFD | EP-002 | US-014, US-015 |
| [FT-009](feature-009-dfd-conclusion-decision.md) | Conclusão e decisão do DFD | EP-002 | US-016, US-017 |
| [FT-010](feature-010-dfd-reuse.md) | Reaproveitamento do DFD | EP-002 | US-018 |
| [FT-011](feature-011-etp-authoring.md) | Elaboração do ETP | EP-003 | US-019, US-020 |
| [FT-012](feature-012-etp-alternatives.md) | Alternativas de solução | EP-003 | US-021 |
| [FT-013](feature-013-etp-estimates.md) | Estimativas | EP-003 | US-022 |
| [FT-014](feature-014-etp-validation.md) | Validação e conclusão do ETP | EP-003 | US-023 |
| [FT-015](feature-015-price-research-setup.md) | Pesquisa e itens | EP-004 | US-024 |
| [FT-016](feature-016-suppliers.md) | Fornecedores | EP-004 | US-025 |
| [FT-017](feature-017-price-sources-quotations.md) | Fontes e cotações | EP-004 | US-026, US-027, US-028 |
| [FT-018](feature-018-price-calculations.md) | Cálculos e alertas | EP-004 | US-029, US-030 |
| [FT-019](feature-019-comparative-map.md) | Mapa comparativo | EP-004 | US-031 |
| [FT-020](feature-020-price-research-conclusion.md) | Conclusão da pesquisa | EP-004 | US-032 |
| [FT-021](feature-021-risk-identification.md) | Identificação e avaliação | EP-005 | US-033 |
| [FT-022](feature-022-risk-treatment.md) | Tratamento | EP-005 | US-034 |
| [FT-023](feature-023-risk-matrix-document.md) | Matriz e documento | EP-005 | US-035 |
| [FT-024](feature-024-tr-authoring.md) | Elaboração do TR | EP-006 | US-036 |
| [FT-025](feature-025-tr-etp-import.md) | Importação do ETP | EP-006 | US-037 |
| [FT-026](feature-026-tr-items-conditions.md) | Itens e condições | EP-006 | US-038 |
| [FT-027](feature-027-tr-validation.md) | Validação e conclusão | EP-006 | US-039 |
| [FT-028](feature-028-workflow-engine.md) | Motor de workflow | EP-007 | US-040, US-041 |
| [FT-029](feature-029-default-workflow.md) | Workflow padrão e aplicabilidade | EP-007 | US-042 |
| [FT-030](feature-030-workflow-administration.md) | Administração de workflows | EP-007 | US-043, US-044, US-045, US-046 |
| [FT-031](feature-031-forwarding.md) | Encaminhamento | EP-008 | US-047 |
| [FT-032](feature-032-returning.md) | Devolução | EP-008 | US-048 |
| [FT-033](feature-033-responsibility.md) | Responsabilidade | EP-008 | US-049, US-050 |
| [FT-034](feature-034-approvals.md) | Aprovações | EP-008 | US-051, US-052, US-053 |
| [FT-035](feature-035-movement-history-deadlines.md) | Registro e prazos | EP-008 | US-054, US-055 |
| [FT-036](feature-036-task-inbox.md) | Caixa de tarefas e aprovações | EP-009 | US-056, US-057, US-058 |
| [FT-037](feature-037-process-timeline.md) | Timeline do processo | EP-010 | US-059, US-060 |
| [FT-038](feature-038-document-types.md) | Tipos de documento | EP-011 | US-061 |
| [FT-039](feature-039-process-documents.md) | Documentos do processo | EP-011 | US-062, US-063, US-064 |
| [FT-040](feature-040-document-lifecycle-versioning.md) | Ciclo de vida e versões | EP-011 | US-065, US-066 |
| [FT-041](feature-041-pdf-generation.md) | Geração de PDF | EP-011 | US-067 |
| [FT-042](feature-042-attachments.md) | Anexos | EP-011 | US-068, US-069, US-070 |
| [FT-043](feature-043-comments-mentions.md) | Comentários e menções | EP-012 | US-071, US-072 |
| [FT-044](feature-044-audit-recording.md) | Registro de auditoria | EP-013 | US-073, US-074 |
| [FT-045](feature-045-audit-query.md) | Consulta de auditoria | EP-013 | US-075 |
| [FT-046](feature-046-operational-dashboard.md) | Dashboard operacional | EP-014 | US-076 |
| [FT-047](feature-047-monorepo-environment.md) | Monorepo e ambiente | EP-015 | US-077, US-078, US-079 |
| [FT-048](feature-048-api-foundation.md) | Arquitetura base da API | EP-015 | US-080, US-081, US-082, US-083 |
| [FT-049](feature-049-observability.md) | Observabilidade | EP-015 | US-084, US-085 |
| [FT-050](feature-050-web-foundation.md) | Frontend base | EP-015 | US-086 |
| [FT-051](feature-051-authentication.md) | Autenticação | EP-016 | US-087, US-088, US-089, US-090 |
| [FT-052](feature-052-users-memberships.md) | Usuários e vínculos | EP-016 | US-091, US-092, US-093 |
| [FT-053](feature-053-roles-permissions.md) | Perfis e permissões | EP-016 | US-094, US-095, US-096, US-097 |
| [FT-054](feature-054-user-profile.md) | Perfil do usuário | EP-016 | US-098 |
| [FT-055](feature-055-tenant-provisioning-isolation.md) | Provisionamento e isolamento | EP-017 | US-099, US-100 |
| [FT-056](feature-056-organizational-structure.md) | Estrutura organizacional | EP-017 | US-101, US-102 |
| [FT-057](feature-057-tenant-configuration.md) | Parametrização | EP-017 | US-103, US-104, US-105, US-106 |
| [FT-058](feature-058-document-templates.md) | Templates de documentos | EP-018 | US-107, US-108, US-109, US-110 |
| [FT-059](feature-059-notifications.md) | Notificações | EP-019 | US-111, US-112, US-113, US-114 |

## Stories

| Story | Título | Épico | Feature | Prio | Est | Depende de |
|---|---|---|---|---|---|---|
| [US-001](story-001-create-process.md) | Criar processo de contratação | EP-001 | FT-001 | P0 | L | US-042, US-059, US-073, US-082, US-097, US-102, US-104, US-105 |
| [US-002](story-002-list-search-processes.md) | Listar, pesquisar, filtrar e ordenar processos | EP-001 | FT-002 | P0 | L | US-001, US-097 |
| [US-003](story-003-saved-views-export.md) | Visões salvas e exportação CSV da lista de processos | EP-001 | FT-002 | P2 | M | US-002 |
| [US-004](story-004-process-cockpit.md) | Visualizar detalhe do processo com painel situacional | EP-001 | FT-003 | P0 | L | US-001, US-041 |
| [US-005](story-005-edit-process.md) | Editar dados do processo | EP-001 | FT-004 | P0 | M | US-001 |
| [US-006](story-006-process-items.md) | Gerenciar itens da contratação | EP-001 | FT-004 | P0 | M | US-001, US-104 |
| [US-007](story-007-process-tags.md) | Gerenciar etiquetas do processo | EP-001 | FT-004 | P2 | S | US-005 |
| [US-008](story-008-suspend-resume-process.md) | Suspender e retomar processo | EP-001 | FT-005 | P1 | M | US-047, US-055 |
| [US-009](story-009-cancel-discard-process.md) | Cancelar processo ou descartar rascunho | EP-001 | FT-005 | P0 | M | US-001, US-051 |
| [US-010](story-010-complete-process.md) | Concluir processo (planejamento da contratação) | EP-001 | FT-005 | P0 | M | US-047, US-052 |
| [US-011](story-011-duplicate-process.md) | Duplicar processo | EP-001 | FT-006 | P1 | M | US-001, US-065 |
| [US-012](story-012-process-participants.md) | Gerenciar participantes do processo | EP-001 | FT-007 | P1 | M | US-001, US-097 |
| [US-013](story-013-confidential-budget.md) | Sigilo do orçamento estimado | EP-001 | FT-007 | P1 | M | US-001, US-097 |
| [US-014](story-014-dfd-wizard.md) | Elaborar DFD em wizard a partir de template | EP-002 | FT-008 | P0 | L | US-006, US-065, US-110 |
| [US-015](story-015-dfd-autosave.md) | Editar DFD com autosave, retomada e tratamento de conflito | EP-002 | FT-008 | P0 | M | US-014 |
| [US-016](story-016-dfd-conclude-forward.md) | Revisar, concluir e enviar o DFD para aprovação | EP-002 | FT-009 | P0 | M | US-015, US-047, US-051 |
| [US-017](story-017-dfd-decision-effects.md) | Tratar decisão sobre o DFD e propagar dados ao processo | EP-002 | FT-009 | P0 | M | US-016, US-052 |
| [US-018](story-018-duplicate-dfd.md) | Duplicar DFD | EP-002 | FT-010 | P2 | S | US-014, US-011 |
| [US-019](story-019-create-etp.md) | Criar ETP a partir de template com importação do DFD | EP-003 | FT-011 | P0 | M | US-014, US-065, US-110 |
| [US-020](story-020-etp-sections.md) | Editar seções do ETP com autosave e "não se aplica" justificado | EP-003 | FT-011 | P0 | L | US-015, US-019 |
| [US-021](story-021-etp-alternatives.md) | Gerenciar alternativas de solução | EP-003 | FT-012 | P0 | M | US-019 |
| [US-022](story-022-etp-estimates.md) | Estimar quantidades e vincular valor à pesquisa de preços | EP-003 | FT-013 | P0 | M | US-019, US-029 |
| [US-023](story-023-etp-validate-conclude.md) | Validar completude do ETP e concluí-lo | EP-003 | FT-014 | P0 | M | US-020, US-021, US-022 |
| [US-024](story-024-create-price-research.md) | Criar pesquisa de preços a partir dos itens do processo | EP-004 | FT-015 | P0 | M | US-006, US-065, US-110 |
| [US-025](story-025-suppliers.md) | Cadastrar e manter fornecedores | EP-004 | FT-016 | P0 | M | US-097, US-100 |
| [US-026](story-026-price-sources-quotations.md) | Registrar fontes de pesquisa e cotações | EP-004 | FT-017 | P0 | L | US-024, US-025, US-068 |
| [US-027](story-027-exclude-restore-quotation.md) | Desconsiderar e restaurar cotação com justificativa | EP-004 | FT-017 | P0 | S | US-026 |
| [US-028](story-028-import-quotations.md) | Importar cotações por planilha | EP-004 | FT-017 | P2 | M | US-026, US-068 |
| [US-029](story-029-price-statistics.md) | Calcular estatísticas e valor estimado por item | EP-004 | FT-018 | P0 | M | US-026 |
| [US-030](story-030-price-outliers-alerts.md) | Sinalizar outliers e alertas de conformidade | EP-004 | FT-018 | P1 | M | US-029 |
| [US-031](story-031-comparative-map.md) | Visualizar e exportar o mapa comparativo | EP-004 | FT-019 | P0 | M | US-029, US-067 |
| [US-032](story-032-conclude-price-research.md) | Concluir a pesquisa de preços | EP-004 | FT-020 | P0 | M | US-029, US-066 |
| [US-033](story-033-risk-register.md) | Registrar e avaliar riscos | EP-005 | FT-021 | P0 | M | US-001, US-104 |
| [US-034](story-034-risk-treatments.md) | Gerenciar ações de tratamento de riscos | EP-005 | FT-022 | P0 | M | US-033 |
| [US-035](story-035-risk-matrix-document.md) | Visualizar matriz de riscos e emitir o Mapa de Riscos | EP-005 | FT-023 | P1 | M | US-034, US-065, US-110 |
| [US-036](story-036-tr-authoring.md) | Criar TR e editar suas seções | EP-006 | FT-024 | P0 | L | US-015, US-065, US-110 |
| [US-037](story-037-tr-import-etp.md) | Importar dados do ETP para o TR | EP-006 | FT-025 | P0 | M | US-020, US-036 |
| [US-038](story-038-tr-items-conditions.md) | Especificar itens e condições contratuais do TR | EP-006 | FT-026 | P0 | M | US-006, US-036 |
| [US-039](story-039-tr-validate-conclude.md) | Validar e concluir o TR | EP-006 | FT-027 | P0 | M | US-037, US-038 |
| [US-040](story-040-workflow-definition-model.md) | Modelo de definição de workflow versionado | EP-007 | FT-028 | P0 | L | US-061, US-100 |
| [US-041](story-041-workflow-engine.md) | Motor de execução: ações disponíveis e avaliação de regras | EP-007 | FT-028 | P0 | L | US-040 |
| [US-042](story-042-default-workflow-applicability.md) | Workflow padrão e seleção por aplicabilidade | EP-007 | FT-029 | P0 | M | US-041, US-104 |
| [US-043](story-043-workflow-editor.md) | Editor de workflow (etapas e transições) | EP-007 | FT-030 | P1 | L | US-040 |
| [US-044](story-044-workflow-rules.md) | Regras de etapa e de transição | EP-007 | FT-030 | P1 | M | US-041, US-043 |
| [US-045](story-045-workflow-publish-versioning.md) | Publicar, versionar e aposentar workflow | EP-007 | FT-030 | P1 | M | US-043 |
| [US-046](story-046-workflow-diagram.md) | Visualizar diagrama do workflow | EP-007 | FT-030 | P2 | M | US-043 |
| [US-047](story-047-forward-process.md) | Encaminhar processo | EP-008 | FT-031 | P0 | L | US-004, US-041, US-059, US-106 |
| [US-048](story-048-return-process.md) | Devolver processo | EP-008 | FT-032 | P0 | M | US-047 |
| [US-049](story-049-claim-process.md) | Assumir processo recebido pela unidade | EP-008 | FT-033 | P0 | S | US-047 |
| [US-050](story-050-assign-process.md) | Atribuir e reatribuir responsável | EP-008 | FT-033 | P0 | M | US-049 |
| [US-051](story-051-request-approval.md) | Solicitar aprovação e resolver o aprovador | EP-008 | FT-034 | P0 | L | US-047, US-065 |
| [US-052](story-052-decide-approval.md) | Decidir aprovação (aprovar, devolver, indeferir) | EP-008 | FT-034 | P0 | L | US-051 |
| [US-053](story-053-withdraw-reassign-approval.md) | Retirar ou redirecionar aprovação pendente | EP-008 | FT-034 | P1 | M | US-052 |
| [US-054](story-054-movement-history.md) | Histórico de tramitações | EP-008 | FT-035 | P0 | M | US-047 |
| [US-055](story-055-deadlines-overdue.md) | Prazos em dias úteis e detecção de atrasos | EP-008 | FT-035 | P0 | M | US-047, US-083, US-106 |
| [US-056](story-056-task-inbox.md) | Caixa de tarefas unificada | EP-009 | FT-036 | P0 | L | US-049, US-051 |
| [US-057](story-057-approvals-list.md) | Lista de aprovações | EP-009 | FT-036 | P0 | M | US-051 |
| [US-058](story-058-inbox-bulk-actions.md) | Ações em lote na caixa de tarefas | EP-009 | FT-036 | P2 | M | US-056 |
| [US-059](story-059-timeline-projection.md) | Projetar eventos do processo na timeline | EP-010 | FT-037 | P0 | M | US-082 |
| [US-060](story-060-timeline-view.md) | Visualizar timeline com filtros | EP-010 | FT-037 | P0 | M | US-059 |
| [US-061](story-061-document-types.md) | Gerenciar tipos de documento | EP-011 | FT-038 | P1 | M | US-100 |
| [US-062](story-062-process-documents-panel.md) | Painel de documentos do processo | EP-011 | FT-039 | P0 | M | US-065 |
| [US-063](story-063-free-text-documents.md) | Criar documento livre a partir de template | EP-011 | FT-039 | P1 | M | US-015, US-065 |
| [US-064](story-064-uploaded-documents.md) | Incluir documento externo (upload) com versões | EP-011 | FT-039 | P1 | M | US-065, US-068 |
| [US-065](story-065-document-lifecycle.md) | Ciclo de vida do documento | EP-011 | FT-040 | P0 | L | US-061, US-108 |
| [US-066](story-066-document-versioning.md) | Versionamento imutável e comparação de versões | EP-011 | FT-040 | P0 | M | US-065 |
| [US-067](story-067-pdf-generation.md) | Gerar PDF de documentos | EP-011 | FT-041 | P0 | L | US-066, US-083 |
| [US-068](story-068-secure-upload.md) | Upload seguro de anexos | EP-011 | FT-042 | P0 | L | US-083, US-097 |
| [US-069](story-069-attachment-download.md) | Visualizar e baixar anexos | EP-011 | FT-042 | P0 | S | US-068 |
| [US-070](story-070-editing-presence.md) | Indicador de edição concorrente | EP-011 | FT-042 | P2 | M | US-015 |
| [US-071](story-071-comments.md) | Comentar no processo e em documentos | EP-012 | FT-043 | P0 | M | US-001, US-059 |
| [US-072](story-072-mentions.md) | Mencionar usuários e unidades | EP-012 | FT-043 | P1 | M | US-071, US-111 |
| [US-073](story-073-audit-recording.md) | Registrar auditoria transacional | EP-013 | FT-044 | P0 | L | US-081, US-084 |
| [US-074](story-074-audit-seal.md) | Selagem de integridade da trilha de auditoria | EP-013 | FT-044 | P1 | M | US-073, US-083 |
| [US-075](story-075-audit-query-export.md) | Consultar e exportar a trilha de auditoria | EP-013 | FT-045 | P0 | M | US-073, US-097 |
| [US-076](story-076-operational-dashboard.md) | Dashboard operacional por perfil | EP-014 | FT-046 | P0 | L | US-002, US-055, US-056 |
| [US-077](story-077-monorepo-setup.md) | Configurar monorepo e padrões de código | EP-015 | FT-047 | P0 | M | — |
| [US-078](story-078-local-environment.md) | Ambiente local com Docker Compose | EP-015 | FT-047 | P0 | M | US-077 |
| [US-079](story-079-ci-pipeline.md) | Pipeline de CI com quality gates | EP-015 | FT-047 | P0 | M | US-077 |
| [US-080](story-080-api-foundation.md) | Esqueleto da API modular | EP-015 | FT-048 | P0 | L | US-077 |
| [US-081](story-081-persistence-prisma.md) | Persistência com Prisma e concorrência otimista | EP-015 | FT-048 | P0 | M | US-078, US-080 |
| [US-082](story-082-domain-events-outbox.md) | Eventos de domínio com outbox transacional | EP-015 | FT-048 | P0 | L | US-081 |
| [US-083](story-083-worker-queues.md) | Worker com filas, retries e dead letter | EP-015 | FT-048 | P0 | M | US-082 |
| [US-084](story-084-logging-tracing.md) | Logs estruturados, correlationId e tracing | EP-015 | FT-049 | P0 | M | US-080 |
| [US-085](story-085-health-metrics.md) | Health checks, métricas e dashboards técnicos | EP-015 | FT-049 | P1 | M | US-080, US-083 |
| [US-086](story-086-web-shell-design-system.md) | Shell da aplicação web, design system e cliente de API | EP-015 | FT-050 | P0 | L | US-077 |
| [US-087](story-087-oidc-login-bff.md) | Login OIDC com Authentik e sessão segura no BFF | EP-016 | FT-051 | P0 | L | US-078, US-080, US-086 |
| [US-088](story-088-logout-session-expiry.md) | Logout, expiração e renovação de sessão | EP-016 | FT-051 | P0 | M | US-087 |
| [US-089](story-089-password-recovery.md) | Recuperação de senha | EP-016 | FT-051 | P0 | S | US-087 |
| [US-090](story-090-mfa-policy.md) | Política de MFA por tenant com step-up | EP-016 | FT-051 | P1 | M | US-087, US-097 |
| [US-091](story-091-invite-user.md) | Convidar usuário e ativar vínculo | EP-016 | FT-052 | P0 | M | US-087, US-102, US-112 |
| [US-092](story-092-manage-users.md) | Gerenciar usuários e lotações | EP-016 | FT-052 | P0 | M | US-091 |
| [US-093](story-093-tenant-switch.md) | Selecionar órgão ativo | EP-016 | FT-052 | P1 | S | US-087 |
| [US-094](story-094-permission-catalog-default-roles.md) | Catálogo de permissões e perfis padrão | EP-016 | FT-053 | P0 | M | US-100 |
| [US-095](story-095-manage-roles.md) | Gerenciar perfis e matriz de permissões | EP-016 | FT-053 | P0 | M | US-094 |
| [US-096](story-096-assign-roles.md) | Atribuir perfis com escopo e vigência | EP-016 | FT-053 | P0 | M | US-091, US-094 |
| [US-097](story-097-authorization-enforcement.md) | Autorização na API e no frontend | EP-016 | FT-053 | P0 | L | US-094, US-096, US-100 |
| [US-098](story-098-my-profile.md) | Meu perfil e preferências | EP-016 | FT-054 | P1 | S | US-087 |
| [US-099](story-099-tenant-provisioning.md) | Provisionar tenant com dados padrão | EP-017 | FT-055 | P0 | M | US-081, US-100 |
| [US-100](story-100-tenant-isolation.md) | Contexto de tenant e isolamento de dados | EP-017 | FT-055 | P0 | L | US-080, US-081 |
| [US-101](story-101-organizations.md) | Gerenciar órgãos/entidades | EP-017 | FT-056 | P0 | S | US-100 |
| [US-102](story-102-departments.md) | Gerenciar secretarias e setores | EP-017 | FT-056 | P0 | M | US-101 |
| [US-103](story-103-tenant-settings.md) | Configurações gerais do tenant | EP-017 | FT-057 | P0 | M | US-100 |
| [US-104](story-104-catalogs.md) | Catálogos parametrizáveis | EP-017 | FT-057 | P0 | M | US-100 |
| [US-105](story-105-numbering.md) | Numeração configurável e segura sob concorrência | EP-017 | FT-057 | P0 | M | US-103 |
| [US-106](story-106-business-calendar.md) | Calendário de dias úteis e feriados | EP-017 | FT-057 | P1 | S | US-100 |
| [US-107](story-107-template-editor.md) | Criar e editar template de documento | EP-018 | FT-058 | P0 | L | US-061 |
| [US-108](story-108-template-publishing.md) | Publicar versão de template e definir padrão do tipo | EP-018 | FT-058 | P0 | M | US-107 |
| [US-109](story-109-print-layout.md) | Layout de impressão (timbre, cabeçalho, rodapé) | EP-018 | FT-058 | P1 | M | US-067, US-107 |
| [US-110](story-110-default-template-library.md) | Biblioteca de templates padrão | EP-018 | FT-058 | P0 | M | US-108 |
| [US-111](story-111-notification-center.md) | Central de notificações in-app | EP-019 | FT-059 | P0 | M | US-083, US-086 |
| [US-112](story-112-transactional-emails.md) | E-mails transacionais | EP-019 | FT-059 | P0 | M | US-078, US-083 |
| [US-113](story-113-notification-preferences.md) | Preferências de notificação | EP-019 | FT-059 | P2 | S | US-111 |
| [US-114](story-114-deadline-reminders.md) | Lembretes de prazo e alertas de atraso | EP-019 | FT-059 | P1 | M | US-055, US-111, US-112 |

Totais: 19 épicos · 59 features · 114 stories (114 escritas) · P0 84 · P1 22 · P2 8 · 615 pontos.
