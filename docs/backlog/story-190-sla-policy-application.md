---
id: US-190
title: "Aplicar a política de SLA ao processo e calcular prazos"
epic: EP-030
feature: FT-086
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-047, US-189]
modules: [sla, process, workflow, catalog, approval, audit]
screens: [SCR-006, SCR-121]
endpoints: [SLA-11, SLA-12, CAL-06, PRC-19, PRC-20, APV-03]
permissions: [PROCESS_VIEW, SLA_POLICY_MANAGE]
events: [ProcessStageDueSoon, ProcessStageOverdue]
---

# US-190 — Aplicar a política de SLA ao processo e calcular prazos

## Título
Aplicar a política de SLA ao processo e calcular prazos

## Descrição
**Como** responsável por uma etapa, gestor de contratações ou titular de unidade, **quero** que, ao entrar numa etapa, o processo receba o prazo definido pela política de SLA que se aplica a ele (tipo de contratação, modalidade ou valor), e **ver no detalhe do processo** qual política valeu, qual é o prazo e como ele foi calculado, **para** trabalhar com prazos realistas e poder explicar a qualquer pessoa por que aquele processo tem aquele prazo.

A story liga o cadastro de US-189 ao trâmite: na entrada de cada passagem de etapa (`ProcessStage`), o módulo `sla` escolhe a política aplicável por `priority`, calcula `ProcessStage.dueAt` em dias úteis ou corridos pelo calendário do órgão e grava o *snapshot* (`slaPolicyId`, `slaDays`, `slaType`, `dueAt`); calcula também o prazo por linha de aprovador (`approverDays`) em etapas `APPROVAL`; oferece uma **pré-visualização** (qual política e quais prazos valeriam para um processo — SLA-11) e a leitura `GET /processes/{id}/sla` (SLA-12) para o detalhe do processo (SCR-006); e publica o provedor `sla.*` do `RuleContext` v2. Sem política aplicável, tudo continua exatamente como no MVP 1 (DEC-031).

## Contexto
- O prazo do MVP 1 é calculado na entrada da etapa a partir de `WorkflowStage.slaDays`/`slaType` (US-055, RN-TRAM-78): fim do dia no fuso do tenant do N-ésimo dia a partir de `enteredAt`, por `CAL-06`, com *snapshot* em `ProcessStage`. A DEC-205 mantém essa base e a **substitui** quando uma política casa; `ProcessStage.dueAt` continua sendo o campo do prazo.
- `ProcessStage` ganhou `slaPolicyId` (política aplicada na entrada), `pauseReason`, `escalationLevel` e `lastEscalatedAt` (entities.md §5.3); esta story preenche `slaPolicyId`, `slaDays`, `slaType` e `dueAt`; pausa e degraus são de US-191 e US-192.
- O `RuleContext` v2 (US-129) reserva o namespace `sla` (`policyKey`, `paused`, `escalationLevel`, `overdue`); cada story de módulo publica o provedor do seu namespace, e este é o do `sla`.
- Como a escolha da política precisa do contexto do processo (valor, modalidade, orçamento etc.), a ADR-015 manda montar o contexto de forma **preguiçosa por namespace** e com cache por requisição, para não encarecer a transação de tramitação.
- Passagens em curso mantêm o *snapshot*: alterar ou desativar a política (US-189) só vale para **novas entradas** em etapa (POL-27); a migração de versão de workflow preserva `dueAt` (`MIGRATED` — entities.md §5.3).
- Etapas `PARALLEL_SPLIT`/`PARALLEL_JOIN` não têm prazo nem responsável (check em `WorkflowStage`); etapas dispensadas (`SKIPPED`) nascem fechadas e sem prazo; cada ramo paralelo tem a sua `ProcessStage` e o seu prazo (DEC-194).
- `Approval.dueAt` de aprovação originada em etapa é o `dueAt` da `ProcessStage` (RN-TRAM-51); o prazo por linha (`ApprovalApprover.dueAt`, DEC-193/DEC-205) só existe quando a política define `approverDays`.
- O indicador de cumprimento por etapa (EP-028) lê `ProcessStage.slaPolicyId` e `dueAt`; a meta do épico é ≥ 80% das passagens com prazo definido por política nos órgãos que cadastraram política.

## Objetivo
Garantir que 100% das entradas em etapa nos órgãos com política ativa escolham a política correta (menor `priority`, empate pela mais antiga), gravem o prazo e o *snapshot* de forma atômica com o comando de tramitação e exponham, no detalhe do processo, a política e o prazo aplicados; e que, sem política aplicável, o resultado seja idêntico ao do MVP 1.

## Persona
- **Principal:** Responsável pela etapa (`PLANEJAMENTO`, `COMPRAS`, `JURIDICO`, `CONTROLE_INTERNO`) e titular de unidade, que veem o prazo e a política no processo.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) e Administrador do órgão (`ADMIN_ORGAO`), que usam a pré-visualização para conferir a política; Auditor (`AUDITOR`) e Controle Interno, que verificam qual política valeu para cada atraso.

## Pré-condições
- Ao menos uma política ativa (US-189) para haver aplicação; sem ela o fluxo segue o MVP 1.
- Calendário do tenant configurado (US-106) e `CAL-06` disponível.
- Para a pré-visualização: `SLA_POLICY_MANAGE` e `PROCESS_VIEW` sobre o processo. Para SLA-12: `PROCESS_VIEW` (visibilidade DEC-024).

