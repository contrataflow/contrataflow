---
id: US-114
title: "Lembretes de prazo e alertas de atraso"
epic: EP-019
feature: FT-059
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-055, US-111, US-112]
modules: [notification]
screens: [SCR-036]
endpoints: []
permissions: []
events: []
---

# US-114 — Lembretes de prazo e alertas de atraso

## Título
Lembretes de prazo e alertas de atraso

## Descrição
**Como** responsável por uma etapa (ou titular da unidade), **quero** ser avisado antes do prazo vencer e, se vencer, ser avisado junto com minha chefia, **para** agir a tempo e para que o atraso nunca passe em silêncio.

Esta story liga o registro `STAGE_DUE_SOON`/`STAGE_OVERDUE` (events.md §6) ao `NotificationDispatcher` (US-111): quando o job `deadlines` (US-055) emite `ProcessStageDueSoon` ou `ProcessStageOverdue`, o dispatcher resolve o responsável da etapa e, em caso de atraso, também o titular da unidade (escalonamento), criando a notificação in-app e, para o atraso, também o e-mail (US-112) — sempre sem duplicar.

## Contexto
- US-055 já calcula `dueAt`, detecta vencimento próximo e atraso, e emite os eventos com idempotência própria (`dueSoonNotifiedAt`/`overdueNotifiedAt`); esta story não recalcula prazo nem decide *quando* avisar — só decide *quem* recebe o aviso e *como* ele aparece para a pessoa.
- Antes desta story, `ProcessStageDueSoon`/`ProcessStageOverdue` não têm nenhum consumidor: os eventos são publicados, mas ninguém é avisado. É o controle tempestivo exigido pelo art. 169 da Lei 14.133/2021 (já citado como motivação em US-055) só se completa com o aviso chegando a uma pessoa.
- `STAGE_OVERDUE` é o único caso do registro em que **dois** destinatários são notificados pelo mesmo evento (responsável **e** titular da unidade) — os demais tipos notificam um destinatário ou um conjunto de membros de uma unidade, nunca "o indivíduo mais a chefia dele" ao mesmo tempo.

## Objetivo
Garantir que 100% dos eventos `ProcessStageDueSoon`/`ProcessStageOverdue` resultem em notificação para o responsável (e, no atraso, também para o titular da unidade) em até 1 minuto do processamento do job `deadlines`, sem duplicar quando as duas pessoas coincidem.

## Persona
- **Principal:** responsável atual da etapa.
- **Secundárias:** titular da unidade (recebe quando não há responsável individual, ou sempre, no atraso); gestor de contratações (acompanha o volume de atrasos pelo dashboard, fora do escopo desta story).

## Pré-condições
- Etapa ativa com `dueAt` calculado e, eventualmente, `ProcessStageDueSoon`/`ProcessStageOverdue` já emitidos (US-055).
- `NotificationDispatcher` (US-111) e `EmailSender` (US-112) em operação.

## Fluxo principal
1. O job `deadlines` (US-055) detecta uma etapa a vencer ou atrasada e publica `ProcessStageDueSoon` ou `ProcessStageOverdue` com `processStageId`, `stageKey`, `dueAt`, `assigneeId?`, `departmentId`.
2. O roteador de domain-events replica o evento para a fila `notifications`; o `NotificationDispatcher` (US-111) o recebe e reconhece o tipo pelo registro (`STAGE_DUE_SOON`/`STAGE_OVERDUE` — events.md §6).
3. Resolve os destinatários: se `STAGE_DUE_SOON`, usa `assigneeId` quando presente; na ausência, resolve `Department.headUserId` da unidade (`departmentId`). Se `STAGE_OVERDUE`, resolve **ambos** — `assigneeId` (se houver) **e** `headUserId` da unidade — como destinatários independentes.
4. Se `assigneeId` e `headUserId` forem a mesma pessoa, apenas uma notificação é criada para ela (RN-NTF-28).
5. Cria a notificação in-app para cada destinatário resolvido (idempotente por `sourceEventId`, como qualquer tipo do registro — US-111). Para `STAGE_OVERDUE`, também enfileira e-mail (US-112), sujeito à preferência do destinatário (US-113).
6. O destinatário vê a notificação no sininho (SCR-036) com o nome da etapa e o prazo; ao clicar, é levado ao processo.
7. Se o processo for suspenso antes do próximo aviso, US-055 deixa de alimentar novos eventos para aquela etapa (pausa já tratada na origem); esta story não precisa tratar suspensão.

