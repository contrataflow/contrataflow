---
id: US-124
title: "Executar ramos paralelos no processo"
epic: EP-021
feature: FT-063
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-041, US-047, US-048, US-123]
modules: [process, workflow, approval, access, timeline, notification, audit, platform]
screens: [SCR-006]
endpoints: [PRC-39, PRC-04, PRC-08, PRC-09, PRC-10, PRC-11, PRC-19, PRC-20, PRC-21, PRC-22, PRC-23, PRC-24, PRC-25]
permissions: [PROCESS_VIEW, PROCESS_FORWARD, PROCESS_RETURN, PROCESS_CLAIM, PROCESS_ASSIGN, PROCESS_SUSPEND, PROCESS_CANCEL]
events: [ProcessBranchesOpened, ProcessBranchArrived, ProcessBranchesJoined, ProcessBranchesCanceled, ProcessStageChanged, ProcessStatusChanged, ProcessAssigned, ApprovalRequested, ApprovalCanceled]
---

# US-124 — Executar ramos paralelos no processo

## Título
Executar ramos paralelos no processo

## Descrição
**Como** responsável por uma etapa dentro de um ramo paralelo, **quero** trabalhar e encaminhar a minha etapa sem alterar a do outro ramo, e ver o processo seguir sozinho para a etapa seguinte quando o último ramo chegar à junção, **para** que Jurídico, Controle Interno ou outras áreas trabalhem ao mesmo tempo sem perda de rastreabilidade nem corrida entre eles.

A story entrega o **motor em execução** do paralelismo modelado na US-123 (DEC-194, ADR-005): entrada no `PARALLEL_SPLIT` (um `ProcessBranch` `OPEN` e uma `ProcessStage` `ACTIVE` por ramo), custódia e ações por etapa ativa (`processStageId`), conclusão de cada ramo, **junção na mesma transação** em que o último ramo chega, devolução dentro do ramo (fica no ramo) e devolução para antes da ramificação (cancela os demais ramos e as aprovações pendentes), status macro com várias etapas ativas e suspensão/cancelamento que atingem todos os ramos. A caixa de tarefas, o painel e os prazos por ramo são da US-125; a migração de processos em paralelismo é da US-127.

## Contexto
- No MVP 1 o processo tem **uma** `ProcessStage` ativa e `Process.currentStageId` é a fonte de verdade (US-041, US-047, US-048). DEC-194 muda a fonte de verdade para `ProcessStage` (`status = ACTIVE`) e mantém `currentStageId` por compatibilidade: aponta para a única etapa ativa ou, durante o paralelismo, para a `ProcessStage` do split; a API ganha `activeStages[]` de forma aditiva (DEC-108).
- `docs/mvp-02/entities.md` §4.7 (`ProcessBranch`), §5.1 (`Process`), §5.3 (`ProcessStage`: `branchKey`, `splitProcessStageId`, unique parcial por tronco e por ramo), §5.4 (`ProcessAssignment` único por etapa ativa), §5.5 (`ProcessMovement.branchKey`, `MovementMetadata.branch`/`canceledBranches`), §5.6 (`ProcessAccess` por ramo) e §6.7 (ciclo de vida) fixam o modelo. `permissions.md` §7 estende POL-01 (custódia por etapa ativa) e define `processStageId` e o erro `PROCESS_STAGE_REQUIRED` (422).
- O princípio da custódia (DEC-023) vale **por ramo**: quem está com um ramo não altera o outro. A serialização da junção é feita com `SELECT … FOR UPDATE` na `ProcessStage` do split (FT-063, riscos).
- A devolução e o encaminhamento do MVP 1 (US-047, US-048) continuam a regra-base: esta story só acrescenta o **alvo** (a etapa do ramo) e os efeitos de ramo. Aprovações dentro de um ramo seguem US-051/US-052/US-053; a decisão `APPROVE`/`RETURN` de uma etapa de ramo aciona o mesmo motor (`ApprovalSubjectHandler`).
- `events.md` define `ProcessBranchesOpened`, `ProcessBranchArrived`, `ProcessBranchesJoined`, `ProcessBranchesCanceled`, os campos aditivos de `ProcessStageChanged` (`branchKey`, `splitProcessStageId`, `activeStageIds[]`) e as entradas de timeline `BRANCHES_OPENED`/`BRANCH_ARRIVED`/`BRANCHES_JOINED`/`BRANCHES_CANCELED`.

## Objetivo
Garantir que um processo que entre numa ramificação sempre tenha exatamente uma etapa ativa por ramo aberto, que cada ramo possa ser encaminhado ou devolvido só por quem detém a sua custódia, e que a junção aconteça **uma única vez**, na transação do último ramo, sem etapa ativa órfã (100% das junções em teste de invariante).

## Persona
- **Principal:** Responsável de ramo — qualquer perfil com `PROCESS_FORWARD`/`PROCESS_RETURN` e custódia da etapa do ramo (ex.: `JURIDICO`, `CONTROLE_INTERNO`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) com `PROCESS_ASSIGN`/`PROCESS_SUSPEND`/`PROCESS_CANCEL`; aprovador da etapa `APPROVAL` de um ramo; Administrador do órgão (consulta); Sistema (`SYSTEM`) na junção automática.

## Pré-condições
- Versão de workflow publicada com bloco paralelo válido (US-123) e processo criado nela (a versão é fixada na criação — DEC-014).
- Processo `IN_PROGRESS`/`RETURNED` na etapa que antecede o split, com custódia do usuário (POL-01) e regras de saída satisfeitas (US-041).
- O usuário que age sobre um ramo tem a permissão da ação (`PROCESS_FORWARD`, `PROCESS_RETURN`, `PROCESS_CLAIM`, `PROCESS_ASSIGN`) cobrindo o processo e a custódia da **etapa do ramo** (responsável da `ProcessStage` ou lotado na unidade do ramo, se sem responsável).

