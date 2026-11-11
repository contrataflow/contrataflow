---
id: US-125
title: "Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos"
epic: EP-021
feature: FT-063
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-004, US-055, US-056, US-124]
modules: [process, approval, access, notification]
screens: [SCR-013, SCR-006, SCR-014, SCR-015]
endpoints: [TSK-01, TSK-02, TSK-03, TSK-04, PRC-01, PRC-07, APV-01, APV-02]
permissions: [INBOX_VIEW, PROCESS_VIEW, PROCESS_CLAIM, PROCESS_ASSIGN]
events: [ProcessStageDueSoon, ProcessStageOverdue]
---

# US-125 — Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos

## Título
Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos

## Descrição
**Como** responsável por um ramo paralelo (ou gestor que acompanha o processo), **quero** ver na caixa de tarefas um item por ramo, no painel do processo as etapas ativas lado a lado e o prazo do processo como o menor prazo entre elas, **para** saber sem ambiguidade "quem está com o quê, até quando" quando duas áreas trabalham ao mesmo tempo.

A story leva o paralelismo da US-124 para as **leituras**: a caixa de tarefas (SCR-013 — TSK-01/TSK-02 e as ações em lote TSK-03/TSK-04) passa a listar e contar **uma linha por etapa ativa**; o painel situacional (SCR-006 — PRC-07, "Onde está?") lista as etapas ativas e destaca a minha; a lista de processos (PRC-01) e a tela de aprovações (SCR-014/SCR-015 — APV-01/APV-02) mostram o ramo; e o prazo do processo, os indicadores de atraso e os alertas passam a valer **por ramo**, com o menor `dueAt` como prazo do processo (DEC-194). Tudo é aditivo (DEC-108): sem ramificação, as respostas e telas são idênticas às do MVP 1.

## Contexto
- A caixa de tarefas não é entidade própria: é consulta em tempo real sobre `ProcessStage`/`ProcessAssignment` ativos e `Approval` `PENDING` (DEC-026, RN-INBOX-01). Como o paralelismo cria mais de uma etapa ativa por processo, a consulta passa naturalmente a produzir uma linha por etapa; esta story define o contrato dessas linhas, os contadores e as ações rápidas por ramo (RN-INBOX-02..13 do MVP 1 continuam).
- O painel situacional responde as sete perguntas da DEC-180 (RN-PROC-48). Com ramos, "onde está", "quem é o responsável" e "qual o próximo passo" deixam de ter resposta única: a US-004 passa a mostrar as etapas ativas lado a lado ("Onde está?" lista as etapas ativas — DEC-194).
- Prazos: o job `deadlines` já opera por `ProcessStage` ativa (RN-TRAM-81..85); `Process.currentStageDueAt` passa a ser o **menor** `dueAt` entre as etapas ativas (`entities.md` §5.1) e a custódia (DEC-023) vale por ramo. SLA com pausa e escalonamento por ramo é do EP-030 (fora desta story).
- `events.md` §2 acrescenta `branchKey?`, `slaPolicyKey?` e `escalationLevel?` a `ProcessStageDueSoon`/`ProcessStageOverdue` e §9 manda ajustar caixa de tarefas e dashboard na mesma entrega do paralelismo (DT-03).
- A US-124 já define `activeStages[]`, `processStageId` e os erros `PROCESS_STAGE_REQUIRED`/`STAGE_CHANGED`; aqui só se consome.

## Objetivo
Garantir que, para 100% dos processos com ramos, cada responsável veja exatamente os ramos que lhe cabem na caixa de tarefas, o painel mostre todas as etapas ativas com responsável e prazo próprios e o prazo do processo seja o menor entre elas, sem regressão de resposta nem de desempenho para processos sem ramificação (p95 da caixa < 500 ms por visão — RN-INBOX-12).

## Persona
- **Principal:** Responsável de ramo (qualquer perfil com `INBOX_VIEW` e atribuição ou lotação numa etapa de ramo).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), que acompanha o processo e os prazos; titular/substituto de unidade (fila e atribuição em lote); aprovador de uma etapa `APPROVAL` de ramo; Auditor (`AUDITOR`) e Controle Interno (leitura).

## Pré-condições
- Processo em ramificação conforme US-124 (`activeStages[]` com 2 ou mais etapas).
- Usuário autenticado com `INBOX_VIEW` (caixa), `PROCESS_VIEW` (painel e lista), visibilidade do processo (DEC-024) e, para assumir/atribuir, `PROCESS_CLAIM`/`PROCESS_ASSIGN` cobrindo a etapa (POL-04/POL-05).

