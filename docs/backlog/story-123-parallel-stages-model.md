---
id: US-123
title: "Modelar etapas paralelas no workflow (ramificação e junção)"
epic: EP-021
feature: FT-063
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-040, US-043, US-045]
modules: [workflow, audit]
screens: [SCR-034]
endpoints: [WF-24, WF-09, WF-10, WF-11, WF-13, WF-14, WF-20, WF-21]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE, WORKFLOW_PUBLISH]
events: [WorkflowVersionPublished]
---

# US-123 — Modelar etapas paralelas no workflow (ramificação e junção)

## Título
Modelar etapas paralelas no workflow (ramificação e junção)

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO`), **quero** modelar no editor de workflow uma ramificação (`PARALLEL_SPLIT`) que abre dois ou mais caminhos simultâneos e uma junção (`PARALLEL_JOIN`) que os reúne, **para** que áreas como Jurídico e Controle Interno trabalhem ao mesmo tempo sem que eu precise abrir mão da validação do fluxo antes de publicar.

A story entrega a **definição** do paralelismo (DEC-194): os dois tipos novos de etapa, as regras de compatibilidade das transições, o cálculo de `WorkflowStage.branchKey` na publicação, a validação do grafo (`WF_PARALLEL_INVALID`) e o suporte do editor e do diagrama (SCR-034). O **comportamento em execução** (ramos no processo, junção, devolução) é da US-124 e a caixa de tarefas, o painel e os prazos são da US-125. O uso é opcional por tenant: nenhuma versão existente muda e a v2 do workflow padrão (DEC-196) continua sequencial.

## Contexto
- O MVP 1 modela um fluxo estritamente sequencial: `StageType` = `START`, `TASK`, `APPROVAL`, `END` e uma única etapa ativa por processo (DEC-014, ADR-005). Órgãos que querem Jurídico e Controle Interno em paralelo (ordem configurável por tenant — DEC-196) não conseguem expressar isso.
- DEC-194 cria `PARALLEL_SPLIT` e `PARALLEL_JOIN`: sem responsável nem prazo, atravessados automaticamente pelo motor, **um nível** de ramos e **exatamente um** `PARALLEL_JOIN` por split. A validação do grafo na publicação recusa o resto com `WF_PARALLEL_INVALID` (422). O ADR-005 recebeu o adendo de 2026-11-10 para o motor com ramos.
- US-040 define o modelo e a validação completa do grafo (`WF_*`, RN-WF-11/12/19: todos os erros de uma vez); US-043 entrega o editor; US-045 publica e congela a versão (`definitionSnapshot`, `definitionHash`, RN-WF-64). Esta story **estende** essas três sem alterar contratos do MVP 1 (campos e valores aditivos — DEC-108).
- `docs/mvp-02/entities.md` §5.8 fixa as colunas novas de `WorkflowStage` (`branchKey`) e o check `type NOT IN ('PARALLEL_SPLIT','PARALLEL_JOIN') OR (sla_days IS NULL AND approver_type IS NULL)`; a regra de derivação de `branchKey` e a compatibilidade ação × tipo dos tipos novos são detalhadas aqui (ver "Lacunas nas fontes canônicas").
- Quem já usa o contorno do MVP 1 (etapas `TASK` provisórias para dotação, parecer e manifestação — roadmap §4.2) pode, depois, colocar essas etapas em ramos paralelos de uma versão própria; o mapeamento para os módulos do MVP 2 é tratado na migração (US-126/US-127).

## Objetivo
Permitir que 100% das versões de workflow com ramificação sejam modeladas, validadas e publicadas no editor com o grafo garantidamente íntegro (todo split com ao menos dois ramos e exatamente uma junção comum, sem aninhamento nem transição entre ramos), de modo que nenhum processo possa entrar em paralelismo num fluxo inválido.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`) com `WORKFLOW_MANAGE` e `WORKFLOW_PUBLISH`.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) e Auditor (`AUDITOR`), que consultam o diagrama (`WORKFLOW_VIEW`); Controle Interno, que lê a versão publicada para conferir a ordem das análises.

## Pré-condições
- Usuário autenticado no tenant, com vínculo ativo e MFA conforme `security.mfaPolicy` (permissões `WORKFLOW_MANAGE`/`WORKFLOW_PUBLISH` têm risco `H` — POL-14).
- Existe um `Workflow` do tenant com uma versão em `DRAFT` (RN-WF-04/46: no máximo uma por workflow). Sem rascunho, o administrador cria um com WF-08 (US-043).
- A versão em edição ainda não passou do limite de 50 etapas, 200 transições e 200 regras (RN-WF-18); `PARALLEL_SPLIT` e `PARALLEL_JOIN` contam como etapas.

