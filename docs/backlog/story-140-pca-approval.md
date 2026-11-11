---
id: US-140
title: "Enviar o PCA para aprovação e decidir"
epic: EP-023
feature: FT-069
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-051, US-052, US-138]
modules: [pca, approval, access, organization, notification, audit, platform]
screens: [SCR-018, SCR-014, SCR-015]
endpoints: [PCA-15, PCA-16, PCA-17, PCA-18, APV-01, APV-02, APV-03, TSK-01]
permissions: [PCA_SUBMIT, PCA_VIEW, APPROVAL_DECIDE]
events: [PcaStatusChanged, ApprovalRequested, ApprovalCompleted, ApprovalReturned, ApprovalRejected, ApprovalCanceled]
---

# US-140 — Enviar o PCA para aprovação e decidir

## Título
Enviar o plano de contratações anual para aprovação da autoridade competente e registrar a decisão

## Descrição
**Como** responsável pelo planejamento (`PLANEJAMENTO`), **quero** enviar o PCA em elaboração para a autoridade competente do meu órgão e, se for o caso, retirá-lo antes da decisão, e **como** autoridade competente (`AUTORIDADE_COMPETENTE`) **quero** aprovar, devolver ou rejeitar o plano pela tela de aprovações que já uso, **para** dar ao PCA um ato formal de aprovação, com autoria, data e histórico, e travar a edição dos itens do plano aprovado.

O envio cria uma `Approval` de assunto `PCA` (sem processo), coloca o plano em `AWAITING_APPROVAL` e trava a edição. A autoridade decide por APV-03, com a mesma mecânica da US-052 e da decisão múltipla da US-134: `APPROVE` leva o plano a `APPROVED` (vigente e imutável nos itens); `RETURN` e `REJECT` o devolvem a `DRAFT` com o comentário registrado. A retirada pelo planejamento também devolve o plano a `DRAFT`. A revisão do plano já aprovado (nova versão) é a US-141; a reconciliação das referências textuais que o plano aprovado dispara é a US-143.

## Contexto
- A DEC-197 define a aprovação do PCA pela autoridade competente por `Approval` com o novo `ApprovalSubjectType` `PCA` e `Approval.processId` nulo (`entities.md §5.9`: `+ pcaId`, checks `subject_type <> 'PCA' OR (pca_id IS NOT NULL AND process_id IS NULL)`, único `(tenant_id, pca_id) WHERE status = 'PENDING' AND subject_type = 'PCA'`). O assunto `PCA` é decidido por um `ApprovalSubjectHandler` implementado pelo módulo `pca` (`domains.md §12`: `assertDecidable`, `getCoveredAuthors`, `onDecision`, `onCanceled`).
- POL-22: elaborar e enviar com `PCA_MANAGE`/`PCA_SUBMIT` e plano `DRAFT`; aprovar por `Approval` com aprovador `ROLE AUTORIDADE_COMPETENTE` (padrão, configurável) cuja atribuição cubra o **órgão do plano**; a decisão segue a POL-03 por linha; **quem enviou não aprova**; erros `PCA_NOT_EDITABLE` (409) e `PCA_SELF_APPROVAL_FORBIDDEN` (403).
- A mecânica de linhas da US-133/US-134 vale também aqui: toda `Approval` tem `decisionPolicy` e ao menos uma linha `ApprovalApprover`; para o PCA a política é `ANY` com uma linha `ROLE`. Aprovação múltipla ou sequencial para o PCA não está no escopo (feature FT-069, "fora de escopo"), e não há onde configurá-la nas fontes.
- Como não há processo, não existem `ProcessAccess`, entrada na timeline do processo nem etapa de workflow; a visibilidade da aprovação segue a RN-PCA-81 (lacuna 4 da US-136 resolvida aqui) e o estado do plano é o `PcaPlanStatus` (`DRAFT → AWAITING_APPROVAL → APPROVED`, `entities.md §6.1`).
- A aprovação de uma **revisão** (versão > 1) usa o mesmo envio e a mesma decisão; o que ela faz a mais (versão anterior `SUPERSEDED`, reconciliação com `trigger = REVISION`) é da US-141.
- O evento `PcaStatusChanged` (`pca.status_changed.<status>`) tem a especialização `PcaApproved` (`pca.status_changed.approved`), que dispara o `PcaReconciliationScheduler` (US-143) e a notificação `PCA_APPROVAL_DECIDED`.
- Sigilo (DEC-030): o valor previsto do plano aprovado é exibido ao aprovador; nenhum valor vai a eventos, notificações ou logs.

## Objetivo
Garantir que 100% dos planos enviados tenham uma aprovação `PENDING` única, com aprovador resolvido, e fiquem imutáveis até a decisão; que a decisão da autoridade competente (nunca de quem enviou) leve o plano a `APPROVED` ou de volta a `DRAFT` de forma atômica, com evento, notificação e auditoria; e que o plano aprovado tenha `approvedAt` e `approvedById` registrados.

## Persona
- **Principal (envia):** Planejamento (`PLANEJAMENTO`, `PCA_SUBMIT` com escopo `ORGANIZATION`/`TENANT`).
- **Principal (decide):** Autoridade competente (`AUTORIDADE_COMPETENTE`, `APPROVAL_DECIDE`, atribuição que cobre o órgão do plano).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, `PCA_SUBMIT`/`PCA_MANAGE`); Auditor (`AUDITOR`) e Controle Interno (`CONTROLE_INTERNO`) — consultam plano, decisões e histórico (`PCA_VIEW`); Administrador do órgão (`ADMIN_ORGAO`) — garante que existe quem aprove. Sem acesso: `CONSULTOR_EXTERNO` (L-07).

## Pré-condições
- Plano do órgão em `DRAFT` (versão 1 ou revisão), com ao menos um item (US-138); usuário com `PCA_SUBMIT` e escopo de órgão.
- Perfil `AUTORIDADE_COMPETENTE` ativo no tenant, com ao menos uma pessoa com vínculo `ACTIVE` e atribuição vigente cujo escopo cubra o órgão do plano (`TENANT` ou `ORGANIZATION` do plano) e que não seja quem envia.
- Não existe `Approval` `PENDING` de assunto `PCA` para o plano (garantido pelo índice único).
- Para decidir: `APPROVAL_DECIDE` + designação (POL-03 por linha) + não ser quem enviou (POL-22) + MFA (ação de risco `H`).