## Fluxos alternativos
- **FA-01 — Unidade sem titular e sem responsável:** nenhuma notificação é criada (não há destinatário resolvível); registrado em log `warn` para acompanhamento operacional — não é um erro do usuário.
- **FA-02 — Usuário perdeu visibilidade do processo entre o cálculo do prazo e o aviso:** segue a regra geral de US-111 (RN-NTF-06): a notificação não é criada para quem não tem mais visibilidade.
- **FA-03 — Vencimento próximo desativado (`deadlines.warnBeforeBusinessDays = 0`):** US-055 nunca emite `ProcessStageDueSoon`; esta story simplesmente não recebe o evento (nada a fazer aqui).
- **FA-04 — Reentrega do job `deadlines` no ciclo seguinte:** US-055 só emite o evento uma vez por etapa (idempotência própria); mesmo que o dispatcher reprocesse o mesmo evento por reentrega da fila, a unicidade de `Notification` garante no máximo uma notificação por destinatário e evento.

## Regras de negócio
- **RN-NTF-27** — O `NotificationDispatcher` reconhece `STAGE_DUE_SOON` (origem `ProcessStageDueSoon`) e `STAGE_OVERDUE` (origem `ProcessStageOverdue` — US-055) com resolução de destinatário própria: `STAGE_DUE_SOON` = responsável da etapa ou, na ausência, titular da unidade (`Department.headUserId`); `STAGE_OVERDUE` = responsável **e** titular da unidade, ambos, sem depender da ausência de responsável.
- **RN-NTF-28** — Quando responsável e titular da unidade são a mesma pessoa, apenas uma notificação é criada para ela.
- **RN-NTF-29** — Se a unidade não tiver titular (`headUserId` nulo) e não houver responsável individual, nenhuma notificação é criada para aquele evento; não há fallback adicional além do já previsto no registro.
- **RN-NTF-30** — `STAGE_DUE_SOON` não envia e-mail por padrão (events.md §6: "E-mail padrão" = não); `STAGE_OVERDUE` envia e-mail por padrão, sujeito a `notifications.emailEnabled` e à preferência do destinatário (US-113).
- **RN-NTF-31** — A unicidade de `Notification` por `(tenant_id, recipient_id, source_event_id, type)` (US-111) é suficiente para impedir duplicidade mesmo sob reentrega do job `deadlines` ou da fila `notifications`; esta story não introduz um segundo mecanismo de deduplicação.
- **RN-NTF-32** — O conteúdo cita o nome da etapa e `dueAt` (ou `overdueSince`, no atraso) formatados no fuso do tenant (DEC-003); nunca inclui valores monetários do processo (POL-09).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| — | `assigneeId` (do evento) | uuid (somente leitura) | — | RN-NTF-27 | `ProcessStageDueSoon`/`Overdue` (US-055) |
| — | `departmentId` (do evento) | uuid (somente leitura) | — | RN-NTF-27 | idem |
| — | `headUserId` (consultado) | uuid (somente leitura) | — | RN-NTF-27/29 | `Department` (entities.md) |
| — | `dueAt` / `overdueSince` (do evento) | datetime (somente leitura) | — | RN-NTF-32 | idem |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Evento sem `assigneeId` nem `departmentId` resolvível | Worker (interno) | — | — (nenhuma notificação criada; log `warn`) |
| V-02 | Unidade referenciada sem `headUserId` | Worker (interno) | — | — (RN-NTF-29; log `warn`) |
| V-03 | Evento de etapa/processo de outro tenant (corrupção improvável) | Worker (interno) | — | — (RLS impede leitura; log `error`) |