## Fluxo principal
1. Na etapa anterior ao split, o responsável encaminha (PRC-19) pela transição que leva ao `PARALLEL_SPLIT`. O motor avalia as regras (US-041), resolve unidade e responsável de **cada** ramo e, na mesma transação, cria: a `ProcessStage` do split (`ACTIVE`, sem responsável), um `ProcessBranch` `OPEN` por transição de saída e a primeira `ProcessStage` de cada ramo (`ACTIVE`, com `branchKey` e `splitProcessStageId`), um `ProcessAssignment` por etapa de ramo e os `ProcessAccess` `DEPARTMENT/CURRENT` por ramo.
2. O processo passa a ter `currentStageId` = split, `activeStagesCount` = nº de ramos, `currentStageDueAt` = menor `dueAt` dos ramos e status macro por RN-WF2-16. São emitidos `ProcessBranchesOpened`, `ProcessStageChanged` (com `activeStageIds[]`) e, por ramo, `ProcessAssigned` quando a etapa resolve responsável; o timeline recebe `BRANCHES_OPENED` e cada responsável/unidade é notificado (`PARALLEL_BRANCH_RECEIVED`).
3. O responsável de um ramo abre o processo (SCR-006), vê as ações da **sua** etapa (PRC-08 devolve `stages[]` e as ações com `processStageId`) e, se necessário, assume a etapa (PRC-21) ou a atribui (PRC-22) informando `processStageId`.
4. Ao encaminhar dentro do ramo (PRC-19 com `processStageId`), o motor fecha a `ProcessStage` do ramo (`COMPLETED`) e abre a seguinte do **mesmo** ramo (`branchKey` herdado), com movimento `FORWARD` carregando `branchKey`; os demais ramos não são tocados.
5. Quando o responsável encaminha a **última** etapa do ramo para o `PARALLEL_JOIN`, o motor trava a `ProcessStage` do split (`FOR UPDATE`), marca o `ProcessBranch` como `ARRIVED` (`arrivedAt`), grava o movimento do ramo e emite `ProcessBranchArrived` (`openBranchesLeft`); o timeline mostra `BRANCH_ARRIVED`. O processo continua com as etapas dos ramos restantes.
6. Se esse era o **último** ramo `OPEN`, na **mesma transação** o motor avalia as regras de saída do join sobre o processo inteiro (`STAGE_EXIT` do join + `TRANSITION` da saída — RN-WF2-20), cria a `ProcessStage` do join já `COMPLETED`, fecha o split (`COMPLETED`), converte os `ProcessAccess` `CURRENT` dos ramos em `HISTORICAL` e entra na etapa de saída (`currentStageId` = nova etapa, unidade e responsável pelas regras do MVP 1; se for `APPROVAL`, solicita a aprovação como em US-051).
7. São emitidos `ProcessBranchesJoined` e `ProcessStageChanged` da junção para a etapa seguinte; o timeline recebe `BRANCHES_JOINED`; o responsável da etapa seguinte é notificado (`PARALLEL_BRANCHES_JOINED`). A auditoria registra `process.branch_join`.
8. **Devolução dentro do ramo:** PRC-20 com `processStageId` e `targetStageId` de etapa anterior do mesmo ramo reabre essa etapa (movimento `RETURN` com `branchKey`); o ramo fica `OPEN`, o status macro vira `RETURNED` enquanto a etapa reaberta estiver ativa e os outros ramos seguem normalmente.
9. **Devolução para antes da ramificação:** PRC-20 com `targetStageId` anterior ao split exige `confirmBranchCancellation = true` quando houver outros ramos `OPEN`. O motor cancela, na mesma transação, **todos** os ramos abertos (`ProcessBranch` e `ProcessStage` → `CANCELED`, a do ramo de origem → `RETURNED`), cancela as aprovações pendentes (motivo "Processo devolvido para etapa anterior à ramificação"), marca o split `RETURNED`, reabre a etapa de destino e emite `ProcessBranchesCanceled`, `ApprovalCanceled`, `ProcessStageChanged` e `ProcessStatusChanged` (`RETURNED`); o timeline mostra `BRANCHES_CANCELED`.
10. **Suspender/retomar e cancelar:** suspender (PRC-23) pausa **todas** as etapas ativas dos ramos; retomar (PRC-24) estende o `dueAt` de cada uma; cancelar (PRC-25) cancela ramos, etapas e aprovações pendentes (US-009).

## Fluxos alternativos
- **FA-01 — Um só ramo restante:** com um único ramo `OPEN`, `processStageId` deixa de ser obrigatório (a API infere a única etapa ativa), mas `currentStageId` continua apontando para o split até a junção.
- **FA-02 — Ramo com etapa `APPROVAL`:** o responsável encaminha para a etapa `APPROVAL` do ramo (aprovação solicitada como em US-051); a decisão `APPROVE` (APV-03) leva ao próximo passo do ramo ou ao join; `RETURN` e `REJECT` seguem as transições modeladas (RN-WF2-06 da US-123); a retirada (APV-04) volta o ramo à etapa anterior do mesmo ramo e **não** afeta os demais.
- **FA-03 — Regra de saída do join violada:** no encaminhamento do último ramo, se uma regra `BLOCKING` do join estiver violada, o PRC-19 responde 422 `TRANSITION_BLOCKED` com as violações e **nada** muda (o ramo continua `OPEN`); PRC-08 já mostra a ação desabilitada com os motivos.
- **FA-04 — Etapa seguinte à junção é `APPROVAL` sem aprovador resolvido:** `APPROVER_UNRESOLVED`/`DOCUMENT_INCOMPLETE` desfazem a junção inteira (como RN-TRAM-19): o ramo continua `OPEN`.
- **FA-05 — Ação sobre processo inteiro:** editar dados, suspender, cancelar e gerir participantes exigem custódia de **alguma** etapa ativa ou as permissões de gestor do MVP 1 (POL-01 estendida).
- **FA-06 — Etapa `START` do split já aceita:** se uma etapa de ramo não tem responsável (`UNASSIGNED`), ela entra na fila da unidade do ramo (aba "Na fila da minha unidade" — US-125) e qualquer lotado com `PROCESS_CLAIM` pode assumir **aquela** etapa.
- **FA-07 — Reenvio do mesmo encaminhamento:** repetir PRC-19 com a mesma `Idempotency-Key` devolve a mesma resposta (`Idempotent-Replayed: true`) sem novo movimento nem segunda junção.
- **FA-08 — Processo reentra no split depois de devolvido:** ao avançar de novo até o split, cria-se **nova** `ProcessStage` de split e **novos** `ProcessBranch`; os ramos antigos ficam no histórico (`CANCELED`/`ARRIVED`).