## Fluxo principal
1. Na aba **Aprovação** de `/pca/[pcaId]` (SCR-018), o planejamento vê o estado do plano e a **lista de prontidão** (PCA-18): itens existentes, itens com dado obrigatório faltando ou referência inativa, e se há autoridade competente disponível para o órgão. Cada pendência tem o link "Ir para o item".
2. Sem pendências, clica em **"Enviar para aprovação"**; o diálogo mostra o resumo ("PCA 2027 — versão 1 · 116 itens · R$ 18.450.300,00") e o campo opcional **Comentário** (até 2.000 caracteres), e avisa: "Depois do envio, o plano fica bloqueado para edição até a decisão." O front envia PCA-15 com `If-Match` (versão do plano) e `Idempotency-Key`.
3. A API, em uma transação com `app.tenant_id`: autoriza `PCA_SUBMIT` com escopo de órgão; trava o plano (`FOR UPDATE`); confere `DRAFT` e a versão; reavalia a completude dos itens (RN-PCA-70); resolve o aprovador (RN-PCA-72); cria a `Approval` (`subjectType = PCA`, `pcaId`, `processId` nulo, título "Aprovação do PCA 2027 — versão 1", política `ANY`, uma linha `ROLE` `PENDING`); marca o plano `AWAITING_APPROVAL` com `submittedAt`, `submittedById` e `approvalId`; grava auditoria (`pca.submit`, `approval.request`) e publica `ApprovalRequested` e `PcaStatusChanged` no outbox.
4. A API responde **200** com o plano, a aprovação criada e a nova `ETag`. A aba mostra "Aguardando decisão da autoridade competente desde {data/hora}", os itens passam a leitura e aparecem "Retirar da aprovação" e o histórico.
5. Depois do commit, os detentores do perfil de autoridade com escopo sobre o órgão (máx. 50) recebem a notificação `APPROVAL_REQUESTED` (in-app obrigatória); a aprovação aparece em **Aprovações** (SCR-014), na caixa de tarefas ("Aprovações pendentes", `process` nulo) e em `/aprovacoes/[id]` (SCR-015).
6. Em SCR-015, a autoridade vê o resumo do plano (exercício, versão, título, quantidade de itens, valor previsto total, quem enviou, comentário do envio) e o link **"Abrir o plano"** (leitura completa do plano enquanto a aprovação for dela, mesmo sem outro escopo de `PCA_VIEW`). Ela escolhe **Aprovar**, **Devolver** ou **Rejeitar**; devolver e rejeitar exigem comentário de 10 a 5.000 caracteres. O front envia APV-03 com `If-Match` da aprovação e `Idempotency-Key`; o MFA é exigido.
7. A API (APV-03, US-052/US-134) autoriza e trava a aprovação, chama `PcaApprovalSubjectHandler.assertDecidable` (plano `AWAITING_APPROVAL` com `approvalId` igual) e a segregação (`getCoveredAuthors` = quem enviou), registra a decisão e encerra a aprovação; chama `onDecision` **na mesma transação**:
   - `APPROVE`: plano `APPROVED`, `approvedAt` e `approvedById` preenchidos; `ApprovalCompleted` e `PcaStatusChanged` (`pca.status_changed.approved`, `PcaApproved`).
   - `RETURN` ou `REJECT`: plano volta a `DRAFT` (`submittedAt`/`submittedById` preservados como histórico); `ApprovalReturned`/`ApprovalRejected` e `PcaStatusChanged` (`AWAITING_APPROVAL → DRAFT`).
8. Depois do commit, `PCA_APPROVAL_DECIDED` notifica quem enviou e quem tem `PCA_MANAGE` no órgão (máx. 50), exceto a autoridade que decidiu. Em SCR-018 a aba mostra "Aprovado em {data} por {nome}" (itens em leitura) ou "Devolvido/Rejeitado em {data}: {comentário}" (itens editáveis de novo, "Enviar para aprovação" disponível).
9. Antes da decisão, o planejamento pode clicar em **"Retirar da aprovação"** (PCA-16, `If-Match`, `Idempotency-Key`, motivo opcional). A API cancela a aprovação (`CANCELED`, motivo `WITHDRAWN`), cancela a linha, devolve o plano a `DRAFT`, grava `pca.withdraw`/`approval.cancel` e publica `ApprovalCanceled` e `PcaStatusChanged`.
10. O histórico (PCA-17) lista cada envio e decisão do plano, com quem enviou, quando, a decisão, quem decidiu e o comentário.

## Fluxos alternativos
- **FA-01 — Pendências de completude:** PCA-18 lista as pendências; PCA-15 responde 422 `PCA_INCOMPLETE` com `violations[]` (`PCA_ITEMS_REQUIRED` ou `PCA_ITEM_INCOMPLETE` com `itemId`, `code`, `field`) e nada é gravado. O botão "Enviar" fica desabilitado enquanto houver pendência.
- **FA-02 — Sem autoridade disponível:** nenhum detentor elegível (perfil sem ninguém, atribuição que não cobre o órgão, ou único detentor é quem envia) → 422 `APPROVER_UNRESOLVED` (`meta.reason` = `NO_HOLDER` ou `ONLY_SUBMITTER`); a mensagem orienta a falar com o administrador do órgão.
- **FA-03 — Plano devolvido e reenviado:** depois de `RETURN`/`REJECT` o plano volta a `DRAFT`; o planejamento corrige e envia de novo; é criada **nova** `Approval` (a anterior permanece no histórico) e o plano ganha novo `approvalId`.
- **FA-04 — Quem enviou tenta decidir:** APV-02 mostra `decisionBlocker = PCA_SELF_APPROVAL_FORBIDDEN` e esconde as decisões; APV-03 responde 403 `PCA_SELF_APPROVAL_FORBIDDEN` mesmo que a pessoa também tenha o perfil de autoridade.
- **FA-05 — Alguém sem designação tenta decidir:** quem tem `APPROVAL_DECIDE` mas não a atribuição que cobre o órgão do plano recebe 403 `NOT_DESIGNATED_APPROVER`.
- **FA-06 — Decisão já tomada:** com a aprovação já decidida ou retirada, APV-03 responde 409 `APPROVAL_NOT_PENDING` (verificado antes do `If-Match`); a tela recarrega e mostra a decisão registrada.
- **FA-07 — Retirada depois da decisão:** PCA-16 com o plano já `APPROVED`/`DRAFT` responde 409 `APPROVAL_NOT_PENDING` ou `INVALID_STATE`; a retirada nunca desfaz uma aprovação.
- **FA-08 — Plano editado entre abrir a tela e enviar:** `Pca.version` mudou → 412 `VERSION_CONFLICT`; a aba recarrega a lista de prontidão e o resumo.
- **FA-09 — Revisão (versão > 1):** o envio é o mesmo; a Approval traz "versão {n}" no título; o efeito sobre a versão anterior na aprovação é da US-141.
- **FA-10 — Retirada e APV-04/APV-05:** `POST /approvals/{id}/withdraw` e `/reassign` não se aplicam ao assunto `PCA` (responde 409 `INVALID_STATE`); a retirada é PCA-16.
- **FA-11 — Leitura sem escopo:** quem tem `PCA_VIEW` só de uma secretaria vê o estado do plano e a decisão, mas não a aba de lista de prontidão (exige `PCA_SUBMIT`).
- **FA-12 — Autoridade sem MFA válido:** APV-03 responde 403 `MFA_REQUIRED`; a tela leva ao desafio de MFA e retoma a decisão.

