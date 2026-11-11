---
id: US-197
title: "Roteamento condicional: etapa dispensada e transição condicional"
epic: EP-031
feature: FT-089
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-041, US-047, US-195]
modules: [workflow, process, rules, timeline, access, audit]
screens: [SCR-034, SCR-006]
endpoints: [WF-11, WF-14, WF-20, WF-21, PRC-08, PRC-10, PRC-19, PRC-70, PRC-71, RUL-01]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE, WORKFLOW_PUBLISH, RULE_VIEW, PROCESS_VIEW, PROCESS_FORWARD, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [ProcessStageSkipped, ProcessStageChanged, WorkflowVersionPublished]
---

# US-197 — Roteamento condicional: etapa dispensada e transição condicional

## Título
Roteamento condicional: etapa dispensada e transição condicional

## Descrição
**Como** administrador do órgão, **quero** definir que uma etapa só se aplica quando uma regra da biblioteca for verdadeira e que uma transição só fique disponível quando uma condição for atendida, **para** que processos de baixo valor deixem de passar por etapas que não se aplicam, os de alto valor ganhem mais controle automaticamente e o motivo de cada caminho fique visível a quem acompanha o processo.

A story muda o papel das regras: deixam de apenas **bloquear** a saída (MVP 1) e passam a **decidir o caminho**. Entrega (1) `WorkflowStage.applicabilityRule`: avaliada ao entrar na etapa; falsa dispensa a etapa (`ProcessStageStatus.SKIPPED`, `MovementAction.SKIP`, evento `ProcessStageSkipped`, timeline `STAGE_SKIPPED`, auditoria `process.stage_skip`) e o processo segue para a próxima etapa aplicável; (2) `WorkflowTransition.condition`: a transição só aparece como destino disponível quando verdadeira e o servidor a revalida no encaminhamento; (3) a configuração no editor (SCR-034), as validações de publicação (etapa legalmente obrigatória, rota de dispensa, caminho padrão) e a visibilidade da dispensa no detalhe do processo (SCR-006) e na linha do tempo.

## Contexto
- A DEC-204 e a ADR-015 criam o roteamento por regra: "etapa dispensada automaticamente quando falsa, com registro na timeline — ex.: valor acima de X exige Controle Interno". A dispensa muda o caminho do processo e "precisa ser muito visível para não parecer pulo" (ADR-015, consequências).
- As regras usadas são **sempre da biblioteca** (US-194, `kind = ROUTING`) por versão fixada (US-195): isso garante os casos de teste obrigatórios no roteamento (RN-RULE-12 da feature, US-200). A validação de referência e a matriz de tipos vêm da US-195.
- Não confundir com `Workflow.applicabilityRule` (US-042, MVP 1), que escolhe **qual workflow** vale para um processo novo; aqui a regra decide se **uma etapa** se aplica a um processo que já está no workflow.
- Etapas legalmente obrigatórias (`isLegallyRequired`, semeado `true` em `JURIDICO` da licitação) não aceitam `applicabilityRule` (POL-27, check de banco `NOT is_legally_required OR applicability_rule IS NULL`, entities.md §5.8).
- O encaminhamento (US-047) e o motor (`WorkflowFacade.getAvailableActions`, US-041) são os pontos de extensão. Etapas paralelas (US-123 "Modelar etapas paralelas no workflow (ramificação e junção)" e US-124 "Executar ramos paralelos no processo") convivem com a dispensa: a regra vale dentro de um ramo e `PARALLEL_SPLIT`/`PARALLEL_JOIN` nunca são dispensados.
- Valores de orçamento sigiloso entram na avaliação (a avaliação é do servidor), mas nunca saem em evento, auditoria, timeline ou para quem não tem a permissão de sigilo (POL-09, RN-RULE-15 da feature).

## Objetivo
Dispensar automaticamente 100% das etapas cuja regra de aplicabilidade é falsa na entrada, com registro completo (movimento, evento, timeline, auditoria), zero dispensa de etapa legalmente obrigatória e nenhum processo sem caminho por causa de condição de transição; meta de qualidade: ≥ 95% das etapas dispensadas sem devolução por "pulo indevido".

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `WORKFLOW_MANAGE`, `WORKFLOW_PUBLISH` e `RULE_VIEW`) — configura e publica.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) e responsáveis pelas etapas, que percebem o novo caminho ao encaminhar; Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), que conferem por que uma etapa foi dispensada.

