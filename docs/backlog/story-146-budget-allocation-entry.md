---
id: US-146
title: "Indicar a dotação orçamentária do processo"
epic: EP-024
feature: FT-072
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-001, US-013, US-097, US-104]
modules: [budget, process, catalog, workflow, timeline, audit, platform]
screens: [SCR-006, SCR-013]
endpoints: [BUD-01, BUD-02, BUD-03, BUD-04, BUD-05, CAT-01, TSK-01]
permissions: [BUDGET_ALLOCATION_MANAGE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET, INBOX_VIEW]
events: [BudgetAllocationCreated, BudgetAllocationUpdated, BudgetAllocationCanceled]
---

# US-146 — Indicar a dotação orçamentária do processo

## Título
Indicar a dotação orçamentária do processo

## Descrição
**Como** servidor da Contabilidade (ou gestor de contratações) com a etapa `DOTACAO` sob minha custódia, **quero** indicar, editar e remover em rascunho as dotações orçamentárias do processo — exercício, unidade orçamentária, programa de trabalho/ação, natureza da despesa, fonte de recursos e valor reservado — escolhendo a classificação nos catálogos do órgão, **para** que a necessidade de recursos fique estruturada no processo (e não em texto livre) e pronta para a confirmação da reserva com evidência (US-147) e para a conferência com o valor estimado (US-148).

A story não tem tela própria (DEC-198, roadmap §4.2): o painel "Dotação orçamentária" vive no detalhe do processo (SCR-006), visível quando o processo está na etapa `DOTACAO` e, em leitura, nas etapas seguintes; a tarefa da etapa aparece na caixa de tarefas (SCR-013) com o resumo das dotações. A dotação nasce em `DRAFT`, é editável e removível enquanto rascunho, e pode haver mais de uma por processo (mais de uma fonte ou mais de um exercício). Nenhuma dotação indicada aqui conta para a cobertura do valor estimado: só `CONFIRMED` conta (US-148). Não há consulta a sistemas contábeis: os dados são digitados.

## Contexto
- A indicação de recursos orçamentários é exigência da fase preparatória (Lei 14.133/2021, art. 18, e art. 72, IV, na contratação direta; art. 150 veda contratar sem créditos orçamentários). Hoje os órgãos contornam a etapa com uma tarefa `TASK` genérica e um documento de texto livre (contorno do roadmap §3.2), sem classificação estruturada, sem catálogo e sem conferência com o valor estimado.
- DEC-198 cria `BudgetAllocation` por processo (1:N), com a classificação em catálogos novos de `CatalogItem` (`BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE`, `FUNDING_SOURCE`), semeados "a validar com o piloto" (entities MVP 2 §9: naturezas usuais de compras e fontes genéricas; unidades e ações vêm vazias e são cadastradas pelo órgão pela administração de catálogos, US-104). DEC-196 posiciona `DOTACAO` na versão 2 do workflow padrão, depois de `APROVACAO_AUTORIDADE` e antes de `MINUTA_EDITAL` (US-130).
- POL-25 (permissions MVP 2 §POL): registrar e editar exigem `BUDGET_ALLOCATION_MANAGE` + custódia da etapa `DOTACAO` (ou titular/substituto da unidade) + processo editável; o valor segue POL-09 na leitura e na escrita. `CONTABILIDADE` e `GESTOR_CONTRATACOES` têm `MANAGE`; só `CONTABILIDADE` tem `CONFIRM` (permissions MVP 2 §3). Participantes do processo nunca indicam dotação por força da participação (permissions MVP 2 §4).
- Sigilo do orçamento (DEC-030, US-013): com `Process.isBudgetConfidential = true`, o valor reservado é mascarado (`null` + `reservedAmountMasked: true`) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem é o responsável atual, em API, eventos, notificações, timeline, auditoria e logs.
- Esta story entrega a entidade, o módulo `budget`, os endpoints de indicação (BUD-01 a BUD-05) e o painel. A confirmação e o cancelamento de dotação confirmada são da US-147; o cálculo de cobertura, a regra de saída e o provedor `budget.*` do `RuleContext` v2 são da US-148.
- As situações "aguardando", "reservada", "insuficiente" e "dispensada" do card de origem **não** são enum novo: o status persistido é só `DRAFT`, `CONFIRMED` e `CANCELED` (entities MVP 2 §6.3); as demais são leituras derivadas, definidas na US-148.

## Objetivo
Garantir que 100% das dotações indicadas tenham classificação completa e coerente (quatro itens de catálogo ativos do próprio órgão, exercício válido, valor maior que zero), sejam gravadas só por quem tem permissão e custódia da etapa `DOTACAO`, nasçam em `DRAFT` com auditoria, evento e entrada de timeline, e jamais exponham o valor de processo sigiloso a quem não pode vê-lo; e que a Contabilidade encontre na caixa de tarefas, sem abrir processo a processo, quais tarefas de dotação têm rascunhos e confirmações.

## Persona
- **Principal:** Contabilidade (perfil `CONTABILIDADE`) — indica as dotações do processo na etapa `DOTACAO`.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, indica em rascunho quando tem a custódia da etapa); Planejamento (`PLANEJAMENTO`), Auditor (`AUDITOR`) e Controle Interno (`CONTROLE_INTERNO`), que consultam; Administrador do órgão (`ADMIN_ORGAO`) e gestor, que mantêm os catálogos orçamentários (`CATALOG_MANAGE`).

## Pré-condições
- Processo do tenant, visível ao usuário (DEC-024), em status `IN_PROGRESS` (editável) com `ProcessStage` `ACTIVE` cuja `WorkflowStage.key = 'DOTACAO'` (workflow padrão v2, US-130, ou versão própria do órgão que mantenha essa chave).
- Usuário com `BUDGET_ALLOCATION_MANAGE` cobrindo o processo, vínculo `ACTIVE` e custódia da etapa `DOTACAO` (responsável atual ou, sem responsável, lotado na unidade da etapa; ou titular/substituto da unidade — POL-25).
- Catálogos `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE` e `FUNDING_SOURCE` com ao menos um item ativo cada (US-104; semeadura "a validar com o piloto").

