---
id: US-198
title: "Alçadas por valor"
epic: EP-031
feature: FT-089
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-133, US-195]
modules: [workflow, approval, rules, process, access, audit]
screens: [SCR-034, SCR-014, SCR-015]
endpoints: [WF-82, WF-83, WF-20, WF-21, PRC-19, PRC-71, APV-02, APV-46, RUL-01]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE, WORKFLOW_PUBLISH, RULE_VIEW, PROCESS_VIEW, PROCESS_FORWARD, APPROVAL_VIEW]
events: [ApprovalRequested, WorkflowVersionPublished]
---

# US-198 — Alçadas por valor

## Título
Alçadas por valor

## Descrição
**Como** administrador do órgão, **quero** definir, por faixa de valor, qual política de decisão (`ANY`, `ALL` ou `SEQUENTIAL`) e quais aprovadores valem para a aprovação de uma etapa, **para** que a alçada de decisão acompanhe o valor do processo sem manter workflows paralelos por faixa e com o motivo registrado em cada aprovação.

A story acrescenta às etapas `APPROVAL` a **alçada por valor** sobre a aprovação múltipla: `WorkflowStage.decisionPolicyRules` (`[{ when, policy }]`, a primeira faixa verdadeira escolhe a política) e `WorkflowStageApprover.applicabilityRule` (a linha de aprovador só entra na aprovação quando a regra é verdadeira). Ambas usam regras `APPROVAL_THRESHOLD` da biblioteca por versão fixada, avaliadas sobre o `RuleContext` v2 no momento em que a aprovação é solicitada. Entrega a configuração no editor (SCR-034), a pré-visualização da resolução (WF-83), as validações de publicação, a resolução atômica na solicitação da aprovação (US-133), seu registro na `Approval` e a visibilidade da alçada aplicada em SCR-014/SCR-015.

## Contexto
- A DEC-193 criou a aprovação com múltiplos aprovadores: `Approval.decisionPolicy` (`ANY`, `ALL`, `SEQUENTIAL`) e uma linha `ApprovalApprover` por aprovador, com a lista ordenada `WorkflowStageApprover` na etapa. A DEC-204 e a ADR-015 permitem que a resolução do aprovador e da política "varie por faixas avaliadas sobre o contexto". Esta story é essa variação.
- US-132 ("Configurar política de decisão e aprovadores ordenados na etapa") entrega a política padrão e as linhas da etapa; US-133 ("Solicitar aprovação com múltiplos aprovadores") entrega a criação da `Approval` com as linhas. A US-198 **estende** a US-133 com um ponto de resolução (`ThresholdResolver`) executado antes de gravar as linhas; sem faixa que case, vale o comportamento da US-133 (política e linhas da etapa).
- A decisão (votos, encerramento, segregação, concorrência) é das US-134 a US-136 e não muda; aqui só se define **quais linhas e qual política** a aprovação nasce.
- Modelo pronto: `ALCADA_AUTORIDADE_POR_VALOR` (`APPROVAL_THRESHOLD`, US-196), com o exemplo da feature FT-089: até R$ 500.000,00 `ANY`, acima `ALL`.
- Valores de orçamento sigiloso entram na avaliação (do servidor), mas nunca saem em mensagem, evento, auditoria ou resolução gravada (POL-09, RN-RULE-15 da feature).
- A aprovação avulsa de documento (`subjectType = DOCUMENT`) e a do PCA (`subjectType = PCA`) não usam a alçada por etapa; seguem `approvalPolicy` do tipo de documento (DT-17) e a política do PCA.

## Objetivo
Resolver a política e os aprovadores por faixa em 100% das aprovações de etapas com alçada configurada, gravar a resolução (regra, versão e linhas) em toda `Approval` criada, nunca deixar uma aprovação sem aprovador aplicável e manter idêntico o comportamento de etapas sem alçada.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `WORKFLOW_MANAGE`, `WORKFLOW_PUBLISH` e `RULE_VIEW`) — configura e publica.
- **Secundárias:** Autoridade competente (`AUTORIDADE_COMPETENTE`) e demais aprovadores, que decidem conforme a alçada e veem por que foram incluídos; Gestor de contratações (`GESTOR_CONTRATACOES`), que vê quem decidirá ao encaminhar; Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), que conferem a alçada aplicada.

## Pré-condições
- `WorkflowVersion` em `DRAFT` com etapa `APPROVAL` já com a política padrão e as linhas de aprovador (US-132) e regras `APPROVAL_THRESHOLD` publicadas, ativas e não-modelo na biblioteca (US-194, US-196).
- Para configurar: `WORKFLOW_MANAGE` e `RULE_VIEW`; para publicar: `WORKFLOW_PUBLISH`. Para encaminhar à etapa de aprovação: `PROCESS_FORWARD` + POL-01.
- `RuleContext` v2 com os provedores citados pelas regras (US-129), em especial `process.estimatedValue`.