## Fluxo principal
1. Um comando abre uma nova passagem de etapa: criação do processo (US-001), encaminhamento (PRC-19, US-047), devolução (PRC-20, US-048) ou decisão de aprovação que leva a outra etapa (APV-03, US-052). O `ComputeStageDueDateService` do MVP 1 chama agora o `SlaFacade.resolveForEntry` dentro da mesma transação.
2. O `sla` lista as políticas **ativas** do tenant em ordem (`priority` crescente, depois `createdAt`), descartando as restritas a outro workflow, e avalia a aplicabilidade de cada uma sobre o `RuleContext` v2 do processo (montado só nos namespaces que as expressões usam); a **primeira que casa** é a política aplicável.
3. Com a política aplicável, o `sla` procura a linha de prazo da etapa (`SlaPolicyStage` pela `stageKey`). Se houver, usa `days` e `dayCountType` da linha; se não houver, usa `WorkflowStage.slaDays`/`slaType` (DEC-031); se também não houver, a etapa fica sem prazo.
4. O `ComputeStageDueDateService` chama `CAL-06` e normaliza para `23:59:59.999` no fuso do tenant (RN-TRAM-78); a passagem é gravada com `slaPolicyId` (quando uma política casou), `slaDays`, `slaType` e `dueAt`.
5. Se a transição permitir e o usuário informar uma nova data (`allowDueDateOverride`), ela substitui `dueAt` como no MVP 1 (RN-TRAM-79), preservando `slaPolicyId`.
6. Se a etapa for `APPROVAL` e a linha da política tiver `approverDays`, a criação da `Approval` e a ativação de cada `ApprovalApprover` chamam `SlaFacade.computeApproverDueAt` e gravam `ApprovalApprover.dueAt`; `Approval.dueAt` continua igual ao `dueAt` da etapa.
7. O comando termina como no MVP 1; o resultado (`ProcessStageChanged`, auditoria e timeline do comando) não muda de forma, e o prazo novo já está visível.
8. No detalhe do processo (SCR-006), o bloco **"Prazo"** consulta SLA-12 e exibe, por etapa ativa: prazo (data e dias restantes), "Política aplicada: {nome} ({chave})" ou "Prazo padrão da etapa", contagem (dias úteis/corridos), pausa e degrau quando houver (US-191/US-192).
9. O administrador, em SCR-121, abre **"Pré-visualizar com um processo"**, escolhe um processo pelo código e chama SLA-11: vê os candidatos avaliados, qual política venceu e, para cada etapa, o prazo em dias e uma data ilustrativa; pode testar uma política específica (mesmo inativa) com `policyId`.
10. Mais tarde, o job `deadlines` (US-055/US-114) emite `ProcessStageDueSoon`/`ProcessStageOverdue` já com `slaPolicyKey` quando a passagem tem política.

## Fluxos alternativos
- **FA-01 — Nenhuma política ativa ou nenhuma casa:** `slaPolicyId` fica nulo e vale o `slaDays` da etapa; mesmos dados, eventos e avisos do MVP 1 (RN-SLA-24).
- **FA-02 — Política casa mas a etapa não tem linha:** `slaPolicyId` é gravado, o prazo é o `slaDays` da etapa; pausas e degraus da política passam a valer para essa passagem (RN-SLA-25).
- **FA-03 — Etapa sem prazo algum:** `dueAt` nulo, sem avisos nem degraus; o bloco "Prazo" mostra "Sem prazo definido".
- **FA-04 — Expressão da política falha na avaliação:** a política não casa (*fail-closed*), a próxima candidata é avaliada, e a falha é registrada em log `warn` sem afetar o comando (RN-SLA-35).
- **FA-05 — Devolução e reentrada na mesma etapa:** cada reentrada é uma **nova passagem** e passa por nova resolução com a política vigente naquele momento (RN-SLA-36).
- **FA-06 — Ramos paralelos:** cada etapa de ramo abre a sua passagem, com política e prazo calculados de forma independente e `branchKey` na resposta de SLA-12.
- **FA-07 — Política alterada ou desativada depois da entrada:** nenhum `dueAt` em curso muda (RN-SLA-26); a próxima entrada usa a configuração nova.
- **FA-08 — Sobrescrita de prazo no encaminhamento:** o prazo informado prevalece e a UI registra "Prazo ajustado manualmente"; `slaPolicyId` permanece (RN-SLA-27).
- **FA-09 — Migração de versão do workflow (`MIGRATED`):** a passagem de destino preserva `dueAt` e `slaPolicyId`, sem nova resolução (RN-SLA-29).
- **FA-10 — Processo com orçamento sigiloso:** a política pode usar `process.estimatedValue` na avaliação (servidor), mas nenhuma resposta, log ou evento traz o valor; a pré-visualização mascara o que for sigiloso para quem não tem POL-09.
- **FA-11 — Pré-visualização sem candidatas:** SLA-11 devolve `appliedPolicy` nulo e as etapas com `source = STAGE_DEFAULT`, confirmando que valem os prazos do workflow.