## Pré-condições
- `WorkflowVersion` em `DRAFT` com a etapa/transição alvo (US-043) e regra `ROUTING` publicada, ativa e não-modelo na biblioteca (US-194, US-196); `RuleContext` v2 com os provedores dos namespaces usados (US-129).
- Para configurar: `WORKFLOW_MANAGE` e `RULE_VIEW`; para publicar: `WORKFLOW_PUBLISH`. Para encaminhar: `PROCESS_FORWARD` + POL-01 (inalterado).
- Para ver motivo e valores no processo: `PROCESS_VIEW`; valores sigilosos: `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (POL-09).

## Fluxo principal
1. No editor (SCR-034), o administrador seleciona a etapa `CONTROLE_INTERNO` e, em "Aplicabilidade", escolhe "Só se aplica quando…" e a regra `CI_ACIMA_DE_500K` (modelo `CI_ACIMA_DE_VALOR` copiado com limite de R$ 500.000,00). O front envia WF-11 com `applicabilityRule` em modo `LIBRARY` e `If-Match`.
2. A API valida o tipo (`ROUTING`), a versão `PUBLISHED`, a etapa (não legalmente obrigatória, tipo aceito) e grava; audita `workflow.update`. Etapas com aplicabilidade mostram o selo "Condicional" no diagrama.
3. Para uma transição, o administrador abre "Condição" e escolhe uma regra `ROUTING`; o front envia WF-14. A etapa de origem precisa de um caminho padrão (transição `FORWARD` primária sem condição).
4. Ao validar (WF-20) e publicar (WF-21), o validador confere referências, `isLegallyRequired`, tipos de etapa, rota de dispensa, caminho padrão e o grafo com ramos paralelos; `errors[]` bloqueiam e `warnings[]` não.
5. Em execução, o gestor encaminha o processo `0050/2026` (R$ 120.000,00) de `JURIDICO`. Antes, o modal (PRC-71) mostra "Próximas etapas: `CONTROLE_INTERNO` será dispensada pela regra Controle Interno acima de R$ 500.000,00; segue para `AUTORIZACAO_LICITACAO`".
6. PRC-19 revalida as regras de saída e a transição escolhida, avalia a aplicabilidade da etapa de destino sobre o `RuleContext` v2 do processo naquele instante e, sendo falsa, na mesma transação: registra o movimento `FORWARD` para a etapa e, em seguida, o `SKIP` (com `metadata.skip`); cria a `ProcessStage` `SKIPPED` (já fechada, sem responsável nem prazo, com `skipRuleResult`); segue a transição primária `FORWARD` da etapa dispensada até a primeira etapa aplicável, que fica `ACTIVE` com responsável, SLA e acessos como numa entrada normal.
7. A API grava `ProcessStageSkipped` (e `ProcessStageChanged` da etapa em que o processo realmente chegou) no outbox, projeta `STAGE_SKIPPED` na timeline e audita `process.stage_skip`; responde 200 com `skippedStages[]`.
8. No detalhe do processo (SCR-006), a etapa aparece com a etiqueta "Dispensada por regra" e, na linha do tempo, "Etapa Controle Interno dispensada pela regra CI_ACIMA_DE_500K"; PRC-70 detalha a regra, a versão e os valores lidos (mascarados sem permissão de sigilo).
9. O processo `0051/2026` (R$ 900.000,00) entra em `CONTROLE_INTERNO` normalmente: a regra é verdadeira e a etapa executa.

## Fluxos alternativos
- **FA-01 — Várias etapas dispensadas em sequência:** cada etapa com regra falsa é dispensada em ordem; o processo para na primeira aplicável. O limite de encadeamento é o número de etapas da versão; estourar desfaz tudo (`SKIP_CHAIN_LIMIT`).
- **FA-02 — Transição condicional escondida:** de uma etapa com duas transições `FORWARD`, a de condição falsa não aparece em PRC-08; pedir essa transição em PRC-19 responde 422 `TRANSITION_NOT_AVAILABLE` (`reason = CONDITION_NOT_MET`).
- **FA-03 — Devolução e nova entrada:** devolver para antes de uma etapa dispensada e encaminhar de novo reavalia a regra com o contexto atual (o valor pode ter mudado); etapas `SKIPPED` não são destino de devolução (nunca foram percorridas).
- **FA-04 — Dispensa dentro de ramo paralelo:** a etapa dispensada pertence ao ramo (`branchKey`); se for a última do ramo, o ramo chega à junção como num encaminhamento comum (US-124); no `PARALLEL_SPLIT`, a avaliação da primeira etapa de cada ramo usa o mesmo contexto do instante da ramificação.
- **FA-05 — Erro ao avaliar:** regra de aplicabilidade que não pode ser avaliada **não dispensa** (a etapa executa) e gera `warn`; transição cuja condição falha fica indisponível; indisponibilidade de banco ou provedor de contexto responde 503 e nada muda.
- **FA-06 — Remover a aplicabilidade:** `applicabilityRule = null` em rascunho volta a etapa a sempre aplicável; processos em andamento não mudam (versão fixada, DEC-014).
- **FA-07 — Versão publicada:** qualquer escrita em versão não `DRAFT` responde `WORKFLOW_VERSION_NOT_DRAFT` (409).
- **FA-08 — Valor alterado depois da dispensa:** não reabre a etapa; o efeito vale só para novas entradas (FA-03).
- **FA-09 — Consulta sem permissão de sigilo:** PRC-70 e PRC-10 mostram a regra e a versão, com os valores lidos como `{ value: null, masked: true }`.

## Regras de negócio
- **RN-RULE-53** — `WorkflowStage.applicabilityRule` aceita `RuleRef` em modo `LIBRARY` com versão `PUBLISHED`, regra ativa e `kind = ROUTING`; modo `INLINE` é recusado (`NOT_ALLOWED`) para garantir os casos de teste do roteamento (RN-RULE-12 da feature; ver D-01). Nulo = etapa sempre aplicável.
- **RN-RULE-54** — A aplicabilidade é avaliada **na entrada da etapa**, sobre o `RuleContext` v2 do processo naquele instante, pelo executor único (ADR-008): verdadeira executa a etapa; falsa a dispensa. Cada entrada reavalia, sem memória de passagens anteriores, inclusive após devolução.
- **RN-RULE-55** — Só etapas `TASK` e `APPROVAL` aceitam `applicabilityRule`; `START`, `END`, `PARALLEL_SPLIT` e `PARALLEL_JOIN` não (`WF_APPLICABILITY_NOT_ALLOWED`): são o início, o fim e a mecânica de ramos.
- **RN-RULE-56** — Etapa com `isLegallyRequired = true` não aceita `applicabilityRule`: recusa ao salvar (WF-11) e na publicação (WF-20/WF-21) com `RULE_NOT_ALLOWED_ON_LEGAL_STAGE` (POL-27), além do check de banco.
- **RN-RULE-57** — **Rota da dispensa:** toda etapa com `applicabilityRule` precisa de exatamente uma transição `FORWARD` primária (`isPrimary`) **sem condição** (caminho padrão); o processo segue por ela ao dispensar a etapa. Ausência ou condição nessa transição: `WF_SKIP_ROUTE_INVALID` na publicação.
- **RN-RULE-58** — **Efeito atômico** da dispensa, na mesma transação do encaminhamento: `ProcessStage` `SKIPPED` fechada (`enteredAt = exitedAt`, sem responsável, sem prazo, com `skipRuleResult`), `ProcessMovement` `SKIP` com `metadata.skip = { stageKey, ruleRef, value }`, outbox `ProcessStageSkipped`, timeline `STAGE_SKIPPED` e auditoria `process.stage_skip` (`actorType = SYSTEM`, com o movimento do encaminhamento em `metadata.triggeringMovementId`).
- **RN-RULE-59** — O `skipRuleResult` guarda o `RuleRef` (regra, versão e `contextVersion`), o resultado e os **valores lidos** pela expressão; na leitura, valores sigilosos saem mascarados por POL-09 (`null` + `masked: true`) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo ou a custódia. Evento, timeline, auditoria e logs **nunca** trazem o valor avaliado.
- **RN-RULE-60** — Etapa dispensada não cria responsável, prazo, SLA, aprovação, checklist nem exigência de documento; as regras de saída dela **não** são avaliadas; ela não conta como etapa percorrida e **não é destino de devolução** (RN-WF-23).
- **RN-RULE-61** — **Encadeamento:** se a próxima etapa também tiver aplicabilidade falsa, é dispensada em seguida; o processo termina na primeira etapa aplicável (a etapa `END` nunca é dispensada, RN-RULE-55). O limite de passos é a quantidade de etapas da versão (`SKIP_CHAIN_LIMIT`, desfaz tudo).
- **RN-RULE-62** — `WorkflowTransition.condition` aceita `RuleRef` `LIBRARY` com `kind = ROUTING` e só em transições `FORWARD` e `COMPLETE`; `RETURN`, `APPROVE` e `REJECT` não têm condição (`WF_CONDITION_NOT_ALLOWED`). A transição só fica disponível quando a condição é verdadeira.
- **RN-RULE-63** — A condição é avaliada ao calcular as ações disponíveis (PRC-08, `getAvailableActions`) e **revalidada no servidor** no encaminhamento (PRC-19): transição de condição falsa não é listada e pedi-la responde 422 `TRANSITION_NOT_AVAILABLE`.
- **RN-RULE-64** — **Caminho padrão:** etapa que tenha ao menos uma transição `FORWARD` com condição precisa ter uma `FORWARD` primária sem condição (`WF_CONDITION_DEFAULT_MISSING`); assim nunca há processo sem caminho por condição. As transições `FORWARD` verdadeiras aparecem como opções e a primária vem pré-selecionada.
- **RN-RULE-65** — **Falha segura:** erro de avaliação (caminho ausente do contexto, tipo inesperado) **não dispensa** a etapa e **oculta** a transição, com `warn` `rule.evaluation_failed` (sem valores); falha de infraestrutura (banco, contribuidor de contexto) responde 503 `DEPENDENCY_UNAVAILABLE` e nenhuma mutação é gravada.
- **RN-RULE-66** — **Validação na publicação** (WF-20/WF-21), além das da US-195: etapas legais, tipos de etapa, rota de dispensa, caminho padrão e **integridade do grafo com ramos paralelos** (`WF_PARALLEL_INVALID`): a rota de dispensa não pode atravessar ramos, deixar um `PARALLEL_JOIN` inalcançável nem sair de um ramo; o validador percorre o grafo considerando cada etapa condicional como "pode ser dispensada".
- **RN-RULE-67** — Dentro de um ramo, a etapa dispensada leva `branchKey` e o movimento `SKIP` leva `branch`; se for a última do ramo, o ramo vira `ARRIVED` conforme a US-124; a ramificação avalia a primeira etapa de cada ramo com um único contexto (consistência no instante do `PARALLEL_SPLIT`).
- **RN-RULE-68** — A dispensa é um **fato visível** (RN-RULE-16 da feature): etiqueta "Dispensada por regra" no SCR-006 (estágios e linha do tempo), `status = SKIPPED` em PRC-10, movimento `SKIP` em PRC-11 e no relatório de tramitação (ADR-015). O texto da timeline é "Etapa {stageName} dispensada pela regra {ruleLabel}".
- **RN-RULE-69** — A configuração só vale em `WorkflowVersion` `DRAFT` (RN-WF-54); versões publicadas são imutáveis; processos em andamento continuam na versão fixada (DEC-014) e nenhuma regra nova os dispensa retroativamente.
- **RN-RULE-70** — O encaminhamento continua idempotente (`Idempotency-Key` de PRC-19): o replay devolve a mesma resposta e **não** gera novo `SKIP`, evento nem auditoria; concorrência entre encaminhamentos do mesmo processo segue o bloqueio do MVP 1 (409/412), com o segundo vendo o novo estado.
- **RN-RULE-71** — O `ProcessStageChanged` do encaminhamento aponta como etapa de destino aquela em que o processo realmente ficou ativo (`activeStageIds[]`, `branchKey`), e cada dispensa gera só `ProcessStageSkipped` (a causa `SKIP` não entra no `ProcessStageChanged`, events.md §2).
- **RN-RULE-72** — A pré-visualização do caminho (PRC-71) é somente leitura: avalia as mesmas regras sobre o contexto atual, sem criar movimentos, eventos, auditoria de domínio nem bloquear o processo; o resultado vale no instante da consulta e o PRC-19 reavalia.
- **RN-RULE-73** — Permissões: editar aplicabilidade e condição exige `WORKFLOW_MANAGE` e `RULE_VIEW` (escolher regra); publicar, `WORKFLOW_PUBLISH`; ver o motivo, `PROCESS_VIEW`; valores sigilosos, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`. Nenhuma permissão nova.
- **RN-RULE-74** — Todo isolamento por tenant: `RuleRef` com versão de outro tenant é referência inexistente (422 `REFERENCE_NOT_FOUND`); consulta de processo de outro tenant é 404.
- **RN-RULE-75** — Etapas dispensadas alimentam o read model de indicadores e o KPI de devolução por "pulo indevido" (`ProcessStageSkipped` × movimentos `RETURN`); a dispensa conta como etapa **não** percorrida nos tempos por etapa e nos gargalos.
- **RN-RULE-76** — A dispensa não substitui `DocumentTypeCodes`, regras de saída nem exigências da etapa seguinte: o que a etapa dispensada produziria (por exemplo, a manifestação do Controle Interno) **não existe** e as regras da etapa seguinte que dependam dele devem ser escritas considerando `internalControl.exists` (o modelo `CI_ACIMA_DE_VALOR` já é o par dessa leitura; ver L-03).

