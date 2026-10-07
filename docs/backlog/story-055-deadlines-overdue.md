---
id: US-055
title: "Prazos em dias úteis e detecção de atrasos"
epic: EP-008
feature: FT-035
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-047, US-083, US-106]
modules: [process, workflow, catalog, notification, audit, platform]
screens: [SCR-006, SCR-013]
endpoints: [CAL-06]
permissions: [PROCESS_VIEW]
events: [ProcessStageDueSoon, ProcessStageOverdue]
---

# US-055 — Prazos em dias úteis e detecção de atrasos

## Título
Calcular prazos em dias úteis e detectar atrasos de etapa

## Descrição
**Como** responsável por uma etapa (ou titular da unidade), **quero** que o sistema calcule o prazo da etapa em dias úteis — considerando feriados, pausas por suspensão e eventuais sobrescritas — e me avise antes do vencimento e quando ele for excedido, **para** agir a tempo e para que a organização tenha visibilidade objetiva dos atrasos no trâmite.

O prazo (`dueAt`) é calculado no instante em que o processo entra em cada etapa (encaminhamento — US-047, decisão de aprovação — US-052, ou criação — US-001), sempre como o **fim do dia útil** do N-ésimo dia a partir da entrada, usando o calendário de dias úteis do tenant (`CAL-06`). Um job (`deadlines`, a cada 15 minutos) varre as etapas ativas e emite `ProcessStageDueSoon` perto do vencimento e `ProcessStageOverdue` quando o prazo é excedido, sem duplicar avisos.

## Contexto
- Hoje, prazos de tramitação são acompanhados em planilhas paralelas ou não são acompanhados — atrasos só aparecem quando alguém cobra manualmente. O art. 169 da Lei 14.133/2021 exige controle e fiscalização tempestivos; prazos explícitos e alertas automáticos são a base desse controle na fase preparatória.
- Baseia-se inteiramente em DEC-031 (Prazos e calendário): SLA por etapa (`WorkflowStage.slaDays`/`slaType`), dias úteis = segunda a sexta exceto `Holiday` do tenant (nacionais semeados, inclusive móveis; estaduais/municipais cadastrados; facultativos conforme `calendar.optionalHolidaysAreNonBusiness`), suspensão pausa a contagem e a retomada estende `dueAt` pelo tempo pausado, atraso = `now > dueAt` detectado pelo job `deadlines`, aviso antecipado conforme `deadlines.warnBeforeBusinessDays` (padrão 2).
- `ProcessStage` já tem todos os campos necessários (`dueAt`, `slaDays`, `slaType`, `dueDateOverridden`, `dueDateOverrideReason`, `pausedAt`, `pausedTotalSeconds`, `overdueSince`, `dueSoonNotifiedAt`, `overdueNotifiedAt` — entities.md §4.4); `WorkflowTransition.allowDueDateOverride` e `requiresComment` controlam se e como o prazo pode ser sobrescrito no encaminhamento (US-047).
- Depende do calendário de dias úteis e do endpoint `CAL-06` (US-106) e da infraestrutura de notificações (US-083); é consumida por toda ação que posiciona o processo em uma nova etapa (US-001, US-047, US-048, US-052, US-053).

## Objetivo
Garantir que 100% das etapas com SLA configurado tenham `dueAt` calculado corretamente em dias úteis (ou corridos) e que todo atraso seja detectado em até 15 minutos do vencimento, sem aviso ou detecção duplicados, mesmo com múltiplas instâncias do worker.

## Persona
- **Principal:** responsável atual da etapa (recebe os avisos) e titular da unidade atual (recebe quando não há responsável individual ou como reforço no atraso).
- **Secundárias:** gestor de contratações (visão agregada de etapas a vencer/atrasadas no dashboard e na caixa de tarefas).

## Pré-condições
- `ProcessStage` ativa com `WorkflowStage.slaDays` configurado (etapas sem SLA não participam).
- Calendário de dias úteis do tenant configurado (feriados nacionais semeados — US-106).

