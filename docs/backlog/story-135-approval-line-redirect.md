---
id: US-135
title: "Redirecionar linha de aprovação e retirar aprovação múltipla"
epic: EP-022
feature: FT-066
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-053, US-134]
modules: [approval, process, document, access, timeline, notification, audit, platform]
screens: [SCR-015]
endpoints: [APV-06, APV-04, APV-05]
permissions: [APPROVAL_REASSIGN, PROCESS_ASSIGN, PROCESS_FORWARD]
events: [ApprovalReassigned, ApprovalCanceled, ProcessStageChanged]
---

# US-135 — Redirecionar linha de aprovação e retirar aprovação múltipla

## Título
Redirecionar uma linha ainda não decidida para outro aprovador e retirar a aprovação inteira, preservando os votos já dados

## Descrição
**Como** gestor de contratações (e **como** quem encaminhou o processo), **quero** trocar o aprovador de uma linha que ainda não decidiu — por ausência, impedimento ou conflito de interesse — e, se preciso, retirar a aprovação inteira, **para** destravar uma aprovação múltipla sem perder os votos já registrados e sem esperar a decisão do aprovador original.

A story estende a US-053 à aprovação com várias linhas: o **redirecionamento passa a agir por linha** (`POST /approvals/{id}/approvers/{approverId}/reassign`, APV-06), com a linha antiga cancelada (`REASSIGNED`) e uma nova de mesma `sequence` (`reassignedFromId`); a **retirada** (APV-04) cancela a aprovação inteira e todas as linhas não decididas, mantendo no histórico as linhas já decididas ("não se retira voto"), e passa a poder ser feita também pelo gestor com `PROCESS_ASSIGN` no escopo. O redirecionamento do MVP 1 (APV-05) continua válido para aprovações de uma só linha.

## Contexto
- DEC-193: "o gestor com `PROCESS_ASSIGN` no escopo pode retirar a aprovação inteira (`CANCELED`, como na DEC-022) ou **redirecionar uma linha ainda não decidida** para outro aprovador elegível — o redirecionamento do MVP 1 (APV-05, `APPROVER_NOT_ELIGIBLE`) passa a agir por linha. Decisão já registrada é imutável — não se retira voto. Substituto vale por linha."
- POL-17 (MVP 2): retirar cancela a aprovação inteira e todas as linhas não decididas; não há retirada de voto já dado; redirecionar (`APPROVAL_REASSIGN`) age por linha ainda não decidida. No MVP 1 a retirada era de quem encaminhou (`PROCESS_FORWARD` + custódia anterior, RN-TRAM-64).
- Entities MVP 2 §4.6: "redirecionar = marcar a linha `CANCELED` (`skippedReason = REASSIGNED`) e criar outra com o mesmo `sequence` e `reassignedFromId`"; linha decidida é imutável por gatilho.
- Devolução depois de votos favoráveis encerra a aprovação mantendo os votos no histórico; reenviar cria nova `Approval` com todas as linhas de novo (US-133, FA-05). O mesmo vale depois de uma retirada.
- A segregação de funções (art. 7º, § 1º, `approval.preventSelfApproval`) vale para o novo aprovador de cada linha.

## Objetivo
Permitir redirecionar uma linha ou retirar a aprovação em menos de 1 minuto, sem perda de votos, documentos, prazo (`dueAt`) ou histórico, e sem que a troca de aprovador gere pessoa repetida, autoaprovação ou linha órfã.

## Persona
- **Principal (redirecionamento):** Gestor de contratações (`GESTOR_CONTRATACOES`, com `APPROVAL_REASSIGN`) ou titular/substituto da unidade com a permissão por perfil.
- **Principal (retirada):** quem encaminhou o processo ou submeteu o documento (`PROCESS_FORWARD`/permissão de submissão) ou o gestor com `PROCESS_ASSIGN` no escopo do processo.
- **Secundárias:** novo aprovador da linha (recebe a pendência); aprovador anterior (é avisado); solicitante e Controle Interno (conferem o rastro).

## Pré-condições
- Existe `Approval` `PENDING` visível ao usuário, com a linha-alvo em `PENDING` ou `WAITING`.
- Para redirecionar: `APPROVAL_REASSIGN` com escopo que cubra o processo.
- Para retirar: `PROCESS_FORWARD` com custódia anterior ou autoria da solicitação (RN-TRAM-64, POL-17), **ou** `PROCESS_ASSIGN` com escopo que cubra o processo.
- Processo não está `SUSPENDED` nem em status final.

