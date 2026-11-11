---
id: US-132
title: "Configurar política de decisão e aprovadores ordenados na etapa"
epic: EP-022
feature: FT-066
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-040, US-043, US-045]
modules: [workflow, document, approval, access, audit, platform]
screens: [SCR-034, SCR-108]
endpoints: [WF-65, WF-08, WF-09, WF-11, WF-20, DTY-02, DTY-03]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE, WORKFLOW_PUBLISH, DOCUMENT_TYPE_MANAGE]
events: []
---

# US-132 — Configurar política de decisão e aprovadores ordenados na etapa

## Título
Configurar a política de decisão (`ANY`, `ALL`, `SEQUENTIAL`) e a lista ordenada de aprovadores da etapa de aprovação e do tipo de documento

## Descrição
**Como** administrador do órgão, **quero** definir, na etapa `APPROVAL` do workflow e na política de aprovação de um tipo de documento, se a decisão é de qualquer aprovador, de todos ou de todos em sequência, e quem são esses aprovadores e em que ordem, **para** que ritos com mais de uma assinatura de decisão (ex.: Secretário e Procurador, cadeia hierárquica) sejam impostos pelo sistema com ordem e rastro.

A story entrega a **configuração**: `WorkflowStage.decisionPolicy` e a lista ordenada `WorkflowStageApprover` (1 a 20 linhas) editadas no rascunho de uma `WorkflowVersion` (SCR-034), a extensão da `approvalPolicy` do `DocumentType` com a mesma política e as mesmas linhas (SCR-108), a validação na validação/publicação do workflow (`WF_APPROVERS_INVALID`) e a clonagem das linhas na cópia de versão. A solicitação (US-133), a decisão (US-134), o redirecionamento e a retirada (US-135) e as visões (US-136) consomem esta configuração. Sem alterá-la, tudo continua como no MVP 1: política `ANY` com um aprovador.

## Contexto
- O MVP 1 tem aprovador único por etapa (`approverType`, `approverUserId`/`approverRoleId`/`approverDepartmentResolution`, `allowDeputy` — RN-WF-08/16, US-040) e por tipo de documento (`DocumentType.approvalPolicy`, RN-DOC-07, US-061); a política é implicitamente `ANY` (DEC-022).
- DEC-193 (resolve PEND-13): `Approval.decisionPolicy` e uma linha por aprovador em `ApprovalApprover`; na etapa, `WorkflowStage.decisionPolicy` e a lista ordenada `WorkflowStageApprover` substituem o aprovador único quando a política não é `ANY`. Com `ANY` e um aprovador o comportamento do MVP 1 é idêntico. Aprovação `ALL` ou `SEQUENTIAL` exige ao menos duas linhas; violação recusa a publicação com `WF_APPROVERS_INVALID` (entities MVP 2 §4.6).
- `WorkflowStageApprover` é imutável em versão publicada (DEC-014). `WorkflowStage.decisionPolicyRules` e `WorkflowStageApprover.applicabilityRule` (alçada por valor) existem no modelo e são preenchidos só pela biblioteca de regras (EP-031, US-198); aqui são preservados, não editados.
- Art. 7º, § 1º da Lei 14.133/2021 (segregação de funções): a configuração impede a mesma pessoa em duas linhas ("ninguém aprova duas vezes"); a verificação de autoria de documento é feita na solicitação e na decisão (US-133, US-134), não aqui.
- O ADR-005 (motor de workflow) e a DEC-014 mantêm a definição declarativa e versionada; o uso da política é opcional por tenant: o workflow padrão v2 (DEC-196) vem com política `ANY` (US-130).

## Objetivo
Permitir configurar e publicar uma etapa de aprovação com 2 a 20 aprovadores ordenados em até 3 minutos, com 100% das versões publicadas sem política inconsistente (menos de duas linhas em `ALL`/`SEQUENTIAL`, pessoa repetida ou aprovador não resolvível) e sem alterar o comportamento de nenhuma etapa que continue `ANY`.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `WORKFLOW_MANAGE`, `WORKFLOW_PUBLISH` e `DOCUMENT_TYPE_MANAGE`).
- **Secundárias:** Gestor de contratações e demais perfis com `WORKFLOW_VIEW` (consulta da política e da ordem); Autoridade competente (conhece a sua posição na ordem); Auditor (lê a trilha de configuração).

## Pré-condições
- Etapa do tipo `APPROVAL` em uma `WorkflowVersion` em `DRAFT` (US-043); ou tipo de documento com `requiresApproval = true` e `approvalPolicy` (US-061).
- Usuário com `WORKFLOW_MANAGE` para editar o rascunho (e `WORKFLOW_PUBLISH` para publicar) ou `DOCUMENT_TYPE_MANAGE` para o tipo de documento.
- Usuários, perfis e unidades referenciados existem, estão ativos no tenant e, para perfil, têm `APPROVAL_DECIDE` (RN-WF-16).

