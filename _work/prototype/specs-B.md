# Especificação das telas do lote B (extraída de docs/mvp-01/screens.md)

### 1.4 Padrões globais

- **Carregando:** *skeleton* por bloco/cartão/linha (nunca a tela inteira quando houver blocos independentes, ex. SCR-003, SCR-006); dados anteriores mantidos durante *refetch* (`placeholderData`/`keepPreviousData`); indicador de carregamento discreto ao refazer consultas já exibidas.
- **Vazio:** mensagem específica da lista/seção + ação primária quando o usuário tem permissão para resolver (ex. "Nenhum documento ainda — Criar DFD"); nunca um "vazio" genérico sem orientação.
- **Erro:** *toast* ou banner com `correlationId` copiável e botão "Tentar novamente"; blocos/cartões falham de forma independente (um erro não derruba a tela, ex. SCR-003, SCR-006); nenhum código técnico é exposto ao usuário além do `correlationId` (RN-FND-95).
- **Sem permissão:** `<Can permission="...">` **oculta** a ação quando ela nunca seria possível para o vínculo e **desabilita com explicação** (`aria-describedby`/tooltip) quando a indisponibilidade é contextual — origem em `meta.allowedActions`/`GET .../available-actions` (PRC-08), nunca reimplementada no cliente (RN-FND-92).
- **403/404/500/manutenção/sessão expirada/sem vínculo:** tratados em `SCR-111` (`/erro/*`) e nos limites globais de erro (`error.tsx`/`global-error.tsx`, US-086); interceptador do cliente de API mapeia 401 `SESSION_EXPIRED` → `SessionExpiredModal`, 403 `MEMBERSHIP_INACTIVE`/`TENANT_SUSPENDED` → `SCR-111` com "Trocar de instituição" quando há outros vínculos, 503 → banner de indisponibilidade com "Tentar novamente" (US-088, US-100).
- **Toasts:** componente genérico de `packages/ui`; sucesso, erro (com `correlationId`) e progresso (ex. exportações) seguem o mesmo padrão visual e temporizador.
- **Diálogos de confirmação:** `ConfirmDialog` com foco preso (*focus trap*), foco inicial no campo mais relevante (motivo/justificativa quando existir) e devolução de foco ao elemento que abriu o diálogo ao fechar; ações destrutivas/irreversíveis exigem justificativa com contador de caracteres (ex. cancelar processo ≥ 20 caracteres — POL-06).
- **Conflito de edição (412):** toda mutação de atualização envia `If-Match` com o `ETag` recebido em `meta.etag` (RN-FND-90); divergência retorna **412** e abre `ConflictDialog`/`SectionConflictDialog`/`HeaderConflictDialog` comparando campo a campo (ou parágrafo a parágrafo em texto rico) o valor local com `meta.current`.
- **Sessão expirada:** `SessionWatcher` monitora ociosidade e expiração via `BroadcastChannel('cf-session')`; `IdleWarningDialog` ("Você continua aí?") com contagem regressiva antes do término; `SessionExpiredModal` bloqueante ao expirar; `LogoutGuard` confirma perda de rascunhos não salvos ao sair (US-088).
- **Orçamento sigiloso (POL-09):** quando `isBudgetConfidential = true`, o valor estimado só é exibido a quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo **ou** detém a custódia atual; para os demais, a API retorna o valor mascarado (`null` + `masked: true`, via `ConfidentialFieldsInterceptor`) em toda superfície — telas, PDFs/*renditions*, exportações, timeline (`BUDGET_RESTRICTED`) e notificações. O selo "Sigiloso"/cadeado nunca é a única informação (texto sempre presente) e aparece onde quer que o valor apareça mascarado.
- **Acessibilidade:** WCAG 2.1 AA + eMAG 3.1 (DEC-183) em toda tela — *primitives* Radix (foco, teclado, ARIA), *skip link* no `AppShell`, foco gerenciado após navegação e em diálogos, erros de formulário associados por `aria-describedby`, regiões `aria-live` para autosave/validação/*toasts*, contraste ≥ 4,5:1, alvo de toque ≥ 24 px (RN-FND-96) — várias telas voltadas a uso móvel intensivo adotam ≥ 44 px (ex. SCR-004, SCR-115). Nenhum estado é comunicado só por cor (ícone + texto). `axe-core` roda no Storybook e como *gate* de CI.
- **Responsividade:** breakpoint de referência 768 px. Editores de documento estruturado (SCR-007, SCR-008, SCR-012) são *desktop-first* (DEC-183): abaixo de 768 px entram em modo leitura + comentários, com aviso discreto sugerindo o desktop para edição de texto rico. Telas operacionais (SCR-003, SCR-004, SCR-006, SCR-009 leitura, SCR-011, SCR-013, SCR-014, SCR-015) permanecem plenamente utilizáveis a partir de 360 px, normalmente convertendo tabelas em listas de cartões.
- **Componentes transversais (nomes unificados na consolidação):** `ConfidentialValue` exibe valor de orçamento mascarado (POL-09, `…Masked`); `ConfidentialBadge` sinaliza processo sigiloso; `EstimatedValueBadge` (US-017) compõe valor + origem usando `ConfidentialValue`; `DueDateBadge` indica prazo com os estados normal/a vencer/atrasado/suspenso/sem prazo (US-055).

### SCR-007 — DFD (wizard/editor)
- **Rota:** `/processos/[id]/dfd/[dfdId]?passo=identificacao|justificativa|planejamento|revisao|conclusao` · **Acesso:** `PROCESS_VIEW` para abrir; `DFD_CREATE` para criar/duplicar; `DFD_UPDATE` + POL-02 para editar seções/itens · **Personas:** requisitante/gestor com custódia do processo; participante `COLLABORATOR`/`CONSULTANT` enquanto o DFD estiver em `DRAFT`/`RETURNED`.
- **Objetivo:** elaborar o Documento de Formalização de Demanda a partir de template, com autosave, retomada e conclusão/envio para aprovação.
- **Layout e regiões:** `DfdWizard` (`Stepper` de 5 passos) com indicador de autosave fixo no cabeçalho.
- **Componentes:** `DfdIdentificationStep` (`DatePicker`, `DepartmentTreeSelect`, `UserLookup`, `PrioritySelect`), `DfdJustificationStep` (`SectionEditor` de `packages/editor`, `SectionHelp`, `LegalBasisTooltip`, `AttachmentUploader`), `DfdPlanningStep` (`DocumentItemsGrid`, `InlineProcessItemDialog`, `QuantityInput`, `MoneyInput`, `PcaFieldset`), `DfdReviewStep` (`CompletenessChecklist`, `ReadOnlySummary`, `PdfPreviewDialog`), `DfdConclusionStep` (+ `ReadyToSendCard`, `WarningsAcknowledgement`, `ForwardPanel` preset, `VersionPdfButton`, `InApprovalBadge` — US-016), `TemplatePickerDialog`; transversais: `useAutosave`/`AutosaveIndicator`/`ConflictDialog`/`HeaderConflictDialog`/`RecoveredDraftBanner` (US-015), `DecisionBanner`/`CancelSuggestionCallout` (US-017), `CommentsPanel` lateral (US-071/072).
- **Dados e endpoints:** DFD-01 (lista), DFD-02 (criar, Idem.), DFD-03 (detalhe), DFD-04 (PATCH cabeçalho, IM), DFD-05 (duplicar); DOC-05 (seções, IM de seção), DOC-06/07 (itens), DOC-08 (`validation`, invalidada com *debounce* 2 s); chaves `['t', tenantId, 'dfds', dfdId]`, `['t', tenantId, 'documents', documentId]`, `['...,'items']`, `['...,'validation']`, `['t', tenantId, 'processes', processId, 'items']`.
- **Ações:** Salvar seção → DOC-05 (*debounce* 1.500 ms) → POL-02 → `AutosaveIndicator` "Salvo às HH:mm"; Concluir e enviar para aprovação → PRC-19 `forward` (IM, Idem.) → POL-01 → submete o DFD automaticamente (DEC-018) → redireciona com `InApprovalBadge` em SCR-006; Duplicar → DFD-05 (Idem.) → `DFD_CREATE` (+`PROCESS_CREATE` se novo processo).
- **Estados:** *skeleton* por passo; vazio de itens; erro de carregamento com "Tentar novamente"; modo leitura com faixa de status; checklist "Sem pendências"; conflito de edição (412, `ConflictDialog`/`SectionDiffView`); recuperação de rascunho local após reconexão.
- **Validações e mensagens:** pendências anunciadas em `aria-live="polite"`; "Ir para o campo" move o foco e descreve o erro; aviso de decisão (aprovado/devolvido/indeferido) com motivo via `DecisionBanner`.
- **Acessibilidade e responsividade:** *stepper* com `aria-current="step"`; foco no título do passo a cada troca; indicador de autosave em `aria-live="polite"`; *desktop-first* (DEC-183) — abaixo de 768 px, passos em coluna única, tabela de itens em cartões, edição de texto rico com aviso para uso no desktop.
- **Stories:** US-014 (principal), US-015, US-016, US-017, US-018; US-071/US-072 (comentários/menções); US-068 (anexos).

### SCR-013 — Caixa de tarefas
- **Rota:** `/tarefas` · **Acesso:** `INBOX_VIEW`; ações em lote exigem `PROCESS_CLAIM`/`PROCESS_ASSIGN` por item · **Personas:** qualquer servidor lotado em unidade com fila; titular/substituto de unidade (atribuição em lote).
- **Objetivo:** reunir, por abas, os processos sob responsabilidade, na fila da unidade e aprovações pendentes do usuário, com ações rápidas de assumir/atribuir.
- **Layout e regiões:** `InboxTabs` com contadores; `InboxTable`/lista por aba; barra de ações em lote (visão "Na fila da minha unidade").
- **Componentes:** `InboxTabs`, `InboxTable`, `QuickClaimButton`, `OverdueBadge`, `DueDateBadge` (US-055), `EmptyState` por visão; `BulkActionBar` ("{N} selecionados"), `BulkResultSummary`, `AssigneeSelect` (US-058).
- **Dados e endpoints:** TSK-01 `GET /tasks`, TSK-02 `GET /tasks/counters`; TSK-03 `POST /tasks/bulk-claim` (Idem., lote de 1 a 50), TSK-04 `POST /tasks/bulk-assign` (Idem., lote de 1 a 50).
- **Ações:** Assumir (linha única) → PRC-21 ou TSK-03 → `PROCESS_CLAIM` + POL-04 → toast de sucesso; Atribuir em lote → SCR-115 (variante múltipla) → TSK-04 → `PROCESS_ASSIGN`/titular → resumo por item.
- **Estados:** *skeleton* nas abas/tabela; vazio por visão; erro com "Tentar novamente"; linha em "assumindo…" durante a chamada; barra de ações oculta sem seleção, botões desabilitados durante o processamento ("Processando {N} processos…").
- **Validações e mensagens:** erro inline se outro usuário já assumiu o processo; resumo de lote com lista expansível de erros.
- **Acessibilidade e responsividade:** abas com `role="tablist"`; contadores lidos ao trocar de aba; seleção por teclado (`aria-label` por linha); resumo de resultado via `aria-live`; tabela em cartões abaixo de 768 px; barra de ações fixa no rodapé em telas pequenas.
- **Stories:** US-056 (principal), US-058; US-055 (badges), US-050 (atribuição individual).

### SCR-014 — Aprovações
- **Rota:** `/aprovacoes` · **Acesso:** `APPROVAL_VIEW` (ou designado) · **Personas:** aprovador designado (usuário, perfil ou titular de unidade — POL-03).
- **Objetivo:** listar as aprovações sob responsabilidade do usuário, com filtros e atalho para a decisão.
- **Layout e regiões:** barra de filtros + tabela/lista.
- **Componentes:** `ApprovalFilters` (status, tipo, unidade, período, busca), `ApprovalTable`, `OverdueBadge`, `EmptyState`.
- **Dados e endpoints:** APV-01 `GET /approvals`.
- **Ações:** Abrir aprovação → navega para SCR-015.
- **Estados:** *skeleton*; vazio (geral e "sem resultado para os filtros"); erro com "Tentar novamente".
- **Validações e mensagens:** nenhuma nesta tela (decisão ocorre em SCR-015).
- **Acessibilidade e responsividade:** filtros com rótulos associados, navegáveis por teclado; tabela em cartões abaixo de 768 px; contraste AA.
- **Stories:** US-057.

### SCR-015 — Detalhe da aprovação
- **Rota:** `/aprovacoes/[id]` (também consumida em painel lateral a partir de SCR-006) · **Acesso:** `APPROVAL_VIEW`/designado para visualizar; decidir `APPROVAL_DECIDE` + POL-03; retirar `PROCESS_FORWARD` + POL-17; redirecionar `APPROVAL_REASSIGN` · **Personas:** aprovador designado; solicitante original (retirada); titular/substituto de unidade.
- **Objetivo:** decidir (aprovar, devolver, indeferir), retirar ou redirecionar uma solicitação de aprovação, com evidência dos documentos cobertos.
- **Layout e regiões:** painel de decisão com três ações principais; lista de documentos cobertos; trilha de auditoria da aprovação.
- **Componentes:** `ApprovalDecisionPanel`, `CommentField` (obrigatório condicional), `WarningsChecklist`, `DocumentCoverageList`, `ApprovalStatusBadge`; `WithdrawApprovalDialog`, `ReassignApprovalDialog`, `ApprovalAuditTrail` (US-053).
- **Dados e endpoints:** APV-02 (detalhe) — chave `['t', tenantId, 'approvals', id]`; APV-03 `decide` (IM, Idem.); APV-04 `withdraw` (IM); APV-05 `reassign` (IM) — sucesso invalida `['t', tenantId, 'approvals']`, `['t', tenantId, 'processes', processId]`, `['t', tenantId, 'tasks']`.
- **Ações:** Aprovar/Devolver/Indeferir → APV-03 (IM, Idem.) → POL-03 (designação + `preventSelfApproval`) → avança/retorna a etapa, atualiza documento; Retirar → APV-04 (IM) → POL-17; Redirecionar → APV-05 (IM) → `APPROVAL_REASSIGN` (busca assíncrona de elegíveis, com motivo obrigatório).
- **Estados:** *skeleton* no carregamento; aviso quando `allowDeputy`; botão desabilitado durante o envio; mensagem clara e recarga automática quando a aprovação já foi decidida por outra pessoa.
- **Validações e mensagens:** comentário obrigatório conforme o tipo de decisão; motivo obrigatório no redirecionamento.
- **Acessibilidade e responsividade:** botões de decisão com rótulo e `aria-pressed`; diálogos com foco inicial no campo de motivo e resultado anunciado via `aria-live`; layout de coluna única e botões grandes abaixo de 768 px (uso móvel é requisito).
- **Stories:** US-052 (principal), US-053.

### SCR-009 — Pesquisa de preços
- **Rota:** `/processos/[id]/pesquisa-precos/[researchId]` (abas Itens, Fontes, Cotações/grade, Mapa → SCR-010, Documento) · **Acesso:** `PROCESS_VIEW`; criar `PRICE_RESEARCH_CREATE`; editar `PRICE_RESEARCH_UPDATE` + POL-02; excluir cotação `PRICE_RESEARCH_EXCLUDE_QUOTATION`; concluir `PRICE_RESEARCH_COMPLETE` · **Personas:** requisitante/gestor com custódia; consulta a `SUPPLIER_VIEW`/`SUPPLIER_MANAGE` para fornecedores.
- **Objetivo:** registrar fontes e cotações, calcular estatísticas e valor estimado por item, sinalizar alertas/outliers e concluir a pesquisa.
- **Layout e regiões:** diálogo de criação (a partir de SCR-006); abas Itens/Fontes/Cotações/Mapa/Documento.
- **Componentes:** `CreatePriceResearchDialog`, `DatePicker` (data-base), `ParametersPanel`, `PriceItemsTable`, `MissingItemsBanner`, `DocumentStatusBadge`, `MaskedValue` (US-024); `PriceSourceList`, `PriceSourceForm` (campos condicionais por `requiredFields`), `SupplierCombobox`, `AttachmentUploader`, `QuotationGrid` (US-026); `ExcludeQuotationDialog` + botão "Restaurar" inline (US-027); `ImportQuotationsDialog`, `ImportPreviewTable` (US-028); `PriceItemStatsCard`, `MethodSelect`, `ManualPriceFieldset`, `RecalculateButton` (US-029); `AlertBadgeList`, `OutlierBadge`/`ExpiredBadge` (US-030); `CompleteResearchDialog`, `IncompleteItemsList`, `CompletedBadge` (US-032); seções `METHODOLOGY`/`CONCLUSION` do documento (autosave DOC-05).
- **Dados e endpoints:** PRS-01 (lista), PRS-02 (criar, Idem.), PRS-03 (detalhe, +POL-09), PRS-04 (PATCH, IM), PRS-05..08 (itens), PRS-09..17 (fontes/cotações/exclusão), PRS-18/19/24 (importação por planilha), PRS-20 (recalcular), PRS-23 (concluir, IM, Idem.); SUP-01..06; chave `['t', tenantId, 'price-research', researchId]`.
- **Ações:** Registrar fonte/cotação → PRS-10/PRS-13 (Idem./IM) → POL-02 → `PriceResearchRecalculated`; Desconsiderar/restaurar cotação → PRS-16/17 (IM) → justificativa obrigatória → recálculo automático; Importar planilha → PRS-18 (prévia) → PRS-19 (Idem.) → grade atualizada; Concluir → PRS-23 (IM, Idem.) → `PRICE_RESEARCH_COMPLETE` + POL-02 → selo "Concluída" + valor atualizado.
- **Estados:** *skeleton*; vazio ("Nenhuma fonte registrada ainda", "Sem cotações válidas", "Sem alertas"); erro com "Tentar novamente"/`correlationId`; célula `EXCLUDED` em somente leitura com tooltip do motivo; somente leitura quando o documento não é editável.
- **Validações e mensagens:** exclusão de cotação exige motivo + justificativa; conclusão lista itens pendentes/`violations[]` antes de confirmar.
- **Acessibilidade e responsividade:** tabela de itens com `caption` e seleção por teclado; grade de cotações navegável por setas, coluna "Item" fixa em rolagem horizontal; valores recalculados anunciados via `aria-live="polite"`; edição *desktop-first* (DEC-183), leitura em mobile com cartões por item.
- **Stories:** US-024 (principal), US-026, US-027, US-028, US-029, US-030, US-032; US-025 (fornecedores, consumida via `SupplierCombobox`).

### SCR-010 — Mapa comparativo
- **Rota:** `/processos/[id]/pesquisa-precos/[researchId]/mapa` · **Acesso:** `PROCESS_VIEW` (+ POL-09) · **Personas:** mesmas de SCR-009, em modo leitura/exportação.
- **Objetivo:** visualizar e exportar o quadro comparativo de preços por fonte e por item.
- **Layout e regiões:** matriz com cabeçalho de fonte fixo e rolagem sincronizada; menu de exportação.
- **Componentes:** `ComparativeMapGrid`, `MapCellPrice` (valor + selos de US-030), `ExportMenu` (XLSX/PDF), `RenditionStatusPoller`.
- **Dados e endpoints:** PRS-21 (`comparative-map`, +POL-09), PRS-22 (export XLSX); exportação em PDF = renderização do documento `PRICE_RESEARCH` via DOC-20/21/22/23 (seção `PRICE_SUMMARY` do template).
- **Ações:** Exportar XLSX → PRS-22 → `PROCESS_VIEW` + POL-09 → download direto; Exportar PDF → DOC-20/21 → *polling* DOC-22 até `READY`/`FAILED` → DOC-23 (link de download).
- **Estados:** *skeleton* da matriz; vazio (sem fontes); erro com `correlationId`; exportando (spinner no botão; *polling* para PDF).
- **Validações e mensagens:** nenhuma entrada de dados nesta tela.
- **Acessibilidade e responsividade:** matriz navegável por teclado (setas entre células); selos com texto alternativo; em telas estreitas, rolagem horizontal com cabeçalho de item fixo.
- **Stories:** US-031 (principal), US-030 (selos reaproveitados).
