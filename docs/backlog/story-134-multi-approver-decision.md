---
id: US-134
title: "Decidir aprovação múltipla: votos, encerramento e concorrência"
epic: EP-022
feature: FT-066
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-052, US-133]
modules: [approval, process, workflow, document, timeline, notification, access, audit, platform]
screens: [SCR-015, SCR-014]
endpoints: [APV-02, APV-03]
permissions: [APPROVAL_DECIDE, APPROVAL_VIEW]
events: [ApprovalVoteRecorded, ApprovalApproverActivated, ApprovalCompleted, ApprovalReturned, ApprovalRejected, ProcessStageChanged, ProcessStatusChanged, ApprovalRequested]
---

# US-134 — Decidir aprovação múltipla: votos, encerramento e concorrência

## Título
Decidir a própria linha de uma aprovação (`ANY`, `ALL` ou `SEQUENTIAL`), registrar votos e encerrar a aprovação com segurança

## Descrição
**Como** aprovador designado em uma linha da aprovação (titular, substituto, usuário ou detentor do perfil competente), **quero** aprovar, devolver ou indeferir a **minha** linha, **para** que a aprovação avance linha a linha até a decisão final (aprovada por todos, ou encerrada pela primeira decisão negativa), com cada voto registrado, imutável e rastreável, sem dupla decisão mesmo com cliques simultâneos.

A decisão continua sendo `POST /approvals/{id}/decide` (APV-03), agora por **linha**: o servidor identifica a linha do usuário, serializa as decisões por trava de linha da `Approval`, registra o voto e, conforme a política, mantém a aprovação aberta (`ApprovalVoteRecorded`), passa a vez à próxima linha (`ApprovalApproverActivated`) ou **encerra** a aprovação. Só no encerramento acontecem os efeitos do MVP 1 (documentos, etapa e status do processo, aprovação encadeada, selo do documento aprovado). Com `ANY` e uma linha o resultado é idêntico ao da US-052.

## Contexto
- DEC-193: `ANY` — qualquer aprovador habilitado decide pelo conjunto; `ALL` — todas as linhas `PENDING` e a aprovação só é `APPROVED` quando todas aprovam; `SEQUENTIAL` — só a linha corrente está `PENDING`, aprovar passa a vez; em `ALL` e `SEQUENTIAL` a **primeira decisão negativa encerra** a aprovação e as demais linhas ficam `SKIPPED`. Não há quórum nem voto de minerva. Decisão registrada é imutável: não se retira voto.
- Concorrência: decisões sobre a mesma aprovação são serializadas por `SELECT … FOR UPDATE` na `Approval`; vale a primeira que efetivar; a segunda recebe 409 `APPROVAL_NOT_PENDING` ou, em `ALL`, `APPROVAL_LINE_NOT_PENDING` (POL-03 por linha).
- A US-052 define a decisão, os efeitos no documento (DEC-018), a transição do workflow, o status do processo (DEC-013), a aprovação encadeada e o selo `APPROVAL_STAMPED`; a US-133 cria as linhas; esta story reaproveita tudo isso **no encerramento**.
- Segregação de funções (art. 7º, § 1º da Lei 14.133/2021; `approval.preventSelfApproval`): avaliada por linha na decisão. Devolução depois de votos favoráveis encerra a aprovação mantendo os votos no histórico; reenviar cria nova `Approval` com todas as linhas (US-133, FA-05).
- `APPROVAL_DECIDE` é risco `H` (MFA conforme `security.mfaPolicy` — POL-14); cada voto é uma decisão e exige a mesma segurança.
- As visões de lista, detalhe e caixa de tarefas (linhas, votos, vez do próximo) são da US-136; aqui entram o contrato da decisão e a leitura mínima necessária ao painel de decisão.

## Objetivo
Garantir que 100% das aprovações `ALL`/`SEQUENTIAL` terminem em estado consistente (nenhuma `Approval` `PENDING` com todas as linhas decididas, nenhuma pessoa com dois votos, nenhuma linha `APPROVED` depois de uma negativa), com decisão atômica e p95 < 1,5 s em votos que não encadeiam nova aprovação.

## Persona
- **Principal:** Aprovador de linha — Autoridade competente (`AUTORIDADE_COMPETENTE`), titular de unidade (`DEPARTMENT_HEAD`), usuário designado ou detentor do perfil (`APPROVAL_DECIDE`).
- **Secundárias:** Substituto da unidade (`deputyUserId`) quando `allowDeputy`; solicitante (recebe os votos); Controle Interno e Auditor (leem a trilha, sem decidir).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, sessão com MFA conforme a política do tenant.
- Existe `Approval` `PENDING` visível ao usuário (`APPROVAL_VIEW` ou designação), com ao menos uma linha `PENDING` ou `WAITING` coberta por ele.
- Processo não está `SUSPENDED` nem em status final (POL-03).
- O cliente possui a ETag da linha do usuário (`meta.myLine.etag` de APV-02) ou, em `ANY`, a ETag da `Approval` (MVP 1).