## Permissões
- **Permissão:** nenhuma própria — reaproveita o motor e as regras de acesso de US-111 (visibilidade via DEC-024 antes de criar a notificação).
- **Políticas:** POL-09 (conteúdo sem valores do processo).
- **MFA:** não aplicável.
- **Sem permissão:** não aplicável (fluxo assíncrono; a leitura da notificação resultante segue as regras de US-111).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum. Esta story **consome** `ProcessStageDueSoon`/`ProcessStageOverdue` (produzidos por US-055); não publica eventos novos. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `STAGE_DUE_SOON` | Responsável da etapa; se não houver, titular da unidade | IN_APP | `ProcessStageDueSoon` |
| `STAGE_OVERDUE` | Responsável da etapa **e** titular da unidade | IN_APP + EMAIL (padrão, ajustável — US-113) | `ProcessStageOverdue` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Lembretes de prazo e alertas de atraso

  Background:
    Given que o processo "0012/2026" está na etapa "Análise jurídica" com responsável "Fábio"
    And o titular da "Secretaria de Obras" é "Helena"

  Scenario: [Sucesso] Atraso notifica responsável e titular da unidade
    Given que "dueAt" da etapa já passou
    When o job "deadlines" emitir "ProcessStageOverdue"
    Then "Fábio" deve receber a notificação "STAGE_OVERDUE" por IN_APP e e-mail
    And "Helena" também deve receber a notificação "STAGE_OVERDUE" por IN_APP e e-mail

  Scenario: [Validação] Evento sem destinatário resolvível
    Given que a etapa não tem responsável individual e a unidade não tem titular
    When o job "deadlines" emitir "ProcessStageOverdue" para essa etapa
    Then nenhuma notificação deve ser criada
    And deve ser registrado log "warn"

  Scenario: [Permissão] Responsável sem mais visibilidade do processo
    Given que "Fábio" deixou de ter visibilidade do processo "0012/2026" antes do aviso
    When o job "deadlines" emitir "ProcessStageOverdue"
    Then "Fábio" não deve receber a notificação
    And "Helena" deve receber normalmente

  Scenario: [Tenant incorreto] Isolamento entre tenants
    Given que existe uma etapa atrasada equivalente no tenant "Prefeitura B"
    When o job "deadlines" processar os dois tenants
    Then nenhuma notificação do tenant "Prefeitura B" deve chegar a usuários da "Prefeitura de São José"

  Scenario: [Duplicidade] Job repete o aviso no ciclo seguinte
    Given que "Fábio" já recebeu "STAGE_OVERDUE" para esta etapa
    When o job "deadlines" rodar novamente 15 minutos depois sobre a mesma etapa ainda atrasada
    Then nenhuma nova notificação "STAGE_OVERDUE" deve ser criada para "Fábio" a partir do mesmo evento

  Scenario: [Concorrência] Responsável e titular são a mesma pessoa
    Given que "Fábio" é também o titular da "Secretaria de Obras"
    When o job "deadlines" emitir "ProcessStageOverdue"
    Then "Fábio" deve receber apenas uma notificação "STAGE_OVERDUE"

  Scenario: [Falha de banco] Banco indisponível ao criar a notificação
    Given que o banco de dados está indisponível
    When o dispatcher processar "ProcessStageOverdue"
    Then o job deve falhar e ser reprocessado conforme a política da fila "notifications"
    And o evento não deve se perder

  Scenario: [Falha de integração] Fila de e-mail indisponível
    Given que a fila "email" está indisponível
    When "Fábio" for notificado de um atraso
    Then a notificação in-app deve ser criada normalmente
    And o e-mail deve ficar "PENDING" até o "EmailSender" voltar a operar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| — (fluxo assíncrono, sem endpoint HTTP próprio) | — | — | — | Notificação resultante segue os casos de erro de `NTF-*` (US-111) |

## Dependências
- **Stories:** US-055 (produtor de `ProcessStageDueSoon`/`ProcessStageOverdue` e de `dueAt`/`overdueSince`); US-111 (motor de despacho, idempotência e visibilidade); US-112 (envio do e-mail de `STAGE_OVERDUE`).
- **Decisões/ADRs:** DEC-003 (exibição de datas no fuso do tenant), DEC-024, DEC-031 (pausa de prazo na suspensão, tratada por US-055).
- **Configurações:** `deadlines.warnBeforeBusinessDays` (lida por US-055, não por esta story); `notifications.emailEnabled`.
- **Lacunas nas fontes canônicas:** nenhuma — a resolução de "titular da unidade" usa `Department.headUserId` (entities.md), já exigido ter vínculo `ACTIVE` lotado ou com escopo sobre a unidade.