## Fluxo principal
1. No editor do workflow (SCR-034), o administrador seleciona uma etapa `APPROVAL` de uma versão em `DRAFT` e abre "Quem decide" no painel de propriedades.
2. Escolhe a **política de decisão**: "Qualquer um aprova" (`ANY`), "Todos aprovam" (`ALL`) ou "Aprovam em sequência" (`SEQUENTIAL`).
3. Para `ALL` ou `SEQUENTIAL`, monta a **lista de aprovadores**: "Adicionar aprovador" abre o formulário de linha (tipo `USER`, `ROLE` ou `DEPARTMENT_HEAD`, referência, resolução da unidade, "permitir substituto" e rótulo opcional, ex.: "Secretário de Administração"). Em `SEQUENTIAL` a ordem define quem decide primeiro: arrastar (ou botões "Subir/Descer") reordena.
4. Ao salvar, o front envia `PUT /workflow-stages/{stageId}/approvers` (WF-65) com `If-Match` da etapa; a API substitui a lista de forma atômica, renumera `sequence` de 1 a n, espelha a linha 1 nas colunas do aprovador único (RN-APV-08), incrementa `WorkflowVersion.version` e responde com a lista e o estado de cada referência.
5. O painel mostra o resumo da etapa (ex.: "Aprovam em sequência: 1. Secretário de Administração → 2. Procurador-Geral") e, no diagrama (US-046), o selo da política.
6. Ao acionar "Validar" (WF-20) e "Publicar" (WF-21, US-045), a API confere `ALL`/`SEQUENTIAL` com no mínimo duas linhas, pessoas distintas e aprovadores resolvíveis; erros aparecem no `ValidationResultPanel` com link para a etapa e a linha (`params.sequence`).
7. Para o **tipo de documento**, em SCR-108 o bloco "Quem aprova" ganha a mesma escolha de política e a mesma lista ordenada; o front envia o `approvalPolicy` completo em `PATCH /document-types/{id}` (DTY-03) ou `POST /document-types` (DTY-02).
8. A partir da publicação (ou do salvamento do tipo), as **próximas** solicitações usam a nova configuração; aprovações em curso e versões publicadas não mudam (RN-APV-12).

## Fluxos alternativos
- **FA-01 — Voltar a `ANY` com lista vazia:** enviar `decisionPolicy = ANY` e `approvers = []` restaura o aprovador único do MVP 1 (colunas da etapa editáveis de novo).
- **FA-02 — `ANY` com lista:** "qualquer um dos aprovadores listados" é válido: a lista de 1 a 20 linhas é usada e a primeira decisão encerra (RN-APV-02).
- **FA-03 — Rascunho incompleto:** `ALL`/`SEQUENTIAL` com menos de duas linhas é aceito no rascunho (edição em andamento) e só barrado na validação/publicação.
- **FA-04 — Aprovador não resolvível:** usuário sem vínculo ativo, perfil inativo ou sem `APPROVAL_DECIDE`, unidade inativa: erro na validação (`WF_APPROVER_UNRESOLVABLE`); unidade fixa sem titular gera só aviso (`WF_APPROVER_HEAD_MISSING`).
- **FA-05 — Nova versão a partir da publicada:** WF-08 clona etapas, regras e as linhas de aprovadores (ids novos); alçadas (`applicabilityRule`, `decisionPolicyRules`) são copiadas sem alteração.
- **FA-06 — Tipo de documento sem aprovação:** `requiresApproval = false` mantém a última política só para auditoria (RN-DOC-06) e a configuração de linhas não é usada.
- **FA-07 — Edição concorrente:** `If-Match` divergente → 412; o front recarrega a etapa mantendo o formulário.