## Regras de negócio
- **RN-PCA-09** — A aprovação do PCA é feita pela autoridade competente por `Approval` de assunto `PCA`, com `processId` nulo; só há uma aprovação `PENDING` por plano (DEC-197; único parcial).
- **RN-PCA-10** — Enviar exige `PCA_SUBMIT`, escopo `ORGANIZATION` ou `TENANT`, ao menos um item e nenhum item com dado obrigatório faltando (DEC-197).
- **RN-PCA-11** — Decisão `RETURN` ou `REJECT`, ou retirada, devolve o plano a `DRAFT` com o comentário registrado; `APPROVE` define `approvedAt` e `approvedById` (DEC-197).
- **RN-PCA-12** — Plano `AWAITING_APPROVAL`, `APPROVED` ou `SUPERSEDED` não aceita alteração de itens, de título, importação nem exclusão; a mudança do aprovado só ocorre por nova versão (US-141) (DEC-197; POL-22).
- **RN-PCA-14** — O aprovador vem da cobertura da `AUTORIDADE_COMPETENTE` com `APPROVAL_DECIDE`, por designação na `Approval` de assunto `PCA` (POL-22; DEC-022, DEC-197).
- **RN-PCA-70** — Prontidão do envio (reavaliada na transação): (a) plano `DRAFT`; (b) ao menos 1 item não excluído (`PCA_ITEMS_REQUIRED`); (c) cada item com `code`, secretaria ativa do órgão, objeto de 10 a 2.000 caracteres, categoria ativa, `plannedValue` ≥ 0, `plannedMonth` de 1 a 12 e, em `POSTPONED`/`CANCELED`, motivo preenchido; responsável, unidade, tipo de contratação, quando informados, ativos (`PCA_ITEM_INCOMPLETE` com `field`); (d) não existir outro plano `APPROVED` do mesmo órgão e exercício que não seja a `previousVersionId` deste (`PCA_APPROVED_PLAN_EXISTS`, 409; defesa contra dado inconsistente); (e) aprovador resolvível (RN-PCA-72). As pendências de (b) e (c) saem em `violations[]` (até 100, `meta.violationsTotal`).
- **RN-PCA-71** — A `Approval` do PCA tem `subjectType = PCA`, `pcaId`, `processId`, `processStageId` e `documentId` nulos, `title` "Aprovação do PCA {year} — versão {n}", `requestedById` = quem enviou, `requestComment` opcional (até 2.000), `decisionPolicy = ANY`, `dueAt` nulo, uma linha `ApprovalApprover` (`sequence = 1`, `approverType = ROLE`, `approverRoleId` do perfil de autoridade, `allowDeputy = false`, `PENDING`) e nenhuma `ApprovalDocument`. Não há `ProcessAccess` nem entrada de timeline.
- **RN-PCA-72** — Resolução do aprovador: o perfil é o da chave `pca.approverRoleKey` (padrão `AUTORIDADE_COMPETENTE`, POL-22), ativo e com `APPROVAL_DECIDE`; é elegível quem tem vínculo `ACTIVE` não vencido e atribuição vigente do perfil com escopo `TENANT` ou `ORGANIZATION` igual ao órgão do plano (escopos de unidade e `CURRENT`/`HISTORICAL` não cobrem); quem envia é excluído. Sem nenhum elegível → `APPROVER_UNRESOLVED` (`NO_HOLDER`/`ONLY_SUBMITTER`).
- **RN-PCA-73** — Segregação (POL-22): quem enviou (`submittedById`) não decide a aprovação do plano; `getCoveredAuthors` devolve `[submittedById]` e a violação responde `PCA_SELF_APPROVAL_FORBIDDEN` (403). A regra independe de `approval.preventSelfApproval`.
- **RN-PCA-74** — Decisão de assunto `PCA`: `APPROVE`, `RETURN` ou `REJECT` por APV-03, sem `transitionId` nem avisos de workflow; `decisionComment` obrigatório (≥ 10 caracteres) em `RETURN`/`REJECT` e opcional em `APPROVE` (RN-TRAM-54/55); só sobre `Approval` `PENDING`; `If-Match` da aprovação; `APPROVAL_NOT_PENDING` antes de `VERSION_CONFLICT` (RN-TRAM-63); MFA exigido (POL-14).
- **RN-PCA-75** — `APPROVE` coloca o plano em `APPROVED` com `approvedAt` = instante da decisão e `approvedById` = decisor, na mesma transação da decisão; a unicidade de plano `APPROVED` por órgão e exercício é garantida pelo banco. Quando `versionNumber > 1`, a substituição da versão anterior segue a US-141.
- **RN-PCA-76** — `RETURN` e `REJECT` levam a aprovação a `RETURNED`/`REJECTED` e o plano a `DRAFT`, liberando a edição; o comentário fica na aprovação e aparece no histórico e no banner da aba; `submittedAt`, `submittedById` e `approvalId` permanecem até o próximo envio. A diferença entre devolver e rejeitar é semântica (pedido de ajuste × negativa) e visual; ambos permitem novo envio.
- **RN-PCA-77** — Retirada (PCA-16): `PCA_SUBMIT` com escopo de órgão (qualquer pessoa com a permissão, não só quem enviou), plano `AWAITING_APPROVAL` com `Approval` `PENDING`; a aprovação e a linha vão a `CANCELED` (`cancellationReason = WITHDRAWN`), o plano a `DRAFT`. O motivo opcional não é persistido nem publicado (só `hasReason`).
- **RN-PCA-78** — Estado do plano e eventos: cada transição (`DRAFT → AWAITING_APPROVAL`, `AWAITING_APPROVAL → APPROVED`, `AWAITING_APPROVAL → DRAFT`) publica um `PcaStatusChanged` (`fromStatus`, `toStatus`, `approvalId`) com routing key `pca.status_changed.<toStatus em minúsculas>`; `APPROVED` é também `PcaApproved`. O evento sai na mesma transação do fato.
- **RN-PCA-79** — Notificações: `ApprovalRequested` → `APPROVAL_REQUESTED` aos detentores elegíveis (máx. 50; in-app obrigatória; e-mail padrão ligado); `PcaStatusChanged` por decisão (`APPROVED` ou volta a `DRAFT`) → `PCA_APPROVAL_DECIDED` a quem enviou e aos vínculos com `PCA_MANAGE` no órgão (máx. 50), nunca o decisor; a retirada não notifica (a pessoa que retira é o ator e a aprovação sai da caixa do aprovador).
- **RN-PCA-80** — Ordem de travas e concorrência: toda operação trava primeiro a linha do plano e depois a da aprovação (evita *deadlock* entre envio, retirada e decisão); envio exige `If-Match` com `Pca.version`; retirada exige `If-Match`; segunda decisão ou retirada sobre aprovação já encerrada → `APPROVAL_NOT_PENDING` (409). Edição de item concorrente muda `Pca.version` e faz o envio falhar com 412.
- **RN-PCA-81** — Visibilidade: a aprovação de assunto `PCA` aparece em APV-01, APV-02 e TSK-01 para o aprovador designado, o solicitante, quem decidiu e quem tem `PCA_VIEW` com escopo cobrindo o plano; em APV-01/TSK-01 `process` é nulo e vem `pca { id, title, year, versionNumber }` (sem valores). O aprovador designado (enquanto `PENDING`) e quem decidiu leem o plano completo (cabeçalho, totais e itens) por PCA-01/PCA-03/PCA-06, mesmo sem `PCA_VIEW` ou com `PCA_VIEW` de menor escopo (leitura por aprovação).
- **RN-PCA-82** — Atomicidade e idempotência: envio, retirada e decisão gravam plano, aprovação, linha, auditoria e outbox na mesma transação; qualquer falha desfaz tudo. `Idempotency-Key` repete a resposta original; novo envio com plano já `AWAITING_APPROVAL` → 409 `INVALID_STATE`.
- **RN-PCA-83** — Histórico: PCA-17 lista as aprovações do plano (da versão consultada), da mais recente para a mais antiga, com `status`, `requestedBy`, `requestedAt`, `requestComment`, `decision`, `decidedBy`, `decidedAt`, `decisionComment`; visível a quem tem `PCA_VIEW` (qualquer escopo) ou é designado.
- **RN-PCA-84** — Prazo: a aprovação do PCA não tem `dueAt` no MVP 2 (sem SLA para o assunto `PCA`); a tela mostra "Sem prazo definido" e a visão de atrasadas não a inclui.

## Campos
**Envio, retirada e decisão**

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Comentário do envio | `comment` (PCA-15) → `Approval.requestComment` | texto | Não | até 2.000 caracteres | — |
| Versão do plano (cabeçalho `If-Match`) | `Pca.version` | inteiro | Sim | RN-PCA-80 | Última leitura |
| Motivo da retirada | `reason` (PCA-16) | texto | Não | até 2.000; não persistido (RN-PCA-77) | — |
| Decisão | `decision` (APV-03) | `ApprovalDecision` | Sim | `APPROVE`, `RETURN`, `REJECT` | — |
| Comentário da decisão | `comment` (APV-03) → `decisionComment` | texto | Condicional | ≥ 10 e ≤ 5.000; obrigatório em `RETURN`/`REJECT` | — |
| *(saída)* Situação do plano | `Pca.status` | `PcaPlanStatus` | — | `DRAFT`, `AWAITING_APPROVAL`, `APPROVED` | — |
| *(saída)* Enviado em / por | `submittedAt`, `submittedById` | data/hora, uuid | — | RN-PCA-76 | Envio |
| *(saída)* Aprovado em / por | `approvedAt`, `approvedById` | data/hora, uuid | — | RN-PCA-75 | Decisão |
| *(saída)* Aprovação vigente | `approvalId` | uuid | — | Última aprovação solicitada | Envio |
| *(saída)* Título da aprovação | `Approval.title` | texto (200) | — | RN-PCA-71 | "Aprovação do PCA {ano} — versão {n}" |

