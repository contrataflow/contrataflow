---
id: US-133
title: "Solicitar aprovação com múltiplos aprovadores"
epic: EP-022
feature: FT-066
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-051, US-132]
modules: [approval, process, document, workflow, organization, access, timeline, notification, audit, platform]
screens: [SCR-014, SCR-015]
endpoints: [PRC-19, DOC-09, APV-02]
permissions: [PROCESS_FORWARD, APPROVAL_VIEW]
events: [ApprovalRequested]
---

# US-133 — Solicitar aprovação com múltiplos aprovadores

## Título
Criar a aprovação com política de decisão e uma linha por aprovador ao entrar em etapa de aprovação ou submeter documento

## Descrição
**Como** sistema, em nome de quem encaminha o processo ou submete o documento, **quero** criar a `Approval` com a política de decisão configurada (`ANY`, `ALL` ou `SEQUENTIAL`) e uma linha `ApprovalApprover` por aprovador, resolvendo cada linha no momento da solicitação, **para** que a decisão (US-134) chegue às pessoas certas, na ordem certa, sem que quem encaminha tenha de escolher "para quem aprovar" e sem que ninguém decida o próprio documento.

Como a US-051 do MVP 1, esta story não tem botão próprio: roda dentro do encaminhamento (PRC-19, quando a etapa de destino é `APPROVAL`) e da submissão avulsa de documento (DOC-09). O que muda: a configuração lida (lista de `WorkflowStageApprover` da etapa, ou `approvalPolicy.approvers` do tipo de documento, da US-132), a criação de **uma linha por aprovador** com o estado inicial conforme a política, a **segregação de funções por linha** (substituto ou falha explícita), a recusa de pessoa repetida e o *backfill* das aprovações existentes com uma linha (`sequence = 1`). Com `ANY` e um aprovador o resultado é o do MVP 1.

## Contexto
- DEC-193 (resolve PEND-13): `Approval.decisionPolicy` e `ApprovalApprover` por aprovador; `ANY` mantém o MVP 1; `ALL` abre todas as linhas `PENDING`; `SEQUENTIAL` abre só a primeira (as demais `WAITING`, fora da caixa de tarefas). O processo fica `AWAITING_APPROVAL` até a decisão final e cada aprovador de linha ganha `ProcessAccess` `APPROVER`. `Approval.dueAt` vale para o conjunto; prazo por linha é do SLA (EP-030).
- A US-051 definiu a resolução de `USER`, `ROLE` e `DEPARTMENT_HEAD` (RN-TRAM-47 a RN-TRAM-49), a cobertura dos documentos (RN-TRAM-44 a RN-TRAM-46) e a atomicidade com o encaminhamento; esta story a aplica **por linha**.
- Segregação de funções (Lei 14.133/2021, art. 7º, § 1º; `approval.preventSelfApproval`, DEC-022): no MVP 1 só era verificada na decisão (RN-TRAM-50). DEC-193: "se a resolução cair no autor de um documento coberto, a linha vai para o substituto e, sem substituto, a solicitação falha com `SELF_APPROVAL_FORBIDDEN`".
- Migrações M2-02 (tabela e colunas) e M2-03 (*backfill* e view `v_inbox_pending_approvals` v2) são pré-requisitos do DT-03; os leitores do MVP 1 continuam na fase *expand* (colunas de aprovador da `Approval` espelham a linha corrente).
- A aprovação do PCA (EP-023) e as alçadas por valor (US-198) reutilizam esta mecânica; esta story não trata de `subjectType = PCA` nem de `applicabilityRule` de linha.

## Objetivo
Garantir que 100% das entradas em etapa `APPROVAL` e das submissões avulsas com aprovação exigida resultem em uma `Approval` com todas as linhas resolvidas e no estado certo, ou que a ação de origem seja integralmente desfeita; que nenhuma pessoa apareça em duas linhas nem seja aprovadora do próprio documento em `ALL`/`SEQUENTIAL`; e que as aprovações do MVP 1 tenham comportamento idêntico após o *backfill*.

## Persona
- **Principal:** o sistema, em nome de quem encaminhou o processo (US-047) ou submeteu o documento (US-065).
- **Secundárias:** aprovadores resolvidos (titular, substituto, usuário ou detentores do perfil); solicitante (acompanha as linhas em SCR-015); Gestor de contratações (`GESTOR_CONTRATACOES`) e Administrador do órgão (veem a política aplicada).

## Pré-condições
- Processo entrando numa `ProcessStage` cuja `WorkflowStage.type = APPROVAL` (PRC-19, US-047) ou documento submetido (DOC-09, US-065) cujo `DocumentType.requiresApproval = true`.
- Etapa ou tipo com política e linhas válidas (US-132) ou sem configuração nova (aprovador único do MVP 1).
- Não existe `Approval` `PENDING` para a mesma etapa ou documento (índices únicos de `approvals`).
- Usuário com a permissão da ação de origem (`PROCESS_FORWARD` + POL-01; permissão de submissão do tipo + POL-02).