## Fluxo principal
1. No editor (SCR-034), na etapa `AUTORIZACAO_LICITACAO` (tipo `APPROVAL`, política padrão `ANY`, três linhas: 1 "Secretário de Administração", 2 "Procurador-Geral", 3 "Prefeito"), o administrador abre a seção "Alçada por valor".
2. Em "Política por faixa", adiciona a faixa "Acima do limite → `ALL`" escolhendo a regra `ALCADA_ACIMA_500K` (cópia de `ALCADA_AUTORIDADE_POR_VALOR` com limite de R$ 500.000,00); define a ordem das faixas (a primeira verdadeira vence) e mantém a política padrão `ANY` para o resto.
3. Em "Aprovadores por faixa", define na linha 3 "Prefeito" a regra "Aplica-se quando…" `ALCADA_ACIMA_500K`; as linhas 1 e 2 ficam "Sempre".
4. O front envia WF-82 com `If-Match` da etapa. A API valida referências, tipo de etapa e linhas existentes, grava e audita `workflow.update`.
5. Antes de publicar, "Simular alçada" (WF-83) com um processo hipotético de R$ 120.000,00 mostra "Política `ANY`; aprovam: Secretário de Administração, Procurador-Geral (Prefeito não se aplica)" e com R$ 900.000,00 "Política `ALL`; aprovam: os três"; avisos aparecem se algum valor deixar a aprovação sem aprovador.
6. Ao validar e publicar (WF-20/WF-21), a API confere as referências (US-195), `WF_APPROVERS_INVALID` e a cobertura por amostragem de fronteira; grava `ruleRefs` com `useType` `DECISION_POLICY` e `APPROVER_APPLICABILITY`.
7. Em execução, o gestor encaminha o processo `0051/2026` (R$ 900.000,00) para `AUTORIZACAO_LICITACAO`. O modal (PRC-71) antecipa "Aprovação por `ALL`: Secretário de Administração, Procurador-Geral e Prefeito".
8. PRC-19 cria a `Approval` pela US-133; antes de gravar as linhas, o `ThresholdResolver` avalia as faixas sobre o `RuleContext` v2, escolhe `ALL`, seleciona as linhas 1, 2 e 3, renumera `sequence` 1..3, grava `decisionPolicy`, as `ApprovalApprover` e a **resolução** (`thresholdResolution`) na mesma transação, audita `approval.request` e grava `ApprovalRequested` (com `decisionPolicy`, `approvers[]` e a resolução, sem valores).
9. Em SCR-014/SCR-015, cada aprovador vê "Alçada aplicada: acima do limite (regra ALCADA_ACIMA_500K v1) — política `ALL`" e a lista de aprovadores; APV-46 detalha as linhas incluídas e as que não se aplicaram. O processo `0050/2026` (R$ 120.000,00) gera a aprovação com `ANY` e as linhas 1 e 2.
10. Se a aprovação for devolvida e o processo reenviado, uma **nova** `Approval` é resolvida de novo com o contexto do momento (DEC-193).