**Lista de prontidão (PCA-18)**

| Dado | Campo | Regras |
|---|---|---|
| Pode enviar | `canSubmit` | Verdadeiro sem pendência e com aprovador resolvível |
| Pendências | `violations[]` | `code` (`PCA_ITEMS_REQUIRED`, `PCA_ITEM_INCOMPLETE`), `severity = BLOCKING`, `itemId`, `itemCode`, `field`, `message` |
| Aprovador disponível | `approverResolved` | Booleano, sem nomes; `approverReason` (`NO_HOLDER`/`ONLY_SUBMITTER`) quando falso |
| Total de pendências | `meta.violationsTotal` | Lista truncada em 100 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Plano fora de `DRAFT` no envio (já enviado, aprovado ou substituído) | API | "Este plano não está em elaboração. Recarregue a página." | `INVALID_STATE` |
| V-02 | Plano sem itens | Front + API | "Inclua ao menos um item antes de enviar o plano." | `PCA_INCOMPLETE` (`PCA_ITEMS_REQUIRED`) |
| V-03 | Item com dado obrigatório faltando ou referência inativa | Front + API | "O item {código} está incompleto: {campo}." | `PCA_INCOMPLETE` (`PCA_ITEM_INCOMPLETE`) |
| V-04 | Já existe plano aprovado do órgão e exercício que não é a versão anterior | API | "Já existe um plano aprovado para {ano}. Para alterá-lo, crie uma revisão." | `PCA_APPROVED_PLAN_EXISTS` |
| V-05 | Nenhuma autoridade elegível para o órgão | API | "Não há autoridade competente disponível para aprovar este plano. Fale com o administrador do órgão." | `APPROVER_UNRESOLVED` |
| V-06 | `If-Match` ausente ou divergente (plano alterado) | API | "O plano foi alterado desde que você o abriu. Recarregue e envie de novo." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-07 | Comentário do envio acima de 2.000 caracteres | Front + API | "O comentário pode ter até 2.000 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-08 | Retirada fora de `AWAITING_APPROVAL` ou aprovação já encerrada | API | "Este plano não está aguardando decisão." | `APPROVAL_NOT_PENDING` / `INVALID_STATE` |
| V-09 | `decision` ausente ou fora do enum; comentário curto em `RETURN`/`REJECT` | Front + API | "Informe a decisão." / "Explique o motivo (mínimo de 10 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`) |
| V-10 | Decisão de quem enviou o plano | API | "Quem enviou o plano não pode decidir sobre ele." | `PCA_SELF_APPROVAL_FORBIDDEN` |
| V-11 | Decisão de quem não é o aprovador designado | API | "Você não é a autoridade designada para este plano." | `NOT_DESIGNATED_APPROVER` |
| V-12 | Decisão sobre aprovação já decidida ou retirada | API | "Esta aprovação já foi decidida ou retirada." | `APPROVAL_NOT_PENDING` |
| V-13 | MFA não validado na decisão | API | "Confirme sua identidade (MFA) para decidir." | `MFA_REQUIRED` |
| V-14 | Plano alterado fora da API durante a aprovação (tentativa de escrita em item) | API + banco | "Este plano não pode mais ser editado." | `PCA_NOT_EDITABLE` |
| V-15 | Retirada via APV-04/APV-05 de aprovação de assunto `PCA` | API | "Retire o plano pela tela do PCA." | `INVALID_STATE` |

## Permissões
- **Permissão:** `PCA_SUBMIT` com escopo `ORGANIZATION`/`TENANT` para PCA-15, PCA-16 e PCA-18; `PCA_VIEW` para PCA-17 (e para consultar plano e itens); `APPROVAL_DECIDE` + designação para APV-03; `APPROVAL_VIEW` ou designação/solicitação/decisão/`PCA_VIEW` para APV-02 (RN-PCA-81).
- **Políticas:** POL-22 (envio em `DRAFT`, aprovador `ROLE AUTORIDADE_COMPETENTE` cobrindo o órgão, segregação de quem enviou); POL-03 por linha (designação; para assunto `PCA`, o escopo `ROLE` cobre o órgão do plano); POL-14 (MFA em ação de risco `H`).
- **MFA:** exigido na decisão (`APPROVAL_DECIDE`, risco `H`), salvo dispensa explícita da política do tenant; não exigido no envio nem na retirada (`PCA_SUBMIT`, risco M), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Enviar para aprovação" e "Retirar" ficam ocultos sem `PCA_SUBMIT` de órgão; as decisões só aparecem para o designado que não enviou o plano. A API responde 403 `PERMISSION_DENIED` / `NOT_DESIGNATED_APPROVER` / `PCA_SELF_APPROVAL_FORBIDDEN` e registra `access.denied`; plano ou aprovação de outro tenant ou não visível → 404 (`NOT_FOUND` / `APPROVAL_NOT_FOUND`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalRequested` | `approval.requested` | Commit de PCA-15 | `subjectType = PCA`, `pcaId`, `decisionPolicy = ANY`, `approvers[]` (uma linha `ROLE`), `processId` nulo no envelope; `dueAt` ausente; consumidores T A N R |
| `PcaStatusChanged` | `pca.status_changed.awaiting_approval` | Commit de PCA-15 | `pcaId`, `organizationId`, `year`, `versionNumber`, `fromStatus = DRAFT`, `toStatus = AWAITING_APPROVAL`, `approvalId`; consumidor R |
| `ApprovalCompleted` | `approval.completed` | Commit de APV-03 com `APPROVE` | `subjectType = PCA`, `pcaId`, `votes[]`, `decidedAsDeputy = false`, `documentVersionIds[]` vazio |
| `PcaStatusChanged` (`PcaApproved`) | `pca.status_changed.approved` | Mesma transação do `APPROVE` | `fromStatus = AWAITING_APPROVAL`, `toStatus = APPROVED`, `approvalId`; consumidores N R X |
| `ApprovalReturned` / `ApprovalRejected` | `approval.returned` / `approval.rejected` | Commit de APV-03 com `RETURN` / `REJECT` | idem, `hasComment = true` |
| `PcaStatusChanged` | `pca.status_changed.draft` | Mesma transação de `RETURN`/`REJECT` e da retirada | `fromStatus = AWAITING_APPROVAL`, `toStatus = DRAFT`, `approvalId`; consumidores N (só por decisão) e R |
| `ApprovalCanceled` | `approval.canceled` | Commit de PCA-16 | `reason = WITHDRAWN`, `pcaId`, `processId` nulo |