## Regras de negócio
- **RN-SLA-23** — A resolução da política e o cálculo de prazo acontecem **na entrada de toda `ProcessStage` que admite prazo** (tipos `TASK` e `APPROVAL`): criação do processo, encaminhamento, devolução, decisão de aprovação e reentradas; é uma extensão do `ComputeStageDueDateService` da US-055 (RN-TRAM-78), chamada dentro da transação do comando.
- **RN-SLA-24** — Seleção: consideram-se as políticas `isActive` do tenant com `workflowId` nulo ou igual ao workflow do processo, em ordem de `priority` crescente e, no empate, `createdAt` crescente; vence a **primeira** cuja `applicabilityRule` seja verdadeira sobre o `RuleContext` v2. Uma passagem nunca tem duas políticas. Expressão que falha na avaliação não casa (*fail-closed*). Sem política que case, `slaPolicyId` é nulo e vale o comportamento do MVP 1.
- **RN-SLA-25** — Prazo da passagem: com política aplicável e linha para a `stageKey`, usa `days` e `dayCountType` da linha; com política aplicável sem linha, ou sem política, usa `WorkflowStage.slaDays`/`slaType`; sem nenhum dos dois, `dueAt` é nulo. A política aplicável é gravada em `slaPolicyId` mesmo quando a etapa não tem linha (ela contribui com pausas e degraus).
- **RN-SLA-26** — *Snapshot*: `slaPolicyId`, `slaDays`, `slaType` e `dueAt` gravados na entrada não são recalculados por alteração, desativação ou exclusão lógica da política (POL-27, DEC-205). A pausa e a retomada (US-191) estendem `dueAt` por mecanismo próprio e não alteram o *snapshot* de dias.
- **RN-SLA-27** — A sobrescrita de prazo no encaminhamento (`allowDueDateOverride`, RN-TRAM-79) continua valendo sobre o prazo calculado pela política: marca `dueDateOverridden`, exige justificativa e preserva `slaPolicyId`.
- **RN-SLA-28** — `PARALLEL_SPLIT`, `PARALLEL_JOIN` e passagens `SKIPPED` não recebem prazo nem política; etapas `START` e `END` não concorrem a política (só `TASK` e `APPROVAL` têm linha de prazo — US-189 · RN-SLA-06) e, se tiverem `slaDays` no workflow, continuam com o cálculo do MVP 1. `slaPolicyId` só é preenchido em passagem `ACTIVE` de etapa `TASK` ou `APPROVAL`.
- **RN-SLA-29** — Em ramos paralelos cada passagem calcula o seu prazo de forma independente; na migração de versão (`MIGRATED`, DEC-195) a passagem de destino **preserva** `dueAt` e `slaPolicyId` e não passa por nova resolução.
- **RN-SLA-30** — Prazo por linha de aprovador: em etapa `APPROVAL` cuja linha da política tem `approverDays`, `ApprovalApprover.dueAt` = fim do dia do N-ésimo dia (`approverDays`, contagem da `dayCountType` da linha) a partir de `activatedAt` — na solicitação para as linhas `PENDING` (`ANY`/`ALL`) e na ativação para as linhas de `SEQUENTIAL` (`ApprovalApproverActivated`); sem `approverDays`, `dueAt` da linha fica nulo e herda `Approval.dueAt`. O prazo por linha **não** altera `Approval.dueAt` nem `ProcessStage.dueAt`, e não há validação cruzada entre `approverDays` e `days`.
- **RN-SLA-31** — O `sla` publica o provedor do namespace `sla` do `RuleContext` v2: `policyKey` (chave da política da passagem de referência, ou nulo), `paused` (`pausedAt` preenchido), `escalationLevel` (inteiro) e `overdue` (`dueAt` preenchido, passado e sem pausa). A passagem de referência é a do evento em avaliação; sem evento, a passagem ativa com `overdueSince` mais antigo e, não havendo atrasada, a mais antiga por `enteredAt`. A montagem é preguiçosa e só ocorre quando a expressão referencia `sla.*`.
- **RN-SLA-32** — Pré-visualização (SLA-11): recebe `processId` (obrigatório) e, opcionalmente, `policyId` e `stageKeys[]`; devolve `candidates[]` (cada política avaliada com `result` em `MATCHED`, `NOT_MATCHED`, `WORKFLOW_MISMATCH`, `INACTIVE` ou `EVALUATION_ERROR`, e `winner`), `appliedPolicy` e, por etapa, `source` (`POLICY`, `STAGE_DEFAULT` ou `NONE`), `days`, `dayCountType`, `approverDays` e `illustrativeDueAt` (como se a etapa fosse aberta agora). Com `policyId`, avalia só aquela política, mesmo inativa. Não grava nada, não devolve valores do processo e mascara o que for sigiloso sem POL-09. Exige `SLA_POLICY_MANAGE` e `PROCESS_VIEW` sobre o processo (POL-27).
- **RN-SLA-33** — SLA-12 devolve as passagens do processo com `dueAt`, `slaDays`, `slaType`, `dueDateOverridden`, `slaPolicy { id, key, name }`, `branchKey`, `status`, `enteredAt`, `exitedAt`, `overdueSince`, `pausedAt`, `pauseReason`, `pausedSeconds`, `escalationLevel`, `lastEscalatedAt` e `nextEscalation`; por padrão só as ativas, com `includeClosed=true` também as encerradas (rastro para auditoria). Os campos de pausa e degrau são preenchidos por US-191 e US-192. Exige `PROCESS_VIEW` (DEC-024); processo fora da visibilidade → 404.
- **RN-SLA-34** — Exibição no SCR-006: bloco "Prazo" por etapa ativa com data, dias restantes (úteis ou corridos conforme `slaType`), `DueDateBadge` (normal, a vencer, atrasado, pausado, sem prazo), "Política aplicada: {nome}" (ou "Prazo padrão da etapa" quando `slaPolicy` é nulo) e o aviso "Prazo ajustado manualmente" quando `dueDateOverridden`; o nome da política é o atual, e a chave vem junto para rastreio mesmo que a política tenha sido desativada.
- **RN-SLA-35** — Execução: a resolução roda na transação do comando, com leitura indexada das políticas ativas `(tenant_id, is_active, priority)`, montagem preguiçosa do contexto e cache por requisição (ADR-015); falha **lógica** na avaliação de uma política não impede o encaminhamento (a política não casa); falha de banco desfaz o comando inteiro. A meta de acréscimo de p95 ≤ 50 ms por entrada em etapa é verificada na suíte de performance, não neste card.
- **RN-SLA-36** — Cada reentrada em etapa (devolução, reabertura, ciclo de diligência) cria nova passagem e nova resolução com a política vigente naquele instante; as passagens fechadas mantêm o que gravaram.
- **RN-SLA-37** — `ProcessStageDueSoon` e `ProcessStageOverdue` passam a carregar `slaPolicyKey` (campo opcional aditivo, events.md §2) quando a passagem tem `slaPolicyId`; `escalationLevel` é acrescentado por US-192. Consumidores do MVP 1 ignoram os campos novos.
- **RN-SLA-38** — Rastreabilidade: a aplicação não gera `AuditLog` próprio (como o cálculo de prazo do MVP 1); o rastro é `ProcessStage.slaPolicyId`/`slaDays`/`slaType`/`dueAt`, a resposta de SLA-12 e o campo `slaPolicyKey` nos eventos de prazo. A consulta de pré-visualização é leitura e não é auditada (events.md §7 não prevê ação).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Processo da pré-visualização | `processId` (SLA-11) | uuid | Sim | processo visível ao usuário (`PROCESS_VIEW`) | seleção por código |
| Política a testar | `policyId` (SLA-11) | uuid | Não | política do tenant; pode estar inativa | nulo (avalia as ativas) |
| Etapas a calcular | `stageKeys` (SLA-11) | lista de textos | Não | chaves do catálogo (US-189 · SLA-07); máx. 50 | todas as etapas `TASK`/`APPROVAL` |
| Incluir etapas encerradas | `includeClosed` (query SLA-12) | booleano | Não | — | `false` |
| *(saída)* Prazo | `dueAt` | datetime \| nulo | — | RN-SLA-25 | calculado |
| *(saída)* Política aplicada | `slaPolicy { id, key, name }` | objeto \| nulo | — | RN-SLA-24 | `ProcessStage.slaPolicyId` |
| *(saída)* Dias e contagem | `slaDays`, `slaType` | inteiro / `DayCountType` | — | snapshot (RN-SLA-26) | `ProcessStage` |
| *(saída)* Prazo ajustado | `dueDateOverridden` | booleano | — | RN-SLA-27 | `ProcessStage` |
| *(saída)* Prazo da linha | `ApprovalApprover.dueAt` | datetime \| nulo | — | RN-SLA-30 | calculado |
| *(saída)* Candidatas | `candidates[].result`, `winner` | enum / booleano | — | RN-SLA-32 | avaliação |
| *(saída)* Origem do prazo (pré-visualização) | `stages[].source` | `POLICY`\|`STAGE_DEFAULT`\|`NONE` | — | RN-SLA-32 | calculado |
| *(saída)* Data ilustrativa | `stages[].illustrativeDueAt` | datetime \| nulo | — | como se aberta agora | `CAL-06` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `processId` ausente ou não uuid em SLA-11 | Front + API (Zod) | "Escolha o processo para a pré-visualização." | `VALIDATION_ERROR` (`REQUIRED`/`INVALID_FORMAT`) |
| V-02 | `policyId` inexistente ou de outro tenant | API | "Selecione uma política válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | `stageKeys` com chave fora do catálogo ou com mais de 50 itens | API (Zod) | "Escolha etapas da lista." | `VALIDATION_ERROR` (`STAGE_KEY_UNKNOWN`/`TOO_LONG`) |
| V-04 | Processo inexistente, de outro tenant ou fora da visibilidade (SLA-11, SLA-12) | API | "Processo não encontrado." | `PROCESS_NOT_FOUND` |
| V-05 | Sem `PROCESS_VIEW` sobre o processo (SLA-11) | API | "Você não tem acesso a este processo." | `PERMISSION_DENIED` |
| V-06 | Sem `SLA_POLICY_MANAGE` (SLA-11) | API | "Você não tem permissão para gerenciar prazos." | `PERMISSION_DENIED` |
| V-07 | `includeClosed` não booleano (SLA-12) | API (Zod) | — | `VALIDATION_ERROR` (`INVALID_TYPE`) |
| V-08 | Calendário ou banco indisponível durante o cálculo na entrada em etapa | API | "Não foi possível concluir a ação agora. Tente novamente em instantes." | `DEPENDENCY_UNAVAILABLE` |
| V-09 | Sobrescrita de prazo sem justificativa ou em transição que não permite (herdadas de US-055) | Front + API | "Informe o motivo da alteração do prazo." / "Esta ação não permite alterar o prazo." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) / `DUE_DATE_OVERRIDE_NOT_ALLOWED` |