## Fluxos alternativos
- **FA-01 — Nenhuma faixa casa:** vale a política padrão da etapa (`WorkflowStage.decisionPolicy`) e as linhas sem regra ou com regra verdadeira.
- **FA-02 — Só alçada de aprovador:** a etapa pode ter apenas regras por linha (sem `decisionPolicyRules`); a política é a padrão e entram as linhas aplicáveis.
- **FA-03 — Só alçada de política:** a etapa pode ter apenas `decisionPolicyRules`; todas as linhas entram.
- **FA-04 — Uma só linha aplicável:** com política resolvida `ALL` ou `SEQUENTIAL` e uma única linha aplicável, a aprovação é criada com a política resolvida e se comporta como decisão única (D-01).
- **FA-05 — Nenhuma linha aplicável:** o encaminhamento é recusado (`APPROVAL_NO_APPLICABLE_APPROVER`) e o processo continua onde está; o gestor aciona o administrador (a publicação e o simulador previnem a maioria dos casos).
- **FA-06 — Erro ao avaliar:** o encaminhamento é recusado (`RULE_EVALUATION_FAILED`) sem efeito parcial; nunca se escolhe aprovador "no escuro".
- **FA-07 — Valor sigiloso:** a alçada é avaliada com o valor real no servidor; a tela do gestor mostra a política e as linhas, nunca o valor ou a faixa numérica; quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` não vê números em lugar nenhum da resolução.
- **FA-08 — Redirecionar ou retirar:** redirecionar uma linha (US-135) troca o aprovador **daquela linha**, sem reavaliar faixas; retirar cancela a aprovação inteira.
- **FA-09 — Remover a alçada:** `decisionPolicyRules = []` e `applicabilityRule = null` nas linhas voltam ao comportamento da US-133; aprovações em andamento não mudam.
- **FA-10 — Etapa sem alçada:** etapas `APPROVAL` com um aprovador e política `ANY` (MVP 1) e sem regras seguem idênticas, sem nenhuma resolução gravada.

## Regras de negócio
- **RN-RULE-77** — A alçada vale só para etapas `APPROVAL` (aprovação de assunto `PROCESS_STAGE`): política por faixa em `WorkflowStage.decisionPolicyRules` e aprovador por faixa em `WorkflowStageApprover.applicabilityRule`, ambos avaliados sobre o `RuleContext` v2 do processo no instante da solicitação (DEC-204, DEC-193).
- **RN-RULE-78** — `decisionPolicyRules` é uma lista **ordenada** de `{ when, policy }`: a primeira faixa cujo `when` é verdadeiro define a política; se nenhuma casar, vale `WorkflowStage.decisionPolicy` (padrão `ANY`). Até 10 faixas por etapa (limite a confirmar, L-03).
- **RN-RULE-79** — `when` e `WorkflowStageApprover.applicabilityRule` aceitam só `RuleRef` em modo `LIBRARY`, versão `PUBLISHED`, regra ativa e `kind = APPROVAL_THRESHOLD`, com resultado booleano; `INLINE` é recusado para garantir os casos de teste das alçadas (RN-RULE-12 da feature; D-02). `applicabilityRule` nula = a linha entra sempre.
- **RN-RULE-80** — A resolução ocorre **na criação da `Approval`** da etapa (encaminhamento de PRC-19 para a etapa `APPROVAL` e reenvio após devolução), dentro da transação da US-133: `ThresholdResolver` escolhe a política, filtra as linhas aplicáveis e só então elas são resolvidas em usuário, perfil ou titular da unidade pelos mecanismos da US-133.
- **RN-RULE-81** — As linhas incluídas mantêm a ordem relativa de `WorkflowStageApprover.sequence` e viram `ApprovalApprover` com `sequence` contígua `1..n`; em `SEQUENTIAL`, só a primeira nasce `PENDING` e as demais `WAITING` (entities.md §6.6). A linha de origem de cada `ApprovalApprover` fica registrada na resolução.
- **RN-RULE-82** — **Sem linha aplicável** (zero após a avaliação): 422 `APPROVAL_NO_APPLICABLE_APPROVER`, nenhuma mutação (nem movimento, nem `Approval`, nem evento); o processo permanece na etapa de origem.
- **RN-RULE-83** — Com política resolvida `ALL` ou `SEQUENTIAL` e **uma** linha aplicável, a aprovação é criada com a política resolvida e se comporta como decisão única (um voto encerra); o mínimo de 2 linhas de `ALL`/`SEQUENTIAL` vale para a **configuração** da etapa (US-132, `WF_APPROVERS_INVALID`), não para a resolução em execução (D-01).
- **RN-RULE-84** — **Registro da resolução:** `Approval.thresholdResolution` (jsonb, proposta L-01) guarda `{ policy, policySource: 'RULE' | 'STAGE_DEFAULT', policyRule?: { ruleDefinitionId, key, label, versionNumber, ruleDefinitionVersionId }, contextVersion, lines: [{ workflowStageApproverId, sequence, resolvedSequence?, label, included, reason: 'ALWAYS' | 'RULE_TRUE' | 'RULE_FALSE', rule? }], evaluatedAt }`, **sem valores do contexto**, imutável; o evento `ApprovalRequested` leva o mesmo resumo (aditivo, DEC-108).
- **RN-RULE-85** — A resolução é fixa na criação: mudança posterior do valor do processo **não** reescreve aprovações já abertas; uma nova aprovação (reenvio após devolução, DEC-193) resolve de novo com o contexto do momento (RN-RULE-14 da feature).
- **RN-RULE-86** — **Falha segura:** erro ao avaliar uma regra da alçada (caminho ausente, tipo inesperado) ou indisponibilidade de provedor do contexto recusa a criação da aprovação (`RULE_EVALUATION_FAILED` 422 ou 503), sem efeito parcial; ao contrário da dispensa de etapa (US-197), não há escolha "segura" por omissão em aprovação.
- **RN-RULE-87** — **Sigilo (POL-09):** o valor de orçamento sigiloso entra na avaliação do servidor e **nunca** é gravado nem exibido na resolução, no evento, na auditoria, em log, na notificação ou na tela; a resolução mostra regra, versão, política e linhas, nunca números.
- **RN-RULE-88** — **Validação na publicação** (WF-20/WF-21), além das da US-195: etapa com alçada deve ser `APPROVAL` e ter as linhas da US-132; referências válidas; política configurada `ALL`/`SEQUENTIAL` com ao menos 2 linhas; e **cobertura por amostragem de fronteira**: para o conjunto de valores de fronteira extraídos das expressões (constantes comparadas a `process.estimatedValue`, mais valor nulo, zero e um valor muito alto), toda amostra deve deixar ao menos uma linha aplicável; falha = `WF_APPROVERS_INVALID` (`reason = NO_APPLICABLE_APPROVER`, com a amostra). A amostragem não prova cobertura total; o simulador mostra o caso concreto.
- **RN-RULE-89** — Configurar (WF-82) só vale em `WorkflowVersion` `DRAFT`; é uma gravação **substitutiva** e atômica das faixas de política e das regras de linha (`PUT`), com `If-Match` da etapa; as linhas (`WorkflowStageApprover`) em si são da US-132 e não são criadas nem removidas aqui.
- **RN-RULE-90** — A pré-visualização (WF-83) avalia as mesmas regras sobre um processo visível (`PROCESS_VIEW`) **ou** um contexto hipotético completado com padrões neutros (US-199) e devolve política, origem (`RULE` ou `STAGE_DEFAULT`), linhas com `included`/`reason` e avisos (`NO_APPLICABLE_APPROVER`, `POLICY_WITH_SINGLE_LINE`, `POLICY_NEEDS_TWO_LINES`); não persiste nada nem gera evento ou auditoria de domínio.
- **RN-RULE-91** — A segregação (`approval.preventSelfApproval`), o substituto (`allowDeputy`) e a designação (POL-03) continuam avaliados **por linha na decisão** (US-134); a resolução não remove linha por segregação.
- **RN-RULE-92** — Redirecionar uma linha (US-135, `APPROVAL_REASSIGN`) e retirar a aprovação (POL-17) agem sobre as linhas já resolvidas, sem reavaliar faixas nem alterar `thresholdResolution`.
- **RN-RULE-93** — **Visibilidade:** SCR-014/SCR-015 mostram "Alçada aplicada" (regra, versão e política) e a lista de aprovadores; APV-46 detalha, a quem tem `APPROVAL_VIEW` ou é aprovador designado, as linhas incluídas e as que não se aplicaram (com o rótulo e o motivo "não se aplica por faixa", sem expressão nem número).
- **RN-RULE-94** — A solicitação é idempotente (`Idempotency-Key` de PRC-19): o replay devolve a mesma aprovação, sem nova resolução, evento ou auditoria; concorrência segue o bloqueio da US-133 (uma única aprovação `PENDING` por etapa, entities.md §4.6/MVP 1).
- **RN-RULE-95** — Compatibilidade (DEC-108): etapa sem `decisionPolicyRules` e sem regra de linha mantém o comportamento da US-133/MVP 1; campos novos são aditivos; `Approval` sem resolução responde APV-46 com `hasThresholds = false`.
- **RN-RULE-96** — Permissões: configurar exige `WORKFLOW_MANAGE` e `RULE_VIEW`; publicar, `WORKFLOW_PUBLISH`; simular, `WORKFLOW_VIEW` (mais `PROCESS_VIEW` no modo real ou `RULE_VIEW` no hipotético); ver a resolução, `APPROVAL_VIEW` ou designação. Nenhuma permissão nova; isolamento por tenant em todas as leituras e gravações.

Regras do MVP 1 e do MVP 2 que se aplicam, sem renumerar: **RN-WF-54** (escrita só em `DRAFT`), **RN-WF-61** (erros bloqueiam a publicação), **RN-TRAM-43** a **RN-TRAM-52** do MVP 1 (solicitação de aprovação: pontos de disparo, resolução do aprovador, `dueAt` e título; `ANY` com uma linha segue idêntico) e as regras da aprovação múltipla das US-132 a US-136 (linhas, `WAITING`, encerramento).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Faixas de política | `decisionPolicyRules` | lista ordenada | Não | até 10 itens (L-03); cada item `{ when, policy, label? }` | `[]` |
| Regra da faixa | `decisionPolicyRules[].when` | `RuleRef` (`LIBRARY`) | Sim (por faixa) | `kind = APPROVAL_THRESHOLD`, versão `PUBLISHED`, regra ativa, não-modelo | — |
| Política da faixa | `decisionPolicyRules[].policy` | `ApprovalDecisionPolicy` | Sim (por faixa) | `ANY`, `ALL` ou `SEQUENTIAL` | — |
| Rótulo da faixa | `decisionPolicyRules[].label` | texto | Não | até 120 caracteres | nome da regra |
| Política padrão | `WorkflowStage.decisionPolicy` | `ApprovalDecisionPolicy` | Sim (US-132) | vale se nenhuma faixa casar | `ANY` |
| Aplica-se quando (por linha) | `approverRules[].applicabilityRule` | `RuleRef` (`LIBRARY`) ou nulo | Não | mesmas regras; nulo = sempre | nulo |
| Linha do aprovador | `approverRules[].sequence` | inteiro 1..20 | Sim | deve existir entre as linhas da etapa (US-132) | — |
| *(sistema)* Resolução da alçada | `Approval.thresholdResolution` | jsonb | — | RN-RULE-84; sem valores; imutável; proposta L-01 | calculado |
| *(sistema)* Política resolvida | `Approval.decisionPolicy` | enum | — | resultado da faixa ou padrão | calculado |
| *(consulta)* Processo | `processId` | uuid | Condicional (WF-83) | visível ao usuário; exclusivo com `context` | — |
| *(consulta)* Contexto hipotético | `context` | `DeepPartial<RuleContextV2>` | Condicional (WF-83) | só caminhos do contexto v2; completado com padrões neutros | — |
| *(sistema)* Concorrência | `If-Match` (etag da etapa) | texto | Sim (WF-82) | — | calculado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `when` ou regra de linha em modo `INLINE`, ou `policy` fora de `ANY`/`ALL`/`SEQUENTIAL` | Front + API (Zod) | "Use uma regra da biblioteca e escolha uma política válida." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-02 | Referência inexistente, de outro tenant ou sem `RULE_VIEW` | API | "Selecione uma regra válida da biblioteca." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | Versão não publicada, regra inativa ou `kind` diferente de `APPROVAL_THRESHOLD` | API | "Esta regra não pode ser usada como alçada: {motivo}." | `RULE_VERSION_NOT_PUBLISHED` / `RULE_INACTIVE` / `RULE_KIND_MISMATCH` |
| V-04 | Etapa que não é `APPROVAL`, ou `sequence` que não existe entre as linhas | API | "A alçada só vale para etapas de aprovação com aprovadores configurados." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Mais de 10 faixas | Front + API | "Use até 10 faixas de política." | `VALIDATION_ERROR` (`TOO_MANY`) |
| V-06 | Versão de workflow não é `DRAFT` | API | "Esta versão do workflow não pode mais ser editada." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-07 | Configuração que deixa algum valor de fronteira sem aprovador, ou política `ALL`/`SEQUENTIAL` com menos de 2 linhas | API (WF-20/21) | "Para o valor {amostra} nenhum aprovador se aplica. Ajuste as faixas." | `WORKFLOW_INVALID` (`WF_APPROVERS_INVALID`) |
| V-08 | Referência inválida na publicação | API | "A regra {nome} usa uma versão que não pode ser publicada: {motivo}." | `WORKFLOW_INVALID` (`WF_RULE_REF_INVALID`) |
| V-09 | `If-Match` ausente ou divergente (WF-82) | API | "Os dados foram alterados. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-10 | WF-83 com `processId` e `context` juntos, ou com nenhum dos dois | Front + API | "Informe um processo ou monte um contexto, não os dois." | `VALIDATION_ERROR` |
| V-11 | `context` com caminho fora do contexto v2 | API | "O campo {caminho} não existe no contexto." | `VALIDATION_ERROR` (`PATH_UNKNOWN`) |
| V-12 | Encaminhar com nenhuma linha aplicável | API (PRC-19) | "Nenhum aprovador se aplica a este processo. Procure o administrador do workflow." | `APPROVAL_NO_APPLICABLE_APPROVER` |
| V-13 | Erro ao avaliar a regra da alçada | API (PRC-19) | "Não foi possível definir os aprovadores agora. Tente novamente ou procure o administrador." | `RULE_EVALUATION_FAILED` |

## Permissões
- **Permissão:** `WORKFLOW_MANAGE` e `RULE_VIEW` para configurar (WF-82); `WORKFLOW_VIEW` para simular (WF-83) e validar (WF-20), com `PROCESS_VIEW` no modo de processo real e `RULE_VIEW` no hipotético; `WORKFLOW_PUBLISH` para publicar; `PROCESS_FORWARD` + POL-01 para o encaminhamento; `APPROVAL_VIEW` ou designação (POL-03) para APV-02/APV-46.
- **Políticas:** POL-03 (designação, substituto e segregação por linha, inalterada), POL-09 (sigilo), POL-17 e `APPROVAL_REASSIGN` (por linha), POL-27 (regras e publicação), POL-14 (MFA na publicação).
- **MFA:** WF-21 segue o MVP 1 (`WORKFLOW_PUBLISH` é `HIGH`; `security.mfaPolicy`). Configurar e simular alçada não exigem MFA própria.
- **Sem permissão:** seção "Alçada por valor" oculta sem `WORKFLOW_MANAGE`; resolução oculta a quem não vê a aprovação; a API responde 403 `PERMISSION_DENIED` (com `reasonCode`) e registra `access.denied`; processo ou aprovação não visível: 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalRequested` (MVP 1/2) | `approval.requested` | Commit de PRC-19 que cria a aprovação da etapa com alçada | Payload com `decisionPolicy` e `approvers[]` (só as linhas incluídas) e, aditivo, `thresholdResolution` (sem valores; L-02); consumidores T, A, N como hoje |
| `WorkflowVersionPublished` (MVP 1) | `workflow.version_published` | Commit de WF-21 | Versão publicada com as referências da alçada em `ruleRefs` (US-195) |