## Fluxo principal
1. A Contabilidade abre a tarefa da etapa `DOTACAO` na caixa de tarefas (SCR-013), onde a linha mostra "Dotação: {n} rascunho(s) · {m} confirmada(s)" (TSK-01 com o bloco `budget`), e entra no detalhe do processo (SCR-006).
2. O painel "Dotação orçamentária" carrega as dotações (BUD-01) e mostra, para cada uma, a classificação, o exercício, o valor (ou o selo "Valor sigiloso") e a situação (`Rascunho`, `Confirmada`, `Cancelada`), mais as ações permitidas (`meta.allowedActions`). Sem dotações: estado vazio "Nenhuma dotação indicada" com o botão **"Indicar dotação"**.
3. Ao acionar **"Indicar dotação"**, o front carrega os quatro catálogos (CAT-01 por tipo, só ativos) e abre o formulário com o exercício preenchido com o ano corrente.
4. O usuário escolhe a unidade orçamentária; a lista de programas de trabalho/ação é filtrada pelas ações vinculadas àquela unidade (`metadata.budgetUnitCode` da ação = `metadata.officialCode` da unidade) mais as ações sem vínculo; escolhe natureza da despesa e fonte de recursos, informa o valor reservado (máscara de moeda `R$`) e, opcionalmente, observações.
5. O front valida localmente (campos obrigatórios, valor > 0, duas casas decimais) e envia `POST /processes/{id}/budget-allocations` (BUD-02) com `Idempotency-Key`.
6. A API, em uma transação: autoriza (`MANAGE` + POL-25 + status do processo), resolve a `ProcessStage` ativa de `DOTACAO`, valida schema, catálogos, exercício, valor, unicidade da classificação e limite por processo; grava `BudgetAllocation` em `DRAFT` com `processStageId`, `version = 1`; grava auditoria `budget_allocation.create`; publica `BudgetAllocationCreated` no outbox (a projeção da timeline `BUDGET_ALLOCATION_ADDED` roda na mesma transação) e responde **201** com a dotação, `ETag` e `Location`.
7. O painel exibe a dotação como `Rascunho`, com avisos não bloqueantes quando houver (`meta.warnings[]`, ex.: exercício diferente do ano do PCA do processo) e o aviso informativo "Só dotações confirmadas contam para a cobertura do valor estimado".
8. Para ajustar, o usuário aciona **"Editar"** (BUD-04 com `If-Match`): só os campos enviados mudam; a API devolve a dotação com `version + 1` e publica `BudgetAllocationUpdated` com `changedFields[]`.
9. Para descartar, aciona **"Remover rascunho"**, informa o motivo (10 a 1.000 caracteres) e a API (BUD-05, `If-Match`) faz a exclusão lógica: o rascunho passa a `CANCELED`, sai da lista padrão e o evento `BudgetAllocationCanceled` sai com `fromStatus = DRAFT`.
10. Quando as dotações estiverem prontas para a confirmação, o fluxo segue na US-147; o encaminhamento só é liberado conforme a regra de saída da US-148.

## Fluxos alternativos
- **FA-01 — Mais de uma dotação:** o processo pode ter várias (outra fonte, outro exercício, outra natureza); cada uma é uma linha própria do painel. O limite é de 20 dotações não canceladas por processo.
- **FA-02 — Gestor indica:** o gestor de contratações (`MANAGE`) só indica se tiver a custódia da etapa; sem ela, vê o painel em leitura com o motivo "Assuma a etapa de dotação para indicar" e pode assumir (PRC-21) ou atribuir (PRC-22, POL-04/POL-05) a etapa a si.
- **FA-03 — Catálogo sem itens:** se algum dos quatro catálogos não tem item ativo, o formulário mostra "Não há {unidade orçamentária} cadastrada. Peça ao administrador do órgão para cadastrá-la em Catálogos" e o botão de salvar fica desabilitado.
- **FA-04 — Item de catálogo inativado depois do rascunho:** o rascunho mantém a referência (registros existentes mantêm o vínculo — entities MVP 1 `CatalogItem.isActive`); ao editar, o item inativo aparece rotulado "(inativo)" e só pode ser mantido se o campo não for alterado; trocar para outro item exige item ativo.
- **FA-05 — Processo sigiloso e usuário sem permissão de sigilo:** o usuário vê a classificação e a situação, mas não o valor (`null` + `reservedAmountMasked: true`); indicar ou alterar o valor exige poder vê-lo (`PERMISSION_DENIED`, `meta.reason = CONFIDENTIAL_BUDGET`); alterar só observações ou classificação é permitido.
- **FA-06 — Exercício diferente do ano do PCA:** quando `Process.pcaYear` está preenchido e difere do exercício informado, a dotação é aceita com o aviso `PCA_YEAR_MISMATCH` (não bloqueia; o órgão pode dotar outro exercício, ex.: contratação plurianual).
- **FA-07 — Etapa `DOTACAO` já concluída ou ausente no workflow:** fora da etapa não se indica nem se edita (RN-BUD-11); o painel fica somente leitura e a tentativa pela API responde `INVALID_STATE` (`meta.reason = NO_ACTIVE_BUDGET_STAGE`). Processos da v1 do workflow, sem a etapa, não têm o painel de indicação.
- **FA-08 — Retorno do processo à `DOTACAO` (devolução, DEC-196):** as dotações existentes (`DRAFT` e `CONFIRMED`) permanecem; novas dotações gravam o `processStageId` da nova passagem; as `CONFIRMED` continuam imutáveis (US-147).
- **FA-09 — Reenvio da criação:** repetir `POST` com a mesma `Idempotency-Key` e corpo igual devolve a mesma resposta com `Idempotent-Replayed: true`; sem a chave, a segunda tentativa idêntica é recusada pela unicidade da classificação (`BUDGET_ALLOCATION_DUPLICATED`).