## Fluxo principal
1. (Disparo A) Na transação de `PRC-19`, ao detectar etapa de destino `APPROVAL`, o sistema lê a **configuração vigente**: `decisionPolicy` e lista ordenada de `WorkflowStageApprover` da etapa; sem lista, o aprovador único (política `ANY`).
2. (Disparo B) Na transação de `DOC-09`, lê `approvalPolicy.decisionPolicy` e `approvers[]` do `DocumentType`; sem lista, o aprovador único.
3. Valida a completude dos documentos cobertos e cria a nova `DocumentVersion` `SUBMISSION` (RN-TRAM-45); `BLOCKING` desfaz tudo com `DOCUMENT_INCOMPLETE`.
4. Para **cada linha**, em ordem de `sequence`, resolve o aprovador: `USER` direto; `DEPARTMENT_HEAD` pelo titular da unidade resolvida (`FIXED`, `REQUESTING_SECRETARIAT` ou `REQUESTING_DEPARTMENT`); `ROLE` grava o perfil e confere que existe ao menos um detentor com atribuição cobrindo a unidade solicitante (RN-TRAM-47/49). Linha sem resolução → `APPROVER_UNRESOLVED` com `meta.sequence` e a transação inteira é desfeita.
5. Aplica a **segregação por linha** (RN-APV-20) e a regra de **pessoa única** (RN-APV-21); falha → `SELF_APPROVAL_FORBIDDEN` ou `APPROVER_DUPLICATED`, e a transação é desfeita.
6. Cria a `Approval` (`PENDING`, `decisionPolicy`, `title`, `requestedById`, `requestedAt`, `requestComment`, `dueAt` do `ProcessStage` na etapa; `null` na avulsa até a US-137) e as linhas `ApprovalApprover`: `ANY`/`ALL` todas `PENDING` (`activatedAt = requestedAt`); `SEQUENTIAL` a linha 1 `PENDING` e as demais `WAITING` (`activatedAt` nulo).
7. Espelha a linha 1 (ou a corrente) nas colunas de aprovador da `Approval` (RN-APV-24), cria as `ApprovalDocument` e preenche `Document.pendingApprovalId`.
8. Concede `ProcessAccess` `USER/APPROVER` a cada aprovador de linha (e ao substituto quando `allowDeputy`; `DEPARTMENT/CURRENT` para linha `ROLE`), com `sourceId` = id da linha.
9. Coloca o processo em `AWAITING_APPROVAL`, grava auditoria `approval.request`, a entrada de timeline `APPROVAL_REQUESTED` e publica `ApprovalRequested` (com `decisionPolicy` e `approvers[]`) no outbox, tudo na mesma transação.
10. Depois do *commit*, notifica os aprovadores das linhas `PENDING` (`APPROVAL_REQUESTED`, in-app obrigatória). A resposta de `PRC-19`/`DOC-09` já traz `approval { id, decisionPolicy, approvers[] }` e o front mostra "Aprovação solicitada a {aprovadores}" (SCR-015 e SCR-014 passam a listar a aprovação).

## Fluxos alternativos
- **FA-01 — `ANY` com um aprovador (MVP 1):** uma linha `sequence = 1` `PENDING`; mesmo comportamento, mesma notificação e mesmas respostas da US-051, com os campos novos aditivos.
- **FA-02 — `SEQUENTIAL`:** só o aprovador da linha 1 é notificado e vê a aprovação na caixa; os demais aparecem em SCR-015 como "Aguardando a vez".
- **FA-03 — Titular é autor de documento coberto:** em `ALL`/`SEQUENTIAL` a linha `DEPARTMENT_HEAD` vai para o substituto da unidade (`allowDeputy` gravado `false` nessa linha) e a auditoria registra `selfApprovalAvoided`; sem substituto, ou se o substituto também for autor, `SELF_APPROVAL_FORBIDDEN` (403) com `meta.sequence`.
- **FA-04 — Mesma pessoa em duas linhas:** titular de duas unidades, usuário igual ao titular, ou substituto que repete outra linha → `APPROVER_DUPLICATED` (422) com as linhas envolvidas.
- **FA-05 — Reenvio depois de devolução com votos:** o encaminhamento seguinte cria nova `Approval` com **todas** as linhas de novo; votos da aprovação encerrada ficam no histórico e não são reaproveitados.
- **FA-06 — Submissão avulsa (`DOCUMENT`):** usa `approvalPolicy` do tipo; linhas resolvidas contra a unidade solicitante do processo do documento; `dueAt` nulo (prazo por tipo é a US-137).
- **FA-07 — Etapa dentro de ramo paralelo:** a aprovação de cada ramo é independente (uma `ProcessStage` por ramo) e usa o mesmo mecanismo.
- **FA-08 — Conflito de solicitação simultânea:** o índice único `PENDING` por etapa ou documento faz uma das solicitações falhar (`VERSION_CONFLICT`/`APPROVAL_NOT_PENDING`); nada fica pela metade.

