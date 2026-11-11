---
id: US-191
title: "Pausar e retomar prazos"
epic: EP-030
feature: FT-086
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-008, US-153, US-190]
modules: [sla, process, legal-review, approval, timeline, audit, platform]
screens: [SCR-006, SCR-121]
endpoints: [SLA-12, PRC-12, PRC-23, PRC-24]
permissions: [PROCESS_VIEW, PROCESS_SUSPEND]
events: [ProcessStageSlaPaused, ProcessStageSlaResumed]
---

# US-191 — Pausar e retomar prazos

## Título
Pausar e retomar prazos

## Descrição
**Como** responsável por uma etapa (ou gestor que acompanha o prazo), **quero** que o prazo da etapa fique pausado enquanto o processo está parado por motivo legítimo — suspensão do processo, diligência do jurídico ou uma condição que o órgão definiu —, e que volte a correr com o vencimento estendido pelo tempo pausado, **para** não perder prazo por algo que não depende de mim e para que o atraso real nunca fique escondido.

A story implementa, sobre o prazo gravado por US-190, as três causas de pausa da DEC-205 (`SlaPauseReason`): `PROCESS_SUSPENDED` (sempre implícita; mecanismo do MVP 1 generalizado), `LEGAL_DILIGENCE` (pausa a etapa do jurídico durante a diligência e retoma quando o processo volta, com o vencimento estendido) e `CONDITION` (regra do órgão, avaliada pelo job `deadlines`). Toda pausa e retomada é registrada na timeline, no evento de domínio e na auditoria; **não** gera notificação (events.md §6).

## Contexto
- No MVP 1 só a suspensão pausa o prazo: `PRC-23` grava `pausedAt` na etapa ativa e `PRC-24` estende `dueAt` por `n` dias úteis do intervalo pausado (US-008, RN-PROC-95/98/99; DEC-031). O job `deadlines` ignora etapas pausadas (RN-TRAM-81).
- A DEC-199 manda que o prazo da análise jurídica fique **pausado durante a diligência**: o jurídico devolve (`RETURN`) o processo a uma etapa anterior, a `LegalReview` passa a `DILIGENCE` e é **retomada** (não recriada) quando o processo volta a `JURIDICO`. A DEC-205 e o `SlaEvaluator` (events.md §3) tratam essa pausa: ele consome `LegalReviewDiligenceRequested` e `LegalReviewResumed` e "recalcula pausas e degraus pelo estado atual".
- `WorkflowStage.pauseSlaWhileReturned` (entities.md §5.8) declara quais etapas pausam o SLA quando devolvem por diligência — semeado `true` em `JURIDICO` e `CONTROLE_INTERNO` — e `SlaPolicy.pauseConditions` (US-189) declara, por política, quais causas pausam (`LEGAL_DILIGENCE`, `CONDITION`). `ProcessStage` ganhou `pauseReason` (a causa da pausa em curso); `pausedAt` e `pausedTotalSeconds` já existiam.
- A pausa **estende** o prazo; não o apaga: `overdueSince` já preenchido permanece (RN-PROC-99, FA-03/FA-04 da US-008), e os indicadores de cumprimento descontam e exibem `pausedSeconds` (DEC-206) para que a pausa não esconda atraso real (risco do épico).
- `ProcessStageSlaPaused` e `ProcessStageSlaResumed` projetam na timeline os tipos `SLA_PAUSED`/`SLA_RESUMED` (grupo "Prazos") e são consumidos pelo read model; **pausas de SLA não geram notificação**, só timeline e auditoria (events.md §6).
- US-153 (diligência e retomada da análise jurídica) é escrita à parte; esta story consome apenas os eventos que ela publica, citados em events.md §4.5: `LegalReviewDiligenceRequested` (`movementId`, `returnStageKey`, `occurredAt`) e `LegalReviewResumed` (`processStageId` da nova passagem por `JURIDICO`).

## Objetivo
Garantir que 100% das pausas legítimas estendam o vencimento exatamente pelo tempo pausado (em dias úteis ou corridos conforme a etapa), de forma idempotente e auditada, sem notificação, sem perder o instante real do início da pausa mesmo com atraso do worker e sem jamais esconder um atraso anterior à pausa.

## Persona
- **Principal:** Responsável pela etapa (`JURIDICO`, `PLANEJAMENTO`, `COMPRAS`, `CONTROLE_INTERNO`), que tem o prazo preservado enquanto aguarda.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), que acompanha prazos pausados e retomados; Administrador do órgão (`ADMIN_ORGAO`), que define as condições de pausa na política (US-189); Auditor (`AUDITOR`), que consulta `pausedSeconds` e o histórico.

## Pré-condições
- Passagem `ACTIVE` com `dueAt` preenchido (etapa sem prazo apenas acumula o tempo pausado e não emite evento de SLA).
- Para `LEGAL_DILIGENCE`: etapa devolvedora com `pauseSlaWhileReturned = true` **e** passagem com `slaPolicyId` cuja política tem `LEGAL_DILIGENCE` em `pauseConditions` (RN-SLA-40).
- Para `CONDITION`: passagem com `slaPolicyId` cuja política tem ao menos uma condição `CONDITION` com `rule` (US-189).
- Para `PROCESS_SUSPENDED`: nenhuma política é necessária (comportamento do MVP 1).
- Worker e fila `deadlines` ativos (o job a cada 15 minutos e o `SlaEvaluator`).