## Regras de negócio
- **RN-BUD-11** — Indicar, editar e remover rascunho só ocorrem com o processo em `IN_PROGRESS` e com `ProcessStage` `ACTIVE` de `WorkflowStage.key = 'DOTACAO'`; sem a etapa ativa → `INVALID_STATE` (409, `meta.reason = NO_ACTIVE_BUDGET_STAGE`); processo em outro status (`SUSPENDED`, `AWAITING_APPROVAL`, `CANCELED`, `COMPLETED`…) → `INVALID_PROCESS_STATUS` (409). Detalha RN-BUD-05 da feature.
- **RN-BUD-12** — Quem indica: `BUDGET_ALLOCATION_MANAGE` cobrindo o processo + custódia da etapa `DOTACAO` (POL-25: responsável atual, lotado na unidade da etapa sem responsável, ou titular/substituto da unidade); sem custódia → `NOT_PROCESS_CUSTODIAN` (403). Participante do processo (`COLLABORATOR`, `CONSULTANT`, `OBSERVER`) nunca indica por força da participação; `AUDITOR`, `CONTROLE_INTERNO` e `PLANEJAMENTO` só leem. O ator é sempre `USER`: nenhuma regra, job ou integração cria dotação (RN-BUD-10 da feature).
- **RN-BUD-13** — Campos obrigatórios (RN-BUD-01 da feature): `fiscalYear`, `budgetUnitId`, `budgetActionId`, `expenseNatureId`, `fundingSourceId` e `reservedAmount`. `notes` é opcional (até 2.000 caracteres). `reservationNumber`, `reservationDate` e `evidenceAttachmentId` não são aceitos em BUD-02/BUD-04 (pertencem à confirmação, US-147): se enviados → `VALIDATION_ERROR` (`UNKNOWN_FIELD`).
- **RN-BUD-14** — A classificação vem exclusivamente dos catálogos: cada id deve ser de `CatalogItem` do **mesmo tenant**, do `catalogType` correto e `isActive` em seleções novas. Inexistente, de outro tenant ou de outro tipo → `VALIDATION_ERROR` com `errors[].code = REFERENCE_NOT_FOUND` no campo; inativo → `REFERENCE_INACTIVE` (api.md MVP 1 §1.5) — a resposta é idêntica para "não existe" e "é de outro tenant", sem revelar existência.
- **RN-BUD-15** — Coerência ação × unidade: se o item `BUDGET_ACTION` traz `metadata.budgetUnitCode` e ele difere do `metadata.officialCode` do item `BUDGET_UNIT` escolhido, a API recusa com `VALIDATION_ERROR` (`errors[].code = CLASSIFICATION_MISMATCH` no campo `budgetActionId`). Ação sem `budgetUnitCode` vale para qualquer unidade.
- **RN-BUD-16** — Exercício (`fiscalYear`): inteiro; padrão = ano corrente no fuso do tenant; aceito de `ano corrente` até `ano corrente + 5`; menor que o ano corrente → `VALIDATION_ERROR` (`FISCAL_YEAR_OUT_OF_RANGE`). Na edição, a faixa só é verificada se o exercício mudar (um rascunho antigo continua editável em outros campos). Se `Process.pcaYear` existe e é diferente, a resposta traz `meta.warnings[] = [{ code: 'PCA_YEAR_MISMATCH', pcaYear }]`, sem bloquear.
- **RN-BUD-17** — Valor reservado (`reservedAmount`): decimal em **string** (DEC-003), 1 a 16 dígitos inteiros e no máximo 2 decimais (`numeric(18,2)`), estritamente maior que zero; mais de duas casas → `VALIDATION_ERROR` (sem arredondar). Não há teto relativo ao valor estimado: um valor acima do estimado é aceito, com o aviso informativo na UI "Valor acima do valor estimado do processo".
- **RN-BUD-18** — Unicidade da classificação: não pode haver duas dotações **não canceladas** do mesmo processo com o mesmo (`fiscalYear`, `budgetUnitId`, `budgetActionId`, `expenseNatureId`, `fundingSourceId`) → `BUDGET_ALLOCATION_DUPLICATED` (409). Para complementar uma reserva na mesma classificação, edita-se o valor da existente (rascunho) ou indica-se outra fonte/exercício. Garantida por índice único parcial.
- **RN-BUD-19** — Limite: no máximo 20 dotações não canceladas por processo; a 21ª → `BUSINESS_RULE_VIOLATION` (`violations[].code = ALLOCATIONS_LIMIT`).
- **RN-BUD-20** — Estado inicial: `status = DRAFT`, `version = 1`, `processStageId` = `ProcessStage` ativa de `DOTACAO` no momento da criação; `reservationNumber`, `reservationDate`, `evidenceAttachmentId`, `confirmedAt/By` e `canceledAt/By` nulos. `processId` e `processStageId` são imutáveis (trigger).
- **RN-BUD-21** — Edição: somente em `DRAFT` (RN-BUD-02 da feature); qualquer outra situação → `BUDGET_ALLOCATION_NOT_EDITABLE` (409, `meta.status`). `PATCH` parcial com `If-Match` obrigatório (428/412). `changedFields[]` lista só campos cujo valor de fato mudou; corpo sem mudança efetiva responde 200 sem nova versão, sem auditoria e sem evento.
- **RN-BUD-22** — Remoção de rascunho (`DELETE`, `If-Match`): exige `reason` de 10 a 1.000 caracteres; `DRAFT → CANCELED` por exclusão lógica (a linha é preservada, DEC-034), com `canceledAt`, `canceledById` e `cancellationReason`; sai das listas padrão (`status` padrão = `DRAFT,CONFIRMED`; `CANCELED` só com filtro explícito). Remover dotação `CONFIRMED` não é aceito aqui (`BUDGET_ALLOCATION_NOT_EDITABLE`; o cancelamento é da US-147). Publica `BudgetAllocationCanceled` com `fromStatus = DRAFT`.
- **RN-BUD-23** — Sigilo (RN-BUD-09 da feature, DEC-030, POL-09): com `isBudgetConfidential = true`, a serialização central mascara `reservedAmount` (`null` + `reservedAmountMasked: true`) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo e não é o `currentResponsibleId`; o campo nunca é omitido. Escrever `reservedAmount` sem poder vê-lo → `PERMISSION_DENIED` (`meta.reason = CONFIDENTIAL_BUDGET`). Eventos, notificações, rótulos de timeline, logs e `metadata` de auditoria **nunca** levam valores; na auditoria de processo sigiloso, `changes.reservedAmount` registra `{ masked: true }`.
- **RN-BUD-24** — Leitura: BUD-01/BUD-03 exigem `PROCESS_VIEW` e visibilidade do processo (DEC-024; invisível ou de outro tenant → 404). A lista é ordenada por `fiscalYear`, `createdAt`; devolve `meta.summary { allocationsCount, draftCount, confirmedCount, canceledCount }` e `meta.allowedActions` por dotação. A cobertura do valor estimado **não** é calculada aqui (US-148 acrescenta `meta.coverage`, de forma aditiva, DEC-108).
- **RN-BUD-25** — Caixa de tarefas: o item de TSK-01 cuja etapa atual é `DOTACAO` ganha, de forma aditiva, `budget { allocationsCount, draftCount, confirmedCount }`, calculado em uma única consulta agrupada por página (sem N+1) e sem valores monetários.
- **RN-BUD-26** — Catálogos: a seleção usa CAT-01 (capacidade implícita do vínculo ativo) por `catalogType`, só itens ativos, ordenados por `sortOrder`; a administração (CAT-02 a CAT-06, `CATALOG_MANAGE`, US-104) valida `metadata.officialCode` por tipo (entities MVP 2 §7.10) e preserva o `code` imutável. Itens inativos continuam exibidos nas dotações existentes.
- **RN-BUD-27** — Timeline e notificação: criar gera `BUDGET_ALLOCATION_ADDED` ("{ator} indicou dotação ({natureza} · fonte {fonte})", rótulos congelados no fato, visibilidade `STANDARD` — sem valor); remover rascunho gera `BUDGET_ALLOCATION_CANCELED` na variante "cancelou a dotação (rascunho)"; editar não gera timeline (apenas auditoria). Nenhum dos três eventos desta story notifica ninguém (events MVP 2 §6).
- **RN-BUD-28** — Atomicidade e idempotência: dotação, auditoria, evento (outbox) e projeção de timeline são gravados na mesma transação com `app.tenant_id`; qualquer falha desfaz tudo. Criação aceita `Idempotency-Key` (24 h, escopo tenant + usuário + método + rota); `PATCH` e `DELETE` usam `If-Match`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Exercício | `fiscalYear` | inteiro (ano) | Sim | RN-BUD-16: ano corrente a +5 | ano corrente (fuso do tenant) |
| Unidade orçamentária | `budgetUnitId` | seleção (`BUDGET_UNIT`) | Sim | RN-BUD-14; item ativo do tenant | catálogo |
| Programa de trabalho/ação | `budgetActionId` | seleção (`BUDGET_ACTION`) | Sim | RN-BUD-14/15; filtrada pela unidade | catálogo |
| Natureza da despesa | `expenseNatureId` | seleção (`EXPENSE_NATURE`) | Sim | RN-BUD-14; exibe `metadata.officialCode` (ex.: 3.3.90.30) | catálogo semeado |
| Fonte de recursos | `fundingSourceId` | seleção (`FUNDING_SOURCE`) | Sim | RN-BUD-14 | catálogo |
| Valor reservado | `reservedAmount` | decimal string `numeric(18,2)` | Sim | RN-BUD-17; > 0; mascarado (RN-BUD-23) | — |
| Observações | `notes` | texto | Não | até 2.000 caracteres; sem HTML | — |
| Motivo da remoção | `reason` | texto (corpo do `DELETE`) | Sim (ao remover) | 10 a 1.000 caracteres | — |
| *(sistema)* Situação | `status` | `BudgetAllocationStatus` | — | `DRAFT` na criação | `DRAFT` |
| *(sistema)* Passagem da etapa | `processStageId` | uuid | — | RN-BUD-20; imutável | etapa `DOTACAO` ativa |
| *(sistema)* Versão | `version` | inteiro | — | `ETag`/`If-Match` (DEC-104) | 1 |
| *(sistema)* Aviso | `meta.warnings[]` | lista | — | `PCA_YEAR_MISMATCH` (RN-BUD-16) | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campo obrigatório ausente (exercício, quatro classificações, valor) | Front + API (Zod) | "Preencha {campo}." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | Valor menor ou igual a zero, com mais de 2 casas ou fora do formato | Front + API (Zod) | "Informe um valor maior que zero, com até duas casas decimais." | `VALIDATION_ERROR` (`INVALID_AMOUNT`) |
| V-03 | Exercício fora da faixa (menor que o ano corrente ou acima de +5) | Front + API | "Informe um exercício entre {ano corrente} e {ano corrente + 5}." | `VALIDATION_ERROR` (`FISCAL_YEAR_OUT_OF_RANGE`) |
| V-04 | Item de catálogo inexistente, de outro tipo ou de outro órgão | API | "Selecione uma opção válida em {campo}." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Item de catálogo inativo | API | "{rótulo} está inativo. Escolha outra opção ou peça ao administrador para reativá-lo." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-06 | Programa/ação vinculado a outra unidade orçamentária | Front + API | "Este programa de trabalho pertence a outra unidade orçamentária." | `VALIDATION_ERROR` (`CLASSIFICATION_MISMATCH`) |
| V-07 | Campo da confirmação enviado na indicação (número, data, evidência) | API | "Número, data e evidência da reserva são informados na confirmação." | `VALIDATION_ERROR` (`UNKNOWN_FIELD`) |
| V-08 | Observações acima de 2.000 caracteres | Front + API | "As observações aceitam até 2.000 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-09 | Classificação idêntica a outra dotação não cancelada do processo | API | "Já existe uma dotação com esta classificação neste processo. Edite a existente ou escolha outra fonte ou exercício." | `BUDGET_ALLOCATION_DUPLICATED` |
| V-10 | Mais de 20 dotações não canceladas | API | "O processo já tem 20 dotações. Remova um rascunho antes de indicar outra." | `BUSINESS_RULE_VIOLATION` (`ALLOCATIONS_LIMIT`) |
| V-11 | Motivo da remoção ausente ou fora de 10 a 1.000 caracteres | Front + API | "Informe o motivo da remoção (10 a 1.000 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`) |
| V-12 | Dotação não está em rascunho (edição ou remoção) | API | "Dotações confirmadas não podem ser editadas. Para desfazer, cancele a dotação com um motivo." | `BUDGET_ALLOCATION_NOT_EDITABLE` |
| V-13 | Processo sem etapa `DOTACAO` ativa | API | "Este processo não está na etapa de dotação orçamentária." | `INVALID_STATE` (`NO_ACTIVE_BUDGET_STAGE`) |
| V-14 | Processo em status que não permite alteração | API | "O processo está {status} e não aceita alterações na dotação." | `INVALID_PROCESS_STATUS` |
| V-15 | Valor enviado por quem não pode ver o orçamento sigiloso | API | "O orçamento deste processo é sigiloso. Você não pode informar ou alterar o valor." | `PERMISSION_DENIED` (`CONFIDENTIAL_BUDGET`) |

