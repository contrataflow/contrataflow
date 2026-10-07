---
id: US-012
title: "Gerenciar participantes do processo"
epic: EP-001
feature: FT-007
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-001, US-097]
modules: [process, organization, access, timeline, audit, platform]
screens: [SCR-006, SCR-112]
endpoints: [PRC-28, PRC-29, PRC-30, PRC-31, PRC-32, USR-02, DEP-01]
permissions: [PROCESS_MANAGE_PARTICIPANTS, PROCESS_FOLLOW, PROCESS_VIEW]
events: [ProcessParticipantAdded, ProcessParticipantRemoved]
---

# US-012 — Gerenciar participantes do processo

## Título
Gerenciar participantes do processo

## Descrição
**Como** gestor de contratações (ou área requisitante/planejamento com a permissão), **quero** conceder acesso explícito a pessoas ou unidades que não estão na tramitação do processo — e permitir que qualquer usuário com visibilidade siga o processo —, **para** que colaboradores eventuais, consultores externos e interessados acompanhem e, quando apropriado, contribuam com o processo sem assumir sua custódia.

A gestão acontece na aba "Participantes" (SCR-112) do painel do processo: adicionar concede o papel Observador, Colaborador ou Consultor a um usuário ou a uma unidade; remover revoga o acesso. Qualquer usuário com visibilidade do processo pode "seguir"/"deixar de seguir" como atalho para se tornar Observador de si mesmo. Um job diário revoga automaticamente consultores cuja validade expirou.

## Contexto
- Hoje é comum que servidores de outras áreas (parecer jurídico pontual, consultoria contratada, um colega que só quer acompanhar) não tenham como ver o processo sem que alguém "empreste" acesso informalmente, fora de qualquer controle.
- DEC-036 criou `ProcessParticipant` exatamente para isso: acesso explícito por processo, concedido a usuário ou unidade, sem se misturar com a tramitação (custódia — DEC-023) nem com perfis globais. Participantes nunca tramitam nem aprovam.
- DEC-024 define a visibilidade do processo por `ProcessAccess`; a concessão/revogação de participante gera a razão `PARTICIPANT` nessa tabela, na mesma transação.
- Relaciona-se a US-001 (o processo precisa existir) e US-097 (permissões, escopos e vínculo `EXTERNAL`, pré-requisito do papel Consultor).

## Objetivo
Permitir conceder ou revogar participação em poucos segundos, com 100% das concessões refletidas em `ProcessAccess` na mesma transação, respeitando POL-10, e com expiração automática de consultores sem intervenção manual.

## Persona
- **Principal:** Gestor de contratações (perfil `GESTOR_CONTRATACOES`, escopo `TENANT`).
- **Secundárias:** Área requisitante (`REQUISITANTE`) e Planejamento (`PLANEJAMENTO`) — têm `PROCESS_MANAGE_PARTICIPANTS` por padrão (permissions.md §3.2). Qualquer perfil com `PROCESS_VIEW` sobre o processo pode seguir (`PROCESS_FOLLOW` é concedida a todos, inclusive `CONSULTOR_EXTERNO` quando participante).

## Pré-condições
- O processo existe (US-001) e é visível ao usuário (`PROCESS_VIEW` — DEC-024).
- Para gerenciar participantes de terceiros: `PROCESS_MANAGE_PARTICIPANTS` em escopo que cubra o processo (POL-10).
- Para seguir/deixar de seguir: `PROCESS_FOLLOW` (todos os perfis) e `PROCESS_VIEW` sobre o processo.
- Para adicionar alguém como Consultor: o usuário-alvo tem vínculo `EXTERNAL` ativo (US-097).