## Fluxo principal
1. Na versão em rascunho (aba **Etapas** de SCR-034), o administrador aciona "Adicionar ramificação" (menu "Mais" do cabeçalho) e informa o nome do bloco, a etapa de origem (`TASK`/`START` de onde o fluxo sai), a etapa de destino da junção (`TASK`/`APPROVAL`) e os ramos (mínimo 2) com a primeira etapa de cada um.
2. O front cria, em sequência, as etapas `PARALLEL_SPLIT` e `PARALLEL_JOIN` (WF-10 com `type`), as etapas iniciais dos ramos (WF-10) e as transições `FORWARD`/`APPROVE` entre elas (WF-13): origem → split, split → primeira etapa de cada ramo, última etapa de cada ramo → join, join → destino. Cada escrita incrementa `WorkflowVersion.version` (RN-WF-06) e o front envia `If-Match` quando aplicável (RN-WF-51).
3. O administrador acrescenta etapas intermediárias aos ramos (WF-10/WF-13), ajusta responsável, prazo, documentos e aprovador **apenas nas etapas `TASK`/`APPROVAL`** dos ramos (o split e o join não aceitam esses campos).
4. O painel "Ramificações" (`ParallelStructurePanel`) chama WF-24 e mostra cada bloco: etapa de split, ramos (`branchKey` e etapas na ordem), etapa de junção e os problemas encontrados, com link para a etapa ou transição.
5. O administrador abre "Versões e publicação" → "Validar" (WF-20). Os problemas de paralelismo chegam em `validation.errors[]` com `code = WF_PARALLEL_INVALID` e `reason`; avisos continuam em `warnings[]`.
6. Com `errors[]` vazio, publica (WF-21, `If-Match`, `changeNotes`). Na mesma transação, o `WorkflowVersionPublisher` calcula e grava `WorkflowStage.branchKey` das etapas de cada ramo, congela o `definitionSnapshot` (com `branchKey`) e o `definitionHash` e emite `WorkflowVersionPublished`.
7. O diagrama (aba **Diagrama**) mostra o split e o join como nós próprios e os ramos em raias paralelas; a `DiagramFallbackList` indenta cada ramo sob o seu split.
8. Processos novos que resolverem essa versão (aplicabilidade — US-042) seguem o fluxo com ramos; processos em andamento continuam na versão em que foram criados (DEC-014).

## Fluxos alternativos
- **FA-01 — Publicação recusada:** havendo ao menos um `WF_PARALLEL_INVALID` (ou outro erro `WF_*`), a publicação responde 422 `WORKFLOW_INVALID` com **todos** os erros; a versão permanece `DRAFT` e nada é gravado (RN-WF-19).
- **FA-02 — Ramo com várias etapas e aprovação:** um ramo pode ter etapas `TASK` e `APPROVAL` encadeadas; a última etapa do ramo chega ao join por `FORWARD` (se `TASK`) ou `APPROVE` (se `APPROVAL`).
- **FA-03 — Devolução modelada:** o administrador cria transições `RETURN` dentro do ramo (para etapa anterior do mesmo ramo) e a partir de uma etapa do ramo para uma etapa anterior ao split; `RETURN` de fora do ramo para dentro dele é recusado na validação (`reason = RETURN_TARGET_INVALID`).
- **FA-04 — Remover ramificação:** excluir o split ou o join (WF-12) é bloqueado enquanto houver transições que os referenciem (RN-WF-50); o administrador remove antes as transições dos ramos. O front oferece "Remover ramificação" que apaga as transições e as etapas de ramo, com confirmação listando o que será removido.
- **FA-05 — Copiar versão com ramos:** criar nova versão a partir de uma versão com ramos (WF-08, RN-WF-22) clona etapas, transições e regras com novos ids; `branchKey` é recalculado na próxima publicação.
- **FA-06 — Rascunho temporariamente inválido:** o rascunho aceita estados intermediários inválidos (um split sem join ainda); só a validação e a publicação barram. O painel "Ramificações" mostra o que falta.
- **FA-07 — Versão publicada ou aposentada:** o painel e o diagrama são somente leitura (servidos do `definitionSnapshot`, com `branchKey` já gravado).