## Regras de negócio
- **RN-APV-16** — A solicitação roda em exatamente dois pontos (como RN-TRAM-43): entrada em `ProcessStage` de etapa `APPROVAL` e submissão avulsa de documento com `requiresApproval = true`. A configuração (política e linhas) é **copiada** no instante da solicitação; mudanças posteriores no workflow ou no tipo (US-132, RN-APV-12) não afetam aprovações abertas.
- **RN-APV-17** — Toda `Approval` tem `decisionPolicy` e ao menos uma linha `ApprovalApprover`. Com lista configurada, uma linha por item (ordem = `sequence`); sem lista (`ANY` do MVP 1), uma linha `sequence = 1` com o aprovador resolvido. As linhas guardam `approverType` e a referência resolvida (`approverUserId`, `approverRoleId`, `approverDepartmentId`), `allowDeputy` e o estado; máximo de 20 linhas.
- **RN-APV-18** — Estado inicial: `ANY` e `ALL`, todas as linhas `PENDING` com `activatedAt = requestedAt`; `SEQUENTIAL`, linha de menor `sequence` `PENDING` e as demais `WAITING` (`activatedAt` nulo, ativadas na decisão — US-134). A caixa de tarefas lê só linhas `PENDING` (US-136).
- **RN-APV-19** — Resolução por linha, com as regras da US-051: `USER` com vínculo `ACTIVE` não vencido; `DEPARTMENT_HEAD` = `headUserId` da unidade resolvida (ativa, com titular) e `allowDeputy = true`; `ROLE` = `approverRoleId`, com ao menos um detentor elegível (atribuição vigente cobrindo a unidade solicitante — nunca `CURRENT`/`HISTORICAL`) e `allowDeputy = false`. Falha em qualquer linha → `APPROVER_UNRESOLVED` (422, `meta.sequence`, `meta.approverLabel`) e a transação de origem é desfeita (RN-TRAM-49).
- **RN-APV-20** — Segregação de funções por linha na solicitação: quando a política é `ALL` ou `SEQUENTIAL` (ou há mais de uma linha) e `approval.preventSelfApproval = true`, se o aprovador resolvido de uma linha `USER` ou `DEPARTMENT_HEAD` é autor de alguma versão coberta, a linha vai para o substituto da unidade (`DEPARTMENT_HEAD`, `deputyUserId` ativo e não autor) e, sem substituto elegível, a solicitação falha com `SELF_APPROVAL_FORBIDDEN` (403, `meta.sequence`). Linhas `ROLE` não são avaliadas aqui (a elegibilidade é da decisão). Com `ANY` e linha única mantém-se a regra do MVP 1 (RN-TRAM-50): só a decisão verifica.
- **RN-APV-21** — Pessoa única: a mesma pessoa resolvida não pode ocupar duas linhas da mesma `Approval` (comparação após a substituição da RN-APV-20); violação → `APPROVER_DUPLICATED` (422). Linhas `ROLE` não entram na comparação; a pessoa que decidir uma linha não decide outra (US-134).
- **RN-APV-22** — Estado do processo e prazo: o processo fica `AWAITING_APPROVAL` até a decisão final (DEC-013, DEC-193); `Approval.dueAt` = `dueAt` da `ProcessStage` recém-criada (RN-TRAM-51), único para o conjunto; `ApprovalApprover.dueAt` fica nulo (prazo por linha: EP-030, DEC-205); `Approval.title` segue RN-TRAM-52.
- **RN-APV-23** — Documentos cobertos e versões: a cobertura, a nova `DocumentVersion` `SUBMISSION`, as `ApprovalDocument` e o `pendingApprovalId` seguem RN-TRAM-44 a RN-TRAM-46, uma vez por `Approval` (não por linha).
- **RN-APV-24** — Espelho (fase *expand*): `approverType`, `approverUserId`, `approverRoleId`, `approverDepartmentId` e `allowDeputy` da `Approval` espelham a primeira linha (`ANY`/`ALL`) ou a linha corrente (`SEQUENTIAL`) e são atualizados na ativação (US-134) e no redirecionamento (US-135); `approverType` pode ser nulo apenas quando não há linha resolvida a espelhar (não ocorre aqui). O contract das colunas legadas é M2-22 (MVP 3+).
- **RN-APV-25** — Acesso: cada aprovador de linha (inclusive de linha `WAITING`) recebe `ProcessAccess` `USER/APPROVER` com `sourceId` = id da linha, mais o substituto quando `allowDeputy`; linha `ROLE` concede `DEPARTMENT/CURRENT` à unidade aprovadora, como no MVP 1 (RN-TRAM-53). O ciclo de vida das concessões segue o MVP 1.
- **RN-APV-26** — Evento: um único `ApprovalRequested` por solicitação, com `decisionPolicy` e `approvers[]` (`approvalApproverId`, `sequence`, `approverType`, referências, `status`); o evento não carrega nomes. Sem `ApprovalApproverActivated` na solicitação: a linha 1 de `SEQUENTIAL` já nasce `PENDING` neste evento.
- **RN-APV-27** — Notificação `APPROVAL_REQUESTED` (in-app obrigatória, e-mail padrão ligado) aos aprovadores das linhas `PENDING`: titular e substituto (se `allowDeputy`), usuário direto, ou detentores do perfil com escopo (máx. 50, senão a unidade atual). Linhas `WAITING` não notificam até a ativação; nunca se notifica o próprio ator.
- **RN-APV-28** — Timeline: entrada `APPROVAL_REQUESTED` ("Aprovação solicitada a {approverLabel}") com `approverLabel` composto pela política: `ANY` "A ou B", `ALL` "A e B", `SEQUENTIAL` "A, depois B"; sem valores sigilosos.
- **RN-APV-29** — Atomicidade: política, linhas, espelho, documentos, acesso, estado do processo, auditoria, timeline e outbox são gravados na transação do encaminhamento ou da submissão; qualquer falha desfaz tudo (nenhuma `Approval` órfã, nenhuma linha sem aprovador).
- **RN-APV-30** — *Backfill* (M2-02/M2-03): toda `Approval` existente ganha uma linha `ApprovalApprover` (`sequence = 1`) com o aprovador, o estado equivalente (`PENDING`, `APPROVED`, `RETURNED`, `REJECTED` ou `CANCELED`) e, se decidida, `decision`, `decidedById`, `decidedAt`, `decisionComment` e `decidedAsDeputy`; aprovações `CANCELED` geram linha `CANCELED` com `skippedReason = WITHDRAWN`. Lotes de 1.000, idempotente por `(approval_id, sequence)`, reversível, com relatório de reconciliação (contagens por status). `decisionPolicy = ANY` para todas.
- **RN-APV-31** — Compatibilidade de leitura: APV-01 e APV-02 e a view `v_inbox_pending_approvals` v1 continuam respondendo como no MVP 1 para aprovações `ANY` com uma linha; APV-02 ganha `decisionPolicy` e `approvers[]` de forma aditiva (DEC-108).
- **RN-APV-32** — Unicidade e limites: `UNIQUE (tenant_id, process_stage_id)` e `(tenant_id, document_id)` com `PENDING` continuam; `UNIQUE (tenant_id, approval_id, sequence) WHERE status <> 'CANCELED'` nas linhas; máximo de 20 linhas; solicitação simultânea para a mesma etapa/documento resulta em uma `Approval` (a outra recebe 409/412).