## Fluxo principal
1. Na aba "Participantes" (SCR-112) do painel do processo, o usuário com `PROCESS_MANAGE_PARTICIPANTS` aciona "Adicionar participante".
2. O sistema abre o diálogo com busca de usuário (`USR-02`) ou de unidade (`DEP-01`), seleção de **Papel** (Observador/Colaborador/Consultor), **Validade** (obrigatória só para Consultor), interruptor **Notificar** (padrão ativado) e **Motivo** (opcional).
3. Ao selecionar um usuário com vínculo `EXTERNAL`, o sistema sugere automaticamente o papel "Consultor" e passa a exigir a Validade.
4. O usuário confirma; o front envia `POST /api/v1/processes/{id}/participants` (PRC-29) com `Idempotency-Key`.
5. A API, em uma transação: autoriza `PROCESS_MANAGE_PARTICIPANTS` + POL-10; valida o alvo e o papel (RN-PROC-126..129); grava `ProcessParticipant`; concede `ProcessAccess` (`PARTICIPANT`); grava timeline `PARTICIPANT_ADDED`; audita `process.participant_add`; publica `ProcessParticipantAdded`.
6. A API responde **201**; a lista é atualizada com o novo participante, papel, validade (se houver) e quem concedeu; se `notify = true`, o participante recebe a notificação `PARTICIPANT_ADDED`.
7. Para remover, o usuário aciona "Remover" na linha do participante e confirma (motivo opcional); o front envia `DELETE /process-participants/{participantId}` (PRC-30).
8. A API revoga o `ProcessParticipant` (`revokedAt`, `revokedById`), revoga o `ProcessAccess` correspondente na mesma transação, grava timeline `PARTICIPANT_REMOVED`, audita `process.participant_remove` (`reason = REVOKED`) e publica `ProcessParticipantRemoved`.
9. A API responde **204**; o participante sai da lista.

## Fluxos alternativos
- **FA-01 — Seguir o processo (atalho):** no cabeçalho do painel (DEC-180), qualquer usuário com `PROCESS_VIEW` vê o botão "Seguir"/"Seguindo". "Seguir" chama PRC-31 (sempre papel `OBSERVER`, `notify = true`, sem escolher campos); se o usuário já é participante ativo em outro papel, o botão exibe o papel atual e fica desabilitado (RN-PROC-133). "Deixar de seguir" chama PRC-32 e só se aplica quando o papel atual é `OBSERVER`.
- **FA-02 — Alvo inativo ou de outro tenant:** a busca (`USR-02`/`DEP-01`) já filtra usuários/unidades ativos do próprio tenant; se o `POST` ainda referenciar um alvo inválido, a API responde `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`.
- **FA-03 — Expiração automática:** o job diário `participants-expire` (fila `maintenance`, 03:00 America/Sao_Paulo) revoga `CONSULTANT` com `expiresAt` vencido, independentemente de alguém acessar o processo (RN-PROC-134/135).
- **FA-04 — Mudar o papel de um participante:** não existe edição in-place; o usuário remove a participação atual e cria uma nova com o papel desejado (RN-PROC-129).