## Regras de negócio
- **RN-WF2-01** — `StageType` ganha `PARALLEL_SPLIT` e `PARALLEL_JOIN` (DEC-194). Etapa desses tipos **não tem** responsável, prazo nem aprovador: `slaDays`, `slaType`, `approverType` (e derivados), `assignmentPolicy` diferente de `UNASSIGNED`, `approvalDocumentTypeCodes` e `documentTypeCodes` são nulos/vazios (check de banco de `entities.md` §5.8). Escrita com esses campos preenchidos → 422 `VALIDATION_ERROR` (`NOT_ALLOWED`).
- **RN-WF2-02** — Todo `PARALLEL_SPLIT` tem **ao menos duas** transições `FORWARD` de saída (cada uma abre um ramo) e **exatamente um** `PARALLEL_JOIN` alcançável por todos os ramos; o par split/join forma um **bloco**. Violação → erro `WF_PARALLEL_INVALID` (`reason = SPLIT_BRANCHES_MIN` ou `SPLIT_JOIN_MISSING`).
- **RN-WF2-03** — Um nível apenas: **não há ramos aninhados** (um `PARALLEL_SPLIT` dentro de um ramo — `reason = NESTED_SPLIT`), **nem mais de um `PARALLEL_JOIN` por split**, **nem transição entre ramos** (aresta que sai de uma etapa de um ramo para etapa de outro ramo — `reason = CROSS_BRANCH_TRANSITION`) e **nem `PARALLEL_JOIN` sem split** (`reason = JOIN_WITHOUT_SPLIT`). Cada etapa de ramo pertence a um único ramo.
- **RN-WF2-04** — Todo ramo tem **ao menos uma** etapa `TASK`/`APPROVAL` entre o split e o join (transição direta split → join é `reason = BRANCH_EMPTY`) e **termina no join**: o ramo não alcança `END` sem passar pelo join e não usa `COMPLETE` (`reason = BRANCH_ESCAPES`). Todos os ramos de um split terminam no **mesmo** join (`reason = JOIN_NOT_COMMON`).
- **RN-WF2-05** — Compatibilidade ação × tipo (extensão da RN-WF-10): `FORWARD` sai de `START`/`TASK` **para** `PARALLEL_SPLIT`; `FORWARD` sai do `PARALLEL_SPLIT` **para** `TASK`/`APPROVAL` (uma por ramo); `FORWARD` sai de `TASK` do ramo para `PARALLEL_JOIN`; `APPROVE` sai de `APPROVAL` do ramo para `PARALLEL_JOIN`; o `PARALLEL_JOIN` tem **exatamente uma** transição de saída, `FORWARD`, para `TASK` ou `APPROVAL` (`reason = JOIN_EXIT_INVALID`). `RETURN`, `REJECT` e `COMPLETE` nunca partem de nem chegam a `PARALLEL_SPLIT`/`PARALLEL_JOIN`; `END` continua sem saídas.
- **RN-WF2-06** — `RETURN` num ramo só pode ter como destino uma etapa **do mesmo ramo** ou **anterior ao split** (e que já satisfaça a RN-WF-10: `START`/`TASK` com caminho de avanço até a origem); `RETURN` de etapa fora do bloco para etapa dentro de um ramo é inválido (`reason = RETURN_TARGET_INVALID`). A `REJECT` de uma `APPROVAL` de ramo continua voltando para a própria etapa de origem (RN-WF-13).
- **RN-WF2-07** — `WorkflowStage.branchKey` é **calculado** (nunca digitado) na publicação e na resposta de WF-24: é a `key` da **primeira etapa do ramo** (destino da transição `FORWARD` que sai do split) e vale para todas as etapas do ramo; etapas fora de ramos, o split e o join têm `branchKey` nulo. Duas etapas iniciais de ramos distintos nunca compartilham `key` (já garantido pela unicidade de `key` na versão). O valor vai para o `definitionSnapshot` (RFC 8785) e para o `definitionHash` (DEC-084).
- **RN-WF2-08** — Regras (`WorkflowRule`): `scope = STAGE_EXIT` é aceito no `PARALLEL_JOIN` (avalia o **processo inteiro** quando o último ramo chega — US-124) e **não** no `PARALLEL_SPLIT`, que não tem saída própria (`WF_RULE_SCOPE_INVALID`); regras `TRANSITION` valem na transição de saída do join e nas de entrada dos ramos. `REQUIRED_APPROVAL` com `stageKey` de uma etapa de ramo é aceita.
- **RN-WF2-09** — A validação (WF-20) reporta **todos** os erros de paralelismo de uma vez, cada um com `code = WF_PARALLEL_INVALID`, `reason`, `stageKey`/`transitionKey` e mensagem pt-BR; a publicação (WF-21) exige `errors[]` vazio e repete a validação dentro da transação (RN-WF-20, RN-WF-61). O catálogo de `reason` é fechado (ver Validações).
- **RN-WF2-10** — A versão publicada é imutável, inclusive `branchKey` e os tipos novos (trigger de banco — RN-WF-21/65); um ramo mal modelado só se corrige em nova versão, e processos que já estiverem na versão antiga continuam nela (DEC-014; migração opcional — US-126..US-128).
- **RN-WF2-11** — O uso do paralelismo é **opcional por tenant**: a existência dos tipos novos não altera versões existentes, o seeder do padrão (v1 e v2) não os usa e nenhum tenant precisa adotá-los (DEC-194, DEC-196). Dentro do limite de 50 etapas por versão (RN-WF-18), o split e o join consomem 2 etapas por bloco.
- **RN-WF2-12** — O editor e o diagrama tornam o paralelismo legível sem depender de cor: nós de split/join com ícone e rótulo ("Ramificação", "Junção"), cada etapa de ramo com o chip "Ramo: {branchKey}" e a lista alternativa (`DiagramFallbackList`) indentada por ramo, anunciável por leitor de tela.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo da etapa | `WorkflowStage.type` | `StageType` | Sim | + `PARALLEL_SPLIT`, `PARALLEL_JOIN` (WF-10/WF-11) | `TASK` |
| Chave da etapa | `WorkflowStage.key` | texto | Sim | ≤ 60, `SCREAMING_SNAKE_CASE`, única na versão, imutável (RN-WF-45) | digitada |
| Nome da etapa | `WorkflowStage.name` | texto | Sim | 3–150; em split/join sugere "Ramificação — {bloco}" / "Junção — {bloco}" | digitado |
| *(sistema)* Ramo da etapa | `WorkflowStage.branchKey` | texto ≤ 60 | Não | Somente leitura; calculado na publicação e em WF-24 (RN-WF2-07) | calculado |
| Responsável/prazo/aprovador | `departmentResolution`, `assignmentPolicy`, `slaDays`, `slaType`, `approverType`… | — | Não | Ocultos e recusados em split/join (RN-WF2-01) | — |
| Ação da transição | `WorkflowTransition.action` | `TransitionAction` | Sim | `FORWARD`, `APPROVE`, `RETURN` conforme RN-WF2-05/06 | `FORWARD` |
| Origem / destino | `fromStageId`, `toStageId` | uuid | Sim | Mesma versão, distintos (RN-WF-49) | selecionados |
| Bloco paralelo (assistente) | *(só UI)* | — | — | Nome do bloco, etapa de origem, destino da junção, ramos ≥ 2 com a primeira etapa | digitados |
| Resultado da validação | `validation.errors[]`/`warnings[]` | lista | — | `{ code, message, stageKey?, transitionKey?, ruleId?, reason? }` (`reason` aditivo) | WF-20 |
| Estrutura de ramos | `blocks[]` de WF-24 | lista | — | `splitStageKey`, `joinStageKey`, `branches[]`, `issues[]` | calculada |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Split/join com `slaDays`, `approverType`, `documentTypeCodes` ou `assignmentPolicy` ≠ `UNASSIGNED` | Front + API (Zod) | "Ramificação e junção não têm responsável, prazo nem aprovador. Configure esses dados nas etapas dos ramos." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-02 | `PARALLEL_SPLIT` com menos de 2 transições `FORWARD` de saída | API (WF-20/21) | "A ramificação \"{etapa}\" precisa de pelo menos dois ramos. Adicione outro caminho." | `WF_PARALLEL_INVALID` (`SPLIT_BRANCHES_MIN`) |
| V-03 | Split sem `PARALLEL_JOIN` alcançável por todos os ramos, ou mais de um join | API | "A ramificação \"{etapa}\" precisa terminar em uma única junção comum aos ramos." | `WF_PARALLEL_INVALID` (`SPLIT_JOIN_MISSING` / `JOIN_NOT_COMMON`) |
| V-04 | `PARALLEL_JOIN` sem split correspondente | API | "A junção \"{etapa}\" não está ligada a nenhuma ramificação." | `WF_PARALLEL_INVALID` (`JOIN_WITHOUT_SPLIT`) |
| V-05 | Split dentro de um ramo | API | "Não é possível ramificar dentro de um ramo. Use apenas um nível de ramificação." | `WF_PARALLEL_INVALID` (`NESTED_SPLIT`) |
| V-06 | Transição entre etapas de ramos diferentes | API | "A transição \"{transição}\" liga dois ramos diferentes. Os ramos só se encontram na junção." | `WF_PARALLEL_INVALID` (`CROSS_BRANCH_TRANSITION`) |
| V-07 | Ramo sem etapa (split → join direto) | API | "O ramo \"{transição}\" não tem nenhuma etapa. Adicione uma etapa ou remova o ramo." | `WF_PARALLEL_INVALID` (`BRANCH_EMPTY`) |
| V-08 | Ramo que chega a `END` sem passar pela junção ou usa `COMPLETE` | API | "O ramo de \"{etapa}\" precisa terminar na junção, não no fim do processo." | `WF_PARALLEL_INVALID` (`BRANCH_ESCAPES`) |
| V-09 | Junção sem exatamente uma saída `FORWARD` para `TASK`/`APPROVAL` | API | "A junção \"{etapa}\" precisa de uma única saída para a etapa seguinte." | `WF_PARALLEL_INVALID` (`JOIN_EXIT_INVALID`) |
| V-10 | `RETURN` de fora do ramo para dentro dele, ou entre ramos | API | "A devolução \"{transição}\" não pode entrar no meio de um ramo." | `WF_PARALLEL_INVALID` (`RETURN_TARGET_INVALID`) |
| V-11 | Ação incompatível com o tipo de etapa (ex.: `COMPLETE` a partir do split) | Front + API | "Esta ação não é permitida a partir de uma ramificação ou junção." | `WF_ACTION_NOT_ALLOWED_FROM_STAGE` |
| V-12 | Regra `STAGE_EXIT` no split | API | "A ramificação não tem saída própria; configure a regra na etapa anterior ou na junção." | `WF_RULE_SCOPE_INVALID` |
| V-13 | Versão fora de `DRAFT` | API | "Esta versão já foi publicada. Crie um novo rascunho para alterá-la." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-14 | `If-Match` divergente em WF-11/WF-14/WF-21 | API | "O workflow foi alterado por outra pessoa. Recarregue e tente de novo." | `VERSION_CONFLICT` |
| V-15 | Limite de 50 etapas/200 transições excedido pelo bloco | API | "O limite de etapas da versão foi atingido." | `BUSINESS_RULE_VIOLATION` (`WF_LIMIT_EXCEEDED` na validação) |

