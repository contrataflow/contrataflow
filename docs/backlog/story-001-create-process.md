---
id: US-001
title: "Criar processo de contratação"
epic: EP-001
feature: FT-001
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-042, US-059, US-073, US-082, US-097, US-102, US-104, US-105]
modules: [process, workflow, catalog, organization, access, timeline, audit, platform]
screens: [SCR-005, SCR-006]
endpoints: [PRC-02, PRC-03, WF-06, CAT-01, DEP-01, DEP-02, ORG-01, ME-01]
permissions: [PROCESS_CREATE]
events: [ProcessCreated]
---

# US-001 — Criar processo de contratação

## Título
Criar processo de contratação

## Descrição
**Como** servidor da área requisitante (ou gestor de contratações), **quero** abrir um processo de contratação informando apenas os dados essenciais, **para** iniciar formalmente a demanda com número único, workflow definido, responsável claro e rastreabilidade desde o primeiro minuto.

A criação acontece em um wizard de três passos (Identificação → Origem e planejamento → Revisão). Ao confirmar, o sistema cria — em uma única transação — o processo em `DRAFT`, atribui número (conforme a configuração), fixa a versão do workflow aplicável, posiciona o processo na etapa inicial sob custódia do criador, concede a visibilidade inicial, registra a tramitação de abertura, a timeline, a auditoria e o evento `ProcessCreated`. Em seguida o usuário é levado ao painel do processo, que já indica o próximo passo (ex.: "Elaborar o DFD").

## Contexto
- Hoje as demandas nascem em memorandos, e-mails e mensagens; a numeração é manual (planilhas, livros de protocolo), há duplicidades e não se sabe quem está com o processo.
- Na Lei 14.133/2021, a fase preparatória (art. 18) se inicia com a formalização da demanda; o DFD (Decreto 10.947/2022) é elaborado **dentro** do processo — por isso o processo é criado primeiro e o DFD é o primeiro artefato (US-014).
- O processo é o agregado central (DEC-010). Status macro × etapa (DEC-013), workflow versionado e fixado na criação (DEC-014/DEC-015), numeração por sequência transacional (DEC-028), referência ao PCA sem entidade PCA no MVP 1 (DEC-029), visibilidade por `ProcessAccess` (DEC-024), auditoria transacional e outbox (DEC-161).
- Esta é a primeira story de negócio implementada sobre a fundação; ela estabelece os padrões de comando transacional (contexto de tenant + auditoria + outbox + projeções síncronas) que as demais stories seguirão.

## Objetivo
Permitir que um usuário autorizado crie um processo válido em até 2 minutos, com 100% dos processos criados possuindo: número único no escopo configurado (quando `assignOn = CREATE`), versão de workflow fixada, etapa inicial ativa com responsável, concessões de acesso, registro de auditoria e evento publicado — de forma atômica.

## Persona
- **Principal:** Área requisitante (perfil `REQUISITANTE`, escopo `OWN_DEPARTMENTS`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), Planejamento (`PLANEJAMENTO`), Compras (`COMPRAS`), Gestor de contrato (`GESTOR_CONTRATO`).

## Pré-condições
- Usuário autenticado (US-087), tenant `ACTIVE`, vínculo `ACTIVE` e não expirado.
- Usuário possui `PROCESS_CREATE` em escopo que cubra ao menos uma unidade (US-097).
- Existe ao menos um `Organization` ativo e unidades ativas (US-101, US-102).
- Catálogos `CONTRACTING_TYPE` e `PROCESS_ORIGIN` têm itens ativos (US-104).
- Existe workflow publicado aplicável ou workflow padrão (US-042).
- Numeração configurada (US-105) — os padrões semeados bastam.

## Fluxo principal
1. O usuário aciona **"Novo processo"** (botão global no cabeçalho, no Dashboard SCR-003, na lista SCR-004 ou na caixa SCR-013).
2. O sistema abre o wizard SCR-005 no passo **1 — Identificação** e carrega em paralelo: catálogos (`CAT-01` para `CONTRACTING_TYPE`, `MODALITY`, `PROCESS_ORIGIN`), órgãos (`ORG-01`), unidades (`DEP-01`) e o vínculo do usuário (`ME-01`). Exibe skeleton até os dados chegarem.
3. O usuário informa **Título**, **Objeto**, **Descrição** (opcional), **Tipo de contratação**, **Modalidade prevista** (opcional — vazio = "A definir") e **Registro de preços** (opcional) e clica em **"Continuar"**. O front valida com `createProcessSchema` (Zod) e só avança se válido.
4. No passo **2 — Origem e planejamento**, o sistema pré-preenche **Órgão/entidade** (órgão principal do tenant; campo oculto se houver um só), **Secretaria solicitante** e **Setor solicitante** (a partir da lotação principal do usuário) e **Prioridade = Média**. O usuário ajusta, informa **Prazo alvo** (opcional), **Valor estimado** (opcional), **Origem** e a **Situação no PCA** (Previsto / Não previsto / Não se aplica), com os campos condicionais (exercício e item do PCA, ou justificativa).
5. No passo **3 — Revisão**, o sistema exibe o resumo e, em paralelo:
   - chama `PRC-03` (verificação de duplicidade) e, se houver candidatos, mostra o aviso "Encontramos processos parecidos" com links;
   - chama `WF-06` (resolução de workflow) e mostra o cartão "Este processo seguirá o fluxo **Fase preparatória — Lei 14.133/2021**, começando em **Formalização da demanda**";
   - oferece os campos opcionais **Código interno** e **Observações** (progressive disclosure: seção "Mais informações", recolhida).
