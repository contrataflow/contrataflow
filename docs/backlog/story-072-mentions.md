---
id: US-072
title: "Mencionar usuários e unidades"
epic: EP-012
feature: FT-043
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-071, US-111]
modules: [collaboration, process, access, organization, notification, audit, platform]
screens: [SCR-006, SCR-007, SCR-008, SCR-009, SCR-011, SCR-012, SCR-105]
endpoints: [CMT-02, CMT-05]
permissions: [COMMENT_CREATE]
events: [UserMentioned]
---

# US-072 — Mencionar usuários e unidades

## Título
Mencionar usuários e unidades

## Descrição
**Como** servidor que comenta no processo, **quero** mencionar colegas ou unidades com "@" dentro do comentário e ter o mencionado notificado, **para** chamar a atenção de quem precisa agir ou se posicionar, sem depender de e-mail paralelo.

Ao digitar "@" no compositor de comentários (US-071), o sistema sugere usuários e unidades com visibilidade sobre o processo. Ao confirmar a menção e publicar (ou editar) o comentário, cada usuário mencionado — ou, no caso de unidade, cada membro ativo dela, até 50 — que tenha visibilidade do processo recebe a notificação `MENTIONED`, exceto o próprio autor.

## Contexto
- Hoje, chamar a atenção de alguém específico numa discussão do processo depende de repetir o nome em texto livre ou recorrer a e-mail/mensageiro fora do sistema, sem garantia de que a pessoa tenha acesso ao processo nem registro de que foi avisada.
- Esta story completa o nó `mention` do schema rich text já previsto em US-071 (RN-CMT-03, RN-CMT-19): enquanto US-072 não está ativa, o compositor não oferece "@" e a API rejeita o nó `mention` com `RICH_TEXT_INVALID`.
- Mencionar é uma extensão do comentário, não uma entidade independente: a menção vive dentro do `body` (nó `mention`) e gera um registro `Mention` (módulo `collaboration`) e o evento `UserMentioned`, já especificados em entities.md e events.md.
- Visibilidade segue DEC-024: só pode ser mencionado — e só é notificado — quem já veria o processo. Mencionar não concede acesso novo; para dar acesso formal usa-se Participantes (US-012). Orçamento sigiloso (POL-09) não é afetado: a notificação nunca leva valores.
- O limite de 50 membros por unidade mencionada segue o mesmo princípio de `APPROVAL_REQUESTED` (perfil com "máx. 50, senão notifica a unidade"): evita notificar dezenas de pessoas por engano com uma única menção.

## Objetivo
Garantir que, em 100% dos comentários com menção válida, o usuário (ou os membros com visibilidade da unidade mencionada) recebam a notificação `MENTIONED` em poucos segundos da publicação — e que ninguém sem acesso ao processo, nem o próprio autor, seja notificado.

## Persona
- **Principal:** mesmas personas de US-071 (quem comenta): área requisitante, colaborador/consultor convidado.
- **Secundárias:** usuário ou membro de unidade mencionado (destinatário da notificação).

## Pré-condições
- US-071 ativa (compositor de comentários, `Comment`, `COMMENT_CREATE`).
- Processo visível ao autor (DEC-024) e em status que permite comentar (RN-CMT-08).
- `NotificationDispatcher` (US-111) disponível para os canais in-app e e-mail.
- Existem usuários com vínculo ativo e/ou unidades ativas candidatas à menção.

## Fluxo principal
1. No compositor (US-071), o usuário digita "@" seguido de ao menos 1 caractere.
2. O front chama `CMT-05` (`GET /processes/{id}/mention-candidates?q=`) com debounce; a API devolve usuários com vínculo ativo e visibilidade do processo (DEC-024) e unidades com visibilidade e até 50 membros ativos, filtrados por `q` (nome/e-mail/sigla), até 10 resultados.
3. O usuário escolhe um item; o compositor insere o nó `mention` (`kind: USER|DEPARTMENT`, `id`, rótulo) no `body` e mantém a digitação.
4. Ao publicar (`CMT-02`) ou salvar edição (endpoint de US-071), a API, na mesma transação do comentário:
   1. extrai os alvos `mention` do `body` já validado contra o schema (RN-CMT-03);
   2. para cada alvo distinto, verifica visibilidade do processo pelo predicado de DEC-024 (usuário) ou `ProcessAccess` ativo da unidade (departamento); alvo sem visibilidade é descartado (RN-CMT-22);
   3. grava um `Mention` por alvo distinto (RN-CMT-23), vinculado ao `Comment`;
   4. grava o evento `UserMentioned` por `Mention` novo no outbox, sem entrada de timeline (RN-CMT-25);
   5. confirma a transação junto com `comment.create`/`comment.update`.
