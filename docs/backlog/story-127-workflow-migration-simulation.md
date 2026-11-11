---
id: US-127
title: "Simular a migração e decidir os processos que exigem decisão"
epic: EP-021
feature: FT-064
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-041, US-124, US-126]
modules: [process, workflow, approval, access, audit]
screens: [SCR-118]
endpoints: [WF-31, WF-32, WF-33, WF-34]
permissions: [WORKFLOW_MIGRATE, WORKFLOW_VIEW]
events: [WorkflowMigrationSimulated]
---

# US-127 — Simular a migração e decidir os processos que exigem decisão

## Título
Simular a migração e decidir os processos que exigem decisão

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO` com `WORKFLOW_MIGRATE`), **quero** simular o plano de migração e ver, processo a processo, o que migraria sozinho, o que exige a minha decisão e o que está bloqueado, e registrar a minha decisão justificada nos casos ambíguos, **para** que nenhum processo seja levado a uma etapa errada e nenhuma decisão ambígua seja tomada pela máquina.

A story entrega a **simulação obrigatória** do ADR-016 e da DEC-195: um `WorkflowMigrationItem` por processo do filtro, classificado em `AUTOMATIC`, `NEEDS_DECISION` ou `BLOCKED` com as razões (`STAGE_REMOVED`, `STAGE_TYPE_CHANGED`, `APPROVAL_INCOMPATIBLE`, `PARALLEL_ACTIVE`, `BLOCKING_RULE_VIOLATED`, `FINAL_STATUS`, `EDIT_LOCK`, `MIGRATION_IN_PROGRESS`), o `simulationHash`, a listagem e o detalhe dos itens com a prévia do efeito, e a **decisão humana** por item (etapa de destino ou exclusão, justificativa de no mínimo 20 caracteres). A simulação não tem nenhum efeito sobre os processos. A execução assíncrona é da US-128.

## Contexto
- A simulação existe para tornar a migração previsível: a máquina só decide sozinha o que é inequívoco (`AUTOMATIC`); tudo que é ambíguo vira decisão humana com justificativa, auditada (DEC-195, ADR-016 §2–§3, princípio de ação humana explícita).
- `docs/mvp-02/entities.md` §4.7 define `WorkflowMigrationItem` (`classification`, `classificationReasons`, `expectedProcessStageIds`, `proposedTargetStageKey`, `decision`, `targetStageKey`, `decisionJustification`, `result`), os checks (`BLOCKED` ⇒ `EXCLUDE`; `MIGRATE` humano ⇒ destino + justificativa) e a regra de `simulationHash` (SHA-256 de mapa + filtro + itens classificados). §6.8 fixa as transições `DRAFT → SIMULATED` e `SIMULATED → RUNNING` (todos os `NEEDS_DECISION` decididos; mesmo `simulationHash`).
- POL-21 (`permissions.md`): executar exige plano `SIMULATED` com o mesmo `simulationHash` e todos os itens `NEEDS_DECISION` decididos com justificativa; códigos `MIGRATION_NOT_SIMULATED`, `MIGRATION_DECISIONS_PENDING` e `MIGRATION_SIMULATION_STALE`.
- Processos em paralelismo (US-124) são sempre `NEEDS_DECISION` (`PARALLEL_ACTIVE`, FT-063/FT-064): o ADR-016 pede revisão dessa classificação se um dia houver ramos aninhados. Processos `COMPLETED` na v1 do padrão (`COMPLETED_V1_CONTINUATION`) são tratados na US-131.
- O contrato do plano (mapa `StageMapping`, filtro `MigrationFilter`, diagnóstico) vem da US-126; as regras e o `RuleContext` avaliados são os do `workflow` (US-041, ADR-008), incluindo `contextVersion` por regra (v1 para regras do MVP 1).
- A aprovação pendente compatível ou não segue as políticas da DEC-193 (`decisionPolicy`, `ApprovalApprover`) e as regras de movimentação de aprovações da DEC-195.

## Objetivo
Garantir que 100% dos processos do filtro sejam classificados por regras determinísticas e explicáveis (razões em pt-BR), que nenhum item `NEEDS_DECISION` chegue à execução sem decisão humana justificada e que a simulação tenha **zero efeito** sobre processos, aprovações e prazos (teste de não-efeito).

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`) com `WORKFLOW_MIGRATE`.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), que informa o critério dos casos ambíguos (a decisão é registrada pelo administrador); Auditor (`AUDITOR`) e perfis com `WORKFLOW_VIEW`, que leem a simulação e as decisões.

## Pré-condições
- Plano `WorkflowMigration` em `DRAFT` (US-126) com mapa e filtro definidos, e origem/destino válidos; ou plano `SIMULATED` que será simulado de novo.
- Usuário com `WORKFLOW_MIGRATE`, MFA válido na sessão (POL-21) e visibilidade dos processos (o administrador vê todos por escopo `TENANT`).
- Filtro retorna ao menos 1 processo e no máximo o limite do plano (2.000 — lacuna L-2 da US-126).

