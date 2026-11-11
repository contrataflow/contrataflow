---
id: US-192
title: "Escalonar prazos em degraus"
epic: EP-030
feature: FT-086
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-114, US-190]
modules: [sla, process, notification, timeline, audit, platform]
screens: [SCR-006, SCR-121]
endpoints: [SET-01, SET-02, SLA-12, PRC-12, NTF-01]
permissions: [PROCESS_VIEW, SETTINGS_MANAGE]
events: [ProcessStageEscalated, ProcessStageDueSoon, ProcessStageOverdue]
---

# US-192 — Escalonar prazos em degraus

## Título
Escalonar prazos em degraus

## Descrição
**Como** gestor de contratações (ou titular de unidade ou de secretaria), **quero** ser avisado em degraus antes do vencimento, no vencimento e depois dele — com o responsável, a chefia da unidade, o gestor e o titular da secretaria solicitante entrando conforme a gravidade —, **para** agir antes do atraso e para que nenhum atraso chegue à chefia tarde ou passe em silêncio.

A story ativa o escalonamento definido na política de SLA (US-189, `escalationSteps`, até 5 degraus) sobre o prazo gravado por US-190: o job `deadlines` consulta o módulo `sla`, dispara cada degrau uma única vez (`ProcessStage.escalationLevel`), publica `ProcessStageEscalated`, projeta `STAGE_ESCALATED` na timeline e cria a notificação `SLA_ESCALATION` para os papéis do degrau (`ASSIGNEE`, `DEPARTMENT_HEAD`, `DEPARTMENT_DEPUTY`, `PROCESS_MANAGER_ROLE`, `REQUESTING_SECRETARIAT_HEAD`). Com política e degraus, o degrau **substitui** o aviso `STAGE_DUE_SOON` do MVP 1 e **se soma** a `STAGE_OVERDUE`; sem política (ou sem degraus, ou com `sla.escalationEnabled = false`), os avisos do MVP 1 continuam como estão.

## Contexto
- No MVP 1, o job `deadlines` (US-055) emite `ProcessStageDueSoon` quando faltam `deadlines.warnBeforeBusinessDays` dias úteis e `ProcessStageOverdue` no vencimento; US-114 transforma esses eventos em notificações `STAGE_DUE_SOON` (responsável, ou titular se não houver) e `STAGE_OVERDUE` (responsável **e** titular), com idempotência por `dueSoonNotifiedAt`/`overdueNotifiedAt` e por `Notification (tenant, recipient, sourceEventId, type)`. O aviso é único e a chefia só entra no atraso.
- A DEC-205 e a ADR-015 definem o escalonamento: degraus configuráveis por política, antes, no vencimento e depois, para responsável, titular da unidade e gestor; o job `deadlines` passa a consultar o `sla`; execução assíncrona e idempotente no worker; `escalationLevel` evita repetição e `repeatEveryBusinessDays` permite reenviar.
- `SlaEscalationStep` (entities.md §7.8): `level` 1..5, `offsetBusinessDays` (negativo = antes do vencimento), `notify` (lista de papéis) e `repeatEveryBusinessDays` opcional; `ProcessStage` guarda `escalationLevel` (último degrau disparado) e `lastEscalatedAt`.
- `events.md` já define o evento `ProcessStageEscalated` (`level`, `dueAt`, `overdueBusinessDays`, `notifyTargets[]` — papéis, não pessoas; consumidores T, N, R e NR), a entrada de timeline `STAGE_ESCALATED`, o tipo de notificação `SLA_ESCALATION` (e-mail padrão sim, não obrigatória) e a ação de auditoria `process.stage_escalate` (ator `SYSTEM`).
- `sla.escalationEnabled` (padrão `true`) desliga **só** os degraus; os avisos do MVP 1 continuam (épico EP-030). Pausas (US-191) interrompem o escalonamento da etapa pausada.
- Indicadores: meta do épico de ≥ 90% dos atrasos escalonados antes de 3 dias úteis do vencimento (`ProcessStageEscalated` × `ProcessStageOverdue`); a regra de notificação condicional (US-193) pode usar `ProcessStageEscalated` como evento de origem.