5. Assincronamente, o `NotificationDispatcher` (US-111) consome `UserMentioned` e envia `MENTIONED` ao usuário mencionado, ou a cada membro ativo com visibilidade da unidade mencionada — exceto o próprio autor (RN-CMT-26).
6. O mencionado vê, no sino de notificações, "{Autor} mencionou você no processo {código}"; ao abrir, o comentário é destacado na aba Comentários.

## Fluxos alternativos
- **FA-01 — Mencionar unidade:** rótulo "@Secretaria de Obras"; a notificação a cada membro usa "{Autor} mencionou {Unidade}, da qual você faz parte, no processo {código}".
- **FA-02 — Alvo perde visibilidade entre a sugestão e o envio:** a API descarta esse nó da lista de menções processadas (o texto "@Nome" permanece como rótulo simples, sem virar link) e publica o comentário normalmente — menção inválida nunca bloqueia a publicação (RN-CMT-22).
- **FA-03 — Menção ao próprio autor:** permitida e registrada como `Mention`, mas nunca gera notificação para ele mesmo (RN-CMT-26).
- **FA-04 — Unidade grande demais:** unidades com mais de 50 membros ativos não aparecem em `CMT-05` (RN-CMT-21); se um nó assim chegar de um rascunho antigo, vale FA-02.
- **FA-05 — Sugestão de adicionar participante:** se a busca não trouxer candidatos porque a pessoa não tem visibilidade do processo, a lista mostra "Ninguém encontrado com esse nome. Para dar acesso a alguém novo, adicione como participante." com link para Participantes (US-012).
- **FA-06 — Edição adicionando menção:** ao editar dentro dos 15 minutos (RN-CMT-09), novos nós `mention` seguem o processamento do passo 4; alvos já mencionados antes da edição não repetem notificação (RN-CMT-24).
- **FA-07 — Documento com orçamento sigiloso:** a notificação `MENTIONED` nunca leva valores (POL-09); o link apenas abre o comentário, sujeito à mesma máscara de RN-CMT-13.

## Regras de negócio
- **RN-CMT-21** — Autocomplete (`CMT-05`) devolve usuários com vínculo ativo e visibilidade do processo (DEC-024) e unidades ativas com visibilidade do processo e **no máximo 50 membros ativos**; filtra por `q` (mín. 1 caractere) em nome/e-mail (usuário) ou nome/sigla (unidade); no máximo 10 resultados.
- **RN-CMT-22** — No commit, cada nó `mention` é revalidado: usuário sem vínculo ativo ou sem visibilidade do processo (DEC-024), ou unidade sem visibilidade do processo, não gera `Mention` nem notificação; o nó permanece como rótulo simples e isso **não** bloqueia a publicação.
- **RN-CMT-23** — Um `Mention` por alvo distinto por comentário (`mentionedUserId` xor `mentionedDepartmentId`); nós `mention` repetidos para o mesmo alvo no mesmo `body` geram um único registro.
- **RN-CMT-24** — Na edição (RN-CMT-09), só geram `Mention`/`UserMentioned` os alvos **novos** frente ao `body` anterior; alvos já mencionados não repetem notificação.
- **RN-CMT-25** — `UserMentioned` não gera entrada de timeline (a menção é um desdobramento de `CommentCreated`/`CommentUpdated`, já projetado como `COMMENT_ADDED`); gera somente a notificação `MENTIONED`.
- **RN-CMT-26** — Sem autonotificação: se o autor mencionar a si mesmo, ou estiver entre os membros de uma unidade mencionada, não recebe `MENTIONED` por essa menção.
- **RN-CMT-27** — Menção não concede acesso: alvo sem visibilidade (RN-CMT-22) não passa a ver o processo; acesso formal só por Participantes (US-012) ou escopo de permissão.
- **RN-CMT-28** — A notificação `MENTIONED` nunca inclui valores monetários do processo ou do documento (POL-09), para nenhum destinatário.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Busca de menção | `q` (query de `CMT-05`) | texto curto | Sim (no autocomplete) | mín. 1 caractere | digitação após "@" |
| Nó de menção | `mention` (dentro de `body`) | nó TipTap | Não | `attrs: { kind: USER\|DEPARTMENT, id, label }` | inserido pelo compositor |
| *(sistema)* Alvo da menção | `Mention.mentionedUserId` / `mentionedDepartmentId` | uuid / uuid | — | exatamente um preenchido (RN-CMT-23) | derivado do `body` |
| *(sistema)* Notificação enviada | `Mention.notifiedAt` | timestamptz | — | preenchido quando o dispatcher envia | gerado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Nó `mention` fora do schema (atributo/estrutura inválida) | API | "Não foi possível salvar uma das menções do comentário." | `RICH_TEXT_INVALID` |
| V-02 | `q` com menos de 1 caractere | Front + API | — (autocomplete não busca) | `VALIDATION_ERROR` |
| V-03 | Alvo de menção sem visibilidade do processo ou inativo no commit | API (silenciosa — RN-CMT-22) | — (publica normalmente; sem link) | — |