## Fluxo principal
1. Na SCR-118, fase **Simulação**, o administrador revisa o resumo do plano e aciona "Simular migração" (WF-31, `Idempotency-Key`, `If-Match`).
2. A API valida o plano (RN-WF2-49), seleciona os processos visíveis que casam com o filtro (RN-WF2-43 da US-126) e, **sem alterar nenhum processo**, lê cada um em instantâneo consistente: status, etapas ativas, aprovação pendente, responsável, unidade e `dueAt`.
3. Para cada processo aplica a classificação (RN-WF2-50..53), registra `expectedProcessStageIds` (RN-WF2-54), a etapa de destino proposta pelo mapa e as razões, e grava um `WorkflowMigrationItem`; itens `AUTOMATIC` nascem com `decision = MIGRATE`, `BLOCKED` com `decision = EXCLUDE` e `NEEDS_DECISION` com `decision = PENDING`.
4. Calcula `totals { automatic, needsDecision, blocked }` e o `simulationHash` (RN-WF2-54), leva o plano a `SIMULATED` (`simulatedAt`, `simulatedById`), audita `workflow_migration.simulate` e emite `WorkflowMigrationSimulated`. A resposta traz o plano com `decisionsPending` e `canExecute`.
5. A SCR-118 mostra três cartões de resumo ("Migram sozinhos", "Precisam da sua decisão", "Bloqueados") e a tabela de itens (WF-32) com filtro por classificação, razão, etapa e situação da decisão, e busca por código ou título.
6. Para cada item `NEEDS_DECISION`, o administrador abre a gaveta de decisão (WF-33), lê as razões e a **prévia do efeito** (etapa de origem → destino, unidade, responsável e prazo preservados, aprovações mantidas ou a cancelar, status resultante) e decide: "Migrar para…" (escolhe a etapa de destino) ou "Excluir da migração", escreve a justificativa (20–1.000 caracteres) e confirma (WF-34, `If-Match` do item).
7. A API grava a decisão (`decision`, `targetStageKey`, `decisionJustification`, `decidedById`, `decidedAt`), audita `workflow_migration.decide_item` e devolve o item; o plano atualiza `decisionsPending`. O botão "Próximo pendente" leva ao item seguinte.
8. Com `decisionsPending = 0` e ao menos um item a migrar, o plano indica "Pronto para executar" (`canExecute = true`) e a fase **Execução** da US-128 é habilitada.

## Fluxos alternativos
- **FA-01 — Excluir um processo `AUTOMATIC`:** o administrador pode excluir da migração um item automático (com justificativa) e depois restaurá-lo ("Migrar automaticamente"), sem informar destino.
- **FA-02 — Decidir de novo:** enquanto o plano está `SIMULATED`, a decisão de um item pode ser alterada; a trilha fica na auditoria (`workflow_migration.decide_item`) e o item guarda a última.
- **FA-03 — Processo em ramificação:** o item vem como `NEEDS_DECISION` (`PARALLEL_ACTIVE`) com a prévia "Os ramos serão encerrados e o processo seguirá em uma única etapa"; o administrador escolhe **uma** etapa de destino (RN-WF2-59).
- **FA-04 — Regra nova violada:** `BLOCKING_RULE_VIOLATED` mostra as regras e as mensagens; o administrador pode migrar assim mesmo (a regra continuará impedindo o encaminhamento no destino) ou excluir o processo.
- **FA-05 — Aprovação perderia votos:** `APPROVAL_INCOMPATIBLE` com `votesLost = true` (política `ALL`/`SEQUENTIAL` com votos já dados) destaca que a aprovação será cancelada e solicitada de novo.
- **FA-06 — Processo bloqueado transitoriamente:** `EDIT_LOCK` pode desaparecer; "Simular de novo" reavalia tudo (descarta decisões, com confirmação).
- **FA-07 — Re-simular:** repetir a simulação de um plano `SIMULATED` reclassifica todos os processos (novo `simulationHash`) e descarta decisões; exige `confirmDiscardDecisions` quando houver decisão humana.
- **FA-08 — Nada a migrar:** se todos os itens ficarem `BLOCKED`/excluídos, o plano continua `SIMULATED` com `canExecute = false` e o motivo "Nenhum processo para migrar".
- **FA-09 — Leitura por perfis sem `WORKFLOW_MIGRATE`:** auditor e gestor veem resumo, itens e decisões em leitura; não decidem.