## Regras de negócio
- **RN-PROC-126** — Exatamente um entre `userId` e `departmentId` por participante; o papel `CONSULTANT` exige `userId` (não se aplica a unidade).
- **RN-PROC-127** — `CONSULTANT` exige `expiresAt` preenchido e ≤ validade do vínculo; o usuário-alvo deve ter vínculo `EXTERNAL` `ACTIVE` (POL-10); fora disso, `PARTICIPANT_NOT_ELIGIBLE`.
- **RN-PROC-128** — Não é permitido adicionar a si mesmo como `COLLABORATOR` nem `CONSULTANT` via PRC-29 (POL-10); a única forma de autoconcessão é o papel `OBSERVER` via "seguir" (PRC-31).
- **RN-PROC-129** — Um mesmo usuário ou unidade tem no máximo um participante ativo por processo (índice único); tentar adicionar quem já participa é rejeitado informando o papel atual. Não há edição de papel in-place: para mudar, revogue e conceda de novo.
- **RN-PROC-130** — `notify` (padrão `true`) controla o recebimento de notificações do processo (ex.: `PROCESS_STATUS_CHANGED`) e não afeta a visibilidade enquanto o participante estiver ativo.
- **RN-PROC-131** — Participantes nunca encaminham, devolvem, assumem, atribuem, suspendem, cancelam ou concluem o processo, nem decidem aprovações, somente em razão da participação (DEC-036); essas ações continuam exigindo custódia (POL-01) ou designação formal de aprovador.
- **RN-PROC-132** — `COLLABORATOR`/`CONSULTANT` editam documentos do processo apenas em `DRAFT`/`RETURNED` (POL-02) e não veem orçamento sigiloso por força da participação (POL-09).
- **RN-PROC-133** — Seguir (PRC-31) concede o papel `OBSERVER` com `notify = true`; se o usuário já é participante ativo em qualquer papel, a chamada é idempotente (200, participante existente, sem novo evento). Deixar de seguir (PRC-32) revoga a própria participação apenas quando o papel atual é `OBSERVER`; nos demais papéis, a remoção é feita por quem tem `PROCESS_MANAGE_PARTICIPANTS` (PRC-30).
- **RN-PROC-134** — Expiração automática: o job diário `participants-expire` (fila `maintenance`) revoga `CONSULTANT` com `expiresAt` vencido, revoga o `ProcessAccess` correspondente na mesma transação e publica `ProcessParticipantRemoved` (`reason = EXPIRED`) com auditoria `process.participant_remove`.
- **RN-PROC-135** — A expiração automatizada não é o único controle: a cada requisição, a autorização já nega acesso de um `CONSULTANT` cujo `expiresAt` tenha passado, mesmo antes de o job rodar; o job só materializa o estado, emite o evento e audita.
- **RN-PROC-136** — Remover participante (PRC-30) exige `PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo (POL-10); `revocationReason` é opcional.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo de alvo | — (deriva `principalType`) | seleção (Usuário/Unidade) | Sim | define qual busca exibir | Usuário |
| Usuário | `userId` | busca (`USR-02`) | Condicional (alvo = Usuário) | ativo, do tenant; RN-PROC-126/128 | — |
| Unidade | `departmentId` | busca em árvore (`DEP-01`) | Condicional (alvo = Unidade) | ativa, do tenant; RN-PROC-126 | — |
| Papel | `role` (`ParticipantRole`) | seleção | Sim | enum; Consultor exige Usuário com vínculo `EXTERNAL` (RN-PROC-127) | Observador |
| Validade | `expiresAt` | data/hora | Condicional (Consultor) | futura; ≤ validade do vínculo (RN-PROC-127) | — |
| Notificar | `notify` | interruptor | Não | — | `true` |
| Motivo | `reason` | texto curto | Não | até 500 caracteres | — |
| Motivo da remoção | `revocationReason` | texto curto | Não (ao remover) | até 500 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Papel ausente ou fora do enum | Front + API (Zod) | "Selecione o papel do participante." | `VALIDATION_ERROR` (`REQUIRED`/`INVALID_ENUM`) |
| V-02 | Nem usuário nem unidade informados (ou os dois) | Front + API | "Selecione um usuário ou uma unidade." | `VALIDATION_ERROR` (`REQUIRED`/`NOT_ALLOWED`) |
| V-03 | Consultor sem validade | Front + API | "Informe a validade da participação do consultor." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-04 | Consultor para uma unidade, ou usuário sem vínculo `EXTERNAL` ativo | API | "Este usuário não pode receber o papel de Consultor." | `PARTICIPANT_NOT_ELIGIBLE` |
| V-05 | Usuário autenticado tentando se adicionar como Colaborador/Consultor | API | "Você não pode se adicionar com este papel." | `PARTICIPANT_NOT_ELIGIBLE` |
| V-06 | Usuário/unidade inexistente, inativo ou de outro tenant | API | "Selecione um usuário ou unidade válidos." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-07 | Usuário/unidade já é participante ativo | API (+ índice único) | "Esta pessoa (ou unidade) já participa do processo." | `PARTICIPANT_ALREADY_EXISTS` |
| V-08 | Participante inexistente ao remover | API | "Este participante não existe mais." | `PARTICIPANT_NOT_FOUND` |

## Permissões
- **Permissão:** `PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo (POL-10), para conceder (PRC-29) e remover (PRC-30) participantes de terceiros. `PROCESS_FOLLOW`, para seguir/deixar de seguir a si mesmo (PRC-31/32) — concedida a todos os perfis que tenham `PROCESS_VIEW` sobre o processo.
- **Políticas:** POL-10 (participantes). Participantes não herdam `PROCESS_VIEW_CONFIDENTIAL_BUDGET` por força do papel (POL-09).
- **MFA:** não exigida (`PROCESS_MANAGE_PARTICIPANTS` é risco `M`; `PROCESS_FOLLOW` é risco `L`), salvo `security.mfaPolicy = ALL` (POL-14).
- **Sem permissão:** a aba "Participantes" fica visível em modo leitura (`PROCESS_VIEW` já basta para listar — PRC-28); os botões "Adicionar"/"Remover" ficam ocultos; a API responde 403 `PERMISSION_DENIED` e audita `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessParticipantAdded` | `process.participant_added` | Concessão manual (PRC-29) ou "seguir" (PRC-31), quando o alvo ainda não era participante ativo | `participantId`, `userId?`, `departmentId?`, `role`, `expiresAt?` |
| `ProcessParticipantRemoved` | `process.participant_removed` | Revogação manual (PRC-30), "deixar de seguir" (PRC-32) ou expiração automática (job `participants-expire`) | `participantId`, `reason` (`REVOKED` ou `EXPIRED`) |