## Fluxo principal
**A — Diligência do jurídico**
1. O processo `0034/2026` está na etapa `JURIDICO` com `dueAt` em 23/03/2026 (política `PREGAO_ALTO_VALOR`, 15 dias úteis). O procurador pede diligência (US-153): o processo é devolvido a `TERMO_REFERENCIA` (`RETURN`), a `LegalReview` vai a `DILIGENCE` e o evento `LegalReviewDiligenceRequested` é publicado na mesma transação.
2. O `SlaEvaluator` (fila `deadlines`) recebe o evento, localiza a passagem de `JURIDICO` fechada pela devolução (`exitedViaMovementId = movementId`) e verifica a regra de RN-SLA-40. Atendida, grava `pausedAt` (instante do evento, não do processamento) e `pauseReason = LEGAL_DILIGENCE`, e publica `ProcessStageSlaPaused` (projeta `SLA_PAUSED` na timeline e audita `process.sla_pause`).
3. Durante a diligência o job `deadlines` não emite `ProcessStageDueSoon`, `ProcessStageOverdue` nem degraus para essa etapa.
4. O solicitante responde, e o processo volta a `JURIDICO` (nova passagem, com prazo resolvido normalmente por US-190). A `LegalReview` é retomada e o evento `LegalReviewResumed` (com o `processStageId` da nova passagem) é publicado.
5. O `SlaEvaluator` recebe o evento, calcula `n` = dias úteis do calendário do tenant no intervalo [data local do início da pausa, data local da retomada) (ou corridos se `slaType = CALENDAR`) e grava na nova passagem o **vencimento estendido** (`dueAt` da passagem pausada + `n`), herdando `slaPolicyId`, `slaDays` e `slaType`, com `pausedTotalSeconds` acumulado; encerra a pausa na passagem antiga (`pausedAt` e `pauseReason` nulos) e publica `ProcessStageSlaResumed` (`pausedSeconds`, `newDueAt`).
6. A timeline mostra "Prazo da etapa Jurídico pausado (diligência do jurídico)" e "Prazo retomado; novo vencimento 27/03/2026"; SCR-006 exibe o novo prazo e o total pausado.

**B — Suspensão do processo**
1. O gestor suspende o processo (PRC-23, `PROCESS_SUSPEND` + POL-07). Na mesma transação, **todas** as passagens ativas com `dueAt` recebem `pausedAt = agora` e `pauseReason = PROCESS_SUSPENDED`; é publicado `ProcessStageSlaPaused` por passagem e gravada a auditoria `process.sla_pause`.
2. Ao retomar (PRC-24), cada passagem tem `dueAt` estendido por `n` (mesmo cálculo), `pausedTotalSeconds` incrementado, e é publicado `ProcessStageSlaResumed`.

**C — Condição do órgão**
1. A política aplicada à passagem tem a condição `CONDITION` "o processo tem a etiqueta AGUARDANDO_FORNECEDOR". A cada ciclo de 15 minutos o job `deadlines` avalia a `rule` sobre o `RuleContext` v2 das passagens ativas, não pausadas, cujas políticas têm `CONDITION`.
2. Verdadeira: grava `pausedAt` (instante da avaliação) e `pauseReason = CONDITION`, publica `ProcessStageSlaPaused`. Quando a regra volta a ser falsa em ciclo posterior, retoma com `n` dias úteis do intervalo, estende `dueAt` e publica `ProcessStageSlaResumed`.

**Comum**
7. Em qualquer dos casos a retomada atualiza `Process.currentStageDueAt`, estende `Approval.dueAt` e `ApprovalApprover.dueAt` pendentes da etapa pelos mesmos `n` dias (RN-PROC-99) e reabre os avisos de prazo quando o novo vencimento ainda está no futuro.

## Fluxos alternativos
- **FA-01 — Etapa sem `dueAt`:** a pausa só acumula `pausedTotalSeconds`; nenhum evento de SLA é publicado (RN-SLA-41).
- **FA-02 — Sem política aplicada à devolução:** a diligência **não** pausa o prazo; a etapa de devolução e a `LegalReview` seguem seus próprios prazos (`legalReview.diligenceDueBusinessDays`); o comportamento é o do MVP 1 (RN-SLA-40; lacuna 1).
- **FA-03 — Etapa devolvedora sem `pauseSlaWhileReturned`:** nenhuma pausa por diligência, mesmo com política que liste `LEGAL_DILIGENCE`.
- **FA-04 — Regra `CONDITION` com erro de avaliação:** não pausa (*fail-closed*), a contagem continua e o erro vai para log `warn` sem expressão nem valores (RN-SLA-45).
- **FA-05 — Várias diligências:** cada ciclo pausa e retoma; os totais acumulam na passagem corrente (`pausedTotalSeconds`) e o vencimento é estendido a cada retomada (RN-SLA-44).
- **FA-06 — Processo suspenso durante diligência ou condição:** a suspensão assume a causa (`PROCESS_SUSPENDED`) sem alterar `pausedAt`; a retomada do processo encerra a pausa inteira, e o job reavalia `CONDITION` no ciclo seguinte (RN-SLA-46).
- **FA-07 — Etapa já atrasada antes da pausa:** `overdueSince` permanece; o badge mostra "Atrasado (pausado)"; na retomada, se o novo `dueAt` ainda estiver no passado, o atraso continua; se estiver no futuro, `overdueSince` é limpo e os avisos reabrem (RN-PROC-99).
- **FA-08 — Processo cancelado ou concluído durante a pausa:** a passagem encerra com a pausa em aberto, sem extensão; o `SlaEvaluator` ignora retomadas de passagens que não estão mais `ACTIVE` nem de diligência pendente.
- **FA-09 — Atraso do worker:** a pausa e a retomada usam o instante do **evento** (`occurredAt`), não o do processamento, para não perder nem ganhar tempo (RN-SLA-51).
- **FA-10 — Controle Interno devolve:** `pauseSlaWhileReturned` é semeado `true` em `CONTROLE_INTERNO`, mas não há evento de devolução do Controle Interno consumido pelo `SlaEvaluator` nem motivo de pausa correspondente; nesta story a devolução do Controle Interno **não** pausa o prazo (lacuna 2).
- **FA-11 — Política alterada durante a pausa:** `SlaPolicyChanged` reavalia as passagens que usam a política (RN-SLA-52); remover `CONDITION` da política retoma as passagens pausadas por ela.

