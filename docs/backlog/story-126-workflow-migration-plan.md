---
id: US-126
title: "Planejar a migração de processos: mapeamento de etapas e filtro"
epic: EP-021
feature: FT-064
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-045]
modules: [process, workflow, audit]
screens: [SCR-118, SCR-034]
endpoints: [WF-25, WF-26, WF-27, WF-28, WF-29, WF-30]
permissions: [WORKFLOW_MIGRATE, WORKFLOW_VIEW]
events: [WorkflowMigrationCanceled]
---

# US-126 — Planejar a migração de processos: mapeamento de etapas e filtro

## Título
Planejar a migração de processos: mapeamento de etapas e filtro

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO` com `WORKFLOW_MIGRATE`), **quero** criar um plano de migração que define a versão de origem, a versão de destino, o mapeamento entre as etapas das duas versões e o filtro dos processos que quero levar, **para** preparar com segurança a mudança dos processos em andamento para uma nova versão do workflow, sem redigitar nada e sem que a máquina decida por mim.

A story entrega o **plano** (`WorkflowMigration` em `DRAFT`, DEC-195, ADR-016): criação com mapa gerado por `key` + `type`, ajuste manual do mapa e do filtro (`MigrationFilter`), pré-visualização da contagem de processos do filtro, diagnóstico do mapa (etapas sem destino, tipos diferentes), cancelamento do plano e a tela SCR-118 em sua primeira fase. A **simulação** e a decisão humana são da US-127; a **execução** é da US-128. Nada nesta story altera processos: planejar não tem efeito sobre o runtime.

## Contexto
- Pela DEC-014 o processo fixa a `WorkflowVersion` na criação e uma publicação nunca o afeta; no MVP 1 não havia como levar processos em andamento para uma versão nova (DT-02). O MVP 2 publica a v2 do workflow padrão (DEC-196) e cada tenant pode evoluir o seu fluxo; sem migração, processos abertos terminariam na versão antiga. A DEC-195 e o ADR-016 definem a ferramenta: plano, simulação obrigatória, decisão humana nos ambíguos e execução assíncrona auditada.
- `docs/mvp-02/entities.md` §4.7 define `WorkflowMigration` (módulo `process` — a execução escreve no runtime; a definição é lida pela fachada de `workflow`), os checks (`source ≠ target`; `RUNNING` exige `simulatedAt`), a unique de um plano `RUNNING` por versão de origem e a integridade (origem e destino do **mesmo** `Workflow`, exceto v1 → v2 do padrão por `seedKey`). §7.4 define `StageMapping` e `MigrationFilter`; §6.8 define o ciclo `DRAFT → SIMULATED → RUNNING → COMPLETED`/`CANCELED`.
- `permissions.md` define `WORKFLOW_MIGRATE` (risco `H`, "criar, simular, decidir e executar") e a POL-21 (MFA sempre; processos fora da visibilidade de quem executa não entram no filtro; o administrador vê todos por `TENANT`).
- O roadmap §4.2 ("contorno configurável") prevê que tenants que registraram dotação, parecer ou manifestação como **etapas `TASK` genéricas** em versões próprias do MVP 1 precisarão considerá-las no plano de migração: o mapa permite apontar essas etapas para as etapas dos módulos novos (ex.: `TASK` "DOTACAO_MANUAL" → `DOTACAO`) e a simulação marca `STAGE_TYPE_CHANGED` quando o tipo mudar. Os documentos de texto livre continuam como histórico e não são convertidos.
- A US-131 (processos `COMPLETED` na v1 do padrão) reutiliza este plano com o status `COMPLETED` no filtro; nesta story esse valor é recusado (RN-WF2-44).

## Objetivo
Permitir que o administrador crie, em até cinco minutos e sem tocar em nenhum processo, um plano de migração com mapa de etapas revisado e filtro conferido por contagem, deixando-o pronto para simular, com 100% das criações e alterações do plano auditadas e sujeitas a MFA.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`) com `WORKFLOW_MIGRATE`.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), que informa os critérios do mapa e do filtro em conjunto com o administrador; Auditor (`AUDITOR`) e perfis com `WORKFLOW_VIEW`, que consultam planos (somente leitura).

## Pré-condições
- Usuário autenticado no tenant, vínculo ativo, `WORKFLOW_MIGRATE` e **MFA válido na sessão** (POL-21).
- Existe ao menos uma versão de origem (`PUBLISHED` ou `RETIRED`, com processos nela) e uma versão de destino `PUBLISHED`, ambas do mesmo workflow (RN-WF2-39).
- A versão de destino foi publicada e validada (US-045): publicar uma versão nunca migra nada (DEC-195).