## Permissões
- **Permissão:** `BUDGET_ALLOCATION_MANAGE` (risco `M`) com escopo que cubra a unidade/órgão do processo, para indicar, editar e remover rascunho. Leitura: `PROCESS_VIEW` (+ POL-09 para o valor). Caixa de tarefas: `INBOX_VIEW`. Perfis padrão com `MANAGE`: `CONTABILIDADE` e `GESTOR_CONTRATACOES`.
- **Políticas:** POL-25 (permissão + custódia da etapa `DOTACAO`, ou titular/substituto da unidade, + processo editável); POL-09 (valor, leitura e escrita); DEC-024 (visibilidade); POL-01 não se aplica diretamente (a custódia é a da etapa `DOTACAO`, como em POL-25).
- **MFA:** não exigido (`BUDGET_ALLOCATION_MANAGE` tem risco `M`; a confirmação, `H`, é da US-147).
- **Sem permissão:** a UI oculta "Indicar dotação", "Editar" e "Remover" (leitura permanece para quem tem `PROCESS_VIEW`) e mostra o motivo quando a ação existe mas está indisponível (sem custódia, processo fora da etapa, status). Na API: 403 `PERMISSION_DENIED` (sem a permissão) ou `NOT_PROCESS_CUSTODIAN` (sem custódia), com auditoria `access.denied`; processo invisível ou de outro tenant → 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `BudgetAllocationCreated` | `budget_allocation.created` | Commit de BUD-02 | `budgetAllocationId`, `fiscalYear`, `expenseNatureCode`, `fundingSourceCode`; **sem valor**; consumidores `T R` |
| `BudgetAllocationUpdated` | `budget_allocation.updated` | Commit de BUD-04 com alteração efetiva | `budgetAllocationId`, `changedFields[]` (nomes de campo, sem valores); sem consumidor |
| `BudgetAllocationCanceled` | `budget_allocation.canceled` | Commit de BUD-05 (remoção de rascunho) | `budgetAllocationId`, `fromStatus = DRAFT`, `hasReason: true`, `coverageReached` (sempre `false` aqui: rascunho não conta); consumidores `T N R NR`, sem notificação para rascunho |