## Campos
Sem formulário próprio: os dados abaixo são produzidos a partir do encaminhamento (US-047) ou da submissão (US-065).

| Campo (dado) | Campo técnico | Tipo | Origem | Regras |
|---|---|---|---|---|
| Política | `Approval.decisionPolicy` | `ApprovalDecisionPolicy` | etapa ou `approvalPolicy` | RN-APV-16 |
| Ordem da linha | `ApprovalApprover.sequence` | inteiro 1..n | configuração | RN-APV-17 |
| Tipo de aprovador | `ApprovalApprover.approverType` | `ApproverType` | configuração | `USER`, `ROLE`, `DEPARTMENT_HEAD` |
| Aprovador resolvido | `approverUserId` / `approverRoleId` / `approverDepartmentId` | uuid | resolução | RN-APV-19 |
| Permite substituto | `allowDeputy` | booleano | resolução | `true` só em `DEPARTMENT_HEAD` (ou `false` após RN-APV-20) |
| Estado da linha | `status` | `ApprovalApproverStatus` | política | `PENDING` / `WAITING` (RN-APV-18) |
| Ativada em | `activatedAt` | data/hora | política | `requestedAt` ou nulo |
| Prazo da linha | `dueAt` | data/hora | — | nulo (EP-030) |
| Prazo do conjunto | `Approval.dueAt` | data/hora | `ProcessStage.dueAt` | RN-APV-22 |
| Motivo de salto | `skippedReason` | texto (40) | decisões e retiradas | nulo na solicitação |
| *(auditoria)* Linha desviada | `selfApprovalAvoided` | booleano | RN-APV-20 | só em `metadata` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Documento coberto incompleto (`BLOCKING`) | API | "Há pendências nos documentos desta etapa: {lista}." | `DOCUMENT_INCOMPLETE` |
| V-02 | Aprovador de uma linha não resolvido | API | "Não há aprovador configurado para a linha {n} ({rótulo}) desta etapa. Fale com o administrador do órgão." | `APPROVER_UNRESOLVED` |
| V-03 | Aprovador resolvido é autor de documento coberto e não há substituto elegível | API | "O aprovador da linha {n} é autor de um dos documentos e não tem substituto. Fale com o administrador do órgão." | `SELF_APPROVAL_FORBIDDEN` |
| V-04 | Mesma pessoa em duas linhas | API | "A mesma pessoa não pode aprovar em duas linhas ({n} e {m}). Fale com o administrador do órgão." | `APPROVER_DUPLICATED` |
| V-05 | Já existe `Approval` `PENDING` para a etapa/documento (corrida) | API | "Já existe uma aprovação em andamento para este item." | `APPROVAL_NOT_PENDING` / `VERSION_CONFLICT` |
| V-06 | Configuração com política ≠ `ANY` e menos de duas linhas no runtime (dado inconsistente) | API | "A aprovação desta etapa está mal configurada. Fale com o administrador do órgão." | `APPROVER_UNRESOLVED` (`meta.reason = POLICY_INVALID`) |
| V-07 | Mais de 20 linhas na configuração copiada (dado inconsistente) | API | idem | `APPROVER_UNRESOLVED` (`meta.reason = LIMIT_EXCEEDED`) |

## Permissões
- **Permissão:** nenhuma própria — a ação é interna e executada dentro da autorização de `PRC-19` (`PROCESS_FORWARD` + POL-01, US-047) ou de `DOC-09` (permissão de submissão do tipo + POL-02, US-065). Para consultar as linhas: `APPROVAL_VIEW` ou designação (APV-02).
- **Políticas:** DEC-022 (resolução); POL-03 por linha (designação, substituto e segregação, avaliadas aqui na solicitação para `ALL`/`SEQUENTIAL` e na decisão em todos os casos).
- **MFA:** não aplicável (sem ação direta do usuário final; `PROCESS_FORWARD` não é de risco `H`).
- **Sem permissão:** se o encaminhamento ou a submissão não for autorizado, esta lógica não roda; a API responde 403 `PERMISSION_DENIED` e registra `access.denied` (US-047/US-065).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalRequested` | `approval.requested` | Commit do encaminhamento ou da submissão que criou a `Approval` | `approvalId`, `subjectType`, `processStageId?`, `documentId?`, `documentVersionIds[]`, `dueAt?`, `decisionPolicy`, `approvers[]` (`approvalApproverId`, `sequence`, `approverType`, `approverUserId?`, `approverRoleId?`, `approverDepartmentId?`, `status`); consumidores `T A N R` |

Eventos do encaminhamento (`ProcessStageChanged`, `ProcessStatusChanged`) e de documento (`DocumentSubmitted`, `DocumentVersionCreated`) pertencem às US-047/US-065. O *backfill* não publica eventos.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_REQUESTED` | Aprovador de cada linha `PENDING` (titular + substituto se `allowDeputy`; usuário; detentores do perfil, máx. 50) | in-app (**obrigatória**) + e-mail (padrão ligado) | `ApprovalRequested` |
| `APPROVAL_REQUESTED` | Aprovador da linha ativada em `SEQUENTIAL` | idem | `ApprovalApproverActivated` (US-134), não na solicitação |