Regras do MVP 1 que se aplicam, sem renumerar: **RN-WF-23** (devolução só para etapas percorridas), **RN-WF-29** (executor com *allowlist*), **RN-WF-54** (escrita só em `DRAFT`), **RN-WF-67** (processos continuam na versão fixada).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Aplicabilidade da etapa | `WorkflowStage.applicabilityRule` | `RuleRef` (`LIBRARY`) | Não | `kind = ROUTING`, versão `PUBLISHED`, regra ativa; só `TASK` e `APPROVAL`; proibida se `isLegallyRequired` | nulo |
| Condição da transição | `WorkflowTransition.condition` | `RuleRef` (`LIBRARY`) | Não | `kind = ROUTING`; só `FORWARD` e `COMPLETE`; exige caminho padrão | nulo |
| *(sistema)* Etapa legalmente obrigatória | `WorkflowStage.isLegallyRequired` | booleano | — | somente leitura aqui; semeado `true` em `JURIDICO` da licitação | `false` |
| *(sistema)* Transição primária | `WorkflowTransition.isPrimary` | booleano | — | rota padrão da dispensa | MVP 1 |
| *(sistema)* Situação da passagem | `ProcessStage.status` | `ProcessStageStatus` | — | `SKIPPED` quando dispensada | — |
| *(sistema)* Resultado da dispensa | `ProcessStage.skipRuleResult` | jsonb | Sim se `SKIPPED` | regra, versão, `contextVersion`, resultado, valores lidos (mascarados na leitura) | — |
| *(sistema)* Movimento | `ProcessMovement.action = SKIP` | enum | — | `metadata.skip = { stageKey, ruleRef, value }` | — |
| Transição escolhida | `transitionId` | uuid | Sim (PRC-19) | deve estar disponível (condição verdadeira) | opção primária |
| *(consulta)* Transição para pré-visualizar | `transitionId` | uuid | Não (PRC-71) | da etapa ativa | primária |
| *(consulta)* Passagem ativa | `processStageId` | uuid | Condicional | obrigatória com mais de uma etapa ativa (`PROCESS_STAGE_REQUIRED`) | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `applicabilityRule`/`condition` em modo `INLINE` | Front + API (Zod) | "Use uma regra da biblioteca para decidir o caminho do processo." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-02 | Referência inexistente, de outro tenant ou sem `RULE_VIEW` | API | "Selecione uma regra válida da biblioteca." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | Versão não publicada, regra inativa ou `kind` diferente de `ROUTING` | API | "Esta regra não pode ser usada para decidir o caminho: {motivo}." | `RULE_VERSION_NOT_PUBLISHED` / `RULE_INACTIVE` / `RULE_KIND_MISMATCH` |
| V-04 | `applicabilityRule` em etapa `isLegallyRequired` | API | "Esta etapa é exigida por lei e não pode ser dispensada por regra." | `RULE_NOT_ALLOWED_ON_LEGAL_STAGE` |
| V-05 | `applicabilityRule` em etapa `START`, `END`, `PARALLEL_SPLIT` ou `PARALLEL_JOIN` | API | "Esta etapa não pode ser condicional." | `WORKFLOW_INVALID` (`WF_APPLICABILITY_NOT_ALLOWED`) |
| V-06 | Etapa condicional sem transição `FORWARD` primária sem condição | API (WF-20/21) | "A etapa {etapa} precisa de um caminho padrão sem condição para o caso de ser dispensada." | `WORKFLOW_INVALID` (`WF_SKIP_ROUTE_INVALID`) |
| V-07 | `condition` em transição `RETURN`, `APPROVE` ou `REJECT` | API | "Só transições de avanço podem ter condição." | `WORKFLOW_INVALID` (`WF_CONDITION_NOT_ALLOWED`) |
| V-08 | Etapa com transição condicional e sem transição `FORWARD` padrão sem condição | API (WF-20/21) | "A etapa {etapa} precisa de uma transição padrão sem condição." | `WORKFLOW_INVALID` (`WF_CONDITION_DEFAULT_MISSING`) |
| V-09 | Dispensa que quebra o grafo com ramos paralelos | API (WF-20/21) | "A dispensa da etapa {etapa} deixaria o ramo sem chegar à junção." | `WORKFLOW_INVALID` (`WF_PARALLEL_INVALID`) |
| V-10 | Versão de workflow não é `DRAFT` | API | "Esta versão do workflow não pode mais ser editada." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-11 | `If-Match` ausente ou divergente (WF-11, WF-14) | API | "Os dados foram alterados. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-12 | Encaminhar por transição de condição falsa | API (PRC-19) | "Este caminho não está disponível agora." | `TRANSITION_NOT_AVAILABLE` (`reason = CONDITION_NOT_MET`) |
| V-13 | Encadeamento de dispensas acima do limite | API (PRC-19) | "Não foi possível definir a próxima etapa. Procure o administrador do workflow." | `BUSINESS_RULE_VIOLATION` (`SKIP_CHAIN_LIMIT`) |
| V-14 | Várias etapas ativas sem `processStageId` (PRC-71) | API | "Informe qual ramo do processo você quer simular." | `PROCESS_STAGE_REQUIRED` |