## Regras de negócio
- **RN-APV-01** — `WorkflowStage.decisionPolicy` ∈ `ANY` (padrão), `ALL`, `SEQUENTIAL`. Só etapa `APPROVAL` aceita valor diferente de `ANY`; em outro tipo, `VALIDATION_ERROR` (`NOT_ALLOWED`). A política é escrita **somente** por WF-65; WF-11 recusa `decisionPolicy` (`NOT_ALLOWED`) para manter política e lista consistentes.
- **RN-APV-02** — Com `ALL`/`SEQUENTIAL` a lista `WorkflowStageApprover` (1 a 20 linhas) substitui o aprovador único da etapa. Com `ANY` e lista vazia vale o aprovador único do MVP 1 (comportamento idêntico, RN-WF-08/16); com `ANY` e lista preenchida, qualquer dos aprovadores listados pode decidir.
- **RN-APV-03** — Limites e ordem: no máximo 20 linhas; `sequence` contígua de 1 a n, calculada pelo servidor a partir da ordem do array (o cliente não envia `sequence`); a ordem só tem efeito de decisão em `SEQUENTIAL`, mas é preservada e exibida nas demais políticas. `ALL`/`SEQUENTIAL` exigem **ao menos duas** linhas na validação e na publicação (`WF_APPROVERS_INVALID`, `params.reason = MIN_LINES`); o rascunho tolera menos (FA-03). Reforça RN-APV-08 da feature FT-066.
- **RN-APV-04** — Forma da linha, igual à do aprovador único: `approverType` ∈ `USER` (`approverUserId`), `ROLE` (`approverRoleId`) ou `DEPARTMENT_HEAD` (`approverDepartmentResolution` ∈ `FIXED`, `REQUESTING_SECRETARIAT`, `REQUESTING_DEPARTMENT` e, se `FIXED`, `approverFixedDepartmentId`); `label` opcional até 120 caracteres. `allowDeputy` é preferência gravada (padrão `true`); o efeito real segue RN-TRAM-48: `true` só para `DEPARTMENT_HEAD`, `false` para `USER` e `ROLE`.
- **RN-APV-05** — Unicidade ("ninguém aprova duas vezes"): a lista não aceita duas linhas `USER` com o mesmo usuário, duas `ROLE` com o mesmo perfil nem duas `DEPARTMENT_HEAD` com a mesma resolução e a mesma unidade; repetição → `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) na escrita e `WF_APPROVERS_INVALID` (`params.reason = DUPLICATE_APPROVER`) na validação. A coincidência de pessoas resolvidas (titular de duas unidades, usuário que também tem o perfil) é tratada na solicitação (US-133).
- **RN-APV-06** — Resolubilidade na validação e na publicação, por linha, como RN-WF-16: `USER` com vínculo `ACTIVE`; `ROLE` existente, ativo e com `APPROVAL_DECIDE`; `DEPARTMENT_HEAD` `FIXED` com unidade ativa (sem titular, só aviso `WF_APPROVER_HEAD_MISSING`). Erro: `WF_APPROVER_UNRESOLVABLE` com `params.sequence`. A cobertura de `ROLE` sobre a unidade solicitante é verificada em execução (DEC-022).
- **RN-APV-07** — Alçada preservada: `WorkflowStage.decisionPolicyRules` e `WorkflowStageApprover.applicabilityRule` (`RuleRef`) não são aceitos em WF-65 (`NOT_ALLOWED`); são mantidos intactos em WF-08 e preenchidos só pela biblioteca de regras (EP-031, US-198).
- **RN-APV-08** — Espelho de compatibilidade (fase *expand*): com lista não vazia, as colunas do aprovador único da etapa (`approverType` e referências, `allowDeputy`) espelham a linha 1, para que leitores do MVP 1 e a validação `WF_APPROVER_UNRESOLVABLE` continuem funcionando; essas colunas ficam somente leitura (WF-11 → `NOT_ALLOWED`) enquanto a lista existir. Com lista vazia, voltam a ser editáveis.
- **RN-APV-09** — WF-65 só aceita versão `DRAFT` (`WORKFLOW_VERSION_NOT_DRAFT`), exige `If-Match` com a `version` da etapa (DEC-104; 428/412) e substitui a lista de forma atômica; toda escrita incrementa `WorkflowVersion.version` (RN-WF-06). Enviar o mesmo conteúdo já gravado é *no-op*: 200 sem incremento de versão e sem auditoria.
- **RN-APV-10** — Cópia e publicação: WF-08 clona as linhas com ids novos; a publicação grava `decisionPolicy` e as linhas (por `sequence`) no `definitionSnapshot` canônico e no `definitionHash` (DEC-084); depois de publicada, a versão é imutável (trigger estendido a `workflow_stage_approvers`). Para versões do MVP 1 (política `ANY`, sem linhas) o snapshot e o hash não mudam.
- **RN-APV-11** — Tipo de documento: `DocumentType.approvalPolicy` aceita `decisionPolicy` (padrão `ANY`) e `approvers[]` (1 a 20 linhas, mesma forma da RN-APV-04, sem `sequence` enviada); `ALL`/`SEQUENTIAL` exigem ao menos duas linhas **no salvamento** (não há rascunho de tipo): `DOCUMENT_APPROVAL_POLICY_INVALID` (422); as colunas do aprovador único espelham a linha 1; as regras de unicidade (RN-APV-05) e de resolubilidade (RN-APV-06) valem na escrita. O prazo (`slaDays`/`slaType`) continua do tipo e é objeto da US-137.
- **RN-APV-12** — Alterar política ou aprovadores vale só para solicitações futuras: nunca altera aprovações em curso, linhas já criadas, versões publicadas nem processos já fixados (DEC-014, RN-DOC-08). A solicitação copia a configuração vigente no momento (US-133).
- **RN-APV-13** — Autorização: WF-65 exige `WORKFLOW_MANAGE`; publicar, `WORKFLOW_PUBLISH`; DTY-02/DTY-03, `DOCUMENT_TYPE_MANAGE`. As três são risco `H` quando aplicável (MFA conforme `security.mfaPolicy`).
- **RN-APV-14** — Apresentação: rótulos pt-BR "Qualquer um aprova", "Todos aprovam" e "Aprovam em sequência"; o resumo da etapa lista as linhas na ordem (`label` ou o nome resolvido); o `ValidationResultPanel` e o diagrama (US-046) mostram a política e apontam a linha com erro. Os rótulos entram em `terminology.md`.
- **RN-APV-15** — Compatibilidade: toda etapa `APPROVAL` e todo tipo de documento existentes assumem `ANY` sem linhas (padrão da migração M2-04); não há *backfill* de `WorkflowStageApprover`; a API de leitura (WF-09, DTY-01) devolve `decisionPolicy` e `approvers[]` de forma aditiva (DEC-108) e o comportamento do MVP 1 não muda para quem não configurar nada.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Política de decisão | `decisionPolicy` (etapa e `approvalPolicy`) | seleção (`ApprovalDecisionPolicy`) | Sim (WF-65) | RN-APV-01 | `ANY` |
| Aprovadores | `approvers[]` | lista ordenada | Condicional | 1 a 20; ≥ 2 em `ALL`/`SEQUENTIAL` na validação | `[]` |
| Tipo de aprovador | `approvers[].approverType` | seleção (`ApproverType`) | Sim | `USER`, `ROLE`, `DEPARTMENT_HEAD` | — |
| Usuário | `approvers[].approverUserId` | seletor (`USR-02`) | Se `USER` | vínculo ativo | — |
| Perfil | `approvers[].approverRoleId` | seletor (`ROL-02`) | Se `ROLE` | perfil ativo com `APPROVAL_DECIDE` | — |
| Resolução da unidade | `approvers[].approverDepartmentResolution` | seleção | Se `DEPARTMENT_HEAD` | `FIXED`, `REQUESTING_SECRETARIAT`, `REQUESTING_DEPARTMENT` | `REQUESTING_SECRETARIAT` |
| Unidade fixa | `approvers[].approverFixedDepartmentId` | seletor (`DEP-02`) | Se `FIXED` | unidade ativa | — |
| Permitir substituto | `approvers[].allowDeputy` | interruptor | Não | efeito só em `DEPARTMENT_HEAD` (RN-APV-04) | `true` |
| Rótulo | `approvers[].label` | texto | Não | até 120 caracteres | nome resolvido |
| *(sistema)* Ordem | `approvers[].sequence` | inteiro | — | 1..n, calculada pelo servidor | posição no array |
| *(sistema)* Estado da referência | `approvers[].resolved.status` | `OK` \| `INACTIVE` \| `NO_HEAD` | — | só resposta | calculado |
| *(sistema)* Alçada | `decisionPolicyRules`, `applicabilityRule` | JSON | — | não editáveis aqui (RN-APV-07) | EP-031 |
| Versão da etapa | `If-Match` (WF-65) | ETag | Sim | DEC-104 | lida de WF-09 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `decisionPolicy` fora do enum | Front + API (Zod) | "Selecione como a decisão será tomada." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | Política diferente de `ANY` em etapa que não é `APPROVAL` | API | "Só etapas de aprovação têm política de decisão." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-03 | Mais de 20 aprovadores | Front + API | "Informe no máximo 20 aprovadores." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-04 | Referência ausente ou incompatível com o tipo de aprovador | Front + API | "Informe o aprovador da linha {n}." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`NOT_ALLOWED`) |
| V-05 | Pessoa, perfil ou unidade repetidos na lista | Front + API | "O mesmo aprovador não pode aparecer duas vezes." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-06 | Usuário, perfil ou unidade inexistente, inativo ou de outro tenant | API | "Selecione um aprovador válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-07 | `label` acima de 120 caracteres | Front + API | "O rótulo deve ter até 120 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-08 | Envio de `sequence`, `applicabilityRule` ou `decisionPolicyRules` | API (Zod) | "Este campo não pode ser alterado aqui." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-09 | Editar aprovador único da etapa (WF-11) com lista preenchida | API | "O aprovador desta etapa é definido pela lista de aprovadores." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-10 | Escrita em versão que não é `DRAFT` | API + trigger | "Esta versão já foi publicada e não pode ser alterada. Crie uma nova versão." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-11 | `If-Match` ausente / divergente | API | "Outra pessoa alterou esta etapa. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-12 | `ALL`/`SEQUENTIAL` com menos de duas linhas, pessoa repetida ou política inválida (validação/publicação) | API | "A etapa {nome} precisa de ao menos dois aprovadores distintos." | `WORKFLOW_INVALID` (`WF_APPROVERS_INVALID`, `params.reason`) |
| V-13 | Aprovador não resolvível na validação | API | "O aprovador da linha {n} da etapa {nome} não pode ser determinado." | `WORKFLOW_INVALID` (`WF_APPROVER_UNRESOLVABLE`) |
| V-14 | Tipo de documento com `ALL`/`SEQUENTIAL` e menos de duas linhas | Front + API | "Informe ao menos dois aprovadores para esta política." | `DOCUMENT_APPROVAL_POLICY_INVALID` |

## Permissões
- **Permissão:** `WORKFLOW_MANAGE` (WF-65, WF-08, WF-11); `WORKFLOW_VIEW` (WF-09, WF-20); `WORKFLOW_PUBLISH` (publicação, WF-21 da US-045); `DOCUMENT_TYPE_MANAGE` (DTY-02, DTY-03).
- **Políticas:** nenhuma política contextual de processo; edição só em rascunho (RN-WF-54/RN-WF-65 do MVP 1); POL-14 (MFA).
- **MFA:** `WORKFLOW_MANAGE`, `WORKFLOW_PUBLISH` e `DOCUMENT_TYPE_MANAGE` (quando de risco `H`) exigem sessão com MFA conforme `security.mfaPolicy` (`ADMINS` ou `ALL`); sem MFA → 403 `MFA_REQUIRED`.
- **Sem permissão:** "Quem decide" e "Quem aprova" aparecem em modo leitura sem permissão de edição; ações ocultas; a API responde 403 `PERMISSION_DENIED` e registra `access.denied` (`reasonCode`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio na edição de rascunho (como US-043/US-044); a publicação gera `WorkflowVersionPublished` (US-045) e a alteração de tipo de documento, `DocumentTypeChanged` (US-061). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: configuração de rascunho não notifica ninguém. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Configurar política de decisão e aprovadores ordenados na etapa

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And existe o workflow "Fase preparatória — Lei 14.133/2021" com a versão 3 em "DRAFT"
    And a etapa "AUTORIZACAO_LICITACAO" (tipo "APPROVAL") e a etapa "ESTUDOS_PRELIMINARES" (tipo "TASK") existem nessa versão
    And "Carla" tem vínculo ativo com o perfil "ADMIN_ORGAO" (WORKFLOW_MANAGE, WORKFLOW_PUBLISH, DOCUMENT_TYPE_MANAGE) e MFA na sessão

  Scenario: [Sucesso] Configurar aprovação em sequência com dois aprovadores e publicar
    When "Carla" definir em "AUTORIZACAO_LICITACAO" a política "SEQUENTIAL" com 1. titular da "Secretaria de Administração" (unidade fixa) e 2. o usuário "Marcos" (Procurador-Geral)
    Then a API deve responder 200 com as linhas de "sequence" 1 e 2
    And as colunas do aprovador único da etapa devem espelhar a linha 1
    And deve gerar registro de auditoria "workflow.update" com "decisionPolicy" "SEQUENTIAL" e "approversCount" 2
    When "Carla" validar a versão
    Then a API deve responder 200 com "valid" verdadeiro
    When "Carla" publicar a versão com as notas "Aprovação do edital por Secretário e Procurador"
    Then o "definitionSnapshot" deve conter a política e as duas linhas na ordem
    And as aprovações em andamento não devem ser alteradas

  Scenario: [Sucesso] Política "ALL" no tipo de documento "NOTA_TECNICA"
    Given que o tipo "NOTA_TECNICA" tem "requiresApproval" verdadeiro
    When "Carla" salvar o "approvalPolicy" com "decisionPolicy" "ALL" e os aprovadores "Marcos" e o perfil "AUTORIDADE_COMPETENTE"
    Then a API deve responder 200 com as duas linhas
    And deve gerar registro de auditoria "document_type.update" com a mudança de "approvalPolicy"
    And documentos já submetidos não devem mudar de aprovação

  Scenario: [Sucesso] Etapa sem configuração continua como no MVP 1
    Given que a etapa "APROVACAO_DFD" tem política "ANY" e aprovador único "DEPARTMENT_HEAD" da secretaria solicitante
    When "Carla" consultar a versão
    Then a etapa deve vir com "decisionPolicy" "ANY" e "approvers" vazio
    And o comportamento da aprovação deve ser o do MVP 1

  Scenario: [Validação] Política sem aprovadores suficientes, fora de etapa de aprovação e limite
    Given que "Carla" salvou "ALL" com apenas o usuário "Marcos" no rascunho
    When "Carla" validar a versão
    Then "errors" deve conter "WF_APPROVERS_INVALID" com "params.reason" "MIN_LINES" para "AUTORIZACAO_LICITACAO"
    When "Carla" tentar publicar a versão
    Then a API deve responder 422 com código "WORKFLOW_INVALID"
    When "Carla" definir "ALL" na etapa "ESTUDOS_PRELIMINARES"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "decisionPolicy"
    When "Carla" enviar 21 aprovadores
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_LONG" no campo "approvers"

  Scenario: [Permissão] Usuário somente leitura tenta configurar
    Given que "Bruno" possui apenas "WORKFLOW_VIEW"
    When "Bruno" enviar PUT dos aprovadores da etapa "AUTORIZACAO_LICITACAO"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Etapa e aprovador de outro tenant
    Given que existe a etapa "AUTORIZACAO_LICITACAO" de um workflow do tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura A", enviar PUT dos aprovadores para essa etapa
    Then a API deve responder 404 com código "NOT_FOUND"
    When "Carla" informar como aprovador um usuário do tenant "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "approvers[0].approverUserId"

  Scenario: [Duplicidade] Mesmo aprovador duas vezes e reenvio da mesma lista
    When "Carla" informar o usuário "Marcos" nas linhas 1 e 2
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DUPLICATE_IN_LIST"
    Given que a lista "Roberto", "Marcos" já está gravada
    When "Carla" reenviar a mesma lista com a ETag atual
    Then a API deve responder 200 sem incrementar a versão da etapa
    And não deve gerar novo registro de auditoria

  Scenario: [Concorrência] Edição simultânea da mesma etapa
    Given que "Carla" e "Diego" abrem a etapa com a mesma ETag
    When "Diego" salvar primeiro e "Carla" enviar PUT com a ETag antiga
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And a lista de "Diego" deve permanecer

  Scenario: [Falha de banco] Banco indisponível ao salvar a lista
    Given que o banco de dados fica indisponível
    When "Carla" salvar a política e a lista
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a política e as linhas anteriores devem permanecer inalteradas

  Scenario: [Falha de integração] Cache de permissões no Redis indisponível
    Given que o Redis de cache de permissões está indisponível
    When "Carla" salvar a política e a lista
    Then a API deve responder 200 recalculando as permissões a partir do banco
    And deve registrar um aviso de degradação sem expor erro ao usuário
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (política, limites, referências) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca a linha e o campo |
| Aprovador repetido | 422 | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) | "O mesmo aprovador não pode aparecer duas vezes." | Destaca as linhas repetidas |
| Referência inexistente/inativa | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um aprovador válido." | Recarrega as opções |
| Política inválida na validação/publicação | 422 | `WORKFLOW_INVALID` (`WF_APPROVERS_INVALID`) | "A etapa {nome} precisa de ao menos dois aprovadores distintos." | `ValidationResultPanel` com link para a linha |
| Aprovador não resolvível | 422 | `WORKFLOW_INVALID` (`WF_APPROVER_UNRESOLVABLE`) | "O aprovador da linha {n} da etapa {nome} não pode ser determinado." | Idem |
| Política do tipo de documento inválida | 422 | `DOCUMENT_APPROVAL_POLICY_INVALID` | "Informe ao menos dois aprovadores para esta política." | Marca o bloco "Quem aprova" |
| Versão não é rascunho | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão já foi publicada e não pode ser alterada. Crie uma nova versão." | Oferece "Criar novo rascunho" |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "Outra pessoa alterou esta etapa. Recarregue para continuar." | Recarrega a etapa |
| Etapa ou tipo inexistente/outro tenant | 404 | `NOT_FOUND` | "Etapa não encontrada." | Volta ao editor |
| Sem permissão / sem MFA | 403 | `PERMISSION_DENIED` / `MFA_REQUIRED` | "Você não tem permissão para editar aprovadores." / "Confirme sua identidade (MFA) para continuar." | Oculta ações; abre o desafio de MFA |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Botão "Tentar novamente"; mantém o formulário |

Avisos de validação (`warnings[]`): `WF_APPROVER_HEAD_MISSING` por linha (`params.sequence`), `WF_STAGE_NO_SLA` e os do MVP 1.

## Dependências
- **Stories:** US-040 (modelo, `WF_*` e RN-WF-08/16), US-043 (editor e rascunho), US-045 (validação, publicação, versionamento), US-061 (`approvalPolicy` do tipo de documento). Habilita US-133 (solicitar com várias linhas), US-134, US-135, US-136 e US-198 (alçadas, EP-031).
- **Decisões/ADRs:** DEC-193, DEC-022, DEC-014, DEC-084, DEC-104, DEC-108; ADR-005.
- **Configurações:** nenhuma nova.
- **Lacunas nas fontes canônicas:**
  1. `entities.md` não diz o que acontece com as colunas do aprovador único de `WorkflowStage` e de `approvalPolicy` quando a lista é usada; proposta: espelham a linha 1 e ficam somente leitura (RN-APV-08, RN-APV-11), à semelhança do espelho da `Approval` (§5.9).
  2. `DocumentType.approvalPolicy` (entities MVP 1 §5.7) não tem `decisionPolicy` nem `approvers[]`, embora §5.9 do MVP 2 diga que `Approval.decisionPolicy` é "copiada da etapa ou da `approvalPolicy` do tipo de documento"; é preciso ampliar o `approvalPolicySchema` (aditivo) e registrar em entities.md.
  3. O código `DOCUMENT_APPROVAL_POLICY_INVALID` (422) é novo; `WF_APPROVERS_INVALID` aparece em entities §4.6, mas sem catálogo de `params.reason` (`MIN_LINES`, `DUPLICATE_APPROVER`); registrar em `api.md`.
  4. A rota indicativa da feature (`PUT /workflows/{id}/versions/{versionId}/stages/{stageId}/approvers`) foi ajustada para `PUT /workflow-stages/{stageId}/approvers`, seguindo o padrão `WF-11` do MVP 1.
  5. Permissão do tipo de documento: `DOCUMENT_TYPE_MANAGE` conforme US-061; SCR-108 não está no Apêndice A de `features.md` para esta story.

## Impacto técnico
- **Compatibilidade:** todas as etapas e tipos existentes viram `ANY` sem linhas (migração M2-04, reversível); leitores do MVP 1 continuam lendo o aprovador único (espelho da linha 1); WF-09 e DTY-01 ganham campos aditivos (DEC-108).
- **Hash e imutabilidade:** `workflow_stage_approvers` entra no gatilho de imutabilidade de versão publicada e no `definitionSnapshot` canônico; versões sem política `ANY`/lista mantêm o `definitionHash` do MVP 1 (comparabilidade com a semente, US-130).
- **Validação central:** a regra de linhas e unicidade é do domínio (`StageApproversPolicy`), compartilhada por WF-65, WF-20/WF-21 e DTY-02/DTY-03; as mensagens por linha reaproveitam `params.sequence`.
- **Rascunhos e cópia:** WF-08 deve clonar linhas com ids novos e preservar `applicabilityRule`/`decisionPolicyRules`.
- **Limites:** 20 linhas por etapa e por tipo; o limite de 200 regras e 50 etapas por versão (RN-WF-18) não muda.

## Backend
- **Módulo(s):** `workflow` (dono: `WorkflowStageApprover`, política da etapa, validação), `document` (extensão do `approvalPolicy`), `approval` (consome a configuração na US-133), `access` (`AuthorizationService`), `audit`, `platform`.
- **Casos de uso:** `SetStageApproversCommand` (WF-65), `CloneWorkflowVersionCommand` (WF-08, estendido), `ValidateWorkflowVersionQuery` (WF-20, estendido), `UpdateDocumentTypeCommand` (DTY-02/DTY-03, estendido).
- **Domínio:** `StageApproversPolicy` (política, 1..20 linhas, contiguidade de `sequence`, unicidade, espelho da linha 1); `ApproverLine` (value object compartilhado com `ApprovalPolicy` do tipo); `WorkflowStage.setDecisionPolicy`.
- **Integrações internas:** `IdentityFacade`/`AccessFacade` (usuário, vínculo, perfil e `APPROVAL_DECIDE`), `OrganizationFacade` (unidade e titular), `DocumentFacade` (tipo de documento).
- **Transação:** em uma transação com `app.tenant_id`: trava da etapa e da versão → substituição atômica das linhas → espelho → incremento de `version` → auditoria.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`) — painel de propriedades da etapa `APPROVAL`; SCR-108 (`/admin/tipos-de-documento`) — bloco "Quem aprova".
- **Componentes:** `DecisionPolicySelect`, `ApproverLinesEditor` (arrastar e botões "Subir/Descer"), `ApproverLineForm` (tipo, seletor `USR-02`/`ROL-02`/`DEP-02`, resolução, rótulo), `ApproverSummary` (ordem e política), `ValidationResultPanel` (link à linha), selo da política no `StageNode` do diagrama.
- **Estados:** loading (skeleton do painel); vazio ("Nenhum aprovador definido — a etapa usa o aprovador único"); erro de validação por linha; conflito de edição (recarrega e mantém o formulário); sucesso (toast "Aprovadores salvos").
- **Acessibilidade e responsividade:** reordenação por teclado (setas) além do arrastar; ordem anunciada por `aria-live` ("Procurador-Geral movido para a posição 2"); política e erros comunicados por texto e ícone; painel lateral vira modal abaixo de 768 px.