## Permissões
- **Permissão:** `WORKFLOW_MANAGE` para criar/editar etapas e transições do rascunho (WF-10, WF-11, WF-13, WF-14); `WORKFLOW_PUBLISH` para publicar (WF-21); `WORKFLOW_VIEW` para WF-09, WF-20 e WF-24 (leitura do diagrama e da estrutura). Escopo de tenant (não escopáveis — POL do MVP 1).
- **Políticas:** POL-14 (MFA); imutabilidade da versão publicada (RN-WF-21/65). Nenhuma permissão nova.
- **MFA:** exigido em `WORKFLOW_MANAGE`/`WORKFLOW_PUBLISH` (risco `H`) quando `security.mfaPolicy` ∈ {`ADMINS`, `ALL`}; sem MFA → 403 `MFA_REQUIRED`.
- **Sem permissão:** a UI oculta "Adicionar ramificação", "Publicar" e as ações de edição; leitores (`WORKFLOW_VIEW`) veem painel e diagrama em modo leitura. A API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowVersionPublished` | `workflow.version_published` | Publicação de versão (WF-21), com ou sem ramos | Payload do MVP 1 (`workflowId`, `workflowVersionId`, `versionNumber`, `definitionHash`) sem mudança; o `definitionHash` passa a cobrir `branchKey` e os tipos novos. Edição de rascunho não gera evento de domínio (como no MVP 1). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: modelar e publicar a versão não notifica ninguém (como no MVP 1). Os efeitos para quem trabalha os ramos começam na US-124 (`PARALLEL_BRANCH_RECEIVED`). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Modelar etapas paralelas no workflow

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO", com MFA válido na sessão
    And existe o workflow "LICITACAO_COM_RAMOS" com uma versão 2 em "DRAFT" copiada da versão 1 publicada
    And a versão 2 tem as etapas "ESTUDOS_PRELIMINARES" e "AUTORIZACAO_LICITACAO"

  Scenario: [Sucesso] Modelar e publicar uma ramificação com Jurídico e Controle Interno
    Given que "Marina" criou as etapas "RAMIFICACAO_ANALISES" (PARALLEL_SPLIT) e "JUNCAO_ANALISES" (PARALLEL_JOIN)
    And criou as etapas "JURIDICO" e "CONTROLE_INTERNO" do tipo "TASK" com prazos de 5 e 4 dias úteis
    And criou as transições "ESTUDOS_PRELIMINARES → RAMIFICACAO_ANALISES", "RAMIFICACAO_ANALISES → JURIDICO", "RAMIFICACAO_ANALISES → CONTROLE_INTERNO", "JURIDICO → JUNCAO_ANALISES", "CONTROLE_INTERNO → JUNCAO_ANALISES" e "JUNCAO_ANALISES → AUTORIZACAO_LICITACAO", todas com ação "FORWARD"
    When "Marina" validar a versão 2
    Then a resposta deve ter "valid" igual a true e "errors" vazio
    When "Marina" publicar a versão 2 com "changeNotes" "Jurídico e Controle Interno em paralelo"
    Then a API deve responder 200 com status "PUBLISHED"
    And as etapas "JURIDICO" e "CONTROLE_INTERNO" devem ter "branchKey" "JURIDICO" e "CONTROLE_INTERNO"
    And "RAMIFICACAO_ANALISES", "JUNCAO_ANALISES" e "ESTUDOS_PRELIMINARES" devem ter "branchKey" nulo
    And deve gerar registro de auditoria "workflow.version_publish" com "definitionHash"
    And deve gerar o evento WorkflowVersionPublished

  Scenario: [Sucesso] Consultar a estrutura de ramos do rascunho
    Given que a versão 2 tem o bloco "RAMIFICACAO_ANALISES" / "JUNCAO_ANALISES" completo
    When "Marina" consultar a estrutura de ramos da versão 2
    Then a resposta deve ter um bloco com "splitStageKey" "RAMIFICACAO_ANALISES" e "joinStageKey" "JUNCAO_ANALISES"
    And dois ramos "JURIDICO" e "CONTROLE_INTERNO", cada um com a sua etapa
    And "issues" vazio
    And não deve gerar registro de auditoria nem evento de domínio (leitura)

  Scenario: [Validação] Publicação recusada por split sem junção e sem segundo ramo
    Given que a versão 2 tem "RAMIFICACAO_ANALISES" com uma única transição de saída para "JURIDICO" e nenhuma junção
    When "Marina" tentar publicar a versão 2
    Then a API deve responder 422 com código "WORKFLOW_INVALID"
    And "validation.errors" deve conter "WF_PARALLEL_INVALID" com "reason" "SPLIT_BRANCHES_MIN" e "SPLIT_JOIN_MISSING" para "RAMIFICACAO_ANALISES"
    And a versão deve continuar "DRAFT" e nenhum evento deve ser gerado

  Scenario: [Validação] Todos os erros de paralelismo são reportados de uma vez
    Given que a versão 2 tem um split aninhado dentro do ramo "JURIDICO" e uma transição de "CONTROLE_INTERNO" para "JURIDICO"
    When "Marina" validar a versão 2
    Then "validation.errors" deve conter "WF_PARALLEL_INVALID" com "reason" "NESTED_SPLIT" e "CROSS_BRANCH_TRANSITION"

  Scenario: [Validação] Split ou join com prazo ou aprovador
    When "Marina" atualizar a etapa "RAMIFICACAO_ANALISES" com "slaDays" 3
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "slaDays"

  Scenario: [Permissão] Usuário sem permissão de edição
    Given que "Bruno" tem apenas "WORKFLOW_VIEW"
    When "Bruno" criar a etapa "JURIDICO" do tipo "PARALLEL_SPLIT"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Bruno" consultar a estrutura de ramos
    Then a API deve responder 200

  Scenario: [Permissão] Edição sem MFA
    Given que "Marina" está com a sessão sem MFA e "security.mfaPolicy" é "ADMINS"
    When "Marina" publicar a versão 2
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Versão de outro tenant
    Given que existe a versão "Prefeitura B / 3" com um bloco paralelo
    When "Marina", no tenant "Prefeitura A", consultar a estrutura de ramos dessa versão
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Chave de etapa repetida e publicação repetida
    When "Marina" criar outra etapa com "key" "JURIDICO" na versão 2
    Then a API deve responder 409 com código "CONFLICT"
    Given que a versão 2 já foi publicada
    When "Marina" reenviar a publicação com o mesmo "If-Match"
    Then a API deve responder 409 com código "INVALID_STATE" ou 412 com código "VERSION_CONFLICT"
    And não deve haver segundo evento WorkflowVersionPublished

  Scenario: [Concorrência] Duas edições simultâneas do rascunho
    Given que "Marina" e "Paulo" carregaram a etapa "JURIDICO" com o mesmo "ETag"
    When "Marina" atualizar o nome da etapa e depois "Paulo" atualizar o prazo com o "ETag" antigo
    Then a segunda chamada deve responder 412 com código "VERSION_CONFLICT"
    And a publicação concorrente com "If-Match" antigo também deve responder 412

  Scenario: [Falha de banco] Banco indisponível na publicação
    Given que o banco de dados está indisponível durante a publicação
    When "Marina" publicar a versão 2
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a versão deve continuar "DRAFT", sem "branchKey" gravado nem evento gerado

  Scenario: [Falha de integração] Falha ao gravar o evento no outbox
    Given que a gravação no outbox falha dentro da transação de publicação
    When "Marina" publicar a versão 2
    Then a transação inteira deve ser revertida
    And a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o diagrama da versão 2 deve continuar a exibir o rascunho
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Grafo de ramos inválido na validação/publicação | 422 | `WORKFLOW_INVALID` (itens `WF_PARALLEL_INVALID` com `reason`) | "A versão tem problemas nas ramificações. Corrija os itens listados e publique de novo." | `ValidationResultPanel` lista cada item com link; publicar desabilitado |
| Campo proibido em split/join | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Ramificação e junção não têm responsável, prazo nem aprovador." | Campos ocultos; erro inline se enviado |
| Ação incompatível com o tipo | 422 | `WF_ACTION_NOT_ALLOWED_FROM_STAGE` (em `validation.errors`) / `VALIDATION_ERROR` na escrita | "Esta ação não é permitida a partir desta etapa." | Opções de ação filtradas no `TransitionForm` |
| Versão não está em rascunho | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão já foi publicada. Crie um novo rascunho." | Botão "Criar rascunho" |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "O workflow foi alterado por outra pessoa. Recarregue e tente de novo." | Diálogo de conflito com "Recarregar" |
| Sem `If-Match` em publicação | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente de novo." | Recarrega a versão |
| `key` duplicada | 409 | `CONFLICT` | "Já existe uma etapa com essa chave nesta versão." | Erro no campo `key` |
| Limite de etapas | 422 | `BUSINESS_RULE_VIOLATION` | "O limite de 50 etapas da versão foi atingido." | Aviso no cabeçalho |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Ações ocultas |
| MFA ausente | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Fluxo de step-up |
| Versão inexistente/outro tenant | 404 | `NOT_FOUND` | "Versão não encontrada." | Volta para a lista |
| Banco/fila indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Toast com `correlationId` e "Tentar novamente" |

## Dependências
- **Stories:** US-040 (modelo, validação `WF_*`), US-043 (editor e WF-10..WF-15), US-045 (validação/publicação/snapshot), US-046 (diagrama, estendido aqui). Habilita US-124 (runtime), US-125, US-126/US-127 (classificação `PARALLEL_ACTIVE`) e as regras de roteamento do EP-031 (que não se aplicam a etapa `isLegallyRequired`).
- **Decisões/ADRs:** DEC-194, DEC-014, DEC-084, DEC-108, DEC-196; [ADR-005](../adr/adr-005-workflow-engine.md) (adendo de 2026-11-10).
- **Configurações:** nenhuma chave nova; a adoção é pela própria versão do tenant.
- **Lacunas nas fontes canônicas** (resolvidas na implementação, card spec-646 — as propostas abaixo foram adotadas e registradas em `docs/mvp-02/entities.md` §5.8, `docs/mvp-02/api.md` §2.2 e `docs/mvp-02/api/20-workflow-v2.md` WF-24; `reason` vai no próprio item de validação, e o WF-24 ganhou `issues` de topo para a junção solta):
  - `entities.md` §5.8 não define como `WorkflowStage.branchKey` é derivado: esta story adota a `key` da primeira etapa do ramo (RN-WF2-07), coerente com o cenário da FT-063 ("ramos `JURIDICO` e `CONTROLE_INTERNO`"). Confirmar no card 9.
  - Compatibilidade ação × tipo dos tipos novos, saída única do join para `TASK`/`APPROVAL` (sem ir direto a `END`), regras de `RETURN` ao redor do bloco e escopo `STAGE_EXIT` no split (RN-WF2-05/06/08) **não constam** de `entities.md`/ADR-005; adotadas aqui como decisão de modelagem a confirmar.
  - `api.md` do MVP 1 §2.3 não lista `WF_PARALLEL_INVALID` nem o membro `reason` dos itens de validação: acrescentar `reason` (aditivo) e o código no catálogo.
  - `entities.md` cita `splitProcessStageId` na entidade e `splitStageId` na DEC-194: a story usa `splitProcessStageId` (entities).
  - As rotas indicativas da FT-063 (`/workflows/{id}/versions/{versionId}/stages/{stageId}`) divergem das reais do MVP 1 (`/workflow-versions/{versionId}/stages`, `/workflow-stages/{stageId}`); esta story segue as reais.

## Impacto técnico
- **Compatibilidade (DEC-108):** `StageType` ganha dois valores e os itens de `validation` ganham `reason`; clientes do MVP 1 que ignoram campos desconhecidos continuam funcionando. Versões publicadas antes desta story não têm tipos novos nem `branchKey` e seu `definitionHash` **não muda** (o cálculo só inclui `branchKey` quando há bloco).
- **Banco (expand/contract):** `ALTER TYPE stage_type ADD VALUE` (não reversível, M2-01), coluna `workflow_stages.branch_key` nula, check do split/join; o trigger de imutabilidade passa a cobrir a coluna nova.
- **Validador:** algoritmo em dois passos — (1) marca blocos (split → join por alcançabilidade dominada), (2) aplica as regras de RN-WF2-02..06 sobre o subgrafo; deve ser determinístico e linear no número de arestas (limites da RN-WF-18). Teste de propriedade com grafos aleatórios e grafos-limite (50 etapas).
- **Segurança/auditoria:** toda escrita no rascunho audita `workflow.update`; a publicação audita `workflow.version_publish` com `metadata.parallelBlocks` (quantidade) e `definitionHash`.
- **Risco de complexidade (roadmap §4.10):** um nível de ramos, validação rígida, uso opcional e nenhuma mudança nos fluxos semeados.

## Backend
- **Módulo(s):** `workflow` (definição, validador, publicador); `audit`.
- **Casos de uso:** `CreateStageCommand`/`UpdateStageCommand` (estendidos), `CreateTransitionCommand`/`UpdateTransitionCommand` (compatibilidade ação × tipo), `ValidateWorkflowVersionQuery` (novo passo `ParallelGraphValidator`), `PublishWorkflowVersionCommand` (`WorkflowVersionPublisher` calcula `branchKey`), `GetVersionBranchesQuery` (WF-24).
- **Domínio:** `StageType` ampliado; `ParallelGraphValidator` (blocos, ramos, `reason`); `BranchKeyResolver` (derivação por primeira etapa do ramo); extensão de `StageActionCompatibility` (RN-WF2-05).
- **Integrações internas:** nenhuma chamada a `process`; o runtime (US-124) lê `branchKey` e a estrutura do `definitionSnapshot` pela fachada de `workflow`.
- **Transação:** publicar = validar + gravar `branchKey` + snapshot/hash + status + `currentPublishedVersionId` + retirar a anterior + auditoria + evento no outbox, atomicamente; falha reverte tudo.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`), abas **Etapas**, **Transições**, **Versões** e **Diagrama**.
- **Componentes:** `ParallelBlockWizard` ("Adicionar ramificação", no menu "Mais"), `StageTypeSelect` (com os tipos novos), `StagePropertiesPanel` (oculta campos de responsável/prazo/aprovador em split/join), `BranchChip` ("Ramo: JURIDICO"), `ParallelStructurePanel` (WF-24), `ValidationResultPanel` (item `WF_PARALLEL_INVALID` com `reason` e link), `WorkflowDiagram` com `StageNode` de split/join e raias por ramo, `DiagramFallbackList` indentada, `RemoveBlockConfirmDialog`.
- **Estados:** loading (skeleton nas abas e no painel), vazio ("Nenhuma ramificação nesta versão — adicione uma quando precisar de etapas simultâneas"), erro (WF-20/WF-24 com "Tentar novamente"), sucesso (toast "Versão N publicada"), concorrência (412 com `ConflictDialog`), somente leitura para versão publicada.
- **Acessibilidade e responsividade:** nós e ramos com `aria-label` e ícone + texto (nunca só cor); navegação por teclado no assistente e na lista de ramos; lista de erros com foco no primeiro item; painel lateral modal abaixo de 768 px; minimapa oculto abaixo de 768 px; contraste AA.