## Regras de negócio
- **RN-SLA-39** — Causas e gatilhos: `PROCESS_SUSPENDED` (PRC-23/PRC-24, síncrono, sempre pausa, sem política); `LEGAL_DILIGENCE` (eventos `LegalReviewDiligenceRequested` e `LegalReviewResumed`, consumidos pelo `SlaEvaluator` na fila `deadlines`); `CONDITION` (avaliação da `rule` pelo job `deadlines`, a cada 15 minutos). Uma passagem tem no máximo uma causa registrada por vez (`pauseReason`).
- **RN-SLA-40** — `LEGAL_DILIGENCE` pausa a passagem de `JURIDICO` fechada pela devolução **somente** se a etapa tem `pauseSlaWhileReturned = true` **e** a passagem tem `slaPolicyId` cuja política lista `LEGAL_DILIGENCE` em `pauseConditions`. Sem política, a diligência não pausa o prazo (MVP 1 sem política continua igual — DEC-205). `CONDITION` só se avalia em passagem com `slaPolicyId` cuja política tem `CONDITION`.
- **RN-SLA-41** — Efeito da pausa: grava `pausedAt` e `pauseReason`; o job `deadlines` ignora a passagem pausada (nenhum `ProcessStageDueSoon`, `ProcessStageOverdue` ou degrau de escalonamento — RN-TRAM-81, US-192); `overdueSince` já preenchido é mantido. Passagem sem `dueAt` só acumula o tempo e não publica evento de SLA.
- **RN-SLA-42** — Retomada: `n` = dias úteis do calendário do tenant (feriados e `calendar.optionalHolidaysAreNonBusiness`) no intervalo [data local de `pausedAt`, data local da retomada) — dias corridos se `slaType = CALENDAR` (RN-PROC-98 generalizada para as três causas); novo `dueAt` = `dueAt` + `n` dias (úteis ou corridos), mantendo o fim do dia no fuso do tenant; `pausedTotalSeconds` += (retomada − `pausedAt`); `pausedAt` e `pauseReason` voltam a nulo; `Process.currentStageDueAt` é atualizado; `Approval.dueAt` e `ApprovalApprover.dueAt` pendentes da etapa são estendidos pelos mesmos `n` dias; se agora ≤ novo `dueAt`, `overdueSince` é limpo e `dueSoonNotifiedAt`/`overdueNotifiedAt` são zerados (RN-PROC-99); `escalationLevel` **não** é alterado (degrau já disparado não se repete — US-192). Etapa sem `dueAt` só acumula a pausa.
- **RN-SLA-43** — Retomada da diligência entre passagens: no `LegalReviewResumed`, a passagem ativa de `JURIDICO` (`processStageId` do evento) recebe `dueAt` = `dueAt` da passagem pausada + `n`, `slaPolicyId`/`slaDays`/`slaType` herdados dela e `pausedTotalSeconds` acumulado; a passagem antiga encerra a pausa. A resolução normal de US-190 na entrada da nova passagem vale apenas até esse ajuste. A operação é aplicada uma única vez (a pausa em aberto da passagem antiga é a trava).
- **RN-SLA-44** — Ciclos repetidos de diligência (rodadas) repetem pausa e retomada; `pausedTotalSeconds` e o vencimento acumulam, e cada ciclo gera seu par de eventos, entradas de timeline e auditorias.
- **RN-SLA-45** — `CONDITION`: o job avalia, por tenant, as passagens `ACTIVE` não pausadas (para pausar) e as pausadas por `CONDITION` (para retomar); a granularidade é a do ciclo (15 min), e `pausedAt` é o instante da avaliação. Expressão que falha na avaliação não pausa nem retoma (mantém o estado atual) e registra `warn`. Caminhos `sla.*` não são aceitos nessas regras (US-189 · RN-SLA-03).
- **RN-SLA-46** — Sobreposição de causas: vale a primeira registrada; a suspensão do processo **assume** a causa (`PROCESS_SUSPENDED`) sem alterar `pausedAt`; ao fim da causa vigente, o `SlaEvaluator` reavalia as demais e, se alguma continua verdadeira, troca `pauseReason` sem retomar (sem `ProcessStageSlaResumed` entre elas); caso contrário retoma. Ao retomar o processo (PRC-24) a pausa é encerrada por inteiro e o job reavalia `CONDITION` no ciclo seguinte.
- **RN-SLA-47** — Suspensão (PRC-23/PRC-24) mantém o mecanismo do MVP 1 e passa a: gravar `pauseReason = PROCESS_SUSPENDED`; atingir **todas** as passagens ativas com `dueAt` (inclusive ramos paralelos); publicar `ProcessStageSlaPaused`/`ProcessStageSlaResumed` na mesma transação do comando (produtor `process`); manter `Process.currentStageDueAt` e a extensão da aprovação pendente como antes. Sem política, o resultado de prazo é idêntico ao do MVP 1.
- **RN-SLA-48** — Registro: cada pausa e retomada publica o evento (`ProcessStageSlaPaused`: `processStageId`, `stageKey`, `reason`, `pausedAt`; `ProcessStageSlaResumed`: `processStageId`, `stageKey`, `reason`, `pausedSeconds`, `newDueAt`), projeta `SLA_PAUSED`/`SLA_RESUMED` na timeline (grupo "Prazos") e grava a auditoria `process.sla_pause`/`process.sla_resume` com `actorType = SYSTEM`; **nenhuma notificação** é criada (events.md §6; RN-SLA-06 da feature).
- **RN-SLA-49** — Idempotência: o `SlaEvaluator` reprocessa eventos sem duplicar efeitos — pausa já registrada com a mesma causa é no-op; retomada sem pausa em aberto é no-op; a trava é o estado da passagem (`pausedAt`/`pauseReason`) e a chave natural do evento; o consumo é "pelo estado atual" (events.md §3).
- **RN-SLA-50** — Transparência: SLA-12 e o SCR-006 exibem "Prazo pausado desde {data} ({motivo})", o total pausado (`pausedSeconds` = `pausedTotalSeconds`), o novo vencimento e, se houver, "Atrasado (pausado)"; o read model dos indicadores (EP-028) lê `pausedSeconds` para descontar e exibir a pausa, nunca para escondê-la.
- **RN-SLA-51** — Atraso de processamento: pausa e retomada por evento usam `occurredAt` do evento como instante de referência; uma pausa processada tardiamente é aplicada de forma retroativa ao instante correto; se o job emitiu `ProcessStageOverdue` na janela, o `overdueSince` é preservado e tratado pela regra de retomada (RN-PROC-99).
- **RN-SLA-52** — Reavaliação por mudança de política: `SlaPolicyChanged` aciona o `SlaEvaluator` para as passagens ativas com `slaPolicyId` da política; `CONDITION` removida retoma as pausadas por ela; `CONDITION` acrescentada passa a valer no próximo ciclo; desativar a política não retoma nem pausa nada (a política continua governando as passagens em curso — US-189 · RN-SLA-13).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Prazo pausado desde | `pausedAt` | datetime (somente leitura) | — | RN-SLA-41 | `ProcessStage` |
| Motivo da pausa | `pauseReason` | `SlaPauseReason` \| nulo | — | `PROCESS_SUSPENDED`, `LEGAL_DILIGENCE`, `CONDITION` | `ProcessStage` |
| Tempo pausado acumulado | `pausedSeconds` (`pausedTotalSeconds`) | inteiro (segundos) | — | RN-SLA-42, RN-SLA-44 | `ProcessStage` |
| Novo vencimento | `dueAt` / `newDueAt` (evento) | datetime | — | RN-SLA-42 | calculado |
| Etapa devolvedora pausa o SLA | `WorkflowStage.pauseSlaWhileReturned` | booleano | — | semeado `true` em `JURIDICO` e `CONTROLE_INTERNO` | configuração do workflow |
| Condição de pausa da política | `SlaPolicy.pauseConditions[]` | lista | — | US-189 · RN-SLA-08 | política |
| Atrasado desde | `overdueSince` | datetime | — | preservado na pausa | `ProcessStage` |
| Situação do prazo | `meta` de SLA-12 (`paused`, `overdue`) | booleanos | — | derivados | calculado |

