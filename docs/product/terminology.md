# ContrataFlow — Terminologia

> **Status:** v1.0 · glossário oficial termo de negócio (pt-BR) ↔ identificador técnico (inglês), conforme a DEC-001.
> **Precedência:** o [registro de decisões](../architecture/decisions.md) e, quando existirem, [`mvp-01/entities.md`](../mvp-01/entities.md), [`mvp-01/permissions.md`](../mvp-01/permissions.md) e [`mvp-01/events.md`](../mvp-01/events.md) prevalecem. Divergência encontrada aqui deve ser corrigida aqui.
> **Documentos irmãos:** [visão do produto](product-overview.md) · [personas](personas.md) · [roadmap](roadmap.md).

**Sumário:** [1. Estrutura organizacional e acesso](#1-estrutura-organizacional-e-acesso) · [2. Processo e tramitação](#2-processo-e-tramitação) · [3. Workflow e regras](#3-workflow-e-regras) · [4. Documentos](#4-documentos) · [5. DFD](#5-dfd) · [6. ETP](#6-etp) · [7. Pesquisa de preços](#7-pesquisa-de-preços) · [8. Riscos](#8-riscos) · [9. Termo de Referência](#9-termo-de-referência) · [10. Aprovações](#10-aprovações) · [11. Colaboração, notificações e auditoria](#11-colaboração-notificações-e-auditoria) · [12. Termos legais da NLLC](#12-termos-legais-da-nllc) · [13. Siglas técnicas](#13-siglas-técnicas) · [14. Rótulos de enums na interface](#14-rótulos-de-enums-na-interface) · [15. Termos reservados para MVPs futuros](#15-termos-reservados-para-mvps-futuros) · [16. Guia de linguagem](#16-guia-de-linguagem)

## Como usar

- A coluna **Identificador técnico** é para o time (código, API, eventos, configuração). **A interface nunca exibe identificadores técnicos** — apenas os termos e rótulos em pt-BR (DEC-184); a única exceção é o `correlationId` em mensagens de erro.
- Termos da Lei 14.133/2021 aparecem na interface com tooltip e link para este glossário (DEC-184).
- Convenções de identificadores: entidades em PascalCase singular; campos em camelCase; valores de enum em SCREAMING_SNAKE_CASE; permissões `RESOURCE_ACTION`; eventos no passado (`ProcessCreated`) com routing key em dot.case; chaves de configuração em dot.camelCase (DEC-001). Siglas brasileiras de domínio são mantidas: `Dfd`, `Etp`, `Pca`, `TermOfReference` (recurso `/terms`).
- Artigos sem indicação de norma referem-se à Lei 14.133/2021.

---

## 1. Estrutura organizacional e acesso

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Tenant (cliente) | `Tenant` | Cliente do SaaS e fronteira de isolamento de dados — por exemplo, "Município de São José". Concentra configurações, faturamento e todos os dados de negócio. | DEC-011; DEC-080 a DEC-082. A Câmara Municipal é, em regra, outro tenant. Situação em `TenantStatus` |
| Órgão/entidade | `Organization` | Órgão ou entidade com CNPJ dentro do tenant: Prefeitura, Fundo Municipal de Saúde, autarquia. Um tenant tem um ou mais. | DEC-011. Base para numeração por órgão e para o PNCP (MVP 3) |
| Unidade administrativa (secretaria, setor) | `Department` | Nó da árvore organizacional — secretaria, diretoria, departamento, divisão, setor, comissão — com titular e substituto. "Secretaria solicitante" é a unidade do tipo `SECRETARIAT` (ou de nível 1); "setor solicitante" é uma unidade da subárvore da secretaria. | DEC-011. Tipo em `DepartmentType`; rótulo "Secretaria" configurável (`labels.secretariat`, ex.: "Diretoria" em câmaras) |
| Titular e substituto da unidade | atributos de `Department` | Responsável pela unidade e quem o substitui; usados para resolver o aprovador `DEPARTMENT_HEAD` e permitir decisão pelo substituto. | DEC-011; DEC-022 |
| Usuário | `User` | Identidade global da pessoa, mapeada ao `sub` do Authentik; não guarda dados de negócio do tenant. | DEC-012; DEC-130 |
| Vínculo | `TenantMembership` | Relação do usuário com um tenant: tipo, situação, cargo, matrícula e validade (obrigatória para externos). | DEC-012. Tipo em `MembershipType`; situação em `MembershipStatus` |
| Lotação | `MembershipDepartment` | Unidade ou unidades em que o vínculo está lotado; base do escopo "Minhas unidades" e da custódia por unidade. | DEC-012; DEC-023 |
| Ente ativo ("órgão ativo") | sessão; cabeçalho `X-Tenant-Id` | Tenant escolhido na sessão por quem tem vínculos com vários tenants (ex.: consultoria). | DEC-012; DEC-132. Ver nota abaixo |
| Perfil | `Role` | Conjunto nomeado de permissões, definido por tenant. Perfis padrão são semeados no provisionamento e editáveis, exceto `ADMIN_ORGAO`. | DEC-035; DEC-134 |
| Permissão | `Permission` | Capacidade atômica no formato `RESOURCE_ACTION` (ex.: `PROCESS_CREATE`, `DFD_SUBMIT`), com nível de risco `LOW`, `MEDIUM` ou `HIGH`; catálogo global mantido em código. | DEC-001; DEC-134 |
| Permissão do perfil | `RolePermission` | Associação entre perfil e permissão. | DEC-134 |
| Atribuição de perfil (com escopo) | `RoleAssignment` | Concede um perfil a um vínculo em um escopo, com ou sem subárvore (`includeSubtree`), e com vigência (`validFrom`, `validUntil`). | DEC-134. Escopo em `ScopeType` |
| Escopo | `ScopeType` | Abrangência da atribuição: todo o tenant, um órgão, uma unidade específica ou as unidades de lotação. | DEC-024; DEC-134 |
| Participante do processo | `ProcessParticipant` | Acesso explícito a um processo específico, concedido a usuário ou unidade: observador, colaborador ou consultor. Participantes nunca tramitam nem aprovam. | DEC-036. Papel em `ParticipantRole`; consultor exige `expiresAt` |
| Conta de serviço | `TenantMembership` do tipo `SERVICE` | Vínculo técnico usado por integrações. | DEC-012. MVP 3 |
| Acesso de suporte | vínculo `EXTERNAL` temporário | Acesso do operador da plataforma por até 72 horas, mediante chamado, auditado como `PLATFORM_OPERATOR` e visível ao administrador do tenant. | DEC-139 |
| Configuração do tenant | `TenantSetting` | Parâmetro chave/valor (ex.: `numbering.process.mask`, `security.mfaPolicy`, `features.<nome>`). | DEC-001; DEC-059 |
| Catálogo | `CatalogItem` (`catalogType`) | Listas parametrizáveis por tenant: `CONTRACTING_TYPE`, `MODALITY`, `PROCESS_ORIGIN`, `UNIT_OF_MEASURE`, `RISK_CATEGORY`, `PRICE_SOURCE_TYPE`, `JUDGMENT_CRITERION`, `ATTACHMENT_CATEGORY`. O `code` é estável; itens de sistema (`isSystem`) podem ser renomeados ou desativados, nunca excluídos. | DEC-027. Metadados por item (ex.: código PNCP da modalidade, base legal) |
| Feriado | `Holiday` | Dia não útil no calendário do tenant: nacionais semeados (inclusive móveis); estaduais e municipais cadastrados. | DEC-031 |
| Sequência de numeração | `NumberSequence` | Contador transacional que gera os números de processos e documentos sem lacunas. | DEC-028 |
| Política de MFA | `security.mfaPolicy` | Exigência de segundo fator: `NONE`, `ADMINS` (padrão: obrigatório para quem tem permissões de risco alto) ou `ALL`. | DEC-133 |
| Provisionamento | módulo `tenancy` | Criação do tenant com cópia do catálogo-base, perfis padrão, workflow padrão e configurações iniciais. | DEC-015; DEC-027; DEC-035 |

> **Nota — "órgão".** A DEC-011 usa "órgão/entidade" para `Organization`, enquanto a DEC-012 chama de "órgão ativo" a escolha do **tenant** na sessão (e a DEC-141 fala em "seleção de órgão"). Para evitar ambiguidade, recomenda-se exibir no seletor da sessão o nome do tenant (ex.: "Município de São José") ou o termo "ente", reservando "órgão/entidade" para `Organization`. A escolha deve ser registrada em `decisions.md`.

---

## 2. Processo e tramitação

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Processo de contratação | `Process` | Agregado central: documentos, versões, aprovações, tramitações, comentários, anexos, prazos, riscos, pesquisas de preço, itens e timeline pertencem a um processo (`processId`). Abrange licitação e contratação direta. | DEC-010 |
| Número do processo | gerado por `NumberSequence`; máscara `numbering.process.mask` | Identificador de negócio (padrão `{seq:4}/{year}`, ex.: `0012/2026`), separado da chave técnica; atribuído na criação ou na autuação (`numbering.process.assignOn`). | DEC-002; DEC-028 |
| Código interno | `internalCode` | Número externo opcional informado pelo órgão (ex.: protocolo legado ou SEI), único por tenant. | DEC-028; PEND-14 |
| Origem | catálogo `PROCESS_ORIGIN` | Origem de negócio da demanda; o canal técnico de criação fica em `creationChannel`. | PEND-14 |
| Tipo de contratação | catálogo `CONTRACTING_TYPE` | Classificação da contratação (ex.: aquisição de bens — código `AQUISICAO_BENS`). | DEC-001; DEC-027 |
| Modalidade | catálogo `MODALITY` | Modalidade de licitação (ex.: pregão — código `PREGAO`). | Art. 28; DEC-027 |
| Situação do processo | `ProcessStatus` | Status macro, independente da etapa do workflow; alterado somente pelo serviço de ciclo de vida (`ProcessLifecycleService`), nunca por edição direta. | DEC-013 |
| Prioridade | `Priority` | Urgência relativa do processo. | — |
| Item da contratação | `ProcessItem` | Identidade canônica do item (nº, lote, natureza, descrição, unidade, código CATMAT/CATSER opcional) com quantidade e preço de referência (`referenceQuantity`, `referenceUnitPrice`), atualizados apenas quando um documento é aprovado ou a pesquisa é concluída. | DEC-019. Natureza em `ItemKind` |
| Valor estimado | `Process.estimatedValue`; `estimatedValueSource` | Derivado pela precedência TR aprovado > pesquisa de preços concluída > ETP > DFD > manual; a origem fica registrada. | DEC-032 |
| Orçamento sigiloso | `Process.isBudgetConfidential` | Faz a API mascarar valores estimados (`null` + `masked: true`) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`. | Art. 24; DEC-030 |
| Etiqueta | `Tag`, `ProcessTag` | Classificação livre definida pelo tenant. | DEC-040 |
| Visão salva | `SavedView` | Combinação salva de filtros e colunas da lista de processos. | DEC-040 |
| Etapa do processo | `ProcessStage` | Instância, no processo, de uma etapa do workflow. No MVP 1 há uma única etapa ativa por processo. | DEC-014 |
| Etapa atual | `currentStageId` | Referência à etapa ativa do processo. | DEC-001; DEC-014 |
| Responsabilidade | `ProcessAssignment` | Histórico de quem responde pela etapa — um usuário ou a unidade, quando não há responsável individual; base da caixa de tarefas. | DEC-014; DEC-026 |
| Tramitação | `ProcessMovement` | Registro imutável de cada movimento do processo (abertura, encaminhamento, devolução, assunção etc.). | DEC-014. Ação em `MovementAction` |
| Encaminhar · devolver · concluir | `FORWARD` · `RETURN` · `COMPLETE` | Ações que percorrem o grafo do workflow (transições). Rotas `/processes/{id}/forward`, `/return`, `/complete`. | DEC-014; DEC-102 |
| Assumir · atribuir · suspender · retomar · cancelar | `CLAIM` · `ASSIGN` · `SUSPEND` · `RESUME` · `CANCEL` | Ações de ciclo de vida, fora do grafo. Assumir = tomar para si um processo que está na unidade sem responsável. | DEC-014; DEC-102 |
| Acesso ao processo | `ProcessAccess` | Índice de visibilidade mantido na mesma transação das mudanças, com os motivos `REQUESTING`, `CURRENT`, `HISTORICAL`, `CREATOR`, `RESPONSIBLE`, `PARTICIPANT` e `APPROVER`. | DEC-024. Recurso não visível ou de outro tenant responde 404 |
| Custódia | política de autorização | Só altera o processo quem está "com o processo": o responsável atual ou, sem responsável, membro da unidade atual. Exceções: gestores com `PROCESS_ASSIGN` (atribuir), participantes colaboradores e consultores (documentos em rascunho ou devolvidos) e aprovadores (suas aprovações). | DEC-023 |
| Caixa de tarefas | módulo `inbox`; rota `/tasks` | Consulta — não existe entidade `Task` — das etapas sob minha responsabilidade ou da minha unidade sem responsável, dos devolvidos, dos atrasados e das aprovações pendentes para mim. | DEC-026 |
| Painel situacional | `GET /processes/{id}/summary` | Topo do detalhe do processo que responde, sem cliques, às 7 perguntas: onde está, quem é o responsável, o que falta, próximo passo, se está atrasado, documentos existentes e aprovações pendentes. | DEC-180 |
| Ações disponíveis | `GET /processes/{id}/available-actions` | Ações que o usuário pode executar agora, considerando permissões, custódia e estado. | DEC-102 |
| Prazo da etapa | `dueAt`; atraso em `overdueSince` | Data-limite da etapa calculada pelo SLA; pausada na suspensão e estendida ao retomar; o atraso é marcado pelo job `deadlines`. | DEC-031 |
| Prazo alvo | `Process.targetDate` | Data planejada para o processo (informativa); o processo está atrasado se o prazo alvo passou e o status não é final. | DEC-031 |
| SLA | `WorkflowStage.slaDays` + `slaType` | Prazo padrão de cada etapa, em dias úteis ou corridos; pode ser sobrescrito no encaminhamento quando a transição permitir. A gestão avançada de SLA chega no MVP 2. | DEC-031. Contagem em `DayCountType` |
| Alerta de prazo próximo | `deadlines.warnBeforeBusinessDays` | Antecedência do aviso de vencimento (padrão: 2 dias úteis). | DEC-031 |
| Suspensão | `SUSPENDED` + `statusBeforeSuspension` | Pausa os prazos e congela as aprovações pendentes; ao retomar, o processo volta ao status anterior. | DEC-013; DEC-031 |
| Duplicação | `duplicatedFromId` | Cópia de metadados, itens, etiquetas e, opcionalmente, do conteúdo dos documentos estruturados como novos rascunhos — nunca de número, aprovações, tramitações, timeline, comentários, auditoria ou participantes. | DEC-033 |
| Descarte de rascunho | exclusão lógica | Rascunho de processo sem número pode ser descartado em vez de cancelado. Nada de processo é excluído fisicamente. | DEC-013; DEC-034 |
| Situação no PCA | `pcaStatus`, `pcaYear`, `pcaItemCode`, `pcaJustification` | Referência ao PCA no processo e no DFD durante o MVP 1; justificativa obrigatória quando a demanda não estiver prevista. No MVP 2, vínculo por `pcaItemId`. | DEC-029. Situação em `PcaStatus` |

---

## 3. Workflow e regras

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Workflow (fluxo) | `Workflow` | Definição configurável das etapas e transições de um tipo de processo; sua aplicabilidade é expressa em JSON Logic (`Workflow.applicabilityRule`). | DEC-014; DEC-016 |
| Versão do workflow | `WorkflowVersion` | Ciclo `DRAFT` → `PUBLISHED` (imutável) → `RETIRED`. O processo fixa a versão na criação (`workflowVersionId`). | DEC-014; DEC-084 |
| Etapa do workflow | `WorkflowStage` | Etapa do fluxo, com tipo (`StageType`), responsável padrão e SLA. | DEC-014; DEC-031 |
| Transição | `WorkflowTransition` | Caminho permitido entre etapas, com ação `FORWARD`, `RETURN`, `APPROVE`, `REJECT` ou `COMPLETE`. | DEC-014 |
| Regra | `WorkflowRule` | Condição avaliada nas ações do processo, dos tipos `REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL` e `CONDITION`, com severidade e mensagem ao usuário configurável. | DEC-016 |
| Status mínimo exigido do documento | `minStatus` | Exigência da regra `REQUIRED_DOCUMENT`: `EXISTS` (qualquer não cancelado), `COMPLETE` (passa na validação de completude), `SUBMITTED` (em revisão, finalizado ou aprovado), `FINAL` (finalizado ou aprovado) ou `APPROVED`. | DEC-018 |
| Severidade | `BLOCKING` · `WARNING` | A regra bloqueante impede a ação; o aviso alerta e permite prosseguir. | DEC-016 |
| JSON Logic | biblioteca `json-logic-js` | Linguagem declarativa, em JSON, para expressar condições sem executar código arbitrário. | DEC-016; ADR-008 |
| Contexto de regras | `RuleContext` (v1) | Conjunto versionado de dados expostos às regras: `process.*`, `documents.<TYPE>.*`, `priceResearch.*`, `risks.*`, `items.*`, `now`. O banco nunca é exposto diretamente. | DEC-016 |
| Workflow padrão | "Fase preparatória — Lei 14.133/2021" | Fluxo semeado com as etapas `ABERTURA`, `APROVACAO_DFD`, `ESTUDOS_PRELIMINARES`, `PESQUISA_PRECOS`, `TERMO_REFERENCIA`, `APROVACAO_AUTORIDADE` e `CONCLUSAO`. | DEC-015 |
| Responsável padrão da etapa | `REQUESTING_DEPARTMENT`, `DEPARTMENT_HEAD`, `CHOSEN_ON_FORWARD`; unidade fixa; perfil no escopo | Forma de definir a quem a etapa é atribuída quando o processo entra nela. | DEC-015. "Unidade fixa" e "perfil no escopo" ainda não têm identificador canônico |
| Regra legal semeada | configuração | Exigência legal representada como regra configurável (ex.: elementos mínimos do ETP), nunca como código. | DEC-016; art. 18, §§ 1º e 2º |

---

## 4. Documentos

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Documento | `Document` | Artefato do processo, com tipo, número, situação, versão atual, versão aprovada e rascunho de trabalho. | DEC-017 |
| Tipo de documento | `DocumentType` | Tipo configurável por tenant, com natureza (`kind`) e indicação de aprovação avulsa (`requiresApproval`). Nos tipos semeados, `requiresApproval = false`: a aprovação formal ocorre nas etapas de aprovação do workflow. | DEC-017; DEC-018. Natureza em `DocumentKind` |
| Códigos dos tipos estruturados | `DFD`, `ETP`, `TR`, `RISK_MAP`, `PRICE_RESEARCH` | Tipos com módulo próprio e dados tipados. | DEC-015; DEC-017 |
| Documento de texto livre | `FREE_TEXT` | Documento redigido a partir de template rico: despacho, ofício, nota técnica. | DEC-017 |
| Arquivo externo | `UPLOADED` | Documento produzido fora da plataforma e enviado como arquivo. | DEC-017 |
| Cabeçalho tipado | `Dfd`, `Etp`, `TermOfReference`, `PriceResearch` | Tabela 1:1 com o documento, com os campos que o sistema precisa filtrar, calcular, validar, reportar ou integrar. | DEC-017 |
| Template (modelo) | `DocumentTemplate` | Modelo de um tipo de documento: seções, textos-padrão e layout do PDF. | DEC-017 |
| Versão do template | `DocumentTemplateVersion` | Versão publicada e imutável do template (snapshot com hash), com a lista de seções (`sections`). | DEC-017; DEC-084 |
| Seção | `sectionKey` (ex.: `NEED_DESCRIPTION`) | Parte narrativa do documento definida pelo template; conteúdo em rich text (TipTap JSON), limitado por padrão a 1 MB por seção. | DEC-001; DEC-017; DEC-056 |
| Rascunho de trabalho | `Document.draftContent` | Conteúdo editável corrente, com revisão por seção; não é uma versão. | DEC-017; DEC-055 |
| Autosave | — | Salvamento automático do rascunho 1,5 s após a digitação e ao perder o foco; não cria versão. Conflito na mesma seção abre diálogo com "Ver diferenças", "Manter a minha versão" e "Descartar a minha e recarregar". | DEC-017; DEC-182 |
| Versão do documento | `DocumentVersion` | Snapshot imutável (cabeçalho, seções e coleções) com hash. Criada ao salvar versão manualmente, submeter, finalizar, importar, enviar nova versão de arquivo e reabrir. | DEC-017; DEC-018 |
| Snapshot | — | Cópia congelada em JSON canonicalizado (RFC 8785/JCS); as linhas são imutáveis no banco. | DEC-084 |
| Hash | `contentHash` (SHA-256) | Impressão digital do conteúdo: qualquer alteração gera outro valor. Também é calculado para PDFs e anexos. | DEC-017; DEC-060; DEC-136 |
| Versão aprovada | `approvedVersionId` | Versão exata aprovada. | DEC-018 |
| Situação do documento | `DocumentStatus` | Ciclo de vida único para todos os tipos de documento. | DEC-018 |
| Finalizar | transição para `FINALIZED` | Conclui documento de tipo sem aprovação avulsa: valida a completude, cria versão e bloqueia a edição; a aprovação formal pode ocorrer depois, em etapa de aprovação que cubra o documento. | DEC-018. Na pesquisa de preços, a ação se chama "Concluir pesquisa" |
| Submeter | `/documents/{id}/submit` | Envia para aprovação avulsa (tipo com `requiresApproval = true`). Também ocorre quando o processo entra em etapa de aprovação que cobre um documento ainda em rascunho ou devolvido. | DEC-018; DEC-102 |
| Retirar da submissão | `/documents/{id}/withdraw` | Desfaz a submissão e cancela a aprovação pendente. | DEC-018 |
| Reabrir | `/documents/{id}/reopen` | Cria novo rascunho a partir da última versão de documento aprovado, finalizado ou indeferido; exige a permissão `DOCUMENT_REOPEN` e justificativa. | DEC-018 |
| Cancelar documento | `/documents/{id}/cancel` | Encerra documento em rascunho ou devolvido, com justificativa; situação final. Documento nunca submetido pode ser excluído logicamente. | DEC-018; DEC-034 |
| Validação de completude | — | Verificação das seções e dos campos obrigatórios do tipo, exigida para finalizar ou submeter. | DEC-018 |
| Renderização (PDF) | `DocumentRendition` | PDF gerado a partir de uma versão, com hash SHA-256; tipo em `RenditionKind`. A pré-visualização de rascunho tem marca d'água "RASCUNHO" e expira em 24 h. | DEC-017; DEC-060 |
| Item do documento | `DocumentItem` | Linha de um item em um documento (DFD, ETP, TR): quantidade daquele documento, memória de cálculo (ETP), especificação e critérios de aceitação (TR). | DEC-019 |
| Documento restrito | `confidentiality = RESTRICTED` | Marcação aplicada aos documentos com valores quando o orçamento é sigiloso. | DEC-030 |

---

## 5. DFD

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| DFD — Documento de Formalização da Demanda | `Dfd` (tipo `DFD`; rota `/dfds`) | Documento em que a área requisitante evidencia e detalha a necessidade da contratação; registra itens, quantidades, justificativa e a situação no PCA. | Art. 12, VII; art. 72, I; Decreto 10.947/2022; DEC-029 |
| Área requisitante / setor solicitante | unidade solicitante (`REQUESTING_DEPARTMENT`) | Unidade que demanda a contratação e responde pela etapa de abertura no workflow padrão. | DEC-011; DEC-015 |
| Aprovação da demanda | etapa `APROVACAO_DFD` | Decisão do titular da secretaria solicitante sobre o DFD. | DEC-015 |
| DFD criado · DFD aprovado | `DFDCreated` · `DFDApproved` | Nomes especializados dos eventos `DocumentCreated` e `DocumentApproved` para o tipo DFD (routing keys `document.created.dfd` e `document.approved.dfd`). | DEC-162 |

---

## 6. ETP

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| ETP — Estudo Técnico Preliminar | `Etp` (tipo `ETP`; rota `/etps`) | Documento da primeira etapa do planejamento, que caracteriza o interesse público e a melhor solução e dá base ao TR ou ao projeto. | Art. 6º, XX; art. 18, §§ 1º e 2º; IN SEGES/ME 58/2022 |
| Alternativa de solução | `EtpAlternative` | Opção analisada no levantamento de mercado, com decisão (`AlternativeDecision`) e justificativa técnica e econômica. | Art. 18, § 1º, V; evento `EtpAlternativeRecommended` |
| Elementos mínimos do ETP | regras semeadas | Incisos I (necessidade), IV (quantidades), VI (estimativa de valor), VIII (parcelamento) e XIII (posicionamento conclusivo) do § 1º; a ausência dos demais elementos exige justificativa. | Art. 18, § 2º; DEC-016 |
| Memória de cálculo | `DocumentItem` (no ETP) | Demonstração de como as quantidades foram estimadas. | Art. 18, § 1º, IV |
| Decisão de parcelamento | `ParcelingDecision` | Justificativa para parcelar ou não a contratação. | Art. 18, § 1º, VIII; arts. 40 e 47 |
| Conclusão do ETP | `EtpConclusion` | Posicionamento conclusivo sobre a viabilidade da contratação. | Art. 18, § 1º, XIII |
| ETP criado · ETP aprovado | `ETPCreated` · `ETPApproved` | Nomes especializados dos eventos `DocumentCreated` e `DocumentApproved` para o tipo ETP. | DEC-162 |

---

## 7. Pesquisa de preços

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Pesquisa de preços (PesquisaPreco) | `PriceResearch` (tipo `PRICE_RESEARCH`; rota `/price-research`) | Cabeçalho tipado 1:1 com o documento; uma pesquisa não cancelada por processo no MVP 1. Não tem status próprio: usa a situação do `Document` e `completedAt`. | Art. 23; IN SEGES/ME 65/2021; DEC-018; DEC-020 |
| Item da pesquisa (PesquisaItem) | `PriceItem` | Linha do item na pesquisa, com estatísticas persistidas. | DEC-019; DEC-020 |
| Fonte de pesquisa (FontePesquisa) — instância | `PriceSource` | Evidência concreta consultada, com data e hora — ex.: "Orçamento Empresa X de 10/09/2026", "Painel de Preços consultado em 12/09/2026 14:32". | Art. 23, § 1º; DEC-020 |
| Tipo de fonte — catálogo | catálogo `PRICE_SOURCE_TYPE` | Classificação da fonte (ex.: painel de preços, contratações similares, mídia ou sítio especializado, pesquisa direta com fornecedor, nota fiscal), com os campos exigidos por tipo nos metadados. | Art. 23, § 1º, I a V; DEC-027 |
| Cotação | `Quotation` | Preço de **um item** em **uma fonte**; válida ou desconsiderada (`QuotationStatus`), com motivo (`ExclusionReason`) e justificativa quando desconsiderada. | DEC-020; eventos `QuotationExcluded`, `QuotationRestored` |
| Fornecedor | `Supplier` | Cadastro do tenant identificado por CNPJ (inclusive alfanumérico) ou CPF; compartilhado com a gestão contratual (MVP 4). | IN RFB 2.229/2024; DEC-020; DEC-040 |
| Média | `MEAN` | Soma dos preços válidos dividida pela quantidade de cotações válidas. | IN SEGES/ME 65/2021 |
| Mediana | `MEDIAN` | Valor central das cotações válidas ordenadas (média dos dois centrais se a quantidade for par); menos sensível a valores extremos. | IN SEGES/ME 65/2021 |
| Menor preço | `LOWEST` | Menor valor entre as cotações válidas. | IN SEGES/ME 65/2021 |
| Manual justificado | `MANUAL` | Valor definido por outro critério, com justificativa obrigatória. | IN SEGES/ME 65/2021 (outros critérios justificados) |
| Método de cálculo | `PriceCalculationMethod` | Método que define o valor recomendado por item; total = valor unitário × quantidade. | DEC-020 |
| Desvio-padrão amostral | — | Medida de dispersão das cotações válidas. | DEC-020 |
| Coeficiente de variação (CV) | — | Desvio-padrão dividido pela média, em percentual; mede a dispersão relativa. Padrão: CV acima de 25% sugere a mediana; caso contrário, a média. | DEC-020 |
| Inexequível | `UNFEASIBLE` | Preço baixo a ponto de indicar impossibilidade de execução. Sinalizado por faixa configurável (padrão: abaixo de 70% da mediana dos demais); a exclusão é sempre manual e justificada. | IN SEGES/ME 65/2021; DEC-020 |
| Excessivamente elevado | `EXCESSIVE` | Preço muito acima dos demais (padrão: acima de 130% da mediana dos demais), com risco de sobrepreço. | IN SEGES/ME 65/2021; DEC-020 |
| Valor atípico (outlier) | — | Cotação fora das faixas configuradas; é **sinalizada**, nunca excluída automaticamente. | DEC-020 |
| Mínimo de cotações | parâmetro (padrão: 3) | Quantidade mínima de preços válidos por item; abaixo dela, exige justificativa. | Art. 23, § 1º, IV; IN SEGES/ME 65/2021; DEC-020 |
| Validade da cotação direta | parâmetro (padrão: 180 dias) | Prazo máximo do orçamento obtido diretamente com fornecedor. | Art. 23, § 1º, IV (orçamentos de até 6 meses); DEC-020 |
| Snapshot de parâmetros | — | Cópia dos parâmetros do tenant feita na criação da pesquisa, para que mudanças posteriores não alterem pesquisas em andamento. | DEC-020 |
| Mapa comparativo | tela SCR-010 | Quadro item × fonte com as estatísticas e o valor recomendado. | — |
| Concluir pesquisa | `/price-research/{id}/complete` | Finaliza o documento da pesquisa (`FINALIZED` e `completedAt`); emite `DocumentFinalized` com routing key `document.finalized.price_research` (nome especializado `PriceResearchCompleted`). | DEC-018; DEC-162 |
| Recálculo da pesquisa | evento `PriceResearchRecalculated` | Fato de recálculo das estatísticas da pesquisa. | DEC-162 |

---

## 8. Riscos

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Risco | `Risk` | Evento incerto que pode comprometer a contratação: título, descrição, categoria (`RISK_CATEGORY`), fase (`RiskPhase`), causa, consequência, probabilidade, impacto, pontuação, nível (`RiskLevel`), responsável e situação (`RiskStatus`). | Art. 18, X; DEC-021; eventos `RiskCreated`, `RiskAssessed` |
| Tratamento do risco | `RiskTreatment` | Ação preventiva ou de contingência (`TreatmentType`), com responsável, prazo e situação (`TreatmentStatus`). | DEC-021; evento `RiskTreatmentChanged` |
| Matriz probabilidade × impacto (P×I) | escala configurável | Pontuação = probabilidade × impacto. Padrão 5 × 5, com faixas 1–4 Baixo, 5–9 Médio, 10–16 Alto e 17–25 Extremo. | DEC-021 |
| Mapa de riscos | documento `RISK_MAP` | Artefato formal, versionado e aprovável, cujo snapshot inclui os riscos do processo. | DEC-021. Não confundir com a matriz de riscos contratual (§12) |

---

## 9. Termo de Referência

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Termo de Referência (TR) | `TermOfReference` (tipo `TR`; rota `/terms`) | Documento que define o objeto e as condições da contratação de bens e serviços: objeto, fundamentação, solução, requisitos, modelos de execução e de gestão, medição e pagamento, seleção do fornecedor, estimativas de valor e adequação orçamentária. | Art. 6º, XXIII, *a* a *j*; art. 40, § 1º; IN SEGES/ME 81/2022 |
| Importar do ETP | `/terms/{id}/import-etp` | Copia para o TR conteúdo e itens do ETP, evitando redigitação. | DEC-102; evento `TermImportedFromEtp` |
| TR concluído | `DocumentFinalized` (TR) | Nome especializado `TermCompleted`, routing key `document.finalized.tr`. | DEC-162 |
| Especificação e critérios de aceitação | `DocumentItem` (no TR) | Descrição técnica do item e condições de recebimento. | DEC-019; art. 40, § 1º |
| Critério de adjudicação | `AwardType` | Forma de adjudicar o objeto: por item, por lote ou global. | Art. 40; art. 82, § 1º |
| Natureza do item | `ItemKind` | Bem, serviço, serviço de engenharia ou obra. | Art. 6º, XII e XXI |

---

## 10. Aprovações

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Aprovação | `Approval` | Solicitação de decisão sobre uma etapa de aprovação do workflow (`subjectType = PROCESS_STAGE`) ou sobre um documento submetido avulsamente (`DOCUMENT`). | DEC-022. Situação em `ApprovalStatus` |
| Documento coberto | `ApprovalDocument` | Versões exatas dos documentos cobertas pela decisão. | DEC-022 |
| Decisão | `ApprovalDecision`; rota `/approvals/{id}/decide` | Aprovar, devolver ou indeferir. | DEC-022 |
| Aprovador | resolução `USER`, `ROLE` (no escopo) ou `DEPARTMENT_HEAD` | Quem pode decidir; resolvido e gravado no momento da solicitação. | DEC-022 |
| Substituto | `deputyUserId`; `allowDeputy` | Substituto da unidade, que pode decidir quando permitido. | DEC-022 |
| Política de decisão | `ANY` | Um aprovador decide. Múltiplos aprovadores e aprovação sequencial: MVP 2. | DEC-022; PEND-13 |
| Segregação de funções | `approval.preventSelfApproval` (padrão `true`) | O autor de um documento coberto não pode aprová-lo. | Art. 5º; art. 7º, § 1º; DEC-022 |
| Aprovação pendente de documento finalizado | `pendingApprovalId` | Indica que um documento `FINALIZED` está sob aprovação de etapa; a situação do documento não muda durante a análise. | DEC-018 |
| Indeferimento | `REJECT` | Por padrão, o processo volta à etapa de origem como `RETURNED`, o documento fica `REJECTED` e o sistema sugere o cancelamento. | PEND-02 |
| Nova aprovação de documento aprovado | — | Documento já aprovado, coberto por nova aprovação de etapa, permanece aprovado; a nova decisão é registrada para a mesma versão. | DEC-018 |

---

## 11. Colaboração, notificações e auditoria

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| Comentário | `Comment` | Mensagem registrada no processo, visível a quem vê o processo. | DEC-040. Comentários restritos por unidade: PEND-11 |
| Menção | `Mention` | Citação de usuário em comentário (@nome), que gera notificação. | DEC-040 |
| Anexo | `Attachment` | Arquivo vinculado ao processo, com categoria (`ATTACHMENT_CATEGORY`), verificação antivírus e de tipo, hash e situação (`AttachmentStatus`); limite padrão de 50 MB. | DEC-136. Exclusão lógica com motivo (DEC-034) |
| Notificação | `Notification` | Aviso in-app e por e-mail; notificações lidas são arquivadas após 180 dias. | DEC-040; DEC-085 |
| Preferência de notificação | `NotificationPreference` | Escolha de tipos e canais de notificação por usuário. | DEC-040 |
| Timeline (linha do tempo) | `ProcessTimelineEntry` | Narrativa curada do processo para usuários, com nomes congelados no tempo; visível a quem vê o processo. | DEC-025 |
| Trilha de auditoria | `AuditLog` | Registro append-only de ações relevantes — inclusive negadas, acessos, exportações e configurações — com ator, IP, user-agent, diferenças antes e depois (mascaradas), `correlationId` e resultado. Ações no formato `resource.action` (ex.: `approval.decide`). Acesso pela permissão `AUDIT_VIEW`. | DEC-025; ADR-009 |
| Selagem da auditoria | `AuditSeal` | Registro periódico (job `audit-seal`, a cada hora) que sela intervalos da trilha para permitir detectar adulteração. | DEC-025; DEC-163; ADR-009 |
| Timeline × auditoria | — | A timeline é a narrativa para usuários; a auditoria é a evidência de conformidade e segurança. Não são conceitos duplicados. | DEC-025 |
| Evento de domínio | envelope da DEC-160 | Fato ocorrido no domínio (ex.: `ProcessForwarded`, routing key `process.forwarded`), com versão (`eventVersion`), tenant, ator e correlação. | DEC-001; DEC-160 |
| Eventos de documento | `DocumentCreated`, `DocumentSubmitted`, `DocumentFinalized`, `DocumentApproved`, `DocumentReturned`, `DocumentRejected`, `DocumentReopened`, `DocumentCanceled`, `DocumentVersionCreated` | Eventos genéricos do ciclo de vida, com `documentTypeCode` e, opcionalmente, `typedSummary`. | DEC-162 |
| Nome especializado de evento | `DFDCreated`, `DFDApproved`, `ETPCreated`, `ETPApproved`, `PriceResearchCompleted`, `TermCompleted` | O mesmo evento genérico publicado com routing key especializada (ex.: `PriceResearchCompleted` = `DocumentFinalized` de `PRICE_RESEARCH`) — não é uma mensagem separada. | DEC-162 |
| Outbox | `OutboxEvent` | Tabela em que os eventos são gravados na mesma transação da mudança; um relay os publica nas filas. | DEC-161; ADR-004 |
| Identificador de correlação | `correlationId` | Código que liga requisição, logs, eventos e auditoria; único código técnico exibido ao usuário, em mensagens de erro (copiável). | DEC-103; DEC-181; DEC-184 |
| Fila de mensagens mortas | fila `dead-letter` | Destino dos jobs que falharam após todas as tentativas, com alerta. | DEC-163 |

---

## 12. Termos legais da NLLC

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| NLLC | — | Nova Lei de Licitações e Contratos Administrativos — Lei 14.133/2021. | Regime geral das novas contratações desde 30/12/2023 (art. 193, II, na redação da LC 198/2023) |
| Fase preparatória | — | Fase de planejamento do processo licitatório: compatibilização com o PCA e as leis orçamentárias; ETP, TR ou projeto, orçamento estimado, edital, minuta de contrato, modalidade e critério de julgamento, análise de riscos, entre outros elementos. | Art. 17, I; art. 18. No MVP 1, o workflow padrão cobre a parte de planejamento (DEC-015) |
| Equipe de planejamento da contratação | — | Agentes que reúnem as competências necessárias ao planejamento da contratação (área requisitante, área técnica, compras). | Conceito dos regulamentos federais (ex.: IN SEGES/ME 58/2022) |
| Agente de contratação | persona Licitações (`LICITACOES`) | Servidor efetivo ou empregado público designado pela autoridade competente para conduzir a licitação até a homologação; no pregão, chama-se pregoeiro. | Art. 6º, LX; art. 8º |
| Comissão de contratação e equipe de apoio | — | Comissão: agentes que recebem, examinam e julgam documentos em licitações e procedimentos auxiliares; equipe de apoio: auxilia o agente de contratação. | Art. 6º, L; art. 8º, §§ 1º e 2º |
| Autoridade competente | perfil `AUTORIDADE_COMPETENTE` | Agente público com poder de decisão (art. 6º, VI) a quem as normas de organização do ente atribuem a decisão no caso: aprova o planejamento, autoriza a contratação, adjudica e homologa. | Arts. 6º, VI; 7º; 71; 72, VIII. Definida pela regulamentação local |
| Ordenador de despesa | — | Autoridade de cujos atos resultam empenho, autorização de pagamento ou dispêndio de recursos. Pode coincidir com a autoridade competente, mas são papéis distintos. | Decreto-Lei 200/1967, art. 80, § 1º |
| Segregação de funções | `approval.preventSelfApproval` | Vedação de designar o mesmo agente para funções suscetíveis a riscos de forma simultânea, para reduzir a ocultação de erros e fraudes. | Art. 5º; art. 7º, §§ 1º e 2º; DEC-022 |
| Linhas de defesa | — | Primeira: servidores, agentes de licitação e autoridades da estrutura de governança; segunda: assessoramento jurídico e controle interno; terceira: órgão central de controle interno e tribunal de contas. | Art. 169 |
| Contratação direta | catálogo `CONTRACTING_TYPE` | Contratação sem licitação, nas hipóteses de inexigibilidade e dispensa, instruída com os documentos do art. 72 e com divulgação do ato. | Arts. 72 a 75 |
| Dispensa de licitação | — | Hipóteses taxativas em que a licitação é possível, mas dispensada (ex.: por valor, emergência). Os valores-limite são atualizados anualmente e, por isso, configuráveis. | Art. 75; art. 182 |
| Inexigibilidade | — | Contratação direta quando a competição é inviável (ex.: fornecedor exclusivo). | Art. 74 |
| Fracionamento de despesa | — | Divisão indevida do objeto para enquadrar-se em dispensa por valor; os limites consideram o somatório por unidade gestora e por objetos de mesma natureza no exercício. | Art. 75, § 1º |
| Parcelamento | `ParcelingDecision` | Divisão do objeto em itens ou lotes quando tecnicamente viável e economicamente vantajosa; deve ser justificada no ETP. | Arts. 18, § 1º, VIII; 40, V, *b*, e §§ 2º e 3º; 47 |
| Modalidades de licitação | catálogo `MODALITY` | Pregão, concorrência, concurso, leilão e diálogo competitivo. | Art. 28 |
| Pregão | código `PREGAO` | Modalidade obrigatória para bens e serviços comuns; critério de julgamento menor preço ou maior desconto. | Art. 6º, XLI |
| Concorrência | — | Modalidade para bens e serviços especiais e para obras e serviços comuns e especiais de engenharia. | Art. 6º, XXXVIII |
| Concurso | — | Modalidade para escolha de trabalho técnico, científico ou artístico, com prêmio ou remuneração ao vencedor. | Art. 6º, XXXIX |
| Leilão | — | Modalidade para alienação de bens imóveis ou de bens móveis inservíveis ou legalmente apreendidos, a quem oferecer o maior lance. | Art. 6º, XL |
| Diálogo competitivo | — | Modalidade em que a Administração dialoga com licitantes previamente selecionados para desenvolver alternativas que atendam à necessidade, seguida de propostas finais. | Art. 6º, XLII |
| Critério de julgamento | catálogo `JUDGMENT_CRITERION` | Menor preço; maior desconto; melhor técnica ou conteúdo artístico; técnica e preço; maior lance (leilão); maior retorno econômico. | Art. 33 |
| Bens e serviços comuns / especiais | — | Comuns: padrões de desempenho e qualidade definíveis objetivamente por especificações usuais de mercado; especiais: os que não se enquadram como comuns. | Art. 6º, XIII e XIV |
| Obra / serviço de engenharia | `ItemKind`: `WORK` / `ENGINEERING_SERVICE` | Atividades que a lei reserva a arquitetos e engenheiros (no serviço de engenharia, também a técnicos especializados); a obra implica intervenção no meio ambiente que inova o espaço físico ou altera substancialmente um imóvel. | Art. 6º, XII e XXI |
| Anteprojeto, projeto básico e projeto executivo | — | Documentos técnicos de obras e serviços de engenharia que cumprem, nesses objetos, papel equivalente ao do TR. | Art. 6º, XXIV a XXVI. Sem tipo estruturado no MVP 1 (roadmap, L-06) |
| Edital | módulo `tender` (MVP 2) | Ato convocatório da licitação, com seus anexos (TR, minuta de contrato etc.). | Art. 18, V e VI; art. 25 |
| Parecer jurídico | `LegalReview` (MVP 2) | Controle prévio de legalidade feito pelo órgão de assessoramento jurídico ao final da fase preparatória, também em contratações diretas e aditivos. | Art. 53 |
| Dotação orçamentária | `BudgetAllocation` (MVP 2) | Indicação dos créditos orçamentários que custearão a contratação. | Art. 72, IV; art. 150 |
| Sistema de registro de preços (SRP) e ata de registro de preços | — | Procedimentos para registro formal de preços para contratações futuras; a ata é o documento vinculativo do compromisso. | Art. 6º, XLV e XLVI; arts. 82 a 86. Fora do escopo atual (roadmap, L-05) |
| PNCP — Portal Nacional de Contratações Públicas | `PNCPProvider` (MVP 3) | Sítio oficial de divulgação centralizada e obrigatória dos atos da lei (PCA, editais e avisos, atas, contratos e aditivos, entre outros). | Art. 174 |
| Diário oficial | `DiarioOficialProvider` (MVP 3) | Veículo oficial de publicação de extratos; obrigatório para extrato do edital e, para municípios que ainda não adotaram o PNCP, para as demais divulgações. | Art. 54, § 1º; art. 176, parágrafo único |
| PCA — Plano de Contratações Anual | `Pca`, `PcaItem` (MVP 2) | Plano das contratações do exercício, elaborado a partir dos DFDs, divulgado em sítio oficial e observado nas licitações e contratos. | Art. 12, VII e § 1º; Decreto 10.947/2022; DEC-029 |
| CATMAT / CATSER | código opcional em `ProcessItem` | Catálogos de materiais e de serviços do Governo Federal; a lei admite a adoção do catálogo federal por todos os entes. | Art. 19, II; DEC-019 |
| Orçamento sigiloso | `Process.isBudgetConfidential` | Orçamento estimado mantido em sigilo, de forma justificada, sem prejuízo da divulgação dos quantitativos; o sigilo não prevalece para os órgãos de controle interno e externo. | Art. 24; DEC-030 |
| Adjudicação por item / por lote / global | `AwardType` | Forma de atribuir o objeto ao vencedor: cada item separadamente, por grupo de itens ou o objeto inteiro. | Art. 40; art. 82, § 1º |
| Adjudicação e homologação | — | Atos da autoridade superior ao final da licitação: atribui o objeto ao vencedor e confirma a regularidade do procedimento. | Art. 71, IV. Registro do resultado é lacuna (roadmap, L-01) |
| Garantia contratual | — (MVP 4) | Garantia de execução do contrato prestada pelo contratado (caução, seguro-garantia, fiança bancária ou título de capitalização), em percentual do valor do contrato: até 5%, até 10% conforme complexidade e riscos, até 30% em obras e serviços de engenharia de grande vulto. | Arts. 96 a 102 |
| Garantia do objeto | — | Prazo e condições de garantia técnica do bem ou serviço (assistência e manutenção), definidos no ETP e no TR. **Não se confunde com a garantia contratual.** | Art. 18, § 1º, VII; art. 40, § 1º, III. Exemplo de validação do MVP 5: "Garantia divergente" |
| Matriz de riscos | — | Cláusula contratual que aloca riscos e responsabilidades entre as partes e caracteriza o equilíbrio econômico-financeiro inicial; obrigatória em obras e serviços de grande vulto e nos regimes de contratação integrada e semi-integrada. **Diferente do mapa de riscos** do planejamento. | Art. 6º, XXVII; art. 22 |
| Sobrepreço / superfaturamento | — | Sobrepreço: preço orçado ou contratado expressivamente superior aos referenciais de mercado; superfaturamento: dano ao patrimônio na execução (medições a maior, qualidade inferior, entre outros). | Art. 6º, LVI e LVII |
| Fiscal de contrato / gestor de contrato | `ContractInspector` / `ContractManager` (MVP 4) | Agentes designados para acompanhar e fiscalizar a execução (fiscal) e coordenar a gestão do contrato (gestor). | Art. 117; art. 7º; Decreto 11.246/2022 (federal) |
| Termo aditivo, apostilamento, reajuste e repactuação | `ContractAmendment` (MVP 4) | Aditivo: formaliza alterações contratuais; apostila: registra o que não caracteriza alteração (ex.: reajuste previsto); reajuste: aplicação do índice de correção previsto no contrato; repactuação: revisão pela variação dos custos contratuais em serviços contínuos com dedicação exclusiva ou predominância de mão de obra. | Arts. 124 a 136; art. 6º, LVIII e LIX |
| Vigência e prorrogação | — (MVP 4) | Duração prevista em edital; serviços e fornecimentos contínuos com prazo de até 5 anos, prorrogáveis até 10 anos. | Arts. 105 a 107 |

---

## 13. Siglas técnicas

| Termo (pt-BR) | Identificador técnico | Definição | Base legal / observação |
|---|---|---|---|
| BFF — Backend for Frontend | `apps/web` (Next.js) | Camada de servidor dedicada à interface web: faz o login, guarda a sessão e encaminha chamadas à API; tokens nunca chegam ao navegador. | DEC-053; ADR-003 |
| CSP — Content Security Policy | cabeçalho HTTP | Política que restringe as origens de scripts e recursos da página. | DEC-135 (CSP estrita com nonce) |
| DLQ — Dead-Letter Queue | fila `dead-letter` | Fila para mensagens que falharam definitivamente. | DEC-163 |
| eMAG — Modelo de Acessibilidade em Governo Eletrônico | — | Padrão brasileiro de acessibilidade digital para governo. | DEC-183 (eMAG 3.1) |
| ETag — Entity Tag | cabeçalhos `ETag` / `If-Match` | Identificador de versão de um recurso HTTP, usado na concorrência otimista; divergência resulta em 412 `VERSION_CONFLICT`. | DEC-104 |
| FTS — Full-Text Search | coluna `search_vector` | Busca textual do PostgreSQL em português, sem acentos. | DEC-057 |
| JCS — JSON Canonicalization Scheme | RFC 8785 | Forma canônica de JSON usada para calcular hashes estáveis. | DEC-084 |
| JWT / JWKS | — | Token assinado / conjunto de chaves públicas para validá-lo. | DEC-132 |
| KMS — Key Management Service | — | Serviço de gestão de chaves criptográficas. | DEC-086; DEC-137 |
| LAI — Lei de Acesso à Informação | Lei 12.527/2011 | Regras de transparência ativa e passiva. | Ver §4.3 da [visão do produto](product-overview.md#43-regulamentos-federais-e-normas-correlatas) |
| LGPD — Lei Geral de Proteção de Dados Pessoais | Lei 13.709/2018 | Regras de tratamento de dados pessoais; o órgão é controlador e a plataforma, operadora. | DEC-140 |
| MFA — autenticação multifator | `security.mfaPolicy` | Login com segundo fator (TOTP ou WebAuthn). | DEC-133 |
| OIDC — OpenID Connect | Authentik | Protocolo de autenticação sobre OAuth 2.0. | DEC-130 |
| PDF/A | — | Formato de PDF para preservação de longo prazo (ISO 19005). | PEND-09 (avaliado no MVP 3) |
| PKCE — Proof Key for Code Exchange | método S256 | Extensão do fluxo Authorization Code que protege contra interceptação do código. | DEC-130 |
| RBAC — Role-Based Access Control | `Role`, `RoleAssignment` | Controle de acesso baseado em perfis, aqui com escopo e políticas contextuais. | DEC-134 |
| RLS — Row-Level Security | política `tenant_id = current_setting('app.tenant_id')` | Recurso do PostgreSQL que filtra linhas por tenant em toda tabela de negócio (`ENABLE` + `FORCE`). | DEC-082 |
| RPO / RTO | — | Perda máxima de dados tolerada / tempo máximo de recuperação. | Metas propostas na [visão do produto](product-overview.md#122-kpis-e-metas-iniciais-propostas) (C7) |
| S3 | API compatível com S3 | Armazenamento de objetos (anexos e PDFs), com bucket de quarentena para uploads. | DEC-050; DEC-136 |
| SHA-256 | — | Função de hash criptográfico usada em versões, PDFs e anexos. | DEC-017; DEC-060; DEC-136 |
| SIC — Serviço de Informação ao Cidadão | — | Canal de pedidos de acesso à informação (LAI). | Persona P14 |
| SLA — Service Level Agreement | `WorkflowStage.slaDays` | No produto, prazo padrão de uma etapa; no suporte, tempo de atendimento acordado. | DEC-031 |
| SSO — Single Sign-On | — | Login único federado com o provedor de identidade do órgão. | DEC-130 (futuro) |
| SUS — System Usability Scale | — | Questionário padronizado de usabilidade (0 a 100). | Meta S1 da visão do produto |
| TOTP — Time-based One-Time Password | — | Código temporário gerado por aplicativo autenticador. | DEC-133 |
| UUIDv7 | chave primária `id` | Identificador único ordenável no tempo, gerado pela aplicação; nunca sequencial ou previsível. | DEC-002 |
| WCAG — Web Content Accessibility Guidelines | — | Diretrizes internacionais de acessibilidade; o produto adota o nível AA da versão 2.1. | DEC-183 |
| WebAuthn — Web Authentication | — | Padrão de autenticação com chaves de segurança e biometria. | DEC-133 |
| IN, SEGES/ME | — | Instrução Normativa; Secretaria de Gestão do então Ministério da Economia, emissora das INs 65/2021, 58/2022 e 81/2022. | [Visão do produto, §4.3](product-overview.md#43-regulamentos-federais-e-normas-correlatas) |
| TCE / TCU | — | Tribunal de Contas do Estado / da União — terceira linha de defesa. | Art. 169, III |

---

## 14. Rótulos de enums na interface

Valores técnicos e rótulos **exatos** a usar na interface, em e-mails e em notificações. A interface nunca exibe o valor técnico (DEC-184). Status de aprovação usam o feminino (concordam com "aprovação"); status de documento e de processo usam o masculino. Sugestão de chave de tradução (next-intl): `enum.<NomeDoEnum>.<VALOR>`.

### 14.1 Processo e tramitação

| Enum | Valor técnico | Rótulo na interface | Observação |
|---|---|---|---|
| `ProcessStatus` | `DRAFT` | Rascunho | Rascunho sem número pode ser descartado (DEC-013) |
| `ProcessStatus` | `IN_PROGRESS` | Em andamento | |
| `ProcessStatus` | `AWAITING_APPROVAL` | Aguardando aprovação | Processo em etapa do tipo `APPROVAL` |
| `ProcessStatus` | `RETURNED` | Devolvido | |
| `ProcessStatus` | `SUSPENDED` | Suspenso | Pausa prazos; guarda o status anterior |
| `ProcessStatus` | `CANCELED` | Cancelado | Final |
| `ProcessStatus` | `COMPLETED` | Concluído | Final no MVP 1; leva a `PUBLISHED` no MVP 3 |
| `ProcessStatus` | `PUBLISHED` | Publicado | Existe desde o MVP 1, alcançável apenas no MVP 3 (PEND-16) |
| `Priority` | `LOW` | Baixa | |
| `Priority` | `MEDIUM` | Média | |
| `Priority` | `HIGH` | Alta | |
| `Priority` | `URGENT` | Urgente | |
| `StageType` | `START` | Início | |
| `StageType` | `TASK` | Tarefa | |
| `StageType` | `APPROVAL` | Aprovação | |
| `StageType` | `END` | Conclusão | |
| `MovementAction` | `CREATE` | Abertura | |
| `MovementAction` | `FORWARD` | Encaminhamento | |
| `MovementAction` | `RETURN` | Devolução | |
| `MovementAction` | `CLAIM` | Assunção | Assumir processo da unidade |
| `MovementAction` | `ASSIGN` | Atribuição | |
| `MovementAction` | `APPROVE` | Aprovação | Decorre da decisão de uma `Approval` |
| `MovementAction` | `REJECT` | Indeferimento | Decorre da decisão de uma `Approval` |
| `MovementAction` | `COMPLETE` | Conclusão | |
| `MovementAction` | `CANCEL` | Cancelamento | |
| `MovementAction` | `SUSPEND` | Suspensão | |
| `MovementAction` | `RESUME` | Retomada | |
| `ParticipantRole` | `OBSERVER` | Observador | Vê e recebe notificações ("seguir processo") |
| `ParticipantRole` | `COLLABORATOR` | Colaborador | Vê, comenta, edita documentos em rascunho, anexa |
| `ParticipantRole` | `CONSULTANT` | Consultor | Como colaborador, com `expiresAt` obrigatório; padrão para vínculos externos |
| `DayCountType` | `BUSINESS` | Dias úteis | Exclui sábados, domingos e feriados do tenant |
| `DayCountType` | `CALENDAR` | Dias corridos | |

### 14.2 Documentos e aprovações

| Enum | Valor técnico | Rótulo na interface | Observação |
|---|---|---|---|
| `DocumentStatus` | `DRAFT` | Rascunho | |
| `DocumentStatus` | `IN_REVIEW` | Em revisão | |
| `DocumentStatus` | `RETURNED` | Devolvido | Editável pelo custodiante |
| `DocumentStatus` | `FINALIZED` | Finalizado | Concluído sem aprovação formal; pode ser aprovado depois em etapa de aprovação (DEC-018) |
| `DocumentStatus` | `APPROVED` | Aprovado | |
| `DocumentStatus` | `REJECTED` | Indeferido | Só volta a rascunho por reabertura |
| `DocumentStatus` | `CANCELED` | Cancelado | Final |
| `DocumentKind` | `STRUCTURED` | Estruturado | |
| `DocumentKind` | `FREE_TEXT` | Texto livre | |
| `DocumentKind` | `UPLOADED` | Arquivo externo | |
| `RenditionKind` | `PREVIEW` | Pré-visualização | Marca d'água "RASCUNHO"; expira em 24 h |
| `RenditionKind` | `CONTENT` | Documento | |
| `RenditionKind` | `APPROVAL_STAMPED` | Com registro de aprovação | |
| `RenditionKind` | `SIGNED` | Assinado | Disponível a partir do MVP 3 |
| `ApprovalStatus` | `PENDING` | Pendente | |
| `ApprovalStatus` | `APPROVED` | Aprovada | |
| `ApprovalStatus` | `RETURNED` | Devolvida | |
| `ApprovalStatus` | `REJECTED` | Indeferida | |
| `ApprovalStatus` | `CANCELED` | Cancelada | Retirada da submissão ou cancelamento do processo |
| `ApprovalDecision` | `APPROVE` | Aprovar | |
| `ApprovalDecision` | `RETURN` | Devolver | Motivo obrigatório |
| `ApprovalDecision` | `REJECT` | Indeferir | Justificativa obrigatória; consequência padrão na PEND-02 |
| `AttachmentStatus` | `PENDING_UPLOAD` | Aguardando envio | |
| `AttachmentStatus` | `UPLOADED` | Enviado | |
| `AttachmentStatus` | `SCANNING` | Em verificação | |
| `AttachmentStatus` | `AVAILABLE` | Disponível | |
| `AttachmentStatus` | `INFECTED` | Infectado | Detectado pelo antivírus (DEC-136) |
| `AttachmentStatus` | `REJECTED` | Rejeitado | Tipo de arquivo não permitido (DEC-136) |
| `AttachmentStatus` | `DELETED` | Excluído | Exclusão lógica com motivo (DEC-034) |

### 14.3 Organização e acesso

| Enum | Valor técnico | Rótulo na interface | Observação |
|---|---|---|---|
| `MembershipType` | `INTERNAL` | Servidor/interno | |
| `MembershipType` | `EXTERNAL` | Externo | Validade obrigatória (DEC-012) |
| `MembershipType` | `SERVICE` | Conta de serviço | MVP 3 |
| `MembershipStatus` | `INVITED` | Convidado | |
| `MembershipStatus` | `ACTIVE` | Ativo | |
| `MembershipStatus` | `SUSPENDED` | Suspenso | |
| `MembershipStatus` | `REVOKED` | Revogado | |
| `MembershipStatus` | `EXPIRED` | Expirado | Validade do vínculo vencida |
| `ScopeType` | `TENANT` | Todo o tenant | Sugestão de UX: complementar com o nome do tenant (ex.: "Todo o tenant — Município de São José") |
| `ScopeType` | `ORGANIZATION` | Órgão/entidade | |
| `ScopeType` | `DEPARTMENT` | Unidade específica | Com ou sem subárvore (`includeSubtree`) |
| `ScopeType` | `OWN_DEPARTMENTS` | Minhas unidades | Unidades de lotação do vínculo |
| `TenantStatus` | `PROVISIONING` | Em implantação | |
| `TenantStatus` | `ACTIVE` | Ativo | Único status que aceita requisições (DEC-132) |
| `TenantStatus` | `SUSPENDED` | Suspenso | |
| `TenantStatus` | `OFFBOARDING` | Em encerramento | |
| `TenantStatus` | `DEACTIVATED` | Desativado | |
| `DepartmentType` | `SECRETARIAT` | Secretaria | Rótulo configurável (`labels.secretariat`) |
| `DepartmentType` | `BOARD` | Diretoria | |
| `DepartmentType` | `DEPARTMENT` | Departamento | |
| `DepartmentType` | `DIVISION` | Divisão | |
| `DepartmentType` | `SECTOR` | Setor | |
| `DepartmentType` | `COMMITTEE` | Comissão | |
| `DepartmentType` | `OTHER` | Outro | |

### 14.4 PCA, pesquisa de preços e itens

| Enum | Valor técnico | Rótulo na interface | Observação |
|---|---|---|---|
| `PcaStatus` | `PLANNED` | Previsto no PCA | |
| `PcaStatus` | `NOT_PLANNED` | Não previsto (com justificativa) | `pcaJustification` obrigatória (DEC-029) |
| `PcaStatus` | `NOT_APPLICABLE` | Não se aplica | |
| `PriceCalculationMethod` | `MEAN` | Média | |
| `PriceCalculationMethod` | `MEDIAN` | Mediana | |
| `PriceCalculationMethod` | `LOWEST` | Menor preço | |
| `PriceCalculationMethod` | `MANUAL` | Manual justificado | Justificativa obrigatória |
| `QuotationStatus` | `VALID` | Válida | |
| `QuotationStatus` | `EXCLUDED` | Desconsiderada | Exige motivo e justificativa; auditada (DEC-020) |
| `ExclusionReason` | `UNFEASIBLE` | Inexequível | |
| `ExclusionReason` | `EXCESSIVE` | Excessivamente elevado | |
| `ExclusionReason` | `INCONSISTENT` | Inconsistente | |
| `ExclusionReason` | `EXPIRED` | Fora da validade | Orçamento além da validade configurada (padrão 180 dias) |
| `ExclusionReason` | `NON_COMPLIANT` | Não atende à especificação | |
| `ExclusionReason` | `OTHER` | Outro | |
| `ItemKind` | `GOOD` | Bem | |
| `ItemKind` | `SERVICE` | Serviço | |
| `ItemKind` | `ENGINEERING_SERVICE` | Serviço de engenharia | |
| `ItemKind` | `WORK` | Obra | |
| `AwardType` | `BY_ITEM` | Por item | |
| `AwardType` | `BY_LOT` | Por lote | |
| `AwardType` | `GLOBAL` | Global | |

### 14.5 ETP e riscos

| Enum | Valor técnico | Rótulo na interface | Observação |
|---|---|---|---|
| `AlternativeDecision` | `UNDER_ANALYSIS` | Em análise | |
| `AlternativeDecision` | `RECOMMENDED` | Recomendada | Emite `EtpAlternativeRecommended` |
| `AlternativeDecision` | `DISCARDED` | Descartada | |
| `EtpConclusion` | `PENDING` | Pendente | |
| `EtpConclusion` | `VIABLE` | Viável | |
| `EtpConclusion` | `NOT_VIABLE` | Inviável | |
| `ParcelingDecision` | `PARCELED` | Parcelada | |
| `ParcelingDecision` | `NOT_PARCELED` | Não parcelada | |
| `ParcelingDecision` | `NOT_APPLICABLE` | Não se aplica | |
| `RiskLevel` | `LOW` | Baixo | Faixa padrão 1–4 (DEC-021) |
| `RiskLevel` | `MEDIUM` | Médio | Faixa padrão 5–9 |
| `RiskLevel` | `HIGH` | Alto | Faixa padrão 10–16 |
| `RiskLevel` | `EXTREME` | Extremo | Faixa padrão 17–25 |
| `RiskStatus` | `OPEN` | Aberto | |
| `RiskStatus` | `IN_TREATMENT` | Em tratamento | |
| `RiskStatus` | `MITIGATED` | Mitigado | |
| `RiskStatus` | `MATERIALIZED` | Materializado | |
| `RiskStatus` | `CLOSED` | Encerrado | |
| `RiskPhase` | `PLANNING` | Planejamento | |
| `RiskPhase` | `SELECTION` | Seleção do fornecedor | |
| `RiskPhase` | `CONTRACT_MANAGEMENT` | Gestão contratual | |
| `TreatmentType` | `PREVENTIVE` | Preventiva | |
| `TreatmentType` | `CONTINGENCY` | Contingência | |
| `TreatmentStatus` | `PLANNED` | Planejada | |
| `TreatmentStatus` | `IN_PROGRESS` | Em andamento | |
| `TreatmentStatus` | `DONE` | Concluída | |
| `TreatmentStatus` | `CANCELED` | Cancelada | |

---

## 15. Termos reservados para MVPs futuros

Nomes indicados pelo cliente ou reservados nas decisões. Exceto `Pca` e `PcaItem` (DEC-029), são **propostas** até o registro em `decisions.md` no detalhamento do respectivo MVP.

| Termo (pt-BR) | Identificador técnico | Definição resumida | Base legal / observação |
|---|---|---|---|
| Plano de Contratações Anual / item do plano | `Pca` / `PcaItem` | Plano do exercício e seus itens (exercício, secretaria, objeto, categoria, valor previsto, mês previsto, responsável, status). | MVP 2; DEC-029. O nome `PcaStatus` já está em uso (situação do processo em relação ao PCA) |
| Dotação orçamentária | `BudgetAllocation` | Indicação de créditos orçamentários para o processo. | MVP 2; art. 150 |
| Análise jurídica / parecer | `LegalReview` | Análise com as situações aguardando, em análise, diligência, favorável, favorável com ressalvas e desfavorável. | MVP 2; art. 53; rota reservada `/legal-reviews` |
| Publicação / tentativa de publicação | `Publication` / `PublicationAttempt` | Ato publicado em um canal e cada tentativa de envio, com retentativas e idempotência. | MVP 3; rota reservada `/publications` |
| Provedor de publicação | `PublicationProvider`: `PNCPProvider`, `DiarioOficialProvider`, `PortalMunicipalProvider` | Interface de publicação e suas implementações por canal. | MVP 3. Nomes indicados pelo cliente |
| Integração / webhook | `Integration` / `Webhook` | Configuração de integração externa; assinatura de eventos por sistemas de terceiros. | MVP 3; rotas reservadas `/integrations`, `/webhooks` |
| Contrato | `Contract` | Contrato originado do processo (número, processo, fornecedor, objeto, valor, início, fim, fiscal, gestor, status: rascunho, vigente, suspenso, encerrado, rescindido). | MVP 4; rota reservada `/contracts` |
| Gestor do contrato / fiscal do contrato | `ContractManager` / `ContractInspector` | Designações de gestão e fiscalização, com substitutos. | MVP 4; art. 117 |
| Medição / ocorrência / alteração contratual | `ContractMeasurement` / `ContractOccurrence` / `ContractAmendment` | Medições e atesto; registros de fiscalização; aditivos e apostilamentos. | MVP 4; arts. 117, 124 a 136 |
| Análise de IA | `AiAnalysis` | Registro de cada análise ou sugestão gerada por IA. | MVP 5. Citada pelo cliente como "AIAnalysis"; normalizada conforme a DEC-001 (como `Pca` e `AiProvider`) |
| Resultado de validação | `ValidationResult` | Resultado de validação cruzada (ex.: "Quantidade divergente entre ETP e TR"). | MVP 5 |
| Módulos reservados | `pca`, `budget`, `legal-review`, `internal-control`, `tender`, `sla`, `analytics`, `rules`, `publication`, `signature`, `integration`, `public-api`, `webhook`, `contract`, `ai` | Fronteiras de domínio previstas. | DEC-040 |

---

## 16. Guia de linguagem

| Use | Evite | Motivo |
|---|---|---|
| Encaminhar | "Tramitar" como verbo de ação; "enviar" | Tramitação é o histórico (`ProcessMovement`); a ação é encaminhar (`FORWARD`) |
| Devolver | Reprovar, voltar | Ação `RETURN`, sempre com motivo |
| Indeferir | Rejeitar, reprovar, negar | Termo administrativo usual; corresponde a `REJECT` (a DEC-014 trata "rejeitar/indeferir" como sinônimos técnicos) |
| Assumir | Pegar, puxar | Ação `CLAIM` |
| Finalizar (documento) | Fechar, concluir o documento | `FINALIZED`; exceção: na pesquisa de preços o botão é "Concluir pesquisa" (DEC-018) |
| Concluir (processo) | Finalizar o processo, encerrar | `COMPLETE` → `COMPLETED` |
| Cancelar | Excluir, apagar | Nada de processo é excluído fisicamente (DEC-034); "descartar" só se aplica a rascunho sem número |
| Desconsiderar cotação | Excluir cotação, apagar | A cotação permanece registrada como `EXCLUDED`, com motivo |
| Valor atípico | Outlier | Linguagem simples (DEC-184) |
| Pesquisa de preços | "Cotação" para o conjunto | Cotação é o preço de um item em uma fonte |
| Mapa de riscos | Matriz de riscos (para o documento do planejamento) | Matriz de riscos é cláusula contratual (art. 22) |
| Garantia do objeto · garantia contratual | "Garantia" sem qualificação | São institutos diferentes |
| Prazo da etapa · prazo alvo | "Prazo" sem qualificação em telas que mostram os dois | DEC-031 |
| Situação | "Status" na interface | Linguagem simples; "status" permanece nos identificadores técnicos |
| Secretaria (ou o rótulo configurado) | Termo fixo para todos os tenants | `labels.secretariat` (DEC-011) |
| Autoridade competente · ordenador de despesa | Usá-los como sinônimos | Podem coincidir na mesma pessoa, mas são papéis distintos |
| Órgão/entidade (`Organization`); nome do tenant ou "ente" (`Tenant`) | "Tenant" em textos da interface | Ver a nota da §1; o rótulo do escopo `TENANT` segue a §14 |
| Processo | Expediente, pasta, protocolo | O processo é o agregado central (DEC-010) |