O cancelamento de dotação `CONFIRMED` e a confirmação são eventos da US-147.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | Indicar, editar e remover rascunho não notificam (events MVP 2 §6: `BUDGET_ALLOCATION_CONFIRMED` e `_CANCELED` — esta última só `de CONFIRMED` — são da US-147). O responsável vê o resumo na caixa de tarefas e a entrada na timeline. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Indicar a dotação orçamentária do processo

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0045/2026" está "IN_PROGRESS" na etapa "DOTACAO" com valor estimado de 100.000,00
    And "Marcos", da Contabilidade, tem "BUDGET_ALLOCATION_MANAGE" e é o responsável pela etapa "DOTACAO"
    And os catálogos orçamentários do tenant têm itens ativos, entre eles a unidade "UO 02.01", o programa "PT 04.122.0001", a natureza "3.3.90.30" e as fontes "FONTE 1500" e "FONTE 1600"

  Scenario: [Sucesso] Indicar duas dotações em fontes distintas
    When "Marcos" indicar uma dotação de 60.000,00 na "FONTE 1500" e outra de 40.000,00 na "FONTE 1600", exercício 2026
    Then a API deve responder 201 duas vezes, com "status" "DRAFT" e "version" 1
    And cada dotação deve guardar o "processStageId" da passagem atual por "DOTACAO"
    And deve gerar registro de auditoria "budget_allocation.create" para cada uma
    And deve gerar o evento "BudgetAllocationCreated" sem o campo de valor
    And a timeline deve registrar "Marcos indicou dotação (3.3.90.30 · fonte 1500)" com visibilidade "STANDARD"
    And a caixa de tarefas deve mostrar "2 rascunhos · 0 confirmadas" na tarefa do processo

  Scenario: [Sucesso] Editar e remover rascunho
    Given que existe a dotação "DRAFT" de 60.000,00 com "version" 1
    When "Marcos" alterar o valor para 65.000,00 enviando "If-Match" "1"
    Then a dotação deve ter "reservedAmount" "65000.00" e "version" 2
    And deve gerar o evento "BudgetAllocationUpdated" com "changedFields" ["reservedAmount"] e nenhum valor
    When "Marcos" remover o rascunho informando o motivo "Fonte indicada por engano na reunião"
    Then a dotação deve ficar "CANCELED" com o motivo gravado e sair da lista padrão
    And deve gerar o evento "BudgetAllocationCanceled" com "fromStatus" "DRAFT"

  Scenario: [Sucesso] Orçamento sigiloso mascara o valor para quem não pode vê-lo
    Given que o processo tem "isBudgetConfidential" verdadeiro e "Paulo" não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Paulo" listar as dotações do processo
    Then cada dotação deve vir com "reservedAmount" nulo e "reservedAmountMasked" verdadeiro
    And a classificação e a situação devem aparecer normalmente
    And nenhum evento, notificação ou registro de log deve conter o valor reservado

  Scenario: [Sucesso] Exercício diferente do PCA gera aviso, não bloqueio
    Given que o processo está vinculado ao PCA do exercício 2026
    When "Marcos" indicar uma dotação do exercício 2027
    Then a API deve responder 201 com "meta.warnings" contendo "PCA_YEAR_MISMATCH"

  Scenario: [Validação] Valor, exercício e classificação inválidos
    When "Marcos" indicar uma dotação com valor "0.00"
    Then a API deve responder 422 com "VALIDATION_ERROR" e o código "INVALID_AMOUNT" no campo "reservedAmount"
    When "Marcos" indicar uma dotação com exercício 2024
    Then a API deve responder 422 com o código "FISCAL_YEAR_OUT_OF_RANGE" no campo "fiscalYear"
    When "Marcos" escolher um programa vinculado à unidade "UO 03.05" para a unidade "UO 02.01"
    Then a API deve responder 422 com o código "CLASSIFICATION_MISMATCH" no campo "budgetActionId"
    When "Marcos" escolher uma fonte de recursos inativa
    Then a API deve responder 422 com o código "REFERENCE_INACTIVE" no campo "fundingSourceId"
    And nenhuma dotação deve ser gravada em nenhum dos casos

  Scenario: [Validação] Campos da confirmação não entram na indicação
    When "Marcos" enviar "reservationNumber" na criação da dotação
    Then a API deve responder 422 com o código "UNKNOWN_FIELD"

  Scenario: [Permissão] Usuário sem a permissão, sem custódia ou fora da etapa
    Given que "Bruno" não possui "BUDGET_ALLOCATION_MANAGE"
    When "Bruno" tentar indicar uma dotação
    Then a API deve responder 403 com "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Clara", gestora com "BUDGET_ALLOCATION_MANAGE", não é responsável pela etapa "DOTACAO"
    When "Clara" tentar indicar uma dotação
    Then a API deve responder 403 com "NOT_PROCESS_CUSTODIAN"
    Given que o processo já está na etapa "JURIDICO"
    When "Marcos" tentar indicar uma dotação
    Then a API deve responder 409 com "INVALID_STATE" e "meta.reason" "NO_ACTIVE_BUDGET_STAGE"
    And a UI não deve exibir o botão "Indicar dotação"

  Scenario: [Permissão] Quem não vê o orçamento sigiloso não informa o valor
    Given que o processo é sigiloso e "Paulo" tem "BUDGET_ALLOCATION_MANAGE" sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Paulo" enviar "reservedAmount" ao indicar ou editar uma dotação
    Then a API deve responder 403 com "PERMISSION_DENIED" e "meta.reason" "CONFIDENTIAL_BUDGET"

  Scenario: [Tenant incorreto] Processo, dotação e catálogo de outro tenant
    Given que existe o processo "0031/2026" no tenant "Prefeitura B"
    When "Marcos", no tenant "Prefeitura A", listar ou indicar dotação nesse processo
    Then a API deve responder 404 com "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado
    When "Marcos" indicar uma dotação com "budgetUnitId" de um item do tenant "Prefeitura B"
    Then a API deve responder 422 com "REFERENCE_NOT_FOUND" no campo "budgetUnitId", idêntico ao de um id inexistente
    When "Marcos" consultar uma dotação do processo "0045/2026" pelo caminho de outro processo
    Then a API deve responder 404 com "NOT_FOUND"

  Scenario: [Duplicidade] Mesma classificação duas vezes e reenvio idempotente
    Given que existe uma dotação "DRAFT" no exercício 2026, "UO 02.01", "PT 04.122.0001", "3.3.90.30" e "FONTE 1500"
    When "Marcos" indicar outra dotação com a mesma classificação
    Then a API deve responder 409 com "BUDGET_ALLOCATION_DUPLICATED"
    Given que "Marcos" indicou uma dotação com "Idempotency-Key" "k-146"
    When a mesma requisição for reenviada com o mesmo corpo
    Then a API deve responder com o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir uma única dotação, uma única auditoria "budget_allocation.create" e um único evento "BudgetAllocationCreated"

  Scenario: [Concorrência] Duas edições com a mesma versão
    Given que "Marcos" e "Carla", da Contabilidade, abriram a dotação "DRAFT" com "version" 1
    When os dois enviarem "PATCH" com "If-Match" "1" ao mesmo tempo
    Then uma requisição deve responder 200 com "version" 2
    And a outra deve responder 412 com "VERSION_CONFLICT" e "currentVersion" 2
    And a edição vencedora não deve ser sobrescrita

  Scenario: [Concorrência] Remoção e edição simultâneas do mesmo rascunho
    When "Marcos" remover o rascunho e "Carla" editá-lo ao mesmo tempo com a mesma versão
    Then somente uma operação deve ser aceita e a outra deve responder 412 ou 409 "BUDGET_ALLOCATION_NOT_EDITABLE"

  Scenario: [Falha de banco] Banco falha ao gravar a dotação
    Given que o banco de dados falha ao inserir a dotação
    When "Marcos" indicar uma dotação
    Then a API deve responder 503 com "DEPENDENCY_UNAVAILABLE"
    And nenhuma dotação, auditoria, entrada de timeline ou evento de outbox deve ser gravado
    And o formulário deve manter os dados digitados com o botão "Tentar novamente"

  Scenario: [Falha de integração] Fila e relay do outbox indisponíveis
    Given que o Redis das filas está indisponível
    When "Marcos" indicar uma dotação
    Then a API deve responder 201 com a dotação gravada
    And o evento "BudgetAllocationCreated" deve ficar "PENDING" no outbox até o relay voltar
    And a entrada de timeline deve existir, pois é projetada na mesma transação
    And depois que o relay voltar, o evento deve ser publicado uma única vez
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo obrigatório, valor, exercício ou observações inválidos | 422 | `VALIDATION_ERROR` | "Corrija os campos destacados." | Erro por campo com foco no primeiro |
| Item de catálogo inexistente ou de outro órgão | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione uma opção válida em {campo}." | Recarrega o catálogo do campo |
| Item de catálogo inativo | 422 | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) | "{rótulo} está inativo. Escolha outra opção." | Marca o campo e mantém o formulário |
| Programa/ação de outra unidade | 422 | `VALIDATION_ERROR` (`CLASSIFICATION_MISMATCH`) | "Este programa de trabalho pertence a outra unidade orçamentária." | Filtra a lista de programas pela unidade |
| Classificação duplicada no processo | 409 | `BUDGET_ALLOCATION_DUPLICATED` | "Já existe uma dotação com esta classificação neste processo. Edite a existente ou escolha outra fonte ou exercício." | Oferece "Editar a existente" |
| Limite de 20 dotações | 422 | `BUSINESS_RULE_VIOLATION` | "O processo já tem 20 dotações. Remova um rascunho antes de indicar outra." | Desabilita "Indicar dotação" |
| Dotação não está em rascunho | 409 | `BUDGET_ALLOCATION_NOT_EDITABLE` | "Dotações confirmadas não podem ser editadas. Para desfazer, cancele a dotação com um motivo." | Recarrega a dotação; oculta Editar/Remover |
| Processo fora da etapa `DOTACAO` | 409 | `INVALID_STATE` | "Este processo não está na etapa de dotação orçamentária." | Painel em leitura |
| Processo em status que não permite alteração | 409 | `INVALID_PROCESS_STATUS` | "O processo está {status} e não aceita alterações na dotação." | Painel em leitura com o motivo |
| Sem custódia da etapa | 403 | `NOT_PROCESS_CUSTODIAN` | "Assuma a etapa de dotação para indicar ou editar." | Mostra "Assumir etapa" quando permitido |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para indicar dotação neste processo." | Oculta as ações de escrita |
| Valor sigiloso sem permissão para vê-lo | 403 | `PERMISSION_DENIED` (`CONFIDENTIAL_BUDGET`) | "O orçamento deste processo é sigiloso. Você não pode informar ou alterar o valor." | Campo de valor desabilitado |
| Processo ou dotação de outro tenant/invisível | 404 | `NOT_FOUND` | "Processo não encontrado." | Volta à lista de processos |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a dotação e tente de novo." | Recarrega |
| Dotação alterada por outra pessoa | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou esta dotação. Recarregue e tente de novo." | Recarrega e mantém o que foi digitado |
| Chave de idempotência reutilizada com outro corpo | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega a lista |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Botão "Tentar novamente"; mantém o formulário |

