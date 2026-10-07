# Especificação das telas do lote A (extraída de docs/mvp-01/screens.md)

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

### SCR-001 — Login (entrada)
- **Rota:** `/entrar` (inicia o fluxo OIDC do Authentik) · **Acesso:** público, não autenticado · **Personas:** qualquer usuário com vínculo ativo em pelo menos um tenant; usuário sem nenhum vínculo (mensagem dedicada)
- **Objetivo:** iniciar a autenticação e comunicar o motivo de retorno quando o usuário chega vindo de um logout, expiração de sessão ou bloqueio.
- **Layout e regiões:** `LoginCard` central (marca, título, botão principal); `LoginReasonMessage` acima do botão quando há motivo na URL; `PrivacyNotice` e `HelpLink` no rodapé.
- **Componentes:** `LoginCard`, `LoginReasonMessage`, `PrivacyNotice`, `HelpLink`, `InstitutionList` (ponte para SCR-101), `NoMembershipPage`.
- **Dados e endpoints:** rotas do BFF (fora da API NestJS): `GET /api/auth/login`, `GET /api/auth/callback`, `GET /api/auth/session`.
- **Ações:** Entrar → `GET /api/auth/login` → redireciona ao Authentik → callback resolve sessão → SCR-003 (1 vínculo) ou SCR-101 (2+ vínculos); "Esqueci minha senha" → SCR-002.
- **Estados:** sem *skeleton* (página estática); motivos (`saiu`, `saiu-parcial`, `sessao-expirada`, sem vínculo) em `role="status"`; erro com `correlationId` copiável; `NoMembershipPage` quando não há vínculo algum.
- **Validações e mensagens:** motivo vem só por querystring controlada pelo próprio app/BFF; nenhum código técnico exposto ao usuário além do `correlationId`.
- **Acessibilidade e responsividade:** foco inicial no título; botão alcançável por teclado; contraste AA; `lang="pt-BR"`; coluna única a partir de 360 px; páginas do Authentik usam o mesmo tema e são testadas com axe.
- **Stories:** US-087 (principal), US-089 (link), US-088 (mensagens de saída/expiração), US-090 (step-up reaproveita o componente de erro).

### SCR-101 — Seleção de órgão
- **Rota:** `/selecionar-orgao` (e seletor global no cabeçalho) · **Acesso:** capacidade implícita (qualquer vínculo ativo) · **Personas:** usuário com vínculo em 2+ tenants/órgãos.
- **Objetivo:** escolher o órgão/tenant ativo para a sessão, no primeiro acesso ou a qualquer momento pelo cabeçalho.
- **Layout e regiões:** lista de instituições; no cabeçalho, menu compacto equivalente.
- **Componentes:** `InstitutionList` (login, US-087), `TenantSwitcherMenu`, `TenantList` (US-093).
- **Dados e endpoints:** ME-04 `GET /me/memberships`; ORG-01 `GET /organizations`; troca efetivada pelo BFF `POST /api/auth/switch-tenant`.
- **Ações:** Selecionar instituição → `switch-tenant` → — → `queryClient.clear()` + `BroadcastChannel('cf-session')` (RN-FND-90/RN-TEN-35) → navega a SCR-003 com toast "Agora você está em {tenant}".
- **Estados:** *loading* no botão durante a troca; erro inline se falhar; (no primeiro acesso, via login, a lista aparece sem a moldura do cabeçalho — US-087 completada pela US-093).
- **Validações e mensagens:** nenhuma; lista restrita a vínculos ativos.
- **Acessibilidade e responsividade:** itens focáveis por teclado; layout de coluna única em telas pequenas.
- **Stories:** US-093 (principal), US-087 (entrada no login), US-099/US-100 (destino de "Trocar de instituição" a partir de SCR-111).

