# MVP 2 — Permissões, Perfis e Políticas de Acesso

> **Documento canônico** de autorização do MVP 2. Estende [mvp-01/permissions.md](../mvp-01/permissions.md): modelo, escopos, participação, visibilidade (DEC-024), MFA e testes continuam como lá. Decisões: [DEC-193 a DEC-209](../architecture/decisions.md#mvp-2--governança-e-controle). Entidades: [entities.md](entities.md).
> Nenhum perfil novo é criado: os 15 perfis de DEC-035 ganham permissões (`CONTABILIDADE`, `JURIDICO`, `CONTROLE_INTERNO`, `AUTORIDADE_COMPETENTE`, `ADMIN_ORGAO`, entre outros), e o backoffice usa as permissões de plataforma.

Sumário: [1. O que muda no modelo](#1-o-que-muda-no-modelo) · [2. Catálogo](#2-catálogo-de-permissões-novas) · [3. Matriz](#3-matriz-perfil--permissão-novas-e-alteradas) · [4. Participação](#4-participação-no-processo) · [5. Visibilidade e escopos](#5-visibilidade-e-escopos) · [6. Políticas novas](#6-políticas-contextuais-novas) · [7. Políticas do MVP 1 alteradas](#7-políticas-do-mvp-1-alteradas) · [8. Plataforma](#8-permissões-de-plataforma-e-backoffice) · [9. Frontend](#9-uso-no-frontend) · [10. Testes](#10-testes-de-autorização)

---

## 1. O que muda no modelo

A fórmula de decisão do MVP 1 ([§1](../mvp-01/permissions.md#1-modelo-de-autorização)) não muda. O MVP 2 acrescenta:

- **Recursos fora do processo com escopo:** o PCA pertence a um órgão (`Pca.organizationId`) e seus itens a uma secretaria (`PcaItem.departmentId`); os relatórios agregam processos. Ambos usam o escopo da atribuição como recorte (§5).
- **Custódia por etapa ativa:** com etapas paralelas (DEC-194), a custódia (POL-01) é avaliada contra a etapa ativa sobre a qual a ação recai — não mais contra `Process.currentDepartmentId` (§7).
- **Designação por linha:** em aprovação múltipla (DEC-193), a designação (POL-03) e a segregação de funções valem por `ApprovalApprover`.
- **Segregação de funções nas análises:** quem elabora não analisa, quem analisa não aprova o que analisou (POL-19, POL-20, POL-23).
- **Rascunhos restritos:** parecer e manifestação em elaboração só são lidos por quem os elabora (POL-24).

---

## 2. Catálogo de permissões novas

Legenda igual à do MVP 1: **Risco** `L`/`M`/`H` (`H` exige MFA conforme `security.mfaPolicy` — POL-14); **Esc.** = aceita escopo. Fonte em código: `packages/types/src/permissions.ts`, com `introducedIn = 'MVP2'`, sincronizada com a tabela `permissions` por migração.

### 2.1 PCA (`pca`)
| Código | Nome (pt-BR) | Risco | Esc. | Descrição / política |
|---|---|---|---|---|
| `PCA_VIEW` | Visualizar PCA | L | ✔ | Plano, itens, execução e relatório de reconciliação do órgão/secretarias no escopo (§5.1) |
| `PCA_MANAGE` | Elaborar PCA | M | ✔ | Criar plano e revisão, editar itens, importar planilha, alterar situação de item no acompanhamento (POL-22) |
| `PCA_SUBMIT` | Enviar PCA para aprovação | M | ✔ | Enviar e retirar o plano da aprovação (POL-22) |
| `PCA_RECONCILE` | Conciliar referências ao PCA | M | ✔ | Disparar a reconciliação e conciliar manualmente processos e DFDs pendentes (DEC-197) |
| `PCA_EXPORT` | Exportar PCA | M | ✔ | Exportação para divulgação (art. 12, § 1º) e planilhas de acompanhamento |

### 2.2 Dotação orçamentária (`budget`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `BUDGET_ALLOCATION_MANAGE` | Indicar dotação | M | ✔ | Registrar, editar e cancelar dotações em rascunho (POL-25) |
| `BUDGET_ALLOCATION_CONFIRM` | Confirmar dotação | H | ✔ | Confirmar a reserva com evidência e cancelar dotação confirmada (POL-25) |

### 2.3 Análise jurídica (`legal-review`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `LEGAL_REVIEW_VIEW` | Acessar a fila jurídica | L | ✔ | Fila priorizada e painel de análise (SCR-019); o parecer concluído de um processo visível já é lido com `PROCESS_VIEW` |
| `LEGAL_REVIEW_MANAGE` | Conduzir análise jurídica | M | ✔ | Iniciar análise, pedir diligência, editar o parecer (`PARECER_JURIDICO`), registrar ressalvas (POL-19, POL-24) |
| `LEGAL_REVIEW_CONCLUDE` | Concluir análise jurídica | H | ✔ | Escolher a situação conclusiva e concluir (POL-19) |
| `LEGAL_REVIEW_WAIVE` | Dispensar análise jurídica | H | ✔ | Registrar a dispensa por hipótese configurada (art. 53, § 5º — POL-26) |
| `LEGAL_REVIEW_CONFIGURE` | Configurar a análise jurídica | H | — | Critérios da fila (art. 53, § 1º, I) e hipóteses de dispensa (catálogo `LEGAL_WAIVER_HYPOTHESIS`) |

### 2.4 Controle Interno (`internal-control`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `INTERNAL_CONTROL_REVIEW_VIEW` | Acessar o painel do Controle Interno | L | ✔ | Fila e painel de manifestação (SCR-020); a manifestação concluída é lida com `PROCESS_VIEW` |
| `INTERNAL_CONTROL_REVIEW_MANAGE` | Conduzir manifestação | M | ✔ | Responder checklist, registrar achados e recomendações, editar a manifestação (POL-20, POL-24) |
| `INTERNAL_CONTROL_REVIEW_CONCLUDE` | Concluir manifestação | H | ✔ | Concluir com a situação (POL-20) |
| `INTERNAL_CONTROL_CHECKLIST_MANAGE` | Gerenciar checklists do Controle Interno | H | — | Criar e publicar versões de `InternalControlChecklist` |

### 2.5 Edital (`tender`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `TENDER_CREATE` | Criar minuta do edital | M | ✔ | Criar `Tender` + documento `EDITAL` e a `MINUTA_CONTRATO` |
| `TENDER_UPDATE` | Editar minuta do edital | M | ✔ | Cabeçalho, lotes, matriz de riscos, seções; importação do TR (POL-02) |
| `TENDER_SUBMIT` | Concluir minuta do edital | M | ✔ | Finalizar `EDITAL` e `MINUTA_CONTRATO` (a aprovação é a etapa `AUTORIZACAO_LICITACAO` — POL-23) |

### 2.6 Workflow, regras, SLA e notificações (`workflow`, `rules`, `sla`, `notification`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `WORKFLOW_MIGRATE` | Migrar processos entre versões de workflow | H | — | Criar, simular, decidir e executar `WorkflowMigration` (POL-21) |
| `RULE_VIEW` | Visualizar biblioteca de regras | L | — | SCR-035 e simulador com contexto hipotético |
| `RULE_MANAGE` | Editar regras da biblioteca | M | — | Rascunhos e casos de teste |
| `RULE_PUBLISH` | Publicar regras da biblioteca | H | — | Publicar/aposentar versões (POL-27) |
| `SLA_POLICY_MANAGE` | Gerenciar políticas de prazo | H | — | `SlaPolicy`, prazos por etapa, pausas e escalonamento (POL-27) |
| `NOTIFICATION_RULE_MANAGE` | Gerenciar regras de notificação | M | — | `NotificationRule` (POL-27) |

### 2.7 Indicadores e gargalos (`analytics`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `REPORT_VIEW` | Acessar relatórios e gargalos | L | ✔ | SCR-027, SCR-028 e gargalos, recortados pelo escopo (POL-28) |
| `REPORT_EXPORT` | Exportar relatórios | M | ✔ | CSV/XLSX pela fila de exportações, auditado (`report.export`) |

**Total MVP 2: 30 permissões novas de tenant** (69 do MVP 1 + 30 = **99**) e 1 de plataforma (§8). Nenhum código colide com o MVP 1; prefixos novos: `PCA_`, `BUDGET_ALLOCATION_`, `LEGAL_REVIEW_`, `INTERNAL_CONTROL_`, `TENDER_`, `RULE_`, `SLA_POLICY_`, `NOTIFICATION_RULE_`, `REPORT_`; `WORKFLOW_MIGRATE` estende o prefixo existente.

---

## 3. Matriz perfil × permissão (novas e alteradas)

Siglas dos perfis como no MVP 1 ([§3.1](../mvp-01/permissions.md#31-perfis-e-escopo-padrão-de-atribuição)); escopos padrão de atribuição inalterados.

| Permissão | ADM | GES | REQ | PLA | COM | LIC | CTB | JUR | CI | AUT | FIS | GCT | AUD | LEI | EXT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `PCA_VIEW` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `PCA_MANAGE` | | ✔ | | ✔ | | | | | | | | | | | |
| `PCA_SUBMIT` | | ✔ | | ✔ | | | | | | | | | | | |
| `PCA_RECONCILE` | | ✔ | | ✔ | | | | | | | | | | | |
| `PCA_EXPORT` | | ✔ | | ✔ | | | | | ✔ | | | | ✔ | | |
| `BUDGET_ALLOCATION_MANAGE` | | ✔ | | | | | ✔ | | | | | | | | |
| `BUDGET_ALLOCATION_CONFIRM` | | | | | | | ✔ | | | | | | | | |
| `LEGAL_REVIEW_VIEW` | | ✔ | | | | | | ✔ | ✔ | ✔ | | | ✔ | | |
| `LEGAL_REVIEW_MANAGE` | | | | | | | | ✔ | | | | | | | |
| `LEGAL_REVIEW_CONCLUDE` | | | | | | | | ✔ | | | | | | | |
| `LEGAL_REVIEW_WAIVE` | | | | | | | | ✔ | | | | | | | |
| `LEGAL_REVIEW_CONFIGURE` | ✔ | | | | | | | | | | | | | | |
| `INTERNAL_CONTROL_REVIEW_VIEW` | | ✔ | | | | | | | ✔ | ✔ | | | ✔ | | |
| `INTERNAL_CONTROL_REVIEW_MANAGE` | | | | | | | | | ✔ | | | | | | |
| `INTERNAL_CONTROL_REVIEW_CONCLUDE` | | | | | | | | | ✔ | | | | | | |
| `INTERNAL_CONTROL_CHECKLIST_MANAGE` | ✔ | | | | | | | | ✔ | | | | | | |
| `TENDER_CREATE` | | ✔ | | | | ✔ | | | | | | | | | |
| `TENDER_UPDATE` | | ✔ | | | | ✔ | | | | | | | | | ✔ |
| `TENDER_SUBMIT` | | ✔ | | | | ✔ | | | | | | | | | |
| `WORKFLOW_MIGRATE` | ✔ | | | | | | | | | | | | | | |
| `RULE_VIEW` | ✔ | ✔ | | | | | | | ✔ | | | | ✔ | | |
| `RULE_MANAGE` | ✔ | ✔ | | | | | | | | | | | | | |
| `RULE_PUBLISH` | ✔ | | | | | | | | | | | | | | |
| `SLA_POLICY_MANAGE` | ✔ | ✔ | | | | | | | | | | | | | |
| `NOTIFICATION_RULE_MANAGE` | ✔ | ✔ | | | | | | | | | | | | | |
| `REPORT_VIEW` | | ✔ | | ✔ | ✔ | ✔ | | | ✔ | ✔ | | | ✔ | | |
| `REPORT_EXPORT` | | ✔ | | | | | | | ✔ | ✔ | | | ✔ | | |
| `AI_GENERATE` *(alterada)* | | ✔ | ✔ | ✔ | ✔ | **✔** | | **✔** | | | | ✔ | | | |

Notas:
- **`AI_GENERATE` ampliada** para `LICITACOES` (rascunho do edital) e `JURIDICO` (rascunho do parecer) — DEC-202. Continua fora de `CONTROLE_INTERNO` (sem IA na manifestação — DEC-200) e do `CONSULTOR_EXTERNO`.
- **`AUTORIDADE_COMPETENTE`** aprova o PCA e o edital com `APPROVAL_DECIDE` (já concedida), por designação na `Approval` de assunto `PCA` e na etapa `AUTORIZACAO_LICITACAO` (POL-22, POL-23); ganha leitura das filas de análise e os relatórios.
- **`ADMIN_ORGAO`** ganha a configuração: migração de workflow, biblioteca de regras, políticas de prazo, regras de notificação, critérios da fila jurídica e checklists do Controle Interno. Continua sem tramitar e sem `REPORT_VIEW` por padrão (o tenant pode conceder).
- **`CONTROLE_INTERNO`** mantém a leitura ampla do MVP 1 (escopo `TENANT`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, `AUDIT_VIEW`) e ganha as filas jurídica e própria, a biblioteca de regras em leitura, os relatórios e a exportação do PCA (POL-20).
- **`CONSULTOR_EXTERNO`**: só `TENDER_UPDATE` (como `TERM_UPDATE` no MVP 1), com efeito apenas onde é participante; **sem acesso ao PCA** (DEC-197, L-07), às análises ou aos relatórios.
- **`CONTABILIDADE`** é o único perfil padrão com `BUDGET_ALLOCATION_CONFIRM`; o gestor indica (rascunho) mas não confirma.
- Permissões **não escopáveis** (—) valem em qualquer atribuição vigente (regra do MVP 1, §1.1).

---

## 4. Participação no processo

| Papel | Mudança no MVP 2 |
|---|---|
| `OBSERVER` | Sem mudança (o parecer e a manifestação concluídos são lidos como qualquer documento visível; rascunhos seguem POL-24) |
| `COLLABORATOR` / `CONSULTANT` | `+ TENDER_UPDATE` (minuta do edital e do contrato, só documentos em `DRAFT`/`RETURNED` — POL-02) |

Participantes **nunca** conduzem ou concluem análise jurídica ou do Controle Interno, indicam ou confirmam dotação, mexem no PCA, migram processos ou decidem aprovações por força da participação (regra do MVP 1 estendida).

---

## 5. Visibilidade e escopos

### 5.1 PCA
Um escopo **cobre** o plano P quando: `TENANT`; `ORGANIZATION = P.organizationId`; `DEPARTMENT`/`OWN_DEPARTMENTS` — para os **itens** cujo `departmentId` está no escopo (com subárvore se `includeSubtree`). Consequências:
- `PCA_VIEW` com escopo de unidade vê o plano (cabeçalho e totais da própria secretaria) e só os itens das suas unidades; totais do órgão só com escopo `ORGANIZATION`/`TENANT`.
- `PCA_MANAGE` com escopo de unidade edita só itens da sua secretaria; criar o plano, criar revisão, importar e `PCA_SUBMIT` exigem escopo `ORGANIZATION`/`TENANT`.
- Selecionar um item do PCA no DFD/processo não exige `PCA_VIEW`: o seletor (`/pca-items/lookup`) devolve código, objeto e secretaria dos itens do plano aprovado do órgão do processo a quem pode editar o DFD/processo (capacidade implícita, como os seletores do MVP 1).

### 5.2 Relatórios (`REPORT_VIEW`, `REPORT_EXPORT`)
- `TENANT`/`ORGANIZATION`: agregados de todos os processos do tenant/órgão.
- `DEPARTMENT`/`OWN_DEPARTMENTS`: agregados de processos cuja **secretaria solicitante** está no escopo e, nos gargalos, de passagens cuja **unidade da etapa** está no escopo.
- O **detalhamento por processo** (SCR-028) aplica sempre o predicado de visibilidade da DEC-024 sobre os fatos — mesmo com escopo `TENANT`, só lista o que o usuário veria em Processos.
- Orçamento sigiloso: POL-09 aplicada por linha antes de agregar (DEC-206) — ver POL-28.

### 5.3 Filas jurídica e do Controle Interno
`LEGAL_REVIEW_VIEW`/`INTERNAL_CONTROL_REVIEW_VIEW` listam análises de processos **visíveis** (DEC-024) cujo escopo cobre o processo. O procurador designado e o analista recebem `ProcessAccess` `USER/RESPONSIBLE` pela atribuição da etapa (MVP 1).

### 5.4 Concessões `ProcessAccess` novas
| Evento | Concessão (mesma transação) |
|---|---|
| Ramificação (DEC-194) | `DEPARTMENT/CURRENT` para a unidade de cada ramo; junção converte os `CURRENT` dos ramos em `HISTORICAL` |
| Aprovação múltipla | `USER/APPROVER` para o aprovador de **cada** linha (e substituto, se `allowDeputy`); para `ROLE`, `DEPARTMENT/CURRENT` como no MVP 1 |
| Migração de versão | Concessões da etapa de destino iguais às de uma entrada normal; nenhuma é revogada além do `CURRENT → HISTORICAL` usual |
| Acesso de suporte (DEC-208) | Nenhuma `ProcessAccess`: o vínculo `EXTERNAL` recebe o perfil do pedido, com o escopo dele |

---

## 6. Políticas contextuais novas

| ID | Política | Regra |
|---|---|---|
| POL-19 | **Segregação jurídico × requisitante** | Iniciar, editar o parecer e concluir (`LEGAL_REVIEW_MANAGE`/`_CONCLUDE`) exigem que o usuário **não** seja: criador do processo; autor (`createdById` ou autor de versão) de DFD, ETP, TR, `EDITAL` ou `MINUTA_CONTRATO` do processo; lotado na secretaria ou no setor solicitante. Concluir exige ainda ser o `assigneeId` da `LegalReview` ou o titular/substituto da unidade jurídica da etapa. Erro `LEGAL_REVIEW_SEGREGATION` (403); `NOT_LEGAL_REVIEW_ASSIGNEE` (403) |
| POL-20 | **Controle Interno: leitura ampla e independência** | O perfil mantém visibilidade de todos os processos do escopo (`TENANT` por padrão), orçamento sigiloso (art. 24, I) e trilha de auditoria. Conduzir/concluir a manifestação exige não ter atuado no processo como autor de documento, aprovador ou procurador, e ser o `assigneeId` ou titular/substituto da unidade da etapa. O Controle Interno **não** edita documentos de outros tipos nem decide aprovações do processo que analisa. Erro `INTERNAL_CONTROL_SEGREGATION` (403) |
| POL-21 | **Migração de versão de workflow** | `WORKFLOW_MIGRATE` (MFA sempre — permissão `HIGH`). Executar exige plano `SIMULATED` com o mesmo `simulationHash` e todos os itens `NEEDS_DECISION` decididos com justificativa; processos fora da visibilidade de quem executa não entram no filtro (o administrador vê todos por `TENANT`). Nenhuma migração roda sem pedido humano (DEC-195). Erros: `MIGRATION_NOT_SIMULATED` (409), `MIGRATION_DECISIONS_PENDING` (422), `MIGRATION_SIMULATION_STALE` (409) |
| POL-22 | **Administração e aprovação do PCA** | Elaborar e enviar: `PCA_MANAGE`/`PCA_SUBMIT` com o escopo da §5.1, plano em `DRAFT`. Aprovar: `Approval` de assunto `PCA` com aprovador `ROLE AUTORIDADE_COMPETENTE` (padrão, configurável) cuja atribuição cubra o **órgão do plano**; a decisão segue POL-03 por linha. Segregação: quem enviou (`submittedById`) não aprova. Revisar plano `APPROVED` = criar nova versão (`PCA_MANAGE`, escopo de órgão), nunca editar a vigente. Erros: `PCA_NOT_EDITABLE` (409), `PCA_SELF_APPROVAL_FORBIDDEN` (403) |
| POL-23 | **Aprovação do edital e autorização da licitação** | Decisão na etapa `AUTORIZACAO_LICITACAO` por POL-03 (cobre `EDITAL`, `MINUTA_CONTRATO`, `PARECER_JURIDICO`, `MANIFESTACAO_CONTROLE_INTERNO`). Segregação: o aprovador não pode ser autor do edital, da minuta do contrato nem do parecer. Com parecer `UNFAVORABLE`, manifestação `NON_COMPLIANT`, ressalvas `OPEN` ou achados `HIGH`/`CRITICAL` abertos, a decisão `APPROVE` exige **motivação** (`decisionComment` ≥ 50 caracteres) e o reconhecimento de cada aviso (`warningsAcknowledged` — ADR-008); ressalvas/achados abertos passam a `RISK_ACCEPTED` na mesma transação. Erro `AUTHORIZATION_MOTIVATION_REQUIRED` (422) |
| POL-24 | **Rascunho de parecer e de manifestação** | Enquanto `PARECER_JURIDICO`/`MANIFESTACAO_CONTROLE_INTERNO` não estiver `FINALIZED`, o conteúdo e o PDF só são lidos por quem tem `LEGAL_REVIEW_MANAGE`/`INTERNAL_CONTROL_REVIEW_MANAGE` cobrindo o processo (e por `AUDITOR` com `AUDIT_VIEW`); os demais veem título e status, como em documentos `RESTRICTED`. Comentários no rascunho seguem a mesma restrição. Erro `DOCUMENT_DRAFT_RESTRICTED` (403) |
| POL-25 | **Dotação orçamentária** | Registrar/editar: `BUDGET_ALLOCATION_MANAGE` + custódia da etapa `DOTACAO` (ou titular/substituto da unidade) + processo editável. Confirmar e cancelar confirmada: `BUDGET_ALLOCATION_CONFIRM` + mesma custódia + evidência anexada e verificada (`AVAILABLE`). Valores seguem POL-09 (leitura e escrita). Erros: `BUDGET_ALLOCATION_NOT_EDITABLE` (409), `BUDGET_EVIDENCE_REQUIRED` (422) |
| POL-26 | **Dispensa de análise jurídica** | `LEGAL_REVIEW_WAIVE` + POL-19 + hipótese `LEGAL_WAIVER_HYPOTHESIS` ativa cuja condição (`RuleRef`) seja verdadeira para o processo + `LegalReview` em `PENDING`; justificativa ≥ 20. A dispensa não vale em etapa marcada `isLegallyRequired` quando a hipótese não a prevê. Erro `LEGAL_WAIVER_NOT_APPLICABLE` (422) |
| POL-27 | **Regras, prazos e notificações** | Publicar versão de regra (`RULE_PUBLISH`) exige casos de teste verdes na expressão atual; regra de roteamento não pode ser aplicada a etapa `isLegallyRequired` (validação na publicação do workflow). `SLA_POLICY_MANAGE` e `NOTIFICATION_RULE_MANAGE` só alteram efeitos futuros (passagens e eventos novos). O simulador (`RULE_VIEW`) com processo real exige `PROCESS_VIEW` sobre ele e mascara valores sigilosos sem POL-09. Erros: `RULE_TESTS_FAILING` (422), `RULE_NOT_ALLOWED_ON_LEGAL_STAGE` (422) |
| POL-28 | **Relatórios e sigilo** | `REPORT_VIEW` recorta pelo escopo (§5.2); valores de processos com orçamento sigiloso só entram nas somas de quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo — os demais recebem os totais sem eles e `confidentialExcluded: true`; o detalhamento aplica DEC-024 e POL-09 por linha; exportação (`REPORT_EXPORT`) aplica o mesmo filtro e é auditada |
| POL-29 | **Backoffice e identidade federada** | Rotas `/platform/*` do backoffice: `User.isPlatformOperator` + MFA sempre (DEC-078) + permissão de plataforma da rota (§8); o backoffice não lê processos nem documentos. Vincular gov.br em "Meu perfil": usuário autenticado, `auth.govbrEnabled` no tenant ativo; desvincular exige sessão com MFA ou login gov.br recente (≤ 10 min). Entrada por gov.br sem vínculo ou sem `TenantMembership` ativo é recusada (`GOVBR_NOT_LINKED`, `MEMBERSHIP_REQUIRED`) — DEC-207 |

---

## 7. Políticas do MVP 1 alteradas

| ID | Mudança no MVP 2 |
|---|---|
| POL-01 (Custódia) | Avaliada **por etapa ativa**: com ramos paralelos, quem tem a custódia de um ramo (responsável da `ProcessStage` ou lotação na unidade do ramo) só age sobre aquele ramo (encaminhar, devolver, editar documentos permitidos na etapa do ramo — DEC-194). A API recebe `processStageId` nas ações de tramitação quando houver mais de uma etapa ativa (`PROCESS_STAGE_REQUIRED`, 422). Ações sobre o processo inteiro (editar dados, suspender, cancelar) exigem custódia de **alguma** etapa ativa ou as permissões de gestor do MVP 1 |
| POL-02 (Edição de documento) | Tipos novos: `PARECER_JURIDICO` ← `LEGAL_REVIEW_MANAGE`; `MANIFESTACAO_CONTROLE_INTERNO` ← `INTERNAL_CONTROL_REVIEW_MANAGE`; `EDITAL` e `MINUTA_CONTRATO` ← `TENDER_UPDATE`. A etapa permitida vem de `WorkflowStage.documentTypeCodes` da etapa ativa do ramo. Coleções tipadas novas (`TenderLot`, `TenderLotItem`, `TenderRiskAllocation`, `LegalReviewReservation`, `InternalControlChecklistAnswer`, `InternalControlFinding`) seguem a regra do documento dono |
| POL-03 (Decisão de aprovação) | Designação, substituto e segregação avaliados **por linha** `ApprovalApprover` `PENDING`; em `SEQUENTIAL`, linha `WAITING` → `NOT_DESIGNATED_APPROVER` (`meta.reason = LINE_WAITING`). Uma pessoa decide no máximo uma linha por aprovação: segundo voto → `APPROVER_ALREADY_VOTED` (409 — US-134). Aprovação de assunto `PCA`: escopo `ROLE` cobre o **órgão do plano** (não há unidade solicitante). Concorrência: a segunda decisão recebe `APPROVAL_NOT_PENDING` (409) ou, em `ALL`, `APPROVAL_LINE_NOT_PENDING` (409) |
| POL-09 (Orçamento sigiloso) | Estendida a `BudgetAllocation.reservedAmount`, `PcaItem.plannedValue` de itens vinculados a processo sigiloso (na visão por processo), fatos e agregados do `analytics` (POL-28), `RuleContext` exposto no simulador e insumos de IA (já excluídos — RN-AI-05) |
| POL-17 (Retirar aprovação) | Retirar cancela a aprovação inteira e todas as linhas não decididas; não há retirada de voto já dado. Redirecionar (`APPROVAL_REASSIGN`) age **por linha** ainda não decidida (DEC-193) |
| POL-18 (Gerar com IA) | Permissões de edição dos alvos novos: `LEGAL_REVIEW_MANAGE` (`LEGAL_OPINION`, com POL-19 e POL-24) e `TENDER_UPDATE` (`TENDER`). Limites, opt-in e revalidação no worker inalterados (DEC-203). No parecer, aplicar a seção de conclusão não altera `LegalReview.status` |

---

## 8. Permissões de plataforma e backoffice

Não fazem parte de perfis de tenant (DEC-078, DEC-139, DEC-208). As do MVP 1 continuam; o backoffice as usa por tela:

| Código | Uso no MVP 2 |
|---|---|
| `PLATFORM_TENANT_MANAGE` | Backoffice: provisionar tenant e órgãos, acompanhar e mudar o ciclo de vida (mesmas operações da CLI — US-099) |
| `PLATFORM_SUPPORT_ACCESS` | Backoffice: conceder e encerrar acesso de suporte (`SupportAccessGrant`, ≤ 72 h, chamado obrigatório) |
| `PLATFORM_QUEUE_ADMIN` | Backoffice: filas e dead-letter (Bull Board continua) |
| `PLATFORM_AUDIT_VIEW` | Backoffice: auditoria de plataforma |
| `PLATFORM_HEALTH_VIEW` *(nova)* | Backoffice: saúde operacional por tenant — filas, consumo e limites de IA, uso de storage, situação da reconciliação do read model — **sem** dados de processos ou documentos |

O administrador do tenant (`AUDIT_VIEW`) vê na auditoria do próprio tenant toda ação de operador sobre ele (`actorType = PLATFORM_OPERATOR`), inclusive concessões de acesso de suporte (DEC-139).

---

## 9. Uso no frontend

`GET /api/v1/me/permissions` inalterado no formato (as permissões novas aparecem na lista). Itens de menu e rotas novos:

| Área | Requer |
|---|---|
| Planejamento › PCA (SCR-018) | `PCA_VIEW` |
| Jurídico (SCR-019) | `LEGAL_REVIEW_VIEW` |
| Controle Interno (SCR-020) | `INTERNAL_CONTROL_REVIEW_VIEW` |
| Edital (SCR-021, aba do processo) | `PROCESS_VIEW` (edição: `TENDER_UPDATE` + POL-02) |
| Relatórios (SCR-027) / Relatório detalhado (SCR-028) | `REPORT_VIEW` |
| Administração › Regras (SCR-035) | `RULE_VIEW` |
| Administração › Prazos (SLA) | `SLA_POLICY_MANAGE` |
| Administração › Regras de notificação | `NOTIFICATION_RULE_MANAGE` |
| Administração › Workflows › Migrar processos | `WORKFLOW_MIGRATE` |
| Administração › Checklists do Controle Interno | `INTERNAL_CONTROL_CHECKLIST_MANAGE` |
| Administração › Análise jurídica (critérios e dispensas) | `LEGAL_REVIEW_CONFIGURE` |
| Backoffice (área própria) | `isPlatformOperator` + permissão de plataforma da tela |

`GET /processes/{id}/available-actions` passa a devolver as ações por etapa ativa (`stages[]`) quando houver paralelismo, com os motivos de indisponibilidade de POL-19 a POL-25.

---

## 10. Testes de autorização

Mesma estratégia do MVP 1 ([§10](../mvp-01/permissions.md#10-testes-de-autorização)), com acréscimos:
- **Matriz gerada** cobre as 30 permissões novas × 15 perfis × escopos, a partir de `packages/types`; inclui `AI_GENERATE` ampliada.
- **Uma bateria por POL nova** (POL-19 a POL-29) e pelas mudanças das POL-01, 02, 03, 09, 17 e 18: sucesso e violação, inclusive segregação jurídico × requisitante, aprovador do edital autor do parecer, voto concorrente em `ALL`, linha `WAITING` em `SEQUENTIAL`, custódia por ramo e rascunho restrito.
- **Escopo do PCA:** usuário com escopo de secretaria vê/edita só os itens das suas unidades; `CONSULTOR_EXTERNO` recebe 403/404 em todo o PCA.
- **Relatórios:** agregado com escopo de unidade não inclui processos de outras secretarias; somas sem valores sigilosos para quem não tem POL-09 (inclusive diferença entre recortes).
- **Multi-tenant:** toda rota nova com id de outro tenant → 404 (suíte "tenant leak"), inclusive fatos do `analytics`, itens de migração e regras da biblioteca.
- **Backoffice:** operador sem MFA → 403 `MFA_REQUIRED`; nenhuma rota do backoffice devolve dados de processo.