## Critérios de aceite em Gherkin
```gherkin
Feature: Solicitar aprovação com múltiplos aprovadores

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0012/2026" está na etapa "CONTROLE_INTERNO" sob responsabilidade de "Ana"
    And a etapa "AUTORIZACAO_LICITACAO" (tipo "APPROVAL") cobre o documento "EDITAL" "ED 0003/2026"
    And "Ana" tem "PROCESS_FORWARD" e custódia do processo

  Scenario: [Sucesso] Aprovação em sequência abre só a primeira linha
    Given que a etapa tem a política "SEQUENTIAL" com 1. titular da "Secretaria de Administração" ("Roberto", substituta "Helena") e 2. o usuário "Marcos"
    When "Ana" encaminhar o processo para "AUTORIZACAO_LICITACAO"
    Then deve existir uma "Approval" "PENDING" com "decisionPolicy" "SEQUENTIAL" e duas linhas
    And a linha 1 de "Roberto" deve estar "PENDING" e a linha 2 de "Marcos" deve estar "WAITING"
    And o processo deve estar "AWAITING_APPROVAL" e "Roberto" e "Marcos" devem ter acesso "APPROVER"
    And deve gerar registro de auditoria "approval.request" com "decisionPolicy" "SEQUENTIAL" e "approversCount" 2
    And deve gerar o evento "ApprovalRequested" com os dois aprovadores e seus estados
    And apenas "Roberto" e "Helena" devem receber a notificação "APPROVAL_REQUESTED"

  Scenario: [Sucesso] Aprovação "ALL" abre todas as linhas
    Given que a etapa tem a política "ALL" com os usuários "Roberto" e "Marcos"
    When "Ana" encaminhar o processo
    Then as duas linhas devem estar "PENDING" com "activatedAt" igual a "requestedAt"
    And "Roberto" e "Marcos" devem receber a notificação "APPROVAL_REQUESTED"

  Scenario: [Sucesso] Aprovação "ANY" com aprovador único comporta-se como no MVP 1
    Given que a etapa tem a política "ANY" sem lista e o aprovador "DEPARTMENT_HEAD" da secretaria solicitante
    When "Ana" encaminhar o processo
    Then deve existir uma "Approval" com uma única linha "sequence" 1 "PENDING"
    And a resposta de encaminhamento deve manter os campos do MVP 1

  Scenario: [Sucesso] Titular autor do documento tem a linha desviada para o substituto
    Given que "Roberto" é autor de uma versão do "EDITAL" e "approval.preventSelfApproval" é verdadeiro
    When "Ana" encaminhar o processo para a etapa "ALL" com "Roberto" (titular) e "Marcos"
    Then a linha 1 deve ficar com "Helena" e "allowDeputy" falso
    And a auditoria "approval.request" deve registrar "selfApprovalAvoided" na linha 1

  Scenario: [Sucesso] Backfill das aprovações do MVP 1
    Given que existem 2.350 aprovações do MVP 1, entre "PENDING", "APPROVED", "RETURNED" e "CANCELED"
    When a migração de dados M2-03 rodar duas vezes
    Then cada aprovação deve ter exatamente uma linha "sequence" 1 com o estado equivalente
    And o relatório de reconciliação deve mostrar contagens iguais por status
    And as aprovações "PENDING" devem continuar aparecendo para os mesmos aprovadores

  Scenario: [Validação] Linha sem aprovador, pessoa repetida e documento incompleto
    Given que a linha 2 é "DEPARTMENT_HEAD" de uma unidade sem titular
    When "Ana" encaminhar o processo
    Then a API deve responder 422 com código "APPROVER_UNRESOLVED" e "meta.sequence" 2
    And nenhuma "Approval", linha ou movimento deve ser gravado e o processo deve continuar na etapa "CONTROLE_INTERNO"
    Given que "Roberto" é titular das duas unidades configuradas nas linhas 1 e 2
    When "Ana" encaminhar o processo
    Then a API deve responder 422 com código "APPROVER_DUPLICATED"
    Given que o "EDITAL" está incompleto
    When "Ana" encaminhar o processo
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE"

  Scenario: [Validação] Autor sem substituto elegível
    Given que "Marcos" é autor de uma versão do "EDITAL" e a linha 2 é o usuário "Marcos"
    When "Ana" encaminhar o processo para a etapa "SEQUENTIAL"
    Then a API deve responder 403 com código "SELF_APPROVAL_FORBIDDEN" e "meta.sequence" 2

  Scenario: [Permissão] Usuário sem PROCESS_FORWARD tenta encaminhar
    Given que "Bruno" não possui "PROCESS_FORWARD"
    When "Bruno" tentar encaminhar o processo para a etapa de aprovação
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And nenhuma "Approval" deve ser criada
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Encaminhar processo de outro tenant
    Given que existe o processo "0007/2026" no tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura A", tentar encaminhar esse processo
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum aprovador ou dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio do encaminhamento com a mesma chave
    Given que "Ana" encaminhou com "Idempotency-Key" "k-133"
    When a mesma requisição for reenviada com o mesmo corpo
    Then a API deve responder com o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir uma única "Approval" com as duas linhas e um único evento "ApprovalRequested"

  Scenario: [Concorrência] Dois usuários encaminham o mesmo processo ao mesmo tempo
    Given que "Ana" e "Carlos" têm custódia e a mesma versão do processo
    When os dois enviarem o encaminhamento ao mesmo tempo
    Then apenas uma "Approval" deve ser criada
    And a outra requisição deve receber 412 "VERSION_CONFLICT" ou 409 "APPROVAL_NOT_PENDING"

  Scenario: [Falha de banco] Banco falha ao gravar as linhas
    Given que o banco de dados falha ao inserir a segunda linha
    When "Ana" encaminhar o processo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o processo, os documentos e o outbox devem permanecer como antes do encaminhamento

  Scenario: [Falha de integração] Fila de notificação e relay do outbox indisponíveis
    Given que o Redis das filas está indisponível
    When "Ana" encaminhar o processo
    Then a API deve responder 200 com a aprovação criada
    And o evento "ApprovalRequested" deve ficar "PENDING" no outbox até o relay voltar
    And as notificações devem ser enviadas depois, sem duplicidade
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Documento coberto incompleto | 422 | `DOCUMENT_INCOMPLETE` | "Há pendências nos documentos desta etapa: {lista}." | Lista as violações no painel de encaminhamento |
| Aprovador de uma linha não resolvido | 422 | `APPROVER_UNRESOLVED` | "Não há aprovador configurado para a linha {n} ({rótulo}) desta etapa. Fale com o administrador do órgão." | Mantém os dados do encaminhamento para nova tentativa |
| Autor sem substituto elegível | 403 | `SELF_APPROVAL_FORBIDDEN` | "O aprovador da linha {n} é autor de um dos documentos e não tem substituto. Fale com o administrador do órgão." | Idem |
| Mesma pessoa em duas linhas | 422 | `APPROVER_DUPLICATED` | "A mesma pessoa não pode aprovar em duas linhas ({n} e {m}). Fale com o administrador do órgão." | Idem |
| Aprovação já em andamento (corrida) | 409 | `APPROVAL_NOT_PENDING` | "Já existe uma aprovação em andamento para este item." | Recarrega o processo |
| Processo alterado por outra pessoa | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou o processo. Recarregue e tente de novo." | Recarrega e mantém o comentário |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para encaminhar este processo." | Oculta a ação |
| Processo ou documento de outro tenant | 404 | `NOT_FOUND` | "Processo não encontrado." | Volta à lista |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega o processo |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível encaminhar agora. Tente novamente em instantes." | Botão "Tentar novamente"; mantém o formulário |

## Dependências
- **Stories:** US-051 (solicitar e resolver o aprovador — regras RN-TRAM-43 a RN-TRAM-53 estendidas por linha), US-132 (política e lista configuradas). Indiretas: US-047 (`PRC-19`), US-065 (`DOC-09`), US-016 e US-023 (aprovação de DFD e ETP). Habilita US-134, US-135, US-136, US-198 (alçadas por valor) e a aprovação do PCA (EP-023).
- **Decisões/ADRs:** DEC-193, DEC-022, DEC-013, DEC-018, DEC-108; migrações M2-02 e M2-03 de `entities.md §10`.
- **Configurações:** `approval.preventSelfApproval` (padrão `true`).
- **Lacunas nas fontes canônicas:**
  1. DEC-193 e RN-APV-07 da feature aplicam a segregação "na resolução"; a RN-TRAM-50 do MVP 1 a limitava à decisão. Adotado: na solicitação só para `ALL`/`SEQUENTIAL` (e mais de uma linha), preservando o MVP 1 em `ANY` com linha única (RN-APV-20). Confirmar com produto.
  2. Pessoa repetida em duas linhas não está tratada nas fontes (a feature diz "ninguém aprova duas vezes"); proposta `APPROVER_DUPLICATED` (RN-APV-21), código novo em api.md.
  3. `ApprovalApprover.skippedReason` só tem `NEGATIVE_DECISION`, `ANY_DECIDED`, `REASSIGNED` e `WITHDRAWN`; no *backfill* de aprovações `CANCELED` por outras causas (`PROCESS_CANCELED`) usa-se `WITHDRAWN` (RN-APV-30). Se necessário, ampliar os valores.
  4. A posse do *backfill* e da view `v_inbox_pending_approvals` v2 (M2-03) não está atribuída a story nas fontes; assumido: *backfill* nesta story, view na US-136.
  5. `allowDeputy` em `WorkflowStageApprover` tem padrão `true`, mas a US-051 só o ativa em `DEPARTMENT_HEAD`; mantida a regra do MVP 1 (RN-APV-19), preferência gravada.
- **Resolução na implementação (spec-642, 2026-11-11):** as cinco propostas acima foram adotadas como escritas. Complementos:
  - O `ApprovalRequested` leva também `allowDeputy` em cada item de `approvers[]` (o substituto é avisado e recebe `APPROVER` por linha) e o `ApprovalReassigned` ganha `approvalApproverId?` (a linha redirecionada); ambos aditivos e opcionais no esquema (eventos do MVP 1 no outbox continuam válidos).
  - Linha desviada para o substituto (RN-APV-20): continua `DEPARTMENT_HEAD`, com `approverUserId` = substituto e `allowDeputy = false`; rótulo "{nome} (em substituição ao titular da {unidade})". A decisão por linha (US-134) precisa aceitar o substituto gravado nessa linha.
  - Os autores usados na segregação são os mesmos da decisão (RN-TRAM-62): criador do documento e da versão analisada. A recusa por linha (`SELF_APPROVAL_FORBIDDEN`, `APPROVER_DUPLICATED`) acontece depois das escritas do encaminhamento e desfaz a transação inteira.
  - `meta` dos erros: `APPROVER_UNRESOLVED` → `{ sequence, approverLabel }` (rótulo configurado ou genérico do tipo, nunca o nome) ou `{ reason }` (V-06/V-07); `SELF_APPROVAL_FORBIDDEN` → `{ sequence }`; `APPROVER_DUPLICATED` → `{ sequences: [n, m] }`. Sem lista configurada (FA-01) a mensagem de V-02 é a do MVP 1.
  - M2-02 entregue em parte (migração `20261112090000_approval_approvers`): `approval_approvers` e `approvals.decision_policy`. `approvals.pca_id` fica com o EP-023 (a tabela `pcas` é da M2-11) e o relaxamento de `approver_type` para nulo com a story que gravar aprovação sem linha a espelhar.
  - M2-03 = migração `20261112091000_approval_approvers_backfill` (SQL, por tenant, lotes de 1.000, idempotente). O relatório de reconciliação sai como `NOTICE` (`approval.backfill_batch`/`approval.backfill_reconciled`) e uma divergência aborta a migração (`approval.backfill_failed`); a auditoria `approval.backfill` não é gravada (o `row_hash` do `audit_logs` é calculado pela aplicação).
  - Enquanto a US-134/US-135 não chegam, a decisão, a retirada, o cancelamento e o redirecionamento do MVP 1 mantêm as linhas em sincronia (linha de quem decidiu recebe a decisão, as demais `SKIPPED`; não decididas → `CANCELED`/`WITHDRAWN`; redirecionamento no lugar).
  - DOC-09 continua respondendo o `Document` com `pendingApprovalId` (a política e as linhas ficam no APV-02); o resumo `approval { … }` na resposta do DOC-09 fica pendente.

## Impacto técnico
- **Transação e carga:** a solicitação resolve até 20 linhas; consultas de titular, substituto e detentores de perfil são em lote (uma por tipo) para manter a latência do encaminhamento próxima à do MVP 1.
- **Compatibilidade (expand):** leitores do MVP 1 leem as colunas espelhadas; `approverType` passa a admitir nulo só por segurança de migração; a view v1 é mantida até o contract (M2-22).
- **Backfill:** job em lotes de 1.000, idempotente por `(approval_id, sequence)`, executado fora do horário de uso, com relatório de reconciliação (contagem por status antes e depois); aprovações em decisão durante o *backfill* são tratadas pela trava de linha da `Approval`.
- **Segurança:** as mensagens de erro não revelam o nome de quem seria o aprovador; `meta` traz só `sequence` e rótulo da linha. Valores de orçamento não entram em eventos, notificações nem timeline.
- **Consistência com o paralelismo:** como cada ramo tem a sua `ProcessStage`, os índices únicos de `approvals` continuam corretos (US-124).

## Backend
- **Módulo(s):** `approval` (dono: `Approval`, `ApprovalApprover`, resolução e criação), `process` (encaminhamento, estado, `ProcessAccess`), `document` (cobertura e versões), `workflow` (configuração da etapa), `organization` (titular e substituto), `access` (detentores de perfil e permissões), `timeline`, `notification`, `audit`, `platform`.
- **Casos de uso:** `RequestApprovalHandler` (estendido), `ApprovalLinesResolver`, `ApprovalBackfillJob` (M2-03).
- **Domínio:** `Approval.open(config, lines)`; `ApprovalApprover` (estado inicial por política); `SelfApprovalGuard` (por linha); `DistinctApproversPolicy`; `ApprovalConfigSnapshot` (cópia da configuração); espelho da linha corrente.
- **Integrações internas:** `WorkflowFacade` (lista ordenada e política da etapa), `DocumentFacade` (`approvalPolicy`, versões, autoria), `OrganizationFacade` (`headUserId`, `deputyUserId`), `AccessFacade` (detentores do perfil com escopo), `ProcessAccessPort`, `OutboxWriter`.
- **Transação:** a de `PRC-19`/`DOC-09`, com `app.tenant_id`: configuração → documentos → resolução e regras por linha → `Approval` e linhas → espelho → `ProcessAccess` → estado do processo → auditoria → timeline → outbox.

## Frontend
- **Tela(s):** SCR-015 (`/aprovacoes/[id]`) e SCR-014 (`/aprovacoes`) passam a exibir a política e as linhas criadas; o painel de encaminhamento (US-047) mostra o resultado e os erros por linha.
- **Componentes:** `ApprovalPolicyBadge` ("Qualquer um aprova", "Todos aprovam", "Aprovam em sequência"), `ApprovalLinesList` (ordem, estado e "Aguardando a vez"), mensagens de erro por linha no `ForwardPanel`.
- **Estados:** loading (skeleton da aprovação); erro por linha (`APPROVER_UNRESOLVED`, `APPROVER_DUPLICATED`, `SELF_APPROVAL_FORBIDDEN`) com texto de recuperação; sucesso (toast "Aprovação solicitada a {aprovadores}").
- **Acessibilidade e responsividade:** estado de cada linha por texto e ícone, não só por cor; erros do encaminhamento anunciados por `aria-live`; lista de linhas em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `approvals` (`decision_policy`, espelho), `approval_approvers` (nova, M2-02), `approval_documents`, `documents` (`pending_approval_id`), `process_access`, `outbox_events`, `audit_logs`, `process_timeline_entries`.
- **Migrações:** M2-02 (`approval_approvers`, `approvals.decision_policy`, `pca_id`, `approver_type` nulo; checks `NOT VALID` + `VALIDATE`) e M2-03 (*backfill* + view v2), ambas reversíveis.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, approval_id, sequence) WHERE status <> 'CANCELED'`; índices parciais `(tenant_id, approver_user_id|approver_department_id|approver_role_id) WHERE status = 'PENDING'`; checks de tipo × coluna por linha; `status NOT IN ('APPROVED','RETURNED','REJECTED') OR (decided_at IS NOT NULL AND decision IS NOT NULL)`; únicos de `PENDING` da `Approval` mantidos.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PRC-19` | POST | `/processes/{id}/forward` | como na US-047 | `200 { data: Process, … }` com `approval { id, decisionPolicy, approvers[] }` quando o destino é `APPROVAL` (aditivo) | 200, 403, 404, 409, 412, 422, 503 |
| `DOC-09` | POST | `/documents/{id}/submit` | como na US-065 | idem para aprovação avulsa | 200, 403, 404, 409, 422, 503 |
| `APV-02` | GET | `/approvals/{id}` | — | `200 { data: Approval }` com `decisionPolicy` e `approvers[]` (`id`, `sequence`, `status`, `approverType`, `label`, `activatedAt`, `dueAt`, …) · `ETag` | 200, 403, 404 |

## Logs
- `info` `approval.requested` — `approvalId`, `subjectType`, `decisionPolicy`, `linesCount`, `durationMs`.
- `warn` `approval.request_rejected` — `reason` (`APPROVER_UNRESOLVED`, `APPROVER_DUPLICATED`, `SELF_APPROVAL_FORBIDDEN`), `sequence`.
- `info` `approval.backfill_batch` — `batchId`, `approvals`, `linesCreated`, `skipped`; `error` `approval.backfill_failed` — `batchId`, causa.
- **Nunca logar:** nomes, e-mails ou CPF dos aprovadores, comentário do encaminhamento, conteúdo dos documentos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `approval.request` | `WORKFLOW` | Commit do encaminhamento/submissão | `metadata`: `approvalId`, `subjectType`, `decisionPolicy`, `approversCount`, `documentIds[]`, `lines[]` (`sequence`, `approverType`, `status`, `selfApprovalAvoided?`) — sem nomes |
| `approval.backfill` | `DATA_CHANGE` | Lote do *backfill* (ator `SYSTEM`) | `metadata`: `batchId`, contagens por status |
| `access.denied` | `ACCESS` | Tentativa sem permissão de origem | `reasonCode` da permissão de `PRC-19`/`DOC-09` |

## Testes necessários
- **Unitários:** estado inicial por política; resolução por tipo de linha; `SelfApprovalGuard` (substituto, sem substituto, substituto autor, `ROLE`); `DistinctApproversPolicy`; espelho da linha corrente; mapeamento de status do *backfill*.
- **Integração (Testcontainers PostgreSQL + Redis):** solicitação atômica em `PRC-19` e `DOC-09` com `ANY`, `ALL` e `SEQUENTIAL`; rollback total por falha de resolução; `ProcessAccess` por linha; outbox e timeline; *backfill* idempotente com reconciliação; contrato do MVP 1 (APV-01/APV-02, view v1) inalterado.
- **API/contrato:** `approval` nas respostas de `PRC-19`/`DOC-09`; APV-02 com `approvers[]`; códigos de erro novos.
- **RBAC e multi-tenant:** permissões de origem; processo/documento/aprovador de outro tenant → 404 (suíte `test/tenant-leak`); mensagens sem nomes.
- **Concorrência:** duas solicitações simultâneas para a mesma etapa; *backfill* concorrente com decisão.
- **E2E (Playwright):** forward com `SEQUENTIAL` e `ALL`; erro de linha sem aprovador e recuperação.
- **Acessibilidade/performance:** axe na lista de linhas e nas mensagens de erro; latência do encaminhamento com 20 linhas na suíte de performance (medida no endurecimento).

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
- [ ] *Backfill* M2-03 com relatório de reconciliação sem divergência
- [ ] Teste de contrato do MVP 1 (aprovação `ANY` de uma linha) verde

## Estimativa
**L** — estende a solicitação do MVP 1 por linha (resolução, segregação, pessoa única, acesso, notificação), exige o *backfill* idempotente das aprovações existentes e a compatibilidade de leitura na fase *expand*.

## Prioridade
**P0** — sem as linhas criadas na solicitação não há decisão múltipla; é o segundo card do DT-03 e pré-requisito da decisão, do redirecionamento e das alçadas.