## Permissões
- **Permissão:** `PROCESS_VIEW` para SLA-12 e para o bloco "Prazo" do SCR-006 (visibilidade pela DEC-024); `SLA_POLICY_MANAGE` + `PROCESS_VIEW` sobre o processo para a pré-visualização SLA-11. A aplicação em si é automática (ator `SYSTEM` dentro do comando de tramitação) e não tem permissão própria.
- **Políticas:** POL-27 (o simulador com processo real exige `PROCESS_VIEW` e mascara valores sigilosos sem POL-09; mudanças de política só valem para efeitos futuros); POL-01 e demais políticas do comando de origem inalteradas; POL-09 (sigilo de orçamento).
- **MFA:** exigido apenas para `SLA_POLICY_MANAGE` (risco `H`) conforme `security.mfaPolicy` (POL-14); a leitura de SLA-12 não exige MFA.
- **Sem permissão:** o bloco "Prazo" segue a visibilidade do processo; a pré-visualização não aparece sem `SLA_POLICY_MANAGE`; a API responde 403 `PERMISSION_DENIED` (SLA-11) ou 404 `PROCESS_NOT_FOUND` (processo não visível) e registra `access.denied` nas respostas 403.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageDueSoon` | `process.stage_due_soon` | Job `deadlines` (US-055) | Passa a incluir `slaPolicyKey?` (aditivo); `escalationLevel?` vem de US-192 |
| `ProcessStageOverdue` | `process.stage_overdue` | Job `deadlines` (US-055) | Idem |
| — | — | Entrada em etapa | Nenhum evento novo: o comando de origem continua publicando `ProcessStageChanged` (e `ApprovalRequested`/`ApprovalApproverActivated` com `dueAt`/`dueAt` da linha quando houver) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação própria: os avisos de prazo são de US-114 (sem política) e US-192 (degraus, com política). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Aplicar a política de SLA ao processo e calcular prazos

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And existe a política ativa "PREGAO_ALTO_VALOR" (prioridade 10) para "process.modalityCode = PREGAO e process.estimatedValue > 1000000"
    And a política "PREGAO_ALTO_VALOR" tem 15 dias úteis na etapa "JURIDICO" e 3 dias úteis por aprovador na etapa "AUTORIZACAO_LICITACAO"
    And existe a política ativa "COMPRAS_GERAIS" (prioridade 100) para "process.contractingTypeCode = COMPRAS" com 10 dias úteis na etapa "PLANEJAMENTO"
    And o processo "0034/2026" é um pregão de R$ 1.250.000,00 e o processo "0035/2026" é uma compra direta de R$ 40.000,00
    And "Carla Mendes" tem custódia dos processos e a permissão "PROCESS_FORWARD"

  Scenario: [Sucesso] Prazo pela política na entrada em "JURIDICO"
    Given que hoje é segunda-feira 02/03/2026 e o processo "0034/2026" está na etapa "TERMO_REFERENCIA"
    When "Carla Mendes" encaminhar o processo "0034/2026" para a etapa "JURIDICO"
    Then a nova passagem deve ter "slaPolicyId" de "PREGAO_ALTO_VALOR", "slaDays" 15 e "slaType" "BUSINESS"
    And o "dueAt" deve ser 23/03/2026 às 23:59:59.999 no fuso do tenant
    And "GET /processes/{id}/sla" deve exibir "PREGAO_ALTO_VALOR" e o mesmo "dueAt"
    And deve gerar registro de auditoria "process.forward" do comando de origem
    And deve gerar o evento "ProcessStageChanged"

  Scenario: [Sucesso] Os eventos de prazo carregam a política aplicada
    Given que o processo "0034/2026" está em "JURIDICO" com "slaPolicyId" de "PREGAO_ALTO_VALOR" e "dueAt" em 23/03/2026
    When o job "deadlines" executar em 19/03/2026 e depois em 24/03/2026
    Then os eventos "ProcessStageDueSoon" e "ProcessStageOverdue" devem trazer "slaPolicyKey" igual a "PREGAO_ALTO_VALOR"
    And um processo sem política deve emitir os mesmos eventos sem "slaPolicyKey", como no MVP 1
    And nenhuma auditoria própria deve ser gerada pela detecção

  Scenario: [Sucesso] Sem política aplicável vale o prazo da etapa
    Given que nenhuma política ativa casa com o processo "0035/2026"
    When "Carla Mendes" encaminhar o processo "0035/2026" para a etapa "PLANEJAMENTO" cuja "slaDays" é 5
    Then a passagem deve ter "slaPolicyId" nulo, "slaDays" 5 e "dueAt" em 5 dias úteis
    And os avisos de prazo devem seguir "deadlines.warnBeforeBusinessDays"
    And deve gerar registro de auditoria "process.forward" e o evento "ProcessStageChanged" idênticos aos do MVP 1

  Scenario: [Sucesso] Política aplicável sem linha para a etapa usa o prazo do workflow
    When "Carla Mendes" encaminhar o processo "0034/2026" para a etapa "COMPRAS" cuja "slaDays" é 7 e que não tem linha em "PREGAO_ALTO_VALOR"
    Then a passagem deve ter "slaPolicyId" de "PREGAO_ALTO_VALOR" e "slaDays" 7
    And deve gerar registro de auditoria "process.forward" e o evento "ProcessStageChanged"

  Scenario: [Sucesso] Prazo por linha de aprovador em etapa de aprovação
    When "Carla Mendes" encaminhar o processo "0034/2026" para a etapa "AUTORIZACAO_LICITACAO" com duas linhas "SEQUENTIAL"
    Then "Approval.dueAt" deve ser igual ao "dueAt" da etapa
    And a linha 1 deve ter "dueAt" 3 dias úteis depois da solicitação e a linha 2 deve ter "dueAt" nulo até ser ativada
    When a linha 2 for ativada pelo evento "ApprovalApproverActivated"
    Then a linha 2 deve ter "dueAt" 3 dias úteis depois da ativação
    And deve gerar registro de auditoria "approval.request" e o evento "ApprovalRequested"

  Scenario: [Sucesso] Pré-visualização mostra candidatas e o prazo ilustrativo
    Given que "Marina Costa" tem "SLA_POLICY_MANAGE" e "PROCESS_VIEW" sobre o processo "0034/2026"
    When "Marina Costa" chamar "POST /sla-policies/preview" com "processId" do processo "0034/2026"
    Then a API deve responder 200 com "PREGAO_ALTO_VALOR" como "appliedPolicy" e "winner" verdadeiro
    And "COMPRAS_GERAIS" deve aparecer com "result" "NOT_MATCHED"
    And a etapa "JURIDICO" deve ter "source" "POLICY", "days" 15 e "illustrativeDueAt" preenchido
    And nenhum dado deve ser gravado e nenhum valor do processo deve constar na resposta

  Scenario: [Sucesso] Alterar a política depois da entrada não muda o prazo em curso
    Given que o processo "0034/2026" entrou em "JURIDICO" com "dueAt" em 23/03/2026
    When "Marina Costa" alterar "PREGAO_ALTO_VALOR" para 12 dias úteis em "JURIDICO"
    Then o "dueAt" da passagem em curso deve continuar 23/03/2026
    And uma nova entrada em "JURIDICO" de outro pregão deve receber 12 dias úteis

  Scenario: [Validação] Regra que falha na avaliação não casa e parâmetros inválidos são recusados
    Given que a política "PREGAO_ALTO_VALOR" tem uma expressão que falha ao avaliar o processo "0034/2026"
    When "Carla Mendes" encaminhar o processo "0034/2026" para "JURIDICO"
    Then a passagem deve usar "COMPRAS_GERAIS" se casar ou o "slaDays" da etapa
    And o encaminhamento deve concluir com sucesso e deve ser registrado log "warn" "sla.policy_evaluation_failed"
    When "Marina Costa" chamar "POST /sla-policies/preview" sem "processId"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" no campo "processId"
    When "Marina Costa" enviar "stageKeys" com "ARQUIVO_MORTO"
    Then a API deve responder 422 com erro "STAGE_KEY_UNKNOWN" no campo "stageKeys[0]"

  Scenario: [Permissão] Pré-visualização e leitura sem permissão
    Given que "Bruno Lopes" não possui "SLA_POLICY_MANAGE"
    When "Bruno Lopes" chamar "POST /sla-policies/preview"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" "SLA_POLICY_MANAGE"
    Given que "Marina Costa" tem "SLA_POLICY_MANAGE" mas não tem "PROCESS_VIEW" sobre o processo "0099/2026"
    When "Marina Costa" chamar "POST /sla-policies/preview" com o processo "0099/2026"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que "Bruno Lopes" não enxerga o processo "0034/2026" pela visibilidade
    When "Bruno Lopes" chamar "GET /processes/{id}/sla"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Tenant incorreto] Política e processo de outro tenant não participam
    Given que o tenant "Prefeitura B" tem a política ativa "PREGAO_ALTO_VALOR" com prioridade 1
    When "Carla Mendes" encaminhar o processo "0034/2026" da "Prefeitura A" para "JURIDICO"
    Then a política da "Prefeitura B" não deve ser avaliada nem aplicada
    When "Marina Costa" chamar "POST /sla-policies/preview" com um processo da "Prefeitura B"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Duplicidade] Reenvio do encaminhamento não recalcula nem duplica
    Given que "Carla Mendes" encaminhou o processo "0034/2026" com a chave "K1" e recebeu 200 com "dueAt" em 23/03/2026
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo "dueAt" e o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única passagem ativa em "JURIDICO" com "slaPolicyId" preenchido

  Scenario: [Concorrência] Política desativada no mesmo instante do encaminhamento
    Given que "Marina Costa" desativa "PREGAO_ALTO_VALOR" ao mesmo tempo em que "Carla Mendes" encaminha o processo "0034/2026" para "JURIDICO"
    When as duas transações concluírem
    Then a passagem deve ter ou "slaPolicyId" de "PREGAO_ALTO_VALOR" com 15 dias, ou "slaPolicyId" nulo com o "slaDays" da etapa
    And nunca uma mistura de política nula com 15 dias, e a resposta do encaminhamento deve ser 200

  Scenario: [Falha de banco] Falha durante o cálculo do prazo
    Given que o banco de dados fica indisponível durante a transação do encaminhamento
    When "Carla Mendes" encaminhar o processo "0034/2026" para "JURIDICO"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o processo deve continuar na etapa "TERMO_REFERENCIA", sem nova passagem, sem "dueAt" e sem auditoria ou evento

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla Mendes" encaminhar o processo "0034/2026" para "JURIDICO"
    Then a API deve responder 200 com a passagem e o "dueAt" gravados
    And o evento "ProcessStageChanged" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Parâmetro inválido na pré-visualização | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca o campo no painel |
| Processo inexistente, de outro tenant ou não visível | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Limpa a seleção |
| Política inexistente (`policyId`) | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione uma política válida." | Limpa o seletor |
| Sem `SLA_POLICY_MANAGE` ou sem `PROCESS_VIEW` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta consulta." | Oculta o painel de pré-visualização |
| MFA exigido para `SLA_POLICY_MANAGE` | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Conduz ao passo de MFA |
| Calendário ou banco indisponível na entrada em etapa | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a ação agora. Tente novamente em instantes." | Mantém a tela; botão "Tentar novamente" |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

Os erros de sobrescrita de prazo (`DUE_DATE_OVERRIDE_NOT_ALLOWED`, `VALIDATION_ERROR` `CONDITIONAL_REQUIRED`) e de tramitação são os de US-047/US-055, inalterados.

## Dependências
- **Stories:** US-047 (encaminhamento — ponto onde a passagem nasce e a sobrescrita é oferecida), US-189 (políticas e catálogo de etapas). Indiretas: US-055 (cálculo base e `ComputeStageDueDateService`), US-106 (`CAL-06`), US-001/US-048/US-052 (outras entradas em etapa), US-129 (`RuleContext` v2 e contrato do namespace `sla`), US-133/US-134 (linhas de aprovação e ativação em `SEQUENTIAL`), US-124 (ramos paralelos), US-128 (migração preserva `dueAt`), US-191 e US-192 (pausa e degraus sobre o prazo gravado aqui), US-114 (avisos do MVP 1), US-004 (detalhe do processo, SCR-006).
- **Decisões/ADRs:** DEC-205, DEC-031, DEC-193, DEC-194, DEC-195, DEC-204; ADR-015; POL-27, POL-09.
- **Configurações:** `deadlines.warnBeforeBusinessDays` (avisos sem política), `calendar.optionalHolidaysAreNonBusiness`.
- **Lacunas nas fontes canônicas:**
  1. **Cálculo síncrono × assíncrono:** a regra da feature (RN-SLA-09) diz que cálculo e avaliação rodam no worker "sem custo na transação do comando", mas `events.md §3` não faz o `SlaEvaluator` assinar eventos de entrada em etapa e a ADR-015 diz que "ao entrar numa etapa, a política aplicável define `ProcessStage.dueAt`". Esta story adota resolução **síncrona e enxuta** na entrada (contexto preguiçoso, índice, orçamento de p95) e deixa pausas, degraus e reavaliação no worker (RN-SLA-35). **Confirmar com a arquitetura.**
  2. **Origem do prazo na passagem:** `ProcessStage` guarda `slaPolicyId`, `slaDays` e `slaType`, mas não se o prazo veio da linha da política ou de `WorkflowStage.slaDays`; a pré-visualização calcula `source` ao vivo, e SLA-12 não o expõe. Proposta (opcional): `ProcessStage.slaSource` (`POLICY`/`STAGE_DEFAULT`) em `entities.md §5.3`.
  3. **Namespace `sla.*` com ramos paralelos:** `entities.md §7.2` define um único objeto `sla`; a passagem de referência (RN-SLA-31) é proposta aqui — confirmar com US-129.
  4. **Contratos novos** SLA-11 e SLA-12 e o campo `slaPolicyKey` nos eventos de prazo: a consolidar no `api.md` e em `events.md §2` (já cita `slaPolicyKey?`).
  5. **Auditoria da pré-visualização** com processo real: `events.md §7` só prevê `rule.simulate` para o simulador de regras; se o produto quiser rastrear consultas de `SLA-11`, incluir `sla_policy.preview`.
  6. A feature e o épico listam o SCR-006 para o SLA; `features.md` (Apêndice A) não o lista para US-189..US-193. Esta story o inclui em `screens`.

## Impacto técnico
- **Caminho crítico da tramitação:** a resolução entra na transação de PRC-19/PRC-20/APV-03/PRC-02; precisa ser barata e **nunca lançar** (falha lógica = política não casa). Medir o acréscimo na suíte de performance (meta p95 ≤ 50 ms) e vigiar a montagem de contexto de namespaces pesados (`budget.*`, `tender.*`): como a política só lê o que a expressão referencia, uma política que usa só `process.*` não paga o custo dos outros módulos.
- **Cálculo único:** reaproveita `BusinessCalendarFacade` (US-106) e a normalização de fim do dia (RN-TRAM-78); o prazo por linha usa a mesma função.
- **Compatibilidade:** campos novos em eventos e em SLA-12 são aditivos; órgãos sem política não veem nenhuma diferença (testes de contrato do MVP 1 sobre PRC-19, PRC-04, TSK-01 e eventos de prazo).
- **Etapas existentes:** passagens abertas antes da ativação de uma política ficam como estão (`slaPolicyId` nulo); a adoção é gradual.
- **Risco de explicabilidade:** a pessoa precisa entender por que o prazo é aquele; por isso a política vai para o SCR-006 e a pré-visualização mostra os candidatos descartados.

## Backend
- **Módulo(s):** `sla` (dono: `SlaFacade`, resolução, SLA-11, provedor `sla.*`), `process` (dono de `ProcessStage`, `ComputeStageDueDateService` estendido, SLA-12), `workflow` (`slaDays`/`slaType` base), `catalog` (`BusinessCalendarFacade`), `approval` (consome `computeApproverDueAt`), `audit` (sem ação nova).
- **Casos de uso:** `SlaFacade.resolveForEntry(processId, workflowStageId, enteredAt)`, `SlaFacade.computeApproverDueAt(processStageId, activatedAt)`; `PreviewSlaPolicyQuery` (SLA-11); `GetProcessSlaQuery` (SLA-12); `SlaRuleContextContributor` (namespace `sla`).
- **Domínio:** `SlaPolicySelector` (ordenação + avaliação + *fail-closed*), `StageDeadlineCalculator` (linha da política × base), `ProcessStage.applySla({ policyId, days, type, dueAt })`.
- **Integrações internas:** `RuleEvaluator` com `RuleContextV2Builder` (montagem preguiçosa — US-129), `BusinessCalendarFacade`, `WorkflowFacade`, `AuthorizationService`.
- **Transação:** a do comando de origem; a resolução lê as políticas, avalia, calcula e grava a passagem com o *snapshot* dentro da mesma transação, junto com auditoria, movimento e outbox do comando.

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`) — bloco "Prazo"; SCR-121 (`/admin/prazos`) — painel "Pré-visualizar com um processo".
- **Componentes:** `StageDeadlineCard` (por etapa ativa; usa `DueDateBadge` da US-055), `AppliedPolicyLabel`, `SlaPreviewPanel` (seletor de processo, tabela de candidatas e de etapas), `CandidateResultBadge`.
- **Estados:** skeleton do bloco; "Sem prazo definido"; "Prazo padrão da etapa"; erro do bloco isolado (não derruba SCR-006); pré-visualização vazia ("Nenhuma política casa com este processo; valem os prazos do workflow"); erro com `correlationId`.
- **Acessibilidade e responsividade:** estado do prazo por texto e ícone; datas completas no `aria-label`; tabelas da pré-visualização em cartões abaixo de 768 px; contraste AA.

