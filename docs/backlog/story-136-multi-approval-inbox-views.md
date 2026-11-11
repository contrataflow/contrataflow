---
id: US-136
title: "Aprovação múltipla na caixa de tarefas, na lista e no detalhe da aprovação"
epic: EP-022
feature: FT-066
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-056, US-057, US-134]
modules: [approval, process, access, timeline]
screens: [SCR-013, SCR-014, SCR-015]
endpoints: [TSK-01, TSK-02, APV-01, APV-02, APV-31]
permissions: [INBOX_VIEW, APPROVAL_VIEW]
events: []
---

# US-136 — Aprovação múltipla na caixa de tarefas, na lista e no detalhe da aprovação

## Título
Aprovação múltipla na caixa de tarefas, na lista e no detalhe da aprovação

## Descrição
**Como** aprovador designado em uma aprovação com mais de um aprovador (ou solicitante que acompanha essa aprovação), **quero** ver na caixa de tarefas apenas as linhas de aprovação em que é a minha vez, e na lista e no detalhe da aprovação a política de decisão, as linhas, os votos já registrados e de quem é a vez, **para** decidir no momento certo e saber exatamente o que falta para a aprovação se encerrar.

A story entrega o lado de **leitura** da aprovação múltipla (DEC-193): a visão `PENDING_APPROVALS` da caixa de tarefas (SCR-013, TSK-01/TSK-02) passa a ler a view `v_inbox_pending_approvals` v2, com uma linha por `ApprovalApprover` `PENDING`; a lista de aprovações (SCR-014, APV-01) ganha política, progresso e minha situação; o detalhe (SCR-015, APV-02) mostra as linhas ordenadas, os votos e as ações disponíveis por linha; e um endpoint novo (APV-31) devolve o histórico completo das linhas, inclusive as substituídas por redirecionamento. As ações em si (solicitar, decidir, redirecionar, retirar) são de US-133, US-134 e US-135; aqui nada é gravado.

## Contexto
- No MVP 1 a aprovação tem um aprovador resolvido e a caixa de tarefas lista uma linha por `Approval` `PENDING` (US-056, RN-INBOX-07); a lista (US-057) e o detalhe (US-052) seguem o mesmo modelo. Com a DEC-193 a aprovação ganha `decisionPolicy` (`ANY`, `ALL`, `SEQUENTIAL`) e uma `ApprovalApprover` por aprovador; a fonte de verdade de quem decide passa a ser a linha, e as colunas de aprovador da `Approval` apenas espelham a linha corrente (entities.md §5.9).
- A caixa de tarefas só pode listar a linha `PENDING`: em `SEQUENTIAL` as linhas seguintes ficam `WAITING` e fora da caixa; em `ALL` todas ficam `PENDING` ao mesmo tempo e cada aprovador vê a sua. Quando o aprovador já votou, a linha sai da caixa mesmo que a aprovação continue `PENDING` para os demais.
- A view `v_inbox_pending_approvals` v2 (dono `approval`) existe desde a migração M2-03 (backfill de uma linha por aprovação existente + view); a v1 continua publicada até o *contract* (M2-22, fora do MVP 2). A leitura v2 precisa devolver, para toda aprovação do MVP 1 (`ANY`, uma linha), exatamente o que a v1 devolvia.
- Segregação de funções por linha e designação por linha (POL-03 do MVP 2): linha `WAITING` não decide (`NOT_DESIGNATED_APPROVER`); a segunda decisão sobre a mesma linha recebe `APPROVAL_LINE_NOT_PENDING` (409) em `ALL`. A tela precisa **explicar** esses estados antes de o usuário tentar a ação.
- `Approval.dueAt` vale para o conjunto (DEC-193, RN-APV-09 da feature); `ApprovalApprover.dueAt` só existe quando uma política de SLA o define (US-190). A caixa e a lista exibem o prazo da linha quando houver e, senão, o da aprovação (events.md §6, "Aprovação por linha").
- A aprovação de assunto `PCA` (EP-023) reutiliza a mesma mecânica, com `processId` nulo; os contratos de leitura desta story já tratam `process` nulo para que o EP-023 não precise alterá-los.
- Esta story depende de US-134 (decisão e encerramento) para que existam linhas em todos os estados (`APPROVED`, `SKIPPED`, `CANCELED`…) a exibir.

## Objetivo
Garantir que 100% das linhas `PENDING` cobertas pelo usuário apareçam exatamente uma vez na caixa de tarefas e nenhuma linha `WAITING`, `SKIPPED` ou `CANCELED` apareça; que lista e detalhe mostrem política, progresso, linhas e votos coerentes com o estado do banco; e que as aprovações do MVP 1 continuem idênticas, com p95 < 500 ms por visão da caixa (meta do RN-INBOX-12 mantida).