## Fluxo principal
1. Na SCR-015, o gestor localiza a linha ainda não decidida (`PENDING` ou `WAITING`) e aciona "Redirecionar esta linha".
2. No diálogo escolhe o **novo aprovador** (tipo `USER`, `ROLE` ou `DEPARTMENT_HEAD` e o alvo, com busca assíncrona de elegíveis) e informa o **motivo** (≥ 10 caracteres, ex.: "Titular em licença médica").
3. O front envia `POST /approvals/{id}/approvers/{approverId}/reassign` (APV-06) com `Idempotency-Key` e `If-Match` da linha.
4. A API, em uma transação com `app.tenant_id`: trava a `Approval` (`FOR UPDATE`), confere que está `PENDING` e que a linha está `PENDING` ou `WAITING`, valida `If-Match`, autoriza (`APPROVAL_REASSIGN` no escopo) e verifica a elegibilidade do novo aprovador (RN-APV-53).
5. Marca a linha antiga `CANCELED` (`skippedReason = REASSIGNED`), cria a nova linha com o **mesmo `sequence`**, `reassignedFromId`, o mesmo estado (`PENDING`/`WAITING`) e o mesmo `activatedAt` e `dueAt`; atualiza o espelho da `Approval` se a linha era a corrente; revoga o `ProcessAccess` `APPROVER` da linha antiga e concede o da nova; grava auditoria, timeline e o evento `ApprovalReassigned`.
6. A API responde 200 com a aprovação (linhas atualizadas). O front invalida as consultas da aprovação, do processo e da caixa de tarefas e mostra "Linha redirecionada para {nome}."
7. **Retirar:** o solicitante ou o gestor aciona "Retirar aprovação" (menu "Mais ações"); o diálogo explica: "A aprovação inteira será cancelada. Os votos já dados ficam no histórico e o processo voltará para a etapa anterior. Será preciso solicitar a aprovação de novo." O front envia `POST /approvals/{id}/withdraw` (APV-04) com `Idempotency-Key`, `If-Match` e motivo opcional.
8. A API cancela a `Approval` (`CANCELED`, `cancellationReason = WITHDRAWN`) e **todas as linhas não decididas** (`CANCELED`, `skippedReason = WITHDRAWN`), mantém as linhas já decididas e aplica os efeitos da US-053 (documentos, etapa, status `RETURNED`, movimento `RETURN` com `metadata.withdrawn`), com `ApprovalCanceled` e `ProcessStageChanged`.
9. Para seguir, quem tem a custódia corrige o que for preciso e encaminha de novo: a US-133 cria nova `Approval` com todas as linhas.

## Fluxos alternativos
- **FA-01 — Aprovação de uma linha (compatibilidade):** `POST /approvals/{id}/reassign` (APV-05) age sobre a única linha `PENDING`; em aprovação com mais de uma linha responde `APPROVAL_LINE_REQUIRED`, orientando a usar APV-06.
- **FA-02 — Linha `WAITING`:** em `SEQUENTIAL` a linha ainda não ativada pode ser redirecionada; o novo aprovador é avisado e só recebe a pendência quando a linha for ativada (US-134).
- **FA-03 — Linha de `ALL` com votos de outras:** o redirecionamento não afeta os votos já dados nem o estado das demais linhas.
- **FA-04 — Linha já decidida, pulada ou cancelada:** `APPROVAL_LINE_NOT_PENDING` (409); o voto registrado é imutável.
- **FA-05 — Novo aprovador inelegível:** igual ao atual, sem vínculo ativo, perfil sem detentor, unidade sem titular → `APPROVER_NOT_ELIGIBLE`; autor de documento coberto → `SELF_APPROVAL_FORBIDDEN`; já ocupa ou ocupou outra linha desta aprovação → `APPROVER_DUPLICATED`.
- **FA-06 — Retirada com votos favoráveis:** a aprovação é cancelada, as linhas `APPROVED` permanecem no histórico e não são reaproveitadas na nova solicitação.
- **FA-07 — Retirada de submissão avulsa:** pelo DOC-11 (US-053), com o mesmo cancelamento das linhas não decididas; sem mudança de contrato.
- **FA-08 — Decisão simultânea:** se o aprovador decidir antes do redirecionamento, a linha já está decidida (409); se o redirecionamento vier antes, a decisão com o id da linha antiga recebe 409 (US-134, RN-APV-40).
- **FA-09 — Retirada simultânea a um voto:** vale o primeiro a efetivar; o outro recebe `APPROVAL_NOT_PENDING`.