## Permissões
- **Permissão:** `WORKFLOW_MANAGE` (editar), `RULE_VIEW` (escolher regra), `WORKFLOW_PUBLISH` (publicar), `WORKFLOW_VIEW` (validar e consultar); `PROCESS_FORWARD` com POL-01 no encaminhamento (por etapa ativa, no paralelismo); `PROCESS_VIEW` para PRC-10, PRC-70 e PRC-71; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` para os valores sigilosos.
- **Políticas:** POL-27 (regra de roteamento fora de etapa `isLegallyRequired`), POL-01 (custódia por etapa ativa), POL-09 (orçamento sigiloso), POL-14 na publicação (`HIGH`).
- **MFA:** WF-21 segue o MVP 1 (`WORKFLOW_PUBLISH`, POL-14). Editar aplicabilidade e condição não exige MFA própria. A dispensa é ato do sistema, sem ator humano a autenticar.
- **Sem permissão:** controles de aplicabilidade e condição ocultos sem `WORKFLOW_MANAGE`; valores sigilosos mascarados sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; a API responde 403 `PERMISSION_DENIED` com `access.denied`, e 404 para processo não visível (DEC-024).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageSkipped` | `process.stage_skipped` | Etapa com `applicabilityRule` falsa, uma por etapa dispensada, no commit de PRC-19 | `processStageId`, `stageKey`, `ruleRef { mode, ruleDefinitionVersionId? }`, `contextVersion`, `movementId`; sem o valor avaliado; consumidores T, R, NR; projeta `STAGE_SKIPPED` |
| `ProcessStageChanged` (MVP 1) | `process.stage_changed.*` | Mesmo commit, para a etapa em que o processo ficou ativo | Com `branchKey?`, `splitProcessStageId?`, `activeStageIds[]` (events.md §2); a causa `SKIP` não entra aqui |
| `WorkflowVersionPublished` (MVP 1) | `workflow.version_published` | Commit de WF-21 | Publica a versão com as referências de roteamento já fixadas em `ruleRefs` (US-195) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação própria: a dispensa gera só a entrada `STAGE_SKIPPED` na timeline (events.md §8). O administrador pode, se quiser, criar uma regra de notificação (`NotificationRule`, EP-030) sobre `ProcessStageSkipped`, marcado "notificável por regra" (NR). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Roteamento condicional: etapa dispensada e transição condicional

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (WORKFLOW_MANAGE, WORKFLOW_PUBLISH, RULE_VIEW)
    And "Rafael" tem vínculo ativo com o perfil "GESTOR_CONTRATACOES" com custódia dos processos de teste
    And "Paulo" tem vínculo ativo com o perfil "CONTROLE_INTERNO" (PROCESS_VIEW_CONFIDENTIAL_BUDGET)
    And "Bruno" tem vínculo ativo com o perfil "PLANEJAMENTO" sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    And o workflow "Fase preparatória" v3 em rascunho tem as etapas "JURIDICO" (isLegallyRequired), "CONTROLE_INTERNO" e "AUTORIZACAO_LICITACAO" em sequência, com transições "FORWARD" primárias sem condição
    And a regra "CI_ACIMA_DE_500K" (tipo "ROUTING", versão 1 publicada, limite R$ 500.000,00, valor nulo aplica) está na biblioteca

  Scenario: [Sucesso] Configurar a aplicabilidade e publicar o workflow
    When "Marina" definir "CI_ACIMA_DE_500K" como "applicabilityRule" da etapa "CONTROLE_INTERNO"
    Then a API deve responder 200 com a regra em modo "LIBRARY" e a etapa marcada como condicional
    And deve gerar registro de auditoria "workflow.update"
    When "Marina" validar e publicar a versão com "changeNotes"
    Then "ruleRefs" deve registrar "CI_ACIMA_DE_500K" versão 1 usada em "STAGE_APPLICABILITY" de "CONTROLE_INTERNO"
    And deve gerar o evento "WorkflowVersionPublished" e a auditoria "workflow.version_publish"

  Scenario: [Sucesso] Processo de R$ 120.000,00 tem a etapa dispensada e segue
    Given que o processo "0050/2026" de R$ 120.000,00 está em "JURIDICO" na versão publicada
    When "Rafael" encaminhar o processo pela transição primária
    Then a API deve responder 200 com "skippedStages" contendo "CONTROLE_INTERNO" e a regra "CI_ACIMA_DE_500K" versão 1
    And a etapa "CONTROLE_INTERNO" deve ficar "SKIPPED" sem responsável nem prazo e com "skipRuleResult"
    And o processo deve ficar ativo em "AUTORIZACAO_LICITACAO"
    And deve existir um movimento "SKIP" para "CONTROLE_INTERNO"
    And deve gerar registro de auditoria "process.stage_skip" com "actorType" "SYSTEM"
    And deve gerar os eventos "ProcessStageSkipped" e "ProcessStageChanged" sem o valor do processo
    And a timeline deve exibir "Etapa Controle Interno dispensada pela regra CI_ACIMA_DE_500K"

  Scenario: [Sucesso] Processo de R$ 900.000,00 executa a etapa e o caminho é pré-visualizado
    Given que o processo "0051/2026" de R$ 900.000,00 está em "JURIDICO"
    When "Rafael" pré-visualizar o encaminhamento
    Then a pré-visualização deve indicar "CONTROLE_INTERNO" como "ACTIVE" e não deve criar movimento, evento nem auditoria
    When "Rafael" encaminhar o processo
    Then a etapa "CONTROLE_INTERNO" deve ficar "ACTIVE" e não deve haver movimento "SKIP"
    And deve gerar o evento "ProcessStageChanged" e nenhum "ProcessStageSkipped"

  Scenario: [Sucesso] Transição condicional escondida, caminho padrão e devolução reavaliam a regra
    Given que a etapa "PESQUISA_PRECOS" tem a transição padrão "PARA_DOTACAO" e a transição "PARA_AUTORIZACAO_DIRETA" com a regra "BAIXO_VALOR" (valor até R$ 50.000,00)
    And o processo "0052/2026" de R$ 120.000,00 está em "PESQUISA_PRECOS"
    When "Rafael" consultar as ações disponíveis
    Then só a transição "PARA_DOTACAO" deve ser listada
    When "Rafael" pedir "PARA_AUTORIZACAO_DIRETA"
    Then a API deve responder 422 com código "TRANSITION_NOT_AVAILABLE" e "reason" "CONDITION_NOT_MET"
    Given que o processo "0050/2026" teve "CONTROLE_INTERNO" dispensada e o valor foi corrigido para R$ 700.000,00 após devolução a "JURIDICO"
    When "Rafael" encaminhar de novo
    Then a etapa "CONTROLE_INTERNO" deve ser executada (nova passagem "ACTIVE") e o movimento "SKIP" anterior deve permanecer no histórico

  Scenario: [Sucesso] Valor sigiloso fica mascarado no motivo da dispensa
    Given que o processo "0060/2026" tem orçamento sigiloso e teve "CONTROLE_INTERNO" dispensada
    When "Paulo" consultar PRC-70
    Then o valor lido "process.estimatedValue" deve vir com o número real
    When "Bruno" consultar PRC-70
    Then o valor lido deve vir com "value" nulo e "masked" verdadeiro, mantendo a regra e a versão
    And o evento "ProcessStageSkipped" e a auditoria "process.stage_skip" não devem conter o valor

  Scenario: [Validação] Etapa legal, tipo de etapa, caminho padrão e modo INLINE
    When "Marina" definir "applicabilityRule" na etapa "JURIDICO" (isLegallyRequired)
    Then a API deve responder 422 com código "RULE_NOT_ALLOWED_ON_LEGAL_STAGE"
    Given que um rascunho copiado de uma versão antiga traz "applicabilityRule" em "JURIDICO", que nela ainda não era obrigatória por lei
    When "Marina" tentar publicar o workflow
    Then a publicação deve ser recusada com "RULE_NOT_ALLOWED_ON_LEGAL_STAGE"
    When "Marina" definir "condition" numa transição "RETURN"
    Then a publicação deve ser recusada com "WF_CONDITION_NOT_ALLOWED"
    Given que "CONTROLE_INTERNO" é condicional e sua única transição "FORWARD" tem condição
    When "Marina" publicar
    Then a publicação deve ser recusada com "WF_SKIP_ROUTE_INVALID" e "WF_CONDITION_DEFAULT_MISSING"
    When "Marina" enviar uma "applicabilityRule" em modo "INLINE"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"

  Scenario: [Permissão] Quem não pode configurar nem ver
    When "Bruno" tentar definir "applicabilityRule" numa etapa
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Sandra" tem "WORKFLOW_MANAGE" mas não tem "RULE_VIEW"
    When "Sandra" escolher a regra "CI_ACIMA_DE_500K"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e "reasonCode" igual a "RULE_VIEW"
    When um usuário sem visibilidade do processo "0050/2026" consultar PRC-70
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Tenant incorreto] Regra e processo de outro tenant
    Given que a regra "CI_ACIMA_DE_1M" pertence ao tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", definir essa regra como aplicabilidade
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"
    When "Rafael" consultar o roteamento de um processo do tenant "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Encaminhamento reenviado não dispensa duas vezes
    Given que "Rafael" encaminhou "0050/2026" com a "Idempotency-Key" "K-77" e a etapa "CONTROLE_INTERNO" foi dispensada
    When a mesma requisição for reenviada
    Then a API deve responder com a mesma resposta e "Idempotent-Replayed" verdadeiro
    And deve existir um único movimento "SKIP", um único "ProcessStageSkipped" e uma única auditoria "process.stage_skip"

  Scenario: [Concorrência] Dois encaminhamentos simultâneos do mesmo processo
    Given que "Rafael" e outro usuário com custódia abriram "0050/2026" em "JURIDICO"
    When os dois encaminharem ao mesmo tempo
    Then um encaminhamento deve responder 200 e o outro 409 ou 412
    And deve existir uma única dispensa de "CONTROLE_INTERNO"
    And o processo deve ter uma única etapa ativa no tronco

  Scenario: [Falha de banco] Banco indisponível no encaminhamento com dispensa
    Given que o banco de dados fica indisponível durante a transação de encaminhamento de "0050/2026"
    When "Rafael" encaminhar o processo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o processo deve continuar em "JURIDICO", sem etapa "SKIPPED", sem movimento, sem auditoria e sem evento

  Scenario: [Falha de integração] Provedor de contexto indisponível e relay do outbox parado
    Given que o provedor do namespace "internalControl" falha ao montar o contexto
    When "Rafael" encaminhar o processo "0050/2026"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e nada deve mudar
    Given que o relay do outbox está indisponível
    When "Rafael" encaminhar "0050/2026" com sucesso e a etapa for dispensada
    Then a API deve responder 200
    And o evento "ProcessStageSkipped" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (`INLINE`, campos) | 422 | `VALIDATION_ERROR` | "Use uma regra da biblioteca para decidir o caminho do processo." | Marca o campo; mantém o painel |