## Fluxo principal
1. O processo entra em uma nova `ProcessStage` (criação, encaminhamento, devolução ou decisão de aprovação). Se `WorkflowStage.slaDays` for nulo, `dueAt` fica nulo (etapa sem prazo) e o fluxo termina aqui.
2. Caso contrário, o sistema chama `CAL-06` com `fromDateTime = enteredAt`, `businessDays = slaDays` e `dayCountType = slaType` (`BUSINESS` ou `CALENDAR`), obtendo a data do N-ésimo dia; normaliza o resultado para o **fim do dia** (`23:59:59.999`) no fuso do tenant e converte para UTC, gravando em `ProcessStage.dueAt`, com `slaDays`/`slaType` copiados como snapshot.
3. Se a `WorkflowTransition` usada permitir sobrescrita (`allowDueDateOverride = true`) e o usuário informar uma nova data no encaminhamento, `dueAt` é substituído pelo valor informado (também normalizado para o fim do dia), `dueDateOverridden = true` e `dueDateOverrideReason` é gravado (obrigatório).
4. O job **`deadlines`** (fila BullMQ, repetível a cada 15 minutos, com lock distribuído) varre as `ProcessStage` com `status = ACTIVE`, `pausedAt IS NULL` e `dueAt` preenchido:
   1. para as que estão a `deadlines.warnBeforeBusinessDays` dias úteis (padrão 2) ou menos do vencimento e `dueSoonNotifiedAt IS NULL`: grava `dueSoonNotifiedAt = now` e emite `ProcessStageDueSoon`;
   2. para as que já venceram (`now > dueAt`) e `overdueSince IS NULL`: grava `overdueSince = now` e `overdueNotifiedAt = now`, e emite `ProcessStageOverdue`.
5. Quando o processo é suspenso (US-008), a `ProcessStage` ativa recebe `pausedAt = now`; o job passa a ignorá-la enquanto estiver pausada.
6. Quando o processo é retomado, `pausedTotalSeconds += (now - pausedAt)`, `dueAt` é estendido pelo mesmo intervalo e `pausedAt` volta a `NULL`; `overdueSince`, se já preenchido, não é alterado (reflete o instante real em que o atraso começou).
7. As telas que exibem a etapa (painel do processo — SCR-006; caixa de tarefas — SCR-013) mostram o prazo com indicador visual: normal, "vence em breve" (após `ProcessStageDueSoon`) ou "atrasado" (após `ProcessStageOverdue`).

## Fluxos alternativos
- **FA-01 — Etapa sem SLA configurado:** `dueAt` permanece nulo; a UI exibe "Sem prazo definido"; a etapa nunca entra no job `deadlines`.
- **FA-02 — Sobrescrita negada pela transição:** se `allowDueDateOverride = false` e o usuário tentar informar uma nova data, a API responde `DUE_DATE_OVERRIDE_NOT_ALLOWED` (422) e o campo não aparece na UI para aquela transição.
- **FA-03 — Feriado estadual/municipal altera o cálculo:** `CAL-06` soma o `Holiday` cadastrado do tenant (nacional, estadual, municipal); pontos facultativos contam como não úteis somente se `calendar.optionalHolidaysAreNonBusiness = true`.
- **FA-04 — Processo suspenso com etapa já atrasada:** `overdueSince` é preservado; a UI mostra "Atrasado (suspenso)" até a retomada.
- **FA-05 — Aviso antecipado desativado:** `deadlines.warnBeforeBusinessDays = 0` suprime `ProcessStageDueSoon`; o atraso ainda é detectado normalmente.
- **FA-06 — Atraso do processo por prazo alvo (`targetDate`):** diferente do atraso de etapa, é apenas um indicador informativo ("Fora do prazo planejado") quando `targetDate < hoje` e o status não é final (DEC-031); não gera `overdueSince` nem notificação.