## Permissões
- **Permissão:** `COMMENT_CREATE` — a mesma de criar/editar comentário (permissions.md §4); `CMT-05` exige a mesma permissão (catálogo api.md §3).
- **Políticas:** nenhuma política contextual própria; a filtragem de candidatos usa o predicado de visibilidade de DEC-024, não uma política (POL-NN) nova.
- **MFA:** não exigido (mesma classificação de `COMMENT_CREATE`, risco L), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** sem `COMMENT_CREATE` o "@" não é oferecido (RN-CMT-07); chamada direta a `CMT-05` sem a permissão responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `UserMentioned` | `comment.user_mentioned` | Commit da criação/edição do comentário, um por `Mention` novo | `commentId`, `mentionId`, `mentionedUserId?`, `mentionedDepartmentId?`; sem entrada de timeline (RN-CMT-25) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `MENTIONED` | Usuário mencionado, ou membros ativos (até 50) da unidade mencionada, com visibilidade do processo; nunca o próprio autor (RN-CMT-26) | In-app (e-mail ativado por padrão; desativável — US-113) | Após o commit de `UserMentioned`, via `NotificationDispatcher` (US-111) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Mencionar usuários e unidades

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está em "IN_PROGRESS" e é visível a "Marcos" e a "Cláudia"
    And "Marcos" possui "COMMENT_CREATE" com visibilidade do processo "0012/2026"

  Scenario: [Sucesso] Mencionar um usuário com visibilidade
    Given que "Cláudia" tem visibilidade do processo "0012/2026"
    When "Marcos" digitar "@Cláudia", selecionar o resultado sugerido por "CMT-05" e publicar o comentário
    Then a API deve responder 201 com o comentário contendo o nó "mention" para "Cláudia"
    And deve existir um registro "Mention" vinculado ao comentário com "mentionedUserId" de "Cláudia"
    And deve gerar o evento "UserMentioned"
    And "Cláudia" deve receber a notificação "MENTIONED" in-app e por e-mail
    And "Marcos" não deve receber notificação pela própria menção

  Scenario: [Sucesso] Mencionar uma unidade com até 50 membros
    Given que a unidade "Setor de Manutenção" tem 12 membros ativos com visibilidade do processo
    When "Marcos" mencionar "@Setor de Manutenção" e publicar o comentário
    Then cada um dos 12 membros deve receber a notificação "MENTIONED"
    And deve existir exatamente um registro "Mention" com "mentionedDepartmentId" do "Setor de Manutenção"

  Scenario: [Validação] Nó de menção fora do schema
    When a API receber um "body" com um nó "mention" sem o atributo "id"
    Then a API deve responder 422 com código "RICH_TEXT_INVALID"
    And nenhum comentário deve ser criado

  Scenario: [Permissão] Usuário sem COMMENT_CREATE não acessa candidatos
    Given que "Tatiane" possui apenas o perfil "SOMENTE_LEITURA"
    When "Tatiane" enviar GET para "/api/v1/processes/{id}/mention-candidates?q=cla"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Candidato de outro tenant não aparece
    Given que existe um usuário "Roberto" com o mesmo nome em outro tenant
    When "Marcos" buscar "@Roberto" em "/api/v1/processes/{id}/mention-candidates"
    Then a resposta não deve incluir o "Roberto" do outro tenant
    And nenhum dado do outro tenant deve ser lido ou alterado

  Scenario: [Duplicidade] Mesmo alvo mencionado duas vezes no mesmo comentário
    When "Marcos" inserir dois nós "mention" para "Cláudia" no mesmo comentário e publicar
    Then deve existir exatamente um registro "Mention" para "Cláudia" nesse comentário
    And "Cláudia" deve receber a notificação "MENTIONED" uma única vez

  Scenario: [Concorrência] Edição sem novas menções não duplica notificação
    Given que "Marcos" publicou um comentário mencionando "Cláudia" há 2 minutos
    When "Marcos" editar o comentário com "If-Match" válido sem alterar as menções existentes
    Then nenhum novo evento "UserMentioned" deve ser gerado para "Cláudia"

  Scenario: [Falha de banco] Banco indisponível ao gravar a menção
    Given que o banco de dados fica indisponível durante o commit do comentário
    When "Marcos" publicar um comentário mencionando "Cláudia"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum comentário, menção ou evento deve ser persistido

  Scenario: [Falha de integração] Fila de notificações indisponível
    Given que a fila usada pelo "NotificationDispatcher" está indisponível
    When "Marcos" publicar um comentário mencionando "Cláudia"
    Then o comentário e a menção devem ser criados normalmente e a API deve responder 201
    And o evento "UserMentioned" deve permanecer "PENDING" no outbox até a fila voltar
    And quando a fila voltar a notificação "MENTIONED" deve ser entregue uma única vez
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Nó `mention` fora do schema | 422 | `RICH_TEXT_INVALID` | "Não foi possível salvar uma das menções do comentário." | Mantém o texto no compositor; remove o nó inválido antes de reenviar |
| Alvo sem visibilidade/inativo no commit | — | — | — (publica normalmente; menção vira texto simples) | Nó perde o estilo de link após recarregar |
| Sem `COMMENT_CREATE` em `CMT-05` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para comentar neste processo." | "@" não é oferecido |
| Processo não visível | 404 | `PROCESS_NOT_FOUND` | — | Rota/aba não acessível |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível publicar o comentário agora. Tente novamente em instantes." | Mantém o texto digitado; botão "Tentar novamente" |