## Regras de negócio
- **RN-WF2-49** — Simular (WF-31) exige `WORKFLOW_MIGRATE` e MFA (POL-21) e plano em `DRAFT` (ou `SIMULATED`, FA-07 — com `confirmDiscardDecisions` se houver decisão humana, senão `MIGRATION_DISCARD_NOT_CONFIRMED`); `RUNNING`/`COMPLETED`/`CANCELED` → 409 `MIGRATION_NOT_EDITABLE`. O filtro precisa casar ≥ 1 processo (`MIGRATION_NO_PROCESSES`, 422) e ≤ 2.000 (`MIGRATION_TOO_MANY_PROCESSES`, 422, `meta.matchCount/limit`). A simulação é síncrona; reexecutar com a mesma `Idempotency-Key` devolve o mesmo resultado. Considera apenas processos **visíveis** a quem simula (POL-21, DEC-024).
- **RN-WF2-50** — Classificação `BLOCKED` (sempre `decision = EXCLUDE`, sem decisão possível): (a) `FINAL_STATUS` — processo `CANCELED`, `PUBLISHED` ou `COMPLETED` (este fora da continuação da US-131); (b) `EDIT_LOCK` — o processo está com a trava consultiva tomada por outra operação no momento da leitura (tentativa sem espera); (c) `MIGRATION_IN_PROGRESS` — o processo tem item `PENDING` em outro plano `RUNNING`. Havendo qualquer causa de bloqueio, as demais regras não são avaliadas e todas as razões de bloqueio encontradas são registradas.
- **RN-WF2-51** — Classificação `AUTOMATIC` (todas as condições): o processo tem **uma** etapa ativa `TASK`/`APPROVAL`; a etapa tem destino no mapa; origem e destino têm o **mesmo tipo**; se há aprovação pendente, ela é **compatível** (RN-WF2-60); e nenhuma regra `BLOCKING` **nova** do destino está violada (RN-WF2-52). `proposedTargetStageKey` = destino do mapa.
- **RN-WF2-52** — Classificação `NEEDS_DECISION`: basta **uma** razão: `STAGE_REMOVED` (etapa ativa sem destino no mapa), `STAGE_TYPE_CHANGED` (destino de tipo diferente), `APPROVAL_INCOMPATIBLE` (aprovação pendente incompatível), `PARALLEL_ACTIVE` (split ativo — RN-WF2-59), `BLOCKING_RULE_VIOLATED` (alguma regra `BLOCKING` de `STAGE_EXIT` da etapa de destino **que não tem equivalente** — mesmo `type` e mesma configuração — na etapa de origem está violada para o processo; regra que não pode ser avaliada conta como violada, fail-closed, com `evaluationFailed = true`) e `COMPLETED_V1_CONTINUATION` (US-131). Todas as razões aplicáveis são registradas, na ordem do catálogo.
- **RN-WF2-53** — Avaliação das regras na simulação: usa o `RuleContext` na versão da regra (`contextVersion` — v1 para regras do MVP 1, v2 para as novas), sobre o estado atual do processo, **sem efeitos colaterais** e com cache por (etapa de destino, regra); falha de provedor de contexto (módulo indisponível) é fail-closed (`BLOCKING_RULE_VIOLATED` com `evaluationFailed`). A simulação nunca avalia regras `WARNING` (não bloqueiam). Valores de orçamento sigiloso nunca saem da avaliação (POL-09).
- **RN-WF2-54** — Cada item grava `expectedProcessStageIds` = ids das `ProcessStage` `ACTIVE` do processo (inclusive o split) no instante da leitura; o plano grava `simulationHash` = SHA-256 do JSON canônico (RFC 8785) de `{ stageMapping ordenado por sourceStageKey, processFilter canônico, items ordenados por processId: { processId, classification, reasons ordenadas, proposedTargetStageKey, expectedProcessStageIds ordenados } }`; as decisões humanas **não** entram no hash. A simulação lê cada processo em transação `REPEATABLE READ READ ONLY` e grava itens e plano numa única transação de escrita (confere a `version` do plano; divergência → 412).
- **RN-WF2-55** — Decisão humana (WF-34): só com plano `SIMULATED`; `decision` ∈ {`MIGRATE`, `EXCLUDE`}. Em `NEEDS_DECISION`: `MIGRATE` exige `targetStageKey` (etapa `TASK`/`APPROVAL` da versão de destino, fora de ramo — `MIGRATION_TARGET_INVALID`/`MIGRATION_TARGET_IN_BRANCH`) e `justification` de **20 a 1.000** caracteres; `EXCLUDE` exige `justification` (20–1.000). Em `AUTOMATIC`: `EXCLUDE` com justificativa; `MIGRATE` sem destino nem justificativa restaura o automático. Em `BLOCKED`: sempre 422 `MIGRATION_ITEM_BLOCKED`. Grava `decidedById`/`decidedAt`; a justificativa é texto livre sem dados sigilosos e é auditada.
- **RN-WF2-56** — Concorrência das decisões: WF-34 exige `If-Match` com a `version` do item (412 `VERSION_CONFLICT`); reenviar a mesma decisão idêntica é idempotente (200 sem nova auditoria quando nada mudou); decisões em itens diferentes são independentes. Alterar mapa/filtro ou re-simular remove os itens e as decisões (US-126, FA-07).
- **RN-WF2-57** — Listagem (WF-32): filtros `classification`, `decision`, `result`, `reason`, `stageKey`, `q` (código/título do processo, 2–200 caracteres), ordenação (`code`, `classification`, `-decidedAt`; padrão `classification` e `code`), paginação (`pageSize` ≤ 100) e `meta` com contagens por classificação e por decisão (do plano inteiro, não só da página). Cada item traz dados do processo (`code`, `title`, `status`, secretaria, etapas ativas), as razões com mensagem pt-BR e parâmetros, a etapa proposta, a decisão e o resultado; **nenhum valor monetário** é devolvido.
- **RN-WF2-58** — Detalhe (WF-33) devolve a **prévia do efeito**: etapas de origem → etapa de destino (nome e tipo), o que será preservado (unidade, responsável, `dueAt`), as aprovações a manter e a cancelar (`approvalsKept[]`, `approvalsToCancel[]`, `votesLost`), o status resultante (`statusFrom` → `statusTo`), as regras novas violadas (`ruleId`, mensagem) e se haverá nova solicitação de aprovação. A prévia é calculada no momento da leitura e **não** altera nada.
- **RN-WF2-59** — Processo em paralelismo (`PARALLEL_ACTIVE`): é sempre `NEEDS_DECISION`; a etapa **representativa** para o mapa e para a prévia é a etapa de ramo com o **menor `dueAt`** (empate: `displayOrder`, depois `sequence`); a decisão `MIGRATE` escolhe **uma** etapa de destino fora de ramo; na execução os ramos e o split fecham como `MIGRATED`/cancelados e as aprovações pendentes dos ramos são canceladas (US-128). Unidade, responsável e `dueAt` preservados vêm da etapa representativa.
- **RN-WF2-60** — Compatibilidade da aprovação pendente (ADR-016): só é avaliada quando o destino é `APPROVAL`; compatível = **mesmos aprovadores resolvidos** (mesmo `approverType` e mesma pessoa/perfil/unidade resolvida, `allowDeputy` igual) e **mesma `decisionPolicy`** (DEC-193) na etapa de destino; caso contrário `APPROVAL_INCOMPATIBLE`, com `votesLost = true` se já houver voto (`APPROVED`/`RETURNED`/`REJECTED`) em alguma linha `ApprovalApprover`. Processo em etapa `TASK` não tem aprovação pendente a avaliar.
- **RN-WF2-61** — Prontidão do plano: `decisionsPending` = itens `NEEDS_DECISION` com `decision = PENDING`; `canExecute` = plano `SIMULATED` ∧ `decisionsPending = 0` ∧ ao menos um item com `decision = MIGRATE`; `blockers[]` ∈ {`NOT_SIMULATED`, `DECISIONS_PENDING`, `NOTHING_TO_MIGRATE`}. O plano e a SCR-118 exibem esse estado; a regra de execução em si (e o 409/422 da API) é da US-128.
- **RN-WF2-62** — Nenhum efeito colateral: simular e decidir **não** escrevem em `Process`, `ProcessStage`, `ProcessAssignment`, `ProcessMovement`, `ProcessAccess` nem `Approval`, não enviam notificação, não pausam nem estendem prazos e não tomam locks de escrita de processos (apenas tentativa de trava consultiva para `EDIT_LOCK`, liberada em seguida); só gravam `WorkflowMigration`, `WorkflowMigrationItem`, auditoria e o evento `WorkflowMigrationSimulated`. Um teste de **não-efeito** compara o estado das tabelas de processo antes e depois.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Confirmo descartar as decisões | `confirmDiscardDecisions` | boolean | Condicional | Obrigatório ao re-simular plano `SIMULATED` com decisão humana | `false` |
| Classificação | `classification` | `MigrationClassification` | — | `AUTOMATIC`/`NEEDS_DECISION`/`BLOCKED` | simulação |
| Motivos | `classificationReasons[]` | lista `{ code, message, params }` | — | Catálogo da RN-WF2-50/52 | simulação |
| Etapa de origem | `expectedProcessStageIds` + etapas ativas | uuid[] / lista | — | Etapas ativas na simulação | simulação |
| Etapa proposta | `proposedTargetStageKey` | texto ≤ 60 | — | Pelo mapa (etapa representativa em ramo) | mapa |
| Decisão | `decision` | `MigrationItemDecision` | Sim (WF-34) | `MIGRATE` / `EXCLUDE` (`PENDING` só leitura) | `PENDING`/`MIGRATE`/`EXCLUDE` |
| Etapa de destino escolhida | `targetStageKey` | texto ≤ 60 | Condicional | Obrigatória em `MIGRATE` de `NEEDS_DECISION`; `TASK`/`APPROVAL` fora de ramo da versão de destino | — |
| Justificativa | `justification` → `decisionJustification` | texto | Condicional | 20–1.000 caracteres; obrigatória em decisão humana | — |
| Quem decidiu / quando | `decidedById`, `decidedAt` | uuid / data | — | Sistema | sessão |
| Resultado | `result` | `MigrationItemResult` | — | `PENDING` até a execução (US-128) | `PENDING` |
| Resumo | `totals` | objeto | — | `{ automatic, needsDecision, blocked }` após a simulação | simulação |
| Hash da simulação | `simulationHash` | texto 64 | — | SHA-256 (RN-WF2-54) | simulação |
| Prontidão | `decisionsPending`, `canExecute`, `blockers[]` | int / boolean / lista | — | RN-WF2-61 | calculado |
| Prévia do efeito | `effectPreview` | objeto | — | RN-WF2-58 | WF-33 |
| Filtros da lista | `classification`, `decision`, `result`, `reason`, `stageKey`, `q`, `page`, `pageSize`, `sort` | query | Não | RN-WF2-57 | UI |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Plano fora de `DRAFT`/`SIMULATED` ao simular | API | "Este plano não pode mais ser simulado." | `MIGRATION_NOT_EDITABLE` (409) |
| V-02 | Re-simular com decisões sem confirmar o descarte | Front + API | "Simular de novo apaga as decisões já tomadas. Confirme para continuar." | `MIGRATION_DISCARD_NOT_CONFIRMED` (422) |
| V-03 | Filtro sem processos | API | "O filtro não encontrou nenhum processo. Ajuste o plano." | `MIGRATION_NO_PROCESSES` (422) |
| V-04 | Filtro com mais de 2.000 processos | API | "O filtro encontrou {N} processos; o limite por plano é {limite}. Restrinja o filtro e simule de novo." | `MIGRATION_TOO_MANY_PROCESSES` (422) |
| V-05 | Decisão com plano que não está `SIMULATED` | API | "Simule o plano antes de decidir." | `MIGRATION_NOT_SIMULATED` (409) |
| V-06 | Decisão em item `BLOCKED` | API | "Este processo está bloqueado ({motivo}) e não pode ser migrado." | `MIGRATION_ITEM_BLOCKED` (422) |
| V-07 | `MIGRATE` sem `targetStageKey` em `NEEDS_DECISION` | Front + API (Zod) | "Escolha a etapa de destino." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-08 | `targetStageKey` inexistente, de tipo não permitido ou dentro de ramo | API | "A etapa \"{etapa}\" não aceita processos migrados." | `MIGRATION_TARGET_INVALID` / `MIGRATION_TARGET_IN_BRANCH` (422) |
| V-09 | `justification` ausente, menor que 20 ou maior que 1.000 | Front + API (Zod) | "Explique a decisão em 20 a 1.000 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-10 | `If-Match` ausente/divergente (plano ou item) | API | "Este item foi alterado por outra pessoa. Recarregue e tente de novo." | `PRECONDITION_REQUIRED` (428) / `VERSION_CONFLICT` (412) |
| V-11 | Parâmetros de listagem inválidos | Front + API (Zod) | "Revise os filtros e tente de novo." | `VALIDATION_ERROR` (422) |
| V-12 | Sessão sem MFA | API | "Confirme sua identidade com o segundo fator para migrar processos." | `MFA_REQUIRED` (403) |
| V-13 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta requisição já foi usada com outros dados." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `WORKFLOW_MIGRATE` para simular e decidir (WF-31, WF-34); `WORKFLOW_VIEW` para listar e ver itens (WF-32, WF-33) e o plano.
- **Políticas:** POL-21 (MFA sempre; processos fora da visibilidade de quem simula não entram; erros `MIGRATION_*`), DEC-024 (visibilidade), POL-09 (nenhum valor sigiloso na simulação, na lista, na prévia ou nos logs).
- **MFA:** **sempre** em WF-31 e WF-34 (POL-21); sem MFA → 403 `MFA_REQUIRED`. Leituras (WF-32/WF-33) não exigem MFA.
- **Sem permissão:** "Simular migração", "Decidir" e as ações de gaveta não aparecem; a SCR-118 fica em leitura para `WORKFLOW_VIEW`; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`; plano/item de outro tenant → 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowMigrationSimulated` | `workflow_migration.simulated` | Commit da simulação (WF-31) | `migrationId`, `sourceWorkflowVersionId`, `targetWorkflowVersionId`, `totals { automatic, needsDecision, blocked }`; sem ids de processo nem texto; consumido pelo `AnalyticsProjector` |