6. O usuário clica em **"Criar processo"**. O front envia `POST /api/v1/processes` com `Idempotency-Key` (gerada uma vez por sessão do wizard) e desabilita o botão, exibindo "Criando processo…".
7. A API, em **uma transação** com `app.tenant_id` definido:
   1. valida o corpo (Zod) e as referências (catálogos ativos, unidades ativas do mesmo órgão, setor na subárvore da secretaria);
   2. autoriza: `PROCESS_CREATE` com escopo que cubra o `requestingDepartmentId` (POL de escopo, §1.1 de permissions.md);
   3. verifica `internalCode` único (se informado) e a heurística de duplicidade (exceto se `confirmDuplicate = true`);
   4. resolve o workflow aplicável (`WorkflowFacade.resolveApplicable(RuleContext.process)`) e obtém a etapa inicial da versão publicada;
   5. se `numbering.process.assignOn = CREATE`: obtém o próximo número (`NumberingFacade.next('PROCESS:<escopo>:<ano>')` — `UPDATE … RETURNING` com bloqueio da linha) e formata o `code` pela máscara;
   6. insere `Process` (`status = DRAFT`, `openedAt = now` se numerado, `creationChannel = WEB`);
   7. cria `ProcessStage` nº 1 (etapa inicial, `ACTIVE`), resolvendo a unidade pela regra da etapa (padrão: `REQUESTING_DEPARTMENT`) e o responsável pela política da etapa (padrão: `CREATOR`), calcula `dueAt` se a etapa tiver SLA (dias úteis — US-106);
   8. cria `ProcessAssignment` (`STAGE_ENTRY`, ativo) e `ProcessMovement` nº 1 (`CREATE`, com IP, user-agent, correlationId);
   9. atualiza `currentStageId`, `currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId`, `currentStageDueAt`;
   10. grava concessões `ProcessAccess` (`REQUESTING` para secretaria e setor, `CURRENT` para a unidade da etapa, `CREATOR` e `RESPONSIBLE` para o usuário);
   11. grava `AuditLog` `process.create`, o evento `ProcessCreated` no outbox e — pelo projetor síncrono — a entrada `PROCESS_CREATED` na timeline;
   12. confirma a transação.
8. A API responde **201** com o processo, `Location: /api/v1/processes/{id}` e `ETag: "1"`.
9. O front invalida as consultas de lista/contadores do tenant, limpa o rascunho local do wizard e navega para **SCR-006** (`/processos/{id}`), exibindo o toast "Processo 0012/2026 criado" e, no painel situacional, o próximo passo configurado na etapa ("Elabore o DFD para formalizar a demanda").

## Fluxos alternativos
- **FA-01 — Abandonar o wizard:** ao clicar em "Cancelar" ou sair da rota com alterações, o sistema pede confirmação. Os dados digitados ficam em `sessionStorage` (por usuário + tenant) para retomada em caso de recarga acidental da página; nada é gravado no servidor antes de "Criar processo".
- **FA-02 — Possível duplicidade:** `PRC-03` (ou o próprio `POST`, como salvaguarda) encontra processos com título ou objeto semelhantes (similaridade trigram ≥ 0,6) criados pelo mesmo usuário ou para o mesmo setor solicitante dentro de `process.duplicateDetectionWindowMinutes` (padrão 10 min). O sistema lista os candidatos (código, título, status, criador, data) com links. O usuário pode **"Abrir processo existente"** ou **"Criar mesmo assim"** (reenvia com `confirmDuplicate: true`; a confirmação é registrada na auditoria).
- **FA-03 — Numeração na autuação (`assignOn = START`):** o processo é criado sem `number`/`code`; a UI exibe "Rascunho (sem número)"; o número é atribuído no primeiro encaminhamento (US-047). `openedAt` fica nulo até lá.
- **FA-04 — Tenant com vários órgãos:** o campo "Órgão/entidade" aparece no passo 2; trocar o órgão limpa secretaria/setor e recarrega as opções. Com `numbering.process.scope = ORGANIZATION`, a revisão mostra que a numeração é por órgão.
- **FA-05 — Usuário com várias lotações:** o setor padrão é a lotação principal; o seletor destaca as demais lotações no topo da lista.
- **FA-06 — Nenhum workflow aplicável:** `WF-06` (ou o `POST`) retorna `NO_APPLICABLE_WORKFLOW`; a revisão mostra "Não há fluxo configurado para este tipo de contratação. Fale com o administrador do órgão." e o botão "Criar processo" fica desabilitado. Os dados do wizard são mantidos.
- **FA-07 — Reenvio após falha de rede:** se a resposta não chegar, o front reenvia com a **mesma** `Idempotency-Key`; a API devolve a resposta original (`Idempotent-Replayed: true`) e nenhum processo duplicado é criado.
- **FA-08 — Escopo sem a unidade desejada:** o seletor de setor lista apenas unidades cobertas pelo escopo de `PROCESS_CREATE` do usuário; se nenhuma estiver disponível, o botão "Novo processo" não é exibido.
- **FA-09 — `internalCode` exigido:** com `process.requireInternalCode = true`, o campo "Código interno" sai de "Mais informações" e torna-se obrigatório no passo 3.