## Fluxo principal
1. Em SCR-034, aba **Versões**, o administrador aciona "Migrar processos" na versão de origem desejada (ou abre `/admin/workflows/[id]/migracoes` e escolhe "Novo plano"). O front abre o assistente da SCR-118.
2. Informa o nome do plano, confere a **origem**, escolhe a **versão de destino** (lista de versões `PUBLISHED` do workflow; a mais nova vem pré-selecionada) e confirma. O front chama WF-25 (`Idempotency-Key`).
3. A API valida permissão, MFA e versões (RN-WF2-39/40), **gera o mapa** de etapas por `key` + `type` (RN-WF2-41), cria o `WorkflowMigration` em `DRAFT` com `processFilter = {}` e responde 201 com o plano e o **diagnóstico do mapa** (etapas de origem sem destino, etapas de destino sem origem, correspondências de tipo diferente). O plano aparece com o chip "Rascunho".
4. Na tabela `StageMappingTable`, cada etapa de origem aparece com a etapa de destino sugerida e a origem do vínculo ("Automático"/"Manual"). O administrador completa ou corrige o mapa escolhendo etapas de destino (apenas `TASK`/`APPROVAL` do destino) ou "Sem destino (decidir caso a caso)"; o front envia WF-28 (`If-Match`).
5. Em "Quais processos", define o filtro: situações (`IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED`), etapas de origem, secretarias solicitantes, intervalo de abertura e/ou lista de até 1.000 ids de processo. Cada alteração é salva por WF-28.
6. O cartão `FilterPreviewCard` chama WF-29 e mostra: processos que casam com o filtro, por situação e por etapa, quantos estão em etapa **sem destino**, quantos estão em **ramificação** (`PARALLEL_ACTIVE` na simulação) e o aviso do limite do plano.
7. A cada salvamento, a API recalcula o diagnóstico, audita `workflow_migration.update` e devolve o plano com nova `ETag`; o administrador pode "Gerar o mapa de novo" (descarta os vínculos manuais, após confirmação).
8. Com mapa e filtro conferidos, o plano está **pronto para simular** (botão "Simular migração" da US-127, habilitado quando há ao menos um processo no filtro e o plano está em `DRAFT`).
9. Para desistir, "Cancelar plano" (WF-30, motivo opcional) leva o plano a `CANCELED`, audita `workflow_migration.cancel` e emite `WorkflowMigrationCanceled`.

## Fluxos alternativos
- **FA-01 — Mapa incompleto:** etapas de origem sem destino são permitidas; o diagnóstico alerta "N etapas sem destino — os processos nelas exigirão decisão" (viram `NEEDS_DECISION` na simulação). Não bloqueia salvar nem simular.
- **FA-02 — Tipo diferente por escolha manual:** mapear uma etapa `TASK` para uma `APPROVAL` (ou o contrário) é aceito e marcado "Tipo diferente"; os processos nessa etapa serão `NEEDS_DECISION` (`STAGE_TYPE_CHANGED`).
- **FA-03 — Contorno do MVP 1:** o administrador mapeia a etapa `TASK` provisória "DOTACAO_MANUAL" para `DOTACAO` da v2; o tipo coincide (`TASK` → `TASK`), mas a `key` não: o vínculo é **manual** e fica registrado como tal.
- **FA-04 — Migração de volta:** destino de número menor que a origem é permitido desde que esteja `PUBLISHED` (voltar exige outra migração — ADR-016); como uma versão aposentada não volta a `PUBLISHED`, o caminho prático é criar um novo rascunho copiando a versão desejada e publicá-lo antes (US-043/US-045).
- **FA-05 — Alterar plano já simulado:** editar mapa ou filtro de um plano `SIMULATED` o devolve a `DRAFT`, descarta classificações e decisões e exige nova simulação (RN-WF2-45); o front pede confirmação explícita antes de enviar.
- **FA-06 — Filtro por ids:** colar mais de 1.000 ids ou ids de processos que não estão na versão de origem é recusado com a lista dos problemas; ids fora da visibilidade de quem planeja são ignorados com aviso (POL-21).
- **FA-07 — Filtro vazio:** sem filtro, valem todas as situações permitidas (`IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED`) de todos os processos na versão de origem.
- **FA-08 — Sem versão de destino:** se o workflow não tem versão `PUBLISHED` além da origem, "Migrar processos" mostra "Publique a nova versão antes de planejar a migração" com atalho para SCR-034.
- **FA-09 — Plano abandonado:** planos `DRAFT` sem uso continuam listados; não há expiração automática no MVP 2.