Decidir um item não gera evento de domínio (só auditoria `workflow_migration.decide_item`); leituras não geram evento.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: a simulação é síncrona e a decisão é da própria pessoa; a notificação do fim da execução (`WORKFLOW_MIGRATION_FINISHED`) é da US-128. Nenhum processo é notificado por simular ou decidir. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Simular a migração e decidir os processos que exigem decisão

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (com "WORKFLOW_MIGRATE") e MFA válido na sessão
    And o workflow "LICITACAO_PADRAO" tem a versão 2 "RETIRED" (com a etapa "ARQUIVO_TEMPORARIO" e um bloco paralelo "RAMIFICACAO_ANALISES") e a versão 3 "PUBLISHED" sem essas etapas
    And o plano "Migração v2 → v3" está em "DRAFT" com o mapa revisado e "ARQUIVO_TEMPORARIO" sem destino
    And os processos do filtro são: "0101/2026" em "ESTUDOS_PRELIMINARES", "0102/2026" em "ARQUIVO_TEMPORARIO", "0103/2026" em "APROVACAO_AUTORIDADE" com aprovação pendente de "Dr. Álvaro", "0104/2026" com os ramos "JURIDICO" e "CONTROLE_INTERNO" ativos, e "0105/2026" "CANCELED" citado em "processIds"
    And na versão 3 a aprovação da etapa "APROVACAO_AUTORIDADE" é do perfil "AUTORIDADE_COMPETENTE"

  Scenario: [Sucesso] Simular classifica cada processo sem alterá-lo
    When "Marina" simular o plano
    Then a API deve responder 200 com o plano "SIMULATED", "totals" { automatic: 1, needsDecision: 3, blocked: 1 } e "simulationHash" preenchido
    And "0101/2026" deve ser "AUTOMATIC" com decisão "MIGRATE"
    And "0102/2026" deve ser "NEEDS_DECISION" com a razão "STAGE_REMOVED"
    And "0103/2026" deve ser "NEEDS_DECISION" com a razão "APPROVAL_INCOMPATIBLE"
    And "0104/2026" deve ser "NEEDS_DECISION" com a razão "PARALLEL_ACTIVE" e etapa representativa a do menor prazo
    And "0105/2026" deve ser "BLOCKED" com a razão "FINAL_STATUS" e decisão "EXCLUDE"
    And as tabelas de processo devem ficar idênticas às de antes da simulação
    And deve gerar registro de auditoria "workflow_migration.simulate"
    And deve gerar o evento WorkflowMigrationSimulated com os mesmos totais

  Scenario: [Sucesso] Decidir um item com etapa de destino e justificativa
    Given que o plano está "SIMULATED"
    When "Marina" decidir "0102/2026" com "MIGRATE", "targetStageKey" "ESTUDOS_PRELIMINARES" e a justificativa "Processo arquivado por engano; retomar a partir dos estudos com a mesma equipe."
    Then o item deve ficar com "decision" "MIGRATE", "decidedById" de "Marina" e "decidedAt" preenchido
    And "decisionsPending" do plano deve diminuir em 1
    And deve gerar registro de auditoria "workflow_migration.decide_item"
    And nenhum processo deve ser alterado

  Scenario: [Sucesso] Excluir da migração e restaurar um item automático
    When "Marina" excluir "0101/2026" com a justificativa "Aguardando definição do gestor sobre a nova etapa."
    Then o item deve ficar com "decision" "EXCLUDE"
    When "Marina" restaurar o item com "MIGRATE" sem destino nem justificativa
    Then o item deve voltar a "MIGRATE" e a auditoria "workflow_migration.decide_item" deve ter registrado as duas decisões

  Scenario: [Sucesso] Plano pronto para executar
    Given que "Marina" decidiu os 3 itens "NEEDS_DECISION"
    Then o plano deve ter "decisionsPending" 0 e "canExecute" verdadeiro

  Scenario: [Validação] Justificativa curta ou destino inválido
    When "Marina" decidir "0103/2026" com "MIGRATE", destino "APROVACAO_AUTORIDADE" e a justificativa "ok"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" no campo "justification"
    When "Marina" decidir "0102/2026" com destino "FASE_INEXISTENTE" (etapa que não existe na versão 3)
    Then a API deve responder 422 com código "MIGRATION_TARGET_INVALID"
    When "Marina" decidir o item "BLOCKED" "0105/2026" com "MIGRATE"
    Then a API deve responder 422 com código "MIGRATION_ITEM_BLOCKED"

  Scenario: [Validação] Filtro com processos demais ou nenhum
    Given que o filtro do plano casa 2.001 processos
    When "Marina" simular o plano
    Then a API deve responder 422 com código "MIGRATION_TOO_MANY_PROCESSES" e "meta.matchCount" igual a 2001
    And o plano deve continuar "DRAFT" e nenhum item deve ser criado

  Scenario: [Permissão] Sem WORKFLOW_MIGRATE ou sem MFA
    Given que "Bruno" tem apenas "WORKFLOW_VIEW"
    When "Bruno" simular o plano
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Bruno" listar os itens da simulação
    Then a API deve responder 200 sem nenhum valor monetário
    Given que "Marina" está com a sessão sem MFA
    When "Marina" decidir um item
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Plano ou item de outro tenant
    Given que existe o plano "Migração B" com itens no tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", listar os itens ou decidir um item desse plano
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio da simulação e da decisão
    Given que "Marina" simulou o plano com a "Idempotency-Key" "S-01" e recebeu 200
    When a mesma requisição for reenviada
    Then a API deve responder 200 com "Idempotent-Replayed" verdadeiro e o mesmo "simulationHash"
    And deve existir uma única auditoria "workflow_migration.simulate" e um único evento WorkflowMigrationSimulated
    When "Marina" reenviar a mesma decisão idêntica de um item
    Then a API deve responder 200 sem nova auditoria

  Scenario: [Concorrência] Duas pessoas decidem o mesmo item
    Given que "Marina" e "Paulo" (também administrador) carregaram o item "0102/2026" com o mesmo "ETag"
    When "Marina" decidir com "MIGRATE" e depois "Paulo" decidir "EXCLUDE" com o "ETag" antigo
    Then a segunda chamada deve responder 412 com código "VERSION_CONFLICT"
    And o item deve manter a decisão de "Marina"

  Scenario: [Concorrência] Processo tramitado durante a simulação
    Given que "0101/2026" foi encaminhado por outro usuário enquanto o plano era simulado
    When a simulação gravar os itens
    Then o item deve ter "expectedProcessStageIds" da etapa lida no instante da simulação
    And a execução da US-128 deve marcá-lo "STALE" sem alterar o processo

  Scenario: [Falha de banco] Falha ao gravar os itens
    Given que o banco falha durante a gravação dos itens da simulação
    When "Marina" simular o plano
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o plano deve continuar "DRAFT", sem itens, sem "simulationHash" e sem evento

  Scenario: [Falha de integração] Provedor do contexto de regras indisponível
    Given que o provedor do contexto v2 do módulo "legal-review" falha ao avaliar uma regra BLOCKING nova da etapa de destino
    When "Marina" simular o plano
    Then o item do processo afetado deve ser "NEEDS_DECISION" com a razão "BLOCKING_RULE_VIOLATED" e "evaluationFailed" verdadeiro
    And a simulação não deve falhar nem alterar processos
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Plano não simulável | 409 | `MIGRATION_NOT_EDITABLE` | "Este plano não pode mais ser simulado." | Fase em leitura |
| Descarte de decisões não confirmado | 422 | `MIGRATION_DISCARD_NOT_CONFIRMED` | "Simular de novo apaga as decisões já tomadas. Confirme para continuar." | Diálogo de confirmação |
| Filtro sem processos | 422 | `MIGRATION_NO_PROCESSES` | "O filtro não encontrou nenhum processo. Ajuste o plano." | Link para a fase Plano |
| Processos demais | 422 | `MIGRATION_TOO_MANY_PROCESSES` | "O filtro encontrou {N} processos; o limite por plano é {limite}. Restrinja o filtro e simule de novo." | Link para o filtro |
| Decisão sem simulação | 409 | `MIGRATION_NOT_SIMULATED` | "Simule o plano antes de decidir." | Botão "Simular" em destaque |
| Item bloqueado | 422 | `MIGRATION_ITEM_BLOCKED` | "Este processo está bloqueado ({motivo}) e não pode ser migrado." | Ações da gaveta desabilitadas |
| Destino inválido/em ramo | 422 | `MIGRATION_TARGET_INVALID` / `MIGRATION_TARGET_IN_BRANCH` | "A etapa \"{etapa}\" não aceita processos migrados." | Opção desabilitada com tooltip |
| Justificativa inválida | 422 | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`/`CONDITIONAL_REQUIRED`) | "Explique a decisão em 20 a 1.000 caracteres." | Erro no campo com contador |
| Item/plano alterado | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "Este item foi alterado por outra pessoa. Recarregue e tente de novo." | `ConflictDialog` com a decisão atual |
| Corpo diferente com a mesma chave | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta requisição já foi usada com outros dados." | Nova chave |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para migrar processos." | Ações ocultas |
| MFA ausente | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para migrar processos." | Step-up |
| Plano/item inexistente/outro tenant | 404 | `NOT_FOUND` | "Item não encontrado." | Volta para a lista |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Toast com `correlationId` e "Tentar novamente" |

## Dependências
- **Stories:** US-126 (plano, mapa e filtro), US-041 (motor de regras e `RuleContext`), US-124 (etapas ativas, ramos e `PARALLEL_ACTIVE`); US-051/US-052 (aprovações pendentes) e EP-022/DEC-193 (política e linhas de aprovação). Habilita US-128 (execução) e US-131 (continuação v1 → v2).
- **Decisões/ADRs:** DEC-195, DEC-193, DEC-194, DEC-014, DEC-016/DEC-204 (`RuleContext`); [ADR-016](../adr/adr-016-workflow-version-migration.md), [ADR-008](../adr/adr-008-configurable-rules.md); POL-21; `entities.md` §4.7 e §6.8.
- **Configurações:** nenhuma chave nova.
- **Lacunas nas fontes canônicas:**
  - `EDIT_LOCK` ("processo com trava de edição") aparece em `entities.md`/DEC-195 sem definição; adotada a trava consultiva por processo tomada por outra operação (RN-WF2-50b) — **dúvida de produto/arquitetura**: confirmar o que é a "trava de edição".
  - O catálogo dos códigos `MIGRATION_*` (além dos três de POL-21), o objeto `blockers[]`/`canExecute`/`decisionsPending` e `effectPreview` não constam das fontes; WF-31..WF-34 são definições desta story.
  - Quais itens aceitam decisão (NEEDS_DECISION e exclusão/restauração de AUTOMATIC) e o intervalo da justificativa (20–1.000; `entities.md` só fixa o mínimo de 20) são decisões desta story.
  - `PARALLEL_ACTIVE`: `entities.md` tem um único `targetStageKey` por item; a escolha da etapa representativa (menor `dueAt`) para preservar unidade/responsável/prazo é decisão desta story — **dúvida de produto**.
  - **Decisão em lote** (aplicar a mesma decisão a todos os itens com a mesma razão e etapa) não consta de nenhuma fonte; recomendável quando houver centenas de `NEEDS_DECISION` — sugerir como P1 para o card 9.
  - Limite de 2.000 processos por plano e simulação síncrona não constam das fontes (lacuna L-2 da US-126); se o teste de performance falhar, a simulação passa a assíncrona (critério de revisão).
  - Se as decisões humanas devem sobreviver a alterações do mapa (hoje são descartadas — US-126 RN-WF2-45) é **dúvida de produto**.

## Impacto técnico
- **Determinismo:** a classificação é uma função pura do estado lido; o `simulationHash` precisa ser reprodutível (JSON canônico RFC 8785, ordenação estável). Mudança no algoritmo exige versão do classificador gravada em `metadata` da auditoria.
- **Performance:** 2.000 processos × (leitura + avaliação de regras): cache por (etapa de destino, regra), leitura em lotes de 100 em `REPEATABLE READ READ ONLY`, concorrência limitada; meta p95 ≤ 20 s para 2.000 processos (escrita como teste de performance, medida no endurecimento). Se ultrapassar o limite de requisição, virar assíncrona (revisão do ADR-016).
- **Efeito zero:** nenhuma escrita em tabelas de processo; teste de não-efeito automatizado; a tentativa de trava consultiva não espera (`pg_try_advisory_xact_lock`).
- **Segurança:** MFA sempre; sem valores sigilosos; justificativa auditada (texto livre — orientação na UI para não incluir dados pessoais).
- **Compatibilidade:** endpoints novos; sem mudança nos contratos do MVP 1; processos de rascunho e de outros workflows nunca entram.

## Backend
- **Módulo(s):** `process` (plano, itens, simulação), `workflow` (fachada de definição e avaliação de regras), `approval` (leitura de aprovação pendente e compatibilidade), `access` (visibilidade), `audit`.
- **Casos de uso:** `SimulateWorkflowMigrationCommand`, `ListMigrationItemsQuery`, `GetMigrationItemQuery` (com `effectPreview`), `DecideMigrationItemCommand`.
- **Domínio:** `MigrationClassifier` (precedência BLOCKED → razões → AUTOMATIC/NEEDS_DECISION), `ApprovalCompatibilityPolicy`, `NewBlockingRulesEvaluator` (regras sem equivalente na origem), `RepresentativeStageSelector` (paralelismo), `SimulationHasher` (RFC 8785 + SHA-256), `MigrationReadiness`.
- **Integrações internas:** `WorkflowRuleEvaluator`/`RuleContextProvider` por módulo (v1 e v2), `approval` (linhas e política), `process` (leitura), `organization`, `platform` (idempotência, MFA).
- **Transação:** leitura em transação `READ ONLY` consistente; escrita única de itens + plano (status, hash, totals, `simulatedAt/By`) + auditoria + outbox; decisão = item + auditoria numa transação com `If-Match`.

## Frontend
- **Tela(s):** SCR-118 (`/admin/workflows/[id]/migracoes/[migrationId]`) — fases **Simulação** e **Decisões**.
- **Componentes:** `SimulationSummaryCards` (automáticos, decisão, bloqueados), `MigrationItemsTable` (até 6 colunas: processo, etapa atual → destino proposto, classificação com `ClassificationChip`, motivos em tooltip, decisão, ⋯), `ItemFiltersPopover`, `ItemDecisionDrawer` (razões, `EffectPreview`, `Select` de destino, textarea da justificativa com contador, "Migrar"/"Excluir da migração", "Próximo pendente"), `ReadinessBanner` ("Faltam N decisões" / "Pronto para executar"), `ResimulateConfirmDialog`.
- **Estados:** loading (skeleton nos cartões e na tabela), vazio ("Nenhum processo precisa da sua decisão"), erro por bloco com "Tentar novamente", sucesso (toasts "Simulação concluída: N processos"), conflito (`ConflictDialog`), leitura para quem só tem `WORKFLOW_VIEW`, simulação em andamento (indicador de progresso e botão desabilitado).
- **Acessibilidade e responsividade:** chips com ícone e texto (não só cor); gaveta com foco preso e retorno ao item; resultado da simulação anunciado por `aria-live`; contador da justificativa lido por leitor de tela; navegação por teclado entre itens pendentes; abaixo de 768 px a tabela vira cartões e a gaveta vira tela cheia.

## Banco de dados
- **Tabelas:** `workflow_migrations` (atualiza `status`, `simulated_at/by`, `simulation_hash`, `totals`), `workflow_migration_items` (nova — `entities.md` §4.7).
- **Migrações:** expand — tabela e enums criados na US-126; esta story só usa; `classification_reasons` jsonb com validação de códigos.
- **Índices/constraints relevantes:** `unique (tenant_id, migration_id, process_id)`; índices `(tenant_id, process_id, result)` e `(tenant_id, migration_id, classification, result)`; checks: `classification <> 'BLOCKED' OR decision = 'EXCLUDE'`, `decision <> 'MIGRATE' OR classification = 'AUTOMATIC' OR (target_stage_key IS NOT NULL AND decision_justification IS NOT NULL)`, `result <> 'MIGRATED' OR movement_id IS NOT NULL`; FK `ON DELETE CASCADE` do plano em `DRAFT`; RLS por `tenant_id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-31 | POST | `/workflows/{id}/migrations/{migrationId}/simulate` | `{ confirmDiscardDecisions? }`; `Idempotency-Key` e `If-Match` obrigatórios | `200 { data: WorkflowMigration }` (`status = SIMULATED`, `totals`, `simulationHash`, `decisionsPending`, `canExecute`, `blockers[]`) | 200, 403, 404, 409 (`MIGRATION_NOT_EDITABLE`), 412, 422 (`MIGRATION_NO_PROCESSES`, `MIGRATION_TOO_MANY_PROCESSES`, `MIGRATION_DISCARD_NOT_CONFIRMED`), 428, 503 |
| WF-32 | GET | `/workflows/{id}/migrations/{migrationId}/items` | query `classification?`, `decision?`, `result?`, `reason?`, `stageKey?`, `q?`, `page`, `pageSize` (≤ 100), `sort` | `200 { data: MigrationItem[], meta: { page, pageSize, totalItems, totalPages, byClassification{}, byDecision{} } }` sem valores monetários | 200, 403, 404, 422 |
| WF-33 | GET | `/workflows/{id}/migrations/{migrationId}/items/{itemId}` | — | `200 { data: MigrationItem }` com `reasons[]` detalhadas, `effectPreview`, regras novas violadas, `ETag` = `version` do item | 200, 403, 404 |
| WF-34 | PUT | `/workflows/{id}/migrations/{migrationId}/items/{itemId}/decision` | `{ decision: 'MIGRATE'\|'EXCLUDE', targetStageKey?, justification? }`; `If-Match` obrigatório | `200 { data: MigrationItem }` + nova `ETag`; plano com `decisionsPending` atualizado em `meta` | 200, 403, 404, 409 (`MIGRATION_NOT_SIMULATED`), 412, 422 (`MIGRATION_ITEM_BLOCKED`, `MIGRATION_TARGET_*`, `VALIDATION_ERROR`), 428 |