## Regras de negócio
- **RN-PROC-01** — Obrigatórios: `title`, `object`, `contractingTypeId`, `requestingSecretariatId`, `requestingDepartmentId`, `priority`, `originId`, `pcaStatus`; `organizationId` assume o órgão principal quando omitido.
- **RN-PROC-02** — `requestingDepartmentId` deve ser a própria secretaria ou unidade da sua subárvore (`path` prefixado), ambas **ativas** e do mesmo `organizationId`. Opções de "Secretaria" = unidades do órgão com `type` `SECRETARIAT` ou `BOARD`, mais as unidades raiz.
- **RN-PROC-03** — O usuário precisa de `PROCESS_CREATE` em escopo que cubra `requestingDepartmentId` (`TENANT`, `ORGANIZATION` do processo, `DEPARTMENT` com subárvore ou `OWN_DEPARTMENTS`).
- **RN-PROC-04** — Numeração conforme DEC-028: máscara `numbering.process.mask`, escopo `numbering.process.scope`, momento `numbering.process.assignOn`; sequência por (escopo, ano) sem lacunas por rollback; `code` único no tenant.
- **RN-PROC-05** — `year` = ano corrente no fuso do tenant no momento da numeração (ou da criação, se não numerado).
- **RN-PROC-06** — Resolução do workflow: workflows ativos com versão publicada, avaliados por `applicabilityPriority` crescente; o primeiro cuja `applicabilityRule` for verdadeira vence; sem correspondência, usa o `isDefault`; sem padrão, erro `NO_APPLICABLE_WORKFLOW`. O `workflowVersionId` resolvido é **imutável** no processo.
- **RN-PROC-07** — Status inicial `DRAFT`; etapa inicial = `WorkflowVersion.initialStageId`; unidade e responsável conforme `departmentResolution` e `assignmentPolicy` da etapa (no workflow padrão: setor solicitante e criador).
- **RN-PROC-08** — `openedAt = now()` quando numerado na criação; caso contrário, nulo.
- **RN-PROC-09** — `internalCode` (até 60 caracteres, trim) é único por tenant quando preenchido; obrigatório se `process.requireInternalCode = true`.
- **RN-PROC-10** — `estimatedValue` é opcional, ≥ 0, com 2 casas; quando informado, `estimatedValueSource = MANUAL` (será substituído por fontes de maior precedência — DEC-032).
- **RN-PROC-11** — `targetDate`, quando informado, deve ser ≥ data atual no fuso do tenant.
- **RN-PROC-12** — PCA (DEC-029): `PLANNED` exige `pcaYear` (ano corrente ou seguinte) e aceita `pcaItemCode`; `NOT_PLANNED` exige `pcaJustification` com ≥ 20 caracteres; `NOT_APPLICABLE` ignora os demais campos (gravados nulos).
- **RN-PROC-13** — Heurística de duplicidade (FA-02): bloqueia com `POSSIBLE_DUPLICATE_PROCESS` (409) até confirmação explícita; desativada se a janela configurada for 0.
- **RN-PROC-14** — Concessões de visibilidade na criação conforme permissions.md §5.
- **RN-PROC-15** — Tudo ocorre em uma transação: qualquer falha desfaz processo, etapa, movimentação, acessos, timeline, auditoria, outbox **e** o incremento da sequência.
- **RN-PROC-16** — `contractingTypeId`, `modalityId` e `originId` devem ser itens **ativos** do catálogo correto do tenant.
- **RN-PROC-17** — Não há notificação na criação: o processo nasce sob custódia do próprio criador.
- **RN-PROC-18** — Etiquetas não são informadas na criação no MVP 1 (gerenciadas em US-007).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Título | `title` | texto curto | Sim | 5–200 caracteres; sem quebras de linha; trim | — |
| Objeto | `object` | texto longo | Sim | 10–2.000 caracteres | — |
| Descrição | `description` | texto longo | Não | até 10.000 caracteres | — |
| Tipo de contratação | `contractingTypeId` | seleção (catálogo `CONTRACTING_TYPE`) | Sim | item ativo | — |
| Modalidade prevista | `modalityId` | seleção (catálogo `MODALITY`) | Não | item ativo; vazio = "A definir" | vazio |
| Registro de preços (SRP) | `isPriceRegistration` | interruptor | Não | — | `false` |
| Órgão/entidade | `organizationId` | seleção | Sim (oculto se único) | ativo | órgão principal |
| Secretaria solicitante | `requestingSecretariatId` | seleção | Sim | ativa; RN-PROC-02 | secretaria da lotação principal |
| Setor solicitante | `requestingDepartmentId` | seleção em árvore | Sim | ativa; subárvore da secretaria; RN-PROC-03 | lotação principal |
| Prioridade | `priority` | seleção (`Priority`) | Sim | enum | `MEDIUM` |
| Prazo alvo | `targetDate` | data | Não | ≥ hoje | — |
| Valor estimado | `estimatedValue` | moeda (BRL) | Não | ≥ 0; 2 casas; string decimal na API | — |
| Origem | `originId` | seleção (catálogo `PROCESS_ORIGIN`) | Sim | item ativo | — |
| Situação no PCA | `pcaStatus` | rádio (`PcaStatus`) | Sim | enum | — |
| Exercício do PCA | `pcaYear` | número | Condicional (`PLANNED`) | ano corrente ou seguinte | ano corrente |
| Item do PCA | `pcaItemCode` | texto curto | Não | até 60 | — |
| Justificativa (fora do PCA) | `pcaJustification` | texto longo | Condicional (`NOT_PLANNED`) | ≥ 20 caracteres | — |
| Código interno | `internalCode` | texto curto | Condicional (`process.requireInternalCode`) | até 60; único no tenant | — |
| Observações | `notes` | texto longo | Não | até 5.000 | — |
| Confirmo que não é duplicado | `confirmDuplicate` | booleano (técnico) | Não | só enviado após aviso | `false` |
| *(sistema)* Número / Ano / Código | `number`, `year`, `code` | int / int / texto | — | RN-PROC-04/05 | gerados |
| *(sistema)* Status, workflow, etapa, unidade e responsável atuais | `status`, `workflowVersionId`, `currentStageId`, `currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId` | — | — | RN-PROC-06/07 | gerados |
| *(sistema)* Abertura, canal, criador | `openedAt`, `creationChannel`, `createdById` | — | — | RN-PROC-08 | gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios presentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` |
| V-02 | Limites de tamanho (título, objeto, descrição, observações) | Front + API | "O {campo} deve ter entre X e Y caracteres." | `VALIDATION_ERROR` |
| V-03 | Catálogo inexistente, inativo, de outro tipo ou de outro tenant | API | "Selecione um {campo} válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | Unidade inexistente, inativa ou de outro tenant | API | "Selecione uma unidade válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-05 | Setor fora da subárvore da secretaria / órgão divergente | API | "O setor deve pertencer à secretaria selecionada." | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`) |
| V-06 | Escopo de `PROCESS_CREATE` não cobre o setor | API | "Você não pode abrir processos para este setor." | `PERMISSION_DENIED` |
| V-07 | `targetDate` no passado | Front + API | "O prazo alvo não pode ser anterior a hoje." | `VALIDATION_ERROR` |
| V-08 | `estimatedValue` negativo ou com mais de 2 casas | Front + API | "Informe um valor válido, com até 2 casas decimais." | `VALIDATION_ERROR` |
| V-09 | Regras de PCA (RN-PROC-12) | Front + API | "Informe o exercício do PCA." / "Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres)." | `VALIDATION_ERROR` |
| V-10 | `internalCode` duplicado | API (+ índice único) | "Já existe um processo com o código interno {valor}." | `DUPLICATE_INTERNAL_CODE` |
| V-11 | Possível duplicidade sem confirmação | API | "Encontramos processos parecidos criados recentemente." | `POSSIBLE_DUPLICATE_PROCESS` |
| V-12 | Sem workflow aplicável | API | "Não há fluxo configurado para este tipo de contratação. Fale com o administrador do órgão." | `NO_APPLICABLE_WORKFLOW` |
| V-13 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados. Recarregue a página." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `PROCESS_CREATE` com escopo que cubra o `requestingDepartmentId` (permissions.md §1.1).
- **Políticas:** nenhuma política contextual além do escopo (o processo ainda não existe). Leituras auxiliares (catálogos, unidades, órgãos, `/me`) são capacidades implícitas.
- **MFA:** não exigido (`PROCESS_CREATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Novo processo" e a rota `/processos/novo` não são exibidos/acessíveis (rota retorna SCR-111 403); a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessCreated` | `process.created` | Commit da criação | Payload conforme events.md §4.1; `code`/`number` nulos se `assignOn = START` |

Projeções síncronas na mesma transação: `ProcessTimelineEntry` (`PROCESS_CREATED`) e `ProcessAccess` (concessões iniciais). Não há `ProcessAssigned` na criação (o responsável inicial consta do próprio `ProcessCreated`).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (RN-PROC-17). O toast de sucesso é feedback de interface, não notificação. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Criar processo de contratação

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a numeração de processos usa a máscara "{seq:4}/{year}", escopo "TENANT" e atribuição "CREATE"
    And o workflow "Fase preparatória — Lei 14.133/2021" está publicado e é o padrão
    And o usuário "Ana" tem vínculo ativo, lotação principal no setor "Setor de Manutenção" da "Secretaria de Obras"
    And "Ana" possui o perfil "REQUISITANTE" com escopo "OWN_DEPARTMENTS"

  Scenario: [Sucesso] Criar processo com os campos obrigatórios
    Given que o último número de processo do tenant em 2026 é 11
    When "Ana" preencher título, objeto, tipo de contratação "AQUISICAO_BENS", origem "DEMANDA_NAO_PREVISTA" e situação no PCA "NOT_APPLICABLE"
    And clicar em "Criar processo"
    Then o processo deve ser criado com status "DRAFT"
    And deve receber o número 12 e o código "0012/2026"
    And deve estar vinculado ao tenant "Prefeitura de São José"
    And deve ter a versão publicada do workflow padrão fixada
    And deve estar na etapa "ABERTURA" sob custódia do "Setor de Manutenção" com "Ana" como responsável
    And deve existir uma tramitação de ação "CREATE" com IP e correlationId
    And deve existir uma entrada "PROCESS_CREATED" na timeline
    And deve gerar registro de auditoria "process.create"
    And deve gerar o evento "ProcessCreated"
    And a API deve responder 201 com o cabeçalho "Location" e "ETag" igual a "1"
    And "Ana" deve ser levada ao painel do processo com o próximo passo "Elabore o DFD"

  Scenario: [Sucesso] Criar processo sem número quando a numeração ocorre na autuação
    Given que a configuração "numbering.process.assignOn" é "START"
    When "Ana" criar um processo válido
    Then o processo deve ser criado com status "DRAFT" sem número e sem código
    And o campo "openedAt" deve ficar vazio
    And nenhuma sequência de numeração deve ser consumida

  Scenario: [Validação] Campos obrigatórios ausentes
    When "Ana" tentar avançar o passo 1 sem informar o título
    Then o sistema deve exibir "Informe o título." junto ao campo
    And não deve avançar para o passo 2
    And se a API receber o mesmo corpo deve responder 422 com código "VALIDATION_ERROR" e erro no campo "title"

  Scenario: [Validação] Setor fora da secretaria selecionada
    When "Ana" enviar "requestingSecretariatId" da "Secretaria de Obras" e "requestingDepartmentId" de um setor da "Secretaria de Saúde"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DEPARTMENT_NOT_IN_SECRETARIAT" no campo "requestingDepartmentId"
    And nenhum processo deve ser criado

  Scenario: [Validação] Contratação fora do PCA sem justificativa
    When "Ana" escolher a situação no PCA "NOT_PLANNED" sem informar justificativa
    Then o sistema deve exibir "Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres)."
    And o botão "Criar processo" deve permanecer desabilitado

  Scenario: [Permissão] Usuário sem a permissão PROCESS_CREATE
    Given que o usuário "Bruno" possui apenas o perfil "SOMENTE_LEITURA"
    When "Bruno" acessar a lista de processos
    Then o botão "Novo processo" não deve ser exibido
    When "Bruno" enviar POST para "/api/v1/processes" com um corpo válido
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PROCESS_CREATE"
    And nenhum processo deve ser criado

  Scenario: [Permissão] Escopo que não cobre o setor solicitante
    Given que "Ana" possui "PROCESS_CREATE" apenas para suas lotações
    When "Ana" enviar POST com "requestingDepartmentId" de um setor onde não é lotada
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Referência a unidade de outro tenant
    Given que existe o setor "Setor X" no tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", enviar POST com "requestingDepartmentId" do "Setor X"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "requestingDepartmentId"
    And a resposta não deve revelar que a unidade existe em outro tenant
    And nenhum dado do tenant "Prefeitura B" deve ser lido ou alterado

  Scenario: [Tenant incorreto] Cabeçalho de tenant sem vínculo
    When "Ana" enviar a requisição com "X-Tenant-Id" de um tenant em que não possui vínculo
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Duplicidade] Processo semelhante criado recentemente
    Given que "Ana" criou há 3 minutos o processo "0012/2026" com título "Aquisição de cimento para manutenção de vias"
    When "Ana" tentar criar um processo com título "Aquisição de cimento p/ manutenção das vias"
    Then o sistema deve exibir o aviso "Encontramos processos parecidos criados recentemente." com o link para "0012/2026"
    When "Ana" clicar em "Criar mesmo assim"
    Then o processo deve ser criado com o número 13
    And a auditoria "process.create" deve registrar "duplicateConfirmed" igual a verdadeiro

  Scenario: [Duplicidade] Código interno já utilizado
    Given que existe o processo com código interno "PROT-2026-0457"
    When "Ana" tentar criar outro processo com código interno "PROT-2026-0457"
    Then a API deve responder 409 com código "DUPLICATE_INTERNAL_CODE"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Ana" enviou a criação com a chave de idempotência "K1" e recebeu 201 para o processo "0012/2026"
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo processo "0012/2026" e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas um processo criado

  Scenario: [Concorrência] Criações simultâneas recebem números distintos e sem lacunas
    Given que o último número de processo do tenant em 2026 é 0
    When 50 usuários autorizados criarem processos válidos simultaneamente
    Then devem existir 50 processos com números de 1 a 50, sem repetição e sem lacunas
    And cada processo deve ter exatamente uma etapa ativa

  Scenario: [Concorrência] Rollback não consome número
    Given que o último número de processo do tenant em 2026 é 20
    And a criação de um processo falha após obter o número 21
    When outro processo válido for criado em seguida
    Then ele deve receber o número 21

  Scenario: [Falha de banco] Banco indisponível durante a criação
    Given que o banco de dados fica indisponível durante a transação de criação
    When "Ana" clicar em "Criar processo"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum processo, tramitação, timeline, auditoria ou evento deve ser persistido
    And o wizard deve manter os dados preenchidos e exibir "Não foi possível criar o processo agora. Tente novamente em instantes." com o correlationId

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox e a fila "domain-events" estão indisponíveis
    When "Ana" criar um processo válido
    Then o processo deve ser criado e a API deve responder 201
    And o evento "ProcessCreated" deve permanecer com status "PENDING" no outbox
    And quando o relay voltar o evento deve ser publicado uma única vez

  Scenario: [Falha de integração] Redis indisponível
    Given que o Redis está indisponível
    When "Ana" criar um processo válido com chave de idempotência
    Then o processo deve ser criado normalmente
    And deve ser registrado log "warn" "idempotency.store_unavailable" e incrementada a métrica correspondente
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (schema) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]`; foca o primeiro erro |
| Referência inexistente/inativa/outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um {campo} válido." | Recarrega opções do campo |
| Sem permissão/escopo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para abrir processos para este setor." | Mantém dados; sugere escolher outro setor |
| Vínculo inativo / tenant suspenso | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | "Seu acesso a este órgão não está ativo." | Redireciona para SCR-111 |
| Possível duplicidade | 409 | `POSSIBLE_DUPLICATE_PROCESS` | "Encontramos processos parecidos criados recentemente." | Painel com candidatos e "Criar mesmo assim" |
| Código interno duplicado | 409 | `DUPLICATE_INTERNAL_CODE` | "Já existe um processo com o código interno {valor}." | Erro no campo |
| Requisição idêntica em processamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "Estamos concluindo a criação. Aguarde." | Repete consulta após 2 s |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave e pede nova confirmação |
| Sem workflow aplicável | 422 | `NO_APPLICABLE_WORKFLOW` | "Não há fluxo configurado para este tipo de contratação." | Desabilita "Criar processo"; mostra contato do administrador |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente para continuar." | Preserva rascunho local; redireciona ao login e retorna ao wizard |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível criar o processo agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente"; exibe correlationId |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém dados; botão copiar código |

## Dependências
- **Stories:** US-042 (workflow padrão e resolução), US-059 (projeção na timeline), US-073 (auditoria), US-082 (outbox), US-097 (autorização e escopos), US-102 (secretarias e setores), US-104 (catálogos), US-105 (numeração). Indiretas: US-080, US-081, US-086, US-087, US-099, US-100, US-106.
- **Decisões/ADRs:** DEC-010, DEC-011, DEC-013, DEC-014, DEC-015, DEC-024, DEC-028, DEC-029, DEC-032, DEC-055, DEC-105, DEC-161; ADR-002, ADR-004, ADR-005, ADR-011.
- **Configurações:** `numbering.process.mask`, `numbering.process.scope`, `numbering.process.assignOn`, `process.duplicateDetectionWindowMinutes`, `process.requireInternalCode`, `labels.secretariat`, `labels.department`.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Estabelece o **padrão de comando transacional** do produto: `TenantTransaction` (set_config) → validação → autorização por escopo → domínio → repositórios → projeções síncronas (timeline, acesso) → `AuditService` → `OutboxWriter` → commit. Deve ser extraído como base reutilizável (`TransactionalCommandHandler`).
- **Contenção de numeração:** o `UPDATE … RETURNING` bloqueia a linha da sequência (tenant/escopo/ano) até o commit; transações de criação devem ser curtas (meta p95 < 600 ms). Throughput esperado por tenant (dezenas/min) é atendido com folga.
- `currentStageId` é FK circular (processo ↔ etapa): usar constraint `DEFERRABLE INITIALLY DEFERRED`.
- Coluna gerada `search_vector` e índices trigram exigem migração SQL bruta (Prisma `Unsupported`).
- Heurística de duplicidade usa `pg_trgm` (`similarity()`), restrita por tenant, janela de tempo e criador/setor (índice `(tenant_id, created_at DESC)`) para manter custo baixo.

## Backend
- **Módulo(s):** `process` (dono); usa as fachadas de `workflow` (`resolveApplicable`, `getInitialStage`, `computeStageDueAt`), `catalog` (`NumberingFacade`, `CatalogFacade.assertActive`, `BusinessCalendarFacade`), `organization` (`DepartmentFacade.assertInSubtree`), `access` (`AuthorizationService.assertCan('PROCESS_CREATE', { departmentId })`), `timeline` (projetor síncrono), `audit` (`AuditService`), `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateProcessCommand` → `CreateProcessHandler`; `CheckDuplicateProcessesQuery` → `CheckDuplicateProcessesHandler`.
- **Domínio:** `Process.create(props)` (fábrica que aplica RN-PROC-01..12 e emite `ProcessCreated`); value objects `ProcessCode`, `PcaReference`, `Money`; `ProcessStage.enter(...)`; `ProcessMovement.record(...)`.
- **Transação:** passos 7.1–7.12 do fluxo principal em uma transação interativa Prisma com `app.tenant_id`; isolamento `READ COMMITTED` + bloqueio de linha na sequência.
- **Idempotência:** decorator `@Idempotent()` (Redis, 24 h, escopo tenant + usuário + rota); em indisponibilidade do Redis, segue sem idempotência e registra alerta.
- **Serialização:** `ProcessPresenter` (inclui `allowedActions` resumidas e mascaramento — DEC-030).

## Frontend
- **Tela(s):** SCR-005 (`/processos/novo`) e redirecionamento para SCR-006 (`/processos/[id]`).
- **Componentes:** `Stepper` (packages/ui), formulário único React Hook Form + `zodResolver(createProcessSchema)` com validação por passo (`trigger` dos campos do passo), `CatalogSelect`, `OrganizationSelect`, `DepartmentTreeSelect` (filtra por escopo e secretaria), `PrioritySelect`, `DatePicker`, `MoneyInput` (BRL, envia string decimal), `PcaFieldset` (campos condicionais), `DuplicateWarningPanel`, `WorkflowPreviewCard`, `ReviewSummary`, `CollapsibleSection` "Mais informações".
- **Dados:** TanStack Query — `['t', tenantId, 'catalogs', type]` (staleTime 10 min), `['t', tenantId, 'departments', orgId]`, `useMutation(createProcess)` com `Idempotency-Key` gerada uma vez por sessão do wizard; após sucesso, invalidar `['t', tenantId, 'processes']`, `['t', tenantId, 'tasks']`, `['t', tenantId, 'dashboard']`.
- **Estados:** skeleton nos selects enquanto carregam; empty state se não houver tipos de contratação ("Nenhum tipo de contratação ativo. Fale com o administrador."); erro de carregamento com "Tentar novamente"; botão principal com estado de carregamento; aviso de rascunho recuperado ("Recuperamos o que você estava preenchendo").
- **Acessibilidade:** foco movido para o título do passo a cada troca; erros anunciados via `aria-live`; stepper navegável por teclado; rótulos e descrições associados; contraste AA.
- **Responsivo:** em telas < 768 px o stepper vira indicador "Passo 2 de 3" e os campos ficam em coluna única; botões fixos no rodapé.

## Banco de dados
- **Tabelas escritas:** `processes`, `process_stages`, `process_assignments`, `process_movements`, `process_access`, `process_timeline_entries`, `number_sequences`, `audit_logs`, `outbox_events`.
- **Migrações:** criação de `processes` e tabelas de runtime conforme entities.md §4.4 (constraints, índices, RLS, FKs compostas, FK `current_stage_id` deferrable); SQL bruto para `search_vector` (coluna gerada com `unaccent` via função imutável `cf_unaccent`) e índices `gin_trgm_ops` em `code`/`title`.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, code) WHERE code IS NOT NULL`; `UNIQUE (tenant_id, internal_code) WHERE …`; `UNIQUE (tenant_id, process_id) WHERE status = 'ACTIVE'` em `process_stages`; `UNIQUE (tenant_id, sequence_key)` em `number_sequences`; checks de PCA e `(number IS NULL) = (code IS NULL)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-02 | POST | `/api/v1/processes` | `{ title, object, description?, contractingTypeId, modalityId?, isPriceRegistration?, organizationId?, requestingSecretariatId, requestingDepartmentId, priority, targetDate?, estimatedValue?, originId, pcaStatus, pcaYear?, pcaItemCode?, pcaJustification?, internalCode?, notes?, confirmDuplicate? }` + `Idempotency-Key` | `201 { data: Process }` com `id`, `code`, `number`, `year`, `status`, `currentStage { key, name }`, `currentDepartment`, `currentResponsible`, `workflow { id, name, versionNumber }`, `version` | 201, 401, 403, 409, 422, 429, 500, 503 |
| PRC-03 | POST | `/api/v1/processes/check-duplicates` | `{ title, object, requestingDepartmentId }` | `200 { data: { candidates: [{ id, code, title, status, createdAt, createdBy }] } }` | 200, 403, 422 |
| WF-06 | POST | `/api/v1/workflows/resolve` | `{ contractingTypeId, modalityId?, originId, estimatedValue?, organizationId, isPriceRegistration }` | `200 { data: { workflowId, name, versionNumber, initialStage { key, name } } }` | 200, 422 (`NO_APPLICABLE_WORKFLOW`) |
| CAT-01, DEP-01/02, ORG-01, ME-01 | GET | (leituras de apoio) | — | — | 200 |

Exemplo de resposta `201`:
```json
{
  "data": {
    "id": "01927f1a-6c1e-7c8b-9a2e-3f6d2b1c0a11",
    "code": "0012/2026", "number": 12, "year": 2026,
    "title": "Aquisição de cimento para manutenção de vias",
    "status": "DRAFT",
    "priority": "MEDIUM",
    "organization": { "id": "…", "shortName": "PMSJ" },
    "requestingSecretariat": { "id": "…", "name": "Secretaria de Obras" },
    "requestingDepartment": { "id": "…", "name": "Setor de Manutenção" },
    "currentStage": { "id": "…", "key": "ABERTURA", "name": "Formalização da demanda", "dueAt": null },
    "currentDepartment": { "id": "…", "name": "Setor de Manutenção" },
    "currentResponsible": { "id": "…", "name": "Ana Souza" },
    "workflow": { "id": "…", "name": "Fase preparatória — Lei 14.133/2021", "versionNumber": 1 },
    "estimatedValue": null, "estimatedValueMasked": false,
    "openedAt": "2026-10-05T14:30:00Z",
    "createdAt": "2026-10-05T14:30:00Z",
    "version": 1
  }
}
```

## Logs
- `info` `process.created` — `processId`, `code`, `workflowVersionId`, `initialStageKey`, `durationMs`, `tenantId`, `userId`, `correlationId`.
- `info` `process.duplicate_warning` — quantidade de candidatos e se houve confirmação.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar.
- `warn` `numbering.lock_wait` — espera > 200 ms no bloqueio da sequência.
- `error` `process.create_failed` — `errorCode`, causa resumida, `correlationId` (stack apenas em nível `debug`).
- **Nunca logar:** título, objeto, descrição, observações, justificativas, valores estimados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.create` | `DATA_CHANGE` | Commit da criação | `changes`: valores iniciais dos campos não sensíveis (IDs de catálogos/unidades, prioridade, PCA status, datas); textos longos registrados como hash + tamanho. `metadata`: `code`, `workflowVersionId`, `initialStageKey`, `idempotencyKey`, `duplicateConfirmed` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/escopo | `reasonCode = PROCESS_CREATE`, `requestingDepartmentId` |