Configurar a alçada no rascunho (WF-82) e simular (WF-83) não geram evento de domínio.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_REQUESTED` (MVP 1, uso ampliado) | Aprovador de cada linha `PENDING` **incluída pela alçada** (titular e substituto se `allowDeputy`; perfil como no MVP 1) | In-app (e e-mail conforme preferências, US-113) | No commit de PRC-19, a partir de `ApprovalRequested`; linhas não incluídas **não** são notificadas e linhas `WAITING` só quando ativadas (`APPROVAL_TURN`/`APPROVAL_REQUESTED`) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Alçadas por valor

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (WORKFLOW_MANAGE, WORKFLOW_PUBLISH, RULE_VIEW)
    And "Rafael" tem vínculo ativo com o perfil "GESTOR_CONTRATACOES" com custódia dos processos de teste
    And "Bruno" tem vínculo ativo com o perfil "PLANEJAMENTO" sem "WORKFLOW_MANAGE"
    And a regra "ALCADA_ACIMA_500K" (tipo "APPROVAL_THRESHOLD", versão 1 publicada, valor acima de R$ 500.000,00, valor nulo na faixa mais alta) está na biblioteca
    And a etapa "AUTORIZACAO_LICITACAO" (tipo "APPROVAL", política padrão "ANY") tem as linhas 1 "Secretário de Administração", 2 "Procurador-Geral" e 3 "Prefeito"

  Scenario: [Sucesso] Configurar faixas de política e aprovador por faixa
    When "Marina" salvar a faixa "ALCADA_ACIMA_500K → ALL" e a regra "ALCADA_ACIMA_500K" na linha 3 com o "If-Match" da etapa
    Then a API deve responder 200 com as faixas e as regras de linha gravadas
    And deve gerar registro de auditoria "workflow.update" com "metadata.field" igual a "thresholds"
    And não deve gerar evento de domínio

  Scenario: [Sucesso] Simular a alçada com processo hipotético
    Given que a alçada da etapa está configurada
    When "Marina" simular com contexto "process.estimatedValue" igual a 120000
    Then a resposta deve trazer política "ANY" com origem "STAGE_DEFAULT" e as linhas 1 e 2 incluídas e a linha 3 com motivo "RULE_FALSE"
    When "Marina" simular com "process.estimatedValue" igual a 900000
    Then a resposta deve trazer política "ALL" com origem "RULE" e as três linhas incluídas
    And não deve haver evento, auditoria de domínio nem alteração de dados

  Scenario: [Sucesso] Processo de R$ 120.000,00 gera aprovação ANY com duas linhas
    Given que o workflow publicado usa a alçada e o processo "0050/2026" de R$ 120.000,00 está na etapa anterior
    When "Rafael" encaminhar o processo para "AUTORIZACAO_LICITACAO"
    Then a "Approval" deve ter "decisionPolicy" "ANY" e as linhas "Secretário de Administração" e "Procurador-Geral" com "sequence" 1 e 2 em "PENDING"
    And a "thresholdResolution" deve registrar "policySource" "STAGE_DEFAULT" e a linha 3 como "included" falso com motivo "RULE_FALSE"
    And deve gerar registro de auditoria "approval.request"
    And deve gerar o evento "ApprovalRequested" com 2 aprovadores e sem o valor do processo

  Scenario: [Sucesso] Processo de R$ 900.000,00 gera aprovação ALL com três linhas
    Given que o processo "0051/2026" de R$ 900.000,00 está na etapa anterior
    When "Rafael" consultar a pré-visualização e encaminhar o processo
    Then a pré-visualização deve indicar "ALL" com os três aprovadores
    And a "Approval" deve ter "decisionPolicy" "ALL" e três linhas "PENDING"
    And a "thresholdResolution" deve citar "ALCADA_ACIMA_500K" versão 1 como "policyRule"
    And deve gerar registro de auditoria "approval.request" e o evento "ApprovalRequested" com 3 aprovadores
    And o aprovador da linha 3 deve receber a notificação "APPROVAL_REQUESTED"

  Scenario: [Sucesso] Reenvio após devolução resolve de novo com o valor atual
    Given que a aprovação de "0051/2026" foi devolvida e o valor do processo foi corrigido para R$ 300.000,00
    When "Rafael" reenviar o processo para "AUTORIZACAO_LICITACAO"
    Then uma nova "Approval" deve ser criada com "decisionPolicy" "ANY" e duas linhas
    And a aprovação anterior deve manter a sua "thresholdResolution" original

  Scenario: [Sucesso] Valor sigiloso não aparece na resolução
    Given que o processo "0060/2026" tem orçamento sigiloso de R$ 800.000,00
    When "Rafael" encaminhar o processo para "AUTORIZACAO_LICITACAO"
    Then a "Approval" deve ter "decisionPolicy" "ALL"
    And a "thresholdResolution", o evento "ApprovalRequested", a auditoria e os logs não devem conter o valor nem a faixa numérica
    And um usuário com "APPROVAL_VIEW" e sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" ao consultar APV-46 não deve ver nenhum número

  Scenario: [Validação] Regra inválida, etapa errada e cobertura
    When "Marina" usar uma regra "ROUTING" como "when"
    Then a API deve responder 422 com código "RULE_KIND_MISMATCH"
    When "Marina" enviar a regra em modo "INLINE"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"
    When "Marina" configurar alçada numa etapa do tipo "TASK"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"
    Given que as três linhas só se aplicam acima de R$ 500.000,00
    When "Marina" validar o workflow
    Then o resultado deve conter "WF_APPROVERS_INVALID" com "reason" "NO_APPLICABLE_APPROVER" e a amostra "process.estimatedValue" igual a 500000
    And a publicação deve ser recusada

  Scenario: [Validação] Nenhuma linha aplicável em execução e erro de avaliação
    Given que uma versão antiga publicada deixa o valor R$ 500.000,00 sem aprovador
    When "Rafael" encaminhar o processo "0070/2026" de R$ 500.000,00
    Then a API deve responder 422 com código "APPROVAL_NO_APPLICABLE_APPROVER"
    And o processo deve continuar na etapa anterior, sem "Approval", sem movimento e sem evento
    Given que o contexto do processo "0071/2026" não traz "process.estimatedValue" avaliável pela regra
    When "Rafael" encaminhar o processo
    Then a API deve responder 422 com código "RULE_EVALUATION_FAILED" e nada deve mudar

  Scenario: [Permissão] Sem configurar, sem ver a resolução
    When "Bruno" tentar salvar faixas de alçada
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Sandra" tem "WORKFLOW_MANAGE" sem "RULE_VIEW"
    When "Sandra" escolher a regra "ALCADA_ACIMA_500K"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e "reasonCode" "RULE_VIEW"
    When um usuário sem "APPROVAL_VIEW" e sem designação consultar APV-46 da aprovação de "0051/2026"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Tenant incorreto] Regra e aprovação de outro tenant
    Given que a regra "ALCADA_B" pertence ao tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", usá-la como faixa
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"
    When "Rafael" consultar a resolução de uma aprovação do tenant "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio do encaminhamento e da configuração
    Given que "Rafael" encaminhou "0051/2026" com a "Idempotency-Key" "K-900" e a aprovação "ALL" foi criada
    When a mesma requisição for reenviada
    Then a API deve responder com a mesma resposta e "Idempotent-Replayed" verdadeiro
    And deve existir uma única "Approval" "PENDING", um único evento "ApprovalRequested" e uma única auditoria "approval.request"
    When "Marina" reenviar WF-82 com o mesmo conteúdo e o "If-Match" atual
    Then a API deve responder 200 sem criar nova auditoria de alteração

  Scenario: [Concorrência] Duas configurações simultâneas e dois encaminhamentos
    Given que "Marina" e outro administrador carregaram a etapa com o mesmo "If-Match"
    When os dois salvarem faixas diferentes ao mesmo tempo
    Then uma requisição deve responder 200 e a outra 412 com código "VERSION_CONFLICT"
    Given que "Rafael" e outro usuário com custódia encaminham "0051/2026" ao mesmo tempo
    When os dois enviarem PRC-19
    Then um deve responder 200 e o outro 409 ou 412
    And deve existir uma única "Approval" "PENDING" para a etapa

  Scenario: [Falha de banco] Banco indisponível ao criar a aprovação
    Given que o banco de dados fica indisponível durante a transação de PRC-19
    When "Rafael" encaminhar "0051/2026" para "AUTORIZACAO_LICITACAO"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And não deve existir "Approval", linha, resolução, movimento, auditoria nem evento

  Scenario: [Falha de integração] Provedor de contexto e relay do outbox indisponíveis
    Given que o provedor do namespace "process" falha ao montar o contexto de "0051/2026"
    When "Rafael" encaminhar o processo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e nada deve mudar
    Given que o relay do outbox está indisponível
    When "Rafael" encaminhar "0051/2026" com sucesso
    Then a API deve responder 200 e o evento "ApprovalRequested" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (`INLINE`, política, limites) | 422 | `VALIDATION_ERROR` | "Use uma regra da biblioteca e escolha uma política válida." | Marca o campo; mantém o painel |
| Regra inválida para a alçada | 422 | `RULE_VERSION_NOT_PUBLISHED` / `RULE_INACTIVE` / `RULE_KIND_MISMATCH` | "Esta regra não pode ser usada como alçada: {motivo}." | Filtra o seletor |
| Aprovadores configurados de forma inválida | 422 | `WORKFLOW_INVALID` (`WF_APPROVERS_INVALID`) | "Para o valor {amostra} nenhum aprovador se aplica. Ajuste as faixas." | Lista a amostra e abre o simulador |
| Referência inválida na publicação | 422 | `WORKFLOW_INVALID` (`WF_RULE_REF_INVALID`) | "A regra {nome} usa uma versão que não pode ser publicada: {motivo}." | Oferece "Adotar versão vigente" |
| Versão do workflow não é rascunho | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão do workflow não pode mais ser editada." | Oferece "Criar novo rascunho" |
| Nenhuma linha aplicável (execução) | 422 | `APPROVAL_NO_APPLICABLE_APPROVER` | "Nenhum aprovador se aplica a este processo. Procure o administrador do workflow." | Mantém o processo; mensagem no modal |
| Erro ao avaliar a regra (execução) | 422 | `RULE_EVALUATION_FAILED` | "Não foi possível definir os aprovadores agora. Tente novamente ou procure o administrador." | Mantém o processo; "Tentar novamente" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta ações |
| Etapa, processo ou aprovação inexistente / outro tenant / não visível | 404 | `NOT_FOUND` | "Registro não encontrado." | Volta à lista |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "Os dados foram alterados. Recarregue e tente novamente." | Recarrega a etapa |
| Encaminhamento concorrente | 409 | `CONFLICT` (como PRC-19 do MVP 1) | "O processo foi alterado por outra pessoa. Atualize e tente de novo." | Recarrega o processo |
| Banco ou provedor de contexto indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém a tela; "Tentar novamente" |

## Dependências
- **Stories:** US-133 (Solicitar aprovação com múltiplos aprovadores: criação da `Approval` e das linhas, onde o `ThresholdResolver` se encaixa); US-195 (referência `LIBRARY`, validação e `ruleRefs`). Por transitividade: US-132 (política e aprovadores ordenados na etapa), US-194 (regra e versões), US-129 (contexto v2). Relacionadas: US-134 a US-136 (decisão, redirecionamento, caixa de tarefas e detalhe da aprovação), US-196 (modelo `ALCADA_AUTORIDADE_POR_VALOR`), US-199 e US-200 (simulador e testes das regras de alçada), US-197 (mesmo validador e padrão de fato visível).
- **Decisões/ADRs:** DEC-193, DEC-204, DEC-108, DEC-022; ADR-015, ADR-008; POL-03, POL-09, POL-17, POL-27.
- **Configurações:** `approval.preventSelfApproval` (inalterada); `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. **L-01 — Onde gravar a resolução:** a `Approval` (entities.md §5.9) não tem campo para a regra e a versão aplicadas (a feature pede "resolução registrada na `Approval` com a regra e a versão"). Proposta: `Approval.thresholdResolution` (jsonb, nulo, imutável) com a forma da RN-RULE-84.
  2. **L-02 — Evento:** events.md §2 define `ApprovalRequested` com `decisionPolicy` e `approvers[]`, sem a resolução. Proposta aditiva: `thresholdResolution?`.
  3. **L-03 — Limites sem valor definido:** quantidade máxima de faixas por etapa (proposto 10) e amostragem de fronteira da validação; a confirmar no `api.md`/`entities.md`.
  4. **L-04 — Endpoints:** a feature lista `PATCH /workflow-stages/{stageId}` para `decisionPolicyRules` e `PUT /workflow-stages/{stageId}/approvers` para as faixas por aprovador; este card usa **um único** `PUT /workflow-stages/{stageId}/thresholds` (WF-82) para evitar colisão com os endpoints de linhas da US-132 e gravar as duas coisas em uma transação. WF-83 e APV-46 são propostos aqui. Códigos novos: `APPROVAL_NO_APPLICABLE_APPROVER`, `RULE_EVALUATION_FAILED`, motivo `NO_APPLICABLE_APPROVER` em `WF_APPROVERS_INVALID`.
  5. **L-05 — Expressão textual em `APPROVAL_THRESHOLD`:** entities.md §7.3 admite `expected` textual (política/aprovador) em casos de teste, mas `when` e `applicabilityRule` precisam de booleano; aqui só o booleano é usado em execução (a forma textual é tratada na US-200).
  6. **D-01 (dúvida de produto) — Uma só linha aplicável com `ALL`/`SEQUENTIAL`:** aceita e tratada como decisão única, ou recusada? O card aceita (evita travar o processo); confirmar.
  7. **D-02 (dúvida de produto) — `INLINE` em alçada:** idem à D-01 da US-197: o card exige `LIBRARY` para garantir casos de teste.

