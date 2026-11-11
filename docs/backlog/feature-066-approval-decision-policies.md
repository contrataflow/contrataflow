---
id: FT-066
title: "Políticas de decisão com múltiplos aprovadores"
epic: EP-022
mvp: 2
priority: P0
stories: [US-132, US-133, US-134, US-135, US-136]
status: Especificada
---

# FT-066 — Políticas de decisão com múltiplos aprovadores

## Título
Políticas de decisão com múltiplos aprovadores

## Épico
EP-022 — Aprovação múltipla

## Descrição
Resolve a PEND-13 (DEC-193): a aprovação ganha `decisionPolicy` (`ANY`, `ALL`, `SEQUENTIAL`) e uma linha `ApprovalApprover` por aprovador. Em `ANY` qualquer aprovador habilitado decide (comportamento do MVP 1, inalterado); em `ALL` todas as linhas ficam `PENDING` e todas precisam aprovar; em `SEQUENTIAL` só a linha corrente está `PENDING` e a vez passa de uma para a próxima. A primeira decisão negativa encerra a aprovação em `ALL` e `SEQUENTIAL`.

O administrador configura a política e a lista ordenada de aprovadores (`WorkflowStageApprover`) na etapa `APPROVAL`. O solicitante vê cada linha; o aprovador decide a sua; o gestor com `PROCESS_ASSIGN` redireciona uma linha ainda não decidida ou retira a aprovação inteira. As decisões são serializadas por trava de linha e a segregação de funções vale por linha.

## Valor para o usuário e para o órgão
- Ritos com mais de uma decisão (ex.: Secretário e Procurador, cadeia hierárquica) passam a ser impostos pelo sistema, com ordem e rastro.
- Ninguém aprova duas vezes, ninguém aprova o próprio documento e a decisão final é inequívoca mesmo com cliques simultâneos.
- O solicitante sabe quem já votou e de quem é a vez.

## Personas
- Autoridade competente (`AUTORIDADE_COMPETENTE`) — decide a sua linha (`APPROVAL_DECIDE`).
- Aprovador ou substituto — decide se estiver designado e elegível.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — redireciona linha e retira aprovação (`PROCESS_ASSIGN`).
- Administrador do órgão (`ADMIN_ORGAO`) — configura política e aprovadores da etapa.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-132 ⏳ | Configurar política de decisão e aprovadores ordenados na etapa | P0 | M | US-040, US-043, US-045 |
| US-133 ⏳ | Solicitar aprovação com múltiplos aprovadores | P0 | L | US-051, US-132 |
| US-134 ⏳ | Decidir aprovação múltipla: votos, encerramento e concorrência | P0 | L | US-052, US-133 |
| US-135 ⏳ | Redirecionar linha de aprovação e retirar aprovação múltipla | P0 | M | US-053, US-134 |
| US-136 ⏳ | Aprovação múltipla na caixa de tarefas, na lista e no detalhe da aprovação | P0 | M | US-056, US-057, US-134 |

## Escopo
- `WorkflowStage.decisionPolicy`, `WorkflowStageApprover` (1..20 linhas), validação `WF_APPROVERS_INVALID` na publicação.
- `Approval.decisionPolicy`, `ApprovalApprover`, backfill das aprovações existentes e view `v_inbox_pending_approvals` v2.
- Decisão por linha com votos (`ApprovalVoteRecorded`), vez do próximo (`ApprovalApproverActivated`), encerramento, concorrência e `onDecision` só no encerramento.
- Redirecionar linha, retirar aprovação inteira, substituto por linha e segregação de funções por linha.
- Caixa de tarefas só para linha `PENDING`; lista e detalhe com linhas, votos e ordem; `ProcessAccess` `APPROVER` por linha.

## Fora de escopo
- Quórum, voto de minerva e retirada de voto já dado.
- Alçada por valor e política por faixa — EP-031 (US-198).
- Prazo por linha por política de SLA — EP-030.
- Aprovação do PCA — EP-023 (reutiliza esta mecânica).

## Regras de negócio da feature
- RN-APV-01 — `ANY`: qualquer aprovador habilitado decide pelo conjunto; com um aprovador, o comportamento do MVP 1 é idêntico e as aprovações existentes migram com uma linha `ApprovalApprover` (DEC-193).
- RN-APV-02 — `ALL`: todas as linhas `PENDING` ao mesmo tempo; `APPROVED` só quando todas aprovam; a primeira decisão negativa encerra (`RETURNED` ou `REJECTED`) e as demais ficam `SKIPPED` (DEC-193).
- RN-APV-03 — `SEQUENTIAL`: ordem por `sequence`; só a linha corrente `PENDING`, as seguintes `WAITING` e fora da caixa de tarefas; aprovar ativa a próxima; decisão negativa encerra como em `ALL` (DEC-193).
- RN-APV-04 — decisões sobre a mesma aprovação são serializadas por `SELECT … FOR UPDATE`; vale a primeira que efetivar, e a segunda recebe `APPROVAL_NOT_PENDING` (409) ou, em `ALL`, `APPROVAL_LINE_NOT_PENDING` (409); sem quórum nem voto de minerva (DEC-193, POL-03).
- RN-APV-05 — decisão registrada é imutável; redirecionar só vale para linha ainda não decidida e cria nova linha com o mesmo `sequence` e `reassignedFromId`; retirar cancela a aprovação inteira e todas as linhas não decididas (DEC-193, POL-17).
- RN-APV-06 — devolução depois de votos favoráveis encerra a aprovação mantendo os votos no histórico; reenviar cria nova `Approval` com todas as linhas de novo (DEC-193).
- RN-APV-07 — `approval.preventSelfApproval` vale por linha: se a resolução cair no autor de um documento coberto, a linha vai ao substituto e, sem substituto, a solicitação falha com `SELF_APPROVAL_FORBIDDEN` (DEC-193, art. 7º, § 1º).
- RN-APV-08 — etapa `APPROVAL` com política `ALL` ou `SEQUENTIAL` exige ao menos duas linhas; violação recusa a publicação com `WF_APPROVERS_INVALID` (DEC-193, entities §4.6).
- RN-APV-09 — o processo fica `AWAITING_APPROVAL` até a decisão final; cada aprovador de linha ganha `ProcessAccess` `APPROVER`; `Approval.dueAt` vale para o conjunto (DEC-193).