## Dependências
- **Stories:** US-001 (processo e `Process.estimatedValue`/`pcaYear`), US-013 (sigilo do orçamento e máscara central), US-097 (autorização na API e no front), US-104 (catálogos e suas telas). Indiretas: US-056 (caixa de tarefas, TSK-01), US-130 (etapa `DOTACAO` na v2), US-129 (`RuleContext` v2). Habilita US-147 e US-148.
- **Decisões/ADRs:** DEC-198, DEC-196, DEC-030, DEC-024, DEC-034, DEC-055, DEC-003, DEC-104, DEC-105, DEC-108, DEC-161; ADR-008.
- **Configurações:** nenhuma nova nesta story (a severidade da cobertura, `budget.coverageRuleSeverity`, é da US-148). Usa o fuso e o calendário do tenant para o "ano corrente".
- **Lacunas nas fontes canônicas:**
  1. **IDs de endpoint** `BUD-01` a `BUD-05` (faixa BUD-01..BUD-09 desta story) e rotas aninhadas no processo (`/processes/{id}/budget-allocations/...`): a feature e a DEC-198 listam rotas indicativas planas (`PATCH /budget-allocations/{allocationId}`); adotou-se o aninhamento para que a autorização, a visibilidade (DEC-024) e o tenant sejam resolvidos pelo processo. Consolidar no `api.md` do MVP 2.
  2. **Códigos de erro novos:** `BUDGET_ALLOCATION_DUPLICATED` (409, RN-BUD-18). Códigos de campo novos em `VALIDATION_ERROR`: `FISCAL_YEAR_OUT_OF_RANGE`, `CLASSIFICATION_MISMATCH`, `INVALID_AMOUNT`, `UNKNOWN_FIELD`; subcódigos `NO_ACTIVE_BUDGET_STAGE` (`INVALID_STATE`), `CONFIDENTIAL_BUDGET` (`PERMISSION_DENIED`) e `ALLOCATIONS_LIMIT` (`BUSINESS_RULE_VIOLATION`). `BUDGET_ALLOCATION_NOT_EDITABLE` (409) já existe em POL-25.
  3. **Índice único parcial** em `budget_allocations`: `(tenant_id, process_id, fiscal_year, budget_unit_id, budget_action_id, expense_nature_id, funding_source_id) WHERE status <> 'CANCELED'` (RN-BUD-18); e o limite de 20 dotações por processo. Hoje a entidade só prevê índices por processo/status e por exercício/unidade.
  4. **Remoção de rascunho:** a entidade não tem `deletedAt` (BudgetAllocation é "Padrão", sem +SD); a "exclusão lógica" da feature foi mapeada para `DRAFT → CANCELED` com `cancellationReason` (§6.3 permite), por `DELETE` com corpo `{ reason }` (precedente: ATT-06). A feature fala em motivo ≥ 10 caracteres só no cancelamento; aplicou-se o mesmo mínimo à remoção.
  5. **Aviso `meta.warnings[]`** (`PCA_YEAR_MISMATCH`) e bloco aditivo `budget` em TSK-01 (RN-BUD-25): campos novos de resposta (aditivos, DEC-108).
  6. **Identificação da etapa por chave:** a custódia e a indicação dependem de `WorkflowStage.key = 'DOTACAO'` (DEC-196). Workflows próprios do órgão que renomeiem a chave não habilitam o painel; sugerir à validação de publicação (WF-20) um aviso quando uma etapa de dotação customizada não usar a chave.
  7. **Metadados dos catálogos novos:** CAT-02/CAT-03 (US-104) precisam validar `metadata` por tipo (entities MVP 2 §7.10: `officialCode` obrigatório; `budgetUnitCode` opcional na ação) e a coerência ação × unidade usa `officialCode`/`budgetUnitCode`. Não há `CATALOG_MANAGE` para `CONTABILIDADE` por padrão (só `ADMIN_ORGAO` e `GESTOR_CONTRATACOES`) — dúvida de produto.
  8. **Escrita sob sigilo:** POL-25 diz que o valor segue POL-09 "na leitura e na escrita"; o card define que quem não pode ver o valor não o informa (403 `CONFIDENTIAL_BUDGET`), com a mesma exceção do responsável atual da US-013.