## Banco de dados
- **Tabelas:** `workflow_stage_approvers` (nova, M2-04), `workflow_stages` (`decision_policy`, `decision_policy_rules`), `workflow_versions` (`definition_snapshot`, `version`), `document_types` (`approval_policy` jsonb), `audit_logs`.
- **Migrações:** nenhuma nova (M2-04 cria as colunas e a tabela; reversível).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, workflow_stage_id, sequence)`; FK `workflow_stage_id` com `CASCADE` só em `DRAFT`; trigger de imutabilidade estendido; `CHECK` de tipo × coluna do aprovador por linha (como na etapa); `approval_policy` validado por Zod (`approvalPolicySchema` ampliado).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `WF-65` | PUT | `/workflow-stages/{stageId}/approvers` | `{ decisionPolicy, approvers: [{ approverType, approverUserId?, approverRoleId?, approverDepartmentResolution?, approverFixedDepartmentId?, allowDeputy?, label? }] }` + `If-Match` | `200 { data: { stageId, decisionPolicy, approvers: [{ id, sequence, …, resolved { label, status } }] } }` · `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `WF-08` | POST | `/workflows/{id}/versions` | como no MVP 1 | cópia inclui `decisionPolicy` e `approvers[]` | 201, 403, 404, 409, 422 |
| `WF-09` | GET | `/workflow-versions/{versionId}` | — | etapas com `decisionPolicy` e `approvers[]` (aditivo) | 200, 403, 404 |
| `WF-11` | PATCH | `/workflow-stages/{stageId}` | como no MVP 1 | recusa `decisionPolicy` e o aprovador único com lista preenchida | 200, 403, 409, 412, 422, 428 |
| `WF-20` | POST | `/workflow-versions/{versionId}/validate` | — | `errors[]` com `WF_APPROVERS_INVALID` / `WF_APPROVER_UNRESOLVABLE` e `params.sequence`/`params.reason` | 200, 404 |
| `DTY-02` | POST | `/document-types` | `approvalPolicy` com `decisionPolicy?` e `approvers[]?` | `201 { data: DocumentType }` | 201, 403, 409, 422 |
| `DTY-03` | PATCH | `/document-types/{id}` | idem + `If-Match` | `200 { data: DocumentType }` | 200, 403, 404, 412, 422, 428 |