## Impacto técnico
- **Ponto de extensão na US-133:** o `ApprovalRequester` chama `ThresholdResolver.resolve(stage, ruleContext)` antes de gravar as linhas; sem alçada configurada, o resolver devolve a política e as linhas da etapa (comportamento atual) e custa uma verificação de campo vazio.
- **Contexto:** a avaliação usa o `RuleContext` v2 montado de forma preguiçosa (só os namespaces citados pelas regras) e reaproveitado entre aplicabilidade, transições e alçada na mesma requisição.
- **Validação de cobertura:** a amostragem de fronteira é determinística e barata (≤ dezenas de avaliações); não substitui o simulador e não prova cobertura total (RN-RULE-88).
- **Compatibilidade (DEC-108):** campos e rotas aditivos; as aprovações do MVP 1 (uma linha `ApprovalApprover` por migração) e as etapas sem alçada seguem idênticas; `Approval.thresholdResolution` é nulo nelas.
- **Concorrência:** a resolução ocorre sob o bloqueio do processo e da criação da aprovação da US-133 (uma `PENDING` por etapa); WF-82 usa `If-Match` da etapa.
- **Sigilo:** nenhuma coluna ou log grava o valor; a resolução é só estrutural (quais regras e linhas).

## Backend
- **Módulo(s):** `workflow` (dono de `decisionPolicyRules`, regras de linha, WF-82/WF-83 e validação), `approval` (criação da aprovação, `thresholdResolution`, APV-46), `rules` (versões fixadas), `process` (PRC-19, PRC-71), `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `SaveStageThresholdsCommand` (WF-82), `PreviewStageThresholdsQuery` (WF-83), extensões de `ValidateWorkflowVersionQuery` e `WorkflowVersionPublisher`; `ThresholdResolver` na solicitação de aprovação (US-133); `GetApprovalResolutionQuery` (APV-46).
- **Domínio:** `ThresholdResolver` (política por faixa + filtro de linhas), `ThresholdResolution` (value object sem valores), `ThresholdCoverageChecker` (amostragem de fronteira), `RuleRefValidator` (US-195).
- **Integrações internas:** `RulesFacade` (versão fixada), `RuleContextBuilder` v2, `ApprovalFacade.requestApproval` (US-133), `AuthorizationService`.
- **Transação:** PRC-19 → trava do processo → revalida regras de saída → resolve a alçada → cria `Approval`, linhas e `thresholdResolution` → movimento → auditoria `approval.request` → outbox (`ApprovalRequested`) → timeline; WF-82 grava sob `FOR UPDATE` da etapa com `If-Match`.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`, seção "Alçada por valor" da etapa `APPROVAL`), SCR-014 (`/aprovacoes`) e SCR-015 (`/aprovacoes/[id]`) com a alçada aplicada; modal de encaminhamento do SCR-006.
- **Componentes:** `ThresholdBandsEditor` (faixas ordenáveis: regra + política), `ApproverRuleField` (por linha), `ThresholdSimulator` (WF-83: processo real ou contexto hipotético, resultado por linha e avisos), `ApprovalResolutionPanel` (política, regra e versão, linhas incluídas e não incluídas), `ForwardApprovalPreview` (PRC-71: "Aprovação por ALL: …").
- **Estados:** carregando (skeleton), vazio ("Nenhuma alçada configurada: valem a política e os aprovadores da etapa"), erro ("Tentar novamente"), sem permissão, conflito (recarrega), versão publicada (somente leitura), valor sigiloso (sem números, com texto "Valor sigiloso").
- **Acessibilidade e responsividade:** ordem das faixas alterável por teclado (setas) com anúncio por `aria-live`; inclusão ou não inclusão da linha comunicada por texto e ícone; tabelas em coluna única abaixo de 768 px; contraste 4,5:1.

