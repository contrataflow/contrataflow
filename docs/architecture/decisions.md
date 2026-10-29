# Registro de Decisões (Decision Log)

> **Documento canônico.** Toda especificação (produto, arquitetura, MVPs, backlog) deve respeitar as decisões abaixo.
> Para mudar uma decisão: registre uma nova entrada que **substitui** a anterior (`Substitui: DEC-NNN`), atualize os documentos afetados e, se a decisão for estrutural, crie/atualize o ADR correspondente.
>
> **Status possíveis:** `Aceita` · `Proposta` (aceita para especificação, validar na implementação) · `Pendente` (requer decisão de produto/jurídico — ver seção 10).

Sumário: [1. Convenções](#1-convenções-gerais) · [2. Produto e domínio](#2-produto-e-domínio) · [3. Módulos](#3-módulos-bounded-contexts-e-propriedade-de-entidades) · [4. Arquitetura](#4-arquitetura-e-stack) · [5. Dados](#5-dados-e-persistência) · [6. API](#6-api) · [7. Segurança e identidade](#7-segurança-identidade-e-acesso) · [8. Eventos e filas](#8-eventos-filas-e-jobs) · [9. UX](#9-ux) · [10. Pendentes](#10-decisões-pendentes) · [11. ADRs](#11-índice-de-adrs)

---

## 1. Convenções gerais

### DEC-001 — Idioma e nomenclatura · `Aceita`
- Documentação, UI, mensagens (`title`/`detail` de erro), e-mails e notificações: **pt-BR**.
- Código e contratos técnicos: **inglês**.

| Elemento | Convenção | Exemplo |
|---|---|---|
| Modelo Prisma / entidade | PascalCase singular | `Process`, `TermOfReference`, `Dfd`, `Etp` |
| Tabela / coluna | snake_case (tabela no plural) | `processes`, `process_items.process_id` |
| Campo TS / JSON | camelCase | `estimatedValue`, `currentStageId` |
| Enum (valores) | SCREAMING_SNAKE_CASE | `IN_PROGRESS`, `AWAITING_APPROVAL` |
| Permissão | `RESOURCE_ACTION` | `PROCESS_CREATE`, `DFD_SUBMIT` |
| Evento de domínio | PascalCase no passado + routing key dot.case | `ProcessCreated` / `process.created` |
| Ação de auditoria | `resource.action` (dot.case) | `process.create`, `approval.decide` |
| Código de erro | SCREAMING_SNAKE_CASE | `PROCESS_NOT_FOUND`, `VERSION_CONFLICT` |
| Fila BullMQ | kebab-case | `document-render`, `email` |
| Chave de configuração | dot.camelCase | `numbering.process.mask` |
| Rota da API | `/api/v1/<recurso-plural-kebab>` | `/api/v1/price-research/{id}` |
| Rota web (Next.js) | pt-BR kebab-case | `/processos/[id]/pesquisa-precos/[researchId]` |
| Chave de seção de documento | SCREAMING_SNAKE_CASE | `NEED_DESCRIPTION`, `CONTRACTOR_OBLIGATIONS` |
| Código de catálogo | SCREAMING_SNAKE_CASE (estável) | `PREGAO`, `AQUISICAO_BENS` |

- Siglas de domínio brasileiras mantidas: DFD (`Dfd`), ETP (`Etp`), PCA (`Pca`), TR (`TermOfReference`; recurso `/terms`).
- Siglas em identificadores PascalCase/camelCase seguem a mesma regra (só a inicial maiúscula): `PncpProvider`, `AiProvider`, `CnpjValidator`. Exceção: nomes especializados de eventos pedidos pelo produto (`DFDCreated`, `ETPApproved` — DEC-162) e `PNCPProvider` citado no briefing, que será implementado como `PncpProvider`.

### DEC-002 — Identificadores · `Aceita`
- Chave primária: **UUIDv7** gerado pela aplicação (ordenável no tempo, boa localidade de índice). IDs nunca são sequenciais nem previsíveis.
- Identificadores de negócio (número, ano, código formatado) são **separados** da PK e gerados por sequência transacional (DEC-028).
- IDs de documentação: ver [`docs/README.md`](../README.md#22-identificadores-de-documentação).

### DEC-003 — Datas, dinheiro e números · `Aceita`
- Persistência em `timestamptz` (UTC). API em ISO 8601 UTC (`2026-10-05T14:30:00Z`). Datas sem hora em `YYYY-MM-DD` (`date`).
- Exibição no fuso do tenant (padrão `America/Sao_Paulo`; configurável — o Brasil tem múltiplos fusos).
- Valores monetários: `Decimal(18,2)`. Preço unitário: `Decimal(18,4)`. Quantidade: `Decimal(18,4)`. Percentual: `Decimal(9,4)`.
- Na API, decimais trafegam como **string** (`"12345.67"`). Cálculos com `decimal.js` (nunca `number`/float). Arredondamento padrão `ROUND_HALF_UP` para 2 casas em totais (alternativa ABNT NBR 5891 — PEND-05).

---

## 2. Produto e domínio

### DEC-010 — O Processo de Contratação é o agregado central · `Aceita`
Todo artefato de negócio — documentos, versões, aprovações, tramitações, comentários, anexos, prazos, riscos, pesquisas de preço, itens, timeline — possui `processId` obrigatório. Exceções (cadastros/configuração do tenant, sem processo): estrutura organizacional, usuários e perfis, catálogos, templates, workflows, fornecedores, configurações, calendário.

### DEC-011 — Tenant × Organization × Department · `Aceita`
| Conceito | Entidade | Exemplo | Observação |
|---|---|---|---|
| Cliente/conta do SaaS e fronteira de isolamento | `Tenant` | "Município de São José" | Faturamento, configurações, isolamento de dados |
| Órgão/entidade com CNPJ dentro do tenant | `Organization` | Prefeitura Municipal; Fundo Municipal de Saúde; SAAE (autarquia) | 1..N por tenant; base para numeração por órgão e para o PNCP (MVP 3) |
| Unidade administrativa em árvore | `Department` | Secretaria de Saúde → Departamento de Compras → Setor de Cotações | Tipo configurável (`SECRETARIAT`, `BOARD`, `DEPARTMENT`, `DIVISION`, `SECTOR`, `COMMITTEE`, `OTHER`); titular e substituto |

- "Secretaria solicitante" = `Department` do tipo `SECRETARIAT` (ou nó de nível 1); "setor solicitante" = `Department` na subárvore da secretaria (pode ser a própria). O rótulo "Secretaria" é configurável (`labels.secretariat`, ex.: "Diretoria" em câmaras).
- Câmara Municipal é, em regra, **outro tenant** (poder distinto), mesmo no mesmo município.

### DEC-012 — Identidade global + vínculo por tenant · `Aceita`
- `User` é a identidade global (mapeada ao `sub` do Authentik). Não contém dados de negócio do tenant.
- `TenantMembership` é o vínculo do usuário com um tenant (tipo `INTERNAL` servidor, `EXTERNAL` consultoria/terceiro, `SERVICE` conta de serviço — MVP 3), com status, cargo, matrícula, lotação (`MembershipDepartment`) e validade (obrigatória para `EXTERNAL`).
- Um usuário pode ter vínculos com vários tenants (ex.: consultoria externa) e escolhe o **tenant ativo** na sessão. Na interface o tenant é exibido como a **instituição contratante** (ex.: "Prefeitura de São José"); o termo "órgão/entidade" fica reservado a `Organization` (DEC-011).

### DEC-013 — Status macro do processo separado da etapa do workflow · `Aceita`
`ProcessStatus`: `DRAFT`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED`, `CANCELED`, `COMPLETED`, `PUBLISHED`.

```mermaid
stateDiagram-v2
    [*] --> DRAFT: criar
    DRAFT --> IN_PROGRESS: 1º encaminhamento (etapa TASK)
    DRAFT --> AWAITING_APPROVAL: 1º encaminhamento (etapa APPROVAL)
    IN_PROGRESS --> AWAITING_APPROVAL: entra em etapa APPROVAL
    AWAITING_APPROVAL --> IN_PROGRESS: aprovação APPROVED (próxima etapa TASK)
    AWAITING_APPROVAL --> RETURNED: aprovação RETURNED/REJECTED
    IN_PROGRESS --> RETURNED: devolver
    AWAITING_APPROVAL --> RETURNED: devolver (retirada pelo gestor)
    RETURNED --> IN_PROGRESS: encaminhar novamente
    RETURNED --> AWAITING_APPROVAL: encaminhar para etapa APPROVAL
    IN_PROGRESS --> SUSPENDED: suspender
    AWAITING_APPROVAL --> SUSPENDED: suspender
    RETURNED --> SUSPENDED: suspender
    SUSPENDED --> IN_PROGRESS: retomar (status anterior)
    SUSPENDED --> AWAITING_APPROVAL: retomar (status anterior)
    SUSPENDED --> RETURNED: retomar (status anterior)
    IN_PROGRESS --> COMPLETED: concluir (etapa END)
    AWAITING_APPROVAL --> COMPLETED: aprovação APPROVED com próxima etapa END
    DRAFT --> CANCELED: cancelar
    IN_PROGRESS --> CANCELED: cancelar
    AWAITING_APPROVAL --> CANCELED: cancelar
    RETURNED --> CANCELED: cancelar
    SUSPENDED --> CANCELED: cancelar
    COMPLETED --> PUBLISHED: publicação (MVP 3)
    CANCELED --> [*]
    PUBLISHED --> [*]
```

Regras:
- O status só é alterado pelo serviço de ciclo de vida do processo (`ProcessLifecycleService`); nunca por `PATCH` direto.
- `PUBLISHED` existe no enum desde o MVP 1, mas só é alcançável no MVP 3 (PEND-16).
- `SUSPENDED` guarda `statusBeforeSuspension` e pausa prazos (DEC-031). Aprovações pendentes ficam congeladas.
- `CANCELED` e `PUBLISHED` são finais no MVP 1. Reabertura de `COMPLETED`/`CANCELED`: PEND-03.
- Rascunho sem número (quando a numeração ocorre na autuação — DEC-028) pode ser **descartado** (exclusão lógica), em vez de cancelado.
- **Aditivo (US-071, 2026-10-17):** em `CANCELED`, `COMPLETED` e `PUBLISHED` os comentários do processo são **somente leitura** — criar, responder, editar e excluir o próprio respondem 409 `INVALID_PROCESS_STATUS`; a moderação (`COMMENT_MODERATE`) continua permitida. Rever quando o MVP 3 tornar `COMPLETED → PUBLISHED` operacional.

### DEC-014 — Motor de workflow próprio, declarativo e versionado · `Aceita` · [ADR-005](../adr/adr-005-workflow-engine.md)
- Definição: `Workflow` → `WorkflowVersion` (DRAFT → PUBLISHED → RETIRED; publicada é **imutável**) → `WorkflowStage` (tipos `START`, `TASK`, `APPROVAL`, `END`) → `WorkflowTransition` (ações `FORWARD`, `RETURN`, `APPROVE`, `REJECT`, `COMPLETE`) → `WorkflowRule`.
- Execução (runtime, no módulo `process`): `ProcessStage` (instância da etapa), `ProcessAssignment` (histórico de responsabilidade), `ProcessMovement` (registro imutável de tramitação).
- O processo **fixa a versão do workflow** na criação (`workflowVersionId`). Migração de processos em andamento para nova versão: fora do MVP 1 (postergado).
- Ações do usuário: **encaminhar** (`FORWARD`), **devolver** (`RETURN`), **aprovar** (`APPROVE`), **rejeitar/indeferir** (`REJECT`), **assumir** (`CLAIM`), **concluir** (`COMPLETE`), **cancelar** (`CANCEL`). Aprovar/rejeitar ocorrem por meio de `Approval`; assumir/cancelar/suspender/retomar/atribuir são ações de ciclo de vida, não transições do grafo.
- Um único `ProcessStage` ativo por processo no MVP 1 (sem paralelismo). Paralelismo: MVP 2+.

### DEC-015 — Workflow padrão semeado: "Fase preparatória — Lei 14.133/2021" · `Aceita`
| # | Chave | Nome | Tipo | Responsável padrão | Saída exige (regras padrão) |
|---|---|---|---|---|---|
| 1 | `ABERTURA` | Formalização da demanda | START | Setor solicitante (`REQUESTING_DEPARTMENT`) | DFD existente e completo |
| 2 | `APROVACAO_DFD` | Aprovação da demanda | APPROVAL | Titular da secretaria solicitante (`DEPARTMENT_HEAD`) | — (decisão) cobre documento `DFD` |
| 3 | `ESTUDOS_PRELIMINARES` | ETP e mapa de riscos | TASK | Escolhida no encaminhamento (`CHOSEN_ON_FORWARD`) | ETP completo (BLOCKING); Mapa de riscos existente (WARNING) |
| 4 | `PESQUISA_PRECOS` | Pesquisa de preços | TASK | Unidade fixa configurada (Compras) | Pesquisa de preços concluída |
| 5 | `TERMO_REFERENCIA` | Termo de Referência | TASK | Escolhida no encaminhamento | TR completo |
| 6 | `APROVACAO_AUTORIDADE` | Aprovação da autoridade competente | APPROVAL | Perfil `AUTORIDADE_COMPETENTE` cuja atribuição cubra a **secretaria solicitante** (ver DEC-022) | — (decisão) cobre `ETP`, `RISK_MAP`, `PRICE_RESEARCH`, `TR` |
| 7 | `CONCLUSAO` | Planejamento da contratação concluído | END | — | — |

Devoluções padrão: qualquer etapa pode devolver para etapas anteriores já percorridas (lista configurável por transição).

- **Nome da etapa final:** no MVP 1 o processo termina com o **planejamento concluído** (artefatos do art. 18 aprovados); o status `COMPLETED` significa isso. A "fase preparatória" só se completa no MVP 2, quando nova versão do workflow padrão inserir, entre as etapas 6 e 7: **Dotação** (compatibilidade orçamentária), **Minuta do edital**, **Jurídico** (art. 53) e **Controle Interno**; a etapa final passará a "Fase preparatória concluída".
- **Autoridade:** em entes descentralizados cada secretário é ordenador de despesa da própria pasta — atribuir `AUTORIDADE_COMPETENTE` aos secretários com escopo `DEPARTMENT` (sua secretaria) e ao chefe do Executivo com escopo `ORGANIZATION`. Quem preferir que só o titular da pasta decida configura a etapa como `DEPARTMENT_HEAD` da secretaria solicitante.
- **Segundo workflow semeado (contratação direta — art. 72):** "Contratação direta — Lei 14.133/2021, art. 72", aplicável quando a modalidade for `DISPENSA` ou `INEXIGIBILIDADE`: `ABERTURA` (DFD) → `APROVACAO_DFD` → `INSTRUCAO` (ETP/TR quando cabíveis, pesquisa de preços, justificativa da escolha do fornecedor e do preço em `NOTA_TECNICA`) → `AUTORIZACAO` (APPROVAL, autoridade competente; cobre os documentos da instrução) → `CONCLUSAO` (END). Regras: TR ou ETP exigidos como `WARNING` (art. 72, I — "se for o caso"); pesquisa de preços concluída `BLOCKING` (art. 72, II). No MVP 2 recebe parecer jurídico e compatibilidade orçamentária (art. 72, III e IV).

### DEC-016 — Regras parametrizáveis com JSON Logic · `Aceita` · [ADR-008](../adr/adr-008-configurable-rules.md)
- `WorkflowRule` (tipos `REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL`, `CONDITION`), severidade `BLOCKING` | `WARNING`, mensagem ao usuário configurável.
- Condições em **JSON Logic** (`json-logic-js`), avaliadas sobre um **contexto de regras versionado** (`RuleContext v1`: `process.*`, `documents.<TYPE>.*`, `priceResearch.*`, `risks.*`, `items.*`, `now`). Nunca expor o banco diretamente; nunca executar código arbitrário.
- Aplicabilidade de workflow (`Workflow.applicabilityRule`) também em JSON Logic.
- Regras legais (ex.: elementos obrigatórios do ETP — art. 18, §§ 1º e 2º) são **configuração semeada**, não código.
- Avisos (`WARNING`) não impedem a ação, mas exigem reconhecimento explícito (`acknowledgedWarnings[]` no comando); os avisos reconhecidos ficam registrados com id e mensagem da regra em `ProcessMovement.metadata.warningsAcknowledged` e em `AuditLog.metadata` — evidência para o Controle Interno.

### DEC-017 — Modelo documental híbrido · `Aceita` · [ADR-006](../adr/adr-006-document-model.md)
- `Document` é o artefato genérico do processo (tipo, número, status, versão atual/aprovada, rascunho de trabalho).
- `DocumentType` (configurável por tenant) com `kind`: `STRUCTURED` (módulos tipados: DFD, ETP, TR, RISK_MAP, PRICE_RESEARCH), `FREE_TEXT` (template rico: despacho, ofício, nota técnica…), `UPLOADED` (arquivo externo).
- Documentos tipados têm uma **tabela de cabeçalho tipada 1:1** (`Dfd`, `Etp`, `TermOfReference`, `PriceResearch`) com os campos que o sistema precisa filtrar, calcular, validar, reportar ou integrar; **seções narrativas** vêm do template (`DocumentTemplateVersion.sections`) e ficam em `Document.draftContent` (TipTap JSON por `sectionKey`); **coleções** em tabelas tipadas (`DocumentItem`, `EtpAlternative`, `PriceItem`, `Quotation`, `Risk`…).
- `DocumentVersion` é um **snapshot imutável** (cabeçalho + seções + coleções) com `contentHash` SHA-256 do JSON canonicalizado (RFC 8785). Renderizações (PDF) ficam em `DocumentRendition` (`PREVIEW`, `CONTENT`, `APPROVAL_STAMPED`; `SIGNED` no MVP 3).
- Versões são criadas em: salvar versão manual, submissão para aprovação, importação, upload de nova versão e reabertura. Autosave **não** cria versão (atualiza o rascunho com controle de revisão).

### DEC-018 — Ciclo de vida único de documento · `Aceita`
`DocumentStatus`: `DRAFT` (Rascunho), `IN_REVIEW` (Em revisão), `RETURNED` (Devolvido), `FINALIZED` (Finalizado — concluído sem aprovação formal), `APPROVED` (Aprovado), `REJECTED` (Indeferido), `CANCELED` (Cancelado).

| De | Para | Gatilho |
|---|---|---|
| DRAFT/RETURNED | FINALIZED | **finalizar** (tipo com `requiresApproval = false`) → valida completude, cria versão, bloqueia edição |
| DRAFT/RETURNED | IN_REVIEW | **submeter** (tipo com `requiresApproval = true`) ou entrada do processo em etapa APPROVAL que cobre o tipo → valida completude, cria versão |
| IN_REVIEW | APPROVED | aprovação APPROVED (`approvedVersionId` = versão submetida) |
| IN_REVIEW | RETURNED | aprovação RETURNED (volta a ser editável pelo custodiante) |
| IN_REVIEW | REJECTED | aprovação REJECTED (só volta a DRAFT por reabertura) |
| IN_REVIEW | DRAFT | retirada da submissão (cancela a `Approval` pendente) |
| FINALIZED | APPROVED | aprovação APPROVED de etapa que cobre o documento (status não muda durante a análise; `pendingApprovalId` preenchido) |
| FINALIZED/APPROVED | RETURNED | aprovação RETURNED de etapa que cobre o documento |
| FINALIZED/APPROVED | REJECTED | aprovação REJECTED de etapa que cobre o documento |
| APPROVED/FINALIZED/REJECTED | DRAFT | **reabrir** (`DOCUMENT_REOPEN` + justificativa) → novo rascunho de trabalho a partir da última versão |
| DRAFT/RETURNED | CANCELED | cancelar documento (justificativa); final |

- Documento `APPROVED` coberto por nova aprovação de etapa (ex.: autoridade reaprova o ETP já aprovado pelo secretário) permanece `APPROVED`; a nova `Approval` fica registrada para a mesma versão.
- Nos tipos semeados (DFD, ETP, TR, RISK_MAP, PRICE_RESEARCH, despacho, ofício…) `requiresApproval = false`: a aprovação formal acontece nas etapas APPROVAL do workflow (DEC-015). `requiresApproval = true` é usado por tenants que queiram aprovação avulsa de um tipo.
- Regra `REQUIRED_DOCUMENT` aceita `minStatus`: `EXISTS` (qualquer não cancelado), `COMPLETE` (passa na validação de completude), `SUBMITTED` (IN_REVIEW, FINALIZED ou APPROVED), `FINAL` (FINALIZED ou APPROVED), `APPROVED`.
- `PriceResearch` **não** tem status próprio: usa o status do `Document` + `completedAt` (DEC-020). "Concluir pesquisa" = finalizar o documento.
- **Indicador "Em aprovação":** como um documento coberto por aprovação de etapa pode estar `IN_REVIEW` (submetido na entrada da etapa) ou `FINALIZED`/`APPROVED` (já concluído antes), a interface exibe o selo derivado **"Em aprovação"** sempre que `pendingApprovalId` estiver preenchido, independentemente do status — o status técnico continua disponível no detalhe.

### DEC-019 — Itens canônicos do processo · `Aceita`
- `ProcessItem` = identidade do item (nº sequencial, lote, natureza, descrição, unidade, código CATMAT/CATSER opcional) + **quantidade e preço de referência** (`referenceQuantity`, `referenceUnitPrice`) atualizados apenas quando um documento é aprovado ou a pesquisa é concluída (com `…SourceDocumentId`).
- `DocumentItem` = linha do item **em um documento** (DFD, ETP, TR): quantidade daquele documento, memória de cálculo (ETP), especificação e critérios de aceitação (TR).
- `PriceItem` = linha do item **na pesquisa de preços**.
- Isso viabiliza, sem duplicar o conceito de item, o aviso **determinístico** de quantidade divergente entre ETP e TR já no MVP 1 (US-039, `WARNING` com reconhecimento) e a validação cruzada ampliada do MVP 5.

### DEC-020 — Pesquisa de preços · `Aceita`
| Conceito pedido | Entidade | Observação |
|---|---|---|
| PesquisaPreco | `PriceResearch` | Cabeçalho tipado 1:1 com `Document` (tipo `PRICE_RESEARCH`); 1 não cancelada por processo no MVP 1 |
| PesquisaItem | `PriceItem` | Estatísticas persistidas por item |
| FontePesquisa | `PriceSource` (instância/evidência) + catálogo `PRICE_SOURCE_TYPE` (tipo) | Ex.: "Orçamento Empresa X de 10/09/2026", "Painel de Preços consultado em 12/09/2026 14:32" |
| Cotacao | `Quotation` | Preço de **um item** em **uma fonte**; `VALID` ou `EXCLUDED` (com motivo e justificativa) |
| Fornecedor | `Supplier` | Cadastro do tenant; CNPJ (inclusive alfanumérico, IN RFB 2.229/2024) ou CPF |

- Estatísticas por item sobre cotações válidas: quantidade, média, mediana, menor, maior, desvio-padrão amostral, coeficiente de variação; valor recomendado pelo método (`MEAN`, `MEDIAN`, `LOWEST`, `MANUAL` com justificativa); total = unitário × quantidade.
- Parâmetros (método padrão, mínimo de cotações = 3, validade da cotação direta = 180 dias, faixas de outlier) são configuráveis por tenant e **copiados como snapshot** na criação da pesquisa.
- Outliers são **sinalizados**, nunca excluídos automaticamente; exclusão exige justificativa e é auditada.
- **Padrão do produto (confirmado em 2026-10-07 — PEND-04 encerrada):** método `AUTO_CV` (média se CV ≤ 25%, mediana se CV > 25%); sinalização abaixo de 70% e acima de 130% da mediana das demais cotações; mínimo de 3 cotações (IN SEGES/ME 65/2021, art. 6º).

### DEC-021 — Riscos · `Aceita`
`Risk` (identificação e avaliação: título, descrição, categoria, fase, causa, consequência, probabilidade, impacto, pontuação, nível, responsável, status) + `RiskTreatment` (ações `PREVENTIVE`/`CONTINGENCY`, responsável, prazo, status). Riscos pertencem ao processo; o documento `RISK_MAP` é o artefato formal (versionado/aprovável) cujo snapshot inclui os riscos. Escalas e faixas de nível configuráveis por tenant (`risk.scale`, `risk.levelThresholds`); padrão confirmado em 2026-10-07 (PEND-15 encerrada): 5×5, faixas 1–4 Baixo, 5–9 Médio, 10–16 Alto, 17–25 Extremo.

### DEC-022 — Aprovação genérica · `Aceita`
- `Approval` com `subjectType` `PROCESS_STAGE` (etapa APPROVAL do workflow) ou `DOCUMENT` (submissão avulsa); `ApprovalDocument` lista as **versões exatas** de documentos cobertas.
- Decisões: `APPROVE` → `ApprovalStatus.APPROVED`; `RETURN` → `RETURNED`; `REJECT` → `REJECTED`. Também `CANCELED` (retirada/cancelamento do processo).
- Aprovador resolvido **no momento da solicitação** (`USER`, `ROLE`, `DEPARTMENT_HEAD`) e gravado; o substituto (`deputyUserId`) da unidade pode decidir quando `allowDeputy = true`.
- **Cobertura para `ROLE`:** são aprovadores os detentores do perfil cuja atribuição cubra a **unidade solicitante** do processo — escopo `TENANT`, `ORGANIZATION` = órgão do processo, ou `DEPARTMENT`/`OWN_DEPARTMENTS` contendo `requestingSecretariatId` ou `requestingDepartmentId`. As concessões de visibilidade `CURRENT`/`HISTORICAL` **não** dão competência para aprovar (evita que o secretário de uma pasta pela qual o processo apenas tramitou decida sobre ele).
- Política de decisão no MVP 1: `ANY` (um aprovador decide). Múltiplos aprovadores/sequenciais: MVP 2 (PEND-13).
- **Segregação de funções** (Lei 14.133, art. 7º, § 1º): por padrão o autor de um documento coberto não pode aprová-lo (`approval.preventSelfApproval = true`).

### DEC-023 — Princípio da custódia · `Aceita`
Só altera o processo (editar dados, editar documentos, encaminhar, devolver) quem está **com o processo**: o responsável atual ou, se não houver responsável atribuído, membro da unidade atual. Exceções: (a) gestores com `PROCESS_ASSIGN` no escopo podem atribuir/reatribuir; (b) participantes `COLLABORATOR`/`CONSULTANT` podem editar documentos em DRAFT/RETURNED do processo; (c) aprovadores decidem aprovações a eles atribuídas.

### DEC-024 — Visibilidade de processos · `Aceita`
Um usuário vê um processo se **qualquer** condição abaixo for verdadeira:
1. Tem `PROCESS_VIEW` com escopo `TENANT`.
2. Tem `PROCESS_VIEW` com escopo `ORGANIZATION` = órgão do processo.
3. Tem `PROCESS_VIEW` com escopo `DEPARTMENT` (com ou sem subárvore) ou `OWN_DEPARTMENTS` (lotações) e existe `ProcessAccess` do processo para alguma dessas unidades (motivos `REQUESTING`, `CURRENT`, `HISTORICAL`).
4. Existe `ProcessAccess` do processo para o próprio usuário (motivos `CREATOR`, `RESPONSIBLE`, `PARTICIPANT`, `APPROVER`).

`ProcessAccess` é mantido na mesma transação das mudanças (criação, tramitação, participantes, aprovações). Acesso histórico de unidades é mantido (`access.historicalDepartmentsCanView`, padrão `true`). Recurso de outro tenant **ou** não visível → **404**; visível mas ação não permitida → **403**.

### DEC-025 — Timeline × Auditoria · `Aceita`
| | Timeline (`ProcessTimelineEntry`) | Auditoria (`AuditLog`) |
|---|---|---|
| Propósito | Narrativa do processo para usuários | Registro de conformidade e segurança |
| Escopo | Somente eventos de processo, curados | Todas as ações relevantes (inclusive negadas, acessos, exportações, configuração) |
| Conteúdo | Mensagem + parâmetros com nomes congelados no tempo | Ator, IP, user-agent, diff antes/depois (com mascaramento), correlationId, resultado |
| Acesso | Quem vê o processo | `AUDIT_VIEW` |
| Escrita | Síncrona, mesma transação | Síncrona, mesma transação; append-only; selagem periódica |
| Retenção | Vida do processo | Política de retenção (PEND-07); partição mensal |

Não são conceitos duplicados: a timeline é uma projeção de leitura; a auditoria é evidência.

### DEC-026 — Caixa de tarefas como consulta · `Aceita`
Não existe entidade `Task` no MVP 1. A caixa é uma consulta sobre: `ProcessStage` ativo + `ProcessAssignment` ativo (meus / da minha unidade sem responsável / devolvidos / atrasados) ∪ `Approval` `PENDING` em que sou aprovador (direto, por perfil no escopo, titular ou substituto) ∪ `ProcessParticipant` ativo do usuário (visão "Acompanhando", qualquer `role` — US-056). Read model dedicado só se a performance exigir (débito técnico monitorado).

### DEC-027 — Catálogos parametrizáveis · `Aceita`
`CatalogItem` (por tenant) com `catalogType`: `CONTRACTING_TYPE`, `MODALITY`, `PROCESS_ORIGIN`, `UNIT_OF_MEASURE`, `RISK_CATEGORY`, `PRICE_SOURCE_TYPE`, `JUDGMENT_CRITERION`, `ATTACHMENT_CATEGORY`. O catálogo-base da plataforma é **copiado no provisionamento**; `code` é estável (usado em regras e integrações); itens de sistema (`isSystem`) podem ser renomeados/desativados, nunca excluídos; no MVP 1 os demais itens também não têm exclusão física — o ciclo de vida é ativar/desativar (referências em processos e documentos; US-104). Metadados por item em JSONB (ex.: código PNCP da modalidade, base legal, campos exigidos por tipo de fonte de preço).

### DEC-028 — Numeração · `Aceita`
- Máscara configurável por tipo (`numbering.process.mask`, `numbering.document.<TYPE>.mask`) com tokens `{seq:N}`, `{year}`, `{org}` (sigla do órgão), `{type}` (código do tipo). Padrões: processo `{seq:4}/{year}` (ex.: `0012/2026`); documento `{type} {seq:4}/{year}` (ex.: `DFD 0005/2026`).
- Escopo da sequência: tenant (padrão) ou órgão (`numbering.process.scope`); reinício anual.
- Gerada por `NumberSequence` com `UPDATE … SET last_value = last_value + 1 RETURNING` **na mesma transação** da criação (sem lacunas por rollback; seguro sob concorrência).
- Momento de atribuição do número do processo: `CREATE` (padrão, conforme exemplo de aceite do produto) ou `START` (na autuação/1º encaminhamento) — `numbering.process.assignOn`; padrão `CREATE` confirmado pelo produto em 2026-10-07 (PEND-01 encerrada).
- `internalCode` ("código interno") é opcional, informado pelo órgão (ex.: nº de protocolo legado/SEI), único por tenant quando preenchido.
- **Implementação (US-105):** a `NumberingFacade` do `catalog` é o único ponto de geração (`assignProcessNumber`/`assignDocumentNumber`/`next` na transação do recurso numerado; `preview` para o `SET-04`). Máscaras das chaves `numbering.*` aceitam `{seq:1..6}` e só as de documento aceitam `{type}` (a de `DocumentType.numberingMask`, US-061, segue `{seq:1..8}`). O escopo do exercício é o da primeira sequência de processo aberta no ano: mudar `numbering.process.scope` só vale no próximo exercício, sem migrar sequências. Documentos numeram por tipo e ano no tenant (`DOCUMENT:<TYPE>:*:<ano>`) mesmo com escopo `ORGANIZATION` para processos — as máscaras de documento semeadas não têm `{org}` e o `code` do documento é único no tenant. Máscara do documento: a do tipo; sem ela, `numbering.document.<TYPE>.mask` (chave dinâmica do registro); sem nenhuma, `numbering.document.defaultMask`.

### DEC-029 — PCA no MVP 1 · `Aceita`
Sem entidade PCA no MVP 1. `Process` e `Dfd` guardam a referência: `pcaStatus` (`PLANNED`, `NOT_PLANNED`, `NOT_APPLICABLE`), `pcaYear`, `pcaItemCode`, `pcaJustification` (obrigatória se `NOT_PLANNED`). O MVP 2 cria `Pca`/`PcaItem` e adiciona `pcaItemId` (FK) com migração que tenta resolver as referências existentes.

### DEC-030 — Sigilo do orçamento estimado · `Aceita`
Lei 14.133, art. 24: o orçamento estimado pode ser sigiloso. `Process.isBudgetConfidential` faz a API **mascarar** valores estimados (processo, itens, pesquisa, ETP, TR) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (resposta `null` + `masked: true`). Documentos com valores (pesquisa de preços) passam a `confidentiality = RESTRICTED`. Aplicado por política de serialização central — nunca por tela.

### DEC-031 — Prazos e calendário · `Aceita`
- SLA por etapa (`WorkflowStage.slaDays`, `slaType` `BUSINESS`|`CALENDAR`); prazo pode ser sobrescrito no encaminhamento quando a transição permitir.
- Dias úteis = segunda a sexta, exceto `Holiday` do tenant (nacionais semeados, inclusive móveis; estaduais/municipais cadastrados; pontos facultativos conforme `calendar.optionalHolidaysAreNonBusiness`).
- Suspensão pausa a contagem; ao retomar, `dueAt` é estendido pelo tempo pausado.
- Atraso: `now > dueAt` → `overdueSince` preenchido pelo job `deadlines`; alerta de vencimento próximo conforme `deadlines.warnBeforeBusinessDays` (padrão 2).
- `Process.targetDate` (prazo alvo) é informativo/planejamento; atraso do processo = `targetDate < hoje` e status não final.

### DEC-032 — Valor estimado do processo · `Aceita`
`Process.estimatedValue` é derivado por precedência de fonte: TR aprovado > pesquisa de preços concluída > ETP > DFD > manual. `estimatedValueSource` registra a origem. Edição manual só quando não houver fonte de maior precedência: havendo, o PATCH é recusado (422 `BUSINESS_RULE_VIOLATION`) e a UI mostra o campo somente leitura com o aviso da fonte (US-005 · RN-PROC-63).

### DEC-033 — Duplicação · `Aceita`
Duplicar processo copia metadados, itens, etiquetas e — opcionalmente — o conteúdo dos documentos estruturados como **novos rascunhos**. Nunca copia: número, aprovações, tramitações, timeline, comentários, auditoria, participantes. Anexos: opcional (cópia lógica referenciando o mesmo binário). Grava `duplicatedFromId`.

### DEC-034 — Exclusão e retenção · `Aceita`
Nada de processo é excluído fisicamente. Rascunho sem número pode ser descartado (exclusão lógica). Documento nunca submetido pode ser excluído logicamente; após submetido, só cancelado. Anexos: exclusão lógica com motivo; o binário é retido conforme política de retenção (PEND-07).

### DEC-035 — Personas → perfis padrão (role templates) · `Aceita`
Perfis semeados no provisionamento (editáveis pelo administrador do tenant, exceto `ADMIN_ORGAO`, que sempre tem todas as permissões de administração):

| Chave do perfil | Persona |
|---|---|
| `ADMIN_ORGAO` | Administrador do órgão |
| `GESTOR_CONTRATACOES` | Gestor de contratações |
| `REQUISITANTE` | Área requisitante |
| `PLANEJAMENTO` | Planejamento |
| `COMPRAS` | Compras |
| `LICITACOES` | Licitações |
| `CONTABILIDADE` | Contabilidade |
| `JURIDICO` | Jurídico / Procuradoria |
| `CONTROLE_INTERNO` | Controle Interno |
| `AUTORIDADE_COMPETENTE` | Autoridade competente |
| `FISCAL_CONTRATO` | Fiscal de contrato (permissões ampliadas no MVP 4) |
| `GESTOR_CONTRATO` | Gestor de contrato (permissões ampliadas no MVP 4) |
| `AUDITOR` | Auditor |
| `SOMENTE_LEITURA` | Usuário somente leitura |
| `CONSULTOR_EXTERNO` | Consultoria externa (acesso por participação em processos) |

Matriz completa em [`mvp-01/permissions.md`](../mvp-01/permissions.md).

### DEC-036 — Participantes do processo · `Aceita`
`ProcessParticipant` concede acesso explícito por processo a usuários ou unidades: `OBSERVER` (vê e recebe notificações; inclui "seguir processo"), `COLLABORATOR` (vê, comenta, edita documentos em rascunho, anexa), `CONSULTANT` (como colaborador, obrigatoriamente com `expiresAt`; padrão para vínculos `EXTERNAL`). Participantes nunca tramitam nem aprovam.

### DEC-037 — IA geradora dos documentos do planejamento no MVP 1 · `Aceita` · antecipa parte do MVP 5 · [ADR-013](../adr/adr-013-ai-provider.md) (provedor pendente — PEND-21)
- **Contexto:** elaborar DFD, ETP, mapa de riscos e TR é o trabalho mais demorado da fase preparatória, e os órgãos pequenos têm pouco tempo e prática nisso; o principal concorrente vende a geração desses documentos com IA. O plano anterior só trazia IA no MVP 5, para assistir e validar (prd-3).
- **Decisão do usuário (2026-10-14):** geração assistida **no MVP 1, antes do lançamento**, logo depois dos editores dos quatro documentos (EP-020; impacto no prazo em [delivery-plan.md](../mvp-01/delivery-plan.md) §5). Documentos: DFD, ETP, Mapa de riscos e TR. Modo: **rascunho completo** a partir de um resumo da necessidade e dos dados do processo, em cadeia (DFD → ETP → mapa de riscos → TR), com os templates do órgão e a base legal da Lei 14.133/2021, e **ajuste por seção** (reescrever, completar, resumir). A pessoa sempre revisa e aprova.
- **Regras que valem para toda a capacidade:**
  1. **Princípio 16:** a IA nunca aprova, encaminha, publica nem decide; o documento só avança por ação humana. O conteúdo gerado fica identificado como "gerado por IA" até ser revisado por uma pessoa, e documento com conteúdo não revisado não pode ser finalizado, submetido nem encaminhado (US-122).
  2. **Nada inventado:** quantidades, valores, prazos e dados do órgão vêm do processo (DFD, itens, pesquisa de preços, cadastro); o que faltar sai marcado **[a confirmar]**; a IA não cria preço — o valor estimado vem da pesquisa de preços. A IA escreve só texto narrativo; campos tipados, itens, alternativas e decisões continuam com as pessoas.
  3. **Rastreabilidade:** cada geração registra quem pediu, documento e seção, modelo, versão do prompt, entradas usadas, tokens e custo (`AiGeneration`); vai para a auditoria e para a timeline do processo.
  4. **Isolamento e LGPD:** só dados do próprio tenant entram no contexto; dados pessoais desnecessários ficam de fora (minimização — DEC-140); valores de orçamento sigiloso nunca são enviados ao provedor (DEC-030).
  5. **Governança do órgão:** a IA é **opt-in** — o administrador liga (`ai.enabled`, padrão desligado) aceitando os termos de uso, pode desligá-la a qualquer momento e tem limite de uso mensal (tokens) e diário por usuário; quem pode gerar é definido pela permissão `AI_GENERATE` na matriz de perfis.
- **Fora de escopo agora:** parecer jurídico e edital ganham geração por IA no MVP 2, quando esses documentos existirem; validações cruzadas entre documentos, saúde do processo, recomendações, benchmark e busca semântica continuam no MVP 5; qualquer IA que decida ou aprove.
- **Pendentes do usuário:** provedor e modelo (PEND-21, ADR-013) e modelo de custo (PEND-22). Nenhuma decisão de provedor foi tomada na especificação.
- Registrado em 2026-10-16 (spec-473, prd-3).

---

## 3. Módulos (bounded contexts) e propriedade de entidades

### DEC-040 — Lista de módulos do MVP 1 · `Aceita`
Cada entidade tem **um único módulo dono**. Outros módulos a acessam somente pela fachada (application service público) ou por eventos.

| Módulo (`apps/api/src/modules/…`) | Responsabilidade | Entidades (dono) |
|---|---|---|
| `tenancy` | Tenants, órgãos, configurações, provisionamento, contexto de tenant | `Tenant`, `Organization`, `TenantSetting` |
| `organization` | Estrutura organizacional | `Department` |
| `identity` | Usuários, vínculos, lotação, perfil do usuário, sessão/contexto | `User`, `TenantMembership`, `MembershipDepartment` |
| `access` | RBAC, escopos, políticas de autorização | `Permission`, `Role`, `RolePermission`, `RoleAssignment` |
| `catalog` | Catálogos, calendário, numeração | `CatalogItem`, `Holiday`, `NumberSequence` |
| `process` | Processo, itens, participantes, etiquetas, runtime da tramitação, visibilidade | `Process`, `ProcessItem`, `ProcessParticipant`, `Tag`, `ProcessTag`, `ProcessStage`, `ProcessAssignment`, `ProcessMovement`, `ProcessAccess`, `SavedView` |
| `workflow` | Definição e motor de workflow (avaliação de transições e regras) | `Workflow`, `WorkflowVersion`, `WorkflowStage`, `WorkflowTransition`, `WorkflowRule` |
| `approval` | Solicitação, resolução de aprovador e decisão | `Approval`, `ApprovalDocument` |
| `document` | Tipos, templates, documentos, versões, renderização, itens de documento | `DocumentType`, `DocumentTemplate`, `DocumentTemplateVersion`, `Document`, `DocumentVersion`, `DocumentRendition`, `DocumentItem` |
| `dfd` | DFD | `Dfd` |
| `etp` | ETP | `Etp`, `EtpAlternative` |
| `price-research` | Pesquisa de preços | `PriceResearch`, `PriceItem`, `PriceSource`, `Quotation` |
| `supplier` | Fornecedores (compartilhado com MVP 4) | `Supplier` |
| `risk` | Riscos | `Risk`, `RiskTreatment` |
| `term` | Termo de Referência | `TermOfReference` |
| `collaboration` | Comentários e menções | `Comment`, `Mention` |
| `files` | Anexos, upload, antivírus, download | `Attachment` |
| `timeline` | Timeline do processo | `ProcessTimelineEntry` |
| `inbox` | Caixa de tarefas (somente consultas) | — |
| `dashboard` | Indicadores operacionais (somente consultas) | — |
| `notification` | Notificações in-app e e-mail, preferências | `Notification`, `NotificationPreference` |
| `audit` | Trilha de auditoria e selagem | `AuditLog`, `AuditSeal` |
| `ai` | Geração assistida de documentos do planejamento (DEC-037, DEC-079); somente fachadas de leitura de outros módulos | `AiGeneration` |
| `platform` (infra compartilhada) | Outbox, filas, storage, cache, PDF, e-mail, observabilidade, health | `OutboxEvent` |

Módulos futuros (reservados): `pca`, `budget`, `legal-review`, `internal-control`, `tender`, `sla`, `analytics`, `rules`, `publication`, `signature`, `integration`, `public-api`, `webhook`, `contract`. O `ai` foi antecipado para o MVP 1 (DEC-079); o MVP 5 amplia o mesmo módulo.

### DEC-041 — Camadas por módulo · `Aceita` · [ADR-001](../adr/adr-001-modular-monolith.md)
```
modules/<modulo>/
  domain/          # entidades, value objects, regras puras, eventos de domínio, interfaces de repositório
  application/     # casos de uso (commands/queries), DTOs, fachada pública do módulo, políticas
  infrastructure/  # repositórios Prisma, adapters (S3, Gotenberg, SMTP, Authentik), mapeadores
  presentation/    # controllers REST, guards, serialização, OpenAPI
  <modulo>.module.ts
```
- `domain` não depende de NestJS, Prisma ou qualquer infraestrutura.
- Dependências entre módulos somente via `application/<modulo>.facade.ts` ou eventos. Proibido importar `infrastructure`/`domain` de outro módulo (verificado por `dependency-cruiser` no CI).
- **Exceção registrada (US-101):** `tenancy` (nível 1) importa as fachadas de `access` e `identity` (mesmo nível; `allow` em `tools/module-levels.json`) porque os casos de uso de órgão (ORG-01..04) são do `tenancy` e exigem `AccessFacade.assertCan` e `IdentityFacade.mfaPolicy`. `access` e `identity` não importam `tenancy` (sem ciclo).
- **Exceção registrada (US-104):** `catalog` (nível 1) importa as fachadas de `access` e `identity` (mesmo nível; `allow` em `tools/module-levels.json`) pelo mesmo motivo — os casos de uso de catálogo (CAT-02..06) exigem `AccessFacade.assertCan('CATALOG_MANAGE')` e `IdentityFacade.mfaPolicy`. `access` e `identity` não importam `catalog` (sem ciclo).
- **Exceção registrada (US-095):** `access` (nível 1) importa a fachada de `identity` (mesmo nível; `allow` em `tools/module-levels.json`) porque os comandos de perfil (ROL-03..08) exigem `ROLE_MANAGE` com MFA conforme `security.mfaPolicy` (`IdentityFacade.mfaPolicy`, POL-14). `identity` não importa `access` (sem ciclo).
- **Exceção registrada (US-102):** `organization` (nível 1) importa as fachadas de `access`, `identity` e `tenancy` (mesmo nível; `allow` em `tools/module-levels.json`): os casos de uso de unidade (DEP-03..09) exigem `AccessFacade.assertCan('DEPARTMENT_MANAGE')`, `IdentityFacade.mfaPolicy`, o órgão ativo (`TenancyFacade.organizationStatus`) e a elegibilidade de titular/substituto (lotação em `identity`, escopo do perfil em `access` — RN-TEN-48). Nenhum dos três importa `organization` (sem ciclo); `workflow`/`document` (nível 2) seguem usando a `OrganizationFacade`.
- **Porta registrada (US-091):** os casos de uso de convite e vínculo são do `identity`, mas exigem a permissão do ator e o perfil inicial (`access`) e as unidades da lotação (`organization`) — que já importam a fachada de `identity`. Em vez de uma exceção de nível (que criaria ciclo), a dependência é a porta `MembershipReferences` do shared kernel (`apps/api/src/shared/auth/membership-references.ts`), implementada por `access` e `organization` no `onModuleInit` (mesmo arranjo do `DocumentTypeCatalog`); sem provedor, falha fechada.
- Operações que alteram mais de um agregado (ex.: tramitação + aprovação + documento) usam **uma transação** coordenada por um caso de uso (Unit of Work), aceitável no monólito modular.

---

## 4. Arquitetura e stack

### DEC-050 — Stack · `Aceita`
| Camada | Escolha |
|---|---|
| Runtime | Node.js LTS ativo (24.x na data desta especificação), TypeScript 5.x `strict` |
| Frontend | Next.js (App Router), React, Tailwind CSS, shadcn/ui, Radix UI, React Hook Form, Zod, TanStack Query, TanStack Table, TipTap, next-intl (pt-BR) |
| Backend | NestJS (REST), Zod (validação), OpenAPI gerado dos schemas |
| Banco | PostgreSQL 17 (mínimo 16) com `pgvector`, `pg_trgm`, `unaccent`, `citext` |
| ORM | Prisma (migrações versionadas; SQL bruto para RLS, `tsvector`, triggers e partições) |
| Cache/filas | Redis 7 (ou Valkey compatível) + BullMQ |
| Autenticação | Authentik (OIDC, Authorization Code + PKCE) |
| Storage | S3-compatible (MinIO em dev, Amazon S3 em produção) |
| PDF | Gotenberg (Chromium) |
| Antivírus | ClamAV (clamd) |
| E-mail | SMTP (Mailpit em dev) / Amazon SES em produção, via abstração |
| IA | Camada própria `AiProvider` (OpenAI, Anthropic, Azure OpenAI): geração de documentos no MVP 1 (DEC-037, DEC-079; provedor em ADR-013 — PEND-21); assistente, validações e pgvector no MVP 5 |
| Observabilidade | pino, OpenTelemetry, Prometheus, Grafana, Loki, Tempo (dev); coletor OTel → backend gerenciado em produção |
| Testes | Vitest, Testcontainers, Supertest, Playwright, k6, axe-core, OWASP ZAP |
| Infra | Docker, Docker Compose (dev), AWS (ECS Fargate, RDS, ElastiCache, S3, ALB + WAF, SES, Secrets Manager, KMS), Terraform |

Versões exatas são fixadas no card de setup do monorepo (US-077).

### DEC-051 — Monorepo · `Aceita`
pnpm workspaces + Turborepo.
```
apps/
  web/        # Next.js (UI + BFF)
  api/        # NestJS (REST)
  worker/     # Node/NestJS standalone (filas, jobs agendados, relay do outbox)
packages/
  ui/              # design system (shadcn/ui + Radix + Tailwind)
  types/           # enums, constantes (permissões, eventos, códigos de erro), contratos de eventos
  validation/      # schemas Zod compartilhados (front e back), RuleContext
  editor/          # extensões TipTap + schema de conteúdo + serializador HTML (compartilhado web/worker)  ← adição proposta
  eslint-config/
  tsconfig/
```
`packages/editor` é adição justificada: o mesmo schema TipTap precisa existir no editor (web), na validação do backend (api) e na geração de HTML para PDF (worker).

### DEC-052 — Worker separado · `Aceita`
`apps/worker` reutiliza os módulos de domínio/aplicação e executa: consumidores BullMQ, jobs agendados, relay do outbox. Escala independente da API.

**Complemento (2026-10-28 · US-083/US-067/US-068/US-115):** os jobs dos módulos da API (`document-render`, `file-scan`, `ai-generation`) chegam ao worker pelo limite de pacote — `@contrataflow/api/jobs` (`exports` do `package.json` da API, `apps/worker` depende de `@contrataflow/api` no workspace) —, e não por alias de caminho: os `#shared/*`/`#config/*` de cada app resolvem pelo próprio `package.json` (Node subpath imports) e não colidem. O worker sobe um contexto Nest **sem HTTP** (`ApiJobsModule`: config, banco, storage, Gotenberg, antivírus, provedor de IA e os módulos de DEC-040 copiados sem controllers), com o seu logger, e executa os `TenantJob` pelo próprio `runJob` (timeouts, concorrência, DLQ). Configuração: o mesmo `.env`, sem as variáveis só de HTTP; dependência ausente pausa só a fila que depende dela. Detalhes em [queues.md](queues.md) §4.10.

### DEC-053 — BFF no Next.js · `Aceita` · [ADR-003](../adr/adr-003-authentication.md)
Browser → `apps/web` (`/api/auth/*` para login/callback/logout/sessão; `/api/v1/*` proxy para a API) → `apps/api`. Tokens nunca chegam ao browser. A API NestJS não é exposta à internet no MVP 1 (somente rede privada); a API pública chega no MVP 3.

### DEC-054 — Validação e contrato · `Aceita` · [ADR-010](../adr/adr-010-shared-validation.md)
Schemas Zod em `packages/validation` são a fonte única: React Hook Form (`zodResolver`) no front, `ZodValidationPipe` no Nest, tipos inferidos (`z.infer`) e OpenAPI 3.1 gerado. Validação de regra de negócio (dependente de estado) fica na camada `application`/`domain`, não no schema.

### DEC-055 — Concorrência · `Aceita`
- Otimista: coluna `version` (int) em agregados mutáveis; API usa `ETag`/`If-Match` (DEC-104).
- Autosave por seção: revisão por seção dentro de `draftContent` (conflito só quando duas pessoas editam a **mesma** seção).
- Pessimista pontual: `SELECT … FOR UPDATE` no processo durante tramitação/ciclo de vida e na sequência de numeração.
- Presença ("Fulano está editando"): chave Redis com TTL e heartbeat (P2).

### DEC-056 — Rich text · `Aceita`
TipTap/ProseMirror JSON armazenado em JSONB. Backend valida contra o schema permitido de nós/marks (`packages/editor`), rejeita nós desconhecidos e limita tamanho (padrão 1 MB por seção). HTML é gerado **somente no servidor** com as mesmas extensões e sanitizado antes do PDF. Imagens embutidas: PEND-08. Tabelas: permitidas.
- **Comentários (US-071, 2026-10-17):** schema restrito próprio — `commentContentSchema` (`validateCommentContent` em `packages/validation/src/collaboration`, usado pela API e pelo compositor): nós `doc`, `paragraph`, `text`, `bulletList`, `orderedList`, `listItem`, `hardBreak`, `mention` (só com a US-072) e marcas `bold`, `italic`, `link` (http/https/mailto, ≤ 2.048). Qualquer outro nó, marca ou atributo → 422 `RICH_TEXT_INVALID`, sem limpeza silenciosa; JSON ≤ 100 KB; texto derivado 1–10.000 caracteres. A leitura renderiza o JSON em nós React (nunca HTML).
- **Menções (US-072, 2026-10-18):** `mention` ativo (`allowMentions`); atributo fora do schema → `RICH_TEXT_INVALID` com a mensagem "Não foi possível salvar uma das menções do comentário.". No commit, alvo sem visibilidade (DEC-024 — usuário: concessão própria ou escopo de `PROCESS_VIEW` recalculado para o terceiro; unidade: `ProcessAccess` ativo e ≤ 50 membros ativos) é descartado em silêncio e o nó fica como rótulo simples; o comentário devolve `mentions[]` só com as válidas presentes no corpo. Enquanto o editor rico não chega ao web, o compositor reconhece o "@Rótulo" do candidato escolhido no autocomplete. O `NotificationDispatcher` passou a ter a fonte `ProcessVisibility` em SQL (mesmo predicado, para terceiros; sem atribuição gravada não há visibilidade por perfil) — antes dela nenhuma notificação de processo saía.

### DEC-057 — Busca · `Aceita`
PostgreSQL FTS (`portuguese` + `unaccent`) em coluna `search_vector` (tsvector gerado) + `pg_trgm` para número/código/título. Motor dedicado e busca semântica (pgvector) avaliados no MVP 5.

### DEC-058 — Infraestrutura cloud-agnostic · `Aceita`
Tudo em contêineres; dependências por protocolos abertos (PostgreSQL, Redis, S3 API, OIDC, SMTP, OTLP). AWS é a primeira nuvem; nenhum serviço proprietário no caminho crítico sem abstração.

### DEC-059 — Feature flags · `Aceita`
Flags por tenant em `TenantSetting` (`features.<nome>`), lidas por um `FeatureFlagService` com cache. Ferramenta dedicada (ex.: Unleash) avaliada quando houver necessidade de rollout percentual.
- **Implementação do registro (US-103):** as chaves de entities.md §6 (schema Zod, padrão, grupo, módulo dono, leitura pública) ficam em `packages/validation` (`SETTING_DEFINITIONS`), compartilhadas pela API e pela SCR-041; o `SettingsRegistry` do `tenancy` é montado no boot a partir das contribuições dos módulos e recusa chave duplicada. `features.<nome>` é booleana, padrão desligada, nunca pública e só é gravada quando alterada (não é semeada). O `PATCH /settings` em lote usa `expectedVersions` por chave no corpo (versão 0 = chave sem linha) e as chaves públicas do `SET-03` são `labels.*` e `branding.*` (RN-TEN-56).

### DEC-060 — Geração de PDF · `Aceita` · [ADR-007](../adr/adr-007-pdf-generation.md)
Worker gera HTML a partir do snapshot da versão + layout do template, envia ao Gotenberg, calcula SHA-256 do PDF, armazena no S3 e registra `DocumentRendition`. Rascunhos geram `PREVIEW` com marca d'água "RASCUNHO" (expira em 24 h). PDF/A-2b: PEND-09.

### DEC-061 — CI/CD com GitHub Actions · `Aceita`
Código no GitHub e CI/CD com GitHub Actions: estágios obrigatórios para *merge*, proteção de branch e ambientes `staging`/`production` com aprovação ([architecture.md §4.5](architecture.md), US-079). Decidido em 2026-10-07 (PEND-10 encerrada).

### DEC-062 — Escopo dos pacotes internos e donos de código · `Aceita`
- Pacotes do workspace chamam-se `@contrataflow/<nome>`, são `"private": true` e nunca são publicados em registry (RN-FND-04). Confirma a proposta de [architecture.md §4](architecture.md#4-monorepo).
- O `.github/CODEOWNERS` usa os times `@contrataflow/{engineering,tech-lead,security,platform,frontend,design,product}` como **nomes provisórios** até a organização do GitHub ser criada (PEND-20).
- O CODEOWNERS exige a aprovação de **um** dos donos listados; a exigência de Tech Lead **e** segurança nas áreas sensíveis da US-077 é configurada na proteção de branch / *ruleset* da `main` (US-079). Registrado em 2026-10-07 (US-077).

### DEC-063 — Ferramentas complementares da stack · `Aceita` · complementa DEC-050 e DEC-054
- NestJS 11 com `@nestjs/platform-express` (Express 5) — compatível com Terminus, throttler, pino-http e instrumentação OTel.
- OpenAPI 3.1 gerado dos schemas Zod por `@asteasolutions/zod-to-openapi` 8.x.
- API e worker em ESM (`"type": "module"`, `NodeNext`, *subpath imports* `#config/*`, `#shared/*`, `#modules/*`); build e `dev` com SWC (`decoratorMetadata`), typecheck com `tsc --noEmit`, testes com Vitest + `unplugin-swc` (esbuild não emite metadados de decorators).
- Versões exatas no catálogo do pnpm; linhas, motivos e medições em [`docs/engineering/versions.md`](../engineering/versions.md). Registrado em 2026-10-07 (US-077).

### DEC-064 — Prisma 7 com *driver adapter* · `Aceita` · [ADR-012](../adr/adr-012-prisma-tenant-transaction.md)
- Prisma ORM 7.x com `@prisma/adapter-pg` + `pg` 8.x (fixados no catálogo: 7.10.0 / 8.23.1); o *fallback* para Prisma 6.x foi descartado.
- O *spike* RT-02 (RLS + contexto por transação + reuso de conexão do pool) foi feito na US-081 com Testcontainers e registrado no ADR-012. Proposta registrada em 2026-10-07 (US-077); aceita em 2026-10-14 (US-081).

### DEC-065 — Ambiente local com Docker Compose · `Aceita` · complementa DEC-050 e DEC-058
- **Imagens fixadas por *tag* exata + *digest*** em `infra/docker-compose.yml` e `infra/compose/*.yml` (Renovate `docker:pinDigests`); linhas e motivos em [`docs/engineering/versions.md`](../engineering/versions.md) §8.
- **MinIO:** a imagem oficial `minio/minio`/`minio/mc` deixou de ser distribuída no Docker Hub (acesso negado desde 2025). Em dev usamos o *build* comunitário `pgsty/minio`/`pgsty/mc` (mesmo código-fonte AGPL do MinIO, mesma API S3), fixado por *digest*. Como só usamos a API S3 (DEC-058), a troca por SeaweedFS/Garage continua possível sem tocar na aplicação (storage.md §11). Produção usa S3.
- **Portas publicadas só em `127.0.0.1`** (nada do ambiente local fica exposto na rede da estação); a porta interna nunca muda, só a publicada (`*_PORT` no `.env`).
- **Usuários de desenvolvimento no Authentik** por *blueprint* gerado a partir do *dataset* do seed (`tools/env/seed/dataset.ts` → `pnpm env:blueprint`), com senha lida do ambiente (`!Env`); um teste falha se o *blueprint* versionado divergir do *dataset*.
- **Seed provisório:** até existir o schema real (US-081, provisionamento da US-099), `pnpm env:seed` grava os tenants semeados no schema **`dev_seed`** do banco `contrataflow` — fora de `public`, para não colidir com as migrações do Prisma —, com os nomes de tabela/coluna de `entities.md`, `tenant_id` + RLS `ENABLE`/`FORCE` e a política de DEC-082. O destino do seed passa às tabelas reais quando elas existirem — a US-081 só criou `outbox_events`; `tenants`, `users`, vínculos e catálogos chegam com as stories de identidade, tenancy e provisionamento (US-087/US-099/US-100), que então removem o schema `dev_seed`. Registrado em 2026-10-07 (US-078); revisto em 2026-10-14 (US-081).

### DEC-066 — Implementação do pipeline de CI · `Aceita` · complementa DEC-061
- **Workflows:** `.github/workflows/ci.yml` (PR, estágios 1–7), `images.yml` (estágio 6 reutilizável por `workflow_call`) e `deploy-staging.yml` (pós-merge: 6 com publicação, deploy, 8 e promoção). Depois da Higiene, os estágios 2–7 rodam **em paralelo** (caminho crítico ≈ Higiene + o mais lento); a ordem obrigatória da RN-FND-24 vale **dentro** do estágio Testes.
- **Proteção da `main` por *ruleset*** (não pela proteção de branch clássica), descrita em `.github/repository-settings.json` e aplicada por `pnpm ci:github-settings --apply`: required checks com `integration_id` do GitHub Actions (status forjado não conta), só *squash*, CODEOWNERS, sem *bypass* (nem administradores), regra `code_scanning` (CodeQL alto+ bloqueia) e **revisores obrigatórios por caminho** gerados do CODEOWNERS — cumpre a exigência "Tech Lead **e** segurança" de DEC-062 (cada time listado aprova; `platform` é apoio quando `security` também é dono).
- **FA-05 por job, não por `paths-ignore`:** o job Higiene calcula se o PR só toca `docs/**` e os estágios 4–7 são pulados por `if:` (check *skipped* conta como aprovado). `paths-ignore` no workflow faria os required checks nunca reportarem e o PR ficaria bloqueado para sempre. O estágio 6 tem um check consolidador (`6. Imagens`) porque check de matriz pulado não serve de required check.
- **Estágio 2** = `2. Estático` (lint, tipos, depcruise, actionlint, Semgrep com regras próprias em `.semgrep/rules/` e testes `semgrep --test`) + `2. Estático (CodeQL)`. CodeQL e a regra `code_scanning` exigem *GitHub Code Security* habilitado em repositório privado.
- **Estágio 3:** diff de OpenAPI próprio (`tools/ci/lib/openapi-diff.ts`), com a direção requisição × resposta; enquanto a US-080 não gera `apps/api/openapi/api.v1.json`, o estágio passa com aviso. O contrato versionado também precisa estar em dia com a geração (`OPENAPI_OUTDATED`).
- **Estágio 4:** cobertura via lcov do Vitest da API (`test` com `--coverage`) e gate do código novo por módulo em `tools/ci/coverage-gate.ts`. Suíte *tenant leak* = tarefa `test:tenant-leak` do Turborepo; hoje roda no banco (catálogo RLS/FK/unicidade + leitura cruzada com papel sem BYPASSRLS sobre as migrações do PR e o seed A/B) e recebe as suítes HTTP das stories de negócio. Matriz de autorização = tarefa `test:authz` (sem implementação até as stories de `access`).
- **Estágio 5:** migrações aplicadas por `psql` num PostgreSQL efêmero (mesma imagem do Compose): do zero e sobre o *snapshot* = migrações da última tag `v*` (ou da base, sem release ainda) + as novas. Lint expand/contract (destrutiva só com `-- cf:contract DEC-NNN`), migração publicada imutável e RLS na mesma migração. *Snapshot* **sem massa de dados** até existir o seed real (US-081). Quando a US-081 adotar `prisma migrate deploy`, só o aplicador muda.
- **Estágio 6:** `infra/docker/prod.Dockerfile` (turbo prune → build → dependências de produção do zero → runtime `-slim` não-root, sem npm/corepack/yarn e com as correções de segurança do Debian aplicadas no build). Gate de CVE próprio sobre o JSON do Trivy (`--ignore-unfixed` não é usado: CVE sem correção é registrada) com exceções com prazo em `.github/ci-policy.yml`. PR: registry local efêmero e assinatura cosign com chave descartável (sem segredo, funciona em fork); pós-merge: ECR por OIDC, assinatura *keyless* + atestado do SBOM, verificação da assinatura antes do deploy.
- **Estágio 7:** Playwright + axe-core em `apps/web/test/e2e` contra o build de produção, com o Compose da US-078 (Authentik real) num projeto próprio por execução (`COMPOSE_PROJECT_NAME`, agora lido do `.env` pelos scripts `env:*`).
- **Estágio 8:** ZAP baseline (`.github/zap/rules.tsv`), k6 smoke (`.github/k6/smoke.js`, p95 < 500 ms) e trace com `traceparent` conhecido consultado no backend (API do Tempo); falha alerta `#cf-ci` e bloqueia o job de promoção (ambiente `production` com aprovação do Tech Lead). O workflow só roda com a variável `CF_STAGING_ENABLED=true` e para merges de *maintainer*.
- **Política versionada** em `.github/ci-policy.yml` (`ci.coverageThreshold`, `ci.coverageGateEnabled`, licenças e exceções, exceções de CVE): está sob CODEOWNERS de `.github/`, então a aprovação do PR é o registro da exceção. Licenças verificadas só no runtime de api/web/worker; exceções iniciais: `caniuse-lite` (CC-BY-4.0, dados) e o libvips do `sharp` (LGPL, linkagem dinâmica). Registrado em 2026-10-14 (US-079).

### DEC-067 — Repositório público e aprovação com mantenedor único · `Aceita` · flexibiliza DEC-062 e DEC-066 enquanto houver uma só pessoa mantenedora
- **Repositório público** na organização `contrataflow` do GitHub, por decisão do produto em 2026-10-14. No plano gratuito ficam disponíveis rulesets, CODEOWNERS e CodeQL, sem *GitHub Code Security*. Todo o conteúdo versionado e o histórico ficam públicos: nenhum segredo no repositório (DEC-137) e atenção a material de terceiros, como imagens de referência.
- **Mantenedor único:** o GitHub não deixa ninguém aprovar o próprio PR, e com uma só pessoa a aprovação obrigatória de CODEOWNERS (DEC-062/DEC-066) bloquearia todo merge. Enquanto for assim, a ruleset da `main` funciona assim:
  - não exige nenhuma aprovação;
  - não exige revisão de CODEOWNERS nem aprovação do último push;
  - não tem revisores obrigatórios por caminho (`teamReviewersFromCodeowners: false` em `.github/repository-settings.json`).
- **Continuam valendo:** os required checks 1–7 emitidos pelo GitHub Actions, a regra `code_scanning`, o histórico linear, o merge só por *squash* e a ausência de *bypass*.
- **Produção:** o ambiente `production` mantém a aprovação do time `tech-lead`, com `prevent_self_review: false`: a pessoa que mescla aprova a promoção. Para o `pnpm ci:github-settings -- --apply`, só o time `tech-lead` precisa existir.
- **Reverter quando** a segunda pessoa entrar nos times `tech-lead`/`security`:
  - `required_approving_review_count: 1`;
  - `require_code_owner_review: true`;
  - `require_last_push_approval: true`;
  - `teamReviewersFromCodeowners: true`;
  - `prevent_self_review: true`.

  Depois reaplicar com `pnpm ci:github-settings --apply`. `tools/test/ci-pipeline.test.ts` cobre os dois modos. Registrado em 2026-10-14 (US-079).

### DEC-068 — Entrega por lote: um commit por card e um PR por lote · `Aceita` · complementa DEC-066 e DEC-067
- **Contexto:** a `main` do GitHub só aceita PR (DEC-066/DEC-067). Os cards rodam em sequência, pelos workers do ddx, na mesma pasta e sobre a `main` local. Workers que terminavam sem commit misturavam o trabalho de uma story com o da seguinte.
- **Decisão do produto (2026-10-14):**
  - cada card termina com **um commit** na `main` local; as regras para os agentes ficam no `AGENTS.md`, fora do bloco do Turborepo;
  - o mantenedor promove um **lote** de cards, por exemplo uma sprint;
  - com a fila vazia, o piloto envia o lote para um branch `lote/<nome>` e abre o PR;
  - com o pipeline verde e o aval do mantenedor, o lote entra por **rebase**, ficando um commit por story na `main`;
  - por fim, o piloto realinha a `main` local com a do GitHub.
- **Métodos de merge:** a ruleset aceita `squash` nos PRs avulsos (o título do PR vira o commit) e `rebase` nos lotes (os commits dos cards entram como estão, já validados pelo commitlint no hook local). `required_linear_history` continua valendo.
- **Alternativa descartada:** um PR por card com merge automático. Exigiria e-mail verificado na conta do GitHub, branch por card nos workers e a fila parada até cada merge.
- Registrado em 2026-10-14 (US-079).

### DEC-087 — Verificação enxuta por card e preset por tipo de card · `Aceita` · complementa DEC-068
Em 2026-10-15 o ritmo era de ~1 card por hora, em série, com sessões de worker em Opus xhigh relendo ~62 milhões de tokens por card; a cota de uso virou o gargalo.
- **DoD enxuta:** no card, rodam os testes do módulo tocado e `pnpm turbo run lint typecheck test` uma vez. As suítes completas (`test:integration`, `test:tenant-leak`, `test:e2e`) e os benchmarks de p95 rodam no CI do PR do lote (`ci.yml`) e no endurecimento. A DoD da story não muda: todo cenário Gherkin (8 categorias) continua com teste automatizado. Regra operacional no `AGENTS.md`.
- **Preset por tipo de card:** `claude-code` (Opus xhigh) só em US-001, US-041, US-047, US-051, US-052, US-065, US-097 e US-105; `claude-code-sonnet` nas stories S e nos CRUDs simples de administração (US-007, US-018, US-025, US-027, US-049, US-061, US-069, US-098, US-101, US-103, US-104, US-106, US-113); `claude-code-opus-high` nas demais. Cards novos seguem a mesma regra.
- **Consequência:** menos tempo e cota por card; o PR do lote passa a ser o ponto de verificação completa, e uma falha ali volta como card de correção.

### DEC-069 — Implementação da persistência · `Aceita` · complementa DEC-064, DEC-082 e DEC-055 · [ADR-012](../adr/adr-012-prisma-tenant-transaction.md)
- **Acesso a dados:** provider global `TenantTransaction` (`apps/api/src/shared/database`) com `run` (comando) e `read` (consulta em transação somente leitura); cada chamada abre a transação com `set_config('app.tenant_id', …, true)` como primeira instrução. O `PrismaClient`, o *adapter* e o `pg` ficam só em `shared/database/**` (lint `contrataflow/no-prisma-client-outside-database`); os repositórios recebem o `tx` e importam tipos de `#shared/database/prisma.js`.
- **Papéis:** criados pela migração inicial em bloco idempotente e sem senha; em produção a infraestrutura cria os papéis de login (senha no Secrets Manager) e concede `CREATE` em `public` ao `cf_migrator` antes do primeiro deploy. Toda migração cria objetos depois de `SET ROLE cf_owner`; a checagem de catálogo do CI reprova objeto com outro dono no schema `public`.
- **Catálogo (V-02/V-03):** além de RLS, FK composta e unicidade, o CI reprova `tenant_id` nulo fora de `audit_logs`/`outbox_events` e tabela sem `tenant_id` fora de `tenants`/`users`/`permissions`/`_prisma_migrations` (lista fechada de DEC-080).
- **Lint de SQL (RN-FND-44):** `pnpm ci:sql-lint` (estágio `2. Estático`) e o lint das migrações novas (estágio `5. Migrações`) barram `set_config` cujo terceiro argumento não é o literal `true` e `SET [SESSION] app.*`, em migrações, no código e nos testes das apps e nos scripts de init do PostgreSQL.
- **Decimais (DEC-003):** o mapeador `toDbDecimal` **recusa** valor fora da escala ou da precisão da coluna (`DecimalScaleError`); arredondar é sempre explícito (`roundTo`, `ROUND_HALF_UP`). Leitura com `fromDbDecimal` (decimal.js 10.6.0).
- **Erros:** *deadlock*/serialização → até 2 retentativas da transação inteira; conexão/tempo de espera → `DatabaseUnavailableError` (503 `DEPENDENCY_UNAVAILABLE`, `Retry-After: 5`); `UPDATE` versionado com 0 linhas → `VersionConflictError` (412 `VERSION_CONFLICT`). Tempos: espera do pool 2 s, transação 10 s, `statement_timeout` 5 s (architecture.md §6.5).
- **Variáveis:** `DATABASE_URL` (papel `cf_app`, obrigatória) e `DATABASE_POOL_SIZE` (padrão 10) na API; `DATABASE_MIGRATION_URL` só para a CLI do Prisma (`prisma.config.ts`). Em dev, `pnpm db:migrate` aplica as migrações e define a senha local dos papéis. Registrado em 2026-10-14 (US-081).

### DEC-070 — Implementação do login OIDC e da sessão do BFF · `Aceita` · complementa DEC-130, DEC-131, DEC-132 e DEC-082
Fecha as lacunas 1–6 da US-087 (detalhes em [authentication.md](authentication.md) §3–§5):
- **Contrato BFF → API de sessão:** `POST /internal/session-events`, fora de `/api/v1` (o proxy do navegador só encaminha `/api/v1/*`), fora do OpenAPI público, com o access token do usuário **e** a credencial de serviço do BFF (`X-CF-Service-Token` = `INTERNAL_SERVICE_TOKEN`, comparada em tempo constante; sem ela configurada, a rota recusa tudo). `SESSION_STARTED` sem `tenantId` resolve a identidade (vínculo do `sub`, `lastLoginAt`, vínculos); com `tenantId` ativa a instituição e grava `auth.session_start`; `TENANT_SWITCHED` grava `auth.tenant_switch`. A rota valida o JWT mas aceita `sub` ainda não vinculado (`@AllowUnboundSubject()`). A seleção da instituição (RN-IAM-09) é do BFF.
- **Cookies e Redis de sessões:** transação de login em `__Host-cf_auth_tx` (AES-256-GCM, até 3 transações, 10 min); sessão em `cf:{env}:sess:{sha256(sid)}` com os tokens cifrados (AES-256-GCM, AAD = chave da sessão) e TTL até o fim absoluto; índice `cf:{env}:sess:user:{userId}` (sorted set) limita 10 sessões por usuário; limite de login por IP em `cf:{env}:rl:auth:{ip}:{janela}`. Uma chave mestra (`SESSION_ENCRYPTION_KEY`) gera subchaves por finalidade (HKDF-SHA256).
- **Leitura entre tenants:** função `cf_user_memberships(user_id)` `SECURITY DEFINER`, dona `cf_definer` (papel `NOLOGIN` com `BYPASSRLS`, sem outro privilégio), `search_path` fixo, colunas mínimas, e que só responde quando `p_user_id = app.user_id` da transação. A API acessa `users`/`tenants` e a função pelo `PlatformTransaction` (`shared/database/platform-transaction.ts` — sem `app.tenant_id`, então tabelas com RLS falham fechadas), cujo uso fica restrito por dependency-cruiser aos adaptadores de `identity`/`tenancy` (`platform-transaction-allowlist`). `tenants` nasce aqui (US-087) por precisar do status da instituição; a US-100 acrescenta o `SystemDbService` e as demais funções.
- **JWT:** API e BFF verificam com `jose` (RS256/ES256; `none`/HMAC recusados). A API mantém cache próprio do JWKS (10 min; `kid` desconhecido força 1 renovação a cada 30 s; JWKS fora do ar → chaves conhecidas continuam valendo e `kid` desconhecido vira 503 `DEPENDENCY_UNAVAILABLE` com alerta). `OIDC_FAKE_SIGNING_KEY` vira modo de identidade fake restrito a `local`/`dev`/`test`.
- **Erros:** usuário bloqueado → 403 `PERMISSION_DENIED` com extensão `reason: USER_BLOCKED` (o código `USER_BLOCKED` segue proposto); sem `User` correspondente ao `sub` → 403 `MEMBERSHIP_INACTIVE` ("sem vínculo"). Registrado em 2026-10-14 (US-087).
- **Revisão (2026-10-28 · DEC-187):** o login deixou de passar pelo navegador no Authentik — a tela é nativa e o BFF conduz o *flow* pelo executor; a transação `__Host-cf_auth_tx` e o callback seguem só para o *step-up* e o atalho do provedor fake.

### DEC-071 — Implementação da auditoria transacional · `Aceita` · complementa DEC-025, DEC-084, DEC-138, DEC-161 e [ADR-009](../adr/adr-009-audit-trail.md)
Decisões de implementação da US-073 (detalhes em `apps/api/src/modules/audit/README.md`):
- **Onde fica:** o `AuditService` é do módulo `audit`, que é **global**; os demais módulos (inclusive os de nível 1, que pela DEC-040 não importam `audit`) e o pipeline HTTP injetam a porta `AUDIT_TRAIL` do shared kernel (`apps/api/src/shared/audit`). `record(tx, entry)` grava no `tx` do caso de uso; `recordStandalone(entry)` serve às ações cujo único efeito é a própria auditoria (acesso negado, início de sessão) e abre a transação do tenant do contexto — ou de plataforma, sem tenant. V-03 é verificado por registro das transações ativas da `TenantTransaction`/`PlatformTransaction` (o `tx` de transação encerrada também é recusado).
- **Catálogo e categoria:** `AUDIT_ACTIONS` (`packages/types/src/audit.ts`) espelha events.md §7 (teste compara com a tabela) e fixa a categoria de cada ação; o caso de uso não a informa.
- **`access.denied`:** gravado pelo filtro RFC 9457 para `PERMISSION_DENIED`, `MFA_REQUIRED`, `MEMBERSHIP_INACTIVE` e `TENANT_SUSPENDED`, com `reasonCode` = `ApiError.auditReasonCode` (a permissão ausente) ou o código do erro. Antes de o pipeline validar o tenant (sem vínculo, tenant suspenso, cabeçalho inválido), a negação vira **registro de plataforma** (`tenant_id` nulo, `metadata.requestedTenantId`): quem não tem vínculo não escreve na trilha de um tenant. Falha ao gravar a negação não muda a resposta (403) e fica em `error audit.write_failed`. 401 não é negação de autorização e não é gravado.
- **Banco:** `audit_logs` particionada por mês (RANGE em `occurred_at`, limites em UTC), sem `DEFAULT` em `id`/`occurred_at` (ambos entram no hash); trigger barra `UPDATE`/`DELETE`/`TRUNCATE`; `cf_app`/`cf_worker` só com `INSERT`/`SELECT`. RLS: `tenant_isolation` (SELECT, padrão estrito), `tenant_insert` e `platform_insert` (INSERT de `tenant_id` nulo só numa transação sem `app.tenant_id`); as de INSERT toleram `app.tenant_id` ausente (`NULLIF`) porque são avaliadas juntas. Sem leitura de registros de plataforma pela aplicação (o papel `cf_platform` chega com a US-100), por isso o INSERT é SQL bruto **sem RETURNING**.
- **Partições:** função `cf_audit_ensure_partitions(meses)` (`SECURITY DEFINER` da **dona da tabela, `cf_owner`** — só ela pode criar partições; `search_path` fixo, parâmetro limitado a 0..12, trava consultiva), que cria o mês corrente e os seguintes com RLS `ENABLE`+`FORCE` e as mesmas políticas. A migração já cria 3 meses; o job diário roda **na API** (agendador em processo, ao subir e a cada 24 h, idempotente entre réplicas) até o worker ter agendador (US-083). Partição ausente → INSERT falha (SQLSTATE 23514), a transação de negócio é desfeita, 503 `DEPENDENCY_UNAVAILABLE` e `error audit.partition_missing`.
- **Coalescência:** o estado (`scope`, `revision`, `size`) fica em `metadata.coalesce` do registro gravado e a decisão lê o último registro da chave no próprio `audit_logs`, dentro da transação — rollback nunca deixa uma janela "aberta" sem registro, e o autosave não depende do Redis. A amostragem de `access.denied` usa contadores Redis (`cf:{env}:t:{tenantId}:audit:ad:{hash}` / `cf:{env}:p:…`); Redis fora → grava tudo (`warn audit.sampling_unavailable`).
- **Contexto do cliente:** a API aceita `X-Forwarded-For` (último salto) e `X-CF-Session-Id-Hash` só de `TRUSTED_PROXY_CIDRS` (IPv4/IPv6); o BFF repassa o IP, o `User-Agent` do navegador e o hash da sessão em toda chamada à API (proxy, Server Components e `session-events`). O IP é normalizado como o `inet` o devolve (IPv4 mapeado → IPv4), para o `rowHash` ser recalculável com `host(ip)`.
- **Ator:** `actorName` = nome exibido do usuário (congelado na autenticação) ou, para `SYSTEM`, o nome do job (FA-01 prevalece sobre RN-AUD-02, que foi ajustada); usuário não identificado em negação grava `actorType = USER` com `actorUserId` nulo.
- **Meta-teste (RN-AUD-09):** `@ApiOperation({ auditActions })` (ou `auditExempt` justificado) vira `x-audit-actions`/`x-audit-exempt` no OpenAPI; `src/openapi/audit-coverage.spec.ts` varre todas as rotas mutáveis (inclusive internas) e também reprova handler mutável sem `@ApiOperation`.
- Registrado em 2026-10-14 (US-073).

### DEC-072 — Implementação do outbox transacional e do relay · `Aceita` · complementa DEC-052, DEC-085, DEC-160..164 e [ADR-004](../adr/adr-004-outbox-events.md)
Decisões de implementação da US-082 (guia de uso em `apps/api/src/modules/platform/README.md`; operação em [queues.md](queues.md) §5 e §7):
- **Definição de evento:** `defineDomainEvent({ eventType, eventVersion, aggregateType, payload, routingKey })` em `packages/validation/src/events` — `payload` é o schema Zod do evento e `routingKey` é fixa ou calculada do payload (DEC-162: o nome especializado é só a routing key, nunca outra linha). O registro `DOMAIN_EVENT_DEFINITIONS` espelha `DOMAIN_EVENT_NAMES` (`packages/types`) e todo nome tem decisão de roteamento no worker (V-03, testes nos dois pacotes). Payload limitado a 16 KB serializado.
- **Escrita (`OutboxWriter`):** porta `OUTBOX_WRITER` no shared kernel da API (`apps/api/src/shared/outbox`), implementada no módulo `platform`, que passa a ser **global**. `record(tx, Evento.of({ aggregateId, processId, payload }))` exige `tx` ativo da `TenantTransaction` (como o `AuditService`), monta o envelope a partir do `RequestContext` (`tenantId`, `actor`, `correlationId`; ator `ANONYMOUS` é recusado), valida envelope e payload antes do `INSERT` (erro = bug de programação → 500 `INTERNAL_ERROR`, transação desfeita) e grava `occurred_at = clock_timestamp()` (após o lock do agregado — queues.md §5.4) seguido de `pg_notify('cf_outbox', '')`. `traceparent`/`tracestate`, `actor`, `correlationId` e `causationId` vão em `metadata`. Eventos de plataforma (`tenant_id` nulo) não são graváveis pela aplicação enquanto não houver produtor (RLS os recusa).
- **Handlers síncronos:** registro `SYNC_EVENT_HANDLERS` (mesmo shared kernel) com lista fechada de nomes — `TimelineProjector` e `ProcessAccessProjector` (RN-FND-52); registrar outro nome falha na subida. Rodam logo depois do `INSERT`, no mesmo `tx` (RLS do tenant), e qualquer erro desfaz agregado, evento e projeções. As implementações concretas chegam com as stories donas (US-059 timeline; `ProcessAccess` com US-001/US-047).
- **Relay (worker, `apps/worker/src/outbox`):** papel `cf_relay` por `DATABASE_URL_RELAY`; o driver `pg` fica só em `apps/worker/src/shared/database` (mesma regra de lint da API). Líder único por `pg_try_advisory_lock(hashtextextended('cf:outbox-relay', 0))` numa conexão de sessão dedicada que também faz `LISTEN cf_outbox`; réplicas em espera tentam a cada 5 s; queda da conexão = perda da liderança (`warn outbox.relay_leader_lost`). Ciclo: transação em outra conexão, `SELECT … FOR UPDATE SKIP LOCKED` de até 100 linhas `PENDING` vencidas por `(occurred_at, id)`, validação por linha (envelope DEC-160 e 16 KB), `addBulk` na fila `domain-events` (`jobId = eventId`, prefixo BullMQ `cf:{env}:q`) e `UPDATE … PUBLISHED, published_at = now(), attempts + 1` no mesmo `COMMIT`. *Polling* de 500 ms ocioso; lote cheio repete sem espera. Falha de Redis ou PostgreSQL no ciclo → `ROLLBACK` e espera de 1 s dobrando até 30 s.
- **Linha inválida:** só ela recebe `attempts + 1`, `last_error` resumido (≤ 500 caracteres, sem payload) e `next_attempt_at` = backoff exponencial com *jitter* (base 5 s, teto 15 min — a fórmula de queues.md §10.1); na 10ª tentativa vira `FAILED` com `error outbox.relay_failed_permanently` e a métrica `cf_outbox_failed_total`.
- **Fan-out (`apps/worker/src/events`):** `DomainEventsProcessor` com a tabela de rotas de queues.md §7.2 (padrões com `*`), conjunto de filas-destino com `jobId = eventId` (hoje só `notifications`) e handlers leves *inline* — `PermissionCacheInvalidator` (`DEL cf:{env}:t:{tenantId}:access:eff:{membershipId}`, ou de todas as chaves do tenant por `SCAN` quando o payload não traz `membershipId`) e `BusinessMetricsCollector` (contador por `event_type`) — deduplicados por `SET NX EX 86400` em `cf:{env}:t:{tenantId}:evt:{consumer}:{eventId}`. O cliente Redis do worker fica em `apps/worker/src/shared/cache`. O consumo pleno com `runJob`, DLQ e Bull Board é da US-083.
- **Purga (DEC-085):** papel `cf_maintenance` (LOGIN, `BYPASSRLS`, só `SELECT`/`DELETE` em `outbox_events` — `cf_relay` continua sem `DELETE`), variável `DATABASE_URL_MAINTENANCE`; a rotina apaga `PUBLISHED` com `published_at` anterior a 7 dias em lotes de 5.000 e nunca toca `PENDING`/`FAILED`. O agendamento diário (`maintenance` → `outbox-purge`) é da US-083.
- **Observabilidade:** logs `outbox.relay_batch_published` (`batchSize`, `lagMsP95`), `outbox.relay_retry`, `outbox.relay_failed_permanently`, `outbox.relay_leader_acquired`/`outbox.relay_leader_lost` e `outbox.relay_cycle_failed`, sem payload. Métricas OpenTelemetry (no-op até a US-085 registrar o provedor): `cf_outbox_published_total`, `cf_outbox_publish_errors_total`, `cf_outbox_failed_total`, `cf_outbox_publish_lag_seconds`, `cf_outbox_batch_size`, `cf_outbox_batch_duration_seconds`, `cf_outbox_relay_leader` e, na API, `cf_outbox_recorded_total`. Os *gauges* que dependem de consulta ao banco (`cf_outbox_pending_events`, `cf_outbox_oldest_pending_age_seconds`, `cf_outbox_failed_events`) ficam com a US-085.
- Registrado em 2026-10-15 (US-082).

### DEC-073 — Logout, expiração e varredura de sessões · `Aceita` · complementa DEC-070, DEC-071, DEC-131, DEC-132 e DEC-164
Fecha as lacunas 1–4 da US-088 (detalhes em [authentication.md](authentication.md) §4.1):
- **Encerramento sem tokens:** todo fim de sessão (logout, ociosidade, duração absoluta, renovação recusada, limite de sessões, vínculo) troca o registro vivo por um registro de encerramento (`cf:{env}:sess:end:{key}`, 24 h) com motivo e horário real do fato; a sessão viva só é gravada com `SET XX`. O protocolo (`sessionKeyspace` em `@contrataflow/types`, `endSession` em `@contrataflow/validation`) é único para BFF, API e worker, sem script Lua.
- **Auditoria pela varredura na API:** `auth.session_end`/`auth.session_expired` são gravados pela varredura de 1 min no processo da API (como o job de partições da DEC-071) até o worker ter agendador (US-083) — só a API tem o `AuditService` (`rowHash`, partições, RLS). Cada registro na transação do tenant da sessão, ator = dono da sessão, `occurredAt` = horário real (`AuditEntry.occurredAt`, recusado no futuro) e `oncePerSession` (no máximo um registro por tenant + ação + horário + `sessionIdHash`); o registro de encerramento sai do Redis só depois do commit. Diverge do "mesma transação" da DEC-161 porque o logout não tem transação de banco (lacuna 3 da story).
- **Encerramento por vínculo no worker:** índice `cf:{env}:sess:membership:{membershipId}` mantido pelo BFF (o payload dos eventos de vínculo só traz `membershipId`), em vez de ler `tenant_memberships` no worker; handler leve nas routing keys `membership.suspended|revoked|expired`, sem registrar os eventos (US-092).
- **Sondagens:** `GET /api/auth/session` sem parâmetro e `GET /notifications/unread-count`/`/tasks/counters` não renovam a ociosidade; `?keepalive=true` renova (lacuna 1).
- **Limites por instituição:** a sessão guarda `idleMinutes` e recalcula os prazos na ativação da instituição; até a US-103 expor as chaves (lacuna 4), o padrão 30 min / 12 h.
- **Reautenticação após expiração (RN-IAM-32):** cookie `__Host-cf_reauth` gravado com o 401 `SESSION_EXPIRED` e `?reauth=1` no login → `max_age=0` + `prompt=login`; refresh token do Authentik válido por 24 h (teto da plataforma).
- **Logout:** sem `id_token_hint` no *RP-initiated logout* (mantém a DEC-070 — a story pedia o parâmetro; em computador compartilhado o token ficaria no histórico); `post_logout_redirect_uri` = `/entrar?motivo=saiu`; Authentik indisponível → `saiu-parcial`. O CSRF do logout continua `403 CSRF_REJECTED` (padrão do BFF desde a US-086), não `PERMISSION_DENIED`.
- **Revisão (2026-10-28 · DEC-187):** o logout não leva mais o navegador ao *end-session* (o Authentik 2026.8 recusa `post_logout_redirect_uri` sem `id_token_hint`); `saiu-parcial` deixou de existir e o `?reauth=1` só leva a `/entrar?motivo=sessao-expirada` — o login nativo sempre pede a senha.
- Registrado em 2026-10-14 (US-088).

### DEC-074 — Recuperação de senha no Authentik · `Aceita` · complementa DEC-012, DEC-070, DEC-073 e DEC-130
Decisões de implementação da US-089 (detalhes em [authentication.md](authentication.md) §8):
- **Rota do BFF:** `GET /api/auth/forgot-password` monta `/if/flow/<slug>/` na origem do emissor OIDC (`OIDC_RECOVERY_FLOW_SLUG`, padrão `contrataflow-recovery`), sem nenhum parâmetro, e antes de redirecionar confere a página do *flow* (GET, 2 s; resultado positivo vale 10 s). Sem resposta 200 — IdP fora do ar ou *flow* não publicado — o navegador vai para SCR-002 `/recuperar-senha?motivo=indisponivel` (com `returnTo`) e o log é `warn auth.recovery_unavailable`; não há 503 porque a rota é navegação de página. Mesmo limite de 20/min por IP das rotas de login, no mesmo contador.
- **`returnTo` (FA-05):** guardado no cookie `__Host-cf_recovery_rt` (1 h, revalidado na leitura) e devolvido por `/entrar?motivo=senha-redefinida`; quando a recuperação parte do formulário do Authentik, vale o `returnTo` da transação de login mais recente ainda aberta (10 min). O login seguinte apaga o cookie; o Authentik nunca recebe o destino.
- **Flow (blueprint `12-contrataflow-recovery.yaml`):** identificação só por e-mail com `pretend_user_exists` → e-mail com template próprio em pt-BR (`infra/authentik/templates`, montado em `/templates`), link de 30 min, até 5 envios a cada 5 min por e-mail, sem reativar conta desativada no IdP → nova senha com a política `contrataflow-password-policy` (12 caracteres; Have I Been Pwned sem tolerância; zxcvbn 0–1 recusada) → gravação. O HIBP exige saída à internet e falha fechada. O uso único do link é do próprio Authentik: a confirmação que ele intercala consome o token; reabrir o link recomeça o pedido.
- **Fim do flow e sessões anteriores:** uma política de expressão avaliada na gravação da senha (a) põe `redirect = /entrar?motivo=senha-redefinida` no plano — o executor conclui o *flow* e limpa o plano (um *redirect stage* deixaria o plano parado na sessão do navegador, e um novo pedido voltaria direto a SCR-001) — e (b) apaga as sessões do usuário no Authentik e os refresh tokens emitidos: sessões abertas do ContrataFlow terminam na renovação seguinte (`REFRESH_FAILED`, US-088), dentro da vida do access token. O *flow* não autentica ninguém (sem `user_login`): a entrada segue o login normal, com o segundo fator quando exigido.
- **Ponto de entrada no IdP:** `recovery_flow` da etapa de identificação do login (o link "Esqueci minha senha" do formulário) e `flow_recovery` da marca apontam para o mesmo *flow*.
- Registrado em 2026-10-14 (US-089).

### DEC-075 — Troca de instituição ativa na sessão · `Aceita` · complementa DEC-012, DEC-070, DEC-073, DEC-132 e DEC-133
Decisões de implementação da US-093 (detalhes em [authentication.md](authentication.md) §6):
- **Contrato pelo vínculo:** `POST /api/auth/switch-tenant` recebe `{ membershipId, setAsDefault? }` e a API é quem confere o vínculo (`TENANT_SWITCHED` em `/internal/session-events` com `membershipId`): vínculo de outra pessoa → 422 `VALIDATION_ERROR`/`REFERENCE_NOT_FOUND`, sem o BFF decidir pela lista em cache da sessão (que pode estar velha nos dois sentidos). Trocar para o vínculo já ativo é no-op no BFF (sem chamada, sem auditoria); com "Usar como padrão", a API só grava a instituição padrão.
- **MFA do destino:** a entrada na instituição exige segundo fator só com `security.mfaPolicy = ALL` (com `ADMINS`, o MFA é cobrado na ação `HIGH` — POL-14). A API responde 200 com `mfaRequired = true` e não grava nada; o BFF guarda a troca pendente **na sessão** (10 min, junto do `setAsDefault`) e responde 403 `MFA_REQUIRED` com `stepUpUrl` — não 302, porque a chamada vem de `fetch` e o redirecionamento ao Authentik seria seguido sem navegação. O retorno do *step-up* conclui a troca com o token novo; recusada, a sessão fica na instituição anterior e SCR-101 mostra o aviso. Nunca por parâmetro de URL (o GET do *step-up* não pode trocar a instituição de ninguém). A política vem de `tenant_settings` (adaptador `SettingsTenantMfaPolicy` do `identity`, sobre a fonte que o `tenancy` registra na porta `TenantMfaSettings` do shared kernel; cache de 60 s por tenant apagado no commit do SET-02 e pelo `TenantSettingsChanged` no `ConfigCacheInvalidator` — RN-IAM-42); sem a chave gravada, vale o padrão `ADMINS`. A checagem é só na troca; no login (AUTO/DEFAULT/primeira escolha) fica com a US-090.
- **Escrita atômica da sessão:** toda gravação de sessão viva do BFF passou a ser leitura-modificação-gravação sobre o registro mais recente (`SessionStore.update`; no Redis, *compare-and-set* por script Lua sobre o valor lido, refeito com espera aleatória curta, 503 depois de 64 tentativas). Cada escrita muda só os seus campos — a troca não desfaz uma renovação de token feita em paralelo, e o `touch` de uma requisição em voo não desfaz a troca. O registro continua um JSON único (`SET`), sem mudar o protocolo de encerramento da DEC-073. No mesmo processo, trocas da mesma sessão são atendidas em fila (`SessionService.exclusive`).
- **Instituição padrão:** `User.preferences.defaultTenantId` (jsonb, sem migração), gravada só como chave do jsonb e sem incrementar `version` (não faz parte do perfil de ME-01/ME-02); devolvida em `defaultTenantId` pelo `session-events` e usada pela seleção `DEFAULT` do login (RN-IAM-09).
- **Front:** a troca apaga o cache de consultas antes de navegar ao início (`HOME_PATH`, até o painel existir) e avisa as outras abas; erro 422 recarrega a lista, `MEMBERSHIP_INACTIVE` tira o vínculo das opções.
- Registrado em 2026-10-15 (US-093).

### DEC-076 — Contexto de tenant e isolamento de dados · `Aceita` · complementa DEC-080..083, DEC-105, DEC-132, DEC-139, DEC-164 e [ADR-002](../adr/adr-002-multi-tenancy.md)
Fecha as lacunas 1–6 da US-100 (detalhes em [multi-tenancy.md](multi-tenancy.md) §4–§9 e §14; guia de uso em [`docs/engineering/data-access.md`](../engineering/data-access.md)):
- **Classificação de rotas:** toda rota declara `@TenantScope('TENANT' | 'PLATFORM' | 'NONE' | 'CROSS_TENANT_LOOKUP')` (substitui o `@WithoutTenant()` da US-080); meta-teste reprova rota sem declaração e, em tempo de execução, a ausência vale `TENANT` (falha fechada). O OpenAPI expõe `x-tenant-scope`. `@OffboardingExport()` marca os comandos de exportação liberados em `OFFBOARDING` (RN-TEN-37), com `accessMode = READ_EXPORT` no contexto.
- **Guard:** `X-Tenant-Id` ausente ou malformado → **400 `MALFORMED_REQUEST`** com `errors[{ field: 'X-Tenant-Id' }]` (muda o 403 da US-080 — não revela nada, porque não há tenant); vínculo antes do status, com resposta idêntica para tenant inexistente e sem vínculo (403 `MEMBERSHIP_INACTIVE`); status pelo `TenantStatusCache` (`cf:{env}:p:tenant-status:{tenantId}`, 30 s, também para tenant inexistente; Redis fora → banco + `warn tenant.status_cache_unavailable`). O tenant do contexto é **imutável** (`TenantContextImmutableError`); o BFF trata o 400 do cabeçalho refazendo a seleção (SCR-101).
- **Extensão do Prisma (`tenant-isolation`):** aplicada antes da `TenantTransaction` no único cliente da aplicação; o tenant vem do **escopo da transação** (AsyncLocalStorage aberto pela `TenantTransaction`), não da requisição — um caso de uso `PLATFORM`/`SYSTEM` abre transação para um tenant alvo com `runForTenant` (RN-TEN-21: dentro de contexto `TENANT`, outro tenant é violação). Modelo de tenant fora de transação `TENANT` → `TenantContextMissingError` antes do banco; `tenantId` divergente em dados, filtro ou `update` → `TenantIsolationViolationError`; SQL bruto só dentro de transação. `TENANT_SCOPED_MODELS`/`PLATFORM_MODELS` são listas versionadas em `shared/database/tenant-models.ts`, conferidas com `schema.prisma` por teste a cada execução do CI (no lugar de geração no `prisma generate`, que o Prisma 7 não expõe sem gerador próprio). O tipo do Prisma continua exigindo `tenantId` nas criações: o repositório passa o do contexto e a extensão confere.
- **Tradução de erros do banco:** FK violada (23503/P2003) → 422 `VALIDATION_ERROR` com `REFERENCE_NOT_FOUND` no campo da coluna da FK (derivado do nome da restrição no padrão do Prisma); escrita barrada pela RLS → violação (500 + alerta); conexão perdida, inclusive no `set_config` → 503 `DEPENDENCY_UNAVAILABLE` + `Retry-After`.
- **Banco (migração `20261015120000_tenancy_foundation`):** papel `cf_platform` (LOGIN, sem `BYPASSRLS`); `cf_apply_tenant_rls(regclass)` (ENABLE + FORCE + política `tenant_isolation`, `SECURITY INVOKER` do `cf_owner`, para toda tabela nova); `cf_find_invitation(token_hash)` (`SECURITY DEFINER` do `cf_definer`, só `EXECUTE` para `cf_platform`); `cf_app`/`cf_worker` passam a ler só as colunas não sensíveis de `tenants` (sem `plan`, motivo e datas de suspensão/desativação); políticas `TO cf_platform` em `audit_logs` (registros de plataforma ou `actor_type = PLATFORM_OPERATOR`) e `outbox_events` (agregado `Tenant`). A política `tenant_isolation` continua **para todos os papéis** (não só `TO cf_app` como sugeria a story): vale também para `cf_worker`, `cf_platform` e o dono sob `FORCE`. `cf_set_primary_organization` fica com a US-101 (precisa de `organizations`).
- **`SystemDbService`:** segundo `PrismaClient` com `DATABASE_URL_PLATFORM` (obrigatória fora de local/dev/test), sem a extensão de tenant; toda transação define `app.tenant_id` = UUID nulo (as políticas de tenant avaliam falso sem erro); motivos da lista fechada de ADR-002; log `info system_db.call` (`reason`, `caller`, `outcome`, `durationMs`) e métrica `cf_system_db_calls_total{reason,outcome}`; importação restrita pelo dependency-cruiser aos `infrastructure` de `tenancy`/`identity`/`audit`, aos schedulers do worker e aos testes de banco. A leitura de vínculos (`cf_user_memberships`) e a gravação de auditoria de plataforma seguem no `PlatformTransaction` do `cf_app` (US-087/US-073) até a US-099 ligar a variável em todos os ambientes.
- **Cache, storage e jobs:** `TenantCache`/`PlatformCache` (`shared/cache`, `CACHE_STORE` Redis no módulo `platform`) montam a chave do contexto, exigem TTL e degradam para o carregamento com o Redis fora; chave já com escopo é violação. `StorageKeyBuilder` + guarda do `StorageService` (`shared/storage`) recusam chave fora de `tenants/{tenantId}/` antes de assinar URL (teto de 300 s); o adaptador S3 é da US-068. `JobMeta` (queues.md §3) com `buildJobMeta` no produtor e a base `TenantJob` no consumidor (`shared/jobs`, importável pelo worker): job de tenant sem `tenantId` é recusado na origem e no consumo (lista de plataforma de queues.md §9.3), tenant fora de `ACTIVE` conclui sem efeito, contexto e trace restaurados antes do handler.
- **Observabilidade:** logs `tenant.context_opened` (`debug` em produção), `warn tenant.access_denied` (sem o tenant pedido quando não há vínculo), `error security.tenant_context_missing` e `error security.tenant_isolation_violation` (`barrier` = `prisma_extension` · `rls` · `storage` · `cache` · `job` · `context`); métricas `cf_tenant_isolation_violations_total{barrier}`, `cf_tenant_context_missing_total{barrier}`, `cf_tenant_context_overhead_seconds{scope}` (substitui `cf_storage_tenant_guard_violations_total` de storage.md); atributo `cf.tenant.id` no span HTTP. Alerta A19 e runbook RB-10 em [observability.md](observability.md).
- **Suíte "tenant leak":** manifesto `src/openapi/tenant-leak.manifest.ts` classifica toda operação (coberta, com fixtures de B para caminho e corpo, ou isenta com motivo) e o meta-teste reprova rota nova sem classificação; a suíte HTTP (`test/tenant-leak`) roda a API inteira sobre PostgreSQL real com identidade real, varre as respostas por marcadores e IDs de B e compara o retrato das tabelas de B antes e depois; inclui o teste de 500 requisições num pool de 2 conexões. A checagem de catálogo do CI passou a exigir `tenant_id` como **primeira** coluna das FKs entre tabelas de tenant e `UNIQUE (tenant_id, id)` em toda tabela de negócio do schema `public`.
- Registrado em 2026-10-15 (US-100).

### DEC-077 — Projeção síncrona da timeline do processo · `Aceita` · complementa DEC-025, DEC-072, DEC-161 e POL-09
Decisões de implementação da US-059 (guia de uso em `apps/api/src/modules/timeline/README.md`):
- **Registro e tabela:** `TIMELINE_ENTRY_TYPES` e `TIMELINE_VISIBILITIES` em `packages/types` (um teste confere o registro com events.md §5). `process_timeline_entries` (migração `20261015140000_process_timeline_entries`): RLS `ENABLE` + `FORCE`, só `INSERT`/`SELECT` para `cf_app`/`cf_worker`, trigger de imutabilidade (`UPDATE`/`DELETE` falham até para o dono), `UNIQUE (tenant_id, source_event_id, type)`, `UNIQUE (tenant_id, id)` e índice `(tenant_id, process_id, occurred_at DESC, id DESC)` para a US-060. A FK de `process_id` → `processes` fica com a US-001.
- **Projetor:** `TimelineProjector` (módulo `timeline`) se registra no `SYNC_EVENT_HANDLERS` e assina `process.*`, `document.*`, `approval.*`, `comment.*`, `attachment.*`, `etp.*`, `price_research.*`, `risk.*` e `term.*`; o filtro fino é o `eventType` da tabela de mapeamento (`domain/timeline-mappings.ts`, pura), com os discriminadores `cause` (`ProcessStageChanged`), `assignmentType` (`ProcessAssigned`: só `CLAIM` e `MANUAL` geram entrada), `fromStatus`/`toStatus` (`ProcessStatusChanged`: suspensão, retomada, cancelamento e conclusão) e `byModerator` (`CommentDeleted`). Um evento pode gerar mais de uma entrada (`ProcessCreated` com `duplicatedFromId` → `PROCESS_CREATED` e `PROCESS_DUPLICATED_FROM`). Payload sem campo exigido → `TimelinePayloadError` (V-01, 500); evento ou discriminador sem linha → ignorado com `debug`; anexo fora de processo é ignorado, mas evento de processo sem `processId` é V-01.
- **Nomes congelados:** o payload só traz IDs (events.md §1), então cada referência — `USER`, `DEPARTMENT`, `ROLE`, `PROCESS`, `PROCESS_STAGE`, `PROCESS_PARTICIPANT`, `DOCUMENT`, `DOCUMENT_VERSION`, `APPROVAL`, `COMMENT`, `ATTACHMENT`, `ETP_ALTERNATIVE`, `PRICE_ITEM`, `QUOTATION`, `RISK` — é resolvida por uma fonte registrada em `TIMELINE_LOOKUP_SOURCES` (`TimelineModule`), escrita sobre a fachada do módulo dono, em lote e no mesmo `tx` (RLS). A US-059 entrega `USER` (`IdentityFacade.userDisplayNames`: nome social ou civil, só de quem tem vínculo no tenant); as demais entram com as stories donas. Tipo sem fonte → `TimelineLookupUnavailableError` (a transação falha, em vez de gravar nome nulo por esquecimento); entidade não encontrada → nome nulo. Nome do ator: o do `RequestContext` quando é o mesmo ator do evento (nenhuma consulta); senão, a fonte `USER` (reprocessamento). `actorDepartmentName`: `payload.actorDepartmentId` quando o produtor informa; em `ProcessStageChanged`, a unidade de origem (custódia); em `ProcessAssigned`, a unidade da etapa; nos demais, nulo.
- **Visibilidade (POL-09):** `BUDGET_RESTRICTED` quando a entrada revela ou resume valor de processo com `isBudgetConfidential` — `ProcessUpdated` com `estimatedValue`, `DocumentFinalized` com `typedSummary`, `QuotationExcluded`/`QuotationRestored`. Sigilo desconhecido (processo não encontrado) falha fechado (restrita). `CONFIDENTIALITY_CHANGED` é `STANDARD`.
- **`params`:** o `{documentLabel}` é gravado como `documentId`, `documentCode`, `documentTitle` e `typeName` (em `DOCUMENT_*`, `COMMENT_ADDED` de documento, `ATTACHMENT_ADDED` de documento e `documents[]` das tramitações) e a mensagem é montada no frontend (US-060). Campos opcionais lidos quando o produtor os envia (events.md §4 ainda não os lista no payload): `reason` (texto) em `ProcessStatusChanged`, `DocumentReopened`/`Canceled`/`Withdrawn` e `ApprovalReassigned`; `hasComment` em `ProcessStageChanged` e `ApprovalCompleted`/`Rejected` (`ApprovalReturned` é sempre `true`); `actorDepartmentId` em qualquer evento. O motivo de exclusão de cotação fica como código (`reason`, `ExclusionReason`), com rótulo no frontend.
- **Idempotência:** `INSERT … ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING RETURNING id` — inclusive sob concorrência (a segunda transação espera a primeira); conflito → `warn timeline.duplicate_ignored`. Reprocessamento (backfill — FA-04) = `TimelineProjector.project(tx, envelope)` numa `TenantTransaction` do tenant do evento.
- **Observabilidade:** `info timeline.entry_projected` (`processId`, `type`, `sourceEventId`, `durationMs`), `debug timeline.event_not_mapped`, `warn timeline.duplicate_ignored` e `error timeline.projection_failed` (`errorCode` `INTERNAL_ERROR`/`DEPENDENCY_UNAVAILABLE`, causa e `correlationId`), nunca com payload ou `params`; deadlock/serialização propaga sem log (a `TenantTransaction` refaz tudo). Métricas `timeline_entries_projected_total{type}`, `timeline_duplicates_ignored_total{type}`, `timeline_projection_failed_total{error_code}` e `timeline_projection_duration_ms`.
- **Pendente:** eventos gravados pelo worker (`AttachmentUploaded` do `file-scan`, `ProcessStageOverdue` do job de prazos) precisam do outbox e deste projetor no worker (US-083/US-055/US-068).
- Registrado em 2026-10-15 (US-059).

### DEC-078 — Provisionamento e ciclo de vida do tenant pela plataforma · `Aceita` · complementa DEC-076, DEC-132, DEC-139 e [ADR-002](../adr/adr-002-multi-tenancy.md)
Decisões de implementação da US-099 (detalhes em [multi-tenancy.md](multi-tenancy.md) §13; operação no runbook RB-12 de [observability.md](observability.md)):
- **Transições de `TenantStatus` (lacuna 4 — RN-TEN-09):** `PROVISIONING → ACTIVE` (fim do provisionamento ou PLT-04, só com o checklist completo); `ACTIVE → SUSPENDED` (PLT-05, motivo obrigatório); `SUSPENDED → ACTIVE` (PLT-04, preserva o `activatedAt` original); `ACTIVE|SUSPENDED → OFFBOARDING` (CLI); `OFFBOARDING → ACTIVE` (PLT-04, reversão); `OFFBOARDING|PROVISIONING → DEACTIVATED` (CLI, confirmação do slug). `DEACTIVATED` é final; qualquer outra → 409 `INVALID_STATE`. Máquina de estados em `tenancy/domain/tenant.ts`.
- **Checklist de etapas, uma transação por etapa:** `tenancy.tenantRecord` (SystemDbService) → seeders → `tenancy.complete` (auditoria `tenant.provision` + `TenantProvisioned` numa transação, uma única vez) → ativação. Substitui a "transação única" da versão anterior de multi-tenancy.md §13.1: falha preserva o que foi feito e a reexecução continua de onde parou. O checklist é calculado (`verify()` de cada etapa), nunca gravado.
- **Seeders registrados pelos módulos donos:** contrato `TenantSeeder` (`key`, `module`, `version`, `dependsOn`, `applyToExistingTenants`, `seed`, `verify`) e registro `TenantSeederRegistry` no shared kernel (`shared/tenancy/tenant-seeding.ts`, `TenantSeedingModule`); cada módulo registra o seu no `onModuleInit` e abre a própria `TenantTransaction` como ator `SYSTEM` no tenant novo. Ordem topológica com desempate pela ordem da story; ciclo ou dependência ausente derruba o boot. Registrados agora: `access.defaultRoles`, `document.systemTypes`, `identity.firstAdmin`, `tenancy.primaryOrganization` (US-101), `tenancy.settings` (US-103), `catalog.items` (US-104) e `catalog.holidays` (US-106); os demais (`document.templateLibrary`, `workflow.seedWorkflows`) entram com as stories donas (US-110, US-042) — o que não está registrado não aparece no checklist.
- **Retomada (FA-01):** `tenants.provisioning_fingerprint` (SHA-256 de slug + CNPJ do órgão principal + e-mail do primeiro administrador, gravado no registro do tenant) — o mesmo slug só retoma o MESMO pedido; outro CNPJ ou e-mail → 409 `TENANT_SLUG_TAKEN`, inclusive em corrida (o índice único decide a criação; quem chega depois compara a impressão). Coluna sem GRANT para `cf_app`/`cf_worker`.
- **Slug imutável fora de `PROVISIONING`:** trigger `tenants_slug_immutable` (migração `20261015200000_tenant_provisioning`).
- **Autorização das rotas `/platform/*`:** guard global `PlatformOperatorGuard` (depois do vínculo, antes do MFA): `User.isPlatformOperator` ativo → senão 403 `PERMISSION_DENIED` (auditado como `access.denied` de plataforma, `reasonCode` = permissão da rota, padrão `PLATFORM_TENANT_MANAGE`); depois MFA SEMPRE → 403 `MFA_REQUIRED`, sem depender de `security.mfaPolicy`. Porta `PlatformOperatorPort` no shared kernel, implementada por `identity`.
- **Auditoria e eventos:** ações sobre o tenant gravadas pela conexão de plataforma (`cf_platform`) com `actorType = PLATFORM_OPERATOR` e `tenantId` do tenant afetado (contexto `runAsPlatformOperator`), visíveis ao cliente; falha anterior ao tenant (slug em uso) vai para a auditoria de plataforma (`tenantId` nulo). Encerramento e desativação usam `tenant.deactivate` com `metadata.toStatus` e publicam `TenantOffboarded`/`TenantDeactivated` (events.md §4); os eventos `Tenant*` não têm consumidor assíncrono: o caso de uso remove o status do cache logo após o commit (TTL de 30 s como rede de segurança).
- **CLI:** `pnpm cf tenant:provision|status|activate|suspend|offboard|deactivate|seed|resend-invite` (`apps/api/src/cli/tenant.cli.ts`), contexto Nest sem HTTP na mesma imagem e configuração da API, com `node:util parseArgs` no lugar do `nest-commander` (sem dependência nova; mesmo padrão da CLI de filas do worker). Operador por `--operator <e-mail>` (ativo e `isPlatformOperator`); `metadata.channel = CLI` e `metadata.runId`. Saída 0 (ok), 1 (validação/autorização, sem efeito), 2 (incompleto ou dependência indisponível).
- **Pendente (stories donas):** papel `ADMIN_ORGAO` no escopo `TENANT` do primeiro administrador (US-096 — `role_assignments`); token e e-mail do convite (US-091/US-112 — até lá `invitationDispatched = false` e `tenant:resend-invite` sai com 2); órgão principal e `cf_set_primary_organization` (US-101); fixtures da suíte "tenant leak" geradas por este provisionamento.
- Registrado em 2026-10-15 (US-099).

### DEC-079 — Módulo `ai` e camada `AiProvider` no MVP 1 · `Aceita` · complementa DEC-037, DEC-040, DEC-052, DEC-163 e a regra D9 de [domains.md](domains.md) · provedor em [ADR-013](../adr/adr-013-ai-provider.md) (PEND-21)
- **Módulo:** `ai` sai da lista de reservados e entra no MVP 1 no **nível 5** de `tools/module-levels.json` ("leitura e efeitos colaterais", com `timeline`, `inbox`, `dashboard` e `notification`). Importa apenas **fachadas de leitura** dos níveis 0–4; nunca chama comando de outro módulo (regra D9 — dependency-cruiser `ai-read-only`). Dono de `AiGeneration`.
- **Aplicação pelo módulo dono:** aplicar o conteúdo gerado e marcar a revisão são comandos de `document` (seções — DOC-26/27) e `risk` (riscos — RSK-11/12), executados por uma pessoa. Esses módulos leem a proposta pela porta **`AiSuggestionSource`** do shared kernel (`apps/api/src/shared/ai/ai-suggestion-source.ts`: `loadForApply` e `markApplied`, na mesma transação), implementada pelo `ai` no `onModuleInit` — mesmo arranjo de `DocumentTypeCatalog` e `MembershipReferences`; sem implementação registrada, falha fechada.
- **Porta `AiProvider` (ACL):** `generate({ model, system, messages, responseSchema, maxOutputTokens, temperature, timeoutMs })` → `{ output, usage: { inputTokens, outputTokens }, model, finishReason, providerRequestId }`. Adaptadores: `FakeAiProvider` (dev/test/CI, determinístico por fixture) e o do provedor escolhido na ADR-013. O modelo não recebe ferramentas: não há como a IA acionar ações do sistema.
- **Execução:** assíncrona, na fila nova **`ai-generation`** (padrão B de [queues.md](queues.md): enfileirada após o commit, `jobId = generationId`; concorrência 4 por worker e 2 simultâneas por tenant; timeout de 120 s; 3 tentativas com backoff exponencial base 10 s; disjuntor). Nenhuma chamada de IA dentro de transação ou da requisição HTTP. Propostas não aplicadas expiram em 7 dias (`ai-proposals-expire`, fila `maintenance`).
- **Contexto e saída:** `ContextSanitizer` (minimização LGPD e sigilo), prompts versionados em código (`apps/api/src/modules/ai/prompts/<promptKey>/`, `promptKey` + `promptVersion`), saída estruturada validada por Zod e convertida para TipTap com o nó `toConfirm`; `GroundingGuard` determinístico troca por **[a confirmar]** todo número, valor, prazo, data ou percentual que não esteja nas entradas.
- **Configuração de plataforma:** `AI_PROVIDER` (`fake`|`anthropic`|`bedrock`|`openai`|`azure-openai`|`none`), `AI_MODEL_DRAFT`, `AI_MODEL_SECTION`, `AI_TENANT_MAX_MONTHLY_TOKENS`, `AI_REQUEST_TIMEOUT_MS`, `AI_TERMS_VERSION` e a tabela de preços versionada por modelo; segredos no Secrets Manager (DEC-137). Por tenant: `ai.enabled`, `ai.termsAcceptedVersion`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit` (entities.md §6).
- **Detalhes operacionais (lacunas das US-115/US-116, decididos em 2026-10-16):**
  - **Disjuntor:** estado compartilhado entre API e worker numa chave Redis de plataforma, sem dado de tenant (`cf:{env}:ai:circuit`).
  - **Tabela de preços:** arquivo versionado em código no módulo `ai` (`pricingVersion` = versão do arquivo), com preço de entrada e de saída por milhão de tokens e por modelo. Os valores são preenchidos com a decisão da ADR-013.
  - **Reserva de tokens por pedido** (RN-AI-18): DFD 15 mil, ETP 40 mil, mapa de riscos 25 mil, TR 40 mil e ajuste de seção 6 mil; calibrar com as métricas do primeiro mês.
  - **Consumo do mês:** atribuído pelo `createdAt` da geração, no fuso do tenant. Reduzir `ai.monthlyTokenLimit` abaixo do já consumido bloqueia só novos pedidos (`AI_USAGE_LIMIT_REACHED`), até o mês seguinte ou até o aumento do limite.
  - **Avisos de consumo:** `AiUsageThresholdReached` usa `eventId` determinístico (UUID v5 de tenant + mês + faixa), gravado no outbox com `ON CONFLICT DO NOTHING` sob a trava consultiva do tenant. Quem já recebeu o aviso não o recebe de novo, mesmo após a limpeza do outbox, pela unicidade `(tenant_id, recipient_id, source_event_id, type)` de `notifications`. O aviso é publicado quando o consumo atinge 80% ou 100% e ainda não houve aviso daquela faixa no mês.
  - **Termos de uso:** o texto fica versionado no repositório junto com `AI_TERMS_VERSION`. SET-01 devolve `meta.aiTerms = { currentVersion, provider }` para o diálogo de aceite. Uma versão nova dos termos não desliga a IA já ligada; só religar exige o aceite da versão vigente.
  - **Portas internas:** o `ai` consulta flag, termos e limites pela porta `AiTenantGate` (implementada na US-116; sem ela, AI-01 falha fechado com `AI_DISABLED`). Sem implementação de `AiSuggestionSource`, DOC-26 e RSK-11 respondem 503 `DEPENDENCY_UNAVAILABLE`.
- **Consequências:** o MVP 1 ganha um subprocessador externo (provedor de IA) — inventário de dados e termos de uso atualizados; a suíte "tenant leak" e os testes de autorização cobrem AI-01..06, DOC-26/27 e RSK-11/12; o MVP 5 reutiliza a camada, o módulo e o registro de gerações.
- Registrado em 2026-10-16 (spec-473, prd-3).

### DEC-088 — Dashboard operacional: leitura agregada sobre views publicadas · `Aceita` · complementa DEC-024, DEC-026, DEC-030 e DEC-040
Decisões de implementação da US-076 (guia em `apps/api/src/modules/dashboard/README.md`):
- **Sem entidade, com views:** o módulo `dashboard` (nível 5) agrega as views `security_invoker` publicadas pelos donos na migração `20261020090000_dashboard_views` — `v_dashboard_processes` e `v_dashboard_stage_passages` (`process`) e `v_dashboard_timeline` (`timeline`) —, como a caixa de tarefas faz com as `v_inbox_*` (DEC-026). Cada indicador é UMA instrução, sempre com o predicado de visibilidade único (`buildVisibilityPredicate` — DEC-024) e o recorte dos filtros.
- **Exceção de nível `dashboard → inbox`:** `PENDING_ITEMS` e o `pendingCount` de DSH-01 vêm da `InboxFacade.countersIn` (mesmos predicados e instrução de TSK-02 — RN-DASH-03), embora os dois módulos sejam do nível 5. Registrada em `allow` de `tools/module-levels.json`; o `inbox` nunca importa o `dashboard`. `pendingCount` = "Comigo" + "Aprovações pendentes".
- **Filtros (RN-DASH-09):** recortam pela unidade SOLICITANTE do processo — `secretariatId` = `requestingSecretariatId`; `departmentId` = `requestingDepartmentId` na subárvore da unidade (caminho materializado). Inexistente/outro tenant → `REFERENCE_NOT_FOUND`; inativa → `REFERENCE_INACTIVE`; secretaria que não é `SECRETARIAT`/`BOARD` nem raiz → `NOT_ALLOWED`.
- **Definições:** "abertos" = `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED` (`openCount`, `BY_STAGE`, `VALUE_BY_SECRETARIAT`); `OVERDUE`/`DUE_SOON` só com o prazo correndo (`IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`); "a vencer" = `currentStageDueAt` de hoje até a véspera do `(warn + 1)`-ésimo dia útil (o mesmo `isDueSoon` do DTO `deadline`); `BY_STATUS` cobre todos os status (soma = total visível).
- **POL-09 nos agregados:** o predicado de desmascaramento por linha passa a morar no shared kernel (`buildConfidentialBudgetPredicate`, reaproveitado pela lista de processos); `RECENT_ACTIVITY` o avalia como se o processo fosse sigiloso (RN-TML-13).
- **Cache:** `TenantCache`, módulo `dashboard`, chave `{userId}:{widget}:{sha256 dos filtros}` e TTL de 60 s; Redis fora → `warn dashboard.cache_unavailable` e cálculo direto no banco.
- **Índices:** criados `process_stages_exited_idx` `(tenant_id, exited_at, workflow_stage_id) WHERE exited_at IS NOT NULL` (no lugar do sugerido pela story, que exigiria uma varredura por etapa) e `process_timeline_entries_tenant_recent_idx` `(tenant_id, occurred_at DESC, id DESC)`. Read model dedicado segue como débito monitorado (mesma postura do DEC-026).
- Registrado em 2026-10-20 (US-076).


---

## 5. Dados e persistência

### DEC-080 — `tenant_id` obrigatório · `Aceita` · [ADR-002](../adr/adr-002-multi-tenancy.md)
Toda tabela de negócio tem `tenant_id uuid NOT NULL`. Tabelas de plataforma sem `tenant_id` (lista fechada): `tenants`, `users`, `permissions`, `_prisma_migrations`. `audit_logs` aceita `tenant_id` nulo **somente** para eventos de plataforma.

### DEC-081 — FKs compostas com tenant · `Aceita`
Tabelas de negócio expõem `UNIQUE (tenant_id, id)` e referenciam umas às outras por `(tenant_id, <fk>)`, impedindo no banco qualquer referência cruzada entre tenants.

### DEC-082 — Row-Level Security · `Aceita`
RLS `ENABLE` + `FORCE` em toda tabela com `tenant_id`; política `tenant_id = current_setting('app.tenant_id')::uuid`. O contexto é definido por transação (`set_config('app.tenant_id', …, true)`) pela extensão do Prisma. O papel da aplicação não é dono das tabelas e não tem `BYPASSRLS`; migrações e jobs de plataforma usam papéis separados e auditados. O acesso de plataforma (papel `cf_platform`) passa somente pelo `SystemDbService` (`systemPrisma` — multi-tenancy.md §5.3, US-100), com `reason` obrigatório de lista fechada: `TENANT_LIFECYCLE`, `TENANT_PROVISIONING`, `TENANT_ENUMERATION`, `USER_MEMBERSHIPS_LOOKUP`, `INVITATION_LOOKUP`, `PLATFORM_AUDIT`.

### DEC-083 — Colunas padrão · `Aceita`
`id`, `tenant_id`, `created_at`, `updated_at`, `created_by_id` (nullable para sistema), `updated_by_id`, `version` (agregados mutáveis), `deleted_at` (somente onde houver exclusão lógica). Unicidades em tabelas com exclusão lógica usam índices parciais `WHERE deleted_at IS NULL`.

### DEC-084 — Snapshots e hashes · `Aceita`
Snapshots (versões de documento, definição de workflow publicada, template publicado) são JSON canonicalizado (RFC 8785/JCS) com hash SHA-256 armazenado. Linhas de snapshot são imutáveis (trigger que bloqueia `UPDATE` de colunas de conteúdo).

### DEC-085 — Volume e retenção técnica · `Aceita`
`audit_logs` particionada por mês (`occurred_at`); `outbox_events` publicados purgados após 7 dias; notificações lidas arquivadas após 180 dias; renditions `PREVIEW` expiram em 24 h (lifecycle do bucket).

### DEC-086 — Dados pessoais sensíveis · `Aceita`
CPF e segredos de integração criptografados na aplicação (AES-256-GCM, chave via KMS — envelope encryption) com *blind index* HMAC para busca por igualdade.

---

## 6. API

### DEC-100 — Estilo · `Aceita`
REST JSON em `/api/v1`, camelCase, recursos no plural em inglês: `/processes`, `/dfds`, `/etps`, `/price-research`, `/risks`, `/terms`, `/workflows`, `/approvals`, `/documents`, `/attachments`, `/comments`, `/tasks`, `/timeline` (sub-recurso), `/dashboard`, `/users`, `/roles`, `/permissions`, `/organizations`, `/departments`, `/catalogs`, `/holidays`, `/settings`, `/templates`, `/document-types`, `/suppliers`, `/tags`, `/notifications`, `/audit`, `/me`. Reservados para MVPs futuros: `/legal-reviews`, `/publications`, `/contracts`, `/integrations`, `/pca`, `/webhooks`.

### DEC-101 — Artefatos do processo · `Aceita`
Criação e listagem aninhadas ao processo (`POST /processes/{processId}/dfds`, `GET /processes/{processId}/risks`); leitura/alteração pelo recurso direto (`GET /dfds/{id}`, `PATCH /risks/{id}`).

### DEC-102 — Comandos · `Aceita`
Ações de negócio como `POST` em sub-recurso verbal: `/processes/{id}/forward`, `/return`, `/claim`, `/assign`, `/suspend`, `/resume`, `/cancel`, `/complete`, `/duplicate`; `/documents/{id}/submit`, `/withdraw`, `/reopen`, `/cancel`, `/versions`; `/approvals/{id}/decide`; `/price-research/{id}/complete`; `/terms/{id}/import-etp`. Suporte de UI: `GET /processes/{id}/summary` (painel situacional) e `GET /processes/{id}/available-actions`.

### DEC-103 — Erros · `Aceita`
RFC 9457 (`application/problem+json`): `type`, `title` (pt-BR), `status`, `detail` (pt-BR), `instance`, **`code`** (estável), `errors[]` (`{ field, code, message }`), `correlationId`, e para regras `violations[]` (`{ ruleId, severity, message }`). Catálogo de códigos em [`mvp-01/api.md`](../mvp-01/api.md).

### DEC-104 — Concorrência na API · `Aceita`
`GET` de recurso mutável retorna `ETag: "<version>"`. `PATCH`, `PUT`, `DELETE` e comandos sobre recursos versionados exigem `If-Match`; divergência → **412** `VERSION_CONFLICT`; ausência → **428** `PRECONDITION_REQUIRED`.

### DEC-105 — Idempotência · `Aceita`
Header `Idempotency-Key` (UUID) aceito em todo `POST` de criação e comandos; registro em Redis por 24 h com escopo `tenant + usuário + método + rota`. Repetição com mesmo corpo → mesma resposta (header `Idempotent-Replayed: true`); mesmo key com corpo diferente → **422** `IDEMPOTENCY_KEY_REUSED`. Frontend envia sempre em criações e comandos.

### DEC-106 — Paginação e envelope · `Aceita`
- Listas: `?page=1&pageSize=20` (máx. 100) → `{ "data": [...], "meta": { "page", "pageSize", "totalItems", "totalPages" } }`.
- Feeds (timeline, auditoria, notificações, tramitações): `?cursor=<opaco>&limit=50` → `{ "data": [...], "meta": { "nextCursor", "hasMore" } }`.
- Recurso único: `{ "data": { … } }`.
- Ordenação `?sort=-updatedAt,code`; busca `?q=`; filtros por query string com múltiplos valores separados por vírgula.

### DEC-107 — Status HTTP · `Aceita`
200, 201 (+ `Location`), 202 (processamento assíncrono, ex.: PDF), 204, 400 (JSON malformado), 401, 403, 404, 409 (conflito de estado/duplicidade), 412, 413, 415, 422 (validação/regra de negócio), 428, 429, 500, 503.

### DEC-108 — Versionamento da API · `Aceita`
Mudanças aditivas na v1; quebra de contrato → `/api/v2`. Depreciação com headers `Deprecation` e `Sunset` e aviso de 6 meses.

---

## 7. Segurança, identidade e acesso

### DEC-130 — OIDC com Authentik · `Aceita` · [ADR-003](../adr/adr-003-authentication.md)
Authorization Code + PKCE (S256) com cliente **confidencial** no BFF; escopos `openid profile email offline_access`; `sub` configurado como UUID do usuário no Authentik. Login, recuperação de senha, MFA e federação (ex.: gov.br, Entra ID do órgão — futuro) são fluxos do Authentik com identidade visual do ContrataFlow.

### DEC-131 — Sessão · `Aceita`
Sessão no Redis (id opaco no cookie `__Host-cf_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`). Tokens (access/refresh/id) ficam só no servidor; renovação transparente no BFF. Ociosidade padrão 30 min e duração absoluta 12 h (configuráveis por tenant dentro de limites da plataforma). Logout local + RP-initiated logout no Authentik.
- O Redis de sessões é **dependência crítica**: em produção, cluster com alta disponibilidade (Multi-AZ com failover automático) e separado logicamente — de preferência fisicamente — do Redis de cache, idempotência e filas, para que a degradação destes não derrube sessões. Indisponibilidade do Redis de sessões → BFF responde 503; indisponibilidade do cache/idempotência → a API degrada sem perder consistência (ver CA-T-07 em [`mvp-01/acceptance-criteria.md`](../mvp-01/acceptance-criteria.md)).

### DEC-132 — Contexto de requisição · `Aceita`
A API valida o JWT (assinatura via JWKS em cache, `iss`, `aud`, `exp`, `nbf`), resolve `User` pelo `sub` e o **tenant ativo** pelo header `X-Tenant-Id` definido pelo BFF a partir da sessão; exige `TenantMembership` `ACTIVE` e não expirado, e tenant `ACTIVE`.
- **Tenant fora de `ACTIVE`:** `PROVISIONING` e `SUSPENDED` → somente operadores da plataforma (`TENANT_SUSPENDED` para usuários); `OFFBOARDING` → **somente leitura e exportação** para vínculos com `ADMIN_ORGAO` ou `AUDITOR` durante o prazo de encerramento (guarda obrigatória de documentos públicos), com todos os comandos bloqueados; `DEACTIVATED` → sem acesso. O contexto (`tenantId`, `userId`, `membershipId`, `correlationId`, IP, user-agent) é propagado por `AsyncLocalStorage`.

### DEC-133 — MFA · `Aceita`
MFA no Authentik (TOTP e WebAuthn). Política por tenant `security.mfaPolicy`: `NONE` | `ADMINS` (padrão: obrigatório para quem tem permissões de risco alto) | `ALL`. A API verifica a claim de método de autenticação (`amr`, ou claim customizada via *property mapping*) e responde **403** `MFA_REQUIRED` para disparar *step-up* no BFF.

### DEC-134 — RBAC granular com escopo · `Aceita`
- `Permission`: catálogo global definido em código (`packages/types`) e sincronizado por migração; cada permissão tem `riskLevel` (`LOW`, `MEDIUM`, `HIGH`).
- `Role` por tenant; `RolePermission`; `RoleAssignment` (vínculo × perfil × escopo `TENANT`|`ORGANIZATION`|`DEPARTMENT`|`OWN_DEPARTMENTS`, `includeSubtree`, `validFrom`, `validUntil`).
- Políticas contextuais em código (custódia DEC-023, segregação DEC-022, estado do recurso).
- Permissões efetivas por vínculo em cache Redis (5 min), invalidadas pelos eventos `RoleUpdated`, `RoleAssigned`, `RoleRevoked`, `MembershipUpdated`.
- Frontend apenas **esconde/desabilita**; a API sempre decide.

### DEC-135 — CSRF, CORS e cabeçalhos · `Aceita`
Cookie `SameSite=Lax` + header obrigatório `X-CF-Request: 1` + verificação de `Origin`/`Sec-Fetch-Site` no BFF para métodos mutáveis. API sem CORS no MVP 1 (não exposta a browsers). Web com CSP estrita (nonce), HSTS, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `frame-ancestors 'none'`.

### DEC-136 — Upload seguro · `Aceita`
Fluxo: `POST /attachments` (intenção) → URL pré-assinada `PUT` para bucket de **quarentena** (5 min) → `POST /attachments/{id}/confirm` → job `file-scan` (verificação de *magic bytes* × allowlist, ClamAV, SHA-256) → promoção ao bucket definitivo (`AVAILABLE`) ou `INFECTED`/`REJECTED`. Limite padrão 50 MB por arquivo (configurável até o teto da plataforma). Download por URL pré-assinada `GET` de 5 min com `Content-Disposition: attachment` e registro de auditoria.

### DEC-137 — Criptografia e segredos · `Aceita`
TLS 1.2+ em todo tráfego; criptografia em repouso (RDS, S3 SSE-KMS, ElastiCache); campos sensíveis com criptografia de aplicação (DEC-086). Segredos em AWS Secrets Manager/SSM (produção) e `.env` apenas local; nada em repositório (verificação `gitleaks` no CI); rotação documentada.

### DEC-138 — Logs seguros · `Aceita`
Proibido logar tokens, cookies, senhas, CPF, conteúdo de documentos, corpo de requisição de upload. E-mails mascarados (`j***@dominio.gov.br`). Redação automática configurada no pino (`redact`).

### DEC-139 — Acesso de suporte da plataforma · `Aceita`
Operadores da plataforma não têm acesso a dados de tenants por padrão. Acesso de suporte = vínculo temporário (`EXTERNAL`, validade ≤ 72 h) concedido mediante registro do chamado, com auditoria `actorType = PLATFORM_OPERATOR` visível ao administrador do tenant.

### DEC-140 — LGPD · `Aceita`
Bases legais: art. 7º, II e III, e art. 23 da LGPD (execução de políticas públicas/obrigação legal). Minimização de dados pessoais, inventário de dados em `security.md`, atendimento a titulares via administrador do tenant (controlador) com apoio da plataforma (operadora). Retenção conforme tabela de temporalidade do órgão (PEND-07).

### DEC-141 — Domínio único da aplicação · `Aceita`
A aplicação web e o BFF respondem em **um único domínio por ambiente**, com seleção de órgão/instituição após o login (DEC-012); não há subdomínio por tenant no MVP 1. Motivos: identidade global com vínculos em vários tenants e troca sem novo login (US-093), cookie `__Host-` (DEC-131), um único endereço de retorno no Authentik e um único certificado. Domínio próprio por tenant pode ser avaliado como recurso comercial a partir do MVP 2 (os slugs reservados da US-099 já o preveem). Decidido em 2026-10-07 (PEND-06 encerrada).


### DEC-142 — Política de MFA, *step-up* e redefinição do segundo fator · `Aceita` · complementa DEC-130, DEC-132, DEC-133 e DEC-134
Decisões de implementação da US-090:
- **`ALL` em toda requisição:** o `AuthorizationService.authorize` (chamado pelo `AuthorizationGuard` em toda rota `TENANT`) recusa com 403 `MFA_REQUIRED` qualquer requisição sem segundo fator quando `security.mfaPolicy = ALL` — não só as permissões `HIGH` (RN-IAM-39). A política só é lida quando o `amr` não comprova o fator, pelo cache de 60 s por tenant do `identity` (`SettingsTenantMfaPolicy`), apagado no commit do SET-02 e pelo `TenantSettingsChanged` no worker (RN-IAM-42). Como a decisão do MFA não entra no retrato das permissões efetivas, invalidar o cache da política basta: a próxima requisição de uma sessão aberta já é avaliada pela política nova. Rotas `NONE`/`PLATFORM`/`CROSS_TENANT_LOOKUP` (`/me`, sessão, troca) não passam por esse corte. `auth.mfa_required` grava `metadata.permissionCode` (nulo no corte de `ALL`) e `metadata.route` (o padrão da rota, sem IDs).
- **USR-13 sem `If-Match`:** a redefinição não altera o vínculo (nada local além da auditoria) e é idempotente, então não usa versão nem `Idempotency-Key`. Ordem: `USER_MANAGE` (+ MFA do administrador) → vínculo no tenant (404) → autoproteção (422 `NOT_ALLOWED`) → vínculo não revogado (409 `INVALID_STATE`) → Authentik fora de transação, com 1 nova tentativa (503 `DEPENDENCY_UNAVAILABLE`) → `membership.mfa_reset` numa transação própria. Falha da auditoria depois da remoção devolve 503 e a repetição grava o registro. A conta é achada pelo `authentikUserId` do provisionamento ou, sem ele, pelo `sub`; a API administrativa remove os dispositivos `totp`, `webauthn`, `static`, `duo` e `sms` (404 = já removido). A redefinição vale para a conta global no Authentik, não só para a instituição de quem a pediu (identidade global — DEC-012).
- **Status do fator no perfil:** ME-01 devolve `mfaVerified` (a sessão da requisição comprova o segundo fator, pelo `amr`), sem método nem dispositivo (RN-IAM-44); SCR-039 mostra o `MfaStatusBadge`.
- ***Step-up* que não se conclui:** com a sessão aberta, o BFF não volta a `/entrar` (que, com sessão ativa, devolveria a pessoa ao destino e à mesma recusa, em laço): Authentik fora → `/erro/confirmacao-indisponivel`; desafio cancelado ou falho → `/erro/confirmacao-nao-concluida` (SCR-111), ambos com "Tentar novamente" (novo *step-up* para o mesmo destino) e "Ir para o início". A sessão não muda (FA-04). Logs `info auth.step_up_completed` (`userId`, `durationMs`) e `warn auth.step_up_unavailable`, nunca o fator usado.
- **Aviso no front:** o interceptador global avisa ("Confirme sua identidade para continuar.", pelo `Toaster` com `aria-live`) antes de seguir ao `/api/auth/step-up` da página atual.
- **Pendente:** o e-mail ao usuário afetado pelo USR-13 (Notificações da story) não tem canal hoje — o envio transacional da fila `email` só conhece origens duráveis com estado (`Notification` e convite), e a story não cria evento de domínio nem tabela. Fica para uma story própria.
- Registrado em 2026-10-17 (spec-404, prd-2).
---

## 8. Eventos, filas e jobs

### DEC-160 — Envelope de evento · `Aceita` · [ADR-004](../adr/adr-004-outbox-events.md)
```json
{
  "eventId": "uuidv7",
  "eventType": "ProcessForwarded",
  "routingKey": "process.forwarded",
  "eventVersion": 1,
  "occurredAt": "2026-10-05T14:30:00Z",
  "tenantId": "uuid",
  "aggregateType": "Process",
  "aggregateId": "uuid",
  "processId": "uuid|null",
  "actor": { "type": "USER|SYSTEM|PLATFORM_OPERATOR|INTEGRATION", "userId": "uuid|null", "membershipId": "uuid|null" },
  "correlationId": "string",
  "causationId": "uuid|null",
  "payload": { }
}
```

### DEC-161 — Entrega · `Aceita`
- Escrita do evento em `outbox_events` **na mesma transação** da mudança de estado.
- Handlers **síncronos in-process** (mesma transação): timeline e `ProcessAccess`.
- Handlers **assíncronos** via relay do outbox → fila `domain-events` → fan-out para filas consumidoras (`notifications`, `email`, `search-index` futuro, `webhooks` MVP 3, `ai` MVP 5). Entrega *at-least-once*; consumidores idempotentes por `eventId`.
- A auditoria é escrita explicitamente pelo caso de uso (via `AuditService`) na mesma transação — não depende do outbox.

### DEC-162 — Eventos genéricos de documento + nomes especializados · `Aceita`
O ciclo de vida de documentos emite eventos genéricos (`DocumentCreated`, `DocumentSubmitted`, `DocumentFinalized`, `DocumentApproved`, `DocumentReturned`, `DocumentRejected`, `DocumentReopened`, `DocumentCanceled`, `DocumentVersionCreated`) com `documentTypeCode` e, quando o módulo tipado quiser, um `typedSummary` (ex.: total da pesquisa, alternativa recomendada). Os nomes especializados pedidos pelo produto **não são mensagens separadas**: são o mesmo evento publicado com routing key especializada, permitindo assinatura por tipo sem duplicar fatos:

| Nome especializado | Evento genérico | Routing key |
|---|---|---|
| `DFDCreated` | `DocumentCreated` (DFD) | `document.created.dfd` |
| `DFDApproved` | `DocumentApproved` (DFD) | `document.approved.dfd` |
| `ETPCreated` | `DocumentCreated` (ETP) | `document.created.etp` |
| `ETPApproved` | `DocumentApproved` (ETP) | `document.approved.etp` |
| `PriceResearchCompleted` | `DocumentFinalized` (PRICE_RESEARCH) | `document.finalized.price_research` |
| `TermCompleted` | `DocumentFinalized` (TR) | `document.finalized.tr` |

Eventos de fatos exclusivos de um módulo (fora do ciclo de vida do documento) são próprios: `QuotationExcluded`, `QuotationRestored`, `RiskCreated`, `RiskAssessed`, `RiskTreatmentChanged`, `EtpAlternativeRecommended`, `TermImportedFromEtp`, `PriceResearchRecalculated`.

O mesmo padrão vale para o processo: `ProcessStageChanged` (com `cause`) é o fato canônico de mudança de etapa e `ProcessForwarded` (`process.stage_changed.forward`) e `ProcessReturned` (`process.stage_changed.return`) são seus nomes especializados; `ProcessStatusChanged` é o fato canônico de mudança de status e `ProcessSuspended`, `ProcessResumed`, `ProcessCanceled`, `ProcessCompleted` são especializações. Catálogo completo em [`mvp-01/events.md`](../mvp-01/events.md).

### DEC-163 — Filas do MVP 1 · `Aceita`
`domain-events`, `notifications`, `email`, `document-render`, `file-scan`, `ai-generation` (DEC-079), `deadlines` (agendada, 15 min), `audit-seal` (agendada, 1 h), `maintenance` (agendada, diária). Política padrão: 5 tentativas, backoff exponencial com jitter (base 5 s), `removeOnComplete` com retenção de 24 h, falhas finais movidas para `dead-letter` com alerta. Detalhes em [`queues.md`](queues.md).

### DEC-164 — Contexto de tenant em jobs · `Aceita`
Todo job carrega `tenantId`, `actor`, `correlationId` e `traceparent`. O worker abre o contexto (AsyncLocalStorage + `app.tenant_id` no banco) antes do handler; job sem `tenantId` só é aceito em filas de plataforma explicitamente marcadas.

---

## 9. UX

### DEC-180 — Painel situacional do processo · `Aceita`
O topo do detalhe do processo responde, sem cliques: (1) onde está (etapa + unidade + status), (2) quem é o responsável, (3) o que está faltando (checklist de regras da etapa), (4) próximo passo (ação primária + orientação da etapa), (5) se está atrasado (prazo da etapa e prazo alvo), (6) documentos existentes (status/versão), (7) aprovações pendentes. Fonte: `GET /processes/{id}/summary`.

### DEC-181 — Padrões de interação · `Aceita`
Wizards para criação (Novo processo, DFD); editor por seções com navegação lateral e indicador de completude (ETP, TR); progressive disclosure (campos avançados recolhidos, ações secundárias em menu "Mais"); skeleton loading; empty states com chamada para ação; mensagens de erro com causa, ação de recuperação e `correlationId` copiável.

### DEC-182 — Autosave · `Aceita`
Debounce de 1,5 s após digitação e ao perder foco; indicador "Salvando…/Salvo às HH:mm/Erro ao salvar"; conflito → diálogo com "Ver diferenças", "Manter a minha versão" (sobrescreve com nova revisão) e "Descartar a minha e recarregar". Rascunho local (IndexedDB) como contingência offline curta.

### DEC-183 — Acessibilidade e responsividade · `Aceita`
WCAG 2.1 AA e eMAG 3.1. Navegação completa por teclado, foco visível, contraste mínimo 4,5:1. Consulta, caixa de tarefas, notificações e aprovações plenamente utilizáveis em mobile (≥ 360 px); edição de documentos é *desktop-first* (em mobile: leitura e comentários).

### DEC-184 — Linguagem · `Aceita`
Linguagem simples; termos da Lei 14.133 com tooltip e link para o glossário; nunca exibir códigos técnicos ao usuário (exceto `correlationId` em erros).

### DEC-185 — Identidade visual oficial · `Aceita` · 2026-10-20
A marca do ContrataFlow é o logo horizontal (ícone + palavra-marca + slogan "Do planejamento à contratação") e o ícone isolado de `docs/brand/` (fonte da verdade; regras de uso em `docs/brand/README.md`). Paleta da interface em navy `#141E2B` + azul `#005BF9` (azul profundo `#004BE3` para hover e botões de e-mail), exposta como tokens de `packages/ui` (`brand-*`, `sidebar-*` e os semânticos) com contraste ≥ 4,5:1 nos temas claro e escuro, conferido por teste. A palavra-marca e o slogan são texto real (Inter), não imagem — leitor de tela lê "ContrataFlow" como uma palavra; o ícone é vetor (`BrandMark`). O menu lateral do shell é navy com o lockup; o tema por tenant continua restrito a `branding.primaryColor` (RN-FND-91), cujo padrão passa a `#005BF9`, e não altera a marca.

### DEC-186 — Sistema de design v2: tema claro padrão e semânticas vivas · `Aceita` · 2026-10-28
Complementa a DEC-185 (a paleta oficial não muda; muda o uso). O **tema claro é o padrão** de quem não escolheu tema (`User.preferences.theme` ausente → `light`; quem salvou `dark` ou `system` mantém a escolha), e o escuro segue como opção com os mesmos tokens semânticos. Ground `#F4F6FA`, superfície branca, bordas finas `#E2E8F0`, texto `#0F172A`; o navy sai do fundo e vai para títulos, logo e toasts (superfície `inverse`), o azul `#005BF9` é a ação (`primary-hover` `#004BE3`). Semânticas com fundo suave e texto escuro do mesmo tom — sucesso, atenção, erro, **aprovação** (`#7C3AED`, nova) e neutro — em tokens `<estado>`, `<estado>-soft` e `<estado>-soft-foreground`, todos ≥ 4,5:1 nos dois temas por teste; o texto secundário é `#5B6B80` (o `#64748B` da prévia não passa sobre o ground). Tipografia Inter em escala curta (página 28/800, seção 16/700, rótulo 12/600, KPI 34/800), raio de 10–14 px, sombras quase nulas, foco de 3 px e alvos de 44 px. Componentes novos no `packages/ui`, sem biblioteca nova: `Card`, `KpiTile`, `StatusChip`, `PageHeader`, `EmptyState`, `FilterChip`, `ViewTabs`, primitivos de tabela, `Avatar`, `Kbd` e gráficos próprios (`BarList`, `Donut`, `ColumnChart`) que sempre trazem o texto. Os nomes de token do v1 continuam como aliases até a segunda leva; o tema por tenant segue trocando só a primária (e o hover dela). Prévia e regras em `docs/brand/` (`mockups/repaginacao-2026-10/`).


### DEC-187 — Login nativo pelo executor de fluxos do Authentik · `Aceita` · 2026-10-28
Revisa a DEC-070 e a DEC-073 (adendo na [ADR-003](../adr/adr-003-authentication.md)); pedido do usuário na repaginação (prd-4, spec-509), ciente da ressalva de a senha passar pelo BFF. O formulário de usuário e senha é do ContrataFlow (`/entrar`, SCR-001) e `POST /api/auth/login` conduz no servidor o *flow* `contrataflow-authentication` pela API do executor do Authentik (`/api/v3/flows/executor/<slug>/`), com jar de cookies por transação (`X-authentik-CSRF` quando houver o cookie). Fim do *flow* → `authorize` com PKCE e o mesmo cliente confidencial, código lido do 302 sem segui-lo, troca como no callback e **invalidação imediata da sessão do IdP** (`default-invalidation-flow`) — o refresh token continua valendo (Authentik 2026.8: `RefreshToken.session` é `SET_DEFAULT`). Detalhes:
- **Respostas:** `{ data: { step: 'done', redirectTo } }`, `{ data: { step: 'mfa', transaction, methods } }` ou problem+json `INVALID_CREDENTIALS` (401, igual para conta inexistente — RN-IAM-18), `LOCKED` (403, o *flow* negou o acesso), `MFA_INVALID`/`MFA_EXPIRED` (401), `IDP_UNAVAILABLE` (503), `RATE_LIMITED` (429). Recusas da API depois do IdP (bloqueado, sem vínculo, manutenção) seguem como `redirectTo` para as páginas de erro de sempre.
- **MFA:** etapa `ak-stage-authenticator-validate` com dispositivo de código (TOTP, estático, e-mail, SMS) → transação no Redis de sessões (`cf:{env}:login-mfa:{sha256(id)}`, AES-256-GCM com AAD = chave, `GETDEL`, 5 min, 5 códigos); o navegador só guarda o id. WebAuthn/Duo, cadastro de MFA, captcha e consentimento explícito viram `IDP_UNAVAILABLE` com `warn`/`error` claro até ganharem tela.
- **Bloqueio:** política de reputação do Authentik no *flow* (só por usuário: todas as tentativas chegam do IP do BFF) + etapa de negação depois da identificação (blueprint 15): 5 senhas ou códigos errados → `LOCKED` até a reputação expirar (`AUTHENTIK_REPUTATION__EXPIRY`, padrão 24 h) ou ser limpa no Admin. A negação só aparece com a senha certa, para não revelar a conta.
- **Controles do BFF:** CSRF de DEC-135 (`X-CF-Request` + `Sec-Fetch-Site`/`Origin`; sem token de formulário — não acrescenta nada à checagem de origem), limite por IP (20/min, o da rota) e por usuário (`cf:{env}:rl:login-user:{hmac}`, 10 a cada 15 min), senha nunca em log/métrica/Redis, logs `auth.login_failed`/`auth.login_succeeded`/`auth.mfa_required` com o usuário só como prefixo de HMAC (a auditoria `auth.session_start` na API continua no sucesso).
- **Entrada e logout:** `GET /api/auth/login` vira atalho para `/entrar` (preserva `returnTo`; `reauth=1` → `motivo=sessao-expirada`); só o provedor fake mantém `?as=<pessoa>` (dev/E2E). O logout encerra a sessão do BFF e revoga o refresh token, sem `end-session` no navegador — o Authentik 2026.8 recusa `post_logout_redirect_uri` sem `id_token_hint` (`invalid_request`/`id_token_hint_missing`, o "Bad Request" de 2026-10-28), e a DEC-070 mantém o token fora da URL. `saiu-parcial` e `OIDC_POST_LOGOUT_REDIRECT_URI` ficam obsoletos; o `form-action` da CSP volta a `'self'`.
- **Fora desta leva:** *step-up* (US-090) ainda pelo navegador no Authentik (a sessão do IdP criada ali expira sozinha em até 12 h), recuperação de senha nativa, código de recuperação no formulário e login gov.br (PEND-18).

### DEC-188 — Kit de componentes no padrão shadcn/ui sobre Radix, com ícones Lucide · `Aceita` · 2026-10-28
Complementa a DEC-186 (prd-5, 2ª leva da repaginação; pedido do usuário: telas sem cara de "HTML puro", menos densas e sem barras de rolagem aninhadas). O `packages/ui` adota o padrão **shadcn/ui** sobre o `radix-ui` já presente e ganha os controles que faltavam — `Field`/`Label`, `Input`, `Textarea`, `Select`, `Combobox`, `Checkbox`, `RadioGroup`, `Switch`, `Popover`, `Tooltip`/`InfoTooltip`, `Calendar`, `DatePicker`, `DateRangePicker`, `Tabs`, `Sheet`, `Command`/`CommandDialog`, `Breadcrumb`, `Separator`, `Progress`, `Collapsible`, `Accordion`, `StageProgress` e `FilterToolbar` —, com teclado e `aria-*` dos primitivos Radix, histórias com axe e paridade clara/escura pelos tokens. Dependências novas, exatas no catálogo: `lucide-react` 1.61.0 (ISC), `cmdk` 1.1.1, `react-day-picker` 10.0.2 e `date-fns` 4.4.0 (MIT); só o `packages/ui` as declara e o app importa ícones de `@contrataflow/ui` (`src/icons.ts`, nomes estáveis), nunca de `lucide-react`. As variáveis que o shadcn espera (`--background`, `--primary`, `--radius`…) são apelidos dos `--color-*` no `:root`; os componentes usam os `--color-*`, de modo que o tema por tenant continua valendo. Cartões, tabelas e diálogos perdem a borda (sombra `shadow-card` com contorno de 1 px; ground `#F7F8FA`). Regra de rolagem: só a página rola — abas, etapas, chips e barras quebram linha; rolagem interna só em `TableContainer`, corpo de Dialog/Sheet, listas de Select/Command e blocos de código. O `react-day-picker` (~27 KB gzip com o locale) entra nas telas por `next/dynamic` quando o seletor não aparece de cara. Kit e uso em `docs/brand/README.md`.

### DEC-189 — Fechamento da segunda leva da repaginação: regras de densidade e rolagem verificadas por teste e por varredura · `Aceita` · 2026-10-29
Fecha o prd-5 (DEC-186 e DEC-188). **Todas** as rotas de `apps/web/src/app` usam o kit e o modelo de página da família, e as duas regras que mais regridem passam a ser testes sem exceção: **só a página rola** (`no-nested-scroll.test.ts` — a lista `ALLOWED` guarda só tabela larga, corpo de diálogo/gaveta, lista suspensa e bloco de código, cada uma com o motivo, e o teste reprova entrada de arquivo que já não rola) e **nenhum controle nativo** (`no-native-controls.test.ts` — sem lista de pendências: qualquer `<select>`, checkbox, radio ou date em `features` reprova). Consequências de produto: o mapa comparativo deixa de ter cabeçalho fixo no topo (rolagem vertical interna sai; só a coluna do item fica fixa na horizontal) e as abas de riscos quebram linha em vez de rolar. Varredura final (build de produção + API simulada, 56 rotas descobertas por links e semente, em claro 1280, escuro 1280 e claro 390): zero erro de render, rolagem horizontal da página, rolagem interna indevida, controle nativo visível (os `<select>`/`<input>` ocultos do Radix, `aria-hidden`, ficam de fora) e violação axe sério/crítico; o E2E local completo (178 testes) passa. Ficam como estão: `/privacidade` (link do rodapé da entrada para a política, cuja página chega com o conteúdo jurídico — 404 conhecido) e as lacunas de API em `docs/mvp-01/screens.md` §1.4. Terceira leva sugerida: micro-interações e transições, atalhos de teclado além do Ctrl K, onboarding guiado do primeiro processo e redesenho do `Select` de listas longas com busca.

---

## 10. Decisões pendentes

Itens que exigem decisão de produto, jurídico ou cliente-piloto. A especificação adota o **padrão indicado** até a decisão.

| ID | Tema | Padrão adotado na especificação | Quem decide |
|---|---|---|---|
| PEND-02 | Consequência do indeferimento (`REJECT`) | Processo volta à etapa de origem com status `RETURNED`; documento `REJECTED`; sugere cancelamento | Produto + jurídico |
| PEND-03 | Reabertura de processo `COMPLETED`/`CANCELED` | Não permitida no MVP 1 | Produto |
| PEND-05 | Arredondamento | `ROUND_HALF_UP`, 2 casas em totais | Contabilidade |
| PEND-07 | Retenção/temporalidade e eliminação (LGPD × arquivo público) | Sem eliminação automática no MVP 1 | Jurídico |
| PEND-08 | Imagens embutidas no editor rico | Não permitidas no MVP 1 (usar anexos) | Produto |
| PEND-09 | PDF/A-2b para arquivamento | PDF comum no MVP 1; PDF/A avaliado no MVP 3 (assinatura) | Produto |
| PEND-11 | Comentários restritos por unidade | Não no MVP 1 | Produto |
| PEND-12 | Edição colaborativa em tempo real | Não no MVP 1 (presença + bloqueio otimista por seção) | Produto |
| PEND-13 | Aprovação com múltiplos aprovadores (todos/sequencial) | Não no MVP 1 (`ANY`) | Produto |
| PEND-14 | Semântica de "origem" e "código interno" | Origem = catálogo `PROCESS_ORIGIN`; canal técnico em `creationChannel`; código interno = nº externo opcional | Produto |
| PEND-16 | Registro manual de publicação no MVP 1 | Não; `PUBLISHED` só no MVP 3 | Produto |
| PEND-17 | Planos comerciais e limites por tenant (usuários, storage) | Limites técnicos padrão sem cobrança (storage: proposta de 50 GB por tenant, avisos em 80%/95% — storage.md §8; erro `STORAGE_QUOTA_EXCEEDED`) | Comercial |
| PEND-18 | Login gov.br via Authentik | Fora do MVP 1 | Produto |
| PEND-19 | Prioridade do processo após a aprovação do DFD | `Process.priority` passa a `Dfd.priority` na aprovação (RN-DFD-66, US-017); ajustes posteriores por US-005 | Produto |
| PEND-20 | Organização e times do GitHub (CODEOWNERS, proteção de branch) | Times provisórios de DEC-062 (`@contrataflow/tech-lead`, `security`, `platform`, `frontend`, `design`, `product`, `engineering`) | Tech Lead |
| PEND-21 | Provedor e modelo de IA para a geração de documentos ([ADR-013](../adr/adr-013-ai-provider.md)) | Camada agnóstica (`AiProvider`) com `FakeAiProvider` em dev/test; a ADR recomenda Anthropic Claude via Amazon Bedrock (região de origem `sa-east-1`), com um modelo intermediário no rascunho completo e um modelo econômico nos ajustes — **sem decisão até o usuário escolher** | Usuário (produto) + jurídico/DPO |
| PEND-22 | Modelo de custo da IA (incluído no plano × cobrado por uso) e limites padrão por órgão | Sem cobrança; limite técnico `ai.monthlyTokenLimit` = 2.000.000 tokens/mês e `ai.userDailyRequestLimit` = 40; custo registrado por geração para o relatório de consumo (AI-06) | Usuário (produto/comercial) — relaciona-se com a PEND-17 |

**Decididas em 2026-10-07 (sprint 0 — padrão confirmado pelo produto):** PEND-01 → DEC-028 · PEND-04 → DEC-020 · PEND-06 → DEC-141 · PEND-10 → DEC-061 · PEND-15 → DEC-021.


---

## 11. Índice de ADRs

| ADR | Título | Status |
|---|---|---|
| [ADR-001](../adr/adr-001-modular-monolith.md) | Monólito modular com DDD pragmático | Aceito |
| [ADR-002](../adr/adr-002-multi-tenancy.md) | Multi-tenancy: banco e schema compartilhados com `tenant_id`, RLS e FKs compostas | Aceito |
| [ADR-003](../adr/adr-003-authentication.md) | Autenticação com Authentik (OIDC + PKCE) e BFF no Next.js | Aceito |
| [ADR-004](../adr/adr-004-outbox-events.md) | Eventos de domínio com Transactional Outbox e BullMQ | Aceito |
| [ADR-005](../adr/adr-005-workflow-engine.md) | Motor de workflow próprio, declarativo e versionado | Aceito |
| [ADR-006](../adr/adr-006-document-model.md) | Modelo documental híbrido com versões imutáveis | Aceito |
| [ADR-007](../adr/adr-007-pdf-generation.md) | Geração de PDF com Gotenberg e hash SHA-256 | Aceito |
| [ADR-008](../adr/adr-008-configurable-rules.md) | Regras parametrizáveis com JSON Logic | Aceito |
| [ADR-009](../adr/adr-009-audit-trail.md) | Auditoria transacional append-only com selagem periódica | Aceito |
| [ADR-010](../adr/adr-010-shared-validation.md) | Validação compartilhada com Zod e contrato OpenAPI gerado | Aceito |
| [ADR-011](../adr/adr-011-identifiers-numbering.md) | UUIDv7 e numeração de negócio por sequência transacional | Aceito |
| [ADR-012](../adr/adr-012-prisma-tenant-transaction.md) | Prisma 7 com *driver adapter* e contexto de tenant por transação | Aceito |
| [ADR-013](../adr/adr-013-ai-provider.md) | Provedor e modelo de IA para a geração de documentos do planejamento | Proposto — pendente de decisão do usuário (PEND-21) |