## Objetivo
Garantir que 100% dos degraus configurados disparem uma única vez, no ciclo seguinte ao gatilho (máximo de 15 minutos de atraso de detecção), para os destinatários certos com visibilidade do processo, sem duplicar o aviso de vencimento do MVP 1 e sem nunca disparar em etapa pausada.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`), que recebe o escalonamento do que está sob sua gestão.
- **Secundárias:** Responsável pela etapa (`PLANEJAMENTO`, `COMPRAS`, `JURIDICO`, `CONTROLE_INTERNO`); titular e substituto da unidade; titular da secretaria solicitante; Administrador do órgão (`ADMIN_ORGAO`), que liga/desliga o escalonamento nas configurações; Auditor (`AUDITOR`), que verifica qual degrau valeu para cada atraso.

## Pré-condições
- Passagem `ACTIVE`, não pausada (`pausedAt` nulo), com `dueAt` e `slaPolicyId` de uma política com ao menos um degrau (US-189/US-190).
- `sla.escalationEnabled = true` no tenant (padrão) e processo não suspenso.
- Job `deadlines` e fila `notifications` em operação; `NotificationDispatcher` (US-111) e `EmailSender` (US-112) disponíveis.

## Fluxo principal
1. O administrador configurou a política `PREGAO_ALTO_VALOR` com três degraus (US-189): nível 1 em −2 dias úteis avisando responsável e titular da unidade; nível 2 no vencimento (0) avisando também o gestor; nível 3 em +2 dias úteis avisando titular, substituto, gestor e titular da secretaria solicitante, repetindo a cada 2 dias úteis.
2. O processo `0034/2026` entra em `JURIDICO` em 02/03/2026 e recebe `dueAt` em 23/03/2026 (US-190), com `escalationLevel = 0`.
3. A cada 15 minutos o job `deadlines` (com lock distribuído) lê, por lote e por tenant, as passagens `ACTIVE`, não pausadas, com `dueAt` e política com degraus, e pergunta ao `sla` quais degraus estão **vencidos de gatilho** e ainda não disparados (`level` > `escalationLevel`).
4. Em 19/03/2026, primeiro ciclo do dia em que faltam 2 dias úteis ou menos, o nível 1 qualifica: na mesma transação o job grava `escalationLevel = 1` e `lastEscalatedAt`, publica `ProcessStageEscalated` (`level`, `slaPolicyKey`, `dueAt`, `overdueBusinessDays = 0`, `notifyTargets = [ASSIGNEE, DEPARTMENT_HEAD]`) e registra a auditoria `process.stage_escalate`; a timeline projeta `STAGE_ESCALATED`.
5. O `NotificationDispatcher` recebe o evento, resolve os papéis em pessoas (RN-SLA-57), aplica visibilidade, preferências e deduplicação e cria a notificação `SLA_ESCALATION` (e e-mail, se a pessoa e o órgão permitirem). O aviso `STAGE_DUE_SOON` da etapa **não** é criado (substituído pelo degrau).
6. Em 24/03/2026, primeiro ciclo depois do vencimento, o nível 2 dispara; o `ProcessStageOverdue` do MVP 1 também é emitido e `STAGE_OVERDUE` é criado como antes (soma-se ao degrau).
7. Em 25/03/2026, com 2 dias úteis de atraso, o nível 3 dispara; em 27/03/2026 (2 dias úteis depois) o nível 3 é **repetido** (`repeatEveryBusinessDays = 2`), publicando novo `ProcessStageEscalated` do mesmo nível e atualizando `lastEscalatedAt`.
8. No detalhe do processo (SCR-006), o bloco "Prazo" mostra "Escalonamento: nível 3 (último em 27/03/2026)" e o próximo degrau previsto; a timeline traz "Prazo da etapa Jurídico: escalonamento nível 3". Quem foi avisado vê `SLA_ESCALATION` no sininho (SCR-036) e por e-mail.
9. Se a etapa for pausada (US-191), nenhum degrau dispara enquanto durar a pausa; ao retomar, os degraus futuros passam a ser relativos ao novo vencimento e os já disparados não se repetem.
10. O administrador pode desligar os degraus do órgão em **Configurações** (`sla.escalationEnabled = false`, SET-02): a partir do ciclo seguinte nenhum degrau dispara, e os avisos `STAGE_DUE_SOON`/`STAGE_OVERDUE` do MVP 1 voltam a valer para todas as etapas.

## Fluxos alternativos
- **FA-01 — Sem política aplicada à passagem:** nada muda; avisos do MVP 1 (`deadlines.warnBeforeBusinessDays`, `STAGE_DUE_SOON`, `STAGE_OVERDUE`) — RN-SLA-59.
- **FA-02 — Política sem degraus:** valem os avisos do MVP 1; a tela de política já informa isso (US-189 · FA-05) — RN-SLA-59.
- **FA-03 — `sla.escalationEnabled = false`:** nenhum degrau dispara; `STAGE_DUE_SOON` volta a ser criado também nas etapas com política — RN-SLA-60.
- **FA-04 — Alvo do degrau sem pessoa (unidade sem titular, etapa sem responsável):** esse alvo é ignorado e registrado em log `warn`; os demais alvos do degrau continuam; se nenhum alvo resolver, o evento é publicado (o degrau ocorreu) e nenhuma notificação é criada — RN-SLA-57.
- **FA-05 — Pessoa em mais de um alvo (responsável e titular):** recebe uma única notificação do degrau.
- **FA-06 — Destinatário sem visibilidade do processo:** não recebe (DEC-024, RN-NTF-06).
- **FA-07 — Vários degraus qualificados no mesmo ciclo** (ex.: após a retomada de uma pausa longa, ou política alterada): disparam em ordem crescente, um evento por nível; notificações do mesmo processo se agrupam na janela de 5 minutos (RN-NTF-04).
- **FA-08 — Etapa concluída ou devolvida antes do degrau:** a passagem deixa de estar `ACTIVE`; o degrau nunca dispara. Uma reentrada cria nova passagem com `escalationLevel = 0` (RN-SLA-62).
- **FA-09 — Degrau com repetição, etapa resolvida:** a repetição cessa quando a passagem sai de `ACTIVE`, é pausada ou um degrau superior dispara (RN-SLA-56).
- **FA-10 — Processo com orçamento sigiloso:** o texto da notificação não traz valor algum (POL-09); o degrau dispara normalmente.
- **FA-11 — Aviso de vencimento da aprovação por linha:** o escalonamento é por **etapa**; o prazo por linha de aprovador (`ApprovalApprover.dueAt`) não gera degraus (RN-SLA-66).

## Regras de negócio
- **RN-SLA-53** — Um degrau só é avaliado para passagem `ACTIVE`, não pausada (`pausedAt` nulo), com `dueAt` preenchido, `slaPolicyId` de política com ao menos um degrau em `escalationSteps`, processo não suspenso e `sla.escalationEnabled = true`. Passagem de ramo paralelo é avaliada de forma independente (`branchKey` no evento).
- **RN-SLA-54** — Gatilho: `offsetBusinessDays` é sempre contado em **dias úteis** do calendário do tenant, qualquer que seja o `slaType` da etapa. Com `offset < 0`, o degrau qualifica quando `businessDaysLeft ≤ |offset|` (dias úteis entre hoje, exclusive, e a data do vencimento, inclusive); com `offset = 0`, quando `agora > dueAt`; com `offset > 0`, quando `overdueBusinessDays ≥ offset` (dias úteis entre a data do vencimento, exclusive, e hoje, inclusive). `overdueBusinessDays` é zero antes e no vencimento.
- **RN-SLA-55** — Ordem e idempotência: o job dispara, em ordem crescente de `level`, cada degrau qualificado com `level` maior que `escalationLevel`; ao disparar, grava `escalationLevel = level`, `lastEscalatedAt = agora`, a auditoria e o evento **na mesma transação**; um degrau já disparado nunca se repete (exceto RN-SLA-56). O evento carrega `level`, `slaPolicyKey`, `dueAt`, `overdueBusinessDays`, `branchKey?` e `notifyTargets[]` (papéis, não pessoas).
- **RN-SLA-56** — Repetição: com `repeatEveryBusinessDays = k` (só em degrau com `offset ≥ 0`), enquanto aquele degrau for o último disparado (`level = escalationLevel`) e a passagem seguir `ACTIVE` e não pausada, o job republica `ProcessStageEscalated` do **mesmo nível** a cada `k` dias úteis após `lastEscalatedAt`, atualizando `lastEscalatedAt` (o `escalationLevel` não muda). A repetição cessa quando um degrau superior dispara, quando a passagem sai de `ACTIVE` ou é pausada, ou quando a política deixa de ter o degrau.
- **RN-SLA-57** — Resolução de papéis em pessoas (no `NotificationDispatcher`): `ASSIGNEE` = `ProcessStage.assigneeId`; `DEPARTMENT_HEAD` = `Department.headUserId` da unidade da passagem; `DEPARTMENT_DEPUTY` = `Department.deputyUserId` da mesma unidade; `PROCESS_MANAGER_ROLE` = detentores ativos do perfil `GESTOR_CONTRATACOES` com escopo sobre o processo (até 50; acima disso, titular e substituto da unidade — regra do MVP 1, events.md §6); `REQUESTING_SECRETARIAT_HEAD` = `headUserId` da secretaria solicitante do processo. Alvo sem pessoa é ignorado (`warn`); pessoas repetidas entre alvos recebem uma notificação; o ator do evento (inexistente em eventos do sistema) nunca é destinatário (RN-NTF-02).
- **RN-SLA-58** — Notificação `SLA_ESCALATION`: título "Prazo da etapa {nome da etapa}: escalonamento nível {level}"; corpo com código do processo e a situação do prazo ("vence em {N} dias úteis", "venceu em {dd/mm/aaaa}" ou "está atrasado há {N} dias úteis"), sem valores monetários (POL-09, RN-NTF-07); `link` = `/processos/{id}` (RN-NTF-08); canais: in-app sempre e e-mail por padrão (events.md §6), sujeito a `notifications.emailEnabled` e à preferência do usuário (US-113); **não** é obrigatória; só para quem tem visibilidade do processo (DEC-024); agrupamento por `groupKey = SLA_ESCALATION:{processId}` na janela de 5 minutos (RN-NTF-04); idempotente por `(tenant, recipient, sourceEventId, type)` (RN-NTF-03).
- **RN-SLA-59** — Relação com os avisos do MVP 1 (events.md §6): em passagem com política que tem degraus e com `sla.escalationEnabled = true`, o degrau **substitui** a notificação `STAGE_DUE_SOON` (o evento `ProcessStageDueSoon` continua publicado, agora com `slaPolicyKey` e `escalationLevel`, mas o `NotificationDispatcher` não cria `STAGE_DUE_SOON`) e **se soma** a `STAGE_OVERDUE`. Sem política, sem degraus ou com o escalonamento desligado, `STAGE_DUE_SOON` e `STAGE_OVERDUE` seguem US-114 sem nenhuma alteração.
- **RN-SLA-60** — `sla.escalationEnabled` (booleano, padrão `true`, entities.md §8) é editado em `SET-02` por quem tem `SETTINGS_MANAGE`, com a auditoria `settings.update`; valor não booleano → `VALIDATION_ERROR`. Desligar não apaga o `escalationLevel` das passagens; ao religar, valem os degraus ainda não disparados.
- **RN-SLA-61** — Registro: cada disparo publica `ProcessStageEscalated` (`process.stage_escalated`), projeta `STAGE_ESCALATED` na timeline ("Prazo da etapa {stageName}: escalonamento nível {level}", grupo "Prazos") e grava a auditoria `process.stage_escalate` (`WORKFLOW`, `actorType = SYSTEM`); `ProcessStageDueSoon`/`ProcessStageOverdue` passam a carregar `slaPolicyKey` e `escalationLevel` (campos opcionais aditivos, events.md §2).
- **RN-SLA-62** — Pausa, suspensão e reentrada: etapa pausada (US-191) ou processo suspenso não dispara degrau nem repetição; ao retomar, os degraus ainda não disparados passam a ser relativos ao novo `dueAt` e `escalationLevel` não é alterado; uma nova passagem (reentrada, devolução) começa com `escalationLevel = 0` e `lastEscalatedAt` nulo.
- **RN-SLA-63** — Execução: ciclo do job `deadlines` a cada 15 minutos, com lock distribuído por ciclo (RN-TRAM-85), lotes por tenant e bloqueio por passagem (`FOR UPDATE SKIP LOCKED`); o atraso máximo de detecção é de um ciclo e a notificação sai em até 1 minuto do processamento do evento (US-114). Nenhuma avaliação de escalonamento ocorre dentro de transação de comando de usuário.
- **RN-SLA-64** — Reavaliação por mudança de política: `SlaPolicyChanged` (consumidor `SlaEvaluator`) faz o ciclo seguinte considerar os degraus **atuais** da política para as passagens em curso que a usam; degraus acrescentados passam a valer (com `level` maior que `escalationLevel`), removidos deixam de disparar, e `escalationLevel` e `lastEscalatedAt` são preservados (degrau já disparado não repete).
- **RN-SLA-65** — Transparência: SLA-12 expõe, por passagem, `escalationLevel`, `lastEscalatedAt` e `nextEscalation` (`level`, `offsetBusinessDays`, `expectedOn` — data prevista pelo calendário); o SCR-006 mostra o degrau atual e o próximo; a tela de política (SCR-121) mostra aviso quando `sla.escalationEnabled` está desligado.
- **RN-SLA-66** — Escopo: o escalonamento é **por passagem de etapa**; o prazo por linha de aprovador (`ApprovalApprover.dueAt`, US-190) e as notificações de prazo de aprovação por linha **não** geram degraus; o prazo de diligência do jurídico (`LegalReviewDiligence.dueAt`, US-153) tem lembretes próprios.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Escalonamento de prazos ligado | `sla.escalationEnabled` (SET-02) | booleano | Não | RN-SLA-60 | `true` |
| Último degrau disparado | `escalationLevel` | inteiro 0..5 | — | RN-SLA-55 | `ProcessStage` (padrão 0) |
| Último disparo em | `lastEscalatedAt` | datetime \| nulo | — | RN-SLA-55/56 | `ProcessStage` |
| Próximo degrau | `nextEscalation { level, offsetBusinessDays, expectedOn }` | objeto \| nulo | — | RN-SLA-65 | calculado (SLA-12) |
| Dias úteis de atraso | `overdueBusinessDays` | inteiro ≥ 0 | — | RN-SLA-54 | calculado (evento) |
| Alvos do degrau | `notifyTargets[]` | lista de papéis | — | RN-SLA-55/57 | `SlaEscalationStep.notify` |
| Política | `slaPolicyKey` | texto | — | RN-SLA-61 | `ProcessStage.slaPolicyId` |
| Papel avisado | `notify` (cadastro, US-189) | lista de enum | Sim (por degrau) | `ASSIGNEE`, `DEPARTMENT_HEAD`, `DEPARTMENT_DEPUTY`, `PROCESS_MANAGER_ROLE`, `REQUESTING_SECRETARIAT_HEAD` | política |
| Repetir a cada (dias úteis) | `repeatEveryBusinessDays` (cadastro, US-189) | inteiro 1–30 | Não | só com `offset ≥ 0` | política |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `sla.escalationEnabled` com valor não booleano (SET-02) | API (Zod) | "Informe sim ou não para o escalonamento de prazos." | `VALIDATION_ERROR` (`INVALID_TYPE`) |
| V-02 | `If-Match`/versão de configurações divergente (SET-02, herdada) | API | "As configurações foram alteradas por outra pessoa. Recarregue e tente de novo." | `VERSION_CONFLICT` |
| V-03 | Sem `SETTINGS_MANAGE` (SET-01/SET-02) | API | "Você não tem permissão para alterar as configurações." | `PERMISSION_DENIED` |
| V-04 | Processo inexistente, de outro tenant ou não visível (SLA-12, PRC-12) | API | "Processo não encontrado." | `PROCESS_NOT_FOUND` |
| V-05 | Passagem não elegível ao degrau (pausada, não ativa, sem `dueAt` ou sem política com degraus) | Worker (interno) | — | — (ignorada; sem log de erro) |
| V-06 | Alvo do degrau sem pessoa resolvível | Worker (interno) | — | — (alvo ignorado; log `warn` `sla.escalation_target_unresolved`) |
| V-07 | Banco indisponível na leitura de SLA-12 / SET-02 | API | "Não foi possível carregar as informações agora." | `DEPENDENCY_UNAVAILABLE` |

## Permissões
- **Permissão:** nenhuma para o disparo (ator `SYSTEM` no job). `SETTINGS_MANAGE` para ligar/desligar `sla.escalationEnabled` (SET-01/SET-02, US-103); `PROCESS_VIEW` (DEC-024) para SLA-12 e para a timeline (PRC-12). Quem recebe a notificação precisa ter visibilidade do processo.
- **Políticas:** DEC-024 e RN-NTF-06 (visibilidade do destinatário); POL-09 (conteúdo sem valores); POL-27 (alterações de política só valem para efeitos futuros); US-113 (preferências do usuário).
- **MFA:** não exigido (`SETTINGS_MANAGE` não é de risco `H`, salvo política do tenant para alterações de configuração).
- **Sem permissão:** a API responde 403 `PERMISSION_DENIED` e registra `access.denied`; a opção "Escalonamento de prazos" não é exibida sem `SETTINGS_MANAGE`; processo não visível → 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageEscalated` | `process.stage_escalated` | Job `deadlines`, a cada degrau (e a cada repetição) | `processStageId`, `stageKey`, `branchKey?`, `slaPolicyKey`, `level`, `dueAt`, `overdueBusinessDays`, `notifyTargets[]`; consumidores T (timeline `STAGE_ESCALATED`), N (notificação `SLA_ESCALATION`), R (read model) e NR (regras de notificação, US-193) |
| `ProcessStageDueSoon` | `process.stage_due_soon` | Job `deadlines` (como no MVP 1) | Ganha `slaPolicyKey?` e `escalationLevel?`; a notificação `STAGE_DUE_SOON` é suprimida com política e degraus (RN-SLA-59) |
| `ProcessStageOverdue` | `process.stage_overdue` | Job `deadlines` (como no MVP 1) | Ganha `slaPolicyKey?` e `escalationLevel?`; `STAGE_OVERDUE` continua sendo criada |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `SLA_ESCALATION` | Papéis do degrau (`SlaEscalationStep.notify`): responsável, titular/substituto da unidade, gestor, titular da secretaria solicitante | in-app + e-mail (padrão sim; não obrigatória) | `ProcessStageEscalated` |
| `STAGE_DUE_SOON` *(MVP 1)* | Responsável da etapa (ou titular) | in-app | Só sem política, sem degraus ou com escalonamento desligado; **suprimida** com política e degraus |
| `STAGE_OVERDUE` *(MVP 1)* | Responsável e titular da unidade | in-app + e-mail | Continua em todos os casos (soma-se ao degrau) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Escalonar prazos em degraus

  Background:
    Given que o tenant "Prefeitura A" está ativo e "sla.escalationEnabled" é verdadeiro
    And a política ativa "PREGAO_ALTO_VALOR" tem os degraus: nível 1 em -2 avisando "ASSIGNEE" e "DEPARTMENT_HEAD"; nível 2 em 0 avisando "ASSIGNEE", "DEPARTMENT_HEAD" e "PROCESS_MANAGER_ROLE"; nível 3 em +2 avisando "DEPARTMENT_HEAD", "DEPARTMENT_DEPUTY", "PROCESS_MANAGER_ROLE" e "REQUESTING_SECRETARIAT_HEAD" repetindo a cada 2 dias úteis
    And o processo "0034/2026" está em "JURIDICO" com "dueAt" em 23/03/2026 às 23:59:59.999 e "escalationLevel" 0
    And "Helena Prado" é a responsável, "Roberto Alves" é titular e "Sílvia Nunes" é substituta da "Procuradoria", "Fernanda Lima" é gestora de contratações e "Marcos Lima" é titular da "Secretaria de Administração" solicitante
    And o calendário não tem feriados entre 16/03/2026 e 31/03/2026

  Scenario: [Sucesso] Degrau 1 antes do vencimento substitui o aviso de vencimento
    When o job "deadlines" executar em quinta-feira 19/03/2026 às 08:00
    Then a etapa deve ter "escalationLevel" 1 e "lastEscalatedAt" preenchido
    And deve gerar o evento "ProcessStageEscalated" com "level" 1, "overdueBusinessDays" 0 e "notifyTargets" ["ASSIGNEE", "DEPARTMENT_HEAD"]
    And deve gerar registro de auditoria "process.stage_escalate" com ator "SYSTEM" e a entrada de timeline "STAGE_ESCALATED"
    And "Helena Prado" e "Roberto Alves" devem receber a notificação "SLA_ESCALATION"
    And a notificação "STAGE_DUE_SOON" não deve ser criada para esta etapa

  Scenario: [Sucesso] Degrau 2 no vencimento soma-se ao aviso de atraso
    Given que o nível 1 já foi disparado
    When o job "deadlines" executar em terça-feira 24/03/2026 às 08:00
    Then a etapa deve ter "escalationLevel" 2 e deve gerar o evento "ProcessStageEscalated" com "level" 2 e "notifyTargets" ["ASSIGNEE", "DEPARTMENT_HEAD", "PROCESS_MANAGER_ROLE"]
    And "Helena Prado", "Roberto Alves" e "Fernanda Lima" devem receber "SLA_ESCALATION"
    And o evento "ProcessStageOverdue" deve ser emitido e "Helena Prado" e "Roberto Alves" devem receber também "STAGE_OVERDUE"
    And deve gerar registro de auditoria "process.stage_escalate" e a entrada de timeline "STAGE_ESCALATED"

  Scenario: [Sucesso] Degrau 3 depois do vencimento com repetição a cada 2 dias úteis
    Given que os níveis 1 e 2 já foram disparados
    When o job "deadlines" executar em quarta-feira 25/03/2026 às 08:00
    Then deve gerar o evento "ProcessStageEscalated" com "level" 3 e "overdueBusinessDays" 2
    And "Roberto Alves", "Sílvia Nunes", "Fernanda Lima" e "Marcos Lima" devem receber "SLA_ESCALATION"
    When o job executar em quinta-feira 26/03/2026 às 08:00
    Then nenhum novo evento "ProcessStageEscalated" deve ser emitido
    When o job executar em sexta-feira 27/03/2026 às 08:00
    Then deve ser emitido novo "ProcessStageEscalated" com "level" 3 e "lastEscalatedAt" atualizado, e "escalationLevel" deve continuar 3

  Scenario: [Sucesso] Sem política ou com o escalonamento desligado valem os avisos do MVP 1
    Given que o processo "0035/2026" está em "PLANEJAMENTO" sem política aplicada e a 2 dias úteis do vencimento
    When o job "deadlines" executar
    Then deve ser emitido "ProcessStageDueSoon" e criada a notificação "STAGE_DUE_SOON" como no MVP 1
    Given que "Marina Costa" desligou "sla.escalationEnabled"
    When o job "deadlines" executar em 19/03/2026 para o processo "0034/2026"
    Then nenhum evento "ProcessStageEscalated" deve ser emitido e a notificação "STAGE_DUE_SOON" deve ser criada normalmente
    And deve existir registro de auditoria "settings.update" da alteração de "sla.escalationEnabled"

  Scenario: [Validação] Configuração inválida e alvos sem pessoa
    When "Marina Costa" enviar "sla.escalationEnabled" igual a "sim" em "PATCH /settings"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_TYPE" no campo "sla.escalationEnabled"
    Given que a "Procuradoria" não tem substituta
    When o degrau 3 disparar com o alvo "DEPARTMENT_DEPUTY"
    Then o alvo sem pessoa deve ser ignorado com log "warn" "sla.escalation_target_unresolved"
    And os demais alvos devem receber a notificação e o evento "ProcessStageEscalated" deve ser emitido

  Scenario: [Permissão] Alteração da configuração sem permissão e destinatário sem visibilidade
    Given que "Bruno Lopes" não possui "SETTINGS_MANAGE"
    When "Bruno Lopes" enviar "PATCH /settings" com "sla.escalationEnabled" falso
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Fernanda Lima" não tem mais visibilidade do processo "0034/2026"
    When o degrau 2 disparar
    Then "Fernanda Lima" não deve receber "SLA_ESCALATION"
    And os demais destinatários com visibilidade devem receber normalmente

  Scenario: [Tenant incorreto] Job processa cada tenant isoladamente
    Given que o tenant "Prefeitura B" tem a política "PREGAO_ALTO_VALOR" com degraus diferentes e um processo com "dueAt" na mesma data
    When o job "deadlines" executar
    Then os degraus de cada tenant devem ser avaliados somente com a política e os destinatários do próprio tenant
    And nenhuma notificação do tenant "Prefeitura B" deve ser criada para usuários da "Prefeitura A"

  Scenario: [Duplicidade] Reexecução do job não repete o degrau
    Given que o degrau 1 já foi disparado em 19/03/2026 às 08:00
    When o job "deadlines" executar novamente às 08:15 e às 08:30
    Then não deve haver novo evento "ProcessStageEscalated" nem nova notificação "SLA_ESCALATION"
    And "escalationLevel" deve continuar 1
    Given que o mesmo evento "ProcessStageEscalated" for reentregue à fila "notifications"
    Then cada destinatário deve ter no máximo uma notificação para aquele evento

  Scenario: [Concorrência] Duas instâncias do worker no mesmo ciclo e pausa simultânea
    When duas instâncias do worker iniciarem o ciclo ao mesmo tempo para a etapa de "JURIDICO"
    Then apenas uma deve obter o lock distribuído e a etapa deve ter um único disparo do degrau 1
    Given que a etapa é pausada por diligência no mesmo instante em que o degrau 2 qualificaria
    When o job e a pausa concorrerem pela passagem
    Then o degrau não deve ser disparado se a pausa for confirmada antes, e "escalationLevel" deve refletir somente o que foi persistido

  Scenario: [Falha de banco] Falha ao gravar o disparo do degrau
    Given que o banco de dados fica indisponível durante a transação do degrau 1
    When o job "deadlines" processar a etapa
    Then a transação deve ser desfeita e "escalationLevel" deve continuar 0 sem evento, auditoria ou notificação
    And o degrau deve ser disparado no ciclo seguinte, uma única vez, quando o banco voltar

  Scenario: [Falha de integração] E-mail indisponível e Redis do lock indisponível
    Given que o provedor de e-mail (SMTP/SES) está indisponível
    When o degrau 2 disparar
    Then as notificações in-app devem ser criadas e o e-mail deve ficar "PENDING" para novas tentativas da fila "email"
    And o evento "ProcessStageEscalated" não deve ser republicado
    Given que o Redis do lock distribuído está indisponível
    When o job "deadlines" iniciar o ciclo
    Then o ciclo deve ser ignorado com log "warn" "process.deadlines_lock_skipped" e nenhum degrau deve ser disparado em duplicidade
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Valor inválido em `sla.escalationEnabled` | 422 | `VALIDATION_ERROR` | "Informe sim ou não para o escalonamento de prazos." | Marca o campo |
| Sem `SETTINGS_MANAGE` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar as configurações." | Oculta a opção |
| Versão de configurações divergente | 412 | `VERSION_CONFLICT` | "As configurações foram alteradas por outra pessoa. Recarregue e tente de novo." | Recarrega |
| Processo inexistente, de outro tenant ou não visível | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Volta à lista |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar as informações agora." | Botão "Tentar novamente"; respeita `Retry-After` |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