## Banco de dados
- **Tabelas:** `workflow_stages` (`decision_policy_rules`), `workflow_stage_approvers` (`applicability_rule`), `approvals` (`decision_policy`, `threshold_resolution` proposta), `approval_approvers`, `outbox_events`, `audit_logs`; leitura de `rule_definition_versions`.
- **Migrações:** M2-02/M2-04 já cobrem `decision_policy`, `decision_policy_rules` e `applicability_rule`; a proposta L-01 (`approvals.threshold_resolution jsonb`) é uma coluna aditiva nula na M2-02, reversível, sem backfill.
- **Índices/constraints relevantes:** sem índice novo; check de que `threshold_resolution` é nulo quando `subject_type <> 'PROCESS_STAGE'`; trigger de imutabilidade do workflow estendido a `decision_policy_rules` e `applicability_rule`; `threshold_resolution` não é atualizável após a criação.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `WF-82` | PUT | `/workflow-stages/{stageId}/thresholds` | `{ decisionPolicyRules: [{ when: RuleRef, policy, label? }], approverRules: [{ sequence, applicabilityRule: RuleRef \| null }] }`; `If-Match` | `200 { data: { stageId, decisionPolicy, decisionPolicyRules, approverRules, validation } }` + `ETag` | 200, 403, 404, 409, 412, 422, 428 |
| `WF-83` | POST | `/workflow-stages/{stageId}/thresholds/preview` | `{ processId }` **ou** `{ context }` | `200 { data: { policy, policySource, policyRule?, lines: [{ sequence, label, approverType, included, reason, rule? }], warnings[], contextSource, defaultedPaths[] } }` | 200, 403, 404, 422 |
| `WF-20` | POST | `/workflow-versions/{versionId}/validate` | — | `errors[]`/`warnings[]` com `WF_APPROVERS_INVALID` e `WF_RULE_REF_INVALID` | 200, 404 |
| `WF-21` | POST | `/workflow-versions/{versionId}/publish` | `{ changeNotes? }`; `If-Match` | `200 { data: WorkflowVersion }` com `ruleRefs` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PRC-19` | POST | `/processes/{id}/forward` | como no MVP 1 e US-133; `Idempotency-Key` | aprovação criada com `decisionPolicy`, linhas e `thresholdResolution` (aditivo) | 200, 403, 404, 409, 412, 422, 503 |
| `PRC-71` | GET | `/processes/{id}/routing/preview` | query `transitionId?`, `processStageId?` | acrescenta `approvalResolution` (política e aprovadores) quando a próxima etapa tem alçada (campo aditivo da US-197) | 200, 403, 404, 422 |
| `APV-02` | GET | `/approvals/{id}` | — | acrescenta `thresholdResolution` resumido (aditivo) | 200, 403, 404 |
| `APV-46` | GET | `/approvals/{id}/resolution` | — | `200 { data: { hasThresholds, policy, policySource, policyRule?, lines: [{ sequence, resolvedSequence?, label, included, reason, rule? }], contextVersion, evaluatedAt } }` (sem valores) | 200, 403, 404 |
| `RUL-01` | GET | `/rules` | `kind = APPROVAL_THRESHOLD`, `isActive = true`, `hasPublishedVersion = true`, `isSystem = false` | regras elegíveis para o seletor | 200, 403 |

## Logs
- `info` `workflow.thresholds_saved` — `workflowVersionId`, `stageKey`, `bandsCount`, `rulesCount`, `durationMs`.
- `info` `approval.threshold_resolved` — `approvalId`, `processId`, `policy`, `policySource`, `includedLines`, `excludedLines`, `durationMs`.
- `warn` `approval.threshold_no_applicable_approver`, `rule.evaluation_failed` (id da regra e `contextVersion`, sem valores).
- `error` `approval.threshold_failed` — causa resumida e `correlationId`.
- **Nunca logar:** valores do `RuleContext`, o valor estimado (sigiloso ou não), a faixa numérica e a expressão da regra.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.update` | `CONFIGURATION` | WF-82 | `metadata`: `stageId`, `field = thresholds`, `bandsCount`, `rulesCount` e as versões de regra antes/depois |
| `workflow.version_publish` | `CONFIGURATION` | WF-21 | como US-195, com `ruleRefsCount` |
| `approval.request` | `WORKFLOW` | Criação da aprovação (PRC-19) | acrescenta `metadata.decisionPolicy`, `metadata.policySource`, `metadata.policyRuleVersionId` e `metadata.includedSequences`; **sem valores** |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = permissão exigida |