## Regras de negócio
- **RN-APV-51** — Redirecionar só vale para linha `PENDING` ou `WAITING` de `Approval` `PENDING`; linha com decisão (`APPROVED`, `RETURNED`, `REJECTED`), `SKIPPED` ou `CANCELED` → `APPROVAL_LINE_NOT_PENDING` (409); `Approval` não `PENDING` → `APPROVAL_NOT_PENDING` (409). Exige `APPROVAL_REASSIGN` com escopo que cubra o processo (POL-17). Voto registrado é imutável (gatilho): não se troca nem se retira voto.
- **RN-APV-52** — Mecanismo: a linha antiga vira `CANCELED` (`skippedReason = REASSIGNED`) e nasce uma linha nova com o mesmo `sequence`, `reassignedFromId` apontando para a antiga, o mesmo estado e o mesmo `activatedAt` e `dueAt` (o prazo não recomeça); `Approval.title`, `Approval.dueAt`, `requestedById`, `requestedAt`, a política e os `ApprovalDocument` são preservados (RN-TRAM-70); o espelho da `Approval` é atualizado se a linha era a corrente (ou a primeira); o gatilho `UNIQUE (…, sequence) WHERE status <> 'CANCELED'` garante uma linha ativa por posição.
- **RN-APV-53** — Elegibilidade do novo aprovador, por linha (RN-TRAM-69): `USER` com vínculo `ACTIVE`; `ROLE` ativo com `APPROVAL_DECIDE` e ao menos um detentor com atribuição cobrindo a unidade solicitante; `DEPARTMENT_HEAD` = titular atual ativo da unidade (com `allowDeputy = true`); diferente do aprovador atual da linha (`APPROVER_NOT_ELIGIBLE`); com `approval.preventSelfApproval`, não pode ser autor de versão coberta (`SELF_APPROVAL_FORBIDDEN`) — para `DEPARTMENT_HEAD` autor, vale a regra do substituto da RN-APV-20; não pode ocupar nem ter ocupado outra linha da mesma aprovação (`APPROVER_DUPLICATED`, "ninguém aprova duas vezes").
- **RN-APV-54** — Acesso: o `ProcessAccess` `USER/APPROVER` com `sourceId` igual à linha antiga é revogado e o da linha nova é concedido (e o do substituto, se `allowDeputy`; `DEPARTMENT/CURRENT` para linha `ROLE`); o aprovador anterior deixa de ver a pendência na caixa de tarefas imediatamente.
- **RN-APV-55** — Motivo: no redirecionamento é obrigatório (≥ 10 e ≤ 2.000 caracteres) e **não é persistido nem publicado** (só `hasReason` em auditoria e evento); na retirada é opcional (≤ 2.000) e vira o comentário do movimento `RETURN` (sem motivo, vale o texto fixo da US-053).
- **RN-APV-56** — Quem pode retirar (APV-04): (a) o solicitante (`requestedById`) ou quem tem a custódia anterior à entrada na etapa, com `PROCESS_FORWARD` no escopo dessa unidade (RN-TRAM-64, POL-17 do MVP 1); **ou** (b) o gestor com `PROCESS_ASSIGN` com escopo `TENANT`/`ORGANIZATION` que cubra o processo (DEC-193). Retirada de submissão avulsa (DOC-11) segue a US-053.
- **RN-APV-57** — Efeitos da retirada (estende RN-TRAM-66 a RN-TRAM-68): `Approval` `CANCELED` (`cancellationReason = WITHDRAWN`, `canceledById`, `canceledAt`); **todas** as linhas não decididas (`PENDING`/`WAITING`) viram `CANCELED` (`skippedReason = WITHDRAWN`); linhas já decididas permanecem como estão, com os votos no histórico; `pendingApprovalId` dos documentos é limpo e `IN_REVIEW` volta a `DRAFT` (DEC-018); a etapa de aprovação é encerrada, o processo volta à etapa de origem com status `RETURNED` e `ProcessMovement` `RETURN` com `metadata.withdrawn = true`; os acessos `APPROVER` das linhas canceladas são revogados.
- **RN-APV-58** — Reenvio depois da retirada: nova solicitação cria nova `Approval` com **todas** as linhas de novo (US-133, FA-05); votos de aprovações canceladas nunca são reaproveitados.
- **RN-APV-59** — Concorrência e ETag: toda operação trava a `Approval` (`FOR UPDATE`) e depois as linhas; ordem das verificações: `Approval` não `PENDING` → `APPROVAL_NOT_PENDING`; linha não `PENDING`/`WAITING` → `APPROVAL_LINE_NOT_PENDING`; `If-Match`. APV-06 usa a ETag da **linha** (`approvers[].version` de APV-02); APV-04 usa a ETag da `Approval` (qualquer voto a invalida, para o gestor revisar o que está retirando); `Idempotency-Key` obrigatório (DEC-105).
- **RN-APV-60** — Compatibilidade e rastro: APV-05 (MVP 1) continua para aprovação de uma linha `PENDING` e aplica a mesma lógica da linha; com mais de uma linha → `APPROVAL_LINE_REQUIRED` (422). `ApprovalReassigned` (MVP 1) ganha `approvalApproverId` e `sequence` (aditivo); `ApprovalCanceled` usa `reason = WITHDRAWN`; notificações `APPROVAL_REASSIGNED` (novo e anterior) e `PROCESS_RETURNED` (retirada de etapa), timeline `APPROVAL_REASSIGNED`/`APPROVAL_CANCELED`; nunca se notifica o próprio ator.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo do novo aprovador | `approverType` | `ApproverType` | Sim | `USER`, `ROLE`, `DEPARTMENT_HEAD` | — |
| Novo aprovador (usuário) | `targetApproverUserId` | uuid | Se `USER` | RN-APV-53 | busca `USR-02` |
| Novo aprovador (perfil) | `targetApproverRoleId` | uuid | Se `ROLE` | RN-APV-53 | busca `ROL-02` |
| Novo aprovador (unidade) | `targetApproverDepartmentId` | uuid | Se `DEPARTMENT_HEAD` | titular atual ativo | busca `DEP-02` |
| Motivo do redirecionamento | `reason` | texto longo | Sim | ≥ 10 e ≤ 2.000; não persistido | — |
| Motivo da retirada | `reason` | texto longo | Não | ≤ 2.000 | texto fixo da US-053 |
| Linha | `{approverId}` (rota) | uuid | Sim | linha da aprovação | `approvers[].id` |
| Versão da linha / da aprovação | `If-Match` | ETag | Sim | linha (APV-06) / `Approval` (APV-04) | APV-02 |
| Chave de idempotência | `Idempotency-Key` | UUID (cabeçalho) | Sim | DEC-105 | gerada pelo front |
| *(sistema)* Linha de origem | `reassignedFromId` | uuid | — | preenchido na linha nova | servidor |
| *(sistema)* Motivo de salto | `skippedReason` | texto (40) | — | `REASSIGNED` / `WITHDRAWN` | servidor |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Motivo do redirecionamento ausente ou curto | Front + API | "Informe o motivo do redirecionamento (mín. 10 caracteres)." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-02 | Alvo incompatível com o tipo (exatamente um `targetApprover*`) | Front + API (Zod) | "Selecione o novo aprovador." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`NOT_ALLOWED`) |
| V-03 | Novo aprovador igual ao atual ou inelegível | API | "Selecione um aprovador diferente e elegível para este processo." | `APPROVER_NOT_ELIGIBLE` |
| V-04 | Novo aprovador violaria a segregação de funções | API | "Este usuário não pode aprovar por ser autor de um dos documentos." | `SELF_APPROVAL_FORBIDDEN` |
| V-05 | Novo aprovador já ocupa ou ocupou outra linha desta aprovação | API | "Esta pessoa já participa desta aprovação em outra linha." | `APPROVER_DUPLICATED` |
| V-06 | `Approval` não está `PENDING` | API | "Esta aprovação já foi decidida ou retirada." | `APPROVAL_NOT_PENDING` |
| V-07 | Linha já decidida, pulada ou cancelada | API | "Esta linha já foi decidida e não pode ser redirecionada." | `APPROVAL_LINE_NOT_PENDING` |
| V-08 | APV-05 em aprovação com mais de uma linha | API | "Esta aprovação tem vários aprovadores. Redirecione a linha desejada." | `APPROVAL_LINE_REQUIRED` |
| V-09 | Usuário sem permissão ou sem custódia/escopo para retirar | API | "Você não pode retirar esta aprovação." | `PERMISSION_DENIED` |
| V-10 | `reason` da retirada acima de 2.000 caracteres | Front + API | "O motivo deve ter até 2.000 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-11 | `If-Match` ausente / divergente | API | "A aprovação foi alterada. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** redirecionar: `APPROVAL_REASSIGN` (risco `M`, escopável); retirar: `PROCESS_FORWARD` (custódia anterior ou autoria da solicitação, POL-17) **ou** `PROCESS_ASSIGN` com escopo que cubra o processo (DEC-193). Retirada de submissão avulsa: permissão de submissão do tipo (US-053).
- **Políticas:** POL-17 (retirar cancela a aprovação inteira e todas as linhas não decididas; sem retirada de voto; redirecionar por linha); POL-03/DEC-022 (elegibilidade e segregação do novo aprovador); POL-05 (escopo de `PROCESS_ASSIGN`).
- **MFA:** não exigido por padrão (`PROCESS_FORWARD`, `PROCESS_ASSIGN` e `APPROVAL_REASSIGN` são risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Redirecionar" e "Retirar" ocultos para quem não pode; a API responde 403 `PERMISSION_DENIED` e registra `access.denied` (`reasonCode`, `approvalId`, `approvalApproverId?`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalReassigned` | `approval.reassigned` | Redirecionamento de linha (APV-06) ou da linha única (APV-05) | MVP 1 + `approvalApproverId` (linha nova) e `sequence`; `fromApprover*`, `toApprover*`, `allowDeputy`, `hasReason` (nunca o motivo) |
| `ApprovalCanceled` | `approval.canceled` | Retirada (APV-04 ou DOC-11) | `reason = WITHDRAWN` |
| `ProcessStageChanged` | `process.stage_changed.return` | Retirada de aprovação de etapa | `cause = RETURN`, `approvalId` preenchido |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_REASSIGNED` | Novo aprovador da linha e aprovador anterior (titular + substituto, se houver) | in-app + e-mail | `ApprovalReassigned` |
| `PROCESS_RETURNED` | Responsável de destino (ou `PREVIOUS_ASSIGNEE`); senão, membros da unidade | in-app + e-mail | Retirada de aprovação de etapa |
| — | — | — | Retirada de submissão avulsa (DOC-11) não tem tipo de notificação dedicado (MVP 1) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Redirecionar linha de aprovação e retirar aprovação múltipla

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0012/2026" está em "AUTORIZACAO_LICITACAO" com status "AWAITING_APPROVAL"
    And a aprovação "SEQUENTIAL" tem a linha 1 de "Roberto" "APPROVED", a linha 2 de "Marcos" "PENDING" com "dueAt" "2026-12-10" e a linha 3 de "Paula" "WAITING"
    And "Ana" encaminhou o processo para esta aprovação
    And "Marta" tem o perfil "GESTOR_CONTRATACOES" com "APPROVAL_REASSIGN" e "PROCESS_ASSIGN" cobrindo o processo

  Scenario: [Sucesso] Redirecionar a linha pendente preservando prazo, ordem e votos
    When "Marta" redirecionar a linha 2 para o usuário "Diego" com o motivo "Marcos está de licença médica"
    Then a linha 2 de "Marcos" deve ficar "CANCELED" com "skippedReason" "REASSIGNED"
    And deve existir uma nova linha de "sequence" 2 "PENDING" de "Diego" com "reassignedFromId" da linha antiga e "dueAt" "2026-12-10"
    And a linha 1 de "Roberto" deve continuar "APPROVED"
    And "Marcos" deve perder o acesso "APPROVER" e "Diego" deve ganhá-lo
    And deve gerar registro de auditoria "approval.reassign" com "approvalApproverId" da linha nova e "hasReason" verdadeiro
    And deve gerar o evento "ApprovalReassigned" com "sequence" 2 e as notificações "APPROVAL_REASSIGNED" para "Diego" e "Marcos"

  Scenario: [Sucesso] Redirecionar uma linha ainda em espera
    When "Marta" redirecionar a linha 3 de "Paula" para o perfil "AUTORIDADE_COMPETENTE" com o motivo "Paula será substituída no rito"
    Then a nova linha 3 deve nascer "WAITING" e a antiga deve ficar "CANCELED" por "REASSIGNED"
    And a nova aprovadora não deve receber "APPROVAL_REQUESTED" até a linha ser ativada

  Scenario: [Sucesso] Retirar a aprovação inteira com voto favorável já dado
    When "Marta" retirar a aprovação com o motivo "Edital precisa de nova análise de riscos"
    Then a aprovação deve ficar "CANCELED" com "cancellationReason" "WITHDRAWN"
    And a linha 1 de "Roberto" deve permanecer "APPROVED" no histórico
    And as linhas 2 e 3 devem ficar "CANCELED" com "skippedReason" "WITHDRAWN"
    And o documento "ED 0003/2026" deve voltar para "DRAFT" e o processo para a etapa de origem com status "RETURNED"
    And deve gerar registro de auditoria "approval.withdraw" e os eventos "ApprovalCanceled" e "ProcessStageChanged"
    And "Ana" deve ser a responsável pela etapa de origem

  Scenario: [Sucesso] Quem encaminhou também retira, sem PROCESS_ASSIGN
    Given que "Ana" tem "PROCESS_FORWARD" e foi quem encaminhou o processo
    When "Ana" retirar a aprovação
    Then a aprovação deve ficar "CANCELED" e o processo deve voltar para "Ana"

  Scenario: [Validação] Motivo curto, aprovador igual e linha já decidida
    When "Marta" redirecionar a linha 2 sem motivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" no campo "reason"
    When "Marta" redirecionar a linha 2 para "Marcos" com um motivo válido
    Then a API deve responder 422 com código "APPROVER_NOT_ELIGIBLE"
    When "Marta" redirecionar a linha 1 de "Roberto"
    Then a API deve responder 409 com código "APPROVAL_LINE_NOT_PENDING"
    And o voto de "Roberto" deve permanecer "APPROVED"

  Scenario: [Validação] Novo aprovador autor do documento ou já presente em outra linha
    Given que "Elisa" é autora de uma versão do "EDITAL"
    When "Marta" redirecionar a linha 2 para "Elisa"
    Then a API deve responder 403 com código "SELF_APPROVAL_FORBIDDEN"
    When "Marta" redirecionar a linha 2 para "Roberto", que votou na linha 1
    Then a API deve responder 422 com código "APPROVER_DUPLICATED"

  Scenario: [Permissão] Gestor fora do escopo e usuário sem custódia
    Given que "Bruno" não encaminhou o processo, não pertence à unidade de origem e não tem "PROCESS_ASSIGN"
    When "Bruno" tentar retirar a aprovação
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Cléber" tem "APPROVAL_REASSIGN" apenas para outra secretaria
    When "Cléber" tentar redirecionar a linha 2
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Aprovação e aprovador de outro tenant
    Given que existe uma aprovação "PENDING" no tenant "Prefeitura B"
    When "Marta", no tenant "Prefeitura A", tentar redirecionar uma linha dessa aprovação
    Then a API deve responder 404 com código "APPROVAL_NOT_FOUND"
    When "Marta" informar como novo aprovador um usuário do tenant "Prefeitura B"
    Then a API deve responder 422 com código "APPROVER_NOT_ELIGIBLE"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio do redirecionamento e segunda retirada
    Given que "Marta" redirecionou a linha 2 com "Idempotency-Key" "k-135" e recebeu 200
    When a mesma requisição for reenviada com o mesmo corpo
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir uma única linha nova e um único evento "ApprovalReassigned"
    Given que a aprovação já foi retirada
    When "Ana" tentar retirar de novo
    Then a API deve responder 409 com código "APPROVAL_NOT_PENDING"

  Scenario: [Concorrência] Decisão do aprovador e redirecionamento ao mesmo tempo
    Given que "Marta" e "Marcos" enviam suas requisições com as ETags atuais
    When "Marcos" aprovar a linha 2 e "Marta" redirecionar a mesma linha ao mesmo tempo
    Then apenas a primeira a efetivar deve valer
    And se a aprovação de "Marcos" efetivar primeiro, "Marta" deve receber 409 com código "APPROVAL_LINE_NOT_PENDING"
    And se o redirecionamento efetivar primeiro, "Marcos" deve receber 409 com código "APPROVAL_LINE_NOT_PENDING"

  Scenario: [Falha de banco] Banco indisponível ao redirecionar
    Given que o banco de dados falha durante a transação
    When "Marta" redirecionar a linha 2
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a linha 2 de "Marcos" deve continuar "PENDING" e nenhuma linha nova deve existir

  Scenario: [Falha de integração] Fila de notificação indisponível ao redirecionar
    Given que o Redis das filas está indisponível
    When "Marta" redirecionar a linha 2 para "Diego"
    Then a API deve responder 200 com a linha redirecionada
    And o evento "ApprovalReassigned" deve permanecer "PENDING" no outbox até o relay voltar
    And as notificações "APPROVAL_REASSIGNED" devem ser enviadas depois, sem duplicidade
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Motivo ausente/curto, alvo incompatível, motivo longo | 422 | `VALIDATION_ERROR` | "Informe o motivo do redirecionamento (mín. 10 caracteres)." | Marca o campo; mantém o diálogo |
| Novo aprovador igual ao atual ou inelegível | 422 | `APPROVER_NOT_ELIGIBLE` | "Selecione um aprovador diferente e elegível para este processo." | Recarrega as opções |
| Novo aprovador violaria a segregação | 403 | `SELF_APPROVAL_FORBIDDEN` | "Este usuário não pode aprovar por ser autor de um dos documentos." | Marca o campo |
| Novo aprovador já participa de outra linha | 422 | `APPROVER_DUPLICATED` | "Esta pessoa já participa desta aprovação em outra linha." | Marca o campo |
| APV-05 em aprovação com várias linhas | 422 | `APPROVAL_LINE_REQUIRED` | "Esta aprovação tem vários aprovadores. Redirecione a linha desejada." | Abre o redirecionamento por linha |
| Aprovação já decidida, retirada ou encerrada | 409 | `APPROVAL_NOT_PENDING` | "Esta aprovação já foi decidida ou retirada." | Recarrega e mostra o resultado |
| Linha já decidida, pulada ou cancelada | 409 | `APPROVAL_LINE_NOT_PENDING` | "Esta linha já foi decidida e não pode ser redirecionada." | Recarrega as linhas |
| Sem permissão, custódia ou escopo | 403 | `PERMISSION_DENIED` | "Você não pode retirar ou redirecionar esta aprovação." | Oculta as ações |
| Aprovação inexistente ou de outro tenant | 404 | `APPROVAL_NOT_FOUND` | "Aprovação não encontrada." | Volta à lista |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "A aprovação foi alterada. Recarregue para continuar." | Recarrega mantendo o motivo |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega a aprovação |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-053 (retirar ou redirecionar no MVP 1, RN-TRAM-64 a RN-TRAM-71, estendidas), US-134 (linhas, votos e imutabilidade). Indiretas: US-133 (criação das linhas; reenvio), US-136 (visão das linhas e ações).
- **Decisões/ADRs:** DEC-193, DEC-022, DEC-018, DEC-013, DEC-104, DEC-105; POL-17 e POL-05.
- **Configurações:** `approval.preventSelfApproval` (padrão `true`).
- **Lacunas nas fontes canônicas:**
  1. A POL-17 de `permissions.md` (MVP 2) não lista o caminho `PROCESS_ASSIGN` para retirar (só DEC-193 e a feature o citam) e a APV-04 do MVP 1 exige `PROCESS_FORWARD`; adotada a união (RN-APV-56). Atualizar POL-17 e a ficha de APV-04.
  2. A rota indicativa da feature para decidir era `/approvals/{id}/decision` e para redirecionar `/approvals/{id}/approvers/{approverId}/reassign`; mantida esta última (APV-06) e `/decide` (MVP 1) para a decisão (US-134).
  3. O código `APPROVAL_LINE_REQUIRED` (422) e a reutilização de `APPROVER_DUPLICATED` (US-133) são novos; registrar em `api.md`.
  4. Aprovadores com linhas `PENDING` canceladas pela retirada não recebem notificação dedicada no MVP 1 (só `PROCESS_RETURNED`); dúvida de produto se devem ser avisados (tipo novo).
  5. `skippedReason` não distingue retirada pelo solicitante da retirada pelo gestor; o ator fica na auditoria.
  6. Retirada por gestor sem exigir motivo (como o MVP 1); dúvida de produto se o motivo deveria ser obrigatório quando quem retira não é o solicitante.
- **Resolução na implementação (spec-644, 2026-11-12):** as seis propostas acima foram adotadas como escritas (POL-17 e APV-04 atualizadas em `permissions.md` e `api/20-workflow-v2.md`; `APPROVAL_LINE_REQUIRED` no catálogo de erros; sem notificação dedicada às linhas canceladas pela retirada; ator só na auditoria; motivo opcional para o gestor). Complementos:
  - Caminho do gestor na retirada: `PROCESS_ASSIGN` com escopo `TENANT` ou `ORGANIZATION` do processo (como POL-05 — escopo de unidade não basta), sem MFA; `access.denied` continua com `reasonCode = APPROVAL_WITHDRAW` (MVP 1). APV-02 mostra `WITHDRAW` também para o gestor. Auditoria `approval.withdraw` com `actorRole` (`REQUESTER`, `CUSTODIAN`, `MANAGER`), `decisionPolicy`, `linesCanceled` e `votesKept`.
  - APV-06 responde `{ data, meta: { newApproverId } }` com a `ETag` da **aprovação** (o redirecionamento faz `version + 1` na aprovação, para o `If-Match` da retirada refletir a troca); o `If-Match` do pedido é a versão da **linha**. Linha de outra aprovação = 404 `APPROVAL_NOT_FOUND`. `approvers[].reassignedFromId` entra no APV-02 (aditivo).
  - APV-05 passa a usar o mesmo "cancelar e criar" sobre a única linha, mas mantém a segregação do MVP 1 (autor = 403, sem desvio ao substituto); o desvio do titular autor para o substituto ativo (`allowDeputy = false`) vale no APV-06.
  - "Ocupa ou ocupou outra linha" (RN-APV-53) compara a pessoa com o `approverUserId` de qualquer linha de outra posição (inclusive canceladas) e com quem votou numa linha de perfil; a própria posição não conta (quem foi redirecionado pode voltar a ela).
  - FA-08: o voto com o `approvalApproverId` da linha já redirecionada responde 409 `APPROVAL_LINE_NOT_PENDING` (antes, 403) quando a pessoa era a aprovadora daquela linha.
  - Eventos: `ApprovalReassigned` com `approvalApproverId` (linha nova), `sequence` e `fromApprovalApproverId`; `ApprovalCanceled` com `approvalApproverIds` (linhas canceladas — o `APPROVER` delas é revogado na mesma transação). Log `approval.line_reassigned` substitui o `approval.reassigned` do MVP 1; recusas em `warn approval.reassign_rejected` com `reason`.
  - Nenhuma migração: o índice único parcial `approval_approvers_sequence_key` e o gatilho de imutabilidade da US-134 bastaram; a linha antiga é gravada como cancelada antes de a nova entrar.

## Impacto técnico
- **Integridade:** a troca de aprovador é "cancelar e criar" em uma transação, preservando `sequence`, estado e prazo; o índice único parcial e o gatilho de imutabilidade evitam duas linhas ativas na mesma posição e alteração de voto.
- **Compatibilidade:** APV-05 e APV-04 do MVP 1 continuam válidas para aprovações `ANY` de uma linha; campos novos nos eventos e nas respostas são aditivos (DEC-108).
- **Concorrência:** mesma trava e mesma ordem de verificações da US-134 para decisão, redirecionamento e retirada, evitando *deadlock* e resultado ambíguo.
- **Segurança e privacidade:** o motivo do redirecionamento não é gravado; mensagens não revelam quem votou além do que a própria aprovação mostra; a ampliação de quem retira (`PROCESS_ASSIGN`) é auditada com o papel usado.
- **Acesso:** a troca de `ProcessAccess` na mesma transação evita janela em que o aprovador anterior ainda vê a pendência.

## Backend
- **Módulo(s):** `approval` (dono), `process` (retorno à etapa de origem, status e acesso), `document` (status DEC-018 na retirada), `access` (elegibilidade), `timeline`, `notification`, `audit`, `platform`.
- **Casos de uso:** `ReassignApprovalLineCommand` (APV-06), `ReassignApprovalCommand` (APV-05, estendido), `WithdrawApprovalCommand` (APV-04, estendido).
- **Domínio:** `Approval.reassignLine(line, newApprover)`; `ApprovalApprover.cancel(reason)`; `ApproverEligibilityPolicy` (reuso da US-051/US-133); `DistinctApproversPolicy`; `Approval.withdraw()` cancelando linhas não decididas.
- **Integrações internas:** `ProcessFacade` (retorno da etapa e acesso), `DocumentFacade` (status e `pendingApprovalId`), `AccessFacade` e `OrganizationFacade` (elegibilidade), `OutboxWriter`, `TimelineProjector`.
- **Transação:** com `app.tenant_id`: trava `Approval` e linhas → verificações → alteração das linhas (e da `Approval`, na retirada) → `ProcessAccess` → efeitos no processo e nos documentos (retirada) → auditoria → timeline → outbox.

## Frontend
- **Tela(s):** SCR-015 (`/aprovacoes/[id]`, também em painel lateral a partir de SCR-006).
- **Componentes:** `ReassignApprovalLineDialog` (tipo, busca de elegíveis, motivo), `WithdrawApprovalDialog` (explica o efeito sobre votos e processo), menu "Mais ações" por linha e da aprovação, `ApprovalAuditTrail` (linhas canceladas por redirecionamento, votos preservados); a lista de linhas é da US-136.
- **Estados:** loading no diálogo; erro de elegibilidade por campo; conflito (`APPROVAL_LINE_NOT_PENDING`/`APPROVAL_NOT_PENDING`) com recarga automática; sucesso (toast "Linha redirecionada para {nome}." / "Aprovação retirada. O processo voltou para a etapa anterior.").
- **Acessibilidade e responsividade:** diálogos com foco inicial no campo de motivo e resultado anunciado por `aria-live`; ações acessíveis por teclado; coluna única e botões grandes abaixo de 768 px.

## Banco de dados
- **Tabelas:** `approvals`, `approval_approvers`, `approval_documents`, `documents`, `process_stages`, `process_movements`, `process_assignments`, `process_access`, `audit_logs`, `outbox_events`, `process_timeline_entries`.
- **Migrações:** nenhuma nova (usa as de M2-02).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, approval_id, sequence) WHERE status <> 'CANCELED'`; FK `reassigned_from_id` → `approval_approvers`; gatilho de imutabilidade de linha decidida; checks de tipo × coluna na linha nova.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `APV-06` | POST | `/approvals/{id}/approvers/{approverId}/reassign` | `Idempotency-Key`, `If-Match` (linha); `{ approverType, targetApproverUserId?, targetApproverRoleId?, targetApproverDepartmentId?, reason }` | `200 { data: Approval }` com `approvers[]` e `meta.newApproverId` · `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `APV-04` | POST | `/approvals/{id}/withdraw` | `Idempotency-Key`, `If-Match` (aprovação); `{ reason? }` | `200 { data: Approval }` com `processStage` atual · `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `APV-05` | POST | `/approvals/{id}/reassign` | como no MVP 1 | `200 { data: Approval }`; aprovação com várias linhas → `422 APPROVAL_LINE_REQUIRED` | 200, 403, 404, 409, 412, 422, 428 |

## Logs
- `info` `approval.line_reassigned` — `approvalId`, `approvalApproverId`, `sequence`, `fromType`, `toType`, `durationMs`.
- `info` `approval.withdrawn` — `approvalId`, `linesCanceled`, `votesKept`, `actorRole` (`REQUESTER`, `CUSTODIAN`, `MANAGER`).
- `warn` `approval.reassign_rejected` — `reason` (`NOT_ELIGIBLE`, `DUPLICATED`, `LINE_NOT_PENDING`), `approvalId`.
- `error` `approval.reassign_failed` / `approval.withdraw_failed` — causa resumida, `correlationId`.
- **Nunca logar:** motivo do redirecionamento ou da retirada, nomes e e-mails de aprovadores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `approval.reassign` | `WORKFLOW` | Redirecionamento (APV-06/APV-05) | `changes`: `approverUserId`/`approverRoleId`/`approverDepartmentId` da linha; `metadata`: `approvalId`, `approvalApproverId` (nova), `fromApprovalApproverId`, `sequence`, `decisionPolicy`, `hasReason` |
| `approval.withdraw` | `WORKFLOW` | Retirada (APV-04) | `metadata`: `processCode`/`documentCode`, `subjectType`, `decisionPolicy`, `hasReason`, `actorRole`, `linesCanceled`, `votesKept` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` (`APPROVAL_REASSIGN`, `PROCESS_FORWARD`, `PROCESS_ASSIGN`), `approvalId`, `approvalApproverId?` |

## Testes necessários
- **Unitários:** mecanismo de troca (linha antiga `CANCELED`, nova com mesmo `sequence`, estado, `activatedAt` e `dueAt` preservados); `ApproverEligibilityPolicy` por tipo; `DistinctApproversPolicy` (inclui quem já votou); cancelamento das linhas não decididas na retirada; autorização por união (RN-APV-56).
- **Integração (Testcontainers PostgreSQL + Redis):** APV-06 atômico com `ProcessAccess`, espelho, auditoria, evento e timeline; APV-04 com votos prévios (linhas `APPROVED` preservadas, demais `CANCELED`, documentos, etapa e status do processo); APV-05 em aprovação de uma e de várias linhas; imutabilidade por gatilho.
- **API/contrato:** APV-06, APV-04 e APV-05 conforme a tabela; MVP 1 inalterado em `ANY` com uma linha.
- **RBAC e multi-tenant:** `APPROVAL_REASSIGN` e escopo; `PROCESS_ASSIGN` (TENANT/ORGANIZATION) × unidade; custódia anterior; aprovação e novo aprovador de outro tenant → 404/422 (suíte `test/tenant-leak`); bateria `test:authz` da POL-17.
- **Concorrência:** decisão × redirecionamento da mesma linha; voto × retirada; dois redirecionamentos simultâneos (um efetiva, outro `APPROVAL_LINE_NOT_PENDING`); mesma `Idempotency-Key` em paralelo.
- **E2E (Playwright):** redirecionar linha pendente e em espera; retirar com voto prévio e reenviar; conflito com recarga.
- **Acessibilidade/performance:** axe nos diálogos; 360 px.

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
- [ ] Voto registrado comprovadamente imutável em redirecionamento e retirada (teste)
- [ ] POL-17 atualizada em `permissions.md` com o caminho `PROCESS_ASSIGN` (lacuna 1)

## Estimativa
**M** — o modelo (linha cancelada e nova) e a retirada do MVP 1 já existem; o esforço está em estender elegibilidade e segregação por linha, na retirada com votos preservados, na ampliação de quem retira e nas verificações de concorrência.

## Prioridade
**P0** — sem redirecionar linha ou retirar a aprovação, uma ausência de aprovador trava o processo; faz parte do núcleo da aprovação múltipla (DT-03).