O disparo do degrau é assíncrono e não tem resposta HTTP; falhas do job são tratadas por novo ciclo e por *retry* da fila `notifications`/`email` (5 tentativas, backoff exponencial); esgotadas, vão à fila de falhas com alerta operacional.

## Dependências
- **Stories:** US-114 (avisos de prazo e notificação `STAGE_DUE_SOON`/`STAGE_OVERDUE` — a base que o degrau substitui e soma), US-190 (política aplicada e `dueAt` da passagem). Indiretas: US-189 (cadastro dos degraus), US-191 (pausa interrompe o escalonamento), US-055 (job `deadlines`, calendário e idempotência do MVP 1), US-111/US-112/US-113 (central, e-mail e preferências), US-103 (configurações do órgão), US-193 (regras de notificação podem usar `ProcessStageEscalated`), US-060 (timeline).
- **Decisões/ADRs:** DEC-205, DEC-031, DEC-206, DEC-024; ADR-015; POL-09, POL-27.
- **Configurações:** `sla.escalationEnabled` (padrão `true`), `deadlines.warnBeforeBusinessDays` (avisos do MVP 1), `notifications.emailEnabled`.
- **Lacunas nas fontes canônicas:**
  1. **Política sem degraus:** `events.md §6` diz que com política os degraus substituem `STAGE_DUE_SOON`, mas não trata política com `escalationSteps` vazio; esta story propõe manter os avisos do MVP 1 nesse caso (RN-SLA-59), para não deixar a etapa sem aviso nenhum. **Dúvida de produto.**
  2. **Definição de `overdueBusinessDays`:** `events.md §4.1` cita o campo sem a regra; RN-SLA-54 propõe zero antes e no vencimento e positivo depois (dias úteis entre o vencimento e hoje). Para degraus antes do vencimento o campo é 0 e o `dueAt` do evento informa o restante.
  3. **Resolução de `PROCESS_MANAGER_ROLE`:** não há definição do "gestor" além do rótulo em `events.md §6`; RN-SLA-57 resolve como detentores do perfil `GESTOR_CONTRATACOES` com escopo sobre o processo. Confirmar.
  4. **Substituição de `STAGE_DUE_SOON` no despachante:** exige que o `NotificationDispatcher` conheça se a passagem tem política com degraus (consulta ao `sla`); `events.md` não descreve esse ponto de integração.
  5. **Prioridade da notificação** (`NotificationPriority`): `events.md §6` não define; esta story usa `NORMAL`.
  6. **`sla.escalationEnabled`:** a chave consta de `entities.md §8`, mas a validação e a exibição na tela de configurações dependem do registro de chaves da US-103/US-105; incluir a chave no catálogo de configurações do MVP 2.
  7. **Notificação de escalonamento para etapa de aprovação por linha** não é tratada (RN-SLA-66).