## Fluxo principal
1. O usuário abre a aprovação (SCR-015); `GET /approvals/{id}` (APV-02) devolve `decisionPolicy`, `approvers[]` e, em `meta`, `myLine` (linha dele, estado e ETag), `allowedActions`, `decisionOptions[]` (com `closesApproval`) e `decisionBlocker`.
2. Escolhe **Aprovar**, **Devolver para ajuste** ou **Indeferir**; para as duas últimas, o comentário (≥ 10 caracteres) é obrigatório; em devolução com mais de uma etapa de destino, informa a etapa (`transitionId`).
3. Se o voto **encerraria** a aprovação (última linha a aprovar, ou decisão negativa) e a transição tem avisos `WARNING`, o usuário os reconhece (`acknowledgedWarnings`); regras `BLOCKING` desabilitam a opção.
4. O front envia `POST /approvals/{id}/decide` com `Idempotency-Key`, `If-Match` e, se necessário, `approvalApproverId`.
5. A API, em uma transação com `app.tenant_id`: (1) trava a `Approval` (`FOR UPDATE`) e carrega as linhas; (2) verifica que a `Approval` está `PENDING` (`APPROVAL_NOT_PENDING`); (3) identifica a linha do usuário e verifica que está `PENDING` (`APPROVAL_LINE_NOT_PENDING`; linha `WAITING` → `NOT_DESIGNATED_APPROVER`); (4) confere `If-Match` (`VERSION_CONFLICT`); (5) autoriza POL-03 por linha (designação, substituto, segregação); (6) aplica a política (matriz abaixo).
6. **Voto positivo que não encerra** (`ALL` com outras linhas `PENDING`; `SEQUENTIAL` com próxima linha): grava a linha `APPROVED` (`decidedById`, `decidedAt`, `decidedAsDeputy`, comentário opcional); em `SEQUENTIAL`, a próxima linha passa de `WAITING` a `PENDING` (`activatedAt = agora`) e o espelho da `Approval` aponta para ela; grava auditoria `approval.vote`, timeline e eventos `ApprovalVoteRecorded` (e `ApprovalApproverActivated`); a `Approval` continua `PENDING` e o processo `AWAITING_APPROVAL`. Resposta 200 com `meta.outcome = VOTE_RECORDED`.
7. **Encerramento** (aprovação por todas as linhas, primeira decisão em `ANY`, ou decisão negativa): grava a `Approval` com a decisão final, marca as linhas restantes `SKIPPED` (`ANY_DECIDED` ou `NEGATIVE_DECISION`) e executa **uma vez** os efeitos da US-052 (documentos, transição, status do processo, aprovação encadeada, renderização do selo), a auditoria `approval.decide` e o evento `ApprovalCompleted`/`ApprovalReturned`/`ApprovalRejected` com `decisionPolicy`, `decidingApprovalApproverId` e `votes[]`. Resposta 200 com `meta.outcome = APPROVED | RETURNED | REJECTED`.
8. O front invalida as consultas da aprovação, do processo e da caixa de tarefas; mostra "Seu voto foi registrado. Faltam {n} aprovação(ões)." ou "Aprovação decidida: {decisão}." e, no encerramento, navega para `/processos/{id}`.

### Resultado por política
| Política | Voto positivo | Voto negativo (`RETURN`/`REJECT`) | Encerra quando |
|---|---|---|---|
| `ANY` | Aprovação `APPROVED`; demais linhas `SKIPPED` (`ANY_DECIDED`) | Aprovação `RETURNED`/`REJECTED`; demais `SKIPPED` (`ANY_DECIDED`) | primeira decisão |
| `ALL` | Linha `APPROVED`; aprovação continua `PENDING` (`ApprovalVoteRecorded`); a última linha aprova → `APPROVED` | Aprovação `RETURNED`/`REJECTED`; demais `SKIPPED` (`NEGATIVE_DECISION`); votos favoráveis permanecem | todas aprovam ou 1 negativa |
| `SEQUENTIAL` | Linha `APPROVED`; próxima `WAITING → PENDING` (`ApprovalApproverActivated`); a última aprova → `APPROVED` | idem `ALL` | última aprova ou 1 negativa |

## Fluxos alternativos
- **FA-01 — Decisão pelo substituto:** com `allowDeputy` e o titular ausente, o substituto decide a linha; `decidedAsDeputy = true` na linha, nos eventos e na auditoria.
- **FA-02 — Linha de perfil (`ROLE`):** qualquer detentor do perfil com atribuição cobrindo a unidade solicitante decide a linha; o primeiro a confirmar vence e o outro recebe `APPROVAL_LINE_NOT_PENDING`.
- **FA-03 — Pessoa coberta por duas linhas** (ex.: usuário e perfil): `approvalApproverId` é obrigatório; depois do voto, a outra linha não pode ser decidida por ela (`APPROVER_ALREADY_VOTED`).
- **FA-04 — Linha `WAITING` em `SEQUENTIAL`:** o aprovador vê a aprovação como "Aguardando a vez"; decidir devolve 403 `NOT_DESIGNATED_APPROVER`; a aprovação não aparece na caixa de tarefas dele.
- **FA-05 — Avisos pendentes:** o voto que encerraria com `WARNING` não reconhecido → `WARNINGS_NOT_ACKNOWLEDGED`; voto que não encerra não exige reconhecimento.
- **FA-06 — Destino da devolução `APPROVAL`:** o encerramento por `APPROVE` pode encadear nova aprovação (US-052, RN-TRAM-60); `APPROVER_UNRESOLVED` desfaz **todo** o voto final e mantém a linha `PENDING`.
- **FA-07 — Submissão avulsa (`DOCUMENT`):** sem etapa nem transição; só o documento muda de status no encerramento.
- **FA-08 — Aprovação cancelada ou encerrada durante a abertura da tela:** a tela recarrega e mostra a decisão registrada (sem perder o comentário digitado).