## Impacto técnico
- **Módulo novo `budget`** (nível e dependências conforme `module-levels`/DEC-040): dono de `BudgetAllocation`; depende de `process` (consulta de etapa, status, custódia, `isBudgetConfidential`) por fachada, de `catalog` (validação dos itens) e de `workflow` apenas para identificar a etapa; `workflow` não importa `budget` (a regra de saída entra na US-148 pela porta `RuleContextContributor`, regra D9).
- **Sigilo por serialização central:** o `BudgetAllocationSerializer` usa a mesma política de POL-09 do processo (não há máscara por tela); testes de contrato garantem que `reservedAmount` e `reservedAmountMasked` estejam sempre presentes (contrato estável, api.md §1.4).
- **Performance:** BUD-01 lê por `(tenant_id, process_id, status)` (índice existente); o resumo em TSK-01 é uma agregação agrupada por `process_id IN (…)` da página (≤ 100 itens), sem N+1; meta de p95 da listagem de dotações de um processo ≤ 150 ms medida na suíte de performance (endurecimento).
- **Migração:** `CREATE TABLE budget_allocations` (M2-xx do módulo `budget`) com RLS `ENABLE`/`FORCE`, FKs compostas com o tenant, checks e triggers da entidade; enums/catálogos do M2-01 e semeadura incremental dos catálogos (entities MVP 2 §9), sem backfill (não há dotação anterior; as etapas `TASK` provisórias do contorno do roadmap §3.2 entram na migração de workflow, DEC-195).
- **Compatibilidade:** mudanças em TSK-01 e nas respostas são aditivas (DEC-108); clientes do MVP 1 ignoram o bloco `budget`.
- **Segurança:** `DELETE` com corpo JSON pode ser descartado por intermediários; o BFF e o contrato de teste cobrem o caso (mesmo padrão de ATT-06). Mensagens de erro nunca citam o tenant, nem o id de item de outro órgão.

## Backend
- **Módulo(s):** `budget` (dono), `process` (fachada de etapa/status/custódia/sigilo), `catalog` (itens), `workflow` (identificação da etapa), `timeline`, `audit`, `platform` (outbox, idempotência).
- **Casos de uso:** `ListBudgetAllocationsQuery`, `GetBudgetAllocationQuery`, `CreateBudgetAllocationCommand`, `UpdateBudgetAllocationCommand`, `RemoveBudgetAllocationDraftCommand`, `GetBudgetTaskSummaryQuery` (lote para TSK-01).
- **Domínio:** `BudgetAllocation` (estados `DRAFT`/`CONFIRMED`/`CANCELED`, invariantes de RN-BUD-20/21); `BudgetClassification` (value object: exercício + quatro itens; chave de unicidade); `BudgetAmount` (decimal `numeric(18,2)`, sem ponto flutuante); `BudgetAllocationPolicy` (POL-25: permissão, custódia, etapa, status); `BudgetAllocationSerializer` (máscara POL-09).
- **Integrações internas:** `ProcessFacade` (etapa ativa `DOTACAO`, status, custódia, `isBudgetConfidential`, `pcaYear`, `currentResponsibleId`), `CatalogFacade` (itens por tipo/ativo/tenant), `AuthorizationService`, `OutboxWriter`, `TimelineProjector` (síncrono), `AuditWriter`.
- **Transação:** a de cada comando, com `app.tenant_id`: autorização → leitura da etapa/processo → validações → gravação da dotação → auditoria → outbox (+ projeção de timeline); a criação não bloqueia o processo (`FOR UPDATE` só na confirmação e no cancelamento, US-147).

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`) — painel "Dotação orçamentária" (aba/região do Resumo, `h2`), visível com a etapa `DOTACAO` ativa e, em leitura, quando houver dotações; SCR-013 (`/tarefas`) — resumo na linha da tarefa. Sem rota nova.
- **Componentes:** `BudgetAllocationPanel`, `BudgetAllocationCard` (classificação, exercício, valor, selo de situação), `BudgetAllocationForm` (`Combobox` por catálogo, `MoneyInput` pt-BR, `YearSelect`), `RemoveDraftDialog` (motivo), `ConfidentialValueBadge` ("Valor sigiloso"), `InboxBudgetChip` ("2 rascunhos · 0 confirmadas"), `EmptyState`.
- **Estados:** loading (skeleton por bloco); vazio ("Nenhuma dotação indicada" com botão); erro por bloco com "Tentar novamente"; sucesso (toast "Dotação indicada" e cartão em `Rascunho`); conflito 412 (diálogo de recarga mantendo o digitado); somente leitura com o motivo (fora da etapa, sem custódia, status).
- **Acessibilidade e responsividade:** formulário em modal com foco no primeiro campo e retorno do foco ao botão de origem; erros por campo associados via `aria-describedby` e anunciados em `aria-live="polite"`; situação por texto e ícone (não só cor); valor com `aria-label` "valor sigiloso" quando mascarado; cartões em coluna única abaixo de 768 px, formulário em tela cheia abaixo de 640 px (DEC-183).

## Banco de dados
- **Tabelas:** `budget_allocations` (nova, módulo `budget`, entities MVP 2 §4.2); leitura de `catalog_items`, `processes`, `process_stages`, `workflow_stages`; escrita em `audit_logs`, `outbox_events`, `process_timeline_entries`.
- **Migrações:** criação de `budget_allocations` (reversível: `down` remove a tabela vazia) com RLS e *grants* de `cf_app`/`cf_worker`; semeadura incremental dos catálogos orçamentários (US-104/`TenantSeeder`).
- **Índices/constraints relevantes:** `(tenant_id, process_id, status)`; `(tenant_id, fiscal_year, budget_unit_id)`; único parcial de classificação (`WHERE status <> 'CANCELED'`, lacuna 3); checks `reserved_amount > 0`, `status <> 'CANCELED' OR cancellation_reason IS NOT NULL`; FKs compostas `(tenant_id, …)` para `processes`, `process_stages`, `catalog_items` e `attachments`; trigger de imutabilidade de `process_id`/`process_stage_id`/`tenant_id` e de `CONFIRMED` (US-147).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `BUD-01` | GET | `/processes/{id}/budget-allocations` | `?status=DRAFT,CONFIRMED&fiscalYear=` (padrão exclui `CANCELED`) | `200 { data: BudgetAllocation[], meta: { summary { allocationsCount, draftCount, confirmedCount, canceledCount }, allowedActions } }`; valor mascarado conforme POL-09 | 200, 401, 403, 404 |
| `BUD-02` | POST | `/processes/{id}/budget-allocations` | `{ fiscalYear, budgetUnitId, budgetActionId, expenseNatureId, fundingSourceId, reservedAmount, notes? }` + `Idempotency-Key` | `201 { data: BudgetAllocation, meta: { warnings[] } }` + `ETag`, `Location` | 201, 401, 403, 404, 409, 422, 429, 503 |
| `BUD-03` | GET | `/processes/{id}/budget-allocations/{allocationId}` | — | `200 { data: BudgetAllocation }` + `ETag`; `reservedAmount`/`reservedAmountMasked` sempre presentes | 200, 401, 403, 404 |
| `BUD-04` | PATCH | `/processes/{id}/budget-allocations/{allocationId}` | qualquer subconjunto de `fiscalYear`, `budgetUnitId`, `budgetActionId`, `expenseNatureId`, `fundingSourceId`, `reservedAmount`, `notes` + `If-Match` | `200 { data: BudgetAllocation, meta: { warnings[] } }` + novo `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `BUD-05` | DELETE | `/processes/{id}/budget-allocations/{allocationId}` | `{ reason }` + `If-Match` | `200 { data: BudgetAllocation }` com `status = CANCELED` (remoção lógica de rascunho) | 200, 403, 404, 409, 412, 422, 428, 503 |
| `CAT-01` | GET | `/catalogs/{catalogType}/items` | `catalogType` ∈ `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE`, `FUNDING_SOURCE`; `?active=true` | `200 { data: CatalogItem[] }` com `code`, `label`, `metadata.officialCode` | 200, 401, 404 |
| `TSK-01` | GET | `/tasks` | como na US-056 | itens da etapa `DOTACAO` ganham `budget { allocationsCount, draftCount, confirmedCount }` (aditivo) | 200, 401, 403 |