## Impacto técnico
- **Job `deadlines` mais pesado:** além dos avisos do MVP 1, avalia degraus por passagem com política; a varredura continua limitada por índice `(tenant_id, due_at) WHERE status = 'ACTIVE'` e filtra por `sla_policy_id IS NOT NULL`; lotes por tenant e `SKIP LOCKED` evitam contenção. O cálculo de `businessDaysLeft`/`overdueBusinessDays` usa o calendário em memória do ciclo.
- **Atomicidade:** `escalationLevel`, `lastEscalatedAt`, auditoria e outbox são gravados na mesma transação curta por passagem; a notificação é assíncrona (idempotente por evento).
- **Coexistência com US-114:** o `NotificationDispatcher` ganha uma única regra nova (suprimir `STAGE_DUE_SOON` quando a passagem tem política com degraus); toda a lógica de resolução do MVP 1 permanece; teste de contrato garante que sem política o comportamento é idêntico.
- **Risco de ruído:** o degrau de vencimento (offset 0) e `STAGE_OVERDUE` podem alcançar as mesmas pessoas no mesmo ciclo; é desejado (events.md §6) e mitigado por agrupamento por tipo/processo e pela orientação no cadastro (US-189).
- **Fuso e calendário:** gatilhos usam a data local do tenant (DEC-003) e o calendário do ciclo; teste de virada de dia.
- **Observabilidade:** métricas `cf_sla_escalations_total{level}` e `cf_sla_escalation_lag_seconds` (tempo entre o gatilho e o disparo) para acompanhar a meta de ≥ 90% antes de 3 dias úteis.