## Dependências
- **Stories:** US-071 (comentários, schema do nó `mention`, `COMMENT_CREATE`); US-111 (`NotificationDispatcher`); US-012 (participantes, alvo de FA-05); US-097 (visibilidade/escopo subjacente a DEC-024); US-113 (preferências de canal).
- **Decisões/ADRs:** DEC-024 (visibilidade de processos), DEC-010 (processo como agregado central), POL-09 (orçamento sigiloso).
- **Configurações:** nenhuma chave própria — os limites de 50 membros e 10 resultados são regras fixas desta story (RN-CMT-21).
- **Lacunas nas fontes canônicas:** nenhuma. `Mention`, `UserMentioned`/`MENTIONED` e `CMT-05` já estão definidos em entities.md, events.md e no catálogo de api.md; esta story apenas detalha o comportamento (validação silenciosa de alvo, deduplicação, ausência de timeline, cap de 50 no autocomplete) sem introduzir campo, enum, evento, notificação ou código de erro novo.

## Impacto técnico
- Extrai os nós `mention` do `body` dentro da **mesma transação** do comentário (`comment.create`/`comment.update`), reaproveitando o `TransactionalCommandHandler` de US-001 — sem outbox adicional.
- A checagem de visibilidade de unidade reaproveita a mesma consulta de `ProcessAccess`/escopo de DEC-024, aplicada aos membros ativos da unidade — custo adicional é uma consulta indexada, não uma varredura.
- O envio a até 50 destinatários por menção de unidade é assíncrono (`NotificationDispatcher`), para não impactar a latência do `POST`/`PATCH` do comentário.
- A deduplicação de alvo repetido (RN-CMT-23) é resolvida no servidor antes do insert; a constraint `UNIQUE` de `mentions` permanece como rede de segurança, não como controle de fluxo.