## Logs
- `info` `workflow.stage_approvers_set` — `workflowVersionId`, `stageId`, `decisionPolicy`, `approversCount`, `durationMs`.
- `info` `document_type.approval_policy_changed` — `documentTypeId`, `decisionPolicy`, `approversCount`.
- `warn` `workflow.stage_approvers_conflict` (412) e `workflow.stage_approvers_rejected` — `reason` (`NOT_DRAFT`, `DUPLICATE`, `REFERENCE`).
- `error` `workflow.stage_approvers_write_failed` — causa, `correlationId`.
- **Nunca logar:** nomes de pessoas, e-mails ou CPF dos aprovadores; só ids e contagens.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.update` | `CONFIGURATION` | WF-65 com alteração efetiva | `changes`: `decisionPolicy`, `approvers` (por `sequence`: tipo e referência); `metadata`: `workflowVersionId`, `stageId`, `stageKey`, `approversCount` |
| `workflow.version_create` | `CONFIGURATION` | WF-08 | `metadata`: `sourceVersionId`, `newVersionId` (MVP 1) |
| `document_type.update` | `CONFIGURATION` | DTY-02/DTY-03 | `changes`: `approvalPolicy` campo a campo (inclui política e linhas); `metadata`: `code`, `isSystem` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = WORKFLOW_MANAGE` ou `DOCUMENT_TYPE_MANAGE` |