| Regra inválida para o uso | 422 | `RULE_VERSION_NOT_PUBLISHED` / `RULE_INACTIVE` / `RULE_KIND_MISMATCH` | "Esta regra não pode ser usada para decidir o caminho: {motivo}." | Filtra o seletor |
| Etapa legalmente obrigatória | 422 | `RULE_NOT_ALLOWED_ON_LEGAL_STAGE` | "Esta etapa é exigida por lei e não pode ser dispensada por regra." | Desabilita o campo na etapa |
| Etapa de tipo não aceito / transição não aceita | 422 | `WORKFLOW_INVALID` (`WF_APPLICABILITY_NOT_ALLOWED`, `WF_CONDITION_NOT_ALLOWED`) | "Esta etapa (ou transição) não pode ser condicional." | Lista erros na validação |
| Sem caminho padrão / rota de dispensa inválida | 422 | `WORKFLOW_INVALID` (`WF_SKIP_ROUTE_INVALID`, `WF_CONDITION_DEFAULT_MISSING`) | "A etapa {etapa} precisa de um caminho padrão sem condição." | Aponta a etapa no diagrama |
| Ramos paralelos inválidos | 422 | `WORKFLOW_INVALID` (`WF_PARALLEL_INVALID`) | "A dispensa da etapa {etapa} deixaria o ramo sem chegar à junção." | Aponta a etapa |
| Versão não é rascunho | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão do workflow não pode mais ser editada." | Oferece "Criar novo rascunho" |
| Transição indisponível | 422 | `TRANSITION_NOT_AVAILABLE` | "Este caminho não está disponível agora." | Recarrega as ações |
| Encadeamento de dispensas excessivo | 422 | `BUSINESS_RULE_VIOLATION` (`SKIP_CHAIN_LIMIT`) | "Não foi possível definir a próxima etapa. Procure o administrador do workflow." | Mantém o processo; registra `error` |
| Etapa ativa não informada | 422 | `PROCESS_STAGE_REQUIRED` | "Informe qual ramo do processo você quer simular." | Mostra o seletor de ramo |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta ações |
| Processo, etapa ou transição inexistente / outro tenant / não visível | 404 | `NOT_FOUND` | "Registro não encontrado." | Volta à lista |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "Os dados foram alterados. Recarregue e tente novamente." | Recarrega |
| Encaminhamento concorrente | 409 | `CONFLICT` (como PRC-19 do MVP 1) | "O processo foi alterado por outra pessoa. Atualize e tente de novo." | Recarrega o processo |
| Banco ou provedor de contexto indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém a tela; "Tentar novamente" |