## Regras de negócio
- **RN-APV-33** — Decisão por linha: a pessoa decide a linha `PENDING` em que está designada — `USER` direto; `DEPARTMENT_HEAD` titular da unidade ou substituto (com `allowDeputy`); `ROLE` com atribuição vigente cobrindo a unidade solicitante (nunca `CURRENT`/`HISTORICAL`). `approvalApproverId` é opcional quando só uma linha `PENDING` cabe ao usuário e **obrigatório** quando há mais de uma (`VALIDATION_ERROR`, `CONDITIONAL_REQUIRED`). Uma pessoa decide, no máximo, **uma linha** por `Approval` (`APPROVER_ALREADY_VOTED`, 409).
- **RN-APV-34** — `ANY`: a primeira decisão efetivada encerra a aprovação; positiva → `APPROVED`; negativa → `RETURNED`/`REJECTED`; as demais linhas ficam `SKIPPED` (`ANY_DECIDED`). Com uma só linha, comportamento da US-052 (RN-TRAM-54 a RN-TRAM-63).
- **RN-APV-35** — `ALL`: voto positivo grava a linha `APPROVED` e mantém a aprovação `PENDING` com `ApprovalVoteRecorded` (`remainingPending`, `remainingWaiting`); a aprovação só é `APPROVED` quando **todas** as linhas aprovam (a última encerra, sem `ApprovalVoteRecorded` próprio).
- **RN-APV-36** — `SEQUENTIAL`: só a linha corrente (menor `sequence` `PENDING`) decide; aprovar grava `APPROVED` e ativa a próxima (`WAITING → PENDING`, `activatedAt = agora`, `ApprovalApproverActivated` com `dueAt` nulo até o SLA por linha — EP-030); linha `WAITING` não decide: 403 `NOT_DESIGNATED_APPROVER` (`meta.reason = LINE_WAITING`); a última a aprovar encerra.
- **RN-APV-37** — Decisão negativa (`RETURN`/`REJECT`) em qualquer política: encerra a aprovação como `RETURNED`/`REJECTED`, as linhas restantes ficam `SKIPPED` (`NEGATIVE_DECISION` em `ALL`/`SEQUENTIAL`), os votos favoráveis já dados permanecem no histórico; `comment` ≥ 10 e ≤ 5.000 obrigatório (RN-TRAM-55); em `RETURN` com mais de uma etapa de destino, `transitionId` obrigatório (RN-TRAM-56).
- **RN-APV-38** — Efeitos só no encerramento: `ApprovalSubjectHandler.onDecision` (documentos conforme DEC-018, `pendingApprovalId`, transição do workflow, `ProcessStage`, status do processo, `ProcessMovement`, aprovação encadeada, selo `APPROVAL_STAMPED`) é chamado **uma única vez**, no encerramento; votos que não encerram não mudam documento, etapa, status nem prazo (documentos seguem `IN_REVIEW`, processo `AWAITING_APPROVAL`). As regras `TRANSITION` da saída `APPROVE` (`BLOCKING`/`WARNING`) são avaliadas só quando o voto encerra.
- **RN-APV-39** — Registro final: `Approval.decision`, `decidedById`, `decidedAt`, `decisionComment` e `decidedAsDeputy` registram a decisão **final** (a linha que encerrou); as colunas de aprovador espelham a linha final; `ApprovalCompleted`/`ApprovalReturned`/`ApprovalRejected` e a auditoria `approval.decide` trazem `decisionPolicy`, `decidingApprovalApproverId` e `votes[]` (`sequence`, `decision`, `decidedById`, `decidedAsDeputy`; nunca o comentário).
- **RN-APV-40** — Concorrência: toda decisão trava a `Approval` (`SELECT … FOR UPDATE`) e depois as linhas; vale a primeira que efetivar. Ordem das verificações: (1) `Approval` não `PENDING` → `APPROVAL_NOT_PENDING` (409); (2) linha do usuário já decidida, `SKIPPED` ou `CANCELED` com a aprovação ainda `PENDING` → `APPROVAL_LINE_NOT_PENDING` (409); (3) linha `WAITING` → `NOT_DESIGNATED_APPROVER`; (4) `If-Match` (412). Decisões simultâneas em **linhas diferentes** de `ALL` não conflitam entre si: ambas são aplicadas em série e a última encerra.
- **RN-APV-41** — `If-Match`: em `ANY` vale a ETag da `Approval` (MVP 1, RN-TRAM-63); em `ALL`/`SEQUENTIAL` vale a ETag da **linha** do usuário (`ApprovalApprover.version`, exposta em `meta.myLine.etag`), para que um voto de outra linha não invalide o voto dele; `Idempotency-Key` obrigatório (DEC-105); a `Approval.version` é incrementada a cada voto.
- **RN-APV-42** — Imutabilidade: linha com decisão (`APPROVED`, `RETURNED`, `REJECTED`) não pode ser alterada (gatilho de banco); não há retirada de voto nem mudança de decisão; qualquer outra tentativa devolve `APPROVAL_LINE_NOT_PENDING`.
- **RN-APV-43** — Segregação por linha na decisão (POL-03): se `approval.preventSelfApproval`, quem for autor de qualquer versão coberta não decide **nenhuma** linha (`SELF_APPROVAL_FORBIDDEN`, 403), inclusive o substituto autor; a linha segue `PENDING` para os demais habilitados.
- **RN-APV-44** — Substituto por linha: `decidedAsDeputy = true` quando decide o `deputyUserId` e não o titular; vale por linha e aparece na linha, no evento, na auditoria e na timeline; `ROLE` e `USER` não têm substituto (RN-TRAM-48).
- **RN-APV-45** — Devolução depois de votos favoráveis: a aprovação encerra `RETURNED`; os votos permanecem no histórico (linhas `APPROVED` e `SKIPPED`); reenviar cria nova `Approval` com todas as linhas de novo (US-133, FA-05); não existe "reaproveitar votos".
- **RN-APV-46** — Guardas e cancelamentos externos: processo `SUSPENDED` ou em status final → `INVALID_PROCESS_STATUS` (409); se a aprovação for cancelada por retirada (US-135), cancelamento do processo, devolução antes da ramificação (`BRANCH_CANCELED`) ou migração (`MIGRATION`), as linhas não decididas ficam `CANCELED` e a decisão posterior recebe `APPROVAL_NOT_PENDING`.
- **RN-APV-47** — MFA: `APPROVAL_DECIDE` é risco `H`; cada voto exige sessão com MFA conforme `security.mfaPolicy` (POL-14); sem MFA → 403 `MFA_REQUIRED`.
- **RN-APV-48** — Notificações e rastro: voto que não encerra → `APPROVAL_VOTE_RECORDED` ao solicitante (in-app) e, em `SEQUENTIAL`, `APPROVAL_REQUESTED` ao aprovador ativado; timeline `APPROVAL_VOTE_RECORDED` ("{actor} aprovou ({votesLabel}) — {title}") e `APPROVAL_TURN` ("Aprovação passou para {approverLabel}"); encerramento → `APPROVAL_DECIDED`, `PROCESS_RETURNED` e demais da US-052; nunca se notifica o próprio ator.
- **RN-APV-49** — Prazo: `Approval.dueAt` vale para o conjunto e não muda com os votos; `ApprovalApprover.dueAt` e `activatedAt` só servem ao SLA por linha (EP-030); o `isOverdue` da aprovação continua pelo `dueAt` da `Approval` enquanto `PENDING`.
- **RN-APV-50** — Invariantes e observabilidade: (a) não existe `Approval` `PENDING` com todas as linhas decididas; (b) não existe linha `APPROVED` depois de uma decisão negativa na mesma aprovação; (c) uma pessoa tem no máximo uma linha decidida por aprovação; (d) `ALL`/`SEQUENTIAL` encerradas como `APPROVED` têm todas as linhas `APPROVED`; verificados por teste de propriedade; métricas `cf_approval_vote_total{policy,decision}` e `cf_approval_decide_duration_ms`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Decisão | `decision` | `ApprovalDecision` | Sim | `APPROVE`, `RETURN`, `REJECT` | — |
| Comentário | `comment` | texto longo | Condicional | ≥ 10 e ≤ 5.000 em `RETURN`/`REJECT`; opcional em `APPROVE` | — |
| Linha do voto | `approvalApproverId` | uuid | Condicional | obrigatório se o usuário cobre mais de uma linha `PENDING` | linha de `meta.myLine` |
| Avisos reconhecidos | `acknowledgedWarnings` | lista de ids | Condicional | só se o voto encerra e há `WARNING` | `[]` |
| Etapa de destino da devolução | `transitionId` | uuid | Condicional | obrigatório em `RETURN` com mais de um destino | opções de `decisionOptions[]` |
| Chave de idempotência | `Idempotency-Key` | UUID (cabeçalho) | Sim | DEC-105 | gerada pelo front |
| Versão | `If-Match` | ETag | Sim | linha (`ALL`/`SEQUENTIAL`) ou `Approval` (`ANY`) | `meta.myLine.etag` |
| *(resposta)* Resultado | `meta.outcome` | `VOTE_RECORDED` \| `APPROVED` \| `RETURNED` \| `REJECTED` | — | — | servidor |
| *(resposta)* Pendências | `meta.remainingPending`, `meta.remainingWaiting` | inteiros | — | após o voto | servidor |
| *(resposta)* Vez do próximo | `meta.activatedApproverId` | uuid | — | só em `SEQUENTIAL` com ativação | servidor |
| *(leitura)* Minha linha | `meta.myLine` (`id`, `sequence`, `status`, `etag`) | objeto | — | APV-02 | servidor |
| *(leitura)* Fecha a aprovação? | `decisionOptions[].closesApproval` | booleano | — | calculado no estado atual | servidor |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `decision` ausente ou fora do enum | Front + API (Zod) | "Selecione uma decisão." | `VALIDATION_ERROR` (`REQUIRED`/`INVALID_ENUM`) |
| V-02 | `comment` ausente/curto em `RETURN`/`REJECT` | Front + API | "Informe o motivo (mín. 10 caracteres)." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-03 | `approvalApproverId` ausente com mais de uma linha possível | Front + API | "Escolha em qual linha você vai decidir." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-04 | `approvalApproverId` de outra aprovação ou que não cabe ao usuário | API | "Você não é o aprovador desta linha." | `NOT_DESIGNATED_APPROVER` |
| V-05 | `Approval` não está `PENDING` | API | "Esta aprovação já foi decidida ou encerrada." | `APPROVAL_NOT_PENDING` |
| V-06 | Linha do usuário já decidida, pulada ou cancelada (aprovação ainda `PENDING`) | API | "Esta linha já foi decidida." | `APPROVAL_LINE_NOT_PENDING` |
| V-07 | Linha ainda `WAITING` (vez de outro aprovador) | API | "Ainda não é a sua vez de decidir esta aprovação." | `NOT_DESIGNATED_APPROVER` |
| V-08 | Usuário já votou nesta aprovação em outra linha | API | "Você já votou nesta aprovação." | `APPROVER_ALREADY_VOTED` |
| V-09 | Autor de documento coberto | API | "Você não pode decidir esta aprovação por ser autor de um dos documentos." | `SELF_APPROVAL_FORBIDDEN` |
| V-10 | Avisos `WARNING` não reconhecidos no voto que encerra | API | "Confirme que está ciente dos avisos para continuar." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-11 | Regra `BLOCKING` não satisfeita no voto que encerra | API | "Não é possível concluir esta decisão agora: {mensagem da regra}." | `TRANSITION_BLOCKED` |
| V-12 | `transitionId` ausente (várias devoluções) ou de outra ação/etapa | Front + API | "Escolha para qual etapa devolver." | `VALIDATION_ERROR` (`REQUIRED`) / `TRANSITION_NOT_AVAILABLE` |
| V-13 | `If-Match` ausente / divergente com a linha ainda `PENDING` | API | "A aprovação foi alterada. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-14 | Aprovador da próxima aprovação (encadeada) não resolvido | API | "Não foi possível determinar quem deve aprovar a próxima etapa. Contate o administrador." | `APPROVER_UNRESOLVED` |
| V-15 | Processo suspenso ou em status final | API | "O processo não está disponível para decisão." | `INVALID_PROCESS_STATUS` |