## Fluxo principal
1. "Rita" (Controle Interno) abre a caixa de tarefas (SCR-013). TSK-02 devolve os contadores por visão contando **linhas** (uma por etapa ativa visível na visão); TSK-01 lista, em "Comigo", a linha do **seu** ramo com a etapa, a unidade, o prazo **da etapa** e o chip "Ramo: Controle Interno".
2. A linha mostra um resumo dos **outros ramos** do mesmo processo ("Também em andamento: Jurídico · Prazo 18/11") sem expor dados pessoais; o link abre o processo (SCR-006) já com o foco no ramo da pessoa.
3. Na aba "Na fila da minha unidade", ramos sem responsável aparecem uma vez por etapa; "Assumir" chama PRC-21 com o `processStageId` da linha. No lote (TSK-03/TSK-04), o front envia `items[]` com `{ processId, processStageId }`.
4. Ao abrir o processo, o painel situacional (PRC-07) mostra o cartão **"Onde está?"** com uma coluna por ramo (nome da etapa, unidade, responsável, `DueDateBadge`, situação "Em andamento"/"Concluído em dd/mm"), o prazo do processo (menor `dueAt`, com a etapa crítica) e o **próximo passo da minha etapa**, listando as etapas dos outros como "Aguardando".
5. O `StageProgress` mostra o split como um grupo expansível ("Análises — 2 ramos"), com cada ramo em sua raia, as etapas já concluídas e a etapa ativa; o histórico por etapa (PRC-10) lista as passagens por ramo.
6. Na lista de processos (PRC-01), a coluna "Etapa" mostra os chips das etapas ativas ("Jurídico · Controle Interno"), o prazo é o menor `dueAt` e o filtro por etapa, unidade ou responsável casa com **qualquer** etapa ativa.
7. Em SCR-014/SCR-015 (aprovações), a aprovação de uma etapa de ramo exibe o chip do ramo e o contexto ("Aguardando também: Jurídico").
8. O job `deadlines` (US-055), a cada 15 minutos, avalia **cada** etapa ativa: emite `ProcessStageDueSoon`/`ProcessStageOverdue` com `branchKey`, marca `overdueSince` na etapa atrasada e as linhas correspondentes aparecem em "Atrasados" apenas para quem está com aquele ramo. O processo é exibido como atrasado quando **qualquer** etapa ativa está atrasada.
9. O front consulta TSK-02 e, para a aba ativa, TSK-01 a cada 60 s (RN-INBOX-13); mudanças de ramo (chegada, junção, devolução) aparecem no ciclo seguinte ou por atualização manual.

## Fluxos alternativos
- **FA-01 — Usuário com os dois ramos:** quem tem custódia dos dois ramos (ex.: gestor que se atribuiu) vê **duas** linhas do mesmo processo, uma por ramo, cada uma com a sua ação.
- **FA-02 — Ramo já concluído:** a etapa de um ramo `ARRIVED` sai da caixa (não há etapa ativa) e aparece no painel como "Concluído em {data}"; só o ramo restante continua na caixa.
- **FA-03 — Junção:** com a junção, as linhas dos ramos somem e surge a linha da etapa seguinte (uma só) com a unidade/responsável da etapa de saída.
- **FA-04 — Devolução para antes do split:** as linhas dos ramos cancelados somem e a etapa reaberta entra em "Devolvidos" (RN-INBOX-05) para quem a recebeu.
- **FA-05 — Aprovação dentro de ramo:** em `PENDING_APPROVALS` cada aprovação continua uma linha (por aprovação); o chip do ramo e a lista dos demais ramos acompanham a linha.
- **FA-06 — Processo suspenso:** todas as linhas do processo seguem a regra do MVP 1 para suspensos (prazo pausado, `isPaused`); retomar estende o `dueAt` de cada ramo.
- **FA-07 — Lote com ramo ambíguo:** `processIds` enviado em TSK-03/TSK-04 para um processo que tem mais de um ramo assumível pelo usuário devolve, para esse item, `PROCESS_STAGE_REQUIRED` (os demais itens seguem).
- **FA-08 — Sem ramificação:** nenhuma mudança visível: linha única, `rowKey` = `processId`, painel e lista como no MVP 1.