## Testes necessários
- **Unitários:** `StageApproversPolicy` (mínimo de linhas por política, limite de 20, contiguidade, unicidade por tipo e referência, espelho da linha 1, *no-op* idempotente); `ApproverLine` por tipo; esquema `approvalPolicySchema` ampliado.
- **Integração (Testcontainers PostgreSQL + Redis):** WF-65 atômico com versão da etapa e da `WorkflowVersion`; WF-08 clona linhas e preserva alçadas; WF-20/WF-21 com cada `params.reason`; trigger de imutabilidade em versão publicada; DTY-02/DTY-03 com política; `definitionHash` de versão do MVP 1 inalterado.
- **API/contrato:** WF-65 conforme a tabela; WF-09, DTY-01 e WF-11 do MVP 1 sem quebra (campos aditivos); códigos de erro.
- **RBAC e multi-tenant:** `WORKFLOW_VIEW` × `WORKFLOW_MANAGE`/`WORKFLOW_PUBLISH`/`DOCUMENT_TYPE_MANAGE`; MFA; etapa e aprovador de outro tenant → 404/422 (suíte `test/tenant-leak`).
- **Concorrência:** duas escritas da mesma etapa (412); edição × publicação da versão.
- **E2E (Playwright):** configurar `SEQUENTIAL` com dois aprovadores, validar, publicar e ver o diagrama; configurar `ALL` no tipo de documento.
- **Acessibilidade/performance:** axe no editor de linhas (reordenação por teclado) e no painel de validação; 360 px.

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
- [ ] Contrato do MVP 1 (WF-09, WF-11, DTY-01) verificado como inalterado para etapas `ANY`
- [ ] Snapshot e `definitionHash` das versões do MVP 1 inalterados (teste)

## Estimativa
**M** — modelo e tabela já definidos, mas a story cobre dois pontos de configuração (etapa e tipo de documento), validação por linha na publicação, clonagem e compatibilidade com leitores do MVP 1.

## Prioridade
**P0** — primeiro card da aprovação múltipla (DT-03); a solicitação, a decisão e as visões dependem desta configuração.