## Backend
- **Módulo(s):** `collaboration` (dono de `Mention`, junto com `Comment` de US-071); usa `access` (predicado DEC-024 para usuário e unidade), `organization` (membros ativos da unidade), `notification` (`NotificationDispatcher`, US-111), `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `ExtractMentionsFromBody` (serviço de domínio chamado por `CreateCommentHandler`/`UpdateCommentHandler` de US-071); `SearchMentionCandidatesQuery` → `SearchMentionCandidatesHandler` (`CMT-05`).
- **Domínio:** `Mention.createFor(comment, target)` (fábrica que valida alvo único — RN-CMT-23); `MentionTarget` (`USER` | `DEPARTMENT`); reaproveita `Comment` de US-071.
- **Integrações internas:** `AccessFacade.canViewProcess(userId, processId)` / `departmentHasAccess(departmentId, processId)`; `OrganizationFacade.listActiveMembers(departmentId, limit: 50)`.
- **Transação:** passos 4.1–4.4 do fluxo principal, na mesma transação de `comment.create`/`comment.update`; o envio da notificação ocorre fora da transação, disparado pelo consumo assíncrono de `UserMentioned`.

## Frontend
- **Tela(s):** mesmas de US-071 (SCR-006, SCR-007, SCR-008, SCR-009, SCR-011, SCR-012, SCR-105) — o "@" é um recurso do compositor, não uma tela própria.
- **Componentes:** `MentionAutocomplete` (popover navegável por teclado — setas, `Enter`, `Esc`), `MentionPill` (renderização do nó em modo leitura, distinguindo usuário/unidade), `NoCandidatesFound` (estado de FA-05).
- **Estados:** carregando (spinner no popover), vazio (FA-05), erro de busca (mantém "@algo" como texto simples, sem bloquear a digitação).
- **Acessibilidade e responsividade:** popover com `role="listbox"`/`option` e `aria-activedescendant`; em telas estreitas ocupa a largura do compositor; `MentionPill` com contraste AA e foco visível.

## Banco de dados
- **Tabelas:** `mentions` (já especificada em entities.md §4, módulo `collaboration`); nenhuma tabela nova.
- **Migrações:** nenhuma além da criação de `mentions` (compartilhada com o módulo de comentários).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, comment_id, mentioned_user_id) WHERE mentioned_user_id IS NOT NULL` (idem para `mentioned_department_id`); índice `(tenant_id, mentioned_user_id, created_at DESC)`; check "exatamente um alvo".

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| CMT-05 | GET | `/api/v1/processes/{id}/mention-candidates?q=` | `q` (query, mín. 1) | `200 { data: [{ kind: "USER"\|"DEPARTMENT", id, label, secondaryLabel? }] }` (máx. 10) | 200, 403, 404, 422 |
| CMT-02 | POST | `/api/v1/processes/{id}/comments` | `body` (TipTap, pode conter nós `mention`) — contrato de US-071 | comentário retornado inclui `mentions: [{ id, kind, targetId }]` | 201, 403, 404, 422, 503 |

## Logs
- `info` `mention.created` — `mentionId`, `commentId`, `targetKind` (`USER`/`DEPARTMENT`), `processId`, `tenantId`, `correlationId`.
- `info` `mention.notification_sent` — `mentionId`, `notificationType = MENTIONED`, canal, `durationMs`.
- `warn` `mention.target_unavailable` — alvo descartado por falta de visibilidade (RN-CMT-22), com `targetKind` e `commentId`.
- **Nunca logar:** nome/e-mail do mencionado, texto do comentário, valores do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `comment.create` / `comment.update` | `DATA_CHANGE` | Commit do comentário com menções | `metadata` acrescenta `mentionedUserIds: []`, `mentionedDepartmentIds: []` (apenas ids) |

## Testes necessários
- **Unitários:** `ExtractMentionsFromBody` (extração e deduplicação — RN-CMT-23); filtro de alvo sem visibilidade (RN-CMT-22); diff de menções na edição (RN-CMT-24); supressão de autonotificação (RN-CMT-26).
- **Integração (Testcontainers PostgreSQL + Redis):** `Mention` gravado na mesma transação do `Comment`; `UNIQUE` de `mentions` não gera erro 500 com alvo repetido no mesmo `body`; RLS impede ler candidatos de outro tenant.
- **API/contrato:** `CMT-05` com limite de 10 e filtro `q`; resposta de `CMT-02` incluindo `mentions[]`.
- **RBAC e multi-tenant:** `CMT-05` sem `COMMENT_CREATE` → 403; candidato de outro tenant nunca retornado; unidade com 51+ membros nunca retornada.
- **Concorrência:** duas edições simultâneas adicionando a mesma menção → um único `Mention`/`UserMentioned`.
- **E2E (Playwright):** digitar "@", escolher candidato, publicar, verificar notificação `MENTIONED` recebida pelo mencionado em outra sessão.
- **Acessibilidade/performance:** popover navegável só por teclado (axe); `CMT-05` com debounce e p95 < 300 ms até 1.000 candidatos elegíveis.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `COMMENT_CREATE` aplicado em `CMT-05`; autocomplete oculto sem permissão
- [ ] Visibilidade (DEC-024) comprovada por teste para usuário e unidade, incluindo "perdeu acesso entre sugestão e envio"
- [ ] Nenhuma autonotificação e nenhum envio duplicado por menção repetida (testes dedicados)
- [ ] Auditoria (`metadata.mentionedUserIds`/`mentionedDepartmentIds`) e evento `UserMentioned` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak" (candidatos e notificações)
- [ ] OpenAPI de `CMT-05` (e dos campos novos em `CMT-02`) compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de notificações enviadas
- [ ] Popover acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita a infraestrutura transacional, de outbox e de notificação já estabelecidas por US-071/US-111; a complexidade está na extração/validação de menções no rich text, na visibilidade de unidade e na deduplicação, sem tela ou tabela novas.

## Prioridade
**P1** — melhora a colaboração iniciada em US-071, mas não bloqueia o fluxo essencial de comentar.