## Testes necessários
- **Unitários:** `ThresholdResolver` (tabela: faixa que casa, nenhuma, ordem, linha com e sem regra, uma só linha, zero linhas, erro de avaliação); `ThresholdCoverageChecker` (fronteiras 499.999,99/500.000,00/500.000,01, nulo, zero, valor alto); renumeração de `sequence`; mascaramento (nenhum valor na resolução); matriz de tipos de regra.
- **Integração (Testcontainers PostgreSQL + Redis):** PRC-19 com alçada cria `Approval`, linhas, `thresholdResolution`, evento e auditoria atomicamente; `SEQUENTIAL` com `WAITING`; reenvio após devolução; rollback total em falha; WF-82 substitutivo com `If-Match`; WF-20/WF-21 com `WF_APPROVERS_INVALID`; regressão da aprovação sem alçada (MVP 1 e US-133).
- **API/contrato:** WF-82, WF-83, WF-20, WF-21, PRC-19, PRC-71, APV-02 e APV-46 conforme este card; campos aditivos sem quebrar clientes do MVP 1.
- **RBAC e multi-tenant:** `WORKFLOW_MANAGE` + `RULE_VIEW`; `APPROVAL_VIEW` ou designação em APV-46; POL-09 (nenhum valor); regra e aprovação de outro tenant (404/422) na suíte `test/tenant-leak`.
- **Concorrência:** duas gravações de WF-82; dois encaminhamentos simultâneos (uma só `Approval` `PENDING`); mudança de valor entre pré-visualização e encaminhamento (prevalece a resolução do encaminhamento).
- **E2E (Playwright):** configurar a alçada → simular 120.000 e 900.000 → publicar → processo de 120.000 gera `ANY` com 2 aprovadores → processo de 900.000 gera `ALL` com 3 → aprovador vê a alçada aplicada no SCR-015.
- **Acessibilidade/performance:** axe sem violações sérias no editor de faixas, no simulador e no painel de resolução; resolução com 20 linhas e 10 faixas dentro da meta de comando; 360 px.

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
- [ ] Nenhuma aprovação nasce sem aprovador aplicável (testado em execução e na publicação)
- [ ] Valor sigiloso ausente de resolução, evento, auditoria, notificação e logs (teste automatizado)
- [ ] Regressão: aprovação de etapa sem alçada idêntica à da US-133 e do MVP 1

## Estimativa
**M** — a aprovação múltipla (US-132 a US-136) e a biblioteca (US-194/US-195) já existem; esta story acrescenta o resolvedor por faixa na solicitação, uma gravação substitutiva e um simulador de alçada, a validação por amostragem, a resolução registrada e as telas de configuração e de visualização.

## Prioridade
**P1** — a alçada por valor é entrega explícita do MVP 2 (roadmap §4) e "alçadas por valor operando no piloto" é critério de saída; depende da aprovação múltipla (US-133) e do uso de regras da biblioteca (US-195).