Nenhum campo é editável por esta story: pausas e retomadas são efeitos do sistema.

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Evento de pausa para passagem inexistente, de outro tenant ou já encerrada sem pausa pendente | Worker (interno) | — | — (no-op; log `warn`) |
| V-02 | Evento de retomada sem pausa em aberto | Worker (interno) | — | — (no-op idempotente — RN-SLA-49) |
| V-03 | `rule` de `CONDITION` com falha de avaliação | Worker (interno) | — | — (não pausa; log `warn` — RN-SLA-45) |
| V-04 | Suspender processo já suspenso ou retomar não suspenso (herdado de US-008) | API | "O processo já está suspenso." / "O processo não está suspenso." | `INVALID_STATE` |
| V-05 | Suspender ou retomar sem `PROCESS_SUSPENDED` e POL-07 (herdado) | API | "Você não tem permissão para suspender este processo." | `PERMISSION_DENIED` |
| V-06 | SLA-12 para processo inexistente, de outro tenant ou não visível | API | "Processo não encontrado." | `PROCESS_NOT_FOUND` |
| V-07 | Banco indisponível durante a pausa/retomada síncrona (PRC-23/PRC-24) | API | "Não foi possível concluir a ação agora. Tente novamente em instantes." | `DEPENDENCY_UNAVAILABLE` |