## Banco de dados
- **Tabelas:** `workflow_stages` (altera: `type` + valores novos; `branch_key` varchar(60) nulo); `workflow_versions` (sem coluna nova; `definition_snapshot` passa a incluir `branchKey`).
- **Migrações:** expand — enum e coluna nula; check `type NOT IN ('PARALLEL_SPLIT','PARALLEL_JOIN') OR (sla_days IS NULL AND approver_type IS NULL)`; trigger de imutabilidade atualizado. Sem backfill (versões existentes não têm blocos).
- **Índices/constraints relevantes:** unicidade de `key` por versão (existente); `(tenant_id, workflow_version_id, branch_key) WHERE branch_key IS NOT NULL` não único (consulta por ramo); RLS por `tenant_id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-24 | GET | `/workflow-versions/{versionId}/branches` | — (path `versionId`) | `200 { data: { blocks: [{ splitStageKey, joinStageKey\|null, branches: [{ branchKey, entryStageKey, stageKeys[], exitTransitionKey\|null }], issues: [{ code, reason, message, stageKey?, transitionKey? }] }], stageBranch: { [stageKey]: branchKey } } }`; `ETag` = `WorkflowVersion.version`; rascunho calculado na hora, publicada lida do snapshot | 200, 403, 404, 503 |
| WF-09 | GET | `/workflow-versions/{versionId}` | — | MVP 1 + `stages[].type` com os valores novos e `stages[].branchKey` (aditivo) | 200, 403, 404, 503 |
| WF-10 | POST | `/workflow-versions/{versionId}/stages` | MVP 1; `type` aceita `PARALLEL_SPLIT`/`PARALLEL_JOIN` (sem SLA/aprovador) | `201 { data: WorkflowStage }` | 201, 403, 409, 422 |
| WF-11 | PATCH | `/workflow-stages/{stageId}` | MVP 1 (`If-Match`); mesmas restrições de WF-10 | `200` + `ETag` | 200, 403, 409, 412, 422 |
| WF-13 | POST | `/workflow-versions/{versionId}/transitions` | MVP 1; compatibilidade ação × tipo estendida (RN-WF2-05) | `201 { data: WorkflowTransition }` | 201, 403, 409, 422 |
| WF-14 | PATCH | `/workflow-transitions/{transitionId}` | MVP 1 (`If-Match`) | `200` + `ETag` | 200, 403, 409, 412, 422 |
| WF-20 | POST | `/workflow-versions/{versionId}/validate` | — | `200 { data: { valid, errors[], warnings[] } }` com itens `WF_PARALLEL_INVALID` e `reason` | 200, 404 |
| WF-21 | POST | `/workflow-versions/{versionId}/publish` | `{ changeNotes? }`; `If-Match` obrigatório | `200 { data: WorkflowVersion }` (`branchKey` gravado) | 200, 403, 404, 409, 412, 422 (`WORKFLOW_INVALID`), 428 |

## Logs
- `info` `workflow.parallel_graph_validated` com `versionId`, `blocks`, `branches`, `errorsCount`, `durationMs`.
- `info` `workflow.version_published` com `versionId`, `versionNumber`, `parallelBlocks`, `definitionHash`.
- `warn` `workflow.parallel_validation_failed` com `versionId` e a lista de `reason` (sem nomes de etapa em texto livre).
- `error` `workflow.publish_failed` com `versionId`, `correlationId` e a causa técnica.
- Nunca logar: `instructions` das etapas, mensagens de regras com dados do órgão, tokens, `Idempotency-Key`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.update` | `CONFIGURATION` | Criar/editar etapa ou transição do rascunho (WF-10/11/13/14) | `metadata`: `stageId`/`transitionId`, `versionId`, `stageType`, `action`; `changes`: campos alterados |
| `workflow.version_publish` | `CONFIGURATION` | WF-21 | `metadata`: `versionNumber`, `definitionHash`, `changeNotes`, `parallelBlocks` |
| `access.denied` | `ACCESS` | 403 em qualquer endpoint da story | `metadata`: permissão exigida, rota |