## Regras de negócio
- **RN-TRAM-78** — `dueAt` é calculado na entrada de cada `ProcessStage` com `slaDays` configurado: fim do dia (`23:59:59.999`, fuso do tenant, convertido a UTC) do N-ésimo dia a partir de `enteredAt`, contado conforme `slaType` via `CAL-06` (`BUSINESS`, considerando `Holiday` do tenant, ou `CALENDAR`). Sem `slaDays`, `dueAt` fica nulo.
- **RN-TRAM-79** — Sobrescrita de `dueAt` só é aceita quando a `WorkflowTransition` usada tiver `allowDueDateOverride = true`; exige `dueDateOverrideReason`; marca `dueDateOverridden = true`; o valor informado também é normalizado para o fim do dia.
- **RN-TRAM-80** — Suspensão pausa a contagem de todas as `ProcessStage` `ACTIVE` do processo (`pausedAt = now`); a retomada soma o tempo pausado a `pausedTotalSeconds` e estende `dueAt` pelo mesmo intervalo; `overdueSince` não é recalculado pela pausa/retomada.
- **RN-TRAM-81** — O job `deadlines` roda a cada 15 minutos e só considera `ProcessStage` com `status = ACTIVE`, `pausedAt IS NULL` e `dueAt` preenchido.
- **RN-TRAM-82** — Aviso de vencimento próximo: quando faltam `deadlines.warnBeforeBusinessDays` dias úteis (padrão 2) ou menos para `dueAt` e `dueSoonNotifiedAt IS NULL`, emite `ProcessStageDueSoon` uma única vez (idempotência garantida por `dueSoonNotifiedAt`).
- **RN-TRAM-83** — Atraso: quando `now > dueAt` e `overdueSince IS NULL`, grava `overdueSince = now` e emite `ProcessStageOverdue` uma única vez (idempotência garantida por `overdueNotifiedAt`).
- **RN-TRAM-84** — Atraso do processo via `targetDate` (DEC-031) é um indicador informativo e de planejamento, distinto do atraso de etapa; nunca gera `overdueSince` nem notificação.
- **RN-TRAM-85** — A execução do job deve ser exclusiva por ciclo (lock distribuído) para que múltiplas instâncias do worker não dupliquem `ProcessStageDueSoon`/`ProcessStageOverdue` nem concorram na mesma `ProcessStage`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Prazo da etapa | `dueAt` | datetime (somente leitura) | — | RN-TRAM-78 | calculado |
| Sobrescrever prazo | `dueDateOverridden` | interruptor (no diálogo de encaminhar — US-047) | Não | só se `allowDueDateOverride` | `false` |
| Nova data do prazo | `overrideDueDate` | data | Condicional (quando sobrescrever) | ≥ hoje | — |
| Justificativa da sobrescrita | `dueDateOverrideReason` | texto longo | Condicional (RN-TRAM-79) | ≥ 10 caracteres | — |
| Atrasado desde | `overdueSince` | datetime (somente leitura) | — | RN-TRAM-83 | calculado pelo job |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Sobrescrita sem justificativa | Front + API | "Informe o motivo da alteração do prazo." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-02 | Transição não permite sobrescrita | API | "Esta ação não permite alterar o prazo." | `DUE_DATE_OVERRIDE_NOT_ALLOWED` |
| V-03 | Nova data de prazo no passado | Front + API | "O novo prazo não pode ser anterior a hoje." | `VALIDATION_ERROR` (`DATE_IN_PAST`) |
| V-04 | Parâmetros inválidos em `CAL-06` (`businessDays` fora do intervalo) | API | — (uso interno/preview) | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |

## Permissões
- **Permissão:** nenhuma permissão própria — o cálculo é automático (ator `SYSTEM`); a sobrescrita do prazo usa a mesma permissão de quem encaminha (`PROCESS_FORWARD`, POL-01, US-047); a visualização de prazos/atrasos exige apenas `PROCESS_VIEW` (DEC-024).
- **Políticas:** nenhuma política contextual própria além das já exigidas pela ação de encaminhar.
- **MFA:** não exigido.
- **Sem permissão:** o campo de sobrescrita de prazo não aparece para quem não pode encaminhar o processo; indicadores de prazo/atraso seguem a visibilidade do processo.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageDueSoon` | `process.stage_due_soon` | Job `deadlines`, RN-TRAM-82 | `processStageId`, `stageKey`, `dueAt`, `businessDaysLeft`, `assigneeId?`, `departmentId` |
| `ProcessStageOverdue` | `process.stage_overdue` | Job `deadlines`, RN-TRAM-83 | `processStageId`, `stageKey`, `dueAt`, `overdueSince`, `assigneeId?`, `departmentId` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `STAGE_DUE_SOON` | Responsável da etapa; se não houver, titular da unidade | in-app (sem e-mail) | `ProcessStageDueSoon` |
| `STAGE_OVERDUE` | Responsável da etapa e titular da unidade | in-app + e-mail | `ProcessStageOverdue` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Prazos em dias úteis e detecção de atrasos

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a etapa "Estudos preliminares" tem SLA de 5 dias úteis
    And o calendário do tenant tem feriado nacional na quinta-feira da semana de referência

  Scenario: [Sucesso] Calcular o prazo considerando um feriado
    Given que o processo entra nesta etapa numa segunda-feira
    When o sistema calcular "dueAt"
    Then o prazo deve cair no fim do dia útil seis dias corridos depois (pulando o feriado de quinta)
    And "slaDays" e "slaType" devem ser gravados como snapshot na etapa

  Scenario: [Sucesso] Job detecta o atraso e emite o evento uma única vez
    Given que "dueAt" da etapa já passou e "overdueSince" está vazio
    When o job "deadlines" executar
    Then "overdueSince" deve ser preenchido com a hora da execução
    And o evento "ProcessStageOverdue" deve ser emitido
    When o job "deadlines" executar novamente no ciclo seguinte
    Then nenhum novo evento "ProcessStageOverdue" deve ser emitido para a mesma etapa

  Scenario: [Validação] Sobrescrever o prazo sem justificativa
    Given que a transição de encaminhamento permite sobrescrita de prazo
    When o usuário tentar sobrescrever o prazo sem informar o motivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "dueDateOverrideReason"

  Scenario: [Permissão] Usuário sem PROCESS_FORWARD tenta sobrescrever o prazo
    Given que "Bruno" não tem "PROCESS_FORWARD" sobre o processo
    When "Bruno" tentar encaminhar com um novo prazo
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Feriados de outro tenant não afetam o cálculo
    Given que o tenant "Prefeitura B" tem um feriado municipal na mesma semana
    When o tenant "Prefeitura de São José" calcular "dueAt" para a mesma semana
    Then o feriado municipal de "Prefeitura B" não deve ser considerado no cálculo

  Scenario: [Duplicidade] Execuções repetidas do job não duplicam o aviso de vencimento próximo
    Given que "dueSoonNotifiedAt" já foi preenchido em uma execução anterior
    When o job "deadlines" executar novamente antes do vencimento
    Then nenhum novo evento "ProcessStageDueSoon" deve ser emitido para a mesma etapa

  Scenario: [Concorrência] Duas instâncias do worker disputam o mesmo ciclo do job
    Given que duas instâncias do worker "deadlines" iniciam no mesmo minuto
    When ambas tentarem processar o mesmo lote de etapas
    Then apenas uma deve obter o lock distribuído e processar o lote
    And nenhuma etapa deve ser notificada duas vezes

  Scenario: [Falha de banco] Banco indisponível durante a execução do job
    Given que o banco de dados fica indisponível durante o ciclo do job
    When o job "deadlines" executar
    Then o ciclo deve falhar sem marcar "overdueSince" nem "dueSoonNotifiedAt"
    And o próximo ciclo (15 minutos depois) deve reavaliar as mesmas etapas normalmente

  Scenario: [Falha de integração] Fila de notificação indisponível
    Given que a fila "email" está indisponível quando o job detecta um atraso
    When o job "deadlines" marcar "overdueSince" e emitir "ProcessStageOverdue"
    Then o evento deve permanecer "PENDING" no outbox
    And a notificação "STAGE_OVERDUE" deve ser entregue quando a fila se recuperar, sem duplicar o evento
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sobrescrita sem justificativa | 422 | `VALIDATION_ERROR` | "Informe o motivo da alteração do prazo." | Marca campo no diálogo de encaminhar |
| Transição não permite sobrescrita | 422 | `DUE_DATE_OVERRIDE_NOT_ALLOWED` | "Esta ação não permite alterar o prazo." | Oculta o campo de nova data |
| Nova data no passado | 422 | `VALIDATION_ERROR` (`DATE_IN_PAST`) | "O novo prazo não pode ser anterior a hoje." | Marca campo |
| Sem permissão para encaminhar/sobrescrever | 403 | `PERMISSION_DENIED` | "Você não pode alterar o prazo desta etapa." | Oculta o campo de sobrescrita |
| Indisponibilidade crítica (job ou `CAL-06`) | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível calcular o prazo agora. Tente novamente." | Mantém o encaminhamento pendente; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-106 (calendário de dias úteis e feriados, base de `CAL-06`); US-083 (infraestrutura de notificações); US-047 (encaminhamento — ponto onde a sobrescrita é oferecida); US-052 (decisão de aprovação também recalcula `dueAt` na nova etapa); US-008 (suspender/retomar — consome `pausedAt`/`pausedTotalSeconds` definidos aqui).
- **Decisões/ADRs:** DEC-031, DEC-013, DEC-014, DEC-015.
- **Configurações:** `deadlines.warnBeforeBusinessDays` (padrão 2), `calendar.optionalHolidaysAreNonBusiness` (padrão `false`).
- **Lacunas nas fontes canônicas:** nenhuma (a detecção automática de atraso não gera `AuditLog`: o registro é o evento `ProcessStageOverdue` e a entrada `STAGE_OVERDUE` da timeline).

## Impacto técnico
- O job `deadlines` deve ser **idempotente** e usar lock distribuído (Redis, TTL curto) por ciclo, pois roda em múltiplas réplicas do worker; sem o lock, duas instâncias processando o mesmo lote duplicariam notificações.
- Varredura usa o índice já existente `(tenant_id, due_at) WHERE status = 'ACTIVE'` (entities.md §4.4); para tenants com grande volume de etapas ativas, o job deve paginar o lote em vez de carregar tudo de uma vez.
- `CAL-06` é chamado tanto no caminho síncrono (entrada de etapa, preview de sobrescrita na UI) quanto, potencialmente, em lote pelo job — cachear o calendário de feriados do tenant em memória por ciclo evita recomputar a mesma tabela de feriados repetidamente.
- Normalização para "fim do dia útil" deve usar o fuso do tenant (`America/Sao_Paulo` por padrão) e não o fuso do servidor, para não deslocar o vencimento em um dia perto da meia-noite (DEC-003).

## Backend
- **Módulo(s):** `process` (dono do job e de `ProcessStage`); usa `catalog` (`BusinessCalendarFacade`/`CAL-06`, `Holiday`), `notification` (dispatch de `STAGE_DUE_SOON`/`STAGE_OVERDUE`), `platform` (fila/worker BullMQ, lock distribuído, `OutboxWriter`), `audit`.
- **Casos de uso:** `ProcessDeadlinesJob` (worker repetível, fila `deadlines`, cron a cada 15 min); `ComputeStageDueDateService` (usado por US-001/US-047/US-048/US-052 na entrada de etapa).
- **Domínio:** `ProcessStage.computeDueAt(enteredAt, slaDays, slaType)`; `ProcessStage.pause()` / `ProcessStage.resume()`; `ProcessStage.markDueSoon()` / `ProcessStage.markOverdue()`.
- **Transação:** cada lote do job processa um conjunto limitado de `ProcessStage` por transação curta (evita locks longos); o cálculo de `dueAt` na entrada de etapa ocorre dentro da transação da ação que a originou (US-001/047/048/052).

## Frontend
- **Tela(s):** SCR-006 (badge de prazo/atraso no painel situacional), SCR-013 (caixa de tarefas — destaque de itens "a vencer"/"atrasados").
- **Componentes:** `DueDateBadge` (estados: normal, a vencer, atrasado, suspenso, sem prazo), `OverrideDueDateField` (no diálogo de encaminhar — US-047).
- **Dados:** os prazos vêm junto das consultas de processo/tarefas já existentes; nenhuma consulta dedicada nova.
- **Estados:** `DueDateBadge` deriva o estado de `dueAt`, `dueSoonNotifiedAt`, `overdueSince` e `pausedAt` sem nova chamada de rede.
- **Acessibilidade e responsividade:** estado do badge nunca comunicado só por cor (ícone + texto); contraste AA; badge compacto em listas no mobile.

## Banco de dados
- **Tabelas:** `process_stages` (update de `due_at`, `paused_at`, `paused_total_seconds`, `overdue_since`, `due_soon_notified_at`, `overdue_notified_at`); `holidays` (leitura via `CAL-06`).
- **Migrações:** nenhuma — todos os campos já existem (entities.md §4.4).
- **Índices/constraints relevantes:** `(tenant_id, due_at) WHERE status = 'ACTIVE'` (varredura do job); `(tenant_id, assignee_id) WHERE status = 'ACTIVE'` (resolução do destinatário da notificação).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| CAL-06 | POST | `/api/v1/calendar/add-business-days` | `{ fromDateTime, businessDays, dayCountType? }` | `200 { data: { dueDateTime } }` | 200, 422, 503 |

`CAL-06` é usado tanto internamente (cálculo de `dueAt`) quanto pela UI para pré-visualizar o novo prazo antes de confirmar uma sobrescrita.

## Logs
- `info` `process.stage_due_computed` — `processStageId`, `enteredAt`, `slaDays`, `slaType`, `dueAt`, `overridden`.
- `info` `process.deadlines_job_run` — `scanned`, `dueSoonEmitted`, `overdueEmitted`, `durationMs`, `lockAcquired`.
- `warn` `process.deadlines_lock_skipped` — quando a instância não obtém o lock distribuído (execução normal, outra instância assumiu o ciclo).
- `error` `process.deadlines_job_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** `dueDateOverrideReason` em texto livre além do necessário à auditoria da ação que o originou (US-047).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.forward` (reaproveitada de US-047) | `WORKFLOW` | Encaminhamento com sobrescrita de prazo | `metadata` adicional: `dueDateOverridden`, `dueDateOverrideReason` |

A detecção automática de atraso não gera `AuditLog` dedicado; o evento de domínio é o registro imutável correspondente.

## Testes necessários
- **Unitários:** cálculo do fim do dia útil com feriados (nacional/estadual/municipal/facultativo); pausa e retomada (extensão de `dueAt`); guardas de idempotência (`dueSoonNotifiedAt`/`overdueNotifiedAt`).
- **Integração (Testcontainers + relógio controlado):** job completo end-to-end (etapa vence → `ProcessStageDueSoon` → `ProcessStageOverdue`), sem duplicar em execuções consecutivas; isolamento de calendário por tenant.
- **Concorrência:** duas instâncias do worker no mesmo ciclo → lock garante processamento único; suspensão/retomada concorrente com o job.
- **API/contrato:** `CAL-06` conforme api.md (datas ISO 8601, `dayCountType`).
- **E2E (Playwright):** sobrescrever prazo no encaminhamento e ver o novo `dueAt`; observar o badge mudar de "a vencer" para "atrasado" após o job.
- **Acessibilidade/performance:** axe no `DueDateBadge`; job processando 10.000 etapas ativas em lote dentro da janela de 15 minutos.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando no CI
- [ ] Job `deadlines` idempotente e com lock distribuído comprovado por teste de concorrência
- [ ] `PROCESS_FORWARD`/POL-01 aplicados à sobrescrita; UI oculta o campo sem permissão
- [ ] Eventos `ProcessStageDueSoon`/`ProcessStageOverdue` e notificações `STAGE_DUE_SOON`/`STAGE_OVERDUE` verificados em teste
- [ ] OpenAPI de `CAL-06` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas do job (`scanned`, `dueSoonEmitted`, `overdueEmitted`) e trace
- [ ] Acessibilidade (axe) e responsividade dos badges verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — a regra de cálculo em si é direta (delegada a `CAL-06`), mas exige cuidado com fuso horário, pausa/retomada, idempotência do job e lock distribuído entre réplicas do worker.

## Prioridade
**P0** — sem prazos e detecção de atraso, não há como o produto cumprir sua promessa central de dar visibilidade objetiva ao trâmite da fase preparatória.