Sem evento na leitura (PCA-17, PCA-18), em recusa de validação ou em rollback.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_REQUESTED` | Detentores elegíveis do perfil de autoridade com escopo sobre o órgão (máx. 50), exceto quem enviou | in-app (**obrigatória**) + e-mail (padrão ligado) | `ApprovalRequested` |
| `PCA_APPROVAL_DECIDED` | Quem enviou o plano e vínculos com `PCA_MANAGE` no órgão (máx. 50), exceto o decisor | in-app + e-mail (padrão ligado) | `PcaStatusChanged` para `APPROVED`, ou volta a `DRAFT` por decisão (`RETURN`/`REJECT`) |

A retirada não gera notificação. Agrupamento de 5 minutos, preferências do usuário (US-113) e a regra de nunca notificar o próprio ator valem; as mensagens citam exercício, versão e decisão, nunca valores.

## Critérios de aceite em Gherkin
```gherkin
Feature: Enviar o PCA para aprovação e decidir

  Background:
    Given que o tenant "Prefeitura A" está ativo com o órgão "Prefeitura Municipal"
    And o plano "PCA 2027" está em "DRAFT" com 116 itens completos
    And "Helena" tem "PCA_SUBMIT" com escopo "ORGANIZATION" e vínculo ativo
    And "Paulo" tem o perfil "AUTORIDADE_COMPETENTE" com escopo "ORGANIZATION" no órgão e "APPROVAL_DECIDE"

  Scenario: [Sucesso] Enviar o plano cria a aprovação e trava a edição
    When "Helena" enviar o plano com o comentário "Plano consolidado com as secretarias"
    Then a API deve responder 200 com o plano "AWAITING_APPROVAL", "submittedById" de "Helena" e "approvalId" preenchido
    And deve existir uma "Approval" "PENDING" de "subjectType" "PCA" com "processId" nulo, política "ANY" e uma linha "ROLE"
    And deve gerar registro de auditoria "pca.submit" e "approval.request"
    And deve gerar os eventos "ApprovalRequested" e "PcaStatusChanged" de "DRAFT" para "AWAITING_APPROVAL"
    And "Paulo" deve receber a notificação "APPROVAL_REQUESTED" e "Helena" não
    And qualquer escrita em item deve responder 409 "PCA_NOT_EDITABLE"

  Scenario: [Sucesso] A autoridade aprova e o plano fica vigente e imutável
    Given que "Helena" enviou o plano
    When "Paulo" decidir "APPROVE" com MFA válido
    Then a API deve responder 200 e o plano deve estar "APPROVED" com "approvedById" de "Paulo" e "approvedAt" preenchido
    And deve gerar registro de auditoria "approval.decide"
    And deve gerar os eventos "ApprovalCompleted" e "PcaStatusChanged" com routing key "pca.status_changed.approved"
    And "Helena" e os vínculos com "PCA_MANAGE" devem receber "PCA_APPROVAL_DECIDED" e "Paulo" não
    And nenhum item deve aceitar alteração de dados

  Scenario: [Sucesso] Devolução com comentário, correção e novo envio
    Given que "Helena" enviou o plano
    When "Paulo" decidir "RETURN" com o comentário "Revisar os valores da Saúde"
    Then o plano deve voltar a "DRAFT" com "approvedAt" nulo e a aprovação deve estar "RETURNED"
    And a aba Aprovação deve mostrar o comentário e os itens devem voltar a ser editáveis
    When "Helena" corrigir um item e enviar de novo
    Then deve existir uma nova "Approval" "PENDING" e a anterior deve continuar "RETURNED" no histórico
    And o histórico "GET /pcas/{id}/approvals" deve listar as duas aprovações

  Scenario: [Sucesso] Rejeição e retirada devolvem o plano a rascunho
    Given que "Helena" enviou o plano
    When "Paulo" decidir "REJECT" com o comentário "Plano fora das diretrizes do exercício"
    Then o plano deve estar "DRAFT" e deve gerar o evento "ApprovalRejected"
    When "Helena" enviar de novo e depois retirar a aprovação
    Then a aprovação deve estar "CANCELED" com motivo "WITHDRAWN" e o plano "DRAFT"
    And deve gerar o evento "ApprovalCanceled" e registro de auditoria "pca.withdraw"
    And ninguém deve receber "PCA_APPROVAL_DECIDED" pela retirada

  Scenario: [Validação] Plano sem itens, item incompleto e sem autoridade
    Given que o plano "PCA 2028" não tem itens
    When "Helena" enviar o plano "PCA 2028"
    Then a API deve responder 422 com código "PCA_INCOMPLETE" e violação "PCA_ITEMS_REQUIRED"
    Given que a categoria do item "0042" foi inativada
    When "Helena" enviar o plano "PCA 2027"
    Then a API deve responder 422 com código "PCA_INCOMPLETE" e violação "PCA_ITEM_INCOMPLETE" para o item "0042" no campo "categoryId"
    Given que ninguém além de "Helena" tem a atribuição de autoridade cobrindo o órgão e "Helena" também a tem
    When "Helena" enviar o plano
    Then a API deve responder 422 com código "APPROVER_UNRESOLVED" e "meta.reason" "ONLY_SUBMITTER"
    And nenhuma "Approval", mudança de status, auditoria ou evento deve ser gravado
    When "Paulo" decidir "RETURN" sem comentário
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" em "comment"

  Scenario: [Permissão] Sem PCA_SUBMIT, quem enviou decidindo e sem designação
    Given que "Bruno" tem apenas "PCA_MANAGE" e "PCA_VIEW"
    When "Bruno" tentar enviar o plano
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar "access.denied"
    Given que "Marina" tem "PCA_SUBMIT" e também o perfil "AUTORIDADE_COMPETENTE" e enviou o plano
    When "Marina" tentar decidir "APPROVE"
    Then a API deve responder 403 com código "PCA_SELF_APPROVAL_FORBIDDEN"
    Given que "Rui" tem "APPROVAL_DECIDE" mas atribuição de autoridade só na secretaria "Saúde"
    When "Rui" tentar decidir
    Then a API deve responder 403 com código "NOT_DESIGNATED_APPROVER"
    Given que "Caio" é "CONSULTOR_EXTERNO"
    When "Caio" chamar "GET /pcas/{id}/approvals"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Plano, aprovação e autoridade de outro tenant
    Given que existem o plano e a aprovação "A9" no tenant "Prefeitura B"
    When "Helena" chamar "POST /pcas/{id}/submit" com o id do plano da "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    When "Paulo" chamar "POST /approvals/A9/decide"
    Then a API deve responder 404 com código "APPROVAL_NOT_FOUND"
    Given que o único detentor do perfil de autoridade está no tenant "Prefeitura B"
    When "Helena" enviar o plano da "Prefeitura A"
    Then a API deve responder 422 com código "APPROVER_UNRESOLVED" sem revelar usuários de outro tenant

  Scenario: [Duplicidade] Segundo envio, reenvio idempotente e decisão repetida
    Given que "Helena" enviou o plano com a chave "k-140" e recebeu 200
    When a mesma requisição for reenviada com a chave "k-140"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir uma única "Approval" "PENDING" e um único evento "ApprovalRequested"
    When "Helena" enviar o plano de novo com outra chave
    Then a API deve responder 409 com código "INVALID_STATE"
    Given que "Paulo" aprovou o plano
    When "Paulo" repetir a decisão com outra chave
    Then a API deve responder 409 com código "APPROVAL_NOT_PENDING" sem gerar novo evento

  Scenario: [Concorrência] Edição, decisão e retirada simultâneas
    Given que "Helena" abriu o plano na versão 12 e "Marina" edita um item, levando o plano à versão 13
    When "Helena" enviar com "If-Match" 12
    Then a API deve responder 412 com código "VERSION_CONFLICT" e nada deve ser enviado
    Given que o plano está "AWAITING_APPROVAL"
    When "Paulo" decidir "APPROVE" e "Helena" retirar a aprovação ao mesmo tempo
    Then exatamente uma operação deve ter sucesso
    And a outra deve responder 409 com código "APPROVAL_NOT_PENDING"
    And o plano deve estar "APPROVED" ou "DRAFT" de acordo com a que venceu, sem estado intermediário
    Given que "Paulo" e "Antônia", ambos com a atribuição de autoridade, decidem ao mesmo tempo
    Then uma decisão deve ser registrada e a outra deve responder 409 "APPROVAL_NOT_PENDING"

  Scenario: [Falha de banco] Banco falha ao criar a aprovação ou registrar a decisão
    Given que o banco de dados falha ao inserir a linha da aprovação durante o envio
    When "Helena" enviar o plano
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o plano deve continuar "DRAFT" e editável, sem "Approval", auditoria ou evento
    Given que o banco falha ao gravar o plano durante "APPROVE"
    When "Paulo" decidir
    Then a aprovação deve continuar "PENDING", o plano "AWAITING_APPROVAL" e nenhum evento "PcaStatusChanged" deve existir

  Scenario: [Falha de integração] Redis das filas e SMTP indisponíveis
    Given que o Redis das filas está indisponível
    When "Helena" enviar o plano
    Then a API deve responder 200 com o plano "AWAITING_APPROVAL"
    And os eventos devem ficar "PENDING" no outbox até o relay voltar
    And quando o relay voltar, "Paulo" deve receber uma única notificação "APPROVAL_REQUESTED"
    Given que o SMTP está indisponível
    When "Paulo" aprovar o plano
    Then o plano deve estar "APPROVED" e a notificação in-app "PCA_APPROVAL_DECIDED" deve ser criada
    And o e-mail deve ficar para reenvio pela fila "email" sem bloquear a decisão
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Plano incompleto | 422 | `PCA_INCOMPLETE` | "O plano tem pendências: {lista}." | Lista as pendências com "Ir para o item" |
| Já existe plano aprovado do exercício | 409 | `PCA_APPROVED_PLAN_EXISTS` | "Já existe um plano aprovado para {ano}." | Oferece abrir o plano aprovado ou criar revisão |
| Sem autoridade elegível | 422 | `APPROVER_UNRESOLVED` | "Não há autoridade competente disponível para aprovar este plano. Fale com o administrador do órgão." | Mantém o diálogo e orienta o contato |
| Plano fora do estado esperado | 409 | `INVALID_STATE` | "Este plano não está em elaboração." | Recarrega o plano |
| Aprovação já decidida ou retirada | 409 | `APPROVAL_NOT_PENDING` | "Esta aprovação já foi decidida ou retirada." | Recarrega e mostra a decisão registrada |
| Plano em aprovação/aprovado sendo editado | 409 | `PCA_NOT_EDITABLE` | "Este plano não pode mais ser editado." | Itens em leitura |
| Plano ou versão alterados | 412 | `VERSION_CONFLICT` | "O plano foi alterado desde que você o abriu. Recarregue e tente de novo." | Recarrega prontidão e resumo |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue o registro e tente de novo." | Recarrega |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação no PCA." | Oculta a ação |
| Quem enviou tenta decidir | 403 | `PCA_SELF_APPROVAL_FORBIDDEN` | "Quem enviou o plano não pode decidir sobre ele." | Esconde as decisões |
| Não é o aprovador designado | 403 | `NOT_DESIGNATED_APPROVER` | "Você não é a autoridade designada para este plano." | Mostra a aprovação em leitura |
| MFA ausente | 403 | `MFA_REQUIRED` | "Confirme sua identidade (MFA) para decidir." | Abre o desafio de MFA |
| Plano ou aprovação de outro tenant | 404 | `NOT_FOUND` / `APPROVAL_NOT_FOUND` | "Plano ou aprovação não encontrado." | Volta à lista |
| Comentário inválido | 422 | `VALIDATION_ERROR` | "Explique o motivo (mínimo de 10 caracteres)." | Marca o campo |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente"; mantém os dados |