## Persona
- **Principal:** Aprovador designado em linha de aprovação (`AUTORIDADE_COMPETENTE` com `APPROVAL_DECIDE`, titular/substituto de unidade, ou usuário nominal).
- **Secundárias:** Solicitante da aprovação e Gestor de contratações (`GESTOR_CONTRATACOES`) que acompanham votos e a vez de cada aprovador; Auditor (`AUDITOR`), que consulta o histórico das linhas.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` e não expirado.
- Para a caixa: `INBOX_VIEW`. Para lista e detalhe: `APPROVAL_VIEW` ou designação em ao menos uma linha da aprovação (ou ser solicitante/decisor, como no MVP 1).
- Migração M2-03 aplicada: toda `Approval` tem ao menos uma `ApprovalApprover` e a view v2 está publicada.
- Existem aprovações com `decisionPolicy` `ALL` ou `SEQUENTIAL` (US-133) em andamento, ou o estado vazio é exibido.

## Fluxo principal
1. O aprovador abre **"Caixa de tarefas"** (SCR-013, `/tarefas`) e a aba **"Aprovações pendentes"**; o front chama TSK-02 e TSK-01 (`view=PENDING_APPROVALS`) em paralelo, com skeleton até a resposta.
2. O sistema lista **uma linha por linha de aprovação `PENDING` coberta pelo usuário**, mostrando o assunto, o solicitante, a data da solicitação, o prazo (da linha ou da aprovação) e um selo de andamento: "Sua vez · aprovação conjunta (1 de 3 aprovaram)" em `ALL`, "Sua vez · etapa 2 de 3" em `SEQUENTIAL`, nada extra em `ANY` com uma linha.
3. O contador da aba (TSK-02 `pendingApprovals`) conta as mesmas linhas, lidas no mesmo snapshot.
4. O usuário abre **"Aprovações"** (SCR-014, `/aprovacoes`); o front chama APV-01 (`status=PENDING`). A lista mostra uma linha por **aprovação**, com política, "Andamento" (`progress`), "Aprovador atual" (em `SEQUENTIAL`) e a situação do próprio usuário (`myLine`): "Sua vez", "Aguardando a vez", "Você já aprovou", "Encerrada para você".
5. O usuário aplica os filtros novos ("Política de decisão" e "Minha situação") e os filtros do MVP 1; o front reconsulta APV-01.
6. Ao abrir uma aprovação (`/aprovacoes/[id]`, SCR-015), o front chama APV-02. O detalhe exibe o cabeçalho do MVP 1, o bloco **"Linhas de aprovação"** (ordem, aprovador, situação, decisão, data, "decidiu como substituto de …", prazo da linha) e o cartão de decisão **somente** quando `meta.allowedActions` contém `DECIDE` para a linha do usuário.
7. Quando o usuário não pode decidir, o cartão de decisão é substituído por uma explicação derivada de `meta.decisionBlocker`: "Aguardando a aprovação de {label da linha corrente} antes da sua", "Você já registrou sua decisão nesta aprovação", "Esta aprovação já foi encerrada" ou "Você é autor de um documento coberto e não pode aprovar" (segregação de funções).
8. O usuário abre **"Histórico de linhas"** no detalhe; o front chama APV-31 e exibe todas as linhas em ordem de `sequence` e criação, inclusive as `CANCELED` por redirecionamento (com "substituída por …") e as `SKIPPED` (com o motivo).
9. A cada 60 s, em primeiro plano, a caixa refaz TSK-02/TSK-01 (polling de RN-INBOX-13); o detalhe revalida APV-02 ao recuperar o foco e após qualquer ação da US-134/US-135; mudança de `ETag` atualiza as linhas sem perder a rolagem.

## Fluxos alternativos
- **FA-01 — Aprovação do MVP 1 (`ANY`, uma linha):** caixa, lista e detalhe se comportam como no MVP 1; o bloco "Linhas de aprovação" não é exibido (há uma só linha) e o selo de andamento não aparece.
- **FA-02 — `ANY` com várias linhas:** a lista mostra "Qualquer um dos {N} aprovadores"; o detalhe mostra as linhas todas `PENDING` e, decidida uma, as demais como "Dispensada — decidida por outro aprovador".
- **FA-03 — Linha `WAITING` do usuário (`SEQUENTIAL`):** a aprovação **não** aparece na caixa, mas aparece em SCR-014 com "Aguardando a vez"; ao ser ativada (`ApprovalApproverActivated`), passa a aparecer na caixa na próxima leitura.
- **FA-04 — Usuário com duas linhas na mesma aprovação:** a caixa mostra duas linhas (uma por `approvalApproverId`); a lista mostra uma linha por aprovação, com `myLine` apontando a linha pendente de menor `sequence`.
- **FA-05 — Linha coberta por mais de um caminho:** titular que também detém o perfil designado vê a linha uma só vez (dedupe por `approvalApproverId`).
- **FA-06 — Substituto:** quando a linha permite substituto (`allowDeputy`), titular e substituto veem a mesma linha; assim que um deles decide, a linha some da caixa do outro na próxima leitura.
- **FA-07 — Linha substituída por redirecionamento:** a linha antiga (`CANCELED`, `REASSIGNED`) some da caixa do aprovador anterior e aparece no histórico; a nova linha aparece na caixa do novo aprovador.
- **FA-08 — Aprovação encerrada enquanto a tela está aberta:** a linha some da caixa; o detalhe exibe o banner "Esta aprovação foi encerrada" e oculta o cartão de decisão.
- **FA-09 — Processo suspenso:** como no MVP 1, a aprovação permanece `PENDING`; o detalhe exibe "Processo suspenso — decisão indisponível até a retomada" (`decisionBlocker = INVALID_PROCESS_STATUS`).
- **FA-10 — Processo com orçamento sigiloso:** a linha aparece normalmente; nenhum valor monetário é exibido (POL-09; §1.4 de api.md).
- **FA-11 — Aprovação de assunto `PCA` (EP-023):** `process` é nulo; a linha exibe o plano ("PCA 2027 — versão 1") e o link leva ao detalhe da aprovação.
- **FA-12 — Rótulo de linha sem pessoa:** em `ROLE`, a linha exibe "Qualquer titular de {perfil}" (como FA-02 da US-057); em `DEPARTMENT_HEAD`, "{nome do titular} (titular de {unidade})".

## Regras de negócio
- **RN-APV-61** — A visão `PENDING_APPROVALS` e o contador `pendingApprovals` leem a view `v_inbox_pending_approvals` v2: **uma linha por `ApprovalApprover` `PENDING`** coberta pelo usuário (direto, `ROLE` com escopo sobre a unidade solicitante, ou titular/substituto de `approverDepartmentId` com `allowDeputy`). Linhas `WAITING`, `APPROVED`, `RETURNED`, `REJECTED`, `SKIPPED` e `CANCELED` nunca entram (DEC-193; estende RN-INBOX-07).
- **RN-APV-62** — Em `PENDING_APPROVALS`, o `id` da linha da resposta é o `approvalApproverId` e o campo `approval.id` traz a `Approval`; uma linha coberta por mais de um caminho aparece uma única vez; um usuário com duas linhas distintas da mesma aprovação vê duas linhas (cada voto é de uma linha). Em `ANY` com uma linha, o resultado é idêntico ao da v1 (RN-INBOX-14, dedupe).
- **RN-APV-63** — O prazo exibido é `ApprovalApprover.dueAt`, quando preenchido; senão `Approval.dueAt`; senão o `dueAt` da `ProcessStage` da aprovação (comportamento do MVP 1). `isOverdue` compara esse valor a agora enquanto a linha estiver `PENDING`, sem depender de `overdueSince` (RN-INBOX-16).
- **RN-APV-64** — Contadores e lista da caixa usam os mesmos predicados e o mesmo snapshot (RN-INBOX-09): `pendingApprovals` conta **linhas** `PENDING`, não aprovações. A meta de p95 < 500 ms por visão (RN-INBOX-12) continua valendo e usa os índices parciais de `approval_approvers` (`approver_user_id`, `approver_department_id`, `approver_role_id` `WHERE status = 'PENDING'`).
- **RN-APV-65** — A linha deixa a caixa na primeira leitura depois de qualquer um destes fatos: decisão do próprio usuário, decisão de outro com a mesma cobertura (substituto), `SKIPPED` por decisão negativa ou por `ANY_DECIDED`, `CANCELED` por redirecionamento ou retirada, ou encerramento da aprovação (`APPROVED`, `RETURNED`, `REJECTED`, `CANCELED`).
- **RN-APV-66** — Cobertura de APV-01: entram as aprovações em que o usuário tem linha `PENDING` ou `WAITING` agora (mesma cobertura de RN-APV-61, aplicada também às linhas `WAITING`) e as que ele decidiu (`ApprovalApprover.decidedById`, o histórico não some quando a titularidade muda). Uma linha de resultado por aprovação. Linha `WAITING` mostra "Aguardando a vez" e nunca oferece a ação de decidir.
- **RN-APV-67** — APV-01 ganha, de forma aditiva: filtros `decisionPolicy` (`ANY`, `ALL`, `SEQUENTIAL`; múltiplos = OU) e `myLineStatus` (`WAITING`, `PENDING`, `APPROVED`, `RETURNED`, `REJECTED`, `SKIPPED`); campos de resposta `decisionPolicy`, `progress` (`totalLines`, `approvedLines`, `pendingLines`, `waitingLines`, contando apenas linhas não `CANCELED`), `myLine` (`approvalApproverId`, `sequence`, `status`, ou nulo) e `currentApprover` (rótulo da linha corrente em `SEQUENTIAL`). A ordenação e a paginação do MVP 1 não mudam.
- **RN-APV-68** — APV-02 ganha, de forma aditiva: `data.decisionPolicy` e `data.approvers[]` (composição vigente, ordenada por `sequence`, sem linhas `CANCELED`), cada item com `id`, `sequence`, `label`, `approverType`, `status`, `activatedAt`, `dueAt`, `decision`, `decidedBy`, `decidedAt`, `decidedAsDeputy`, `decisionComment`, `skippedReason`; `meta.myApproverLineId`, `meta.lineActions` (ações por linha para US-134/US-135) e `meta.waitingFor` (linha corrente em `SEQUENTIAL`). `meta.allowedActions` e `meta.decisionOptions` continuam como no MVP 1, avaliados **para a linha do usuário**. `decisionBlocker` ganha o valor `LINE_NOT_PENDING` (linha do usuário já decidida ou dispensada); linha `WAITING` mantém `NOT_DESIGNATED_APPROVER` (POL-03).
- **RN-APV-69** — APV-31 devolve **todas** as linhas da aprovação, inclusive `CANCELED` (substituídas) com `reassignedFromId`, em ordem de `sequence` e `createdAt`; usa a mesma autorização de APV-02; é somente leitura (decisão registrada é imutável — DEC-193). Linhas substituídas exibem "Substituída por {rótulo da nova linha}" e o motivo não é exibido (o motivo do redirecionamento não é persistido — RN-TRAM-69 do MVP 1).
- **RN-APV-70** — Texto de andamento (campo `progress.label`, gerado no servidor para manter o mesmo texto em caixa, lista e detalhe): `ALL` → "{approvedLines} de {totalLines} aprovaram"; `SEQUENTIAL` → "Etapa {sequência da linha corrente} de {totalLines} — {rótulo da linha corrente}"; `ANY` com mais de uma linha → "Qualquer um dos {totalLines} aprovadores"; `ANY` com uma linha → ausente. Aprovação encerrada → "Encerrada — {resultado}".
- **RN-APV-71** — Situações das linhas em pt-BR, sempre com texto e ícone (nunca só cor): `WAITING` "Aguardando a vez", `PENDING` "Pendente", `APPROVED` "Aprovou", `RETURNED` "Devolveu", `REJECTED` "Indeferiu", `SKIPPED` "Dispensada" com o motivo (`NEGATIVE_DECISION` "Encerrada por decisão negativa", `ANY_DECIDED` "Decidida por outro aprovador", `WITHDRAWN` "Aprovação retirada") e `CANCELED` + `REASSIGNED` "Substituída".
- **RN-APV-72** — Sigilo e isolamento: nenhuma resposta traz valores monetários; o texto de `decisionComment` de uma linha é visível a quem vê a aprovação (APV-02), como no MVP 1; consulta a aprovação de outro tenant ou fora da visibilidade responde 404 `APPROVAL_NOT_FOUND`; a view v2 e as consultas rodam com `app.tenant_id` (RLS).
- **RN-APV-73** — Segregação de funções por linha (`approval.preventSelfApproval`, art. 7º, § 1º da Lei 14.133/2021): se o usuário é autor de documento coberto, `decisionBlocker = SELF_APPROVAL_FORBIDDEN` para a linha dele e a tela explica o motivo; a resolução de substituto da linha é de US-133/US-134 e não é reavaliada aqui.
- **RN-APV-74** — Compatibilidade (DEC-108): nenhum campo do MVP 1 é removido ou muda de significado; `approver` (`type`, `label`) continua espelhando a linha corrente (`SEQUENTIAL`) ou a primeira (`ANY`/`ALL`); clientes que ignoram os campos novos continuam corretos; a view v1 não é alterada. Teste de contrato compara o JSON de APV-01/APV-02/TSK-01 de uma aprovação `ANY` de uma linha antes e depois do backfill.
- **RN-APV-75** — Atualização: o polling de 60 s da caixa (RN-INBOX-13) cobre as linhas novas; SCR-014 e SCR-015 revalidam ao recuperar o foco e após as ações de US-134/US-135 (invalidam `['t', tenantId, 'approvals']`, `['t', tenantId, 'tasks']` e `['t', tenantId, 'processes', processId]`); quando a revalidação mostra a aprovação encerrada ou a linha do usuário decidida por outro, a tela atualiza o estado e informa em `aria-live`.
- **RN-APV-76** — Acessibilidade e responsividade: o bloco "Linhas de aprovação" é uma tabela com cabeçalhos associados (cartões abaixo de 768 px); em `SEQUENTIAL` a linha corrente recebe `aria-current="step"`; a mudança de vez é anunciada por `aria-live="polite"`; contraste AA nos dois temas; uso móvel plenamente suportado (360 px).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Visão da caixa | `view` (query TSK-01) | enum | Não | `PENDING_APPROVALS` lê a view v2 (RN-APV-61) | `MINE` |
| Política de decisão | `decisionPolicy` (query APV-01) | enum múltiplo (`ApprovalDecisionPolicy`) | Não | `ANY`, `ALL`, `SEQUENTIAL`; vários = OU | — |
| Minha situação | `myLineStatus` (query APV-01) | enum (`ApprovalApproverStatus`, exceto `CANCELED`) | Não | RN-APV-67 | — |
| Incluir histórico | `includeHistory` (query APV-31) | booleano | Não | `false` omite linhas `CANCELED` | `true` |
| *(saída)* Linha da caixa | `id`, `approval.id`, `approval.approvalApproverId`, `approval.sequence` | uuid / inteiro | — | RN-APV-62 | view v2 |
| *(saída)* Política | `decisionPolicy` | enum | — | `ApprovalDecisionPolicy` | `Approval.decisionPolicy` |
| *(saída)* Andamento | `progress { totalLines, approvedLines, pendingLines, waitingLines, label }` | objeto | — | RN-APV-67, RN-APV-70 | calculado |
| *(saída)* Minha linha | `myLine { approvalApproverId, sequence, status }` | objeto \| nulo | — | RN-APV-67 | calculado |
| *(saída)* Aprovador atual | `currentApprover { label }` | objeto \| nulo | — | só `SEQUENTIAL` pendente | calculado |
| *(saída)* Prazo da linha | `dueAt`, `isOverdue` | datetime / booleano | — | RN-APV-63 | linha → aprovação → etapa |
| *(saída)* Linhas | `approvers[]` | lista | — | RN-APV-68 | `ApprovalApprover` |
| *(saída)* Rótulo da linha | `approvers[].label` | texto | — | "Secretário de Administração" (`WorkflowStageApprover.label`) ou rótulo derivado do tipo (FA-12) | solicitação (US-133) |
| *(saída)* Bloqueio | `meta.decisionBlocker` | enum \| nulo | — | + `LINE_NOT_PENDING` (RN-APV-68) | calculado |
| *(saída)* Aguardando | `meta.waitingFor { sequence, label }` | objeto \| nulo | — | `SEQUENTIAL` | calculado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `decisionPolicy` fora do enum | API (Zod) | — (a UI só envia valores válidos) | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | `myLineStatus` fora do enum | API (Zod) | — | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-03 | `includeHistory` não booleano em APV-31 | API (Zod) | — | `VALIDATION_ERROR` (`INVALID_TYPE`) |
| V-04 | `view`, `sort`, `status`, `subjectType` ou período inválidos (herdados do MVP 1) | API (Zod) | "Revise os filtros selecionados." | `VALIDATION_ERROR` |
| V-05 | `{id}` de aprovação inexistente, de outro tenant ou fora da visibilidade (APV-02, APV-31) | API | "Aprovação não encontrada." | `APPROVAL_NOT_FOUND` |
| V-06 | Usuário sem `APPROVAL_VIEW`, sem linha e que não é solicitante nem decisor (APV-02, APV-31) | API | "Você não tem acesso a esta aprovação." | `PERMISSION_DENIED` |
| V-07 | Sem `INBOX_VIEW` (TSK-01, TSK-02) | API | "Você não tem acesso à caixa de tarefas." | `PERMISSION_DENIED` |
| V-08 | Consulta acima do teto de 3 s (`statement_timeout`) ou banco indisponível | API | "Não foi possível carregar as aprovações agora." | `DEPENDENCY_UNAVAILABLE` |

## Permissões
- **Permissão:** `INBOX_VIEW` para TSK-01/TSK-02; `APPROVAL_VIEW` (ou designação em alguma linha, solicitante ou decisor) para APV-01, APV-02 e APV-31. APV-01 aplica a cobertura como filtro da consulta e responde lista vazia, nunca 403, quando não há cobertura (RN-INBOX-14).
- **Permissões apenas consultadas para exibir ou ocultar ações (exercidas em US-134/US-135):** `APPROVAL_DECIDE` (cartão de decisão), `APPROVAL_REASSIGN` ("Redirecionar linha") e `PROCESS_ASSIGN` ("Retirar aprovação", DEC-193); nada é executado nesta story.
- **Políticas:** POL-03 do MVP 2 (designação e segregação **por linha**; linha `WAITING` → `NOT_DESIGNATED_APPROVER`; concorrência `APPROVAL_NOT_PENDING`/`APPROVAL_LINE_NOT_PENDING`), POL-17 (retirar cancela a aprovação inteira; não há retirada de voto), DEC-024 (visibilidade do processo), POL-09 (sigilo de orçamento).
- **MFA:** não exigido (todas as permissões desta story são de risco `L`).
- **Sem permissão:** o item "Caixa de tarefas" não é exibido sem `INBOX_VIEW`; "Aprovações" não é exibido a quem não tem `APPROVAL_VIEW` nem é aprovador de nada; a API responde 403 `PERMISSION_DENIED` (TSK-01, APV-02, APV-31) e registra `access.denied` apenas nas respostas 403 de APV-02/APV-31.

## Eventos gerados
Nenhum. TSK-01, TSK-02, APV-01, APV-02 e APV-31 são leituras. A story **consome** o resultado de `ApprovalRequested`, `ApprovalVoteRecorded`, `ApprovalApproverActivated`, `ApprovalReassigned`, `ApprovalCompleted`/`ApprovalReturned`/`ApprovalRejected` e `ApprovalCanceled` (US-133, US-134, US-135) apenas pelo estado persistido das linhas; as entradas de timeline `APPROVAL_VOTE_RECORDED` e `APPROVAL_TURN` aparecem no SCR-006 e já são projetadas por essas stories.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação própria. `APPROVAL_REQUESTED` (a cada linha que passa a `PENDING`) e `APPROVAL_VOTE_RECORDED` (ao solicitante) são enviadas por US-133/US-134 (events.md §6); o link delas leva a `/aprovacoes/{id}`. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Aprovação múltipla na caixa de tarefas, na lista e no detalhe da aprovação

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0012/2026" tem a aprovação "Aprovação da demanda — DFD 0005/2026" na etapa "APROVACAO_DEMANDA"
    And a aprovação tem a política "ALL" com a linha 1 de "Marcos Lima" (titular da "Secretaria de Administração") e a linha 2 de "Paula Reis" (usuária nominal)
    And "Marcos Lima", "Paula Reis" e "Ana Souza" têm vínculo ativo, "INBOX_VIEW" e "APPROVAL_VIEW"

  Scenario: [Sucesso] Em ALL cada aprovador vê a sua linha e some da caixa depois de votar
    Given que as duas linhas estão "PENDING"
    When "Marcos Lima" abrir a aba "Aprovações pendentes" da caixa de tarefas
    Then a lista deve conter uma linha com "approvalApproverId" da linha 1 e o selo "Sua vez · aprovação conjunta (0 de 2 aprovaram)"
    And o contador "pendingApprovals" deve ser 1
    When "Marcos Lima" aprovar a sua linha
    And "Marcos Lima" atualizar a caixa de tarefas
    Then a caixa de "Marcos Lima" não deve conter a aprovação e o contador deve ser 0
    And a caixa de "Paula Reis" deve continuar com a linha 2 e o selo "1 de 2 aprovaram"
    And nenhuma auditoria nem evento deve ser gerado pelas consultas

  Scenario: [Sucesso] Em SEQUENTIAL só a linha corrente aparece na caixa e a vez é explicada na lista
    Given que a política é "SEQUENTIAL" com a linha 1 "PENDING" e a linha 2 "WAITING"
    When "Paula Reis" abrir a caixa de tarefas
    Then a aprovação não deve aparecer em "Aprovações pendentes"
    When "Paula Reis" abrir "Aprovações"
    Then a linha da aprovação deve exibir "Aguardando a vez" e "Etapa 1 de 2 — Secretário de Administração"
    When "Marcos Lima" aprovar a linha 1 e o evento "ApprovalApproverActivated" ativar a linha 2
    And "Paula Reis" atualizar a caixa de tarefas
    Then a caixa de "Paula Reis" deve conter a aprovação com o selo "Sua vez · etapa 2 de 2"
    And nenhuma auditoria nem evento deve ser gerado pelas consultas

  Scenario: [Sucesso] Detalhe da aprovação mostra linhas, votos e ações da minha linha
    Given que "Marcos Lima" aprovou a linha 1 em "ALL" e a linha 2 continua "PENDING"
    When "Paula Reis" abrir "/aprovacoes/{id}"
    Then a API deve responder 200 com "decisionPolicy" "ALL" e "approvers" com 2 itens ordenados por "sequence"
    And a linha 1 deve ter "status" "APPROVED" e "decidedBy" "Marcos Lima"
    And "meta.myApproverLineId" deve ser o id da linha 2 e "meta.allowedActions" deve conter "DECIDE"
    And nenhuma auditoria nem evento deve ser gerado pela consulta

  Scenario: [Sucesso] Histórico de linhas inclui a linha substituída por redirecionamento
    Given que a linha 2 foi redirecionada de "Paula Reis" para "Carla Nunes" por um gestor com "APPROVAL_REASSIGN"
    When "Ana Souza", solicitante da aprovação, chamar "GET /approvals/{id}/approvers"
    Then a API deve responder 200 com 3 linhas
    And a linha antiga de "Paula Reis" deve ter "status" "CANCELED" e "skippedReason" "REASSIGNED"
    And a nova linha deve ter "reassignedFromId" igual ao id da linha antiga e o mesmo "sequence" 2
    And "GET /approvals/{id}" deve devolver apenas 2 linhas em "approvers"

  Scenario: [Sucesso] Aprovação do MVP 1 com uma linha continua idêntica
    Given que existe uma aprovação "ANY" criada antes do MVP 2 com uma linha de backfill "sequence" 1
    When "Marcos Lima" listar "GET /tasks?view=PENDING_APPROVALS" e "GET /approvals"
    Then os campos do MVP 1 devem ser iguais aos de antes da migração
    And "progress.label" deve estar ausente e o bloco "Linhas de aprovação" não deve ser exibido

  Scenario: [Validação] Filtros e parâmetros inválidos
    When "Marcos Lima" chamar "GET /approvals?decisionPolicy=MAJORITY"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_ENUM" no campo "decisionPolicy"
    When "Marcos Lima" chamar "GET /approvals?myLineStatus=CANCELED"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_ENUM" no campo "myLineStatus"
    When "Marcos Lima" chamar "GET /approvals/{id}/approvers?includeHistory=talvez"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_TYPE" no campo "includeHistory"

  Scenario: [Permissão] Cobertura e permissão por linha
    Given que "Bruno Lopes" não tem linha na aprovação, não é solicitante nem decisor e não tem "APPROVAL_VIEW"
    When "Bruno Lopes" chamar "GET /approvals/{id}"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "approvalId"
    When "Bruno Lopes" listar "GET /approvals"
    Then a API deve responder 200 com lista vazia
    Given que a política é "SEQUENTIAL" e a linha de "Paula Reis" está "WAITING"
    When "Paula Reis" abrir "/aprovacoes/{id}"
    Then "meta.decisionBlocker" deve ser "NOT_DESIGNATED_APPROVER" e o cartão de decisão deve exibir "Aguardando a aprovação de Secretário de Administração antes da sua"

  Scenario: [Permissão] Autor de documento coberto não pode aprovar a própria linha
    Given que "Paula Reis" é autora de uma versão do DFD "DFD 0005/2026" coberto e é a pessoa designada na linha 2
    When "Paula Reis" abrir "/aprovacoes/{id}"
    Then "meta.decisionBlocker" deve ser "SELF_APPROVAL_FORBIDDEN"
    And o cartão de decisão deve explicar a segregação de funções

  Scenario: [Tenant incorreto] Aprovação de outro tenant nunca aparece
    Given que existe uma aprovação "ALL" no tenant "Prefeitura B" com "Marcos Lima" como aprovador em outro vínculo
    When "Marcos Lima" abrir a caixa de tarefas e "Aprovações" no tenant "Prefeitura A"
    Then nenhuma linha do tenant "Prefeitura B" deve aparecer
    When "Marcos Lima" chamar "GET /approvals/{id-da-aprovação-da-Prefeitura-B}"
    Then a API deve responder 404 com código "APPROVAL_NOT_FOUND"

  Scenario: [Duplicidade] Linha coberta por dois caminhos aparece uma vez, duas linhas aparecem duas vezes
    Given que "Marcos Lima" é titular da "Secretaria de Administração" e também detém o perfil designado na mesma linha 1
    When "Marcos Lima" abrir "Aprovações pendentes"
    Then a linha 1 deve aparecer exatamente uma vez
    Given que "Marcos Lima" também é a pessoa designada na linha 2 da mesma aprovação "ALL"
    When "Marcos Lima" abrir "Aprovações pendentes"
    Then devem aparecer duas linhas, uma por "approvalApproverId", e o contador "pendingApprovals" deve ser 2

  Scenario: [Concorrência] Aprovação encerrada por outro aprovador com a tela aberta
    Given que "Paula Reis" está com "/aprovacoes/{id}" aberto e a linha 2 "PENDING"
    When "Marcos Lima" devolver a aprovação com comentário de ao menos 10 caracteres
    And "Paula Reis" voltar o foco à janela
    Then o detalhe deve ser revalidado e exibir "Esta aprovação foi encerrada" com a linha 2 "Dispensada — encerrada por decisão negativa"
    And o cartão de decisão deve ser ocultado e a caixa de "Paula Reis" não deve mais conter a linha

  Scenario: [Falha de banco] Banco indisponível ao consultar a caixa e o detalhe
    Given que o banco de dados está indisponível
    When "Paula Reis" abrir a caixa de tarefas
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a UI deve exibir "Não foi possível carregar as aprovações agora." com o botão "Tentar novamente"

  Scenario: [Falha de integração] Redis indisponível durante o polling
    Given que o Redis está indisponível
    When o polling de 60 s executar a consulta de "TSK-01" e "TSK-02"
    Then as respostas devem ser 200 consultando o banco diretamente
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Filtro ou parâmetro inválido | 422 | `VALIDATION_ERROR` | "Revise os filtros selecionados." | Marca o filtro; mantém o último resultado |
| Sem `INBOX_VIEW` | 403 | `PERMISSION_DENIED` | "Você não tem acesso à caixa de tarefas." | Oculta o menu; rota 403 (SCR-111) |
| Sem acesso à aprovação | 403 | `PERMISSION_DENIED` | "Você não tem acesso a esta aprovação." | Volta à lista de aprovações |
| Aprovação inexistente, de outro tenant ou não visível | 404 | `APPROVAL_NOT_FOUND` | "Aprovação não encontrada." | Volta à lista; remove o item do cache |
| Unidade solicitante inválida (filtro herdado) | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione uma unidade válida." | Limpa o filtro |
| Banco indisponível ou consulta acima do teto | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar as aprovações agora." | Botão "Tentar novamente"; respeita `Retry-After` |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

Códigos de decisão (`APPROVAL_NOT_PENDING`, `APPROVAL_LINE_NOT_PENDING`, `NOT_DESIGNATED_APPROVER`, `SELF_APPROVAL_FORBIDDEN`) são produzidos por US-134; aqui aparecem apenas como `meta.decisionBlocker` para a tela explicar o estado antes da tentativa.

## Dependências
- **Stories:** US-056 (caixa de tarefas — `view=PENDING_APPROVALS`, TSK-01/TSK-02), US-057 (lista de aprovações — APV-01), US-134 (decisão e encerramento por linha — estados das linhas, `APPROVAL_LINE_NOT_PENDING`). Indiretas: US-133 (solicitação com várias linhas e rótulos), US-135 (redirecionamento e retirada — origem das linhas `CANCELED`), US-052 (detalhe APV-02 do MVP 1), US-190 (prazo por linha, `ApprovalApprover.dueAt`), US-125 (ramos paralelos na caixa — mesma tela SCR-013, sem sobreposição de colunas), US-106 (dias úteis).
- **Decisões/ADRs:** DEC-193, DEC-022, DEC-024, DEC-026, DEC-108, DEC-205 (prazo por linha); POL-03, POL-17, POL-09.
- **Configurações:** `approval.preventSelfApproval`, `deadlines.warnBeforeBusinessDays` (selo de prazo da caixa).
- **Lacunas nas fontes canônicas:**
  1. **Endpoint APV-31 e campos aditivos** (`progress`, `myLine`, `currentApprover`, `approvers[]`, `meta.lineActions`, `meta.waitingFor`, valor `LINE_NOT_PENDING` em `decisionBlocker`) não constam do catálogo de API do MVP 2 (ainda não escrito); serão consolidados no `api.md` do MVP 2 (card 9). O front fala em `GET /inbox/tasks` na feature; o contrato real do MVP 1 é `GET /tasks` (TSK-01), e é ele que esta story estende.
  2. **Migração M2-03** (view `v_inbox_pending_approvals` v2): `entities.md §10` a atribui ao FT-066 sem dizer a qual story; esta story é só consumidora e exige a migração aplicada e reconciliada. O coordenador deve confirmar o dono (US-133 ou US-134).
  3. **Cobertura de `ROLE` em linhas `WAITING`/`SKIPPED`:** `permissions.md` (POL-03) define apenas a decisão por linha; a regra de visibilidade na lista (RN-APV-66) é proposta nesta story.
  4. **Visibilidade da aprovação de assunto `PCA`** (sem processo): depende de `PCA_VIEW` e do EP-023; aqui só o contrato aceita `process` nulo.

## Impacto técnico
- **Compatibilidade (DEC-108):** tudo é aditivo. O ponto de risco é o leitor do MVP 1 que assume uma linha por `Approval` na caixa; a view v2 passa a devolver uma linha por `ApprovalApprover`, e o teste de contrato (RN-APV-74) é o gatilho para só ligar a v2 depois da reconciliação do backfill.
- **Consulta da caixa:** a perna de aprovações da UNION troca a tabela `approvals` por `approval_approvers` (`status = 'PENDING'`) com junção em `approvals` para título, prazo e política; usa os três índices parciais de entities.md §4.6. A meta de p95 < 500 ms por visão é medida na suíte de performance, não neste card.
- **Cobertura única:** `ApprovalCoverageFacade` deve expor `listCoveredLines(userId, { statuses })` e ser usada por caixa, lista e decisão (US-134), para que os três nunca divirjam; é o mesmo princípio recomendado na US-057.
- **Texto de andamento no servidor:** `progress.label` é montado no servidor para manter caixa, lista e detalhe com o mesmo texto e permitir futura tradução em um só lugar.
- **Rótulos sem dado sensível:** `label` da linha vem do `WorkflowStageApprover.label` ou do tipo; nunca de dados de orçamento.
- **Ramos paralelos:** a caixa já lê várias etapas ativas (US-125); esta story não altera essa perna, e uma aprovação de ramo aparece com o rótulo do ramo (`branchKey`) fornecido por US-125.

## Backend
- **Módulo(s):** `approval` (dono: view v2, `ListApprovalsQuery`, `GetApprovalQuery`, `ListApprovalApproversQuery`), `process` (consulta UNION da caixa, TSK-01/TSK-02), `access` (visibilidade DEC-024), `timeline` (sem alteração).
- **Casos de uso:** `GetTaskInboxQuery` e `GetTaskInboxCountersQuery` (estendidos); `ListApprovalsQuery` e `GetApprovalQuery` (estendidos); `ListApprovalApproversQuery` → `ListApprovalApproversHandler` (APV-31).
- **Domínio:** nenhuma entidade nova; leitura de `Approval` e `ApprovalApprover`; `ApprovalProgress` (value object que calcula `progress.label`); `ApprovalCoverageFacade.listCoveredLines`.
- **Integrações internas:** `DepartmentFacade.isHeadOrDeputy`, `AuthorizationService` (visibilidade e permissões consultadas), `v_inbox_processes` e `v_inbox_pending_approvals` v2 (views publicadas).
- **Transação:** leitura única por requisição, em uma instrução (lista e total no mesmo snapshot — RN-APV-64); sem efeitos colaterais, sem auditoria.

## Frontend
- **Tela(s):** SCR-013 (`/tarefas`), SCR-014 (`/aprovacoes`), SCR-015 (`/aprovacoes/[id]`, também em painel lateral a partir de SCR-006).
- **Componentes:** `InboxTable` (selo de andamento e prazo por linha), `ApprovalProgressBadge`, `ApprovalTable` (colunas "Andamento" e "Aprovador atual"), filtros "Política de decisão" e "Minha situação" no `FilterToolbar`, `ApprovalLinesPanel` (tabela/stepper com `ApprovalLineStatusBadge`), `ApprovalLinesHistory` (APV-31), `DecisionBlockerNotice` (explicação de `decisionBlocker`), `ApprovalDecisionPanel` (já existente — só aparece com `DECIDE`).
- **Estados:** skeleton por bloco; vazio por visão ("Nenhuma aprovação pendente com você. Você está em dia!"); erro com "Tentar novamente" e `correlationId`; banner "Esta aprovação foi encerrada" e "Esta aprovação foi atualizada por outro aprovador" em revalidação; linha em "atualizando…" ao reconsultar.
- **Acessibilidade e responsividade:** situação das linhas por texto e ícone; `aria-current="step"` na linha corrente; `aria-live="polite"` para mudança de vez e de encerramento; tabelas com cabeçalhos associados e cartões abaixo de 768 px; foco previsível ao abrir o histórico; contraste AA.

## Banco de dados
- **Tabelas:** leitura de `approvals`, `approval_approvers`, `approval_documents`, `processes`, `departments`, `process_stages`; nenhuma tabela nova.
- **Migrações:** nenhuma nesta story (a view v2 e o backfill são da M2-03, `entities.md §10`); esta story só passa a **ler** a view v2 em TSK-01/TSK-02.
- **Índices/constraints relevantes:** `(tenant_id, approver_user_id) WHERE status = 'PENDING'`, `(tenant_id, approver_department_id) WHERE status = 'PENDING'`, `(tenant_id, approver_role_id) WHERE status = 'PENDING'` e o unique `(tenant_id, approval_id, sequence) WHERE status <> 'CANCELED'` de `approval_approvers`; `(tenant_id, process_id, created_at DESC)` de `approvals`. Possível índice `(tenant_id, decided_by_id, decided_at DESC)` em `approval_approvers` para a cobertura "decididas por mim" de APV-01, a confirmar na carga de teste.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TSK-01` | GET | `/api/v1/tasks` | `?view=PENDING_APPROVALS&page=&pageSize=&sort=` (MVP 1) | `data[]` do MVP 1; em `PENDING_APPROVALS`, `id` = `approvalApproverId` e `approval { id, approvalApproverId, sequence, decisionPolicy, progress, title, subjectType, requestedBy, requestedAt, dueAt }` (aditivo); `process` nulo em assunto `PCA` | 200, 401, 403, 422, 429, 500, 503 |
| `TSK-02` | GET | `/api/v1/tasks/counters` | — | `pendingApprovals` passa a contar linhas `PENDING` (RN-APV-64) | 200, 401, 403, 429, 500, 503 |
| `APV-01` | GET | `/api/v1/approvals` | MVP 1 + `decisionPolicy`, `myLineStatus` | `data[]` do MVP 1 + `decisionPolicy`, `progress`, `myLine`, `currentApprover` (aditivo) | 200, 401, 422, 429, 503 |
| `APV-02` | GET | `/api/v1/approvals/{id}` | path `id` | `data` do MVP 1 + `decisionPolicy`, `approvers[]`; `meta` + `myApproverLineId`, `lineActions`, `waitingFor`; `decisionBlocker` + `LINE_NOT_PENDING`; `ETag` | 200, 401, 403, 404, 429, 503 |
| `APV-31` | GET | `/api/v1/approvals/{id}/approvers` | path `id`; query `includeHistory` (padrão `true`) | `200 { data: [{ id, sequence, label, approverType, status, activatedAt, dueAt, decision, decidedBy, decidedAt, decidedAsDeputy, decisionComment, reassignedFromId, skippedReason }], meta: { decisionPolicy, totalLines, approvalStatus } }`; `Cache-Control: no-store` | 200, 401, 403, 404, 422, 429, 503 |