Projeções síncronas na mesma transação: `ProcessAccess` (razão `PARTICIPANT`) concedido/revogado; `ProcessTimelineEntry` (`PARTICIPANT_ADDED`/`PARTICIPANT_REMOVED`).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PARTICIPANT_ADDED` | Participante adicionado — exceto quando o próprio ator se adiciona ao seguir (por analogia ao padrão já usado em `PROCESS_ASSIGNED`, que exclui o próprio ator) | IN_APP + e-mail (padrão; o usuário pode desativar — US-113) | Ao conceder a participação (PRC-29 ou PRC-31), na primeira concessão |

Remoção/expiração: nenhuma notificação dedicada — apenas timeline `PARTICIPANT_REMOVED` e auditoria.

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar participantes do processo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" existe e está em andamento no "Setor de Manutenção"
    And "Carla" tem o perfil "GESTOR_CONTRATACOES" com "PROCESS_MANAGE_PARTICIPANTS" em escopo "TENANT"
    And "Diego" tem vínculo "EXTERNAL" ativo e "PROCESS_VIEW" sobre o processo "0012/2026"
    And "Fábio" tem o perfil "SOMENTE_LEITURA" com "PROCESS_VIEW" sobre o processo "0012/2026"

  Scenario: [Sucesso] Adicionar colaboradora interna
    When "Carla" adicionar "Elisa" como "Colaboradora" com notificações ativadas
    Then deve existir um "ProcessParticipant" ativo para "Elisa" com papel "COLLABORATOR"
    And deve existir um "ProcessAccess" com motivo "PARTICIPANT" para "Elisa"
    And "Elisa" deve receber a notificação "PARTICIPANT_ADDED"
    And deve gerar registro de auditoria "process.participant_add"
    And deve gerar o evento "ProcessParticipantAdded"

  Scenario: [Sucesso] Seguir o processo
    When "Fábio" clicar em "Seguir" no processo "0012/2026"
    Then deve existir um "ProcessParticipant" ativo para "Fábio" com papel "OBSERVER" e "notify" verdadeiro
    And o botão deve passar a exibir "Seguindo"
    And deve gerar o evento "ProcessParticipantAdded"

  Scenario: [Sucesso] Expiração automática do consultor
    Given que "Diego" é participante "CONSULTANT" com "expiresAt" de ontem
    When o job "participants-expire" for executado
    Then a participação de "Diego" deve ser revogada com motivo "EXPIRED"
    And o "ProcessAccess" de "Diego" deve ser revogado na mesma transação
    And deve gerar o evento "ProcessParticipantRemoved" e a auditoria "process.participant_remove"

  Scenario: [Validação] Consultor sem validade
    When "Carla" tentar adicionar "Diego" como "Consultor" sem informar a validade
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "expiresAt"
    And nenhum participante deve ser criado

  Scenario: [Permissão] Usuário sem PROCESS_MANAGE_PARTICIPANTS
    When "Fábio" enviar POST para os participantes do processo "0012/2026"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PROCESS_MANAGE_PARTICIPANTS"

  Scenario: [Tenant incorreto] Usuário de outro tenant
    Given que "Grace" existe apenas no tenant "Prefeitura B"
    When "Carla" tentar adicionar "Grace" como participante
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "userId"
    And a resposta não deve revelar que "Grace" existe em outro tenant

  Scenario: [Duplicidade] Participante já ativo
    Given que "Elisa" já é participante ativa como "Colaboradora"
    When "Carla" tentar adicionar "Elisa" novamente, mesmo com outro papel
    Then a API deve responder 409 com código "PARTICIPANT_ALREADY_EXISTS"
    And o participante existente de "Elisa" não deve ser alterado

  Scenario: [Duplicidade] Seguir quem já participa
    Given que "Elisa" já é participante ativa como "Colaboradora"
    When "Elisa" clicar em "Seguir" no mesmo processo
    Then a API deve responder 200 com o participante existente sem criar duplicidade
    And nenhum novo evento "ProcessParticipantAdded" deve ser publicado

  Scenario: [Concorrência] Duas concessões simultâneas para o mesmo usuário
    When duas requisições de concessão de participante para "Hugo" forem enviadas simultaneamente por gestores distintos
    Then exatamente uma deve responder 201
    And a outra deve responder 409 com código "PARTICIPANT_ALREADY_EXISTS"
    And deve existir apenas um "ProcessParticipant" ativo para "Hugo"

  Scenario: [Falha de banco] Banco indisponível ao adicionar
    Given que o banco de dados fica indisponível durante a concessão
    When "Carla" adicionar um participante válido
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum "ProcessParticipant" ou "ProcessAccess" deve ser persistido

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" adicionar um participante válido
    Then o participante deve ser criado e a API deve responder 201
    And o evento "ProcessParticipantAdded" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Papel ou alvo inválido/ausente | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos; foca o primeiro erro |
| Consultor sem validade | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | "Informe a validade da participação do consultor." | Foca o campo "Validade" |
| Alvo não elegível para o papel | 422 | `PARTICIPANT_NOT_ELIGIBLE` | "Este usuário não pode receber o papel selecionado." | Explica o motivo (vínculo ou autoinclusão) |
| Referência inexistente/inativa/outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um usuário ou unidade válidos." | Recarrega a busca |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar participantes deste processo." | Oculta botões de gestão |
| Participante já ativo | 409 | `PARTICIPANT_ALREADY_EXISTS` | "Esta pessoa (ou unidade) já participa do processo." | Mostra o papel atual; sugere remover antes |
| Participante inexistente ao remover | 404 | `PARTICIPANT_NOT_FOUND` | "Este participante não existe mais." | Atualiza a lista |
| Processo não visível/outro tenant | 404 | `PROCESS_NOT_FOUND` | — | Redireciona para página 404 (SCR-111) |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |

## Dependências
- **Stories:** US-001 (o processo precisa existir), US-097 (permissões, escopos e vínculo). Indiretas: US-004 (painel onde vive a aba Participantes), US-092 (gestão de usuários/vínculo `EXTERNAL`, usado na busca e em POL-10), US-055 (mesma infraestrutura de jobs agendados), US-113 (preferências de notificação do destinatário).
- **Decisões/ADRs:** DEC-024, DEC-036, DEC-055, DEC-085, DEC-105, DEC-106.
- **Configurações:** nenhuma identificada nas fontes canônicas para esta story.
- **Lacunas nas fontes canônicas:**
  1. ~~Código para participante duplicado~~ — resolvida: `PARTICIPANT_ALREADY_EXISTS` (409) incluído em api.md §2.2.
  2. A supressão de autonotificação em `PARTICIPANT_ADDED` quando o próprio ator se adiciona ao seguir não está explícita em events.md §6; aplicada por analogia ao padrão já usado em `PROCESS_ASSIGNED` ("exceto quando é o próprio ator").

## Impacto técnico
- Reaproveita 100% o modelo `ProcessParticipant`/`ProcessAccess` já definido em entities.md (DEC-036/DEC-024); nenhuma migração nova.
- O job `participants-expire` já existe no scheduler `maintenance-daily` (queues.md §4.8) cobrindo exatamente este caso; esta story só precisa garantir que o handler e os eventos estejam implementados.
- O índice único `(tenant_id, process_id, user_id) WHERE revoked_at IS NULL` (e o equivalente para `department_id`) é a salvaguarda de concorrência (RN-PROC-129); nenhum lock explícito adicional é necessário.

## Backend
- **Módulo(s):** `process` (dono de `ProcessParticipant`), `organization` (validação de unidade-alvo), `access` (`AuthorizationService`, escopos POL-10), `platform` (`OutboxWriter`, scheduler `participants-expire`).
- **Casos de uso:** `AddProcessParticipantCommand`/`Handler`; `RemoveProcessParticipantCommand`/`Handler`; `FollowProcessCommand`/`Handler`; `UnfollowProcessCommand`/`Handler`.
- **Domínio:** `ProcessParticipant.grant(...)`/`revoke(...)` aplicando RN-PROC-126..133; reaproveita `ProcessAccessService.grant/revoke(reason = 'PARTICIPANT')`.
- **Integrações internas:** `access.AuthorizationService.assertCan('PROCESS_MANAGE_PARTICIPANTS' | 'PROCESS_FOLLOW', { processId })`; `organization.DepartmentFacade` para validar unidade; `platform.IdempotencyService` em PRC-29.
- **Transação:** concessão/revogação do participante + `ProcessAccess` + timeline + auditoria + outbox na mesma transação (padrão estabelecido em US-001).

## Frontend
- **Tela(s):** SCR-006, aba "Participantes" (SCR-112); botão "Seguir" no cabeçalho do painel situacional (DEC-180).
- **Componentes:** `ParticipantsList`, `AddParticipantDialog` (busca via `USR-02`/`DEP-01`, `RoleSelect`, `DateTimePicker` condicional, `Switch` "notify"), `FollowToggleButton`, `ConfirmRemoveDialog`.
- **Estados:** skeleton na lista; vazio ("Nenhum participante além da tramitação. Adicione alguém para dar visibilidade."); erro com "Tentar novamente"; loading no botão "Seguir".
- **Acessibilidade e responsividade:** foco no campo de busca ao abrir o diálogo; confirmação "Você está seguindo este processo" anunciada via `aria-live`; lista navegável por teclado; em telas < 768 px a aba fica no menu "Mais".

## Banco de dados
- **Tabelas:** `process_participants` (leitura/escrita), `process_access` (escrita derivada).
- **Migrações:** nenhuma (tabelas já definidas em entities.md §4).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id, user_id) WHERE revoked_at IS NULL AND user_id IS NOT NULL`; `UNIQUE (tenant_id, process_id, department_id) WHERE revoked_at IS NULL AND department_id IS NOT NULL`; `CHECK (user_id IS NULL) <> (department_id IS NULL)`; `CHECK role <> 'CONSULTANT' OR (expires_at IS NOT NULL AND user_id IS NOT NULL)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-28 | GET | `/api/v1/processes/{id}/participants` | — | `200 { data: [{ id, userId?, departmentId?, role, notify, expiresAt?, grantedAt, grantedBy, reason? }] }` | 200, 403, 404 |
| PRC-29 | POST | `/api/v1/processes/{id}/participants` | `{ userId?, departmentId?, role, notify?, expiresAt?, reason? }` + `Idempotency-Key` | `201 { data: Participant }` | 201, 403, 404, 409, 422, 429, 503 |
| PRC-30 | DELETE | `/api/v1/process-participants/{participantId}` | `{ revocationReason? }` | `204` | 204, 403, 404, 429, 503 |
| PRC-31 | POST | `/api/v1/processes/{id}/follow` | — | `200 { data: Participant }` | 200, 403, 404, 429 |
| PRC-32 | DELETE | `/api/v1/processes/{id}/follow` | — | `204` | 204, 403, 404, 429 |

## Logs
- `info` `process.participant_added` — `participantId`, `role`, `grantedVia` (MANAGE ou FOLLOW), `hasExpiresAt`.
- `info` `process.participant_removed` — `participantId`, `reason`.
- `warn` `participant.duplicate_attempt` — quando bloqueado por participante já ativo.
- `error` `process.participant_command_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** nome do participante, motivo (texto livre), e-mail.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.participant_add` | `DATA_CHANGE` | Commit da concessão (manual ou seguir) | `metadata`: `role`, `grantedVia`, `hasExpiresAt` |
| `process.participant_remove` | `DATA_CHANGE` | Commit da revogação (manual, deixar de seguir ou expiração) | `metadata`: `reason` (REVOKED ou EXPIRED) |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `metadata`: `reasonCode` (PROCESS_MANAGE_PARTICIPANTS ou PROCESS_FOLLOW) |

## Testes necessários
- **Unitários:** regras RN-PROC-126..133 (elegibilidade por papel, unicidade, idempotência do "seguir").
- **Integração (Testcontainers):** índice único sob concorrência; cascata de revogação do `ProcessAccess`; job `participants-expire`; RLS por tenant.
- **API/contrato:** respostas e erros conforme api.md; PRC-29/30/31/32 não exigem `If-Match` (confirmado no contrato).
- **RBAC e multi-tenant:** matriz de perfis com/sem `PROCESS_MANAGE_PARTICIPANTS`; referência de usuário/unidade de outro tenant.
- **Concorrência:** duas concessões simultâneas para o mesmo alvo.
- **E2E (Playwright):** adicionar, seguir, remover e expirar (job), refletindo no painel.
- **Acessibilidade/performance:** axe no diálogo; aba carrega em < 500 ms com 50 participantes.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) passando no CI
- [ ] `PROCESS_MANAGE_PARTICIPANTS` e `PROCESS_FOLLOW` aplicados na API; UI oculta ações sem permissão
- [ ] Índice único comprovado por teste de concorrência (duas concessões simultâneas)
- [ ] Job `participants-expire` cobrindo `ProcessParticipant` verificado em teste de integração
- [ ] Auditoria e eventos (`ProcessParticipantAdded`/`ProcessParticipantRemoved`) verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-28..32 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita o modelo `ProcessParticipant`/`ProcessAccess` e o job `participants-expire` já previstos nas fontes canônicas (DEC-036, DEC-024, queues.md §4.8); o esforço está nos diálogos de busca/papel condicional e na cobertura dos cenários de concorrência/duplicidade, sem novo agregado ou migração.

## Prioridade
**P1** — amplia colaboração e transparência (consultores, observadores) mas não bloqueia a abertura nem a tramitação do processo, que já funcionam sem participantes.