## Banco de dados
- **Tabelas:** `process_stages` (escrita de `sla_policy_id`, `sla_days`, `sla_type`, `due_at`), `approval_approvers` (escrita de `due_at`), leitura de `sla_policies`, `sla_policy_stages`, `workflow_stages`, `holidays`.
- **Migrações:** nenhuma nova nesta story (M2-05 cria as colunas de `process_stages` e M2-10 cria `sla_policies`/`sla_policy_stages` e a FK `process_stages.sla_policy_id`).
- **Índices/constraints relevantes:** `(tenant_id, is_active, priority)` em `sla_policies` (seleção a cada entrada); `UNIQUE (tenant_id, sla_policy_id, stage_key)`; `(tenant_id, due_at) WHERE status = 'ACTIVE'` e o índice de pausa de `process_stages`; FK `(tenant_id, sla_policy_id)` com `ON DELETE RESTRICT` (a política nunca é apagada se referenciada).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `SLA-11` | POST | `/api/v1/sla-policies/preview` | `{ processId, policyId?, stageKeys? }` (leitura; sem `Idempotency-Key`) | `200 { data: { processId, contextVersion, candidates: [{ policyId, key, name, priority, isActive, result, winner }], appliedPolicy: { id, key, name, priority } \| null, stages: [{ stageKey, name, type, source, days, dayCountType, approverDays, illustrativeDueAt }] } }` | 200, 401, 403, 404, 422, 429, 503 |
| `SLA-12` | GET | `/api/v1/processes/{id}/sla` | path `id`; query `includeClosed` | `200 { data: { processId, stages: [{ processStageId, stageKey, name, branchKey, status, enteredAt, exitedAt, dueAt, slaDays, slaType, dueDateOverridden, slaPolicy, overdueSince, pausedAt, pauseReason, pausedSeconds, escalationLevel, lastEscalatedAt, nextEscalation }] }, meta: { escalationEnabled } }`; `Cache-Control: no-store` | 200, 401, 403, 404, 422, 429, 503 |
| `CAL-06` | POST | `/api/v1/calendar/add-business-days` | `{ fromDateTime, businessDays, dayCountType? }` (usado internamente e na pré-visualização) | `200 { data: { dueDateTime } }` | 200, 422, 503 |
| `PRC-19` | POST | `/api/v1/processes/{id}/forward` | como em US-047 | passagem com `dueAt`/`slaPolicyId` (efeito desta story) | 200, 403, 404, 409, 412, 422, 503 |
| `PRC-20` | POST | `/api/v1/processes/{id}/return` | como em US-048 | idem | 200, 403, 404, 409, 412, 422, 503 |
| `APV-03` | POST | `/api/v1/approvals/{id}/decide` | como em US-052 | idem, quando a decisão abre nova etapa | 200, 403, 404, 409, 412, 422, 503 |