## Testes necessários
- **Unitários:** fábrica `Process.create` (RN-PROC-01..12); formatação de máscara (`{seq:4}/{year}`, `{org}-{seq:5}/{year}`); validação de PCA; regra de subárvore; heurística de duplicidade (limiares).
- **Integração (Testcontainers PostgreSQL + Redis):** atomicidade (falha simulada após numerar → nada persiste e a sequência não avança); RLS impede inserir/ler com `app.tenant_id` diferente; FK composta rejeita unidade de outro tenant; outbox e timeline gravados na mesma transação; `ProcessAccess` correto.
- **Concorrência:** 50 criações paralelas → números 1..50 sem lacunas/duplicatas; duas criações com a mesma `Idempotency-Key` simultâneas → uma 201, outra 409 `IDEMPOTENCY_IN_PROGRESS` ou replay.
- **API/contrato:** respostas e erros conforme api.md (snapshot do OpenAPI); cabeçalhos `Location`, `ETag`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** matriz perfis × escopos (REQUISITANTE com e sem lotação na unidade; GESTOR com `TENANT`; AUTORIDADE sem `PROCESS_CREATE`); referências de outro tenant → 422 `REFERENCE_NOT_FOUND`; `X-Tenant-Id` sem vínculo → 403.
- **E2E (Playwright):** jornada completa do wizard até o painel; aviso de duplicidade e "Criar mesmo assim"; retomada de rascunho local após recarregar.
- **Acessibilidade/performance:** axe sem violações sérias no wizard; k6 com 20 criações/s por 2 min → p95 < 600 ms e 0 erros.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PROCESS_CREATE` com escopo aplicado na API; botão e rota ocultos sem permissão
- [ ] Transação única comprovada por teste de falha induzida (inclui sequência)
- [ ] Auditoria `process.create` e evento `ProcessCreated` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-02, PRC-03 e WF-06 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas `process_created_total` e latência; trace com spans de numeração e resolução de workflow
- [ ] Wizard acessível (axe), responsivo (360 px) e com textos revisados por UX writing
- [ ] Revisão de código e de segurança aprovadas
- [ ] Padrão `TransactionalCommandHandler` documentado para reúso

## Estimativa
**L** — envolve o agregado central e os padrões transversais que serão reutilizados (transação com contexto de tenant, numeração concorrente, projeções síncronas, auditoria, outbox, idempotência), além de um wizard de três passos com validação condicional e verificação de duplicidade.

## Prioridade
**P0** — porta de entrada de todo o produto; nenhuma outra jornada de negócio do MVP 1 existe sem a criação do processo.