## Regras de negócio
- **RN-WF2-13** — Entrar no `PARALLEL_SPLIT` cria, em **uma** transação: a `ProcessStage` do split (`ACTIVE`, sem responsável), um `ProcessBranch` `OPEN` por transição `FORWARD` de saída e a primeira `ProcessStage` de cada ramo (`ACTIVE`), com `ProcessAssignment` (`STAGE_ENTRY`) e `ProcessAccess` `DEPARTMENT/CURRENT` por ramo; unidade, responsável e prazo de cada ramo seguem as regras do MVP 1 (RN-WF-30/31, RN-TRAM-07..10). Grava-se **um** movimento `FORWARD` (etapa anterior → split) com os ramos abertos em `metadata.labels`; os movimentos seguintes de cada ramo carregam `branchKey` e `metadata.branch` (DEC-194).
- **RN-WF2-14** — Estado do processo no paralelismo: `currentStageId` = `ProcessStage` do split; `currentWorkflowStageId` = a etapa do split; `currentDepartmentId` = unidade do primeiro ramo na ordem de exibição; `currentResponsibleId` = nulo; `currentStageDueAt` = menor `dueAt` entre as etapas ativas; `activeStagesCount` = nº de etapas ativas `TASK`/`APPROVAL`; `version` + 1 a cada mudança (DEC-194; `entities.md` §5.1).
- **RN-WF2-15** — A fonte de verdade das etapas ativas é `ProcessStage` com `status = ACTIVE` e tipo `TASK`/`APPROVAL`; o split ativo é a "raiz" do bloco e não é acionável. A API devolve `activeStages[]` (PRC-04, PRC-08) e `activeStagesCount`; leitores do MVP 1 que ignoram o campo continuam funcionando.
- **RN-WF2-16** — Status macro com várias etapas ativas (DEC-013, DEC-194): `RETURNED` se **alguma** etapa ativa foi aberta por devolução (`enteredViaMovement.action = RETURN`); senão `IN_PROGRESS` se **alguma** for `TASK`; senão `AWAITING_APPROVAL`. Recalculado a cada ramo que entra, avança, devolve ou chega; `ProcessStatusChanged` só quando o valor muda. A permissão de ação é avaliada **pelo tipo da etapa-alvo** (uma `APPROVAL` só se decide; uma `TASK` de outro ramo pode ser encaminhada mesmo com o status macro `AWAITING_APPROVAL`/`IN_PROGRESS` desde que o processo não esteja `SUSPENDED`/final).
- **RN-WF2-17** — Custódia por ramo (POL-01 estendida, DEC-023): `PROCESS_FORWARD`/`PROCESS_RETURN` exigem custódia da **etapa-alvo** (`assigneeId` da `ProcessStage` ou, sem responsável, lotação na `departmentId` da etapa); quem tem a custódia de um ramo **não** age sobre o outro (`NOT_PROCESS_CUSTODIAN`). Participantes nunca encaminham (DEC-036).
- **RN-WF2-18** — Alvo da ação: com **mais de uma** etapa ativa, `processStageId` é **obrigatório** em PRC-19, PRC-20, PRC-21 e PRC-22 (`PROCESS_STAGE_REQUIRED`, 422); deve ser uma `ProcessStage` `ACTIVE` tipo `TASK`/`APPROVAL` do processo (`PROCESS_STAGE_INVALID`, 422). `expectedStageId` passa a ser comparado com a etapa-alvo; se ela deixou de estar `ACTIVE` → 409 `STAGE_CHANGED`, antes do `If-Match` (RN-TRAM-03/30). O valor `currentStageId` de um processo em ramificação (o split) nunca é alvo válido.
- **RN-WF2-19** — Encaminhar **dentro do ramo**: a transição escolhida deve partir da etapa-alvo (RN-TRAM-04); a nova `ProcessStage` herda `branchKey` e `splitProcessStageId`; só a etapa-alvo é fechada; um responsável por ramo por vez (`unique (tenant_id, process_stage_id) WHERE is_active` — `entities.md` §5.4).
- **RN-WF2-20** — Chegada ao join: encaminhar/aprovar a **última** etapa de um ramo para o `PARALLEL_JOIN` (a) trava o split (`FOR UPDATE`); (b) marca o `ProcessBranch` `ARRIVED`; (c) emite `ProcessBranchArrived` com `openBranchesLeft`. Se `openBranchesLeft = 0`, na mesma transação avalia as regras `STAGE_EXIT` do join e `TRANSITION` da saída sobre o **processo inteiro** (RuleContext v1): `BLOCKING` violada → `TRANSITION_BLOCKED` e nada é gravado; avisos `WARNING` exigem `acknowledgedWarnings` no mesmo PRC-19; ramos que **não** são o último não avaliam as regras do join.
- **RN-WF2-21** — Junção: com o último ramo `ARRIVED`, cria a `ProcessStage` do join já `COMPLETED` (`enteredAt = exitedAt`), fecha o split (`COMPLETED`), converte os `ProcessAccess` `CURRENT` dos ramos em `HISTORICAL` e entra na etapa de saída pela transição única do join, resolvendo unidade, responsável, prazo e aprovação como em RN-TRAM-07..19; `currentStageId`, `currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId`, `currentStageDueAt`, `activeStagesCount` = 1 e `version` + 1. Eventos: `ProcessBranchesJoined` e `ProcessStageChanged`; auditoria `process.branch_join`. O processo **nunca** fica com etapa ativa órfã nem com o join pendente.
- **RN-WF2-22** — Devolução **dentro do ramo** (PRC-20 com destino no mesmo ramo): reabre a etapa de destino do ramo (`ProcessStage` `ACTIVE`, `enteredViaMovement.action = RETURN`, `ProcessAssignment` `RETURN`), fecha a etapa de origem como `RETURNED`, mantém o `ProcessBranch` `OPEN` e não toca nos demais ramos; vale o RN-TRAM-24 (destino já percorrido e configurado como destino de `RETURN`).
- **RN-WF2-23** — Devolução para **antes do split** (PRC-20 com destino fora do bloco): exige `confirmBranchCancellation = true` se houver outros ramos `OPEN` (`BRANCH_CANCELLATION_NOT_CONFIRMED`, 422); cancela **todos** os `ProcessBranch` `OPEN` (`CANCELED`, `canceledAt`, `cancellationReason` "Processo devolvido para etapa anterior à ramificação"), as `ProcessStage` ativas dos ramos (`CANCELED`; a do ramo de origem, `RETURNED`), os `ProcessAssignment` ativos e as aprovações `PENDING` desses ramos (`CANCELED`, `ApprovalCanceled` com `reason = BRANCH_CANCELED`), marca o split `RETURNED` e reabre a etapa de destino (RN-TRAM-23..30). Movimento `RETURN` com `metadata.canceledBranches[]`; eventos `ProcessBranchesCanceled` (`canceledBranchKeys[]`, `canceledApprovalIds[]`), `ProcessStageChanged`, `ProcessStatusChanged` (`RETURNED`); auditoria `process.branch_cancel` + `process.return`. Ramos já `ARRIVED` permanecem como histórico. Documentos não mudam de status (RN-TRAM-29, POL-11).
- **RN-WF2-24** — Concorrência: toda mutação de ramo (encaminhar, devolver, decidir aprovação, cancelar) adquire os locks na ordem **processo → `ProcessStage` do split → `ProcessStage` do ramo-alvo**, evitando deadlock; duas chegadas simultâneas ao join são serializadas e exatamente uma cria a junção; encaminhar um ramo enquanto outro devolve para antes do split resulta em `STAGE_CHANGED` (409) para quem perdeu a corrida (a etapa-alvo já não está `ACTIVE`). `If-Match` continua sendo `Process.version` (DEC-104): ações em ramos diferentes podem gerar `VERSION_CONFLICT` (412) benigno — o cliente recarrega e repete.
- **RN-WF2-25** — Suspensão e cancelamento: suspender pausa **todas** as `ProcessStage` ativas (`pausedAt`), retomar soma `pausedTotalSeconds` e estende cada `dueAt` (RN-TRAM-80); com o processo `SUSPENDED`, nenhuma ação de ramo é aceita (`INVALID_PROCESS_STATUS`). Cancelar o processo cancela os `ProcessBranch` `OPEN` (`cancellationReason` "Processo cancelado"), as etapas ativas e as aprovações pendentes pelos fluxos do MVP 1 (sem `ProcessBranchesCanceled`, que é próprio da devolução).
- **RN-WF2-26** — Rastreabilidade: `ProcessMovement` ganha `branchKey` e `MovementMetadata.branch`/`canceledBranches` (`entities.md` §5.5); PRC-11 aceita o filtro `branchKey` e devolve o campo; a timeline renderiza `BRANCHES_OPENED`, `BRANCH_ARRIVED`, `BRANCHES_JOINED` e `BRANCHES_CANCELED` e `PROCESS_FORWARDED`/`PROCESS_RETURNED` com `params.branchLabel` (`events.md` §3/§5). O prazo e os alertas do job `deadlines` (US-055) já operam por `ProcessStage` ativa e passam a levar `branchKey` (`ProcessStageDueSoon`/`Overdue`).
- **RN-WF2-27** — Visibilidade e acesso: cada ramo concede `ProcessAccess` `DEPARTMENT/CURRENT` à sua unidade e `USER/RESPONSIBLE` ao responsável da etapa; a junção converte os `CURRENT` dos ramos em `HISTORICAL`; a devolução para antes do split converte os `CURRENT` dos ramos cancelados em `HISTORICAL` e concede `CURRENT` à unidade da etapa reaberta (DEC-024).
- **RN-WF2-28** — Atomicidade e idempotência: etapas, ramos, atribuições, movimentos, acessos, aprovações, timeline, auditoria e outbox de cada operação gravam juntos ou nada é gravado; `Idempotency-Key` em PRC-19/PRC-20/PRC-21/PRC-23/PRC-24 reproduz a resposta sem reexecutar; nenhum valor de orçamento sigiloso entra em payload, timeline, notificação ou log (POL-09).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Etapa em que agir | `processStageId` | uuid | Condicional | Obrigatório se houver mais de uma etapa ativa (RN-WF2-18) em PRC-19/20/21/22; `ProcessStage` `ACTIVE` `TASK`/`APPROVAL` do processo | etapa do ramo selecionada na tela |
| *(sistema)* Etapa esperada | `expectedStageId` | uuid | Não | Se enviado, igual à etapa-alvo; senão `STAGE_CHANGED` | `processStageId` lido |
| Confirmo cancelar os outros ramos | `confirmBranchCancellation` | boolean | Condicional | Exigido em PRC-20 quando o destino é anterior ao split e há outros ramos `OPEN` | `false` |
| Destino da devolução | `targetStageId` | uuid | Sim (PRC-20) | Regras RN-TRAM-24 e RN-WF2-22/23 | `available-actions` |
| Comentário | `comment` | texto | Condicional | 10–5.000 (obrigatório em `RETURN`) | digitado |
| Ramo | `branchKey` | texto ≤ 60 | — | Somente leitura em movimentos, etapas e eventos | definição da versão |
| Etapas ativas | `activeStages[]` | lista | — | `{ processStageId, stageKey, stageName, stageType, branchKey\|null, department{id,name}, responsible{id,name}\|null, enteredAt, dueAt\|null, isOverdue, openedByReturn }` | PRC-04/PRC-08/PRC-39 |
| Etapas ativas (contagem) | `activeStagesCount` | smallint | — | 1 fora do paralelismo, ≥ 1 em ramificação, 0 em status finais | `Process` |
| Ramos do split | `branches[]` | lista | — | `{ branchKey, status, arrivedAt, canceledAt, cancellationReason, activeStage\|null, passes[] }` | PRC-39 |
| Ações por etapa | `stages[]` | lista | — | `{ processStageId, branchKey, stageKey, stageName, isMine }` (resumo em PRC-08) | PRC-08 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Mais de uma etapa ativa e `processStageId` ausente | API | "Escolha em qual ramo você quer agir." | `PROCESS_STAGE_REQUIRED` (422) |
| V-02 | `processStageId` não é etapa ativa `TASK`/`APPROVAL` do processo | API | "Essa etapa não está ativa neste processo. Atualize a página." | `PROCESS_STAGE_INVALID` (422) |
| V-03 | Etapa-alvo mudou desde a leitura (`expectedStageId`/etapa não `ACTIVE`) | API | "Este ramo já foi movimentado por outra pessoa. Atualize a página para ver a situação atual." | `STAGE_CHANGED` (409) |
| V-04 | Usuário sem custódia da etapa-alvo | API | "Este ramo está com outra pessoa ou outra unidade. Assuma a etapa ou peça a atribuição." | `NOT_PROCESS_CUSTODIAN` (403) |
| V-05 | Status do processo não permite a ação (`SUSPENDED`, `COMPLETED`, `CANCELED`…) | API | "O processo não pode ser movimentado no status atual." | `INVALID_PROCESS_STATUS` (409) |
| V-06 | Transição não pertence à etapa-alvo, não é `FORWARD` ou destino de devolução inválido | API | "Esta ação não está disponível para este ramo." | `TRANSITION_NOT_AVAILABLE` (422) |
| V-07 | Regra `BLOCKING` (da etapa, da transição ou do join no último ramo) não satisfeita | API | "Há pendências obrigatórias antes de encaminhar. Veja a lista e resolva." | `TRANSITION_BLOCKED` (422) |
| V-08 | Aviso `WARNING` não reconhecido | API | "Confirme que leu os avisos antes de encaminhar." | `WARNINGS_NOT_ACKNOWLEDGED` (422) |
| V-09 | Devolução para antes do split sem `confirmBranchCancellation` com outros ramos abertos | Front + API | "Devolver nesta etapa cancela os outros ramos e as aprovações pendentes. Confirme para continuar." | `BRANCH_CANCELLATION_NOT_CONFIRMED` (422) |
| V-10 | `comment` ausente/curto em `RETURN` | Front + API (Zod) | "Explique o motivo da devolução (mínimo 10 caracteres)." | `VALIDATION_ERROR` |
| V-11 | `If-Match` divergente / ausente | API | "O processo foi alterado. Atualize a página e tente de novo." | `VERSION_CONFLICT` (412) / `PRECONDITION_REQUIRED` (428) |
| V-12 | Etapa seguinte à junção é `APPROVAL` sem aprovador resolvível ou com documento incompleto | API | "Não foi possível encaminhar: falta aprovador ou documento completo na etapa seguinte." | `APPROVER_UNRESOLVED` / `DOCUMENT_INCOMPLETE` (422) |
| V-13 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta requisição já foi usada com outros dados." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `PROCESS_VIEW` (PRC-04/08/09/10/11/39); `PROCESS_FORWARD` (PRC-19), `PROCESS_RETURN` (PRC-20), `PROCESS_CLAIM` (PRC-21), `PROCESS_ASSIGN` ou titular da unidade (PRC-22), `PROCESS_SUSPEND` (PRC-23/24), `PROCESS_CANCEL` (PRC-25) — todas do MVP 1, com escopo que cubra o processo. Nenhuma permissão nova.
- **Políticas:** POL-01 (custódia **por etapa ativa**, estendida — `permissions.md` §7), POL-04 (assumir: lotado na unidade da etapa), POL-05 (atribuir), POL-06 (cancelar), POL-07 (suspender), POL-03/POL-17 (decisão e retirada de aprovação do ramo), POL-09 (sigilo). Visibilidade DEC-024.
- **MFA:** não exigido nestas ações (risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** a UI oculta/desabilita as ações do ramo com o motivo de `reasons[]`; a API responde 403 `PERMISSION_DENIED` ou `NOT_PROCESS_CUSTODIAN` e registra `access.denied`; processo não visível → 404 `PROCESS_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessBranchesOpened` | `process.branches_opened` | Entrada no `PARALLEL_SPLIT` | `movementId`, `splitProcessStageId`, `splitStageKey`, `branches[]` (`branchKey`, `processStageId`, `stageKey`, `departmentId`, `toUserId?`, `dueAt?`) |
| `ProcessBranchArrived` | `process.branch_arrived` | Última etapa de um ramo concluída rumo ao join | `splitProcessStageId`, `branchKey`, `movementId`, `openBranchesLeft` |
| `ProcessBranchesJoined` | `process.branches_joined` | Último ramo chega; junção na mesma transação | `splitProcessStageId`, `joinProcessStageId`, `nextStage { processStageId, key, type }`, `toDepartmentId` |
| `ProcessBranchesCanceled` | `process.branches_canceled` | `RETURN` para antes da ramificação | `splitProcessStageId`, `canceledBranchKeys[]`, `canceledApprovalIds[]`, `movementId` |
| `ProcessStageChanged` | `process.stage_changed.<cause>` | Encaminhar/devolver/junção | MVP 1 + `branchKey?`, `splitProcessStageId?`, `activeStageIds[]` (`events.md` §2); `fromStage`/`toStage` do ramo |
| `ProcessStatusChanged` | `process.status_changed.<status>` | Quando o status macro muda | Como no MVP 1 |
| `ProcessAssigned` | `process.assigned` | Responsável resolvido, assumir ou atribuir em etapa de ramo | MVP 1 |
| `ApprovalRequested` | `approval.requested` | Etapa `APPROVAL` alcançada (no ramo ou após a junção) | MVP 1 + `decisionPolicy`/`approvers[]` (EP-022) |
| `ApprovalCanceled` | `approval.canceled` | Devolução antes do split ou cancelamento | `reason` = `BRANCH_CANCELED` (aditivo) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PARALLEL_BRANCH_RECEIVED` | Responsável de cada ramo ou, sem responsável, lotados na unidade do ramo com `PROCESS_CLAIM` (máx. 50) | In-app + e-mail (padrão ✔) | `ProcessBranchesOpened` (como `PROCESS_RECEIVED`) |
| `PARALLEL_BRANCHES_JOINED` | Responsável da etapa de saída ou lotados na unidade | In-app + e-mail (padrão ✔) | `ProcessBranchesJoined` |
| `PROCESS_RETURNED` (MVP 1) | Responsável/unidade da etapa reaberta | In-app + e-mail | `ProcessStageChanged` (devolução dentro do ramo ou antes do split) |
| `APPROVAL_REQUESTED` (MVP 1) | Aprovador da etapa `APPROVAL` | In-app + e-mail | `ApprovalRequested` |
| `STAGE_DUE_SOON`/`STAGE_OVERDUE` (MVP 1) | Responsável do ramo (e titular da unidade em `STAGE_OVERDUE`) | In-app; e-mail conforme o padrão do tipo | Job `deadlines`, por etapa de ramo (US-055) |

Nunca notifica o próprio ator; sem valores sigilosos; agrupamento de 5 min e preferências do usuário (US-113).

## Critérios de aceite em Gherkin
```gherkin
Feature: Executar ramos paralelos no processo

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And a versão 2 do workflow "LICITACAO_COM_RAMOS" está publicada com o split "RAMIFICACAO_ANALISES" e os ramos "JURIDICO" e "CONTROLE_INTERNO" até a junção "JUNCAO_ANALISES"
    And o processo "0045/2026" está na etapa "TERMO_REFERENCIA" com "Carla" (perfil "PLANEJAMENTO") como responsável
    And "Paulo" (Jurídico) e "Rita" (Controle Interno) têm vínculo ativo, "PROCESS_FORWARD" e lotação nas unidades dos ramos

  Scenario: [Sucesso] Entrar no split abre um ramo por transição
    When "Carla" encaminhar o processo pela transição para "RAMIFICACAO_ANALISES"
    Then o processo deve ter duas etapas ativas: "JURIDICO" e "CONTROLE_INTERNO", cada uma com "branchKey" e "splitProcessStageId"
    And "currentStageId" deve apontar para a etapa do split e "currentResponsibleId" deve ser nulo
    And existem dois "ProcessBranch" com status "OPEN"
    And deve gerar registro de auditoria "process.branch_open"
    And deve gerar os eventos ProcessBranchesOpened e ProcessStageChanged com "activeStageIds" de 2 itens
    And deve gerar o evento ProcessAssigned para o ramo que resolve responsável individual
    And a timeline deve exibir "BRANCHES_OPENED" e "Paulo" e "Rita" devem receber "PARALLEL_BRANCH_RECEIVED"

  Scenario: [Sucesso] Concluir um ramo mantém o outro ativo e a junção acontece com o último
    Given que o processo está com os ramos "JURIDICO" (Paulo) e "CONTROLE_INTERNO" (Rita) abertos
    When "Paulo" encaminhar a etapa "JURIDICO" para a junção com "processStageId" do ramo
    Then o ramo "JURIDICO" deve ficar "ARRIVED" e o processo deve continuar com 1 etapa ativa
    And deve gerar registro de auditoria "process.forward" com "branchKey" "JURIDICO"
    And deve gerar o evento ProcessBranchArrived com "openBranchesLeft" igual a 1
    When "Rita" encaminhar a etapa "CONTROLE_INTERNO" para a junção
    Then a junção deve ser criada e fechada na mesma transação e o processo deve entrar em "AUTORIZACAO_LICITACAO"
    And "currentStageId" deve apontar para "AUTORIZACAO_LICITACAO" e "activeStagesCount" deve ser 1
    And deve gerar registro de auditoria "process.branch_join"
    And deve gerar os eventos ProcessBranchesJoined e ProcessStageChanged
    And a timeline deve exibir "BRANCHES_JOINED"

  Scenario: [Sucesso] Devolver dentro do ramo não afeta o outro
    Given que o ramo "JURIDICO" tem as etapas "ANALISE_JURIDICA" e "REVISAO_JURIDICA" e o processo está em "REVISAO_JURIDICA"
    When "Paulo" devolver "REVISAO_JURIDICA" para "ANALISE_JURIDICA" com o comentário "Faltou citar a cláusula de reajuste."
    Then o ramo "JURIDICO" deve continuar "OPEN" com "ANALISE_JURIDICA" ativa e o status do processo deve ser "RETURNED"
    And a etapa "CONTROLE_INTERNO" deve continuar ativa e sem alteração
    And deve gerar registro de auditoria "process.return" com "branchKey" "JURIDICO"

  Scenario: [Sucesso] Devolver para antes da ramificação cancela os outros ramos e as aprovações
    Given que há uma aprovação pendente na etapa "APROVACAO_CI" do ramo "CONTROLE_INTERNO"
    When "Paulo" devolver o processo para "TERMO_REFERENCIA" com "confirmBranchCancellation" verdadeiro e o comentário "Ajustar o objeto antes das análises."
    Then os dois ramos e as suas etapas ativas devem ficar "CANCELED" (a de "Paulo" "RETURNED") e a aprovação pendente "CANCELED" com o motivo "Processo devolvido para etapa anterior à ramificação"
    And "TERMO_REFERENCIA" deve ficar ativa com o status "RETURNED"
    And deve gerar registro de auditoria "process.branch_cancel"
    And deve gerar os eventos ProcessBranchesCanceled, ApprovalCanceled, ProcessStageChanged e ProcessStatusChanged para "RETURNED"
    And a timeline deve exibir "Ramos paralelos cancelados pela devolução para Termo de referência"

  Scenario: [Sucesso] Junção seguida de etapa de aprovação solicita a aprovação na mesma transação
    Given que a etapa de saída da junção é "AUTORIZACAO_LICITACAO" do tipo "APPROVAL" com o perfil "AUTORIDADE_COMPETENTE" resolvível
    And o ramo "JURIDICO" já está "ARRIVED"
    When "Rita" encaminhar o último ramo
    Then o processo deve ficar "AWAITING_APPROVAL" com uma aprovação "PENDING" para o perfil "AUTORIDADE_COMPETENTE"
    And deve gerar registro de auditoria "approval.request" e "process.branch_join"
    And deve gerar os eventos ApprovalRequested, ProcessBranchesJoined e ProcessStatusChanged

  Scenario: [Validação] Ação sem informar o ramo
    Given que o processo tem duas etapas ativas
    When "Paulo" encaminhar sem "processStageId"
    Then a API deve responder 422 com código "PROCESS_STAGE_REQUIRED"
    And nenhum movimento deve ser gravado

  Scenario: [Validação] Regra de saída da junção violada no último ramo
    Given que a junção tem a regra BLOCKING "Parecer jurídico finalizado" e o parecer está em "DRAFT"
    And o ramo "JURIDICO" já está "ARRIVED"
    When "Rita" encaminhar a etapa "CONTROLE_INTERNO" para a junção
    Then a API deve responder 422 com código "TRANSITION_BLOCKED" e a violação "Parecer jurídico finalizado"
    And o ramo "CONTROLE_INTERNO" deve continuar "OPEN" e nenhum evento ProcessBranchArrived deve ser gerado

  Scenario: [Validação] Devolver antes do split sem confirmar o cancelamento
    When "Paulo" devolver para "TERMO_REFERENCIA" sem "confirmBranchCancellation"
    Then a API deve responder 422 com código "BRANCH_CANCELLATION_NOT_CONFIRMED"

  Scenario: [Permissão] Quem tem um ramo não age no outro
    When "Paulo" encaminhar a etapa "CONTROLE_INTERNO" informando o "processStageId" de Rita
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Processo de outro tenant
    Given que existe o processo "0007/2026" do tenant "Prefeitura B" em ramificação
    When "Paulo", no tenant "Prefeitura A", consultar os ramos desse processo
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio do encaminhamento do último ramo
    Given que "Rita" encaminhou o último ramo com a "Idempotency-Key" "K-77" e recebeu 200
    When a mesma requisição for reenviada
    Then a API deve responder 200 com "Idempotent-Replayed" verdadeiro
    And não deve haver segunda junção, novo movimento nem novo evento ProcessBranchesJoined
    When "Rita" repetir o encaminhamento com outra chave
    Then a API deve responder 409 com código "STAGE_CHANGED"

  Scenario: [Concorrência] Os dois últimos ramos terminam ao mesmo tempo
    Given que "Paulo" e "Rita" encaminham os dois últimos ramos no mesmo instante
    When as duas requisições chegarem ao servidor
    Then exatamente uma junção deve ser criada e o processo deve ter uma única etapa ativa "AUTORIZACAO_LICITACAO"
    And nenhuma requisição deve ficar com erro 5xx e a segunda pode responder 412 "VERSION_CONFLICT" para ser repetida
    And deve existir exatamente um evento ProcessBranchesJoined

  Scenario: [Concorrência] Devolução para antes do split enquanto outro ramo é encaminhado
    Given que "Paulo" devolve para "TERMO_REFERENCIA" e "Rita" encaminha o ramo dela ao mesmo tempo
    When as duas requisições forem processadas
    Then a que perder a corrida deve responder 409 com código "STAGE_CHANGED"
    And o processo não deve ficar com etapa ativa de ramo cancelado

  Scenario: [Falha de banco] Falha no meio da junção
    Given que o banco falha após criar a etapa do join e antes de gravar a etapa seguinte
    When "Rita" encaminhar o último ramo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o ramo "CONTROLE_INTERNO" deve continuar "OPEN", o ramo "JURIDICO" "ARRIVED" e nenhuma etapa do join deve existir

  Scenario: [Falha de integração] Falha do SMTP não desfaz a junção
    Given que o provedor de e-mail (SMTP) está indisponível
    When "Rita" encaminhar o último ramo
    Then a API deve responder 200 e a junção deve estar concluída
    And a notificação "PARALLEL_BRANCHES_JOINED" in-app deve existir e o e-mail deve ficar na fila "email" para nova tentativa

  Scenario: [Falha de integração] Falha ao gravar no outbox
    Given que a gravação do evento no outbox falha dentro da transação
    When "Paulo" encaminhar o ramo "JURIDICO"
    Then a transação deve ser revertida e a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o ramo "JURIDICO" deve continuar "OPEN"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Ramo não informado com várias etapas ativas | 422 | `PROCESS_STAGE_REQUIRED` | "Escolha em qual ramo você quer agir." | Diálogo pré-seleciona o ramo do usuário |
| Etapa informada inválida | 422 | `PROCESS_STAGE_INVALID` | "Essa etapa não está ativa neste processo. Atualize a página." | Recarrega `activeStages[]` |
| Ramo já movimentado | 409 | `STAGE_CHANGED` | "Este ramo já foi movimentado por outra pessoa. Atualize a página." | Banner com "Atualizar" |
| Sem custódia do ramo | 403 | `NOT_PROCESS_CUSTODIAN` | "Este ramo está com outra pessoa ou unidade. Assuma a etapa ou peça a atribuição." | Ação desabilitada com o motivo |
| Status inválido | 409 | `INVALID_PROCESS_STATUS` | "O processo não pode ser movimentado no status atual." | Ações desabilitadas |
| Transição indisponível | 422 | `TRANSITION_NOT_AVAILABLE` | "Esta ação não está disponível para este ramo." | Recarrega ações |
| Regra bloqueante | 422 | `TRANSITION_BLOCKED` | "Há pendências obrigatórias antes de encaminhar." | `ChecklistDrawer` com violações |
| Aviso não reconhecido | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Confirme que leu os avisos antes de encaminhar." | Marca os avisos |
| Cancelamento de ramos não confirmado | 422 | `BRANCH_CANCELLATION_NOT_CONFIRMED` | "Devolver nesta etapa cancela os outros ramos e as aprovações pendentes. Confirme para continuar." | Diálogo de confirmação com a lista de ramos |
| Aprovador/documento da etapa seguinte | 422 | `APPROVER_UNRESOLVED` / `DOCUMENT_INCOMPLETE` | "Não foi possível encaminhar: falta aprovador ou documento completo na etapa seguinte." | Erro no diálogo; nada é alterado |
| `If-Match` divergente/ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "O processo foi alterado. Atualize a página e tente de novo." | Recarrega e mantém o comentário digitado |
| Corpo diferente com a mesma chave | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta requisição já foi usada com outros dados." | Gera nova chave |
| Processo inexistente/outro tenant | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Volta para a lista |
| Banco/outbox indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Toast com `correlationId` e "Tentar novamente" |

## Dependências
- **Stories:** US-123 (definição e `branchKey`), US-041 (motor e regras), US-047 (encaminhar), US-048 (devolver); US-051/US-052/US-053 (aprovação dentro do ramo), US-049/US-050 (assumir/atribuir), US-008/US-009 (suspender/cancelar), US-054/US-059 (movimentos e timeline), US-055 (prazos). Habilita US-125, US-127 (`PARALLEL_ACTIVE`) e os módulos de Jurídico/Controle Interno em ramos.
- **Decisões/ADRs:** DEC-194, DEC-013, DEC-023, DEC-024, DEC-026, DEC-104, DEC-108, DEC-180; [ADR-005](../adr/adr-005-workflow-engine.md).
- **Configurações:** nenhuma chave nova (`deadlines.warnBeforeBusinessDays` do MVP 1 vale por ramo).
- **Lacunas nas fontes canônicas:**
  - `api.md` do MVP 1: PRC-08 devolve `data: ActionEntry[]`; o resumo `stages[]` (previsto em `permissions.md` §9) entra como irmão aditivo de `data` e as entradas ganham `processStageId`/`branchKey`; confirmar no card 9.
  - Códigos novos sem registro prévio: `PROCESS_STAGE_INVALID` e `BRANCH_CANCELLATION_NOT_CONFIRMED` (a salvaguarda `confirmBranchCancellation` é uma decisão desta story); `PROCESS_STAGE_REQUIRED` consta de `permissions.md` §7 mas não do catálogo de erros de `api.md`.
  - `events.md` define `ProcessBranchesOpened.movementId` mas não como o movimento único da entrada no split registra os ramos: adotado `metadata.labels` (MVP 1); `ApprovalCanceled.reason = BRANCH_CANCELED` consta de `events.md` §2.
  - `entities.md` não diz se `ProcessBranch` `ARRIVED` vira `CANCELED` na devolução para antes do split: adotado o histórico (permanece `ARRIVED`; só ramos `OPEN` cancelam).
  - `entities.md` §5.1 mantém a unique `(tenant_id, process_id) WHERE ACTIVE AND branch_key IS NULL` (tronco); a contagem `activeStagesCount` exclui o split.
- **Resolução das lacunas (implementação, spec-647 · 2026-11-12):**
  - PRC-08: adotado `stages[]` irmão de `data` (só no paralelismo; fora dele a resposta do MVP 1 não muda) e `processStageId`/`branchKey` nas entradas `FORWARD`/`COMPLETE`/`RETURN`/`CLAIM`/`ASSIGN`; o motor roda uma vez por etapa ativa sobre a visão focada nela, e no último ramo `OPEN` a entrada para a junção já traz as regras do join.
  - Códigos `PROCESS_STAGE_REQUIRED`, `PROCESS_STAGE_INVALID` e `BRANCH_CANCELLATION_NOT_CONFIRMED` registrados no catálogo (`@contrataflow/types` · `error-catalog`), como em `api.md` MVP 2 §2.2.
  - Movimento único da entrada no split com os ramos em `metadata.labels.branches` (nomes das etapas); movimentos de ramo com `branchKey` e `metadata.branch`; a devolução para antes do split com `metadata.canceledBranches`.
  - Ramo `ARRIVED` permanece `ARRIVED` (histórico) na devolução para antes do split; só os `OPEN` cancelam.
  - A junção grava dois movimentos: o do ramo (etapa → passagem do join, `branchKey`) e a saída do join (join → etapa seguinte); a chegada de ramo que não fecha a junção grava o movimento do ramo com `toProcessStageId` nulo.
  - Na chegada/junção a primeira etapa de cada ramo e a etapa de saída da junção resolvem unidade, responsável, prazo e aprovador pelo `StageEntryResolver`; `CHOSEN_ON_FORWARD` nessas etapas (sem quem escolha) deixa o caminho indisponível (`TRANSITION_NOT_AVAILABLE`).
  - Aprovações pendentes canceladas pela devolução para antes do split devolvem os documentos cobertos a `DRAFT` (DEC-018, como no cancelamento do processo); os demais documentos não mudam.
  - `process_stages.stage_type` ganhou um gatilho que o preenche pela etapa da versão quando a inserção não o informa (cargas por SQL); a aplicação sempre o informa.

## Impacto técnico
- **Compatibilidade (DEC-108):** `currentStageId` continua preenchido (split no paralelismo); `activeStages[]`, `activeStagesCount`, `processStageId`, `branchKey` e `stages[]` são aditivos. Um leitor do MVP 1 que envie `expectedStageId = currentStageId` de um processo em ramificação recebe `STAGE_CHANGED`; a web do MVP 2 usa `activeStages[]` (teste de contrato cobre ambos).
- **Concorrência:** ordem fixa de locks (processo → split → ramo) e transação única por operação; serializa a junção e evita deadlock; `FOR UPDATE` só no split, nunca em todas as etapas.
- **Banco:** unique parciais do tronco e por ramo, unique de `ProcessAssignment` por etapa ativa, índice `(tenant_id, process_id) WHERE status='ACTIVE'` não único; trigger do `Process.workflowVersionId` inalterado aqui.
- **Performance:** PRC-04/PRC-08 devolvem `activeStages[]` com uma consulta por processo (≤ 10 ramos esperados); sem N+1 nas regras do join (avaliação única do contexto).
- **Eventos:** consumidores que assumiam "uma etapa ativa" (caixa de tarefas, painel, analytics) passam a ler `activeStageIds[]` (events.md §9); entregar junto com a US-125.
- **Risco principal:** corrida entre dois ramos e entre devolução × encaminhamento — mitigada por locks ordenados, `expectedStageId` e testes de invariante com paralelismo real.

## Backend
- **Módulo(s):** `process` (motor de ramos, movimentos, acessos), `workflow` (fachada de definição/snapshot e regras), `approval` (cancelamento/solicitação), `access`, `timeline`, `notification`, `audit`, `platform` (outbox, idempotência).
- **Casos de uso:** `ForwardProcessCommand` e `ReturnProcessCommand` (estendidos por etapa-alvo), `ClaimProcessCommand`/`AssignProcessCommand` (por etapa), `SuspendProcessCommand`/`ResumeProcessCommand`/`CancelProcessCommand` (todas as etapas ativas), `GetProcessBranchesQuery` (PRC-39), `BranchEngine` (`openBranches`, `arriveAtJoin`, `joinBranches`, `cancelBranches`), `ProcessStatusResolver` (status macro).
- **Domínio:** `ProcessBranch` (`OPEN` → `ARRIVED`/`CANCELED`), `ProcessStage` com `branchKey`/`splitProcessStageId`, `ActiveStageSet`, `BranchCustodyPolicy` (POL-01 por etapa); invariante "join fecha na transação do último ramo `OPEN`".
- **Integrações internas:** `workflow` (definição, regras e transições da versão fixada), `approval` (`requestApproval`, `cancelPendingForBranches`), `organization` (resolução de unidade/titular), `timeline`, `notification`, `access` (`ProcessAccess`).
- **Transação:** cada operação grava etapas, ramos, atribuições, movimento, acessos, aprovações, timeline, auditoria e outbox juntos; falha reverte tudo.

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`) — diálogos de encaminhar e de devolver do MVP 1, agora cientes do ramo (a visão geral dos ramos, o stepper e os cartões lado a lado são da US-125).
- **Componentes:** `BranchSelector` (escolhe o ramo quando o usuário tem ação em mais de um), `ForwardDialog`/`ReturnDialog` com `processStageId` fixado, `BranchCancellationConfirm` (lista os ramos e aprovações que serão cancelados), `BranchChip`, `ActionBar` por ramo (ação primária do ramo do usuário).
- **Estados:** loading (skeleton por bloco), vazio (processo sem ramificação: UI idêntica à do MVP 1), erro por bloco com "Tentar novamente", sucesso (toast "Ramo Jurídico encaminhado" / "Ramos concluídos — processo seguiu para {etapa}"), conflito (`STAGE_CHANGED`/412 com recarga).
- **Acessibilidade e responsividade:** ramo atual anunciado (`aria-live`) após cada ação; seleção de ramo por teclado; diálogo de cancelamento com foco preso e texto explícito; plenamente utilizável a partir de 360 px.

## Banco de dados
- **Tabelas:** `process_branches` (nova — `entities.md` §4.7), `process_stages` (+ `stage_type`, `branch_key`, `split_process_stage_id`), `process_assignments` (unique por etapa), `process_movements` (+ `branch_key`), `processes` (+ `active_stages_count`).
- **Migrações:** expand — colunas nulas, nova tabela com RLS, backfill de `stage_type` e `active_stages_count = 1` (0 em status finais); troca das unique parciais; `ALTER TYPE` de `ProcessStageStatus`/`StageType` não reversível. Contract não se aplica.
- **Índices/constraints relevantes:** `unique (tenant_id, split_process_stage_id, branch_key)` em `process_branches`; `unique (tenant_id, process_id) WHERE status='ACTIVE' AND branch_key IS NULL`; `unique (tenant_id, split_process_stage_id, branch_key) WHERE status='ACTIVE' AND branch_key IS NOT NULL`; check `(branch_key IS NULL) = (split_process_stage_id IS NULL)`; índice `process_branches (tenant_id, process_id) WHERE status='OPEN'`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-39 | GET | `/processes/{id}/branches` | path `id`; query `round?` (padrão a rodada atual) | `200 { data: { splitProcessStageId, splitStageKey, joinStageKey, status, openBranchesLeft, branches: [{ branchKey, status, arrivedAt, canceledAt, cancellationReason, activeStage: ActiveStage\|null, passes[] }], previousRounds: [{ splitProcessStageId, status }] } }`; `data: null` fora de ramificação | 200, 404 `PROCESS_NOT_FOUND` |
| PRC-04 | GET | `/processes/{id}` | — | MVP 1 + `activeStages[]`, `activeStagesCount` (aditivo; `currentStage` = split no paralelismo) | 200, 404 |
| PRC-08 | GET | `/processes/{id}/available-actions` | — | `{ data: ActionEntry[], stages?: [{ processStageId, branchKey, stageKey, stageName, isMine }] }`; entradas de etapa ganham `processStageId` e `branchKey`; razões incluem `PROCESS_STAGE_REQUIRED`, `NOT_PROCESS_CUSTODIAN`, `TRANSITION_BLOCKED` (inclui regras do join no último ramo) | 200, 404 |
| PRC-09 | GET | `/processes/{id}/checklist` | query `processStageId?` | MVP 1; sem o parâmetro agrega as pendências de todas as etapas ativas (`violations[].processStageId`, `branchKey`) | 200, 404 |
| PRC-10 | GET | `/processes/{id}/stages` | — | MVP 1 + `StageEntry.branchKey`, `isCurrent` verdadeiro em **cada** etapa ativa, `passes[].branchKey` | 200, 404 |
| PRC-11 | GET | `/processes/{id}/movements` | query `branchKey?` | MVP 1 + `branchKey` em cada movimento | 200, 404 |
| PRC-19 | POST | `/processes/{id}/forward` | MVP 1 + `processStageId?` (obrigatório com várias etapas ativas); `Idempotency-Key` e `If-Match` obrigatórios | `200 { data: Process }` + `activeStages[]`; `movement { id, sequence, branchKey? }` | 200, 403, 404, 409 (`STAGE_CHANGED`, `INVALID_PROCESS_STATUS`), 412, 422 |
| PRC-20 | POST | `/processes/{id}/return` | MVP 1 + `processStageId?`, `confirmBranchCancellation?` | `200 { data: Process }` + `activeStages[]` | 200, 403, 404, 409, 412, 422 |
| PRC-21 | POST | `/processes/{id}/claim` | corpo opcional `{ processStageId? }`; `If-Match` | `200 { data: Process }` | 200, 403, 404, 409 (`PROCESS_ALREADY_ASSIGNED`), 412, 422 |
| PRC-22 | POST | `/processes/{id}/assign` | MVP 1 + `processStageId?` | `200 { data: Process }` | 200, 403, 404, 409, 412, 422 |
| PRC-23 | POST | `/processes/{id}/suspend` | MVP 1 (`reason`) | `200` — pausa **todas** as etapas ativas (`activeStages[].pausedAt`) | 200, 403, 404, 409, 412, 422 |
| PRC-24 | POST | `/processes/{id}/resume` | MVP 1 | `200` — estende o `dueAt` de cada etapa ativa | 200, 403, 404, 409, 412 |
| PRC-25 | POST | `/processes/{id}/cancel` | MVP 1 | `200` — cancela ramos, etapas e aprovações pendentes | 200, 403, 404, 409, 412, 422 |

## Logs
- `info` `process.branches_opened` com `processId`, `splitStageKey`, `branches` (keys), `correlationId`.
- `info` `process.branch_arrived` com `processId`, `branchKey`, `openBranchesLeft`.
- `info` `process.branches_joined` com `processId`, `nextStageKey`, `durationMs`.
- `info` `process.branches_canceled` com `processId`, `canceledBranchKeys`, `canceledApprovals` (quantidade).
- `warn` `process.branch_race_lost` (STAGE_CHANGED/412 em ramo) com `processId`, `processStageId`.
- `error` `process.branch_invariant_violated` (junção sem fechar, etapa órfã) com `processId` e alerta.
- Nunca logar: valor estimado (POL-09), comentário de devolução, conteúdo de documentos, nomes de pessoas fora do `userId`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.branch_open` | `WORKFLOW` | Entrada no split | `metadata`: `movementId`, `splitStageKey`, `branches[]` (`branchKey`, `departmentId`, `toUserId?`) |
| `process.forward` | `WORKFLOW` | Encaminhar etapa de ramo (inclui chegada ao join) | `metadata`: `branchKey`, `processStageId`, `warningsAcknowledged`, `idempotencyKey` |
| `process.branch_join` | `WORKFLOW` (`actorType = SYSTEM` quando só a regra dispara) | Junção | `metadata`: `splitProcessStageId`, `joinProcessStageId`, `nextStageKey`, `rulesEvaluated` |
| `process.return` | `WORKFLOW` | Devolução (no ramo ou antes do split) | `metadata`: `branchKey`, `targetStageKey`, `canceledBranches[]` |
| `process.branch_cancel` | `WORKFLOW` | Devolução antes do split | `metadata`: `canceledBranchKeys[]`, `canceledApprovalIds[]`, `reason` |
| `process.claim`, `process.assign`, `process.suspend`, `process.resume`, `process.cancel` | `WORKFLOW` | Ações do MVP 1 sobre etapas de ramo | `metadata` + `processStageId`/`branchKey` quando aplicável |
| `access.denied` | `ACCESS` | 403 | permissão/custódia exigida |

## Testes necessários
- **Unitários:** `BranchEngine` (abrir 2, 3 e 5 ramos; chegada; junção; devolução dentro e antes do split; rodadas sucessivas), `ProcessStatusResolver` (tabela de combinações `TASK`/`APPROVAL`/`RETURNED`), `BranchCustodyPolicy`, resolução de `currentDepartmentId`/`currentStageDueAt`; teste de **invariante** (após cada operação aleatória: 1 tronco ativo, ≤ 1 etapa ativa por ramo `OPEN`, split ativo ⇔ algum ramo `OPEN`, `activeStagesCount` consistente).
- **Integração (Testcontainers):** transação única (rollback em falha no meio da junção e no outbox), unique parciais, `FOR UPDATE` do split com duas conexões, cancelamento de aprovações pendentes, `ProcessAccess` por ramo/`HISTORICAL` na junção.
- **API/contrato:** PRC-04/08/09/10/11/19/20/21/22/23/24/25/39 contra o OpenAPI; snapshot de que as respostas do MVP 1 (sem ramificação) **não mudam** e que `activeStages[]` é aditivo; erros `PROCESS_STAGE_REQUIRED`, `PROCESS_STAGE_INVALID`, `BRANCH_CANCELLATION_NOT_CONFIRMED`.
- **RBAC e multi-tenant:** custódia por ramo (Paulo × Rita), participante não encaminha, escopo por unidade; arquivo novo na suíte `test/tenant-leak` (PRC-39 e ações por `processStageId` entre tenants); `access.denied` auditado.
- **Concorrência:** os dois últimos ramos simultâneos (uma junção só), devolução × encaminhamento, reenvio idempotente, 20 execuções repetidas do cenário para detectar flakiness.
- **E2E (Playwright):** ramificar, trabalhar cada ramo com dois usuários, junção, devolução dentro do ramo e antes do split com o diálogo de confirmação.
- **Acessibilidade/performance:** axe nos diálogos; PRC-04/PRC-08 com 5 ramos dentro do orçamento do MVP 1 (p95 definido no teste de performance, medido no endurecimento); sem N+1 (contador de queries).

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
- [ ] Teste de invariante do motor de ramos (sem etapa ativa órfã) e teste de concorrência da junção estáveis
- [ ] Teste de contrato garantindo que leitores do MVP 1 continuam funcionando (`currentStageId`, ausência de `activeStages[]`)

## Estimativa
**L** — coração do motor: novo estado de ramos com junção serializada, custódia por etapa, devolução com cancelamento em cascata (ramos, etapas, aprovações), status macro e compatibilidade com leitores do MVP 1, exigindo testes de invariante e concorrência pesados. Sem integração externa.

## Prioridade
**P0** — primeiro card de implementação (DT-03, DEC-192): US-125 e a migração de processos em paralelismo (US-127) dependem do runtime, e o Jurídico/Controle Interno em ramos só funciona com ele.