## Dependências
- **Stories:** US-051 (criação da `Approval`, resolução de aprovador `ROLE` e atomicidade), US-052 (decisão, RN-TRAM-54 a RN-TRAM-63), US-138 (plano e itens, trava e `Pca.version`). Indiretas: US-133 e US-134 (linhas e decisão por política; o PCA usa `ANY` com uma linha), US-136 (visões; lacuna 4 resolvida na RN-PCA-81), US-097 (autorização), US-111 a US-113 (notificações), US-090 (MFA). Habilita US-141 (revisão), US-142 (vínculo exige plano `APPROVED`), US-143 (reconciliação disparada pela aprovação), US-144 e US-145.
- **Decisões/ADRs:** DEC-197, DEC-022, DEC-193, DEC-013, DEC-108; POL-03, POL-14, POL-22; `domains.md` (porta `ApprovalSubjectHandler`).
- **Configurações:** `pca.approverRoleKey` (nova, ver lacuna 2); `approval.preventSelfApproval` não se aplica (RN-PCA-73); `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. **Rotas e IDs:** a feature lista `POST /pca/{id}/submit`, `POST /pca/{id}/withdraw` e `GET /pca/{id}/versions`; adotados `PCA-15` `POST /pcas/{pcaId}/submit`, `PCA-16` `POST /pcas/{pcaId}/withdraw`, `PCA-17` `GET /pcas/{pcaId}/approvals` (histórico) e `PCA-18` `GET /pcas/{pcaId}/submission-check` (prontidão); `PCA-19` fica reservado. A decisão reaproveita APV-03; a consulta, APV-02 (com `pca` aditivo).
  2. **Perfil aprovador "configurável":** POL-22 diz "`ROLE AUTORIDADE_COMPETENTE` (padrão, configurável)" mas não há chave nem tela. Proposta: chave de tenant `pca.approverRoleKey` (texto, padrão `AUTORIDADE_COMPETENTE`; deve ser perfil ativo com `APPROVAL_DECIDE`), editável por SET-02. **Dúvida de produto:** o órgão precisa mudar o perfil ou basta o padrão?
  3. **Códigos novos:** `PCA_INCOMPLETE` (422, com `violations[]`), `PCA_APPROVED_PLAN_EXISTS` (409); códigos de violação `PCA_ITEMS_REQUIRED` e `PCA_ITEM_INCOMPLETE`. `PCA_NOT_EDITABLE` e `PCA_SELF_APPROVAL_FORBIDDEN` vêm da POL-22. `APV-03` passa a devolver `PCA_SELF_APPROVAL_FORBIDDEN` (no lugar de `SELF_APPROVAL_FORBIDDEN`) para o assunto `PCA`.
  4. **Segregação incondicional:** POL-22 não menciona `approval.preventSelfApproval`; adotada regra fixa (RN-PCA-73). **Dúvida de produto:** em órgãos pequenos onde a mesma pessoa planeja e é a autoridade, deve haver exceção configurável?
  5. **Contrato de leitura de aprovação sem processo:** `APV-01`, `APV-02` e `TSK-01` precisam do objeto aditivo `pca { id, title, year, versionNumber, itemsCount, totalPlannedValue }` (valor só em APV-02) e de `decisionOptions[]` sem `transitionId` para o assunto `PCA`; a US-136 só garantiu `process` nulo. A leitura do plano por aprovação (RN-PCA-81) é uma capacidade implícita nova do aprovador, análoga ao `ProcessAccess` `APPROVER`, a registrar em `permissions.md §5.1`.
  6. **Trigger de imutabilidade:** `entities.md §4.1` bloqueia só `APPROVED`/`SUPERSEDED` em `pca_items`; é preciso incluir `AWAITING_APPROVAL` (também lacuna 4 da US-138).
  7. **Prazo da aprovação do PCA:** sem `dueAt` nem SLA (RN-PCA-84). **Dúvida de produto:** o órgão quer prazo de decisão e lembrete para a autoridade?
  8. **Notificação da retirada e da rejeição:** `PCA_APPROVAL_DECIDED` cobre aprovação e devolução/rejeição por decisão, não a retirada (adotado). Validar se o aprovador deve ser avisado da retirada (hoje a aprovação só some da caixa).
  9. **Aprovação múltipla para o PCA:** feature FT-069 diz "além da política já configurada na etapa de aprovação (EP-022)", mas o PCA não tem etapa; adotada política `ANY` com linha única. Estender exigiria configuração nova (EP-022).

## Impacto técnico
- **Estados do plano e da aprovação:** duas máquinas de estado (plano e `Approval`) alteradas na mesma transação, sempre na ordem plano → aprovação para evitar *deadlock*; o `PcaApprovalSubjectHandler` é o único ponto onde a decisão toca o plano, na transação de APV-03.
- **Aprovação sem processo:** exige que `approval`, `inbox`, `TimelineProjector` e `ProcessAccessProjector` tolerem `processId` nulo (checks M2-02; US-136 já aceita `process` nulo no contrato). Testes de contrato do MVP 1 (aprovações de etapa e avulsas) devem permanecer verdes.
- **Imutabilidade defensiva:** a regra vale na API e no banco (trigger estendido); jobs de importação e de reconciliação respeitam o estado do plano.
- **Resolução de aprovador:** consulta em lote por perfil, escopo e vínculo ativo (uma consulta); resultado depende de dados que mudam (atribuições), por isso é recalculado em cada envio e conferido de novo na decisão (POL-03).
- **Segurança:** valor previsto total só em APV-02 para quem pode ler o plano; mensagens de erro não revelam nomes de aprovadores; leitura por aprovação limitada ao tempo em que a aprovação é do usuário (`PENDING`) e ao histórico das que ele decidiu.
- **Compatibilidade:** campos novos são aditivos (DEC-108); APV-01/APV-02/APV-03 continuam iguais para os demais assuntos; `Approval.pcaId` e `processId` nulo vêm da migração M2-02; a visão `v_inbox_pending_approvals` v2 precisa expor aprovações sem processo.
- **Evolução:** a US-141 reaproveita o mesmo handler para a aprovação de revisão; a US-143 assina `pca.status_changed.approved`.

## Backend
- **Módulo(s):** `pca` (dono do plano, de `PcaApprovalSubjectHandler` e dos casos de uso de envio/retirada), `approval` (dono de `Approval`/`ApprovalApprover`, decisão e `ApprovalFacade`), `access` (detentores do perfil e escopos), `organization`, `notification`, `audit`, `platform` (outbox, idempotência).
- **Casos de uso:** `SubmitPcaCommand` (PCA-15), `WithdrawPcaApprovalCommand` (PCA-16), `ListPcaApprovalsQuery` (PCA-17), `GetPcaSubmissionCheckQuery` (PCA-18), `PcaSubmissionReadinessService`; reaproveita `RequestApprovalService` (estendido para o assunto `PCA`) e `DecideApprovalHandler` (APV-03).
- **Domínio:** `Pca.submit(approval)`, `Pca.approve(by, at)`, `Pca.returnToDraft()`; `PcaApprovalSubjectHandler` (`assertDecidable`, `getCoveredAuthors`, `onDecision`, `onCanceled`); `PcaApproverResolver` (perfil por chave, escopo do órgão, exclusão de quem envia); `PcaSubmissionPolicy`; `PcaEditGuard` (da US-138).
- **Integrações internas:** `ApprovalFacade.open(subject = PCA, lines)` / `cancel` / `decide`, `AccessFacade` (detentores), `OrganizationFacade`, `CatalogFacade` (referências ativas), `SettingsFacade` (`pca.approverRoleKey`), `OutboxWriter`, `AuditService`, `NotificationDispatcher`.
- **Transação:** envio — autorização → trava do plano → estado/versão → prontidão → aprovador → `Approval` e linha → plano `AWAITING_APPROVAL` → auditoria → outbox. Decisão — autorização e trava (plano e depois aprovação) → `assertDecidable` e segregação → decisão e encerramento → `onDecision` (plano) → auditoria → outbox, tudo no mesmo `tx`. Retirada — autorização → trava → cancelamento da aprovação e da linha → plano `DRAFT` → auditoria → outbox.

## Frontend
- **Tela(s):** SCR-018 (`/pca/[pcaId]`, aba **Aprovação**), SCR-014 (`/aprovacoes`) e SCR-015 (`/aprovacoes/[id]`) com o assunto PCA, SCR-013 (caixa de tarefas) e SCR-036 (notificações).
- **Componentes:** `PcaApprovalTab` (estado, *stepper* Elaboração → Em aprovação → Aprovado, banners de decisão), `PcaReadinessChecklist` (pendências com link ao item), `SubmitPcaDialog` (resumo e comentário), `WithdrawPcaDialog`, `PcaApprovalHistoryTable`, no SCR-015 `PcaApprovalSummaryCard` (exercício, versão, itens, valor, quem enviou, comentário, "Abrir o plano") dentro do `ApprovalDecisionPanel` existente (três botões e comentário), `ApprovalStatusBadge`.
- **Estados:** loading (skeleton da aba e do resumo); vazio ("Nenhuma aprovação registrada ainda"); erro por pendência ou por tipo (sem autoridade, plano alterado, decisão já tomada) com ação de recuperação; sucesso (toast "Plano enviado para aprovação" / "Aprovação registrada"); leitura (itens bloqueados com faixa de estado).
- **Acessibilidade e responsividade:** estado do plano por texto e ícone, não só por cor; pendências em lista com links e `aria-live` ao recalcular; botões de decisão com rótulo e `aria-pressed`; diálogos com foco preso; SCR-015 em coluna única e botões grandes abaixo de 768 px (uso móvel da autoridade); histórico em cartões no celular.

## Banco de dados
- **Tabelas:** `pcas` (`status`, `submitted_at`, `submitted_by_id`, `approval_id`, `approved_at`, `approved_by_id`), `approvals` (`pca_id`, `process_id` nulo, `subject_type = PCA`), `approval_approvers`, `pca_items` (trigger), `outbox_events`, `audit_logs`, `notifications`.
- **Migrações:** nenhuma nova além de M2-02 (aprovação sem processo, linhas, `approver_type` nulo permitido) e M2-11 (`pcas`); extensão do trigger de `pca_items` para `AWAITING_APPROVAL`; semente da chave `pca.approverRoleKey` em M2-21.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, pca_id) WHERE status = 'PENDING' AND subject_type = 'PCA'`; checks `subject_type <> 'PCA' OR (pca_id IS NOT NULL AND process_id IS NULL)` e `subject_type = 'PCA' OR process_id IS NOT NULL`; `status <> 'APPROVED' OR approved_at IS NOT NULL` em `pcas`; únicos parciais de `pcas` (um `APPROVED` e um em elaboração por órgão e exercício); índice `(tenant_id, pca_id, requested_at DESC)` em `approvals` para PCA-17; view `v_inbox_pending_approvals` v2 com `process` nulo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PCA-15` | POST | `/api/v1/pcas/{pcaId}/submit` | `{ comment? }` + `If-Match` (versão do plano) + `Idempotency-Key` | `200 { data: Pca, meta: { approval: { id, status, decisionPolicy, approvers[] } } }` + `ETag` nova | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PCA-16` | POST | `/api/v1/pcas/{pcaId}/withdraw` | `{ reason? }` + `If-Match` + `Idempotency-Key` | `200 { data: Pca }` + `ETag` nova | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PCA-17` | GET | `/api/v1/pcas/{pcaId}/approvals` | query `page`, `pageSize` | `200 { data: [{ approvalId, status, requestedBy, requestedAt, requestComment, decision, decidedBy, decidedAt, decisionComment }], meta }` | 200, 403, 404 |
| `PCA-18` | GET | `/api/v1/pcas/{pcaId}/submission-check` | — | `200 { data: { canSubmit, approverResolved, approverReason?, violations[] }, meta: { violationsTotal } }` | 200, 403, 404 |
| `APV-01` | GET | `/api/v1/approvals` | `subjectType = PCA` aceito (existente) | itens com `process` nulo e `pca { id, title, year, versionNumber }` (aditivo, sem valores) | 200, 422 |
| `APV-02` | GET | `/api/v1/approvals/{id}` | (existente) | `pca { id, title, year, versionNumber, itemsCount, totalPlannedValue, submittedBy }`; `meta.decisionOptions[]` com as três decisões sem `transitionId`; `decisionBlocker` inclui `PCA_SELF_APPROVAL_FORBIDDEN` | 200, 403, 404 |
| `APV-03` | POST | `/api/v1/approvals/{id}/decide` | `{ decision, comment? }` + `If-Match` + `Idempotency-Key` (existente; sem `transitionId`) | `200 { data: Approval }` com `pca { id, status }` | 200, 403, 404, 409, 412, 422 |
| `TSK-01` | GET | `/api/v1/tasks` | `view = PENDING_APPROVALS` (existente) | linhas com `process` nulo e `approval { id, title, subjectType = PCA, … }` | 200, 403 |

- **PCA-15 / PCA-16:** respondem com o plano completo (campos de `Pca` da US-138, mais `submittedAt`, `submittedById`, `approvalId`, `approvedAt`, `approvedById`). Erros: `PCA_INCOMPLETE` (com `violations[]` e `meta.violationsTotal`), `PCA_APPROVED_PLAN_EXISTS`, `APPROVER_UNRESOLVED` (`meta.reason`), `INVALID_STATE`, `APPROVAL_NOT_PENDING`.
- **APV-04 e APV-05** não se aplicam ao assunto `PCA` (responde 409 `INVALID_STATE`).
- **`meta.allowedActions` do plano (PCA-03, US-138):** passa a incluir `SUBMIT`, `WITHDRAW` e `DECIDE` conforme permissão, estado e designação.

## Logs
- `info` `pca.submitted` — `pcaId`, `approvalId`, `versionNumber`, `itemsCount`, `durationMs`.
- `info` `pca.approval_decided` — `pcaId`, `approvalId`, `decision`, `fromStatus`, `toStatus`.
- `info` `pca.approval_withdrawn` — `pcaId`, `approvalId`, `hasReason`.
- `warn` `pca.submit_rejected` — `reason` (`PCA_INCOMPLETE`, `APPROVER_UNRESOLVED`, `PCA_APPROVED_PLAN_EXISTS`, `VERSION_CONFLICT`, `INVALID_STATE`), `pcaId`, `violationsTotal?`.
- `warn` `pca.decision_rejected` — `reason` (`PCA_SELF_APPROVAL_FORBIDDEN`, `NOT_DESIGNATED_APPROVER`, `APPROVAL_NOT_PENDING`), `approvalId`.
- `error` `pca.approval_failed` — `errorCode`, `pcaId`, `correlationId`.
- Métricas: `cf_pca_submit_duration_ms`, `cf_pca_approval_cycle_seconds` (do envio à decisão, para o KPI "mediana ≤ 5 dias úteis").
- **Nunca logar:** comentários do envio e da decisão, valores previsto, nomes e e-mails de aprovadores ou de quem enviou.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `pca.submit` | `WORKFLOW` | Commit de PCA-15 | `changes.status` `DRAFT → AWAITING_APPROVAL`; `metadata`: `pcaId`, `year`, `versionNumber`, `approvalId`, `itemsCount`, `hasComment` |
| `approval.request` | `WORKFLOW` | Commit de PCA-15 (módulo `approval`) | `metadata`: `approvalId`, `subjectType = PCA`, `pcaId`, `decisionPolicy`, `approversCount = 1` |
| `approval.decide` | `WORKFLOW` | Commit de APV-03 | `changes`: `status`, `decision`; `metadata`: `subjectType = PCA`, `pcaId`, `year`, `versionNumber`, `fromStatus`, `toStatus`, `approvalApproverId`, `decidedAsDeputy` |
| `pca.withdraw` | `WORKFLOW` | Commit de PCA-16 | `changes.status` `AWAITING_APPROVAL → DRAFT`; `metadata`: `pcaId`, `approvalId`, `hasReason` |
| `approval.cancel` | `WORKFLOW` | Commit de PCA-16 (módulo `approval`) | `metadata`: `approvalId`, `reason = WITHDRAWN`, `subjectType = PCA` |
| `access.denied` | `ACCESS` | Tentativa sem permissão, sem designação ou de quem enviou | `reasonCode` (`PCA_SUBMIT`, `APPROVAL_DECIDE`, `PCA_SELF_APPROVAL_FORBIDDEN`), `pcaId`, `approvalId?` |

Os textos dos comentários não entram na auditoria (só `hasComment`/hash e tamanho). Nenhuma auditoria de leitura em PCA-17 e PCA-18.

## Testes necessários
- **Unitários:** `PcaSubmissionReadinessService` (sem item, item incompleto, referência inativa, motivo de situação, plano aprovado duplicado); `PcaApproverResolver` (escopo `TENANT`/`ORGANIZATION`, unidade não cobre, vínculo vencido, só quem envia); `Pca.submit/approve/returnToDraft` (transições válidas e inválidas); `PcaApprovalSubjectHandler.assertDecidable`/`getCoveredAuthors`; título da aprovação.
- **Integração (Testcontainers PostgreSQL + Redis):** envio atômico (plano, aprovação, linha, auditoria, outbox) e rollback total; decisão `APPROVE`/`RETURN`/`REJECT` com efeitos no plano na mesma transação; retirada; trigger de imutabilidade em `AWAITING_APPROVAL`/`APPROVED`; único de aprovação `PENDING` por plano; aprovação sem processo nos projetores e na view v2; notificações por evento sem duplicidade; contratos do MVP 1 (aprovação de etapa e avulsa) inalterados.
- **API/contrato:** PCA-15 a PCA-18; APV-01/02/03 e TSK-01 com assunto `PCA` (`process` nulo, `decisionOptions` sem `transitionId`); códigos novos e `violations[]`; `Idempotent-Replayed`.
- **RBAC e multi-tenant:** `PCA_SUBMIT` × escopo; designação do perfil de autoridade por escopo (órgão ≠ secretaria); `PCA_SELF_APPROVAL_FORBIDDEN` mesmo para quem também é autoridade; MFA na decisão; leitura por aprovação sem `PCA_VIEW`; plano e aprovação de outro tenant → 404 e autoridade de outro tenant ignorada (suíte `test/tenant-leak`).
- **Concorrência:** envio × edição de item (412); decisão × retirada; duas decisões simultâneas; dois envios simultâneos (um 200, outro 409); ordem de travas sem *deadlock*.
- **E2E (Playwright):** planejamento envia, autoridade aprova em SCR-015 com MFA e o plano fica imutável; devolução com comentário, correção e novo envio; retirada; plano sem autoridade disponível; leitura do plano pela autoridade.
- **Acessibilidade/performance:** axe na aba Aprovação, nos diálogos e no SCR-015 com assunto PCA; envio de plano com 2.000 itens dentro de 2 s (medido no endurecimento).

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
- [ ] Teste de contrato do MVP 1 (aprovações de etapa e avulsas) verde com o assunto `PCA` habilitado
- [ ] Segregação de quem enviou e imutabilidade do plano em aprovação verificadas na API e no banco

## Estimativa
**M** — reaproveita a solicitação e a decisão de aprovações (US-051/US-052/US-133/US-134) com um novo assunto sem processo, mas exige o `ApprovalSubjectHandler` do PCA, a resolução de aprovador por perfil e escopo de órgão, a prontidão do envio, a retirada, o histórico e ajustes de contrato nas listas.

## Prioridade
**P1** — sem aprovação o plano não fica vigente, não pode ser vinculado a DFD nem conciliado (US-142, US-143) e o critério de saída do MVP 2 pede PCA aprovado; depende apenas de US-138 e da mecânica de aprovação, por isso não é P0.