## Regras de negócio
- **RN-WF2-39** — Criar plano exige `WORKFLOW_MIGRATE` e MFA na sessão (POL-21, DEC-195); origem e destino pertencem ao **mesmo** `Workflow` do tenant (exceção da v1 → v2 do padrão pelo mesmo `seedKey`, tratada na US-131); `sourceWorkflowVersionId ≠ targetWorkflowVersionId`; nenhuma migração roda sem pedido humano e **publicar nova versão nunca cria nem executa plano** (DEC-014, DEC-195).
- **RN-WF2-40** — Estado das versões: a origem é `PUBLISHED` ou `RETIRED` (processos permanecem em versões aposentadas — RN-WF-67) e a destino é `PUBLISHED`; versão `DRAFT` não serve de origem nem de destino (`MIGRATION_VERSIONS_INVALID`). O plano grava os ids das versões e nunca muda de versões depois de criado (para outra combinação, cria-se outro plano).
- **RN-WF2-41** — Mapa de etapas (`stageMapping[]`, `StageMapping` de `entities.md` §7.4): na criação, para cada etapa de origem do tipo `TASK` ou `APPROVAL` (inclusive as dentro de ramos), `targetStageKey` = a etapa de destino de **mesma `key` e mesmo `type`**, com `origin = 'AUTO'`; sem correspondência, `targetStageKey = null` (sem destino → `NEEDS_DECISION` na simulação). Etapas `START`, `END`, `PARALLEL_SPLIT` e `PARALLEL_JOIN` não entram no mapa (processos em ramificação são tratados na simulação — US-127). O administrador completa ou corrige o mapa: toda alteração manual grava `origin = 'MANUAL'`.
- **RN-WF2-42** — Validação do mapa: uma entrada por `sourceStageKey` (sem duplicar), `sourceStageKey` existente na versão de origem e do tipo `TASK`/`APPROVAL`; `targetStageKey` nulo ou existente na versão de destino com tipo `TASK`/`APPROVAL` e **fora de ramo paralelo** (destino dentro de ramo não é suportado — `MIGRATION_TARGET_IN_BRANCH`); a mesma etapa de destino pode receber várias de origem. O diagnóstico devolvido calcula `unmappedSourceStages[]` (sem destino), `typeChanged[]` (origem e destino de tipos diferentes) e `targetStagesWithoutSource[]` (informativo).
- **RN-WF2-43** — Filtro (`processFilter`, `MigrationFilter`): `statuses` ⊆ {`IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED`} (vazio = todos estes); `stageKeys` existentes na origem (casa com processos que tenham **alguma** etapa ativa com a chave); `requestingSecretariatIds` existentes no tenant; `openedFrom` ≤ `openedTo` (datas no fuso do tenant); `processIds` até **1.000** ids únicos de processos que estejam na versão de origem; critérios distintos combinam por **E**, valores do mesmo critério por **OU**, exceto `processIds` explícitos, que **prevalecem** sobre `statuses` (um processo citado entra mesmo em situação final e aparece na simulação como `BLOCKED`, para que o administrador veja por que ele não migra). Processos em `DRAFT` nunca entram (rascunho fica na versão da criação) e só processos visíveis a quem planeja entram (POL-21, DEC-024).
- **RN-WF2-44** — O status `COMPLETED` no filtro só é aceito na continuação v1 → v2 do padrão (US-131); fora dela → `MIGRATION_COMPLETED_NOT_ALLOWED` (422). `CANCELED` e `PUBLISHED` não são valores aceitos em `statuses`; um processo nesses status (ou `COMPLETED` fora da continuação) só entra se citado em `processIds` e é classificado `BLOCKED` (`FINAL_STATUS`) na simulação.
- **RN-WF2-45** — Edição (WF-28) só em plano `DRAFT` ou `SIMULATED` (`MIGRATION_NOT_EDITABLE` nos demais); exige `If-Match` com a `version` do plano; alterar `stageMapping`, `processFilter` ou pedir a regeneração do mapa em plano `SIMULATED` o devolve a `DRAFT`, zera `simulatedAt`/`simulatedById`/`simulationHash`/`totals` e remove os `WorkflowMigrationItem` (e as decisões humanas já registradas) — o front exige `confirmDiscardSimulation: true` quando o plano está `SIMULATED` (`MIGRATION_DISCARD_NOT_CONFIRMED`). Alterar só o `name` não invalida a simulação.
- **RN-WF2-46** — Pré-visualização (WF-29): calcula, sem gravar, a contagem de processos do filtro **atual do plano**, por situação e por etapa ativa, `withoutTarget` (processos em etapa sem destino), `inParallel` (processos com ramos ativos), `visibleOnly = true` e `overLimit`/`limit` (limite de processos por plano, proposto em 2.000 — lacuna L-2 — aplicado na simulação da US-127); nenhum dado individual de processo é devolvido (apenas contagens), nenhum valor de orçamento.
- **RN-WF2-47** — Cancelar (WF-30) só em plano `DRAFT` ou `SIMULATED` (`MIGRATION_NOT_CANCELABLE` nos demais); registra `canceledAt`, `canceledById`, `cancellationReason` (opcional, até 500 caracteres), remove os itens, audita `workflow_migration.cancel` e emite `WorkflowMigrationCanceled` (`hasReason`); plano `CANCELED` é imutável e fica no histórico; reenviar o cancelamento é idempotente por `Idempotency-Key` e, sem ela, responde 409 `INVALID_STATE`.
- **RN-WF2-48** — Leitura e visibilidade: listar e ver planos exige `WORKFLOW_VIEW`; o plano expõe apenas ids, nomes de versões/etapas, mapa, filtro e contagens (sem dados de processos individuais, que só aparecem nos itens da simulação — US-127); toda criação, edição e cancelamento é auditado (`workflow_migration.create`/`update`/`cancel`, categoria `CONFIGURATION`); a SCR-118 só é exibida a quem tem `WORKFLOW_VIEW` e as ações de escrita a quem tem `WORKFLOW_MIGRATE` com MFA.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome do plano | `name` | texto | Sim | 3–150 caracteres | "Migração v{origem} → v{destino}" |
| Versão de origem | `sourceWorkflowVersionId` | uuid | Sim | `PUBLISHED`/`RETIRED` do workflow `{id}` | versão em que se clicou "Migrar processos" |
| Versão de destino | `targetWorkflowVersionId` | uuid | Sim | `PUBLISHED`, mesmo workflow, ≠ origem | versão publicada mais recente |
| Mapa de etapas | `stageMapping[]` | lista `{ sourceStageKey, targetStageKey\|null, origin }` | Sim (gerado) | RN-WF2-41/42; `origin` `AUTO`/`MANUAL` | gerado por `key` + `type` |
| Regenerar o mapa | `regenerateMapping` | boolean | Não | Descarta vínculos manuais | `false` |
| Situações | `processFilter.statuses[]` | lista | Não | RN-WF2-43/44 | todas as permitidas |
| Etapas de origem | `processFilter.stageKeys[]` | lista de `key` | Não | existentes na origem | vazio |
| Secretarias solicitantes | `processFilter.requestingSecretariatIds[]` | lista de uuid | Não | existentes no tenant | vazio |
| Aberto de / até | `processFilter.openedFrom` / `openedTo` | datas | Não | `openedFrom ≤ openedTo` | vazio |
| Ids de processo | `processFilter.processIds[]` | lista de uuid | Não | ≤ 1.000, únicos, na versão de origem | vazio |
| Confirmo descartar a simulação | `confirmDiscardSimulation` | boolean | Condicional | obrigatório ao editar plano `SIMULATED` | `false` |
| Motivo do cancelamento | `reason` | texto | Não | ≤ 500 | — |
| *(sistema)* Situação do plano | `status` | `WorkflowMigrationStatus` | — | `DRAFT` na criação | sistema |
| *(sistema)* Diagnóstico do mapa | `mappingDiagnostics` | objeto | — | `unmappedSourceStages[]`, `typeChanged[]`, `targetStagesWithoutSource[]` | calculado |
| *(sistema)* Totais | `totals` | objeto | — | `{}` até a simulação | sistema |
| *(sistema)* Versão do registro | `version` | int | — | `ETag`/`If-Match` | sistema |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `name` fora de 3–150 | Front + API (Zod) | "Informe um nome de 3 a 150 caracteres." | `VALIDATION_ERROR` |
| V-02 | Origem = destino, destino não `PUBLISHED`, origem `DRAFT` ou versões de workflows diferentes | Front + API | "Escolha duas versões publicadas do mesmo workflow, uma diferente da outra." | `MIGRATION_VERSIONS_INVALID` |
| V-03 | `sourceStageKey` duplicado, inexistente ou de tipo `START`/`END`/split/join | API | "A etapa \"{etapa}\" não pode ser mapeada." | `MIGRATION_MAPPING_INVALID` |
| V-04 | `targetStageKey` inexistente no destino, de tipo não permitido ou dentro de ramo paralelo | API | "A etapa de destino \"{etapa}\" não aceita processos migrados." | `MIGRATION_MAPPING_INVALID` / `MIGRATION_TARGET_IN_BRANCH` |
| V-05 | `statuses` com valor não permitido (`DRAFT`, `CANCELED`, `PUBLISHED`) | Front + API | "Escolha apenas situações de processos em andamento." | `MIGRATION_FILTER_INVALID` |
| V-06 | `COMPLETED` no filtro fora da continuação v1 → v2 | API | "Processos concluídos só podem ser levados à fase preparatória pela migração própria dessa continuação." | `MIGRATION_COMPLETED_NOT_ALLOWED` |
| V-07 | `stageKeys`/`requestingSecretariatIds` inexistentes | API | "Alguns itens do filtro não existem: {lista}." | `MIGRATION_FILTER_INVALID` |
| V-08 | `openedFrom` posterior a `openedTo` | Front + API | "A data inicial não pode ser depois da final." | `MIGRATION_FILTER_INVALID` |
| V-09 | `processIds` com mais de 1.000, repetidos ou fora da versão de origem | Front + API | "Informe até 1.000 processos da versão de origem, sem repetir. Revise: {lista}." | `MIGRATION_FILTER_INVALID` |
| V-10 | Plano não está em `DRAFT`/`SIMULATED` (edição ou cancelamento) | API | "Este plano não pode mais ser alterado." | `MIGRATION_NOT_EDITABLE` / `MIGRATION_NOT_CANCELABLE` |
| V-11 | Editar plano `SIMULATED` sem confirmar o descarte | Front + API | "Alterar o plano apaga a simulação e as decisões já tomadas. Confirme para continuar." | `MIGRATION_DISCARD_NOT_CONFIRMED` |
| V-12 | `If-Match` ausente/divergente | API | "O plano foi alterado por outra pessoa. Recarregue e tente de novo." | `PRECONDITION_REQUIRED` (428) / `VERSION_CONFLICT` (412) |
| V-13 | Sessão sem MFA | API | "Confirme sua identidade com o segundo fator para migrar processos." | `MFA_REQUIRED` |
| V-14 | `reason` acima de 500 caracteres | Front + API | "O motivo pode ter até 500 caracteres." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `WORKFLOW_MIGRATE` para criar, editar e cancelar planos (WF-25, WF-28, WF-30); `WORKFLOW_VIEW` para listar, ver e pré-visualizar (WF-26, WF-27, WF-29). Escopo de tenant (permissão não escopável).
- **Políticas:** POL-21 (migração de versão de workflow: MFA sempre; processos fora da visibilidade de quem planeja não entram no filtro); DEC-024 (visibilidade).
- **MFA:** **sempre** em `WORKFLOW_MIGRATE` (risco `H`, POL-21), independentemente de `security.mfaPolicy`; sem MFA → 403 `MFA_REQUIRED` com fluxo de step-up.
- **Sem permissão:** o botão "Migrar processos" e a SCR-118 em modo escrita não aparecem sem `WORKFLOW_MIGRATE`; quem só tem `WORKFLOW_VIEW` vê planos em leitura; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowMigrationCanceled` | `workflow_migration.canceled` | Cancelamento do plano (WF-30) | `migrationId`, `hasReason`; sem texto do motivo; consumido pelo `AnalyticsProjector` |

Criar e editar o plano não geram evento de domínio (só auditoria), em linha com `events.md` §4 (não há evento de criação).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: planejar não notifica ninguém. A notificação `WORKFLOW_MIGRATION_FINISHED` é do fim da execução (US-128). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Planejar a migração de processos

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (com "WORKFLOW_MIGRATE") e MFA válido na sessão
    And o workflow "LICITACAO_PADRAO" tem a versão 1 "RETIRED" com 38 processos em andamento e a versão 2 "PUBLISHED"
    And as versões têm as etapas "ESTUDOS_PRELIMINARES", "PESQUISA_PRECOS", "TERMO_REFERENCIA" e "APROVACAO_AUTORIDADE" nas duas, e a versão 2 tem também "DOTACAO" e "JURIDICO"
    And a versão 1 tem a etapa "PARECER_MANUAL" do tipo "TASK" (contorno do MVP 1)

  Scenario: [Sucesso] Criar o plano gera o mapa por chave e tipo
    When "Marina" criar o plano "Migração v1 → v2" com origem na versão 1 e destino na versão 2
    Then a API deve responder 201 com status "DRAFT" e "processFilter" vazio
    And o mapa deve ter "ESTUDOS_PRELIMINARES", "PESQUISA_PRECOS", "TERMO_REFERENCIA" e "APROVACAO_AUTORIDADE" com "origin" "AUTO"
    And "PARECER_MANUAL" deve ter "targetStageKey" nulo e constar em "unmappedSourceStages"
    And deve gerar registro de auditoria "workflow_migration.create"
    And nenhum processo deve ser alterado

  Scenario: [Sucesso] Completar o mapa, filtrar e pré-visualizar
    Given que o plano "Migração v1 → v2" está em "DRAFT"
    When "Marina" mapear "PARECER_MANUAL" para "JURIDICO" e definir o filtro com "statuses" ["IN_PROGRESS", "RETURNED"] e "stageKeys" ["TERMO_REFERENCIA", "PARECER_MANUAL"]
    Then o mapa deve ter "PARECER_MANUAL" → "JURIDICO" com "origin" "MANUAL"
    And a pré-visualização deve devolver apenas contagens por situação e por etapa, com "visibleOnly" verdadeiro
    And deve gerar registro de auditoria "workflow_migration.update"

  Scenario: [Sucesso] Cancelar o plano
    When "Marina" cancelar o plano com o motivo "Aguardando ajuste da versão 2"
    Then o plano deve ficar "CANCELED" com "canceledById" de "Marina"
    And deve gerar registro de auditoria "workflow_migration.cancel"
    And deve gerar o evento WorkflowMigrationCanceled com "hasReason" verdadeiro e sem o texto do motivo

  Scenario: [Validação] Versões inválidas e mapa inválido
    When "Marina" criar um plano com origem e destino na versão 2
    Then a API deve responder 422 com código "MIGRATION_VERSIONS_INVALID"
    When "Marina" mapear "PESQUISA_PRECOS" para uma etapa "FIM" do tipo "END"
    Then a API deve responder 422 com código "MIGRATION_MAPPING_INVALID"
    And nenhum dado do plano deve ser alterado

  Scenario: [Validação] Filtro inválido
    When "Marina" enviar o filtro com "statuses" contendo "COMPLETED" na migração v1 → v2 comum
    Then a API deve responder 422 com código "MIGRATION_COMPLETED_NOT_ALLOWED"
    When "Marina" enviar 1.001 ids em "processIds"
    Then a API deve responder 422 com código "MIGRATION_FILTER_INVALID" listando o excesso

  Scenario: [Validação] Editar plano simulado exige confirmar o descarte
    Given que o plano está "SIMULATED" com 3 itens decididos
    When "Marina" alterar o mapa sem "confirmDiscardSimulation"
    Then a API deve responder 422 com código "MIGRATION_DISCARD_NOT_CONFIRMED"
    When "Marina" repetir com "confirmDiscardSimulation" verdadeiro
    Then o plano deve voltar a "DRAFT", sem itens nem "simulationHash"

  Scenario: [Permissão] Sem WORKFLOW_MIGRATE ou sem MFA
    Given que "Bruno" tem apenas "WORKFLOW_VIEW"
    When "Bruno" criar um plano
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Bruno" listar os planos
    Then a API deve responder 200
    Given que "Marina" está com a sessão sem MFA
    When "Marina" criar um plano
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Versão ou plano de outro tenant
    Given que existe o plano "Migração B" e a versão "Prefeitura B / v3"
    When "Marina", no tenant "Prefeitura A", criar um plano usando a versão "Prefeitura B / v3" ou consultar o plano "Migração B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio da criação do plano
    Given que "Marina" criou o plano com a "Idempotency-Key" "P-01" e recebeu 201
    When a mesma requisição for reenviada
    Then a API deve responder 201 com "Idempotent-Replayed" verdadeiro e o mesmo plano
    And deve existir um único plano e uma única auditoria "workflow_migration.create"
    When "Marina" reenviar o cancelamento de um plano já cancelado sem chave de idempotência
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Concorrência] Duas edições do mesmo plano
    Given que "Marina" e "Paulo" (também administrador) carregaram o plano com a mesma "ETag"
    When "Marina" salvar o filtro e depois "Paulo" salvar o mapa com a "ETag" antiga
    Then a segunda chamada deve responder 412 com código "VERSION_CONFLICT"
    And nenhum dos dois deve perder o que já foi salvo sem aviso

  Scenario: [Concorrência] Edição concorrente com o cancelamento
    Given que "Marina" cancela o plano no mesmo instante em que "Paulo" edita o filtro
    When as duas requisições forem processadas
    Then uma deve vencer e a outra deve responder 409 com código "MIGRATION_NOT_EDITABLE" ou 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível na criação
    Given que o banco de dados está indisponível
    When "Marina" criar o plano
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum plano nem auditoria devem ter sido gravados

  Scenario: [Falha de integração] Authentik indisponível ao validar o MFA
    Given que o Authentik está indisponível no momento da verificação de MFA
    When "Marina" criar o plano
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e a mensagem de tentar novamente
    And nenhum plano deve ser criado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Versões inválidas | 422 | `MIGRATION_VERSIONS_INVALID` | "Escolha duas versões publicadas do mesmo workflow, uma diferente da outra." | Erro no seletor de destino |
| Mapa inválido | 422 | `MIGRATION_MAPPING_INVALID` (com `errors[]` por etapa) | "A etapa \"{etapa}\" não pode ser mapeada." | Realça a linha do mapa |
| Destino dentro de ramo | 422 | `MIGRATION_TARGET_IN_BRANCH` | "Ainda não é possível migrar para uma etapa dentro de uma ramificação. Escolha uma etapa fora dos ramos." | Opção desabilitada com tooltip |
| Filtro inválido | 422 | `MIGRATION_FILTER_INVALID` (com `errors[]`) | "Revise o filtro: {detalhe}." | Erro por campo do filtro |
| `COMPLETED` fora da continuação | 422 | `MIGRATION_COMPLETED_NOT_ALLOWED` | "Processos concluídos só entram pela migração própria da fase preparatória." | Opção ocultada |
| Plano não editável | 409 | `MIGRATION_NOT_EDITABLE` | "Este plano não pode mais ser alterado." | Plano em leitura |
| Plano não cancelável | 409 | `MIGRATION_NOT_CANCELABLE` | "Este plano não pode mais ser cancelado." | Botão ocultado |
| Descarte da simulação não confirmado | 422 | `MIGRATION_DISCARD_NOT_CONFIRMED` | "Alterar o plano apaga a simulação e as decisões já tomadas. Confirme para continuar." | Diálogo de confirmação |
| Estado incompatível (reenvio do cancelamento) | 409 | `INVALID_STATE` | "O plano já está cancelado." | Atualiza o plano |
| `If-Match` divergente/ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "O plano foi alterado por outra pessoa. Recarregue e tente de novo." | `ConflictDialog` |
| Corpo diferente com a mesma chave | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta requisição já foi usada com outros dados." | Gera nova chave |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para migrar processos." | Ações ocultas |
| MFA ausente | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para migrar processos." | Fluxo de step-up |
| Plano/versão inexistente/outro tenant | 404 | `NOT_FOUND` | "Plano não encontrado." | Volta para a lista |
| Banco/Authentik indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Toast com `correlationId` e "Tentar novamente" |

## Dependências
- **Stories:** US-045 (versões publicadas e aposentadas), US-040/US-043 (definição de etapas). Habilita US-127 (simulação e decisões), US-128 (execução) e US-131 (continuação v1 → v2). US-123/US-124 influenciam o mapa (etapas de ramo) mas não bloqueiam esta story.
- **Decisões/ADRs:** DEC-195, DEC-014, DEC-196, DEC-024, DEC-194; [ADR-016](../adr/adr-016-workflow-version-migration.md); `entities.md` §4.7, §6.8, §7.4; POL-21.
- **Configurações:** nenhuma chave nova; `security.mfaPolicy` não se aplica (MFA sempre — POL-21).
- **Lacunas nas fontes canônicas:**
  - **L-1:** SCR-118 define a rota `/admin/workflows/[id]/migracoes/[migrationId]`; a **lista de planos** (`/admin/workflows/[id]/migracoes`) usada no fluxo não consta de `features.md` Apêndice A. Proposta: rota própria da lista, ou aba "Migrações" de SCR-034.
  - **L-2:** limite de processos por plano não definido em nenhuma fonte (só `processIds` ≤ 1.000). Proposto: **2.000** por plano (recusa na simulação — US-127), a confirmar com produto e plataforma.
  - **L-3:** `cancellationReason` sem tamanho em `entities.md` (proposto até 500, como `errorMessage`); tamanho de `name` (proposto 3–150).
  - **L-4:** endpoints WF-25..WF-30, códigos `MIGRATION_*` e a opção `confirmDiscardSimulation` não constam do catálogo; as rotas da FT-064 foram seguidas (`/workflows/{id}/migrations…`) e `filter-preview`/`regenerateMapping` são definições desta story.
  - **L-5:** processos `DRAFT` fora do filtro (entities §7.4 só lista situações a partir de `IN_PROGRESS`): a decisão do que acontece com um rascunho encaminhado depois de a nova versão estar publicada (permanece na versão antiga) precisa de confirmação de produto.
  - **L-6:** destino dentro de ramo paralelo não suportado (`MIGRATION_TARGET_IN_BRANCH`) — decisão desta story, a confirmar (ADR-016 só trata ramos de origem).

## Impacto técnico
- **Sem efeito no runtime:** o plano é metadado; nenhuma tabela de processo é escrita. Risco baixo, mas a história define o contrato do mapa e do filtro que a simulação e a execução consomem — mudanças posteriores são incompatíveis; versionar o schema Zod (`stageMappingSchema`, `migrationFilterSchema`).
- **Compatibilidade (DEC-108):** endpoints novos; nada alterado no MVP 1.
- **Banco:** tabela `workflow_migrations` com RLS e as constraints de `entities.md`; `WorkflowMigrationItem` só nasce na simulação (US-127). Unique de plano `RUNNING` por versão de origem é aplicada na execução (US-128).
- **Performance:** WF-29 usa contagens agregadas sobre `processes`/`process_stages` com os índices existentes; alvo p95 baixo em até 20.000 processos do tenant (teste de performance no endurecimento).
- **Segurança:** MFA sempre; sem dados de processo individuais na resposta do plano; auditoria completa.

## Backend
- **Módulo(s):** `process` (dono de `WorkflowMigration`), `workflow` (fachada de definição das versões), `audit`.
- **Casos de uso:** `CreateWorkflowMigrationCommand`, `ListWorkflowMigrationsQuery`, `GetWorkflowMigrationQuery`, `UpdateWorkflowMigrationCommand` (mapa, filtro, nome, regeneração), `PreviewMigrationFilterQuery`, `CancelWorkflowMigrationCommand`.
- **Domínio:** `WorkflowMigration` (estados), `StageMappingBuilder` (key + type), `StageMappingValidator`, `MigrationFilterValidator`/`MigrationFilterSpecification` (consulta de processos visíveis na versão de origem), `MappingDiagnostics`.
- **Integrações internas:** fachada `WorkflowDefinitionReader` (etapas, tipos e `branchKey` da versão), `organization` (secretarias), `access` (visibilidade), `platform` (idempotência, MFA/step-up), `audit`.
- **Transação:** criação = gerar mapa + gravar plano + auditoria; edição = validar + gravar + (se `SIMULATED`) remover itens e limpar a simulação + auditoria; cancelamento = status + remoção de itens + auditoria + outbox.

## Frontend
- **Tela(s):** SCR-118 (`/admin/workflows/[id]/migracoes/[migrationId]`; fase "Plano"); SCR-034 (atalho "Migrar processos" na aba Versões, visível só com `WORKFLOW_MIGRATE`).
- **Componentes:** `MigrationWizardDialog` (nome, origem/destino), `MigrationHeader` (trilha, chips de situação e versões), `MigrationPhaseTabs` (Plano · Simulação · Decisões · Execução — as três últimas habilitadas pelas US-127/US-128), `StageMappingTable` (linha por etapa de origem com `Select` de destino, selo "Automático/Manual/Tipo diferente/Sem destino"), `MappingDiagnosticsAlert`, `ProcessFilterForm` (`Checkbox` de situações, `Combobox` de etapas e secretarias, `DatePicker` de período, `ProcessIdsTextarea` com contador), `FilterPreviewCard`, `DiscardSimulationConfirmDialog`, `CancelMigrationDialog`.
- **Estados:** loading (skeleton por bloco), vazio ("Nenhum plano de migração ainda — planeje a primeira migração"), erro (por bloco com "Tentar novamente"), sucesso (toast "Plano salvo"), conflito (`ConflictDialog`), leitura (plano não editável), sem destino disponível (FA-08).
- **Acessibilidade e responsividade:** tabela de mapeamento navegável por teclado, selos com ícone + texto; erros de campo anunciados por `aria-live`; foco no primeiro erro; abaixo de 768 px a tabela vira lista de cartões e as fases viram `Tabs` roláveis.

## Banco de dados
- **Tabelas:** `workflow_migrations` (nova — `entities.md` §4.7: `name`, `source_workflow_version_id`, `target_workflow_version_id`, `stage_mapping` jsonb, `process_filter` jsonb, `status`, `simulated_at/by`, `simulation_hash`, `started_at/by`, `completed_at`, `canceled_at/by`, `cancellation_reason`, `totals` jsonb); `workflow_migration_items` é criada na mesma migração (usada a partir da US-127).
- **Migrações:** expand — tabelas novas com RLS por `tenant_id`; enums `WorkflowMigrationStatus`, `MigrationClassification`, `MigrationItemDecision`, `MigrationItemResult`; sem backfill.
- **Índices/constraints relevantes:** `unique (tenant_id, source_workflow_version_id) WHERE status='RUNNING'`; check `source ≠ target`; check `status <> 'RUNNING' OR simulated_at IS NOT NULL`; índice `(tenant_id, status, created_at)` para a lista; FK composta das versões com o mesmo `tenant_id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-25 | POST | `/workflows/{id}/migrations` | `{ name, sourceWorkflowVersionId, targetWorkflowVersionId, stageMapping?, processFilter? }`; `Idempotency-Key` obrigatório; sem `stageMapping` o mapa é gerado | `201 { data: WorkflowMigration }` + `Location`, `ETag`; plano com `mappingDiagnostics` | 201, 403 (`PERMISSION_DENIED`, `MFA_REQUIRED`), 404, 422 (`MIGRATION_*`, `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REUSED`), 503 |
| WF-26 | GET | `/workflows/{id}/migrations` | query `status?`, `page`, `pageSize` (≤ 100), `sort` (`-createdAt`) | `200 { data: WorkflowMigration[], meta }` (sem itens) | 200, 403, 404 |
| WF-27 | GET | `/workflows/{id}/migrations/{migrationId}` | — | `200 { data: WorkflowMigration }` com mapa, filtro, `mappingDiagnostics`, `totals`, nomes e números das versões, `ETag` | 200, 403, 404 |
| WF-28 | PATCH | `/workflows/{id}/migrations/{migrationId}` | `{ name?, stageMapping?, processFilter?, regenerateMapping?, confirmDiscardSimulation? }`; `If-Match` obrigatório | `200 { data: WorkflowMigration }` + nova `ETag`; plano `SIMULATED` volta a `DRAFT` | 200, 403, 404, 409 (`MIGRATION_NOT_EDITABLE`), 412, 422, 428 |
| WF-29 | GET | `/workflows/{id}/migrations/{migrationId}/filter-preview` | — | `200 { data: { matchCount, byStatus{}, byStage[{ stageKey, stageName, count, targetStageKey\|null }], withoutTarget, inParallel, limit, overLimit, visibleOnly } }` | 200, 403, 404 |
| WF-30 | POST | `/workflows/{id}/migrations/{migrationId}/cancel` | `{ reason? }`; `If-Match` obrigatório; `Idempotency-Key` opcional | `200 { data: WorkflowMigration }` com `status = CANCELED` | 200, 403, 404, 409 (`MIGRATION_NOT_CANCELABLE`, `INVALID_STATE`), 412, 428 |