### SCR-003 — Dashboard
- **Rota:** `/painel` · **Acesso:** `DASHBOARD_VIEW` · **Personas:** qualquer perfil com acesso ao painel — dados restritos à visibilidade de processos de cada um (§5 de `permissions.md`).
- **Objetivo:** visão operacional por perfil, com indicadores e atalhos para as filas de trabalho.
- **Layout e regiões:** `DashboardSummaryCards` no topo; grade de `DashboardWidgetCard` (1 a 3 colunas); `RecentActivityFeed`; `DepartmentFilterBar`.
- **Componentes:** `DashboardSummaryCards`, `DashboardWidgetCard` (loading/erro independentes por cartão), gráficos de barra/linha de `packages/ui`, `RecentActivityFeed`, `DepartmentFilterBar`.
- **Dados e endpoints:** DSH-01 `GET /dashboard/summary`, DSH-02 `GET /dashboard/widgets/{widgetKey}` — chaves `['t', tenantId, 'dashboard', 'summary', filters]` e `['t', tenantId, 'dashboard', 'widget', widgetKey, filters]`, `refetchInterval: 60000`.
- **Ações:** Filtrar por secretaria/unidade → atualiza a URL e refaz as consultas → cartões recarregam individualmente; "Tentar novamente" por cartão → refetch isolado do widget.
- **Estados:** *skeleton* por cartão; vazio contextual por widget ("Nenhuma atividade recente."); erro por cartão com "Tentar novamente"; filtros refletidos na *query string* (permite compartilhar/recarregar a visão).
- **Validações e mensagens:** agregados somam só valores visíveis ao usuário (POL-09); grupo com exclusões sinaliza `confidentialExcluded: true`.
- **Acessibilidade e responsividade:** paleta com contraste AA e redundância padrão/ícone (RN-DASH-12); dados de gráfico também em tabela (alternância); `aria-live` nos cartões ao atualizar via *polling* sem roubar o foco; grade de 1 coluna (< 768 px) a 3 colunas.
- **Stories:** US-076.

### SCR-005 — Novo processo (wizard)
- **Rota:** `/processos/novo` · **Acesso:** `PROCESS_CREATE` · **Personas:** servidor autorizado a criar processo para a unidade solicitante escolhida.
- **Objetivo:** coletar os dados mínimos para abrir um processo de contratação e redirecionar ao painel do processo criado.
- **Layout e regiões:** `Stepper` (3 passos) com formulário único por passo, seção colapsável "Mais informações", resumo final.
- **Componentes:** `Stepper`, formulário único (React Hook Form + `zodResolver(createProcessSchema)`, validação por passo via `trigger`), `CatalogSelect`, `OrganizationSelect`, `DepartmentTreeSelect`, `PrioritySelect`, `DatePicker`, `MoneyInput` (BRL, string decimal), `PcaFieldset`, `DuplicateWarningPanel`, `WorkflowPreviewCard`, `ReviewSummary`, `CollapsibleSection`.
- **Dados e endpoints:** `['t', tenantId, 'catalogs', type]` (`staleTime` 10 min), `['t', tenantId, 'departments', orgId]`; PRC-03 `POST /processes/check-duplicates`; PRC-02 `POST /processes` (Idem., `Idempotency-Key` única por sessão do wizard) — sucesso invalida `['t', tenantId, 'processes']`, `['t', tenantId, 'tasks']`, `['t', tenantId, 'dashboard']`.
- **Ações:** Avançar passo → `trigger()` local → — → foco no título do próximo passo; Criar processo → PRC-02 → `PROCESS_CREATE` → redireciona para SCR-006 do processo criado.
- **Estados:** *skeleton* nos *selects*; vazio se não houver tipo de contratação ativo ("Fale com o administrador."); erro de carregamento com "Tentar novamente"; botão principal com carregamento; aviso de rascunho recuperado.
- **Validações e mensagens:** validação por passo antes de avançar; aviso de possíveis duplicados (PRC-03) antes de confirmar.
- **Acessibilidade e responsividade:** foco no título do passo a cada troca; erros via `aria-live`; *stepper* navegável por teclado; abaixo de 768 px o *stepper* vira "Passo 2 de 3", campos em coluna única, botões fixos no rodapé.
- **Stories:** US-001 (principal). Serve também de destino para US-018 (duplicar DFD para "novo processo", via `DuplicateTargetPicker` em SCR-113).