## Permissões
- **Permissão:** `APPROVAL_DECIDE` (risco `H`) para decidir; `APPROVAL_VIEW` ou designação para APV-02.
- **Políticas:** POL-03 **por linha** (designação, substituto, segregação; linha `WAITING` → `NOT_DESIGNATED_APPROVER`; concorrência `APPROVAL_NOT_PENDING`/`APPROVAL_LINE_NOT_PENDING`); POL-14 (MFA).
- **MFA:** exigido por voto conforme `security.mfaPolicy` (`ADMINS` ou `ALL`); sem MFA → 403 `MFA_REQUIRED`.
- **Sem permissão:** botões "Aprovar/Devolver/Indeferir" ocultos para quem só tem `APPROVAL_VIEW` e desabilitados, com a razão (`decisionBlocker`), para quem não pode decidir agora; a API responde 403 `NOT_DESIGNATED_APPROVER`/`SELF_APPROVAL_FORBIDDEN`/`PERMISSION_DENIED` e registra `access.denied` (`reasonCode = APPROVAL_DECIDE`, `approvalId`, `approvalApproverId`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalVoteRecorded` | `approval.vote_recorded` | Voto positivo que não encerra (`ALL`/`SEQUENTIAL`) | `approvalId`, `approvalApproverId`, `sequence`, `decidedById`, `decidedAsDeputy`, `remainingPending`, `remainingWaiting` |
| `ApprovalApproverActivated` | `approval.approver_activated` | `SEQUENTIAL`: próxima linha passa a `PENDING` | `approvalId`, `approvalApproverId`, `sequence`, `approverType`, referências, `allowDeputy`, `dueAt?` |
| `ApprovalCompleted` | `approval.completed` | Encerramento por aprovação | MVP 1 + `decisionPolicy`, `decidingApprovalApproverId`, `votes[]` |
| `ApprovalReturned` | `approval.returned` | Encerramento por devolução | idem |
| `ApprovalRejected` | `approval.rejected` | Encerramento por indeferimento | idem |
| `ProcessStageChanged` | `process.stage_changed.<cause>` | Encerramento que move a etapa | `cause` ∈ `APPROVAL_APPROVED`, `APPROVAL_RETURNED`, `APPROVAL_REJECTED` (US-052) |
| `ProcessStatusChanged` | `process.status_changed.<status>` | Encerramento que muda o status macro | `fromStatus`, `toStatus`, `cause` |
| `ApprovalRequested` | `approval.requested` | Destino do encerramento também é `APPROVAL` (encadeamento) | como na US-133 |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_VOTE_RECORDED` | Solicitante | in-app (e-mail desligado por padrão) | `ApprovalVoteRecorded` |
| `APPROVAL_REQUESTED` | Aprovador da linha ativada (titular + substituto se `allowDeputy`; ROLE como no MVP 1) | in-app (**obrigatória**) + e-mail | `ApprovalApproverActivated` |
| `APPROVAL_DECIDED` | Solicitante e responsáveis dos documentos cobertos | in-app + e-mail | Encerramento (`ApprovalCompleted`/`Returned`/`Rejected`) |
| `PROCESS_RETURNED` | Responsável de destino (ou `PREVIOUS_ASSIGNEE`); senão, membros da unidade | in-app + e-mail | Encerramento por `RETURN`/`REJECT` |
| `PROCESS_STATUS_CHANGED` | Criador, responsável atual, participantes com `notify` | in-app | Status final `COMPLETED` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Decidir aprovação múltipla

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0012/2026" está em "AUTORIZACAO_LICITACAO" com status "AWAITING_APPROVAL"
    And a aprovação cobre o "EDITAL" "ED 0003/2026" (autor "Ana") em "IN_REVIEW"
    And "Roberto" (titular da "Secretaria de Administração") e "Marcos" (Procurador-Geral) têm "APPROVAL_DECIDE" e MFA na sessão

  Scenario: [Sucesso] Em "ALL" o primeiro voto mantém a aprovação aberta e o último encerra
    Given que a aprovação tem a política "ALL" com as linhas 1 "Roberto" e 2 "Marcos" "PENDING"
    When "Roberto" aprovar a sua linha
    Then a resposta deve ter "meta.outcome" "VOTE_RECORDED" e "remainingPending" 1
    And a aprovação deve continuar "PENDING", o documento "IN_REVIEW" e o processo "AWAITING_APPROVAL"
    And deve gerar registro de auditoria "approval.vote" e o evento "ApprovalVoteRecorded"
    And "Ana" deve receber a notificação "APPROVAL_VOTE_RECORDED"
    When "Marcos" aprovar a sua linha
    Then a aprovação deve ficar "APPROVED" com "decidedById" de "Marcos"
    And o documento deve ficar "APPROVED" e o processo deve avançar para "CONCLUSAO"
    And deve gerar registro de auditoria "approval.decide" e o evento "ApprovalCompleted" com "votes" de 2 linhas

  Scenario: [Sucesso] Em "SEQUENTIAL" a vez passa de uma linha para a próxima
    Given que a aprovação tem a política "SEQUENTIAL" com a linha 1 "Roberto" "PENDING" e a linha 2 "Marcos" "WAITING"
    When "Roberto" aprovar
    Then a linha 2 deve ficar "PENDING" com "activatedAt" preenchido
    And deve gerar o evento "ApprovalApproverActivated" e a notificação "APPROVAL_REQUESTED" para "Marcos"
    When "Marcos" aprovar
    Then a aprovação deve ficar "APPROVED" e o processo deve seguir

  Scenario: [Sucesso] Decisão negativa depois de voto favorável encerra a aprovação
    Given que a aprovação "ALL" tem a linha 1 de "Roberto" "APPROVED" e a linha 2 de "Marcos" "PENDING"
    When "Marcos" devolver com o comentário "Faltam as cláusulas de reajuste do contrato" para a etapa "MINUTA_EDITAL"
    Then a aprovação deve ficar "RETURNED" e o processo deve voltar para "MINUTA_EDITAL" com status "RETURNED"
    And o voto de "Roberto" deve permanecer "APPROVED" no histórico
    And deve gerar o evento "ApprovalReturned" com "decisionPolicy" "ALL" e "votes" de 2 linhas

  Scenario: [Sucesso] Em "ANY" a primeira decisão encerra e as demais linhas são puladas
    Given que a aprovação tem a política "ANY" com duas linhas "PENDING"
    When "Roberto" aprovar
    Then a aprovação deve ficar "APPROVED" e a linha 2 deve ficar "SKIPPED" com "skippedReason" "ANY_DECIDED"

  Scenario: [Validação] Comentário curto, linha ambígua e etapa de devolução ausente
    When "Marcos" devolver com o comentário "ok"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" no campo "comment"
    Given que "Marcos" cobre duas linhas "PENDING" (usuário e perfil)
    When "Marcos" aprovar sem informar "approvalApproverId"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "approvalApproverId"
    When "Marcos" devolver sem "transitionId" havendo quatro etapas de destino
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "transitionId"

  Scenario: [Permissão] Linha em espera, autor do documento e usuário não designado
    Given que a aprovação é "SEQUENTIAL" e a linha de "Marcos" está "WAITING"
    When "Marcos" tentar aprovar
    Then a API deve responder 403 com código "NOT_DESIGNATED_APPROVER" e "meta.reason" "LINE_WAITING"
    And deve gerar registro de auditoria "access.denied"
    Given que "Ana" é autora do "EDITAL" e é a aprovadora da linha 1
    When "Ana" tentar aprovar
    Then a API deve responder 403 com código "SELF_APPROVAL_FORBIDDEN"
    And a linha 1 deve continuar "PENDING"
    When "Bruno", sem designação, tentar aprovar
    Then a API deve responder 403 com código "NOT_DESIGNATED_APPROVER"

  Scenario: [Tenant incorreto] Aprovação de outro tenant
    Given que existe uma aprovação "PENDING" no tenant "Prefeitura B"
    When "Roberto", no tenant "Prefeitura A", tentar decidir essa aprovação
    Then a API deve responder 404 com código "APPROVAL_NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio do voto e segundo voto da mesma pessoa
    Given que "Roberto" aprovou com "Idempotency-Key" "k-134" e recebeu 200
    When a mesma requisição for reenviada com o mesmo corpo
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir um único registro "approval.vote" e um único evento "ApprovalVoteRecorded"
    Given que "Roberto" também é detentor do perfil da linha 3 "PENDING"
    When "Roberto" tentar decidir a linha 3
    Then a API deve responder 409 com código "APPROVER_ALREADY_VOTED"

  Scenario: [Concorrência] Votos simultâneos em linhas diferentes e na mesma linha
    Given que a aprovação "ALL" tem as linhas 1 "Roberto" e 2 "Marcos" "PENDING"
    When "Roberto" e "Marcos" aprovarem ao mesmo tempo
    Then as duas decisões devem ser aplicadas em série e a aprovação deve ficar "APPROVED" uma única vez
    Given que a linha 2 é do perfil "AUTORIDADE_COMPETENTE" com dois detentores "Marcos" e "Paula"
    When "Marcos" e "Paula" decidirem a mesma linha ao mesmo tempo
    Then apenas a primeira deve efetivar
    And a segunda deve receber 409 com código "APPROVAL_LINE_NOT_PENDING"
    Given que "Roberto" devolve e "Marcos" aprova ao mesmo tempo
    When a devolução efetivar primeiro
    Then "Marcos" deve receber 409 com código "APPROVAL_NOT_PENDING" e a aprovação deve ficar "RETURNED"

  Scenario: [Falha de banco] Banco falha durante o encerramento
    Given que o banco de dados falha ao gravar a transição do processo
    When "Marcos" aprovar a última linha
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a linha de "Marcos" deve continuar "PENDING", o documento "IN_REVIEW" e nenhum evento deve ser gravado

  Scenario: [Falha de integração] Fila de renderização e relay do outbox indisponíveis
    Given que o Redis das filas está indisponível
    When "Marcos" aprovar a última linha
    Then a API deve responder 200 e a aprovação deve ficar "APPROVED"
    And a renderização "APPROVAL_STAMPED" deve ficar "PENDING" para o reconciliador
    And o evento "ApprovalCompleted" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido / comentário curto / linha ambígua | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca o campo; mantém o diálogo |
| Não é o aprovador da linha / linha em espera | 403 | `NOT_DESIGNATED_APPROVER` | "Você não é o aprovador desta linha." / "Ainda não é a sua vez de decidir esta aprovação." | Desabilita a decisão com a razão |
| Autor de documento coberto | 403 | `SELF_APPROVAL_FORBIDDEN` | "Você não pode decidir esta aprovação por ser autor de um dos documentos." | Desabilita a decisão |
| Sem MFA | 403 | `MFA_REQUIRED` | "Confirme sua identidade (MFA) para decidir." | Abre o desafio de MFA |
| Aprovação inexistente ou de outro tenant | 404 | `APPROVAL_NOT_FOUND` | "Aprovação não encontrada." | Volta à lista |
| Aprovação já decidida, retirada ou encerrada | 409 | `APPROVAL_NOT_PENDING` | "Esta aprovação já foi decidida ou encerrada." | Recarrega e mostra o resultado registrado |
| Linha já decidida, pulada ou cancelada | 409 | `APPROVAL_LINE_NOT_PENDING` | "Esta linha já foi decidida." | Recarrega as linhas |
| Pessoa já votou nesta aprovação | 409 | `APPROVER_ALREADY_VOTED` | "Você já votou nesta aprovação." | Mostra o voto registrado |
| Processo suspenso ou em status final | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para decisão." | Desabilita a decisão |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "A aprovação foi alterada. Recarregue para continuar." | Recarrega mantendo o comentário |
| Avisos não reconhecidos / regra bloqueante | 422 | `WARNINGS_NOT_ACKNOWLEDGED` / `TRANSITION_BLOCKED` | "Confirme que está ciente dos avisos para continuar." / "Não é possível concluir esta decisão agora: {mensagem}." | Exibe avisos / desabilita |
| Transição inválida | 422 | `TRANSITION_NOT_AVAILABLE` | "Escolha uma etapa de devolução válida." | Recarrega as opções |
| Próximo aprovador não resolvido (encadeamento) | 422 | `APPROVER_UNRESOLVED` | "Não foi possível determinar quem deve aprovar a próxima etapa. Contate o administrador." | Mantém a linha `PENDING` |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega a aprovação |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível registrar o voto agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-052 (decisão e efeitos, RN-TRAM-54 a RN-TRAM-63), US-133 (linhas e estado inicial). Habilita US-135 (redirecionar e retirar), US-136 (visões) e a aprovação do PCA (EP-023).
- **Decisões/ADRs:** DEC-193, DEC-022, DEC-013, DEC-018, DEC-104, DEC-105; ADR-006 (renderização, pelo selo).
- **Configurações:** `approval.preventSelfApproval` (padrão `true`), `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. O código `APPROVER_ALREADY_VOTED` (409) é novo; a feature diz "ninguém aprova duas vezes" mas não nomeia o erro; registrar em `api.md`/POL-03.
  2. A semântica do `If-Match` por linha (RN-APV-41) e os campos aditivos `meta.myLine`, `meta.outcome` e `decisionOptions[].closesApproval` não estão nas fontes; propostos aqui para manter o contrato do MVP 1 em `ANY` e evitar 412 indevido entre linhas.
  3. `skippedReason` não tem valor próprio para `ANY` negativo, cancelamentos por processo cancelado, ramo cancelado ou migração; usados `ANY_DECIDED` e `WITHDRAWN` (RN-APV-34/46). Ampliar os valores se desejado.
  4. `decisionBlocker` (APV-02) ganha `LINE_NOT_PENDING` e `ALREADY_VOTED`; a lista do MVP 1 não os prevê.
  5. O tratamento de pausa/retomada de SLA por voto (EP-030) não é descrito; `ApprovalApproverActivated.dueAt` fica nulo até a US de SLA por linha.

## Impacto técnico
- **Trava e ordem:** `FOR UPDATE` na `Approval` e depois nas linhas, sempre na mesma ordem, para evitar *deadlock*; a transação de voto é curta; a de encerramento inclui os efeitos da US-052 e pode encadear nova aprovação.
- **Compatibilidade:** em `ANY` com uma linha o contrato de APV-03 e as respostas do MVP 1 permanecem; campos novos são aditivos (DEC-108); a `Approval.version` sobe a cada voto, então clientes do MVP 1 em `ANY` continuam com `If-Match` da `Approval`.
- **Idempotência e reconciliador:** voto e encerramento são idempotentes por `Idempotency-Key`; renderização do selo e entrega de eventos seguem o outbox e o reconciliador (como na US-052).
- **Segurança:** comentários nunca vão a eventos ou logs; `votes[]` traz só ids e decisão; mensagens de erro não revelam quem decidiu além do que a própria aprovação já mostra a quem tem `APPROVAL_VIEW`.
- **Performance:** voto sem encadeamento p95 < 1,5 s (meta na suíte de performance, medida no endurecimento); até 20 linhas por aprovação.
- **Observabilidade:** teste de propriedade das invariantes (RN-APV-50) com decisões aleatórias e concorrentes.

## Backend
- **Módulo(s):** `approval` (dono: linhas, política, votos, encerramento), `process` (transição e status), `workflow` (transições e regras), `document` (status DEC-018 e selo), `timeline`, `notification`, `access` (designação e cobertura de perfil), `audit`, `platform`.
- **Casos de uso:** `DecideApprovalCommand` → `DecideApprovalHandler` (estendido), `GetApprovalQuery` (estendido).
- **Domínio:** `Approval.decide(actor, line, decision)` com `DecisionPolicyStrategy` (`AnyPolicy`, `AllPolicy`, `SequentialPolicy`); `ApprovalApprover` (imutável após decisão); `ApprovalOutcome`; `SelfApprovalGuard`; `ApprovalSubjectHandler.onDecision` só no encerramento.
- **Integrações internas:** `WorkflowFacade` (`evaluateRules`, transição), `ProcessFacade` (movimento, etapa, status), `DocumentFacade` (status e renderização), `AuthorizationService`, `OutboxWriter`, `TimelineProjector`.
- **Transação:** `app.tenant_id` → trava `Approval` e linhas → verificações em ordem (RN-APV-40) → voto ou encerramento → efeitos → auditoria → timeline → outbox → *commit*; renderização enfileirada depois do *commit*.

## Frontend
- **Tela(s):** SCR-015 (`/aprovacoes/[id]`, painel de decisão) e SCR-014 (`/aprovacoes`, aprovações com decisão pendente do usuário).
- **Componentes:** `ApprovalDecisionPanel` (decide a própria linha; mostra "Sua linha: {n} de {total}"), `LineSelector` (quando há mais de uma linha cabível), `WarningsChecklist` (só quando o voto encerra), `CommentField`, mensagens de conflito (`APPROVAL_NOT_PENDING`, `APPROVAL_LINE_NOT_PENDING`) com recarga automática; a lista de linhas e votos completa é da US-136.
- **Estados:** loading (skeleton); botão desabilitado durante o envio; "Aguardando a vez" (linha `WAITING`); "Você já votou"; conflito (mensagem clara e recarga mantendo o comentário); sucesso com o resultado (`VOTE_RECORDED` ou decisão final).
- **Acessibilidade e responsividade:** botões de decisão com rótulo e `aria-pressed`; diálogos com foco inicial no comentário e resultado anunciado por `aria-live`; uso móvel como requisito (coluna única e botões grandes abaixo de 768 px).

## Banco de dados
- **Tabelas:** `approvals`, `approval_approvers` (gatilho de imutabilidade da linha decidida), `approval_documents`, `documents`, `process_stages`, `process_movements`, `process_assignments`, `process_access`, `document_renditions`, `audit_logs`, `outbox_events`, `process_timeline_entries`.
- **Migrações:** nenhuma nova (M2-02/M2-03 da US-133 e gatilhos de `approval_approvers`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, approval_id, sequence) WHERE status <> 'CANCELED'`; `CHECK (status NOT IN ('APPROVED','RETURNED','REJECTED') OR (decided_at IS NOT NULL AND decision IS NOT NULL))`; `CHECK (decision NOT IN ('RETURN','REJECT') OR decision_comment IS NOT NULL)`; trigger "decisão é imutável"; índices parciais por aprovador `WHERE status = 'PENDING'`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `APV-02` | GET | `/approvals/{id}` | — | `200 { data: Approval }` com `decisionPolicy`, `approvers[]` (`id`, `sequence`, `status`, `label`, `decision?`, `decidedBy?`, `decidedAt?`, `decidedAsDeputy`, `version`) e `meta` (`myLine`, `allowedActions`, `decisionOptions[]` com `closesApproval`, `decisionBlocker`) · `ETag` | 200, 403, 404 |
| `APV-03` | POST | `/approvals/{id}/decide` | `Idempotency-Key`, `If-Match`; `{ decision, comment?, approvalApproverId?, acknowledgedWarnings?, transitionId? }` | `200 { data: Approval, meta: { outcome, remainingPending, remainingWaiting, activatedApproverId? } }` com `processStage`, `processStatus`, `chainedApprovalId` no encerramento · `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `approval.vote_recorded` — `approvalId`, `approvalApproverId`, `decisionPolicy`, `decision`, `remainingPending`, `durationMs`.
- `info` `approval.closed` — `approvalId`, `outcome`, `decisionPolicy`, `votesCount`, `chained`.
- `warn` `approval.decide_conflict` — `reason` (`NOT_PENDING`, `LINE_NOT_PENDING`, `VERSION_CONFLICT`), `approvalId`.
- `error` `approval.decide_failed` — causa resumida, `correlationId`.
- **Nunca logar:** comentário da decisão, conteúdo dos documentos, nomes dos aprovadores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `approval.vote` | `WORKFLOW` | Voto positivo que não encerra | `changes`: `status` da linha (`PENDING` → `APPROVED`); `metadata`: `approvalId`, `approvalApproverId`, `sequence`, `decisionPolicy`, `decidedAsDeputy`, `activatedApproverId?` |
| `approval.decide` | `WORKFLOW` | Encerramento (qualquer política) | `changes`: `status`, `decision`; `metadata`: `processCode`, `fromStatus`/`toStatus`, `documentIds[]`, `warningsAcknowledged`, `decidedAsDeputy`, `approvalApproverId`, `decisionPolicy`, `votes[]` |
| `access.denied` | `ACCESS` | Tentativa sem permissão ou não designado | `reasonCode = APPROVAL_DECIDE`, `approvalId`, `approvalApproverId?` |

## Testes necessários
- **Unitários:** `DecisionPolicyStrategy` por política × decisão (matriz completa); ativação da próxima linha; `SelfApprovalGuard`; pessoa única por aprovação; escolha de linha por cobertura; ordem das verificações de erro.
- **Integração (Testcontainers PostgreSQL + Redis):** voto e encerramento atômicos com os efeitos da US-052 (documento, transição, status, encadeamento, selo); `APPROVER_UNRESOLVED` desfaz o voto final; imutabilidade por gatilho; idempotência de reenvio; invariantes de RN-APV-50 em teste de propriedade.
- **API/contrato:** APV-02 e APV-03 conforme a tabela; contrato do MVP 1 em `ANY` com uma linha inalterado.
- **RBAC e multi-tenant:** POL-03 por linha (`NOT_DESIGNATED_APPROVER`, `SELF_APPROVAL_FORBIDDEN`, MFA); aprovação de outro tenant → 404 (suíte `test/tenant-leak`); regressão da bateria `test:authz` para a POL-03.
- **Concorrência:** votos simultâneos em linhas diferentes e na mesma linha; negativa × positiva; dois detentores do mesmo perfil; `Idempotency-Key` repetida em paralelo.
- **E2E (Playwright):** `ALL` com dois aprovadores, `SEQUENTIAL` com passagem da vez, devolução com voto prévio, conflito com recarga.
- **Acessibilidade/performance:** axe no painel de decisão e nos diálogos; 360 px; p95 do voto na suíte de performance (medido no endurecimento).

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
- [ ] Teste de propriedade das invariantes (RN-APV-50) verde, com decisões concorrentes
- [ ] Contrato do MVP 1 para aprovação `ANY` de uma linha verificado como inalterado
- [ ] Bateria `test:authz` atualizada para POL-03 por linha

## Estimativa
**L** — três políticas com matriz de resultados, serialização de decisões concorrentes por linha, efeitos do MVP 1 aplicados só no encerramento, ativação da próxima linha e compatibilidade de contrato com `ANY`.

## Prioridade
**P0** — é o núcleo da aprovação múltipla (DT-03) e pré-requisito do redirecionamento, das visões e da aprovação do PCA.