## Regras de negócio
- **RN-WF2-29** — A caixa de tarefas produz **uma linha por etapa ativa** `TASK`/`APPROVAL` que satisfaça o predicado da visão (RN-INBOX-03..08), em vez de uma por processo: `MINE` (atribuição ativa do usuário na etapa), `UNIT_QUEUE` (atribuição ativa sem responsável em unidade do usuário com `PROCESS_CLAIM` ou titular/substituto), `RETURNED` (atribuição `RETURN` ativa), `OVERDUE` (etapa com `overdueSince`) e `FOLLOWING` (participação — uma linha por processo, sem ramo, pois não depende de etapa). `PENDING_APPROVALS` continua uma linha por aprovação.
- **RN-WF2-30** — Contrato da linha (aditivo à TSK-01): `id` continua o `processId` (ou a aprovação, em `PENDING_APPROVALS`); acrescentam-se `rowKey` (único: `processId` ou `processId:processStageId`), `processStageId`, `branchKey` (nulo fora de ramo), `branchLabel`, `activeStagesCount` e `siblings[]` (`{ branchKey, stageName, status: 'OPEN' | 'ARRIVED', isOverdue }`, até 3 itens + `siblingsMore`). `currentStage`, `currentDepartment`, `currentResponsible`, `enteredAt`, `dueAt`, `isOverdue`, `overdueSince`, `deadline` e `canClaim` descrevem a **etapa da linha**, não o processo. `siblings[]` só traz nomes de etapa e situação (sem pessoas nem valores — POL-09/FA-05 de US-056). O processo pode aparecer em mais de uma linha: a UI usa `rowKey` como chave.
- **RN-WF2-31** — Contadores (TSK-02) usam **os mesmos predicados e o mesmo snapshot** de TSK-01 (RN-INBOX-09) e contam **linhas**; um processo com dois ramos visíveis na mesma visão conta 2. O campo `meta.countUnit = "ROW"` (aditivo) documenta a unidade. Sem ramificação o valor coincide com o do MVP 1.
- **RN-WF2-32** — Ações rápidas por ramo: "Assumir" usa PRC-21 com `processStageId` da linha (POL-04: lotado na unidade **da etapa**); `canClaim` é calculado por linha. TSK-03/TSK-04 aceitam, **no lugar de** `processIds`, `items: [{ processId, processStageId }]` (2 a 50 itens, sem repetir o par; enviar os dois campos → `VALIDATION_ERROR` `NOT_ALLOWED`); o resultado por item inclui `processStageId`; a `Idempotency-Key` cobre o lote (RN-INBOX-23). Com `processIds`, processo com mais de um ramo assumível → item `PROCESS_STAGE_REQUIRED` (FA-07).
- **RN-WF2-33** — O painel situacional (PRC-07) passa a devolver, de forma aditiva: `where.stages[]` (`ActiveStage` da US-124 + `isMine`), `where.stage` mantido apontando para o split (`type = PARALLEL_SPLIT`, compatibilidade), `responsible.byStage[]`, `nextStep.byStage[]` (ação da **minha** etapa com `enabled`/`reasons`; para as demais, `waitingFor`), `pending.items[]` com `processStageId`/`branchKey` e `approvals[]` com `branchKey`. A resposta do MVP 1 permanece válida sem ramificação.
- **RN-WF2-34** — Prazo do processo (DEC-194): `deadline` de PRC-01/PRC-07 e `Process.currentStageDueAt` = **menor** `dueAt` entre as etapas ativas que tenham prazo (ignora etapas sem SLA; sem nenhuma, `null`), acompanhado de `deadline.criticalStage { processStageId, branchKey, stageName }`; `isOverdue` do processo = qualquer etapa ativa com `overdueSince`; `isPaused` = processo `SUSPENDED`. `targetDate` (prazo-alvo — DEC-031) segue distinto do atraso de etapa (RN-TRAM-84).
- **RN-WF2-35** — Alertas por ramo: `ProcessStageDueSoon`/`ProcessStageOverdue` são emitidos **por etapa de ramo**, uma única vez cada (idempotência por `dueSoonNotifiedAt`/`overdueNotifiedAt` da etapa — RN-TRAM-82/83), com `branchKey`; o destinatário é o responsável **do ramo** (ou o titular da unidade do ramo) e a notificação traz o rótulo do ramo; o ramo que chega ao join sai do job (etapa fora de `ACTIVE`). Lock distribuído do job inalterado (RN-TRAM-85).
- **RN-WF2-36** — PRC-01 (lista): `currentStage` continua como no contrato do MVP 1 (no paralelismo aponta para o split); acrescentam-se `activeStages[]` compacto (`{ processStageId, stageKey, stageName, branchKey, departmentName, dueAt, isOverdue }`) e `activeStagesCount`; os filtros `stageKey`/`currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId` e `overdue` casam com **qualquer** etapa ativa do processo; `sort=currentStageDueAt` ordena pelo menor `dueAt`. Sem `activeStages[]` nas telas do MVP 1 nada quebra.
- **RN-WF2-37** — Aprovações (APV-01/APV-02): a linha/detalhe de uma aprovação cuja etapa é de ramo ganha `branchKey`, `branchLabel` e `siblings[]` (como RN-WF2-30); nenhuma outra regra de aprovação muda nesta story (a política múltipla é do EP-022).
- **RN-WF2-38** — Compatibilidade, desempenho e acessibilidade: consultas usam os índices parciais existentes (`process_assignments WHERE is_active`, `process_stages (tenant_id, due_at) WHERE status='ACTIVE'`, `approvals WHERE status='PENDING'`) e a view `v_inbox_processes` ganha `process_stage_id` e `branch_key` (colunas aditivas); meta p95 < 500 ms por visão com até 10.000 processos ativos, 20% deles em ramificação, medida no teste de performance; o paralelismo é comunicado por texto e ícone (nunca só cor), em lista no celular (360 px) e com leitura anunciada por `aria-live` ao mudar de aba.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| *(sistema)* Chave da linha | `rowKey` | texto | — | `processId` ou `processId:processStageId` | TSK-01 |
| Etapa da linha | `processStageId`, `currentStage` | uuid / objeto | — | Etapa ativa da linha | TSK-01 |
| Ramo | `branchKey`, `branchLabel` | texto ≤ 60 / texto | — | Nulo fora de ramo | etapa |
| Outros ramos | `siblings[]`, `siblingsMore` | lista / int | — | Até 3 + contagem; sem pessoas nem valores | TSK-01 |
| Etapas ativas | `activeStages[]`, `activeStagesCount` | lista / int | — | Contrato da US-124; compacto em PRC-01 | PRC-01/PRC-04/PRC-07 |
| Onde está (por ramo) | `where.stages[]` | lista | — | `ActiveStage` + `isMine` | PRC-07 |
| Responsável por ramo | `responsible.byStage[]` | lista | — | `{ processStageId, user\|null, queueDepartment\|null, since }` | PRC-07 |
| Próximo passo por ramo | `nextStep.byStage[]` | lista | — | `action` (só da minha etapa) ou `waitingFor` | PRC-07 |
| Prazo do processo | `deadline` + `deadline.criticalStage` | objeto | — | Menor `dueAt` (RN-WF2-34) | PRC-01/PRC-07 |
| Unidade de contagem | `meta.countUnit` | `"ROW"` | — | Documenta que TSK-02 conta linhas | TSK-02 |
| Itens do lote | `items[]` | lista `{ processId, processStageId }` | Condicional | 2–50, sem repetir o par; exclusivo com `processIds` | TSK-03/TSK-04 |
| Filtro por ramo (opcional na UI) | `branchKey` (query de TSK-01) | texto | Não | Restringe às linhas do ramo | filtro local da tela |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Sem `INBOX_VIEW` | API | "Você não tem acesso à caixa de tarefas." | `PERMISSION_DENIED` (403) |
| V-02 | `view`, `sort`, `branchKey` ou `pageSize` fora do contrato | Front + API (Zod) | "Revise os filtros e tente de novo." | `VALIDATION_ERROR` (422) |
| V-03 | `items` e `processIds` enviados juntos, ou lote fora de 2–50 itens | Front + API | "Selecione de 2 a 50 itens do mesmo tipo de seleção." | `VALIDATION_ERROR` (`NOT_ALLOWED` / `TOO_SHORT` / `TOO_LONG`) |
| V-04 | Par `{ processId, processStageId }` repetido | API | "Há itens repetidos na seleção." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-05 | Item de lote com mais de um ramo assumível e sem `processStageId` | API (por item) | "Este processo tem mais de um ramo disponível. Assuma pela linha do ramo." | `PROCESS_STAGE_REQUIRED` (no item) |
| V-06 | Item de lote com etapa que deixou de estar ativa | API (por item) | "Este ramo já foi movimentado. Atualize a lista." | `STAGE_CHANGED` (no item) |
| V-07 | Etapa já com responsável | API (por item) | "Outra pessoa já assumiu este ramo." | `PROCESS_ALREADY_ASSIGNED` (no item) |
| V-08 | Usuário sem lotação na unidade da etapa/sem `PROCESS_CLAIM` | API (por item) | "Você não pode assumir este ramo." | `PERMISSION_DENIED` (no item) |
| V-09 | Processo inexistente/não visível/outro tenant | API | "Processo não encontrado." | `PROCESS_NOT_FOUND` (404) |