### SCR-006 — Detalhe do processo
- **Rota:** `/processos/[id]?aba=resumo|documentos|itens|tramitacao|timeline|comentarios|participantes` · **Acesso:** `PROCESS_VIEW` para abrir; ações do painel exigem, cada uma, sua permissão (`PROCESS_UPDATE`, `PROCESS_FORWARD`, `PROCESS_RETURN`, `PROCESS_CLAIM`, `PROCESS_ASSIGN`, `PROCESS_SUSPEND`, `PROCESS_CANCEL`, `PROCESS_COMPLETE`, `PROCESS_DUPLICATE`, `PROCESS_MANAGE_PARTICIPANTS`, `PROCESS_FOLLOW`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`/`PROCESS_SET_CONFIDENTIAL_BUDGET`, `TAG_MANAGE`, `COMMENT_CREATE`/`COMMENT_MODERATE`, `ATTACHMENT_UPLOAD`/`ATTACHMENT_DELETE`) + POL-01 (custódia) na maioria das escritas · **Personas:** requisitante/gestor com custódia; participante (observador/colaborador/consultor); aprovador designado; titular/substituto da unidade atual.
- **Objetivo:** painel situacional único do processo — onde está, quem é responsável, o que falta, quando vence — mais acesso a documentos, itens, tramitação, timeline, comentários e participantes.
- **Layout e regiões:** `ProcessHeader` + `ProcessActionBar` no topo; `StageStepper` (horizontal desktop / vertical mobile); `SituationalPanel` com cartões; `ProcessTabs` roláveis com carregamento sob demanda.
- **Componentes:** `ProcessHeader` (código, título, `StatusBadge`, `PriorityBadge`, `TagChips`, `ConfidentialBadge`/`ConfidentialValue`), `ProcessActionBar` (`PrimaryActionButton` desabilitado com motivo, `MoreActionsMenu`, `FollowToggle` — US-012 descreve o mesmo botão como parte do cabeçalho do painel situacional, DEC-180), `WhereCard`, `ResponsibleCard`, `PendingCard` (+ `ChecklistDrawer`), `NextStepCard`, `DeadlinesCard` (`DueDateBadge` + prazo alvo), `DocumentsCard`, `PendingApprovalsCard`; abas: Resumo, **Documentos** (`DocumentsPanel`, `DocumentTypeCard`, `PendingApprovalBadge`, `CreateDocumentMenu` — US-062), **Itens** (`ProcessItemsTab`, `ProcessItemForm`, `SortableItemsList`, `RenumberBanner` — US-006), **Tramitação** (`MovementTimeline`, `MovementFilterBar` — US-054), **Timeline** (`TimelineFeed`, `TimelineFilterBar`, `TimelineDayGroup` — US-060; eventos projetados por US-059, sem UI própria), **Comentários** (`CommentsPanel`, `CommentThread`, `CommentComposer`, `ModerationDialog`, `MentionAutocomplete` — US-071/US-072), **Participantes** (`ParticipantsList`, `AddParticipantDialog`, `FollowToggleButton`, `ConfirmRemoveDialog` — US-012; US-012 rotula esta aba como "SCR-112", mas o inventário a mantém como aba desta tela). Também embutidos: `ConfidentialBudgetToggle`/`ConfirmConfidentialityDialog` (US-013, em "Mais informações"), `AttachmentUploader`/`AttachmentList`/`DeleteAttachmentDialog` (US-068/US-069), `AvailableActionsPanel`/`ActionButton`/`StageChecklist` (US-041), `EditProcessSheet` (US-005, com `LockedField`, `EstimatedValueField`, `ConflictDialog`, `UnsavedChangesGuard`), `DecisionBanner`/`CancelSuggestionCallout` (US-017).
- **Dados e endpoints:** PRC-04 (detalhe), PRC-07 (resumo), PRC-08 (`available-actions`), PRC-09 (`checklist`), PRC-10 (`stages`), PRC-11 (`movements`), PRC-12 (`timeline`), PRC-13 (`items`), DOC-01 (`documents`) — chaves `['t', tenantId, 'processes', id, 'detail'|'summary'|'actions'|'stages'|'checklist']`, `refetchOnWindowFocus` + `refetchInterval` 60 s com aba visível; `['t', tenantId, 'processes', id, 'movements', filters]` (*infinite query*, cursor, `staleTime` 30 s); `['t', tenantId, 'process', id, 'comments', filtros]` (*infinite query*); CMT-01/02/03/04/05; ATT-01..06.
- **Ações:** Editar dados → PRC-05 (IM) → POL-01 → painel atualiza; Encaminhar → SCR-103 → PRC-19 (IM, Idem.) → POL-01 → novo responsável/etapa; Devolver → SCR-104 → PRC-20 (IM, Idem.) → POL-01; Assumir/Atribuir → SCR-115 → PRC-21/PRC-22; Suspender/Retomar/Cancelar/Concluir → SCR-116 → PRC-23/24/25/26; Duplicar → SCR-113 → PRC-27; Seguir/Deixar de seguir → PRC-31/32 → `PROCESS_FOLLOW`; Definir sigilo → PRC-33 → `PROCESS_SET_CONFIDENTIAL_BUDGET`; Adicionar/remover participante → PRC-29/30 → POL-10; Descartar rascunho → PRC-06.
- **Estados:** *skeleton* por bloco (painel aparece progressivamente); vazio por bloco ("Nenhum documento ainda — Criar DFD", "Nenhuma aprovação pendente"); erro por bloco com "Tentar novamente" sem derrubar a tela; modo leitura para processos em status final; sigiloso (POL-09, valor mascarado) e conflito de concorrência (412) na edição de dados.
- **Validações e mensagens:** ação primária desabilitada traz o motivo (`reasons[]`); banner de decisão do DFD/documento anunciado via `aria-live`; aviso de perda de custódia ao editar.
- **Acessibilidade e responsividade:** cada bloco é uma seção com `h2`; ação primária com `aria-describedby` quando desabilitada; *stepper* como lista ordenada com `aria-current="step"`; leitura plena em 360 px (DEC-183); abas roláveis horizontalmente; abaixo de 768 px a aba Participantes move para o menu "Mais".
- **Stories:** US-004 (principal), US-005, US-006, US-054, US-060, US-062, US-071 (abas/painel); US-007, US-008, US-009, US-010, US-011, US-012, US-013, US-017, US-036 (entrada do TR), US-041, US-047 (entrada), US-048 (entrada), US-049/US-050 (entrada), US-051 (selo), US-052/US-053 (painel lateral), US-055, US-059, US-065, US-068, US-069, US-072.

### SCR-103 — Encaminhar processo (painel lateral)
- **Rota:** painel lateral (Sheet) sobre SCR-006 · **Acesso:** `PROCESS_FORWARD` + POL-01 (custódia) · **Personas:** requisitante/gestor com custódia atual do processo.
- **Objetivo:** escolher a transição de etapa, destino, responsável e prazo, verificar pendências e confirmar o encaminhamento (que pode submeter documentos para aprovação).
- **Layout e regiões:** painel lateral de tela inteira no mobile; resumo final antes de confirmar.
- **Componentes:** `ForwardPanel` (Sheet), `TransitionRadioGroup`, `DestinationDepartmentField` (`DepartmentTreeSelect`), `AssigneeLookup`, `DueDateField` (prévia via PRC-08, recálculo por CAL-06) + `OverrideDueDateField` (US-055), `CommentField`, `DocumentsChecklist` (selo "Em aprovação"), `RuleViolationsList`, `WarningsAcknowledgement`, `ForwardSummary`.
- **Dados e endpoints:** `['t', tenantId, 'process', id, 'available-actions']` (PRC-08), `[...,'checklist']` (PRC-09), `[...,'documents']` (DOC-01); PRC-19 `POST /processes/{id}/forward` (IM, Idem.) → `ProcessStageChanged`, `ProcessStatusChanged`, `ProcessAssigned`, `ProcessNumberAssigned`, `DocumentSubmitted`, `DocumentVersionCreated`, `ApprovalRequested`.
- **Ações:** Encaminhar → PRC-19 → POL-01 → invalida `process`, `summary`, `movements`, `timeline`, `tasks`, `dashboard` → fecha o painel e atualiza SCR-006.
- **Estados:** *skeleton*; sem transições disponíveis ("Não há encaminhamentos disponíveis nesta etapa"); erro de carga com "Tentar novamente"; botão com carregamento; avisos de conflito/regra violada.
- **Validações e mensagens:** violações bloqueantes impedem confirmar; avisos exigem reconhecimento explícito (`WarningsAcknowledgement`); erro `APPROVER_UNRESOLVED` quando a resolução do aprovador falha (US-051).
- **Acessibilidade e responsividade:** foco preso no painel, devolvido ao botão de origem ao fechar; violações via `aria-live`; `Esc` com confirmação se houver dados; abaixo de 768 px ocupa a tela inteira com ações fixas no rodapé.
- **Stories:** US-047 (principal), US-016 (preset de conclusão do DFD), US-055 (campo de prazo), US-051 (erro de aprovador).

### SCR-104 — Devolver processo (diálogo)
- **Rota:** diálogo sobre SCR-006 · **Acesso:** `PROCESS_RETURN` + POL-01 · **Personas:** requisitante/gestor com custódia (inclui custódia da etapa de aprovação, quando em `AWAITING_APPROVAL`).
- **Objetivo:** devolver o processo a uma etapa já percorrida, com motivo e, quando aplicável, novo prazo.
- **Layout e regiões:** diálogo simples (tela cheia no mobile).
- **Componentes:** `StageTargetSelect` (etapas já percorridas), `TextareaField` (motivo, contador de caracteres), `DatePicker` condicional (prazo), `ConfirmButton`.
- **Dados e endpoints:** PRC-20 `POST /processes/{id}/return` (IM, Idem.) → `ProcessStageChanged`, `ProcessStatusChanged`, `ProcessAssigned`.
- **Ações:** Devolver → PRC-20 → POL-01 → fecha o diálogo e atualiza o painel de SCR-006.
- **Estados:** *skeleton* ao carregar destinos possíveis; vazio defensivo ("Nenhuma etapa anterior disponível para devolução"); erro de carregamento com "Tentar novamente"; sucesso fecha o diálogo.
- **Validações e mensagens:** motivo obrigatório; erros anunciados via `aria-live`.
- **Acessibilidade e responsividade:** foco inicial no seletor de etapa; diálogo em tela cheia abaixo de 768 px.
- **Stories:** US-048.

### SCR-115 — Atribuir responsável / assumir (diálogo)
- **Rota:** diálogo sobre SCR-006 e SCR-013 · **Acesso:** assumir = `PROCESS_CLAIM` + POL-04; atribuir/reatribuir = `PROCESS_ASSIGN` ou titular/substituto da unidade + POL-05 · **Personas:** servidor lotado na unidade atual (assumir); titular/substituto ou perfil com `PROCESS_ASSIGN` (atribuir).
- **Objetivo:** assumir um processo sem responsável, ou atribuir/reatribuir o responsável — individualmente ou em lote.
- **Layout e regiões:** esta tela agrega **duas interações distintas**: Assumir é uma ação direta (sem diálogo de confirmação — US-049, por ser reversível e sem efeito colateral sensível); Atribuir/Reatribuir é um diálogo (US-050), com variante para múltiplos processos a partir de SCR-013 (US-058).
- **Componentes:** `ClaimButton` (estado de carregamento, desaparece após sucesso — assumir); `DepartmentMemberSelect` (membros da unidade atual + "Deixar na fila da unidade"), `TextareaField` (motivo, condicional), `ConfirmButton` (atribuir).
- **Dados e endpoints:** PRC-21 `POST /processes/{id}/claim` (IM) → POL-04; PRC-22 `POST /processes/{id}/assign` (IM) → POL-05; em lote, TSK-03/TSK-04 (Idem., 1 a 50 itens).
- **Ações:** Assumir → PRC-21 → POL-04 → toast de sucesso, botão desaparece; Atribuir/Reatribuir → PRC-22 (ou TSK-04 em lote) → POL-05 → fecha o diálogo e atualiza o painel/lista.
- **Estados:** botão de assumir visível só quando elegível, desabilitado durante o envio; *skeleton* ao carregar membros (atribuir); vazio ("Nenhum outro membro ativo nesta unidade"); erro inline se outro usuário já assumiu (`PROCESS_ALREADY_ASSIGNED`, 409); erro de carregamento.
- **Validações e mensagens:** motivo obrigatório na reatribuição (`aria-required`); novo responsável deve ter vínculo ativo, lotação na unidade atual e `PROCESS_VIEW`.
- **Acessibilidade e responsividade:** `ClaimButton` com `aria-label` "Assumir este processo", alvo de toque ≥ 44 px; foco inicial no seletor de responsável (atribuir); diálogo em tela cheia abaixo de 768 px.
- **Stories:** US-049 (assumir, principal dessa variante), US-050 (atribuir, principal dessa variante), US-058 (lote).

### SCR-116 — Suspender, retomar, cancelar e concluir (diálogos)
- **Rota:** diálogos sobre SCR-006 · **Acesso:** suspender/retomar `PROCESS_SUSPEND` + POL-07; cancelar `PROCESS_CANCEL` + POL-06; concluir `PROCESS_COMPLETE` + POL-08 · **Personas:** requisitante/gestor com custódia (suspender/retomar/concluir); perfil com `PROCESS_CANCEL` (risco alto, cancelar).
- **Objetivo:** suspender/retomar o andamento do processo, cancelá-lo (ou descartar rascunho) ou concluir a fase preparatória.
- **Layout e regiões:** um diálogo por ação, cada um com efeitos explicados antes da confirmação.
- **Componentes:** `SuspendProcessDialog` (efeitos + motivo com contador), `ResumeProcessDialog` (período suspenso, dias úteis acrescidos, novo prazo, comentário opcional), `SuspendedBanner` ("Suspenso desde … — motivo … — por …") (US-008); `ConfirmDialog` com `Textarea` e lista de impactos ("1 aprovação pendente será cancelada") para cancelar/descartar rascunho (US-009); painel de checklist (`BLOCKING`/`WARNING`, reaproveitado do painel situacional — DEC-180) + `ConfirmDialog` com "Entendo os avisos" para concluir (US-010).
- **Dados e endpoints:** PRC-23 `suspend` (IM), PRC-24 `resume` (IM); PRC-25 `cancel` (IM) / PRC-06 `DELETE` (descartar rascunho); PRC-26 `complete` (IM, Idem.).
- **Ações:** Suspender → PRC-23 → POL-07 (motivo obrigatório) → `SuspendedBanner`; Retomar → PRC-24 → POL-07 → novo prazo calculado no front com os feriados de CAL-05 e confirmado pela API; Cancelar → PRC-25 → POL-06 (justificativa ≥ 20 caracteres) → cancela aprovações pendentes na mesma transação; Concluir → PRC-26 → POL-08 (regras `BLOCKING` satisfeitas) → selo "Concluído".
- **Estados:** botão com "Suspendendo…/Retomando…/Concluindo…"; diálogo bloqueado durante a requisição; erro mantém o texto digitado; botão primário de concluir desabilitado com dica quando há `BLOCKING`.
- **Validações e mensagens:** motivo obrigatório (suspender); justificativa ≥ 20 caracteres (cancelar); violações anunciadas via `aria-live` (concluir); aviso de impacto associado via `aria-describedby`.
- **Acessibilidade e responsividade:** foco preso nos diálogos; foco inicial no campo de justificativa quando existir; diálogos em tela cheia abaixo de 768 px; utilizável em 360 px.
- **Stories:** US-008 (principal, suspender/retomar), US-009 (principal, cancelar/descartar), US-010 (principal, concluir).

---