## Telas
- SCR-034 — Workflow, ampliado (política de decisão e aprovadores ordenados) (`/admin/workflows/[id]`)
- SCR-013 — Caixa de tarefas, ampliada (só linhas `PENDING`) (`/tarefas`)
- SCR-014 — Aprovações, ampliada (política e progresso) (`/aprovacoes`)
- SCR-015 — Detalhe da aprovação, ampliado (linhas, votos, redirecionar, retirar) (`/aprovacoes/[id]`)

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `PUT /workflows/{id}/versions/{versionId}/stages/{stageId}/approvers` — definir política e aprovadores ordenados da etapa
- `POST /processes/{id}/approvals` — solicitar aprovação (estende a solicitação do MVP 1 para várias linhas)
- `POST /approvals/{id}/decision` — decidir a linha do usuário (estende a decisão do MVP 1)
- `POST /approvals/{id}/approvers/{approverId}/reassign` — redirecionar linha ainda não decidida
- `POST /approvals/{id}/withdraw` — retirar a aprovação inteira
- `GET /approvals/{id}` — detalhe com `decisionPolicy` e linhas (aditivo)
- `GET /inbox/tasks` — caixa de tarefas lendo a view v2

## Entidades
- `ApprovalApprover` — linha por aprovador, fonte de verdade de quem decide.
- `WorkflowStageApprover` — lista ordenada na definição da etapa.
- `Approval` — `decisionPolicy`; colunas de aprovador espelham a linha corrente.
- `WorkflowStage` — `decisionPolicy`, `decisionPolicyRules`.
- `ProcessAccess` — `USER/APPROVER` por linha.

## Eventos
- `ApprovalRequested` (MVP 1) — uma linha `PENDING` por aprovador.
- `ApprovalVoteRecorded` — decisão positiva que não encerra.
- `ApprovalApproverActivated` — `SEQUENTIAL`: próxima linha passa a `PENDING`.
- `ApprovalReassigned` (MVP 1) — agora por linha.

## Permissões
- `APPROVAL_DECIDE` — decidir a própria linha.
- `APPROVAL_REASSIGN` — redirecionar linha.
- `PROCESS_ASSIGN` — retirar a aprovação inteira.
- `APPROVAL_VIEW` — consultar linhas e votos.
- `WORKFLOW_MANAGE` — configurar política e aprovadores.

## Dependências
- Stories: US-040, US-043, US-045 (workflow); US-051, US-052, US-053 (aprovações do MVP 1); US-056, US-057 (caixa e lista).
- Decisões: DEC-193, DEC-022, POL-03, POL-17; migrações M2-02 e M2-03.
- Habilita EP-023 (PCA), EP-031 (alçadas, US-198 depende de US-133).

## Critérios de aceite da feature
```gherkin
Feature: Políticas de decisão com múltiplos aprovadores
  Scenario: Aprovação sequencial passa a vez e conclui
    Given uma etapa "APPROVAL" com política "SEQUENTIAL" e dois aprovadores ordenados
    When o solicitante pedir a aprovação
    Then só a linha 1 está "PENDING" e a linha 2 está "WAITING", fora da caixa de tarefas
    When o aprovador 1 aprovar
    Then o evento "ApprovalApproverActivated" ativa a linha 2
    When o aprovador 2 aprovar
    Then a aprovação é "APPROVED" e o processo segue

  Scenario: Decisão negativa em ALL encerra a aprovação
    Given uma aprovação "ALL" com três linhas "PENDING" e um voto favorável já dado
    When um aprovador devolver com comentário de ao menos 10 caracteres
    Then a aprovação é "RETURNED", as linhas restantes ficam "SKIPPED" e o voto favorável permanece no histórico

  Scenario: Decisões simultâneas e redirecionamento
    Given uma aprovação "ALL" com duas linhas "PENDING"
    When dois aprovadores decidirem a mesma linha ao mesmo tempo
    Then só a primeira efetiva e a segunda recebe "APPROVAL_LINE_NOT_PENDING"
    When o gestor redirecionar a linha ainda não decidida para outro aprovador elegível
    Then a linha antiga fica "CANCELED" por "REASSIGNED" e a nova assume o mesmo "sequence"
```

## Métricas de sucesso
- 0 aprovações com dupla decisão da mesma linha ou estado inconsistente (teste de invariante).
- 100% das aprovações do MVP 1 com comportamento idêntico após o backfill.

## Riscos
- Corrida entre decisões — trava de linha e 409 explícito.
- Leitores do MVP 1 sobre colunas de aprovador — espelho da linha corrente na fase expand.
- Linha sem aprovador elegível — substituto por linha e falha explícita `SELF_APPROVAL_FORBIDDEN` / `APPROVER_NOT_ELIGIBLE`.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