## Logs
- `info` `workflow_migration.simulated` com `migrationId`, `processes`, `automatic`, `needsDecision`, `blocked`, `durationMs`, `classifierVersion`.
- `info` `workflow_migration.item_decided` com `migrationId`, `itemId`, `decision`, `classification` (sem justificativa).
- `warn` `workflow_migration.rule_evaluation_failed` com `migrationId`, `ruleId`, `module` (causa do fail-closed).
- `warn` `workflow_migration.simulation_slow` quando passar de 15 s, com `processes`.
- `error` `workflow_migration.simulation_failed` com `correlationId` e causa técnica.
- Nunca logar: justificativa, títulos de processos, valores estimados (POL-09), lista de ids de processo (apenas contagens).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow_migration.simulate` | `CONFIGURATION` | WF-31 | `metadata`: `migrationId`, `simulationHash`, `totals`, `processes`, `classifierVersion`, `discardedDecisions` |
| `workflow_migration.decide_item` | `CONFIGURATION` | WF-34 | `changes`: `decision`, `targetStageKey`, `decisionJustification`; `metadata`: `migrationId`, `itemId`, `processId`, `classification` |
| `access.denied` | `ACCESS` | 403 | permissão exigida e rota |

## Testes necessários
- **Unitários:** `MigrationClassifier` (tabela de verdade: cada razão isolada, combinações, precedência de `BLOCKED`, regra fail-closed), `ApprovalCompatibilityPolicy` (ANY/ALL/SEQUENTIAL, votos perdidos), `NewBlockingRulesEvaluator` (regra equivalente × nova), `RepresentativeStageSelector` (empate), `SimulationHasher` (estabilidade, ordenação, decisões fora do hash), `MigrationReadiness`.
- **Integração (Testcontainers):** simulação com 5 tipos de processo (automático, removido, tipo diferente, aprovação incompatível, paralelismo, bloqueado), teste de **não-efeito** (snapshot das tabelas de processo e aprovação antes/depois), constraints de item, `ON DELETE CASCADE` ao voltar a `DRAFT`, `EDIT_LOCK` com trava tomada por outra conexão, `MIGRATION_IN_PROGRESS` com outro plano `RUNNING`.
- **API/contrato:** WF-31..WF-34 contra o OpenAPI; erros `MIGRATION_*`; ausência de valores monetários; `Idempotency-Key`, `If-Match`.
- **RBAC e multi-tenant:** `WORKFLOW_MIGRATE` × `WORKFLOW_VIEW`, MFA sempre, visibilidade dos processos incluídos; arquivo novo na suíte `test/tenant-leak` (simular, listar, ver e decidir itens entre tenants).
- **Concorrência:** duas decisões do mesmo item (412), simulação com processo tramitado durante a leitura, reenvio idempotente.
- **E2E (Playwright):** simular, ler razões, decidir um item de cada tipo, "Próximo pendente", plano pronto; leitura por perfil auditor; re-simulação com descarte confirmado.
- **Acessibilidade/performance:** axe na SCR-118 (Simulação/Decisões); simulação de 2.000 processos dentro da meta (teste de performance, medido no endurecimento); sem N+1.

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
- [ ] Teste de não-efeito da simulação (processos, aprovações, prazos e notificações intactos)
- [ ] Dúvidas de produto (`EDIT_LOCK`, etapa representativa em paralelismo, decisão em lote) respondidas ou registradas no card 9

## Estimativa
**L** — classificador com várias dimensões (etapa, tipo, aprovação, regras novas, paralelismo, bloqueios), hash canônico, avaliação de regras com `RuleContext` de módulos diferentes, prévia de efeito, decisão humana com concorrência e a parte mais rica da SCR-118, tudo exigindo teste de não-efeito e de desempenho.

## Prioridade
**P0** — a simulação obrigatória é a salvaguarda central da DEC-195/ADR-016; sem ela a execução (US-128) não pode existir e os pilotos não migram processos do MVP 1 com segurança.