## Dependências
- **Stories:** US-041 (motor `getAvailableActions` e `evaluateRules`); US-047 (encaminhamento PRC-19); US-195 (referência `LIBRARY`, validação de versão e matriz de tipos); US-129 (`RuleContext` v2). Habilita US-198 (alçadas) e US-200 (testes obrigatórios das regras de roteamento). Interage com US-123 (modelagem de etapas paralelas) e US-124 (execução dos ramos), que fornecem `branchKey` e a junção; com US-130 (workflow padrão v2) e US-148/US-155/US-161/US-168 (etapas e regras de saída dos módulos novos); com US-194/US-196 (regra e modelo `CI_ACIMA_DE_VALOR`).
- **Decisões/ADRs:** DEC-204, DEC-014, DEC-194, DEC-196, DEC-016, DEC-108, ADR-015, ADR-008, ADR-005; POL-27, POL-09, POL-01.
- **Configurações:** nenhuma nova (`security.mfaPolicy` para a publicação).
- **Lacunas nas fontes canônicas:**
  1. **L-01 — Forma do `skipRuleResult` e de `metadata.skip.value`:** entities.md §5.3/§5.5 diz "regra, versão do contexto e valor avaliado". Proposta: `{ ruleRef, ruleLabel, ruleKey, versionNumber, contextVersion, result: false, reads: { "<path>": valor }, evaluatedAt }`; `metadata.skip.value` = `reads`. Marcar no `schema` do contexto os caminhos `confidential` (US-194, WF-19).
  2. **L-02 — Códigos de erro e de validação novos:** `WF_APPLICABILITY_NOT_ALLOWED`, `WF_SKIP_ROUTE_INVALID`, `WF_CONDITION_NOT_ALLOWED`, `WF_CONDITION_DEFAULT_MISSING`, `SKIP_CHAIN_LIMIT` e o motivo `CONDITION_NOT_MET` em `TRANSITION_NOT_AVAILABLE`; a consolidar no api.md.
  3. **L-03 — Regras da etapa seguinte que dependem da etapa dispensada:** não há convenção; o card orienta ler `internalControl.exists`. A US-130 (workflow v2) deve revisar as regras de saída de `AUTORIZACAO_LICITACAO` que exigem `internalControl.concluded`.
  4. **L-04 — Ação de auditoria da dispensa:** `process.stage_skip` existe (events.md §7); falta definir o ator (aqui `SYSTEM`, com `triggeringMovementId`) — confirmar.
  5. **L-05 — Endpoints:** PRC-70 e PRC-71 (consulta e pré-visualização) são propostos aqui; o catálogo do MVP 2 é consolidado no card 9.
  6. **D-01 (dúvida de produto) — `INLINE` em roteamento:** entities.md §7.1 aceita `INLINE` e `LIBRARY` nos usos de roteamento. Este card exige `LIBRARY` para que 100% das regras de roteamento tenham casos de teste (roadmap §4.10, RN-RULE-12). Confirmar se o produto aceita essa restrição.
  7. **D-02 (dúvida de produto) — Quem encaminha na dispensa:** o responsável da etapa dispensada não existe; se a etapa seguinte for do mesmo setor, a custódia segue a política de atribuição da etapa de destino (como num encaminhamento normal). Confirmar que não há "responsável sombra" na etapa dispensada.