## Permissões
- **Permissão:** `INBOX_VIEW` (TSK-01/TSK-02); `PROCESS_VIEW` (PRC-01, PRC-07); `PROCESS_CLAIM` (TSK-03) e `PROCESS_ASSIGN`/titular da unidade (TSK-04); cobertura de aprovador (POL-03) para APV-01/APV-02 (lista vazia, nunca 403, como no MVP 1). Nenhuma permissão nova.
- **Políticas:** DEC-024 (visibilidade — uma linha só aparece se o processo é visível), POL-01 por etapa ativa, POL-04/POL-05 (assumir/atribuir por etapa), POL-03 (aprovador), POL-09 (nenhum valor monetário na caixa nem nos `siblings[]`).
- **MFA:** não exigido (leituras e ações de risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** sem `INBOX_VIEW` a rota `/tarefas` não aparece no menu e a API responde 403 `PERMISSION_DENIED` com `access.denied`; sem lotação na unidade do ramo a linha não aparece em `UNIT_QUEUE` e "Assumir" não é exibido.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageDueSoon` | `process.stage_due_soon` | Job `deadlines`: faltam `deadlines.warnBeforeBusinessDays` dias úteis para o `dueAt` da etapa **de ramo** | MVP 1 + `branchKey?` (aditivo, `events.md` §2); uma vez por etapa |
| `ProcessStageOverdue` | `process.stage_overdue` | Job `deadlines`: `now > dueAt` da etapa de ramo | MVP 1 + `branchKey?`; uma vez por etapa |

As leituras (caixa, painel, lista, aprovações) não geram evento. `ProcessAssigned` das ações "Assumir"/"Atribuir" por ramo é o do MVP 1, descrito na US-124.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `STAGE_DUE_SOON` (MVP 1) | Responsável **do ramo**; se não houver, titular da unidade do ramo | In-app (e-mail conforme o padrão do tipo) | `ProcessStageDueSoon` — mensagem com o rótulo do ramo |
| `STAGE_OVERDUE` (MVP 1) | Responsável do ramo e titular da unidade do ramo | In-app + e-mail (padrão ✔) | `ProcessStageOverdue` — mensagem com o rótulo do ramo |
| `PROCESS_ASSIGNED` (MVP 1) | Novo responsável do ramo (exceto o próprio ator) | In-app + e-mail | `ProcessAssigned` por TSK-04/PRC-22 |

Nunca notifica o ator; sem valores sigilosos; agrupamento de 5 min e preferências do usuário (US-113).

## Critérios de aceite em Gherkin
```gherkin
Feature: Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0045/2026" está em ramificação com a etapa "JURIDICO" (responsável "Paulo", prazo 18/11/2026) e a etapa "CONTROLE_INTERNO" (responsável "Rita", prazo 20/11/2026)
    And o processo "0046/2026" não tem ramificação e está em "TERMO_REFERENCIA" com "Rita" como responsável
    And "Paulo" e "Rita" têm vínculo ativo, "INBOX_VIEW" e "PROCESS_VIEW"

  Scenario: [Sucesso] A caixa mostra uma linha por ramo e os contadores contam linhas
    When "Rita" consultar a visão "MINE" da caixa de tarefas
    Then a resposta deve ter 2 linhas: "0045/2026" com "branchKey" "CONTROLE_INTERNO" e "0046/2026" sem ramo
    And a linha de "0045/2026" deve trazer "dueAt" de 20/11/2026 e "siblings" com "JURIDICO" em "OPEN"
    And os contadores devem ter "mine" igual a 2 e "meta.countUnit" igual a "ROW"
    And não deve gerar auditoria nem evento de domínio (leitura)

  Scenario: [Sucesso] O painel lista as etapas ativas e o prazo do processo é o menor
    When "Rita" abrir o processo "0045/2026" (resumo)
    Then "where.stages" deve ter 2 etapas, com "isMine" verdadeiro só em "CONTROLE_INTERNO"
    And "deadline.dueAt" deve ser 18/11/2026 com "criticalStage" "JURIDICO"
    And "nextStep.byStage" deve ter a ação da etapa de "Rita" e "waitingFor" com "JURIDICO"
    And "where.stage" deve manter o tipo "PARALLEL_SPLIT" por compatibilidade

  Scenario: [Sucesso] Assumir em lote por ramo
    Given que as etapas "JURIDICO" do processo "0045/2026" e "ANALISE" do processo "0050/2026" estão na fila da unidade de "Paulo"
    When "Paulo" enviar TSK-03 com "items" para os dois pares { processId, processStageId }
    Then a resposta deve ter "successCount" igual a 2
    And deve gerar registro de auditoria "process.claim" por item com "processStageId"
    And deve gerar o evento ProcessAssigned para cada etapa

  Scenario: [Sucesso] Alerta de atraso por ramo
    Given que o prazo da etapa "JURIDICO" venceu ontem e o da etapa "CONTROLE_INTERNO" ainda não
    When o job "deadlines" rodar
    Then o evento ProcessStageDueSoon com "branchKey" "CONTROLE_INTERNO" deve ser emitido uma única vez quando faltarem 2 dias úteis
    And "JURIDICO" deve ficar com "overdueSince" preenchido e "CONTROLE_INTERNO" não
    And deve gerar o evento ProcessStageOverdue com "branchKey" "JURIDICO" uma única vez
    And "Paulo" deve ver a linha em "OVERDUE" e "Rita" não
    And o processo "0045/2026" deve aparecer como atrasado na lista de processos
    And o alerta não gera registro de auditoria (como no MVP 1, o job registra apenas o evento e a notificação)

  Scenario: [Validação] Lote com os dois formatos de seleção
    When "Paulo" enviar TSK-03 com "items" e "processIds" juntos
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"
    When "Paulo" enviar TSK-03 com "processIds" de um processo com dois ramos assumíveis por ele
    Then o item deve vir com código "PROCESS_STAGE_REQUIRED" e os demais itens devem ser processados

  Scenario: [Permissão] Quem não é da unidade do ramo não o vê na fila
    Given que "Marta" está lotada em outra unidade e tem "INBOX_VIEW"
    When "Marta" consultar a visão "UNIT_QUEUE"
    Then a resposta não deve conter a linha "0045/2026"
    Given que "Bruno" não tem "INBOX_VIEW"
    When "Bruno" consultar a caixa de tarefas
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Linhas e ramos de outro tenant
    Given que o tenant "Prefeitura B" tem um processo em ramificação com ramos na unidade "Compras"
    When "Rita", no tenant "Prefeitura A", consultar a caixa de tarefas e a lista de processos
    Then nenhuma linha, contagem ou ramo de "Prefeitura B" deve aparecer
    When "Rita" abrir o resumo desse processo
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Duplicidade] Reenvio do lote de assumir
    Given que "Paulo" assumiu o lote com a "Idempotency-Key" "L-12" e recebeu 200
    When a mesma requisição for reenviada
    Then a API deve responder 200 com "Idempotent-Replayed" verdadeiro e o mesmo resultado por item
    And não deve haver novo evento ProcessAssigned nem nova auditoria "process.claim"

  Scenario: [Concorrência] Duas pessoas assumem o mesmo ramo
    Given que a etapa "JURIDICO" está na fila e "Paulo" e "Lia" (mesma unidade) clicam em "Assumir" ao mesmo tempo
    When as duas requisições chegarem ao servidor
    Then apenas uma deve ter sucesso e a outra deve receber "PROCESS_ALREADY_ASSIGNED" com o responsável atual
    And as linhas não devem ser duplicadas na caixa de nenhum dos dois

  Scenario: [Concorrência] Ramo movimentado enquanto a caixa estava aberta
    Given que "Paulo" carregou a linha do ramo "JURIDICO" e "Rita" encaminhou o último ramo, formando a junção
    When "Paulo" clicar em "Assumir" na linha antiga
    Then a API deve responder com "STAGE_CHANGED"
    And na próxima atualização a linha do ramo deve ser substituída pela da etapa "AUTORIZACAO_LICITACAO"

  Scenario: [Falha de banco] Banco indisponível ao listar
    Given que o banco de dados está indisponível
    When "Rita" abrir a caixa de tarefas
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a UI deve manter os dados anteriores e exibir "Tentar novamente" sem derrubar o menu

  Scenario: [Falha de integração] Redis do tempo real indisponível
    Given que o Redis usado pelo canal de atualização em tempo real está indisponível
    When "Rita" mantiver a caixa aberta por 2 minutos
    Then a caixa deve continuar atualizando por polling a cada 60 segundos
    And o job "deadlines" deve registrar o alerta de lock indisponível sem emitir alertas duplicados
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem acesso à caixa | 403 | `PERMISSION_DENIED` | "Você não tem acesso à caixa de tarefas." | Item de menu oculto |
| Parâmetro inválido | 422 | `VALIDATION_ERROR` | "Revise os filtros e tente de novo." | Restaura o filtro anterior |
| Lote inválido (formato, tamanho, repetido) | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`, `TOO_SHORT`, `TOO_LONG`, `DUPLICATE_IN_LIST`) | "Selecione de 2 a 50 itens, sem repetir." | Mantém a seleção |
| Ramo não informado no item | 200 (item) | `PROCESS_STAGE_REQUIRED` | "Este processo tem mais de um ramo disponível. Assuma pela linha do ramo." | Item com erro no `BulkResultSummary` |
| Ramo movimentado | 200 (item) / 409 | `STAGE_CHANGED` | "Este ramo já foi movimentado. Atualize a lista." | Remove a linha e recarrega |
| Ramo já assumido | 200 (item) / 409 | `PROCESS_ALREADY_ASSIGNED` | "Outra pessoa já assumiu este ramo." | Linha atualizada com o responsável |
| Sem lotação/permissão para assumir | 200 (item) / 403 | `PERMISSION_DENIED` | "Você não pode assumir este ramo." | "Assumir" ocultado |
| Corpo diferente com a mesma chave | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta requisição já foi usada com outros dados." | Nova chave |
| Processo inexistente/outro tenant | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Volta para a caixa |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar agora. Tente novamente." | Mantém dados anteriores, "Tentar novamente" com `correlationId` |

## Dependências
- **Stories:** US-124 (runtime e `activeStages[]`), US-056 e US-058 (caixa e lote), US-004 (painel), US-055 (prazos e job `deadlines`), US-057 (lista de aprovações), US-002 (lista de processos). Habilita US-136 (linhas de aprovação em SCR-014/SCR-015), EP-028 (indicadores por ramo) e EP-030 (SLA por ramo).
- **Decisões/ADRs:** DEC-194, DEC-026, DEC-180, DEC-023, DEC-024, DEC-031, DEC-108; [ADR-005](../adr/adr-005-workflow-engine.md).
- **Configurações:** `deadlines.warnBeforeBusinessDays` (MVP 1) e `inbox.bulkMaxItems` (DT-16, limite do lote).
- **Lacunas nas fontes canônicas:**
  - `api.md`/`entities.md` do MVP 1 descrevem TSK-01 com `id` = processo; as linhas por ramo exigem o campo aditivo `rowKey` (chave única) e `processStageId`. Alternativa descartada: trocar o significado de `id` (quebraria clientes do MVP 1). Confirmar no card 9.
  - O contrato dos corpos de TSK-03/TSK-04 (`items[]`) e `meta.countUnit` não consta de nenhuma fonte; a view `v_inbox_processes` ganha colunas aditivas (`entities.md` §5 só cita a v2 de `v_inbox_pending_approvals`).
  - `deadline.criticalStage` e o recorte exato de `where.stages[]`/`nextStep.byStage[]` em PRC-07 são definições desta story.
  - TSK-13..TSK-20 (faixa reservada) **não foram necessários**: tudo cabe nos endpoints TSK-01..TSK-04 estendidos.
  - O comportamento de `FOLLOWING` (participação) com ramos não está nas fontes; adotada uma linha por processo.

## Impacto técnico
- **Compatibilidade (DEC-108):** `id` mantido; campos novos aditivos; contadores só mudam de valor quando há ramificação (mesma unidade, mais linhas). Teste de contrato com um processo sem ramificação garante respostas idênticas às do MVP 1.
- **Consulta:** as views `v_inbox_*` passam a expor `process_stage_id`/`branch_key`; o plano de execução deve permanecer com índices parciais (RN-INBOX-12); `siblings[]` por uma única junção lateral limitada a 3 linhas.
- **Performance:** meta p95 < 500 ms por visão com 10.000 processos ativos (20% em ramificação), medida no teste de performance; contadores em uma instrução SQL.
- **Job `deadlines`:** já itera por `ProcessStage` ativa; ajustar o cálculo do menor `dueAt` e a inclusão de `branchKey` nos eventos; sem novo job.
- **UX:** risco de poluição visual com muitos ramos — resumo de até 3 irmãos e detalhe sob demanda; mobile em cartões.

## Backend
- **Módulo(s):** `process` (consultas, painel, prazos), `approval` (APV-01/APV-02), `access` (visibilidade), `notification` (texto com ramo).
- **Casos de uso:** `ListTasksQuery` e `GetTaskCountersQuery` (por etapa ativa), `BulkClaimTasksCommand`/`BulkAssignTasksCommand` (formato `items[]`), `GetProcessSummaryQuery` (estendido), `ListProcessesQuery` (filtros por qualquer etapa ativa), `ListApprovalsQuery`/`GetApprovalQuery` (campos de ramo), `DeadlinesTickJob` (menor `dueAt`, `branchKey`).
- **Domínio:** `ProcessDeadlineCalculator` (menor `dueAt` + etapa crítica), `InboxRowKey`, `SiblingBranchesProjection`.
- **Integrações internas:** `process` ↔ `approval` por view e fachada; `notification` (rótulo do ramo); `timeline` não muda.
- **Transação:** leituras em `REPEATABLE READ READ ONLY` (um snapshot por requisição); as ações em lote seguem a transação por item do MVP 1.

## Frontend
- **Tela(s):** SCR-013 (`/tarefas`), SCR-006 (`/processos/[id]`), SCR-014 (`/aprovacoes`), SCR-015 (`/aprovacoes/[id]`); lista de processos (`/processos`).
- **Componentes:** `InboxTable` (linha por ramo, `BranchChip`, `SiblingsSummary`), `BulkActionBar` com `items[]`, `ActiveStagesPanel` (cartão "Onde está?" com colunas por ramo), `StageProgress` com grupo expansível do split e raias, `DeadlinesCard` com "prazo do processo" e etapa crítica, `NextStepCard` por ramo ("Sua etapa" × "Aguardando"), `ProcessStageChips` na lista, chip de ramo em `ApprovalRow`/detalhe.
- **Estados:** loading (skeleton por bloco), vazio por visão (como no MVP 1), erro por bloco com "Tentar novamente", linha "assumindo…", sucesso (toasts por ramo), conflito (`STAGE_CHANGED` remove a linha e recarrega).
- **Acessibilidade e responsividade:** ramos como lista de seções com `h3` e texto ("Ramo Jurídico — em andamento, vence 18/11"), não só cor; `aria-live` ao trocar de aba/atualizar; seleção por teclado; abaixo de 768 px tabela em cartões e colunas de ramo empilhadas; contraste AA.

## Banco de dados
- **Tabelas:** sem tabela nova; views `v_inbox_processes` (+ `process_stage_id`, `branch_key`) e `v_inbox_pending_approvals` (+ `branch_key`), colunas desnormalizadas `processes.current_stage_due_at` (menor `dueAt`) e `active_stages_count` (US-124).
- **Migrações:** `CREATE OR REPLACE VIEW` aditivo (colunas ao final); backfill de `current_stage_due_at` não é necessário (sem processos em ramificação antes do deploy).
- **Índices/constraints relevantes:** reutiliza `process_assignments WHERE is_active`, `process_stages (tenant_id, due_at) WHERE status='ACTIVE'`, `(tenant_id, process_id) WHERE status='ACTIVE'`; avaliar índice `(tenant_id, department_id, assignee_id) WHERE status='ACTIVE'` conforme o plano de execução do teste de performance.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TSK-01 | GET | `/tasks` | MVP 1 + `branchKey?` (filtro opcional) | Linha por etapa ativa com `rowKey`, `processStageId`, `branchKey`, `branchLabel`, `activeStagesCount`, `siblings[]`, `siblingsMore` (RN-WF2-30) | 200, 403, 422 |
| TSK-02 | GET | `/tasks/counters` | — | `{ data: { mine, unitQueue?, pendingApprovals, returned, overdue, following }, meta: { countUnit: "ROW" } }` | 200, 403 |
| TSK-03 | POST | `/tasks/bulk-claim` | `processIds` **ou** `items: [{ processId, processStageId }]` (2–50); `Idempotency-Key` | `200 { data: [{ processId, processStageId?, ok, code?, message?, process? }], meta: { successCount, errorCount } }` | 200, 403, 422 |
| TSK-04 | POST | `/tasks/bulk-assign` | idem + `assigneeId` do MVP 1 | idem | 200, 403, 422 |
| PRC-01 | GET | `/processes` | MVP 1; filtros por etapa/unidade/responsável casam com qualquer etapa ativa | `ProcessListItem` + `activeStages[]` compacto, `activeStagesCount`, `deadline` pelo menor `dueAt` (+ `criticalStage`) | 200, 403, 422 |
| PRC-07 | GET | `/processes/{id}/summary` | — | MVP 1 + `where.stages[]`, `responsible.byStage[]`, `nextStep.byStage[]`, `pending.items[].processStageId/branchKey`, `approvals[].branchKey`, `deadline.criticalStage` | 200, 404 |
| APV-01 | GET | `/approvals` | MVP 1 | linha com `branchKey`, `branchLabel`, `siblings[]` (quando de ramo) | 200, 422 |
| APV-02 | GET | `/approvals/{id}` | — | detalhe com `branchKey`, `branchLabel`, `siblings[]` | 200, 403, 404 |

## Logs
- `info` `inbox.list` com `view`, `rows`, `durationMs`, `parallelRows` (quantidade de linhas de ramo).
- `info` `inbox.bulk_claim` com `items`, `successCount`, `errorCount`, `idempotencyReplay`.
- `warn` `inbox.query_slow` quando uma visão passar de 500 ms, com `view` e plano resumido.
- `warn` `deadlines.branch_alert_suppressed` quando o alerta de um ramo já foi emitido (idempotência).
- `error` `inbox.query_failed` com `correlationId` e causa técnica.
- Nunca logar: valores estimados (POL-09), títulos de processos sigilosos, comentários, nomes de pessoas fora do `userId`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.claim` | `WORKFLOW` | "Assumir" por ramo (PRC-21/TSK-03) | `metadata`: `processStageId`, `branchKey`, `idempotencyKey` |
| `process.assign` | `WORKFLOW` | "Atribuir" por ramo (PRC-22/TSK-04) | `metadata`: `processStageId`, `branchKey`, `toUserId` |
| `access.denied` | `ACCESS` | 403 em qualquer endpoint da story | rota e permissão exigida (amostragem 1/usuário/rota/min) |