## Testes necessários
- **Unitários:** `ParallelGraphValidator` para cada `reason` (um caso mínimo por código), grafos válidos com 2, 3 e 5 ramos, ramos com `APPROVAL`, bloco no limite de 50 etapas; `BranchKeyResolver`; compatibilidade ação × tipo (tabela completa); estabilidade do `definitionHash` para versões sem bloco (regressão do MVP 1); teste de propriedade com grafos aleatórios (validador determinístico).
- **Integração (Testcontainers):** check de banco de split/join (SLA e aprovador), trigger de imutabilidade para `branch_key`, publicação atômica com rollback em falha do outbox, WF-24 sobre rascunho e sobre versão publicada.
- **API/contrato:** WF-09/WF-10/WF-11/WF-13/WF-14/WF-20/WF-21 contra o OpenAPI (campos aditivos, `reason`); snapshot de contrato do MVP 1 sem quebra.
- **RBAC e multi-tenant:** `WORKFLOW_VIEW` × `WORKFLOW_MANAGE` × `WORKFLOW_PUBLISH`; MFA; novo arquivo na suíte `test/tenant-leak` para WF-24 e para as escritas de etapa/transição com tipos novos entre tenants.
- **Concorrência:** duas escritas com o mesmo `ETag`, publicação concorrente (`If-Match` antigo → 412), segunda publicação após a primeira.
- **E2E (Playwright):** administrador cria o bloco pelo assistente, vê o erro de validação, corrige, publica e vê o diagrama com raias; leitor vê somente leitura.
- **Acessibilidade/performance:** axe sem violações sérias no editor com bloco; navegação por teclado no assistente e na lista de ramos; validação de versão de 50 etapas com 5 ramos abaixo de 300 ms (teste de performance, medido no endurecimento).

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
- [ ] Um teste por `reason` de `WF_PARALLEL_INVALID` e teste de regressão do `definitionHash` das versões sem bloco
- [ ] `api.md`/`entities.md` do MVP 2 registram `WF-24`, o membro `reason` e a derivação de `branchKey`

## Estimativa
**L** — três frentes acopladas: extensão do modelo e do validador de grafo (RN-WF2-01..08, catálogo de `reason`), publicação com `branchKey`/snapshot/hash sem regredir versões existentes e editor/diagrama com raias e assistente, tudo com testes de propriedade. Sem integração externa nem fila.

## Prioridade
**P0** — primeiro card de implementação do MVP 2 (DT-03, DEC-192): US-124 e US-125 dependem desta definição e o paralelismo de Jurídico e Controle Interno por tenant (DEC-196) só é possível com ela.