## Permissões
- **Permissão:** pausas e retomadas por evento e por condição são efeitos do sistema (ator `SYSTEM`), sem permissão própria. `PROCESS_SUSPEND` + POL-07 continuam governando PRC-23/PRC-24 (a suspensão que pausa o prazo); `PROCESS_VIEW` (visibilidade DEC-024) para SLA-12 e para a timeline (PRC-12) que exibem pausa e retomada.
- **Políticas:** POL-07 (suspender/retomar), POL-27 (mudanças de política só valem para efeitos futuros), DEC-024.
- **MFA:** não exigido (`PROCESS_SUSPEND` e `PROCESS_VIEW` não são de risco `H`).
- **Sem permissão:** a API responde 403 `PERMISSION_DENIED` em PRC-23/PRC-24 e registra `access.denied`; processo não visível → 404 em SLA-12/PRC-12.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageSlaPaused` | `process.stage_sla_paused` | Início da pausa (diligência e condição pelo `SlaEvaluator`; suspensão na transação de PRC-23) | `processStageId`, `stageKey`, `reason` (`SlaPauseReason`), `pausedAt`; consumidores T (timeline `SLA_PAUSED`) e R (read model). Sem notificação |
| `ProcessStageSlaResumed` | `process.stage_sla_resumed` | Fim da pausa (`LegalReviewResumed`, regra `CONDITION` falsa, PRC-24) | `processStageId`, `stageKey`, `reason`, `pausedSeconds`, `newDueAt`; consumidores T (`SLA_RESUMED`) e R |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: pausas e retomadas de SLA não geram notificação (events.md §6); ficam na timeline e na auditoria. As notificações de diligência (`LEGAL_DILIGENCE_REQUESTED`, `LEGAL_DILIGENCE_REMINDER`) são de US-153. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Pausar e retomar prazos

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And a política ativa "PREGAO_ALTO_VALOR" tem 15 dias úteis na etapa "JURIDICO" e a pausa "LEGAL_DILIGENCE"
    And a etapa "JURIDICO" tem "pauseSlaWhileReturned" verdadeiro
    And o processo "0034/2026" entrou em "JURIDICO" em 02/03/2026 com "dueAt" em 23/03/2026 às 23:59:59.999
    And o calendário não tem feriados entre 02/03/2026 e 31/03/2026

  Scenario: [Sucesso] Diligência pausa o prazo e a retomada o estende
    When o procurador pedir diligência em terça-feira 10/03/2026 às 15:00 devolvendo o processo para "TERMO_REFERENCIA"
    And o "SlaEvaluator" processar o evento "LegalReviewDiligenceRequested"
    Then a passagem de "JURIDICO" deve ter "pausedAt" em 10/03/2026 15:00 e "pauseReason" "LEGAL_DILIGENCE"
    And deve gerar o evento "ProcessStageSlaPaused" e a entrada de timeline "SLA_PAUSED"
    And deve gerar registro de auditoria "process.sla_pause" com ator "SYSTEM"
    And nenhuma notificação deve ser criada
    When o processo voltar a "JURIDICO" em segunda-feira 16/03/2026 às 09:00 e o evento "LegalReviewResumed" for processado
    Then a nova passagem deve ter "dueAt" em 27/03/2026 às 23:59:59.999, pois 4 dias úteis (10, 11, 12 e 13/03) foram pausados
    And deve gerar o evento "ProcessStageSlaResumed" com "newDueAt" em 27/03/2026
    And deve gerar registro de auditoria "process.sla_resume" e a entrada de timeline "SLA_RESUMED"

  Scenario: [Sucesso] Suspensão do processo pausa e retoma o prazo
    When o gestor suspender o processo "0034/2026" em quinta-feira 12/03/2026 às 09:00
    Then a etapa ativa deve ter "pauseReason" "PROCESS_SUSPENDED" e deve gerar o evento "ProcessStageSlaPaused"
    When o gestor retomar o processo em terça-feira 17/03/2026 às 08:00
    Then o "dueAt" deve ser 26/03/2026 às 23:59:59.999, pois 3 dias úteis (12, 13 e 16/03) foram pausados
    And deve gerar o evento "ProcessStageSlaResumed" e registro de auditoria "process.sla_resume"

  Scenario: [Sucesso] Condição do órgão pausa e retoma pelo job
    Given que a política "COMPRAS_GERAIS" tem a pausa "CONDITION" para "etiqueta AGUARDANDO_FORNECEDOR"
    And o processo "0041/2026" está em "COMPRAS" com "dueAt" em 20/03/2026
    When a etiqueta for aplicada em terça-feira 10/03/2026 às 10:05 e o job "deadlines" executar às 10:15
    Then a etapa deve ter "pausedAt" em 10/03/2026 10:15 e "pauseReason" "CONDITION"
    When a etiqueta for removida em sexta-feira 13/03/2026 às 11:00 e o job executar às 11:15
    Then o "dueAt" deve ser 25/03/2026 às 23:59:59.999, pois 3 dias úteis (10, 11 e 12/03) foram pausados
    And devem ser gerados os eventos "ProcessStageSlaPaused" e "ProcessStageSlaResumed" com "reason" "CONDITION"

  Scenario: [Sucesso] Etapa pausada não gera atraso nem aviso
    Given que o processo "0034/2026" está pausado por diligência com "dueAt" em 11/03/2026
    When o job "deadlines" executar em 12/03/2026
    Then nenhum evento "ProcessStageOverdue" nem degrau de escalonamento deve ser emitido para a etapa pausada
    And a etapa deve aparecer como "Prazo pausado" no SLA-12

  Scenario: [Validação] Casos em que não há pausa
    Given que o processo "0035/2026" não tem política aplicada à etapa "JURIDICO"
    When o procurador pedir diligência nesse processo
    Then o "SlaEvaluator" não deve pausar o prazo e nenhum evento "ProcessStageSlaPaused" deve ser emitido
    Given que a regra "CONDITION" da política falha ao ser avaliada
    When o job "deadlines" executar
    Then a etapa não deve ser pausada, o prazo deve continuar correndo e deve ser registrado log "warn" "sla.pause_rule_failed"
    Given que a etapa não tem "dueAt"
    When o processo for suspendido e retomado
    Then apenas "pausedTotalSeconds" deve ser acumulado e nenhum evento de SLA deve ser emitido

  Scenario: [Permissão] Suspender sem permissão e consultar sem visibilidade
    Given que "Bruno Lopes" não possui "PROCESS_SUSPEND"
    When "Bruno Lopes" chamar "POST /processes/{id}/suspend"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And nenhuma pausa de SLA deve ser registrada
    And deve gerar registro de auditoria "access.denied"
    Given que "Bruno Lopes" não enxerga o processo "0034/2026" pela visibilidade
    When "Bruno Lopes" chamar "GET /processes/{id}/sla"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Tenant incorreto] Evento de outro tenant não pausa o prazo
    Given que o tenant "Prefeitura B" tem um processo com a mesma diligência e a mesma chave de etapa
    When o "SlaEvaluator" processar o evento "LegalReviewDiligenceRequested" do tenant "Prefeitura B"
    Then nenhuma passagem do tenant "Prefeitura A" deve ser alterada
    And a pausa deve ser aplicada somente no tenant "Prefeitura B"

  Scenario: [Duplicidade] Reprocessamento do mesmo evento
    Given que o evento "LegalReviewDiligenceRequested" já foi processado e a etapa está pausada
    When a fila entregar o mesmo evento novamente
    Then a etapa deve continuar com o mesmo "pausedAt" e não deve haver novo "ProcessStageSlaPaused" nem nova auditoria
    Given que o evento "LegalReviewResumed" já estendeu o "dueAt" para 27/03/2026
    When a fila entregar o mesmo evento novamente
    Then o "dueAt" deve continuar 27/03/2026 e não deve haver novo "ProcessStageSlaResumed"

  Scenario: [Concorrência] Retomada e job "deadlines" no mesmo instante
    Given que a etapa de "JURIDICO" está pausada com "dueAt" original já vencido
    When o "SlaEvaluator" retomar a etapa ao mesmo tempo em que o job "deadlines" varre as etapas
    Then o job não deve emitir "ProcessStageOverdue" com base no "dueAt" anterior à extensão
    And o "dueAt" final deve ser o valor estendido e "overdueSince" deve seguir a regra da retomada

  Scenario: [Falha de banco] Falha ao gravar a retomada
    Given que o banco de dados fica indisponível durante o tratamento de "LegalReviewResumed"
    When o "SlaEvaluator" processar o evento
    Then a transação deve ser desfeita, a pausa deve continuar em aberto e o evento deve voltar à fila para nova tentativa
    And ao recuperar o banco o "dueAt" deve ser estendido uma única vez

  Scenario: [Falha de integração] Fila indisponível quando a diligência é pedida
    Given que a fila "deadlines" e o Redis estão indisponíveis quando o procurador pede a diligência
    When o pedido de diligência for confirmado
    Then a API deve responder 200 e o evento "LegalReviewDiligenceRequested" deve permanecer "PENDING" no outbox
    And, quando a fila voltar, a pausa deve ser aplicada com "pausedAt" igual ao instante do pedido e não ao do processamento
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Suspender/retomar sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para suspender este processo." | Oculta a ação |
| Suspender processo já suspenso / retomar não suspenso | 409 | `INVALID_STATE` | "O processo já está suspenso." / "O processo não está suspenso." | Recarrega o processo |
| `If-Match` divergente em PRC-23/PRC-24 | 412 | `VERSION_CONFLICT` | "O processo foi alterado por outra pessoa. Recarregue e tente de novo." | Recarrega |
| Processo inexistente, de outro tenant ou não visível (SLA-12, PRC-12) | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Volta à lista |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a ação agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

As falhas do `SlaEvaluator` e do job `deadlines` não têm resposta HTTP: são tratadas por *retry* da fila (política padrão: 5 tentativas, backoff exponencial) e, esgotadas, vão à fila de falhas com alerta operacional.

## Dependências
- **Stories:** US-008 (suspender e retomar — mecanismo de `pausedAt` e extensão, generalizado aqui), US-153 (diligência e retomada da análise jurídica — origem de `LegalReviewDiligenceRequested` e `LegalReviewResumed`), US-190 (prazo e política gravados na passagem). Indiretas: US-189 (condições de pausa na política), US-055 (job `deadlines`, RN-TRAM-81), US-106 (calendário), US-192 (degraus não disparam em etapa pausada), US-124 (ramos paralelos), US-060/US-054 (timeline e movimentos), US-004 (SCR-006).
- **Decisões/ADRs:** DEC-205, DEC-199, DEC-031, DEC-206, DEC-194; ADR-015; POL-07, POL-27.
- **Configurações:** `calendar.optionalHolidaysAreNonBusiness`, `legalReview.diligenceDueBusinessDays` (prazo da diligência, independente), `WorkflowStage.pauseSlaWhileReturned` (por etapa).
- **Lacunas nas fontes canônicas:**
  1. **Diligência sem política (dúvida de produto):** a DEC-199 diz que o prazo da análise jurídica "fica pausado durante a diligência (DEC-205)", mas sem `SlaPolicy` aplicada não há quem declare a pausa; esta story pausa só com a combinação `pauseSlaWhileReturned` + política com `LEGAL_DILIGENCE` (RN-SLA-40). Alternativa: deixar `pauseSlaWhileReturned` bastar por si. Confirmar com o produto.
  2. **Controle Interno:** `pauseSlaWhileReturned` é semeado `true` em `CONTROLE_INTERNO` (entities.md §5.8/§9), mas o `SlaEvaluator` só assina eventos do jurídico (events.md §3), `SlaPauseReason` só tem `LEGAL_DILIGENCE` e não há evento de devolução do Controle Interno. Proposta: evento (`InternalControlReviewDiligenceRequested`/`Resumed`) e motivo (ex.: `INTERNAL_CONTROL_DILIGENCE`) em `entities.md §2` e `events.md §3/§4.6`, ou generalizar `LEGAL_DILIGENCE`.
  3. **Produtor dos eventos na suspensão:** `events.md §4.1` descreve `ProcessStageSlaPaused` como produzido pelo `SlaEvaluator` "(pausa por condição)"; aqui a suspensão (síncrona, na transação do comando) também os publica com `reason = PROCESS_SUSPENDED` para o read model ter um único registro de pausa. Isso adiciona uma entrada `SLA_PAUSED` na timeline ao lado de `PROCESS_SUSPENDED` (informações distintas). Confirmar.
  4. **Pausa registrada em passagem fechada:** na diligência a pausa fica na passagem de `JURIDICO` já devolvida (`pausedAt` em passagem não `ACTIVE`), e o vencimento estendido vai para a passagem seguinte; `entities.md §5.3` só descreve o índice de pausa para passagens `ACTIVE`. Confirmar o modelo (RN-SLA-43).
  5. **Granularidade de `CONDITION`:** não há evento que dispare a avaliação; depende do ciclo de 15 min do job (RN-SLA-45).
  6. **Ações de auditoria** `process.sla_pause`/`process.sla_resume` constam de `events.md §7` com ator `SYSTEM`; na suspensão elas são gravadas dentro da transação do usuário — confirmar se `actorType` deve refletir o usuário (`USER`) com `metadata.cause`.

## Impacto técnico
- **Concorrência real:** pausa, retomada, job `deadlines` e comandos de tramitação mexem na mesma `ProcessStage`; todas as escritas usam `SELECT … FOR UPDATE` na passagem (ou `SKIP LOCKED` no job) e o *guard* por estado (`pausedAt`/`pauseReason`) para idempotência e para não emitir `Overdue` sobre prazo já estendido.
- **Reuso do MVP 1:** o cálculo de `n` e a extensão da aprovação pendente são os de RN-PROC-98/99; a story extrai esse trecho de US-008 para um serviço compartilhado (`SlaPauseService`) usado por PRC-24, pelo `SlaEvaluator` e pelo job.
- **Retroatividade:** `occurredAt` do evento é a referência; o consumidor lê o estado atual e converge, mesmo com reentrega ou atraso do worker (events.md §3).
- **Risco de esconder atraso:** mitigado por manter `overdueSince`, exibir "Atrasado (pausado)", expor `pausedSeconds` e registrar tudo em timeline e auditoria.
- **Escopo de CONDITION:** o custo de avaliar regras a cada 15 minutos é limitado às passagens ativas cujas políticas têm `CONDITION`, em lotes por tenant, com o contexto montado de forma preguiçosa.
- **Compatibilidade:** campos aditivos (`pauseReason`, eventos novos); sem política, o único efeito visível é o par de eventos de SLA na suspensão (aditivo).

## Backend
- **Módulo(s):** `sla` (dono: `SlaEvaluator`, avaliação de `CONDITION`), `process` (`ProcessStage`, PRC-23/PRC-24, `SlaPauseService`, SLA-12, timeline), `legal-review` (produtor dos eventos consumidos), `approval` (extensão de `dueAt` pendente), `audit`, `platform` (fila `deadlines`, locks).
- **Casos de uso:** `SlaEvaluator.onLegalReviewDiligenceRequested`, `SlaEvaluator.onLegalReviewResumed`, `SlaEvaluator.onSlaPolicyChanged`; `ProcessDeadlinesJob` (estendido com a avaliação de `CONDITION`); `SuspendProcessCommand`/`ResumeProcessCommand` (estendidos para registrar `pauseReason` e eventos).
- **Domínio:** `ProcessStage.pause(reason, at)` / `ProcessStage.resume(at)` / `ProcessStage.carryOverPause(from, to)`; `SlaPauseService.computeExtension(pausedAt, resumedAt, slaType, calendar)`; `PauseReasonResolver` (RN-SLA-40, RN-SLA-46).
- **Integrações internas:** `BusinessCalendarFacade`, `RuleEvaluator`/`RuleContextV2Builder` (avaliação de `CONDITION`), `ApprovalFacade.extendPendingDueAt`, `TimelineProjector` (síncrono), `AuditService`, `OutboxWriter`.
- **Transação:** cada pausa/retomada é uma transação curta por passagem: bloqueio → conferência de estado → gravação em `process_stages` (e `approvals`/`approval_approvers` na retomada) → auditoria → outbox → projeção síncrona na timeline → commit.

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`) — bloco "Prazo" e linha do tempo; SCR-121 (`/admin/prazos`) — aba "Pausas" (cadastro, de US-189, com texto de efeito).
- **Componentes:** `StageDeadlineCard` com `PausedBadge` ("Prazo pausado desde 10/03 — diligência do jurídico", "Atrasado (pausado)"), `PausedTotalLabel`, entradas de timeline `SLA_PAUSED`/`SLA_RESUMED` com ícone e texto, filtro "Prazos" da timeline.
- **Estados:** normal, pausado (com motivo), retomado (novo vencimento), atrasado e pausado; skeleton; erro isolado do bloco.
- **Acessibilidade e responsividade:** estado de pausa por texto e ícone; mudança anunciada por `aria-live` ao revalidar; contraste AA; blocos em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `process_stages` (`paused_at`, `pause_reason`, `paused_total_seconds`, `due_at`, `overdue_since`, `due_soon_notified_at`, `overdue_notified_at`, `sla_policy_id`), `approvals` e `approval_approvers` (`due_at`), `processes` (`current_stage_due_at`), `audit_logs`, `outbox_events`, `timeline_entries`.
- **Migrações:** nenhuma nesta story (colunas criadas em M2-05; índice `(tenant_id, paused_at) WHERE paused_at IS NOT NULL AND status = 'ACTIVE'`).
- **Índices/constraints relevantes:** `(tenant_id, paused_at) WHERE paused_at IS NOT NULL AND status = 'ACTIVE'` (retomada pelo job); `(tenant_id, due_at) WHERE status = 'ACTIVE'` (varredura); possível índice para localizar passagem de `JURIDICO` fechada com pausa em aberto `(tenant_id, process_id) WHERE paused_at IS NOT NULL AND status <> 'ACTIVE'`, a confirmar na carga de teste (lacuna 4).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `SLA-12` | GET | `/api/v1/processes/{id}/sla` | path `id`; query `includeClosed` | `stages[]` com `pausedAt`, `pauseReason`, `pausedSeconds`, `dueAt`, `overdueSince` (campos criados em US-190, preenchidos aqui) | 200, 401, 403, 404, 422, 429, 503 |
| `PRC-12` | GET | `/api/v1/processes/{id}/timeline` | filtros do MVP 1 (grupo "Prazos") | entradas `SLA_PAUSED`/`SLA_RESUMED` com `params` (`stageName`, `reason`, `dueAt?`) | 200, 401, 403, 404, 429, 503 |
| `PRC-23` | POST | `/api/v1/processes/{id}/suspend` | `{ reason }` + `If-Match` + `Idempotency-Key` (US-008) | `200 { data: Process }`; passagens ativas pausadas com `pauseReason` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PRC-24` | POST | `/api/v1/processes/{id}/resume` | `{ comment? }` + `If-Match` + `Idempotency-Key` (US-008) | `200 { data: Process }`; `dueAt` estendido | 200, 403, 404, 409, 412, 422, 428, 503 |

Não há endpoint de escrita novo: pausar e retomar por diligência e por condição são efeitos de eventos e do job, sem rota manual.

## Logs
- `info` `sla.stage_paused` / `sla.stage_resumed` — `processStageId`, `reason`, `pausedSeconds`, `extensionBusinessDays`, `newDueAt`, `durationMs`, `correlationId`.
- `info` `sla.pause_noop` — evento reprocessado ou sem efeito (`reason`, `eventId`).
- `warn` `sla.pause_rule_failed` — `policyKey`, `errorCode` da avaliação (sem expressão nem valores); `warn` `sla.pause_target_not_found` (passagem não localizada).
- `error` `sla.pause_failed` — `errorCode`, causa resumida, `correlationId`; `error` `process.deadlines_job_failed` (já existente).
- **Nunca logar:** texto da diligência, justificativa de suspensão em texto livre, expressões de regra, valores do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.sla_pause` | `WORKFLOW` | Início de pausa (por evento, por condição ou por suspensão) | `metadata`: `processStageId`, `stageKey`, `reason`, `pausedAt`, `eventId?`, `movementId?`; `actorType = SYSTEM` |
| `process.sla_resume` | `WORKFLOW` | Fim de pausa | `changes`: `dueAt` (de → para); `metadata`: `reason`, `pausedSeconds`, `extensionDays`, `dayCountType` |
| `process.suspend` / `process.resume` | `WORKFLOW` | PRC-23/PRC-24 (US-008, inalteradas) | Como no MVP 1 |
| `access.denied` | `ACCESS` | 403 em PRC-23/PRC-24 | `reasonCode = PROCESS_SUSPEND` |