## Impacto técnico
- **Compatibilidade (DEC-108):** campos aditivos em WF-11, WF-14, PRC-08, PRC-10 e PRC-19 (`skippedStages[]`); processos e workflows sem `applicabilityRule` e sem `condition` seguem idênticos; a mudança de unique de `ProcessStage` para ramos (M2-06) é pré-requisito.
- **Motor:** `WorkflowFacade.getAvailableActions` filtra transições por condição; um novo passo `RoutingResolver` do módulo `process` executa `enterStage` → avalia aplicabilidade → dispensa e encadeia, dentro da mesma transação do encaminhamento; reusa o `RuleContextBuilder` v2 com montagem preguiçosa por namespace e cache por requisição.
- **Atomicidade e concorrência:** o encaminhamento já serializa por `FOR UPDATE` do processo (e, em ramos, da `ProcessStage` do split); dispensas ocorrem sob a mesma trava, sem novos pontos de contenção.
- **Performance:** a avaliação adiciona, por entrada, uma montagem de contexto limitada aos namespaces citados pela expressão; o `RuleContext` v2 é reutilizado entre aplicabilidade, transições e regras de saída da mesma requisição.
- **Grafo e validação:** o validador percorre o grafo tratando etapas condicionais como "pode ser dispensada"; combina com `WF_PARALLEL_INVALID` (US-123).
- **Observabilidade:** span `process.routing.resolve` com `cf.rules.evaluated`, `cf.process.skipped_count`; métrica `cf_process_stage_skipped_total`.
- **Migração:** colunas `applicability_rule`, `is_legally_required`, `condition` e `skip_rule_result` e o check de `SKIPPED` já previstos na M2-04/M2-05; sem backfill.

## Backend
- **Módulo(s):** `workflow` (dono de `applicabilityRule`, `condition`, validação e `getAvailableActions`), `process` (execução do roteamento, `ProcessStage`, `ProcessMovement`, timeline), `rules` (leitura de versões fixadas), `timeline`, `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** extensões de `UpdateWorkflowStageCommand` (WF-11) e `UpdateWorkflowTransitionCommand` (WF-14); `ValidateWorkflowVersionQuery` e `WorkflowVersionPublisher` (WF-20/21); `ForwardProcessCommand` (PRC-19) com `RoutingResolver`; `GetProcessRoutingQuery` (PRC-70), `PreviewProcessRoutingQuery` (PRC-71); `GetAvailableActionsQuery` (PRC-08).
- **Domínio:** `RoutingResolver` (entrada → aplicabilidade → dispensa → encadeamento), `StageApplicabilityPolicy`, `TransitionConditionPolicy`, `SkipRuleResult` (value object), validadores de grafo (`LegalStageGuard`, `SkipRouteValidator`, `DefaultPathValidator`).
- **Integrações internas:** `RulesFacade` (versão fixada imutável), `RuleContextBuilder` v2, `TimelineProjector` (`STAGE_SKIPPED`), `ProcessAccessGranter` (concessões da etapa realmente ativada), `ConfidentialFieldsInterceptor` (POL-09).
- **Transação:** PRC-19 numa transação com `app.tenant_id`: trava do processo → revalida regras de saída e transição → registra o movimento → avalia e cria as passagens `SKIPPED` → ativa a etapa aplicável (responsável, SLA, acessos) → auditoria → outbox → projeção síncrona na timeline.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`: seção "Aplicabilidade" da etapa e "Condição" da transição; diagrama com selo "Condicional") e SCR-006 (`/processos/[id]`: estágios, linha do tempo e modal de encaminhamento).
- **Componentes:** `StageApplicabilityField` e `TransitionConditionField` (reusam `LibraryRulePicker` da US-195, filtro `ROUTING`), `ConditionalBadge`, `RoutingValidationList`, `ForwardRoutingPreview` (PRC-71: "será dispensada pela regra …"), `SkippedStageBadge` ("Dispensada por regra"), item de timeline `STAGE_SKIPPED`, `RoutingDetailPanel` (PRC-70: regra, versão, valores lidos com máscara).
- **Estados:** carregando (skeleton), vazio ("Nenhuma etapa foi dispensada neste processo"), erro ("Tentar novamente"), sem permissão (campos ocultos; valores mascarados com ícone de cadeado e texto "Valor sigiloso"), conflito (recarrega), versão publicada (somente leitura).
- **Acessibilidade e responsividade:** a etapa dispensada é identificada por texto e ícone, nunca só por cor; a pré-visualização é anunciada por `aria-live`; foco e leitura do motivo por teclado; contraste 4,5:1 nos dois temas; modal em tela cheia abaixo de 768 px.