Os alertas do job `deadlines` não têm ação de auditoria no MVP 1 (só evento e notificação) e assim permanecem. Leituras da caixa, do painel e da lista não geram auditoria (exceto `process.confidential_view` na entrega de valor desmascarado, como no MVP 1).

## Testes necessários
- **Unitários:** `ProcessDeadlineCalculator` (menor `dueAt`, etapas sem SLA, pausa), `InboxRowKey`, projeção de `siblings[]` (limite de 3, sem pessoas), predicados das visões com ramos (tabela de verdade: `MINE`/`UNIT_QUEUE`/`RETURNED`/`OVERDUE`), validação de `items[]` × `processIds`.
- **Integração (Testcontainers):** views `v_inbox_*` com processos com e sem ramos; contadores = tamanho das listas (mesmo snapshot) em todas as visões; job `deadlines` por ramo (único alerta por etapa); filtros de PRC-01 casando com qualquer etapa ativa; lote com item ambíguo.
- **API/contrato:** TSK-01/02/03/04, PRC-01, PRC-07, APV-01/02 contra o OpenAPI; snapshot de **igualdade** das respostas do MVP 1 para processos sem ramificação.
- **RBAC e multi-tenant:** visibilidade por unidade do ramo (fila), `INBOX_VIEW`, lote entre tenants; arquivo novo na suíte `test/tenant-leak` (caixa, painel e lote com ramos).
- **Concorrência:** duas pessoas assumindo o mesmo ramo, ramo movimentado durante a leitura, reenvio idempotente do lote.
- **E2E (Playwright):** duas contas veem os seus ramos, o painel mostra as etapas lado a lado e o menor prazo, junção troca as linhas; atraso de um ramo vira "Atrasados" só para o responsável dele.
- **Acessibilidade/performance:** axe em SCR-013/SCR-006 com ramos (texto + ícone, ordem de leitura); teste de performance da caixa (p95 < 500 ms por visão com 20% em ramificação) medido no endurecimento; viewport de 360 px.

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
- [ ] Teste de contrato: respostas de processos sem ramificação idênticas às do MVP 1
- [ ] Meta de performance da caixa escrita como teste da suíte de performance

## Estimativa
**M** — sem motor novo: estende consultas, views, contratos e telas existentes (caixa, painel, lista, aprovações) e o cálculo de prazo, com muitos testes de contrato e de consistência entre contadores e listas.

## Prioridade
**P0** — fecha a DT-03 do lado do usuário: sem ela o paralelismo da US-124 não é utilizável (o ramo não apareceria na caixa de quem o executa) e os prazos por ramo não seriam acompanhados.