## Logs
- `info` `sla.policy_resolved` — `processId`, `workflowStageKey`, `policyKey` (ou nulo), `candidates`, `evaluated`, `durationMs`, `correlationId`.
- `info` `process.stage_due_computed` — já existente (US-055); passa a registrar `slaPolicyKey` e `source`.
- `warn` `sla.policy_evaluation_failed` — `policyKey`, `errorCode` da avaliação (sem a expressão nem valores do processo); `warn` `sla.resolve_slow` quando `durationMs` > 50 ms.
- `error` `sla.resolve_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** valores do processo (valor estimado, orçamento sigiloso), conteúdo das expressões, resultado detalhado da avaliação.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | Resolução de política e cálculo de prazo na entrada em etapa não geram `AuditLog` próprio (rastro em `ProcessStage` e SLA-12); a auditoria do comando de origem (`process.forward`, `process.return`, `approval.decide`) é a do MVP 1 | — |
| `access.denied` | `ACCESS` | 403 em SLA-11 | `reasonCode = SLA_POLICY_MANAGE` ou `PROCESS_VIEW`, `processId?` |

## Testes necessários
- **Unitários:** `SlaPolicySelector` (ordem por `priority`/`createdAt`, restrição de workflow, *fail-closed*); `StageDeadlineCalculator` (linha × base × nenhuma; dias úteis e corridos; feriado; fim do dia e UTC); cálculo de `approverDays` por ativação; provedor `sla.*` (passagem de referência); sobrescrita preservando `slaPolicyId`.
- **Integração (Testcontainers PostgreSQL):** encaminhamento, devolução, decisão de aprovação e criação de processo com política (todas as entradas); *snapshot* imutável após editar/desativar; passagem em ramo paralelo; migração preservando `dueAt`; `SEQUENTIAL` com prazo por linha; rollback total em falha de banco; relógio controlado.
- **API/contrato:** SLA-11 e SLA-12 conforme `api.md` do MVP 2; **contrato do MVP 1** de PRC-19/PRC-04/TSK-01 e eventos de prazo inalterado sem política; `slaPolicyKey` aditivo nos eventos.
- **RBAC e multi-tenant:** SLA-11 (`SLA_POLICY_MANAGE` + `PROCESS_VIEW`); SLA-12 por visibilidade (DEC-024); política e processo de outro tenant nunca avaliados (suíte "tenant leak": `process_stages` com `sla_policy_id`, SLA-11, SLA-12).
- **Concorrência:** desativação da política × encaminhamento (resultado consistente, sem estado misto); dois encaminhamentos simultâneos (um efetivo).
- **E2E (Playwright):** cadastrar política → encaminhar pregão de alto valor → ver "Política aplicada" e o prazo no SCR-006 → alterar a política e ver que o prazo em curso não muda → pré-visualizar outro processo.
- **Acessibilidade/performance:** axe no bloco "Prazo" e no painel de pré-visualização; suíte de performance: acréscimo de p95 ≤ 50 ms por entrada com 20 políticas ativas.

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
- [ ] Teste de contrato prova que, sem política, o trâmite responde exatamente como no MVP 1
- [ ] Teste prova que alterar ou desativar a política não muda `dueAt` nem `slaPolicyId` de passagens em curso
- [ ] Teste de performance da suíte própria registra o acréscimo de p95 da resolução na entrada em etapa

## Estimativa
**M** — não há tabela nova: o esforço está em encaixar a resolução na transação de quatro comandos sem regressão do MVP 1, no prazo por linha de aprovador, na pré-visualização com candidatas, no endpoint de leitura e no provedor do namespace `sla`.

## Prioridade
**P1** — sem a aplicação, a política cadastrada em US-189 não tem efeito; porém o MVP 1 continua funcionando como base, e a story não bloqueia as etapas P0 do DT-02/DT-03.