## Testes necessários
- **Unitários:** `SlaPauseService.computeExtension` (dias úteis com feriado e fim de semana, `CALENDAR`, intervalo no mesmo dia, virada de mês); `PauseReasonResolver` (sobreposição e troca de causa); regra de RN-SLA-40 (flag × política × motivo); `carryOverPause` (herança de política e acúmulo); guard de idempotência.
- **Integração (Testcontainers + relógio controlado):** diligência completa (pausa → retomada em nova passagem → dueAt estendido); suspensão com ramos paralelos; `CONDITION` pelo job (pausa e retomada); ciclos repetidos; atraso do worker (pausa retroativa por `occurredAt`); retomada com atraso preexistente; aprovação pendente estendida; rollback em falha de banco; reprocessamento do mesmo evento.
- **API/contrato:** SLA-12 e PRC-12 com campos de pausa; contrato do MVP 1 de PRC-23/PRC-24 inalterado sem política; eventos novos com `eventVersion = 1`.
- **RBAC e multi-tenant:** evento de outro tenant não altera passagens (suíte "tenant leak": `process_stages` pausadas, SLA-12); 403/404 conforme V-05/V-06.
- **Concorrência:** retomada × job `deadlines`; suspensão durante diligência; duas retomadas simultâneas (uma efetiva).
- **E2E (Playwright):** pedir diligência (US-153) → ver "Prazo pausado" no SCR-006 → processo volta → ver novo vencimento e a timeline; suspender/retomar; aplicar/remover a etiqueta de condição.
- **Acessibilidade/performance:** axe no bloco "Prazo" nos estados pausado e atrasado; job com 10.000 passagens ativas e 500 com `CONDITION` dentro da janela de 15 minutos (suíte de performance).

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
- [ ] Teste de contrato prova que, sem política, a suspensão e a retomada do MVP 1 têm o mesmo resultado de prazo
- [ ] Teste prova que a pausa nunca limpa um `overdueSince` anterior sem a regra de retomada e que pausa/retomada duplicadas são no-op
- [ ] Nenhuma notificação é criada por pausa ou retomada (teste de ausência)

## Estimativa
**M** — sem tabela nova: o esforço está em generalizar o mecanismo de pausa do MVP 1 para três causas, na retomada entre passagens da diligência, na avaliação de `CONDITION` pelo job e na idempotência e concorrência entre worker, job e comandos.

## Prioridade
**P1** — evita que o jurídico perca prazo na diligência (DEC-199) e dá confiança aos indicadores de cumprimento (DEC-206); depende de US-153 e de US-190 e não bloqueia as etapas P0 do DT-02/DT-03.