Exemplo de resposta de `BUD-02` (processo não sigiloso):
```json
{
  "data": {
    "id": "0192f1c2-7a41-7d3e-9b0e-5c2d4a1e8f10",
    "processId": "0192f1b0-1c11-7a52-8e0f-9a3b6c7d2e01",
    "processStageId": "0192f1b9-44aa-7c10-b3d2-1f0e9a8b7c66",
    "fiscalYear": 2026,
    "budgetUnit": { "id": "…", "code": "UO_0201", "label": "UO 02.01 — Secretaria de Administração", "officialCode": "02.01" },
    "budgetAction": { "id": "…", "code": "PT_041220001", "label": "Administração geral", "officialCode": "04.122.0001" },
    "expenseNature": { "id": "…", "code": "ND_33903000", "label": "Material de consumo", "officialCode": "3.3.90.30" },
    "fundingSource": { "id": "…", "code": "FONTE_1500", "label": "Recursos ordinários", "officialCode": "1500" },
    "reservedAmount": "60000.00",
    "reservedAmountMasked": false,
    "reservationNumber": null,
    "reservationDate": null,
    "evidenceAttachmentId": null,
    "status": "DRAFT",
    "notes": null,
    "version": 1
  },
  "meta": { "warnings": [] }
}
```

## Logs
- `info` `budget.allocation.created` — `allocationId`, `processId`, `fiscalYear`, `durationMs`; `info` `budget.allocation.updated` — `allocationId`, `changedFields`; `info` `budget.allocation.draft_removed` — `allocationId`.
- `warn` `budget.allocation.rejected` — `reason` (`DUPLICATED`, `LIMIT`, `NO_ACTIVE_STAGE`, `NOT_EDITABLE`, `CONFIDENTIAL_BUDGET`, `CLASSIFICATION_MISMATCH`), `processId`.
- `error` `budget.allocation.persist_failed` — `processId`, causa técnica (sem corpo da requisição).
- **Nunca logar:** `reservedAmount` ou qualquer valor monetário, `notes`, `reason` digitados, ids de itens de catálogo de outro tenant, `Idempotency-Key`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `budget_allocation.create` | `DATA_CHANGE` | Commit de BUD-02 | `changes`: `fiscalYear`, ids/códigos dos quatro itens, `reservedAmount` (`{ masked: true }` se o processo for sigiloso), `status`. `metadata`: `processId`, `processStageId`, `idempotencyKey` |
| `budget_allocation.update` | `DATA_CHANGE` | Commit de BUD-04 com alteração efetiva | `changes`: antes/depois dos campos alterados (`reservedAmount` mascarado no sigilo). `metadata`: `processId`, `changedFields[]` |
| `budget_allocation.cancel` | `WORKFLOW` | Commit de BUD-05 | `changes`: `status` DRAFT → CANCELED. `metadata`: `processId`, `fromStatus = DRAFT`, `hasReason` (o texto do motivo fica em `cancellationReason`) |
| `access.denied` | `ACCESS` | Tentativa sem permissão/custódia | `reasonCode` (`PERMISSION_DENIED`, `NOT_PROCESS_CUSTODIAN`, `CONFIDENTIAL_BUDGET`) |

## Testes necessários
- **Unitários:** `BudgetAmount` (casas decimais, limites, > 0); `BudgetClassification` (chave de unicidade); `BudgetAllocationPolicy` (permissão × custódia × etapa × status, titular/substituto); coerência ação × unidade; faixa de exercício no limite do ano (virada de ano no fuso do tenant); `BudgetAllocationSerializer` (máscara com e sem POL-09 e com o responsável atual); `changedFields` sem mudança efetiva.
- **Integração (Testcontainers PostgreSQL + Redis):** criação/edição/remoção atômicas com auditoria, outbox e timeline; índice único parcial de classificação; limite de 20; RLS (`app.tenant_id`) e FKs compostas; trigger que impede alterar `processId`/`processStageId`; rollback total em falha de banco; relay do outbox com Redis fora; agregação em lote do TSK-01 sem N+1 (contagem de consultas).
- **API/contrato:** BUD-01 a BUD-05 contra o OpenAPI; `reservedAmount` e `reservedAmountMasked` sempre presentes; `ETag`/`If-Match`; `Idempotent-Replayed`; códigos de erro de cada validação V-01..V-15; bloco aditivo de TSK-01 sem quebrar o contrato do MVP 1; `DELETE` com corpo através do BFF.
- **RBAC e multi-tenant:** matriz perfil × permissão (`CONTABILIDADE`, `GESTOR_CONTRATACOES` com e sem custódia, `AUDITOR`, participante, `REQUISITANTE`); processo, dotação e catálogo de outro tenant → 404/`REFERENCE_NOT_FOUND` idêntico ao inexistente (suíte `test/tenant-leak`, arquivo novo `budget-allocation.tenant-leak.test.ts`); dotação de outro processo pelo caminho → 404; sigilo: nenhum valor em evento, timeline, notificação, log ou auditoria.
- **Concorrência:** duas edições com a mesma `version`; remoção × edição; dois `POST` com a mesma classificação em paralelo (um 201, um 409); `Idempotency-Key` repetida em paralelo (`IDEMPOTENCY_IN_PROGRESS`).
- **E2E (Playwright):** indicar duas dotações, editar e remover um rascunho; processo sigiloso visto por perfil sem permissão; estado de catálogo vazio; fora da etapa (somente leitura); tarefa na caixa com o resumo.
- **Acessibilidade/performance:** axe no painel, no formulário e no diálogo de remoção; navegação por teclado dos `Combobox`; listagem de 20 dotações dentro da meta de p95 na suíte de performance (medida no endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Teste de serialização garante que nenhum valor sigiloso sai em evento, timeline, notificação, log ou auditoria
- [ ] Contrato aditivo de TSK-01 coberto por teste de compatibilidade com o MVP 1

## Estimativa
**M** — módulo `budget` e entidade novos, cinco endpoints, painel com formulário de classificação por catálogos, máscara de sigilo em leitura e escrita, política POL-25 e resumo na caixa de tarefas; sem integração externa e sem regras de saída (que ficam na US-148).

## Prioridade
**P0** — sem a indicação estruturada não há confirmação (US-147) nem regra de saída da etapa `DOTACAO` (US-148); a regra de saída é pré-requisito da v2 do workflow padrão (US-130) e do parecer jurídico e da manifestação do Controle Interno, que conferem a dotação.