## Backend
- **Módulo(s):** `sla` (dono: `EscalationPlanner`, consulta do job), `process` (`ProcessDeadlinesJob`, `ProcessStage.escalate`, SLA-12, timeline), `notification` (`NotificationDispatcher` — tipo `SLA_ESCALATION`, supressão de `STAGE_DUE_SOON`), `audit`, `platform` (fila, lock distribuído, `OutboxWriter`), configurações (`TenantSettings`).
- **Casos de uso:** `ProcessDeadlinesJob` (estendido: `EscalateStagesStep`); `SlaFacade.listDueEscalations(processStage, now)`; `SlaFacade.replacesDueSoon(processStageId)`; `NotificationDispatcher.onProcessStageEscalated`; `UpdateTenantSettingsCommand` (chave `sla.escalationEnabled`).
- **Domínio:** `EscalationPlanner` (gatilho por offset, ordem crescente, repetição), `ProcessStage.escalate(level, at)`, `EscalationRecipientsResolver` (papéis → pessoas, dedupe, limite de 50), `BusinessCalendarFacade.businessDaysBetween`.
- **Integrações internas:** `BusinessCalendarFacade`, `DepartmentFacade` (titular/substituto), `OrganizationFacade` (secretaria solicitante), `AccessFacade` (detentores do perfil de gestor e visibilidade), `TimelineProjector`, `AuditService`.
- **Transação:** por passagem: bloqueio (`FOR UPDATE SKIP LOCKED`) → reconferência dos pré-requisitos e do `escalationLevel` → gravação de `escalationLevel`/`lastEscalatedAt` → auditoria → outbox (`ProcessStageEscalated`) → projeção síncrona na timeline → commit; a notificação ocorre depois, na fila `notifications`.

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`) — bloco "Prazo" e timeline; SCR-121 (`/admin/prazos`) — banner de escalonamento desligado; tela de Configurações (SET-01/SET-02) — opção "Escalonamento de prazos"; central de notificações (SCR-036) — tipo `SLA_ESCALATION`.
- **Componentes:** `StageDeadlineCard` com `EscalationLevelLabel` ("Escalonamento: nível 2 — último em 24/03/2026" e "Próximo: nível 3 previsto para 25/03/2026"), entrada de timeline `STAGE_ESCALATED`, item de notificação com ícone de prazo, `EscalationDisabledBanner`, interruptor "Escalonamento de prazos" nas configurações.
- **Estados:** sem degrau disparado ("Nenhum escalonamento ainda"); degrau atual; escalonamento desligado; erro isolado do bloco; carregando (skeleton).
- **Acessibilidade e responsividade:** nível e data por texto e ícone; interruptor com rótulo e descrição ("Quando desligado, valem apenas os avisos padrão de vencimento"); contraste AA; blocos em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `process_stages` (`escalation_level`, `last_escalated_at`, `sla_policy_id`, `due_at`, `paused_at`), leitura de `sla_policies` (`escalation_steps`), `departments`, `tenant_settings`; `audit_logs`, `outbox_events`, `timeline_entries`, `notifications`.
- **Migrações:** nenhuma nesta story (colunas de `process_stages` em M2-05; `sla_policies` em M2-10; chave de configuração semeada em M2-21).
- **Índices/constraints relevantes:** `(tenant_id, due_at) WHERE status = 'ACTIVE'` (varredura); possível índice parcial `(tenant_id, due_at) WHERE status = 'ACTIVE' AND sla_policy_id IS NOT NULL AND paused_at IS NULL` para a varredura de degraus, a confirmar na carga de teste; unicidade de `Notification (tenant_id, recipient_id, source_event_id, type)` garante idempotência da entrega.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `SET-01` | GET | `/api/v1/settings` | — (US-103) | inclui `sla.escalationEnabled` | 200, 401, 403, 503 |
| `SET-02` | PATCH | `/api/v1/settings` | `{ "sla.escalationEnabled": boolean }` + `If-Match` (US-103) | `200`; `TenantSettingsChanged` | 200, 401, 403, 412, 422, 503 |
| `SLA-12` | GET | `/api/v1/processes/{id}/sla` | path `id`; query `includeClosed` | `stages[]` com `escalationLevel`, `lastEscalatedAt`, `nextEscalation` (campos criados em US-190, preenchidos aqui); `meta.escalationEnabled` | 200, 401, 403, 404, 422, 429, 503 |
| `PRC-12` | GET | `/api/v1/processes/{id}/timeline` | filtros do MVP 1 (grupo "Prazos") | entradas `STAGE_ESCALATED` (`stageName`, `level`) | 200, 401, 403, 404, 429, 503 |
| `NTF-01` | GET | `/api/v1/notifications` | filtros do MVP 1 | itens `SLA_ESCALATION` (título, corpo, `link`) | 200, 401, 422, 429, 503 |

Não há endpoint de escrita novo para o escalonamento: o disparo é do job `deadlines`.

## Logs
- `info` `sla.escalation_fired` — `processStageId`, `slaPolicyKey`, `level`, `overdueBusinessDays`, `repeat` (booleano), `targets`, `durationMs`, `correlationId`.
- `info` `process.deadlines_job_run` — já existente; acrescenta `escalationsFired`, `escalationsRepeated`.
- `warn` `sla.escalation_target_unresolved` — `processStageId`, `target` (papel); `warn` `process.deadlines_lock_skipped` (já existente); `warn` `sla.escalation_no_recipients`.
- `error` `sla.escalation_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** nomes ou e-mails dos destinatários, valores do processo, título do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.stage_escalate` | `WORKFLOW` | A cada disparo e repetição de degrau pelo job | `changes`: `escalationLevel` (de → para); `metadata`: `processStageId`, `stageKey`, `level`, `slaPolicyKey`, `repeat`; `actorType = SYSTEM` |
| `settings.update` | `CONFIGURATION` | Alteração de `sla.escalationEnabled` (SET-02) | `changes`: chave, valor anterior e novo |
| `access.denied` | `ACCESS` | 403 em SET-01/SET-02 | `reasonCode = SETTINGS_MANAGE` |

## Testes necessários
- **Unitários:** `EscalationPlanner` (gatilhos −2/0/+2 com fins de semana e feriados, ordem crescente, múltiplos níveis qualificados, repetição e sua interrupção); `EscalationRecipientsResolver` (cada papel, dedupe, alvo sem pessoa, limite de 50, visibilidade); `replacesDueSoon` por combinação (política × degraus × configuração).
- **Integração (Testcontainers + relógio controlado):** ciclo completo 19/03 → 24/03 → 25/03 → 27/03; pausa e retomada interrompendo e deslocando degraus; reentrada com `escalationLevel = 0`; política alterada com `SlaPolicyChanged`; supressão de `STAGE_DUE_SOON` e soma a `STAGE_OVERDUE`; `sla.escalationEnabled` ligado/desligado; atomicidade do disparo (rollback).
- **API/contrato:** SLA-12 com `escalationLevel`/`nextEscalation`; `settings` com a chave nova; **contrato do MVP 1** de `ProcessStageDueSoon`/`Overdue` e de `STAGE_DUE_SOON`/`STAGE_OVERDUE` inalterado sem política; eventos com campos aditivos.
- **RBAC e multi-tenant:** job isolado por tenant (suíte "tenant leak": `process_stages` com `escalation_level`, notificações `SLA_ESCALATION`); destinatário sem visibilidade não recebe; `SETTINGS_MANAGE` em SET-02.
- **Concorrência:** duas instâncias do worker (lock); job × pausa; reentrega da fila `notifications`.
- **E2E (Playwright):** configurar política com três degraus, avançar o relógio e ver notificações e a timeline do processo; desligar `sla.escalationEnabled` e ver os avisos do MVP 1.
- **Acessibilidade/performance:** axe em `EscalationLevelLabel` e no interruptor de configuração; job com 10.000 passagens ativas e 2.000 com política e degraus dentro da janela de 15 minutos (suíte de performance).

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
- [ ] Teste de contrato prova que, sem política, sem degraus ou com o escalonamento desligado, `STAGE_DUE_SOON`/`STAGE_OVERDUE` são idênticos ao MVP 1
- [ ] Teste prova idempotência por `escalationLevel` sob reexecução do job, duas instâncias e reentrega de evento
- [ ] Métricas `cf_sla_escalations_total` e `cf_sla_escalation_lag_seconds` expostas

## Estimativa
**M** — sem tabela nova: o esforço está no planejador de degraus (gatilho em dias úteis, ordem, repetição), na resolução de papéis para pessoas com visibilidade, na coexistência com os avisos do MVP 1 e na idempotência sob concorrência do job.

## Prioridade
**P1** — dá ao gestor aviso antes do atraso (meta do épico) e completa o valor das políticas de SLA; depende de US-190 e de US-114 e não bloqueia as etapas P0 do DT-02/DT-03.