## Banco de dados
- **Tabelas:** `workflow_stages` (`applicability_rule`, `is_legally_required`), `workflow_transitions` (`condition`), `process_stages` (`status = SKIPPED`, `skip_rule_result`), `process_movements` (`action = SKIP`, `metadata`), `outbox_events`, `audit_logs`, leitura de `rule_definition_versions`.
- **Migrações:** parte das M2-01 (enums `SKIPPED`/`SKIP`), M2-04 e M2-05 (colunas), sem backfill; nenhuma migração nova nesta story.
- **Índices/constraints relevantes:** check `NOT is_legally_required OR applicability_rule IS NULL`; check `status <> 'SKIPPED' OR skip_rule_result IS NOT NULL`; índice `(tenant_id, process_id) WHERE status = 'ACTIVE'`; para o KPI, consulta `(tenant_id, status)` nos fatos do read model; trigger de imutabilidade do workflow estendido às colunas novas.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `WF-11` | PATCH | `/workflow-stages/{stageId}` | como no MVP 1 + `applicabilityRule?: RuleRef (LIBRARY) \| null`; `If-Match` | `200 { data: WorkflowStage }` com `applicabilityRule` e `isLegallyRequired` | 200, 403, 409, 412, 422, 428 |
| `WF-14` | PATCH | `/workflow-transitions/{transitionId}` | como no MVP 1 + `condition?: RuleRef (LIBRARY) \| null`; `If-Match` | `200 { data: WorkflowTransition }` | 200, 403, 409, 412, 422, 428 |
| `WF-20` | POST | `/workflow-versions/{versionId}/validate` | — | `errors[]`/`warnings[]` com os códigos de roteamento (RN-RULE-66) | 200, 404 |
| `WF-21` | POST | `/workflow-versions/{versionId}/publish` | `{ changeNotes? }`; `If-Match` | `200 { data: WorkflowVersion }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PRC-08` | GET | `/processes/{id}/available-actions` | — | ações sem as transições de condição falsa | 200, 403, 404 |
| `PRC-10` | GET | `/processes/{id}/stages` | — | passagens incluindo `status = SKIPPED` e `skipRuleResult` resumido e mascarado | 200, 403, 404 |
| `PRC-19` | POST | `/processes/{id}/forward` | como no MVP 1; `Idempotency-Key` | `200` com `skippedStages: [{ processStageId, stageKey, stageName, ruleLabel }]` (aditivo) | 200, 403, 404, 409, 412, 422, 503 |
| `PRC-70` | GET | `/processes/{id}/routing` | — | `200 { data: { skippedStages: [{ processStageId, stageKey, stageName, skippedAt, rule: { ruleDefinitionId, key, label, versionNumber, ruleDefinitionVersionId, contextVersion }, reads, movementId }], conditionalTransitions: [{ transitionId, key, name, rule, currentResult }] } }` | 200, 403, 404 |
| `PRC-71` | GET | `/processes/{id}/routing/preview` | query `transitionId?`, `processStageId?` | `200 { data: { path: [{ stageKey, stageName, outcome: 'ACTIVE' \| 'SKIPPED', ruleLabel? }], availableTransitions[] } }` (leitura pura) | 200, 403, 404, 422 |
| `RUL-01` | GET | `/rules` | `kind = ROUTING`, `isActive = true`, `hasPublishedVersion = true`, `isSystem = false` | regras elegíveis para o seletor | 200, 403 |

## Logs
- `info` `process.stage_skipped` — `processId`, `stageKey`, `ruleDefinitionVersionId`, `contextVersion`, `skipChainLength`, `durationMs`.
- `info` `workflow.routing_configured` — `workflowVersionId`, `stageKey`/`transitionKey`, `ruleDefinitionVersionId`.
- `warn` `rule.evaluation_failed` — `ruleDefinitionVersionId`, `useType`, motivo resumido, sem valores; `warn` `process.routing_fallback` (etapa executada por falha de avaliação).
- `error` `process.skip_chain_limit` — `processId`, `workflowVersionId`, `correlationId`.
- **Nunca logar:** valores do `RuleContext`, o valor estimado (sigiloso ou não) e a expressão da regra.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.update` | `CONFIGURATION` | WF-11 e WF-14 com regra de roteamento | `metadata`: `stageId`/`transitionId`, `field` (`applicabilityRule` ou `condition`), `ruleDefinitionVersionId` antes/depois |
| `workflow.version_publish` | `CONFIGURATION` | WF-21 | como US-195, com `ruleRefsCount` |
| `process.stage_skip` | `WORKFLOW` | Por etapa dispensada, na transação de PRC-19 (`actorType = SYSTEM`) | `metadata`: `processId`, `stageKey`, `ruleDefinitionVersionId`, `contextVersion`, `movementId`, `triggeringMovementId`; **sem** valores |
| `process.forward` | `WORKFLOW` | PRC-19 (MVP 1) | movimento do encaminhamento, com `skippedStageKeys[]` aditivo |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = permissão exigida |

## Testes necessários
- **Unitários:** `RoutingResolver` (dispensa simples, encadeada, limite, erro de avaliação que não dispensa, valor nulo aplica); `TransitionConditionPolicy`; validadores (`LegalStageGuard`, `SkipRouteValidator`, `DefaultPathValidator`, grafo com ramos); mascaramento de `reads`; tabela de limites do modelo `CI_ACIMA_DE_VALOR` (R$ 499.999,99, 500.000,00, 500.000,01).
- **Integração (Testcontainers PostgreSQL + Redis):** PRC-19 com dispensa (passagem `SKIPPED`, `SKIP`, evento, timeline, auditoria, responsável e SLA da etapa seguinte); rollback total em falha; ramos paralelos (dispensa da última etapa do ramo chega à junção); devolução e nova entrada; workflow sem regras (regressão do MVP 1); idempotência de PRC-19.
- **API/contrato:** WF-11, WF-14, WF-20, WF-21, PRC-08, PRC-10, PRC-19, PRC-70 e PRC-71 conforme este card; compatibilidade aditiva com clientes do MVP 1.
- **RBAC e multi-tenant:** configuração só com `WORKFLOW_MANAGE` + `RULE_VIEW`; mascaramento por POL-09; processo e regra de outro tenant (404/422) na suíte `test/tenant-leak`.
- **Concorrência:** dois encaminhamentos simultâneos; encaminhar × editar o workflow (versão fixada não muda); mudança de valor entre pré-visualização e encaminhamento (a revalidação prevalece).
- **E2E (Playwright):** configurar `CI_ACIMA_DE_500K` → publicar → processo de R$ 120.000,00 dispensa a etapa e a timeline mostra o motivo → processo de R$ 900.000,00 executa a etapa → etapa `JURIDICO` sem campo de aplicabilidade.
- **Acessibilidade/performance:** axe sem violações sérias nos campos do editor, no modal de encaminhamento e na timeline; PRC-19 com 5 etapas dispensadas em sequência dentro da meta de comando do api.md; 360 px.

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
- [ ] Nenhuma etapa `isLegallyRequired` pode ser dispensada (testado na API, na publicação e no banco)
- [ ] Valor sigiloso ausente de evento, auditoria, timeline e logs (teste automatizado)
- [ ] Regressão: workflows e processos do MVP 1 sem regras de roteamento inalterados

## Estimativa
**L** — toca o editor, o validador de publicação (grafo, ramos, caminho padrão), o motor de ações disponíveis e, principalmente, o encaminhamento (`RoutingResolver` atômico com dispensa encadeada, ramos paralelos, eventos, timeline e mascaramento), além de duas consultas novas e do detalhe do processo; o risco de regressão em PRC-19 exige testes extensos.

## Prioridade
**P1** — é a entrega visível do épico (roteamento por valor e etapa dispensada com motivo) e o que torna o processo de baixo valor mais leve sem perder o controle; depende da biblioteca e do contexto v2, e a alçada (US-198) reusa seu validador e seu padrão de fato visível.