Leituras: `Idempotency-Key` e `If-Match` não se aplicam. APV-31 usa a mesma autorização de APV-02 e não pagina (no máximo 20 linhas vigentes mais as substituídas — `WorkflowStageApprover.sequence` é 1..20).

## Logs
- `info` `inbox.query` — `view`, `resultCount`, `durationMs`, `tenantId`, `userId`, `correlationId` (já existente; passa a registrar `lines = true` na visão `PENDING_APPROVALS`).
- `info` `approvals.query` — forma dos filtros (inclui `decisionPolicy`, `myLineStatus`), `resultCount`, `durationMs`.
- `info` `approvals.lines_query` — `approvalId`, `includeHistory`, `linesCount`, `durationMs`.
- `warn` `inbox.slow_query` (> 500 ms); `warn` `idempotency.store_unavailable` (Redis indisponível, consulta segue no banco).
- `error` `inbox.query_failed` / `approvals.query_failed` / `approvals.lines_query_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** `decisionComment`, `requestComment`, título do processo, rótulos de linha, nomes de aprovadores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | Consultas (TSK-01, TSK-02, APV-01, APV-02, APV-31) são leituras e não geram auditoria | — |
| `access.denied` | `ACCESS` | Resposta 403 de APV-02/APV-31 | `metadata`: `reasonCode = APPROVAL_VIEW`, `approvalId` |

## Testes necessários
- **Unitários:** predicados da view v2 por tipo de cobertura (direto, `ROLE`, `DEPARTMENT_HEAD` + substituto); dedupe por `approvalApproverId`; `ApprovalProgress.label` por política e estado; escolha do prazo (linha → aprovação → etapa); mapeamento de `decisionBlocker`.
- **Integração (Testcontainers PostgreSQL):** `ALL` com 3 linhas (voto → some só da caixa do votante); `SEQUENTIAL` (ativação → entra na caixa); `ANY` com várias linhas; redirecionamento (histórico via APV-31); encerramento por decisão negativa (linhas `SKIPPED`); contador × lista no mesmo snapshot; backfill M2-03 × view v1 (mesmo resultado para `ANY`).
- **API/contrato:** campos aditivos conforme `api.md` do MVP 2; **teste de contrato do MVP 1** (JSON de TSK-01/APV-01/APV-02 de aprovação `ANY` de uma linha inalterado); `meta.decisionBlocker` com `LINE_NOT_PENDING`.
- **RBAC e multi-tenant:** linha de outro tenant nunca aparece (suíte "tenant leak": `approval_approvers`, view v2 e APV-31); `ROLE` com escopo que não cobre a unidade solicitante não vê a linha; 403 e 404 conforme V-05/V-06.
- **Concorrência:** decisão de outro aprovador entre a listagem e a revalidação; ativação da linha seguinte durante o polling.
- **E2E (Playwright):** jornada `ALL` (duas pessoas, contador e selo), jornada `SEQUENTIAL` (vez passada), detalhe com bloqueio explicado, histórico com linha substituída.
- **Acessibilidade/performance:** axe sem violações sérias em `ApprovalLinesPanel` e no selo de andamento; 360 px; teste de performance (suíte própria) com tenant de 10.000 processos ativos e 2.000 aprovações pendentes → p95 < 500 ms por visão.

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
- [ ] Teste de contrato prova que a aprovação do MVP 1 (`ANY`, uma linha) responde igual em TSK-01, APV-01 e APV-02
- [ ] Contador `pendingApprovals` e lista da visão comprovadamente consistentes (mesmo snapshot) com linhas `ALL`/`SEQUENTIAL`
- [ ] Nenhuma linha `WAITING`, `SKIPPED` ou `CANCELED` vaza para a caixa (teste de integração)

## Estimativa
**M** — não há tabela nem comando novo: o esforço está na troca da perna de aprovações da UNION para a view v2 sem regressão do MVP 1, nos campos aditivos de lista e detalhe, no endpoint de histórico e nas telas de linhas e de bloqueio explicado.

## Prioridade
**P0** — sem esta story o solicitante e os aprovadores não enxergam a vez nem os votos, e a caixa de tarefas deixaria de refletir a aprovação múltipla; é um dos cinco primeiros cards do DT-03 (DEC-192) e precede a liberação do FT-066.