## Impacto técnico
- Único ponto do registro `NotificationType` com resolução de **dois** destinatários independentes para o mesmo evento; o `NotificationRegistry` (US-111) precisa suportar essa forma (lista de resolvedores por tipo), não só "um destinatário ou os membros de uma unidade".
- Nenhuma tabela nova; reaproveita integralmente `notifications` e a infraestrutura de US-111/US-112. O risco técnico está concentrado na corretude da resolução de destinatários, não em performance ou esquema.

## Backend
- **Módulo(s):** `notification` (extensão do `NotificationRegistry` de US-111); consulta `organization` (`DepartmentFacade.getHeadUserId`).
- **Casos de uso:** nenhum novo caso de uso — adiciona entradas `STAGE_DUE_SOON`/`STAGE_OVERDUE` ao `NotificationRegistry` de US-111, com resolvedor de destinatários dedicado.
- **Domínio:** `StageDeadlineRecipientResolver` (value object/estratégia usada pelo `NotificationRegistry` para estes dois tipos).
- **Integrações internas:** `organization.DepartmentFacade` (titular da unidade); `process` (responsável atual da etapa, já incluído no payload do evento).
- **Transação:** segue a transação por destinatário já definida em US-111 (busca/agrupamento + inserção/atualização de `Notification`).

## Frontend
- **Tela(s):** nenhuma tela nova — os avisos aparecem no sininho/lista já entregues por US-111 (SCR-036); o indicador visual de "vence em breve"/"atrasado" no painel do processo e na caixa de tarefas é de US-055, não desta story.
- **Componentes:** reaproveita `NotificationItem` (US-111); ícone específico para prazo pode ser adicionado ao mapa de ícones por tipo.
- **Estados:** idem US-111.
- **Acessibilidade e responsividade:** idem US-111 (nenhum componente novo).

## Banco de dados
- **Tabelas:** `notifications` (nenhuma tabela nova; reaproveita US-111).
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** nenhum novo; reaproveita os índices de `notifications` (US-111).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| — | — | — | Sem endpoint próprio; resultado visível via `NTF-01`/`NTF-02` (US-111) | — | — |

## Logs
- `info` `notification.deadline_escalated` — `processStageId`, tipo (`STAGE_DUE_SOON`/`STAGE_OVERDUE`), quantidade de destinatários.
- `warn` `notification.deadline_recipient_missing` — etapa/unidade sem destinatário resolvível.
- `error` herdado do dispatcher genérico (US-111) em falhas de gravação.
- **Nunca logar:** nome do processo além do necessário para correlação; valores estimados do processo (POL-09).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Mesma regra de US-111: criação de notificação é projeção de sistema, não gera `AuditLog`. |

## Testes necessários
- **Unitários:** `StageDeadlineRecipientResolver` (responsável só, titular só, ambos, mesma pessoa, nenhum resolvível).
- **Integração (Testcontainers):** consumo real de `ProcessStageDueSoon`/`ProcessStageOverdue` publicados por um teste de US-055; verificação de que exatamente os destinatários esperados recebem notificação.
- **API/contrato:** não aplicável diretamente; cobertura indireta via `NTF-01` (US-111) retornando os tipos `STAGE_DUE_SOON`/`STAGE_OVERDUE`.
- **RBAC e multi-tenant:** etapas atrasadas de tenants diferentes nunca se cruzam.
- **Concorrência:** responsável = titular da unidade → uma notificação; dois eventos quase simultâneos (due soon seguido de overdue) para a mesma etapa não se confundem (tipos distintos, chaves distintas).
- **E2E (Playwright):** simular etapa atrasada e verificar o sininho de dois usuários (responsável e titular) após o job rodar em ambiente de teste.
- **Acessibilidade/performance:** nenhuma nova tela; cobertura herdada de US-111.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] Resolução de destinatários (responsável/titular/ambos/mesma pessoa/nenhum) cobertas por teste unitário
- [ ] Deduplicação sob reentrega comprovada por teste de concorrência
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] Logs sem dados sensíveis
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — não cria tabelas nem telas novas, mas exige a única resolução de destinatário "duplo" do registro, integrando três stories (US-055, US-111, US-112) com cuidado para não duplicar nem perder avisos.

## Prioridade
**P1** — cumpre o controle tempestivo de prazos (art. 169 da Lei 14.133/2021) já estruturado por US-055; não é P0 porque o produto funciona sem o aviso automático (o painel já mostra o indicador visual), mas o atraso silencioso é um risco real de negócio.