## Logs
- `info` `workflow_migration.created` com `migrationId`, `sourceVersion`, `targetVersion`, `mappedStages`, `unmappedStages`.
- `info` `workflow_migration.updated` com `migrationId`, `changed` (`mapping`/`filter`/`name`), `simulationDiscarded`.
- `info` `workflow_migration.canceled` com `migrationId`, `hasReason`.
- `warn` `workflow_migration.filter_over_limit` com `migrationId`, `matchCount`, `limit`.
- `error` `workflow_migration.plan_failed` com `correlationId` e a causa técnica.
- Nunca logar: ids de processo em massa do filtro (só a contagem), o texto de `reason`, tokens e `Idempotency-Key`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow_migration.create` | `CONFIGURATION` | WF-25 | `metadata`: `migrationId`, `sourceWorkflowVersionId`, `targetWorkflowVersionId`, `mappingCount`, `idempotencyKey` |
| `workflow_migration.update` | `CONFIGURATION` | WF-28 | `changes`: campos alterados (`stageMapping`, `processFilter`, `name`); `metadata`: `simulationDiscarded`, `regeneratedMapping` |
| `workflow_migration.cancel` | `CONFIGURATION` | WF-30 | `metadata`: `migrationId`, `hasReason` (texto no `changes`, restrito à auditoria) |
| `access.denied` | `ACCESS` | 403 | permissão exigida e rota |

## Testes necessários
- **Unitários:** `StageMappingBuilder` (key + type, tipos diferentes, etapas de ramo, START/END/split/join fora do mapa), `StageMappingValidator` (duplicidade, tipo, destino em ramo), `MigrationFilterValidator` (statuses, ids, datas, `COMPLETED`), máquina de estados do plano (`DRAFT` ↔ `SIMULATED`, `CANCELED`), diagnóstico do mapa.
- **Integração (Testcontainers):** criação com mapa gerado a partir de duas versões reais, edição que remove itens de um plano `SIMULATED`, constraints do banco (`source ≠ target`, unique `RUNNING`), contagens de WF-29 com visibilidade restrita, RLS.
- **API/contrato:** WF-25..WF-30 contra o OpenAPI; erros `MIGRATION_*`; `Idempotency-Key` e `If-Match`; ausência de dados de processo individuais.
- **RBAC e multi-tenant:** `WORKFLOW_MIGRATE` × `WORKFLOW_VIEW`, MFA sempre, versão/plano de outro tenant → 404; arquivo novo na suíte `test/tenant-leak` (criar/ler/editar/cancelar plano e pré-visualizar entre tenants).
- **Concorrência:** duas edições com a mesma `ETag`, edição × cancelamento, criação idempotente repetida.
- **E2E (Playwright):** assistente de plano, completar o mapa, filtro com contagem, confirmação de descarte, cancelamento; acesso somente leitura de um auditor.
- **Acessibilidade/performance:** axe na SCR-118 (fase Plano); navegação por teclado na tabela de mapa; WF-29 com 20.000 processos (meta p95 escrita como teste de performance, medida no endurecimento).

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
- [ ] Teste garantindo que criar, editar e cancelar um plano nunca altera tabelas de processo
- [ ] Lacunas L-1..L-6 resolvidas ou registradas no card 9 (`api.md`/`screens.md`)

## Estimativa
**M** — CRUD de plano com validações de mapa e filtro, pré-visualização agregada e SCR-118 em sua primeira fase; sem fila, sem efeito no runtime. A complexidade está nas regras de validação e no contrato que as stories seguintes consomem.

## Prioridade
**P0** — primeiro degrau da DT-02: sem plano não há simulação nem execução; é pré-requisito para os pilotos levarem processos do MVP 1 à v2 sem redigitar (DEC-192).
