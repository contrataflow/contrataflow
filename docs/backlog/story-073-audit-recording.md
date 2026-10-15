---
id: US-073
title: "Registrar auditoria transacional"
epic: EP-013
feature: FT-044
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-081, US-084]
modules: [audit]
screens: []
endpoints: []
permissions: []
events: []
---

# US-073 — Registrar auditoria transacional

## Título
Registrar auditoria transacional

## Descrição
**Como** responsável por conformidade e segurança do órgão (controle interno, auditor ou administrador), **quero** que toda ação relevante do sistema — mudanças de dados, decisões de workflow, acessos negados, exportações e alterações de configuração — seja registrada de forma confiável, íntegra e no mesmo instante em que ocorre, **para** ter evidência completa e à prova de adulteração em caso de auditoria externa (TCU/TCE), investigação interna ou incidente de segurança.

Esta story entrega o `AuditService`: um serviço de infraestrutura do módulo `audit`, chamado explicitamente por todos os casos de uso mutáveis dos demais módulos **dentro da mesma transação de banco** da mudança de negócio (DEC-161). Ela não tem tela própria nem endpoint: é o mecanismo que alimenta a trilha consultada em US-075 e selada em US-074. Cobre também o contexto de requisição, o mascaramento de dados sensíveis, a coalescência de ações de alto volume (autosave) e a amostragem de tentativas de acesso negado.

## Contexto
- A Lei 14.133/2021 (arts. 11, 169 e 171) e o controle externo (TCU/TCE) exigem rastreabilidade de quem fez o quê, quando e com que resultado, em todo o ciclo de contratação. Hoje, em planilhas e sistemas legados, essa trilha é incompleta, editável e perdida com frequência.
- DEC-025 separa a timeline (narrativa do processo, para usuários) da auditoria (evidência de conformidade e segurança, escopo = todas as ações relevantes, inclusive negadas, acessos e exportações); DEC-161 define que a auditoria é escrita explicitamente pelo caso de uso, na mesma transação, e não depende do outbox (ao contrário dos eventos de domínio). DEC-138 proíbe logar tokens, senhas, CPF, conteúdo de documento e corpo de upload. DEC-084 define snapshots/hashes com JSON canonicalizado (RFC 8785/JCS) e SHA-256.
- `AuditLog` (`audit_logs`) é imutável, particionada por mês (`occurredAt`), com `rowHash` por registro (entities.md §4). O catálogo de ações (`resource.action`) está fechado em events.md §7 — cada caso de uso usa um valor existente desse catálogo.
- Esta é, junto com US-001, uma story de fundação: estabelece o padrão que US-001..US-072 e demais stories do produto já assumem ao citar "deve gerar registro de auditoria".

## Objetivo
100% das transações de escrita do produto (criação, atualização, decisão, acesso negado, exportação, configuração) produzem exatamente um `AuditLog` íntegro e consistente com a mudança de negócio — nunca um sem o outro —, com `rowHash` verificável, contexto de requisição completo e nenhum dado sensível em texto puro.

## Persona
- **Principal:** Responsável por conformidade / auditor interno (perfil `AUDITOR`), que depende da trilha gerada por este serviço para suas consultas (US-075).
- **Secundárias:** Todo usuário do sistema (ator cujas ações são registradas, perfil `SYSTEM` nas gravações automáticas); Desenvolvedor de qualquer módulo, que consome o `AuditService` em seus casos de uso.

## Pré-condições
- A transação de banco do caso de uso chamador já está aberta com `app.tenant_id` definido (exceto ações de plataforma, sem tenant).
- O contexto de requisição (`tenantId`, `userId`, `membershipId`, `correlationId`, `requestId`, IP, user-agent) está disponível via `AsyncLocalStorage` (DEC-132, US-084).
- A ação a registrar existe no catálogo de events.md §7.

## Fluxo principal
1. Um caso de uso de qualquer módulo (ex.: `CreateProcessHandler`) executa sua lógica de negócio dentro de uma transação Prisma (`tx`).
2. Antes de confirmar a transação, o caso de uso chama `AuditService.record(tx, { action, category, result, entityType?, entityId?, processId?, changes?, metadata?, reasonCode? })`.
3. O `AuditService` completa automaticamente, a partir do contexto corrente: `tenantId`, `actorType`, `actorUserId`, `actorName` (congelado no momento), `actorMembershipId`, `onBehalfOfUserId` (quando suporte estiver atuando em nome de alguém), `ip`, `userAgent`, `correlationId`, `requestId`, `sessionIdHash` e `occurredAt = now()`.
4. O serviço aplica mascaramento em `changes`: remove/mascara campos sensíveis (CPF, tokens — DEC-138) e substitui campos de texto rico ou texto longo por `{ hash: sha256, length }`.
5. Se a ação estiver marcada como coalescível no catálogo (ex.: `document.draft_update`) e existir um registro do mesmo (`tenantId`, `entityType`, `entityId`, `actorUserId`, `action`) dentro da janela configurada, e os critérios de coalescência (RN-AUD-06) não forem excedidos, o serviço **não insere** novo registro.
6. Se a ação for `access.denied` e o volume no período corrente exceder o limite de amostragem (RN-AUD-07), o serviço grava apenas a fração amostrada e acumula o excedente em `metadata.suppressedCount` do próximo registro gravado.
7. Caso contrário, o serviço calcula `rowHash` = SHA-256 do JSON canonicalizado (RFC 8785) de todos os campos do registro (exceto o próprio `rowHash`) e executa `INSERT INTO audit_logs` usando o **mesmo `tx`** recebido — nunca abre transação própria.
8. Se o `INSERT` falhar (ex.: partição do mês ausente, violação de constraint), a exceção propaga para o caso de uso chamador, que desfaz toda a transação de negócio (RN-AUD-01).
9. O caso de uso confirma a transação; o `AuditLog` passa a existir de forma permanente (imutável) junto com a mudança que o originou.

## Fluxos alternativos
- **FA-01 — Ator de sistema:** quando a ação é disparada por um job (ex.: selagem, expiração de prazo), `actorType = SYSTEM`, `actorUserId`/`actorMembershipId` nulos; `actorName` recebe o nome do job (ex.: "Job de selagem horária").
- **FA-02 — Acesso de suporte:** quando um operador de plataforma atua em nome de um usuário (impersonation autorizada), `onBehalfOfUserId` é preenchido e a ação original de concessão/revogação (`support.access_grant`/`support.access_revoke`) é registrada separadamente.
- **FA-03 — Partição do mês ausente:** se a partição do mês corrente de `audit_logs` não existir no momento do `INSERT` (falha da rotina de criação antecipada), o `INSERT` falha com erro de banco; a transação de negócio é desfeita e um alerta `error` `audit.partition_missing` é emitido (RN-AUD-01, Falha de banco).
- **FA-04 — Contexto de requisição incompleto:** ações de job/background sem IP/user-agent (ex.: selagem) gravam esses campos como nulos; `correlationId` é gerado para a execução do job quando ausente.
- **FA-05 — Reabertura da janela de coalescência:** se a variação de tamanho do conteúdo ou o intervalo de revisões desde o último `document.draft_update` gravado excederem os limiares de `audit.coalesce.*` (RN-AUD-06), um novo registro é gravado mesmo dentro da janela de 10 minutos, fechando a janela anterior.

## Regras de negócio
- **RN-AUD-01** — `AuditService.record` recebe o cliente de transação (`tx`) ativo do caso de uso e grava nele; nunca abre transação própria. Falha na gravação do `AuditLog` desfaz toda a transação de negócio (ação e auditoria são atômicas — DEC-161).
- **RN-AUD-02** — Campos sempre preenchidos: `occurredAt`, `actorType`, `action` (valor do catálogo de events.md §7), `category`, `result`, `rowHash`. `tenantId` é nulo somente para ações de plataforma; `actorUserId`/`actorMembershipId` nulos quando `actorType = SYSTEM`, e `actorName` recebe o nome do job (FA-01 · DEC-071).
- **RN-AUD-03** — `changes` registra apenas campos efetivamente alterados, no formato `[{ path, old, new }]`; campos sensíveis (`cpf`, tokens, senha) são mascarados ou omitidos (DEC-138); texto rico (TipTap JSON) e textos longos são reduzidos a `{ hash: sha256(conteúdo canonicalizado), length }` — nunca o conteúdo integral.
- **RN-AUD-04** — `metadata` inclui, quando aplicável ao caso de uso: `processCode`, `documentCode`, `fromStatus`/`toStatus`, `ruleViolations`, `warningsAcknowledged`, `idempotencyKey`, além de qualquer chave específica documentada pela story dona da ação.
- **RN-AUD-05** — `ip`, `userAgent`, `correlationId`, `requestId` e `sessionIdHash` são obtidos automaticamente do contexto de requisição propagado por `AsyncLocalStorage` (DEC-132, US-084); o caso de uso chamador não os informa manualmente.
- **RN-AUD-06** — Ações marcadas `coalescible` no catálogo (ex.: `document.draft_update`) gravam no máximo 1 registro por `(tenantId, entityType, entityId, actorUserId, action)` a cada `audit.coalesce.windowMinutes` (padrão 10): chamadas dentro da janela do último registro gravado são descartadas (nenhum `UPDATE`, pois `audit_logs` é imutável), **exceto** se, desde o último registro gravado, o intervalo de revisões da seção exceder `audit.coalesce.maxRevisionGap` (padrão 20) ou a variação de tamanho do conteúdo exceder `audit.coalesce.maxSizeVariationPct` (padrão 30%) — nesses casos grava-se um novo registro e a janela é reiniciada.
- **RN-AUD-07** — Para `access.denied`, por `(tenantId, actorUserId ou IP quando anônimo, action)` e janela `audit.accessDeniedSampling.windowSeconds` (padrão 60s): até `audit.accessDeniedSampling.maxPerWindow` (padrão 20) ocorrências são gravadas integralmente; as excedentes da mesma janela não geram registro próprio e são somadas em `metadata.suppressedCount` do próximo registro gravado para a mesma chave.
- **RN-AUD-08** — `rowHash` é o SHA-256 do JSON canonicalizado (RFC 8785/JCS — DEC-084) de todos os campos do registro exceto o próprio `rowHash`; calculado uma única vez, antes do `INSERT`, nunca recalculado.
- **RN-AUD-09** — Todo endpoint mutável da API (`POST`/`PUT`/`PATCH`/`DELETE`, exceto os explicitamente isentos, como autenticação de baixo nível) deve ter ao menos uma ação de auditoria mapeada; um meta-teste de contrato, gerado a partir do catálogo de rotas (OpenAPI), falha o build se encontrar rota mutável sem ação de auditoria correspondente.
- **RN-AUD-10** — Toda autorização negada (`PERMISSION_DENIED`, `MFA_REQUIRED`, `MEMBERSHIP_INACTIVE`, `TENANT_SUSPENDED`) gera `access.denied` (`category = ACCESS`, `result = DENIED`, `reasonCode` = código do erro), sujeito apenas à amostragem de RN-AUD-07 — nunca suprimido por completo.

## Campos
Campos gravados em cada registro (`AuditLog`); não há formulário de usuário nesta story — estes campos são escritos aqui e exibidos pela consulta de US-075.

| Campo (exibição em US-075) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Data/hora | `occurredAt` | timestamptz | Sim | chave de partição | `now()` |
| Tenant | `tenantId` | uuid | Condicional | nulo só em ações de plataforma | contexto |
| Tipo de ator | `actorType` | `ActorType` | Sim | enum | contexto |
| Usuário | `actorUserId`, `actorName` | uuid, texto | Condicional | nulo se `actorType = SYSTEM` | sessão |
| Vínculo | `actorMembershipId` | uuid | Não | — | sessão |
| Em nome de | `onBehalfOfUserId` | uuid | Não | acesso de suporte (FA-02) | sessão |
| Ação | `action` | texto (`resource.action`) | Sim | catálogo events.md §7 | caso de uso |
| Categoria | `category` | `AuditCategory` | Sim | enum | caso de uso |
| Resultado | `result` | `AuditResult` | Sim | enum | caso de uso |
| Tipo/Id da entidade | `entityType`, `entityId` | texto, uuid | Não | — | caso de uso |
| Processo | `processId` | uuid | Não | quando aplicável | caso de uso |
| Alterações | `changes` | jsonb | Não | RN-AUD-03 | caso de uso |
| Detalhes | `metadata` | jsonb | Sim (`{}` padrão) | RN-AUD-04 | caso de uso |
| Motivo | `reasonCode` | texto | Não | obrigatório em `DENIED`/`FAILURE` | caso de uso |
| IP / navegador | `ip`, `userAgent` | inet, texto | Não | RN-AUD-05 | contexto |
| Correlação | `correlationId`, `requestId` | texto | Não | RN-AUD-05 | contexto |
| Sessão (hash) | `sessionIdHash` | texto | Não | RN-AUD-05 | contexto |
| Hash do registro | `rowHash` | varchar(64) | Sim | RN-AUD-08 | calculado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `action` fora do catálogo de events.md §7 | Backend (`AuditService`, contrato) | — (erro de programação; sem mensagem ao usuário final) | `INTERNAL_ERROR` |
| V-02 | `result = DENIED`/`FAILURE` sem `reasonCode` | Backend (`AuditService`, contrato) | — | `INTERNAL_ERROR` |
| V-03 | Chamada de `AuditService.record` fora de uma transação ativa | Backend (contrato) | — | `INTERNAL_ERROR` |
| V-04 | Campo de `changes` identificado como sensível sem regra de mascaramento cadastrada | Backend (`AuditService`) | — (serviço aplica redação total por padrão) | — |
| V-05 | Rota mutável sem ação de auditoria mapeada (meta-teste) | CI (build) | — | — (falha de build, não de runtime) |

## Permissões
- **Permissão:** nenhuma permissão própria — `AuditService.record` é chamado internamente pelo caso de uso já autorizado (ou já registra a negativa, quando a autorização falhou).
- **Políticas:** nenhuma; a gravação da auditoria não pode ser desabilitada por configuração nem por perfil, incluindo `ADMIN_ORGAO`.
- **MFA:** não se aplica (sem endpoint próprio).
- **Sem permissão:** não se aplica; ver cenário [Permissão] abaixo, que cobre o caso de uso chamador sem permissão.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio. A auditoria não depende do outbox e não publica eventos (DEC-161, DEC-025); é gravada de forma explícita e síncrona pelo próprio caso de uso. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. Gravar auditoria não notifica; a notificação (quando existir) é responsabilidade da ação de negócio original. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Registrar auditoria transacional

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Ana" tem vínculo ativo e perfil "REQUISITANTE"

  Scenario: [Sucesso] Ação de negócio gera registro de auditoria íntegro na mesma transação
    When "Ana" criar um processo de contratação válido
    Then deve ser criado exatamente um "AuditLog" com "action" igual a "process.create"
    And o registro deve conter "ip", "userAgent" e "correlationId" da requisição
    And o campo "rowHash" deve ser o SHA-256 do registro canonicalizado
    And nenhum CPF ou token deve aparecer em texto puro em "changes"

  Scenario: [Validação] Ação fora do catálogo é rejeitada
    When um caso de uso chamar "AuditService.record" com "action" igual a "foo.bar"
    Then o serviço deve rejeitar a chamada antes de iniciar o "INSERT"
    And nenhum "AuditLog" deve ser criado

  Scenario: [Permissão] Ação negada por falta de permissão ainda é auditada
    Given que "Bruno" não possui a permissão "PROCESS_CREATE"
    When "Bruno" enviar POST para "/api/v1/processes" com um corpo válido
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve ser gravado um "AuditLog" "access.denied" com "result" igual a "DENIED" e "reasonCode" igual a "PROCESS_CREATE"
    And nenhum perfil, incluindo "ADMIN_ORGAO", pode impedir essa gravação

  Scenario: [Tenant incorreto] Isolamento por RLS entre tenants
    Given que existem registros de auditoria do tenant "Prefeitura A" e do tenant "Prefeitura B"
    When uma consulta for executada com "app.tenant_id" da "Prefeitura A"
    Then somente os registros da "Prefeitura A" devem retornar
    And nenhuma linha da "Prefeitura B" deve ser visível

  Scenario: [Duplicidade] Coalescência de autosave em rajada
    Given que existe um "AuditLog" "document.draft_update" da seção "JUSTIFICATION" gravado há 2 minutos
    When a mesma seção for salva novamente dentro da janela de 10 minutos sem variação relevante de tamanho ou de revisão
    Then nenhum novo "AuditLog" deve ser criado para essa seção
    And o registro existente permanece como o único representante do período

  Scenario: [Concorrência] Gravações simultâneas não se perdem nem colidem
    Given que 20 transações de diferentes casos de uso são confirmadas no mesmo segundo no mesmo tenant
    When cada uma gravar seu "AuditLog"
    Then devem existir 20 registros distintos
    And cada "rowHash" deve ser único

  Scenario: [Falha de banco] Gravação da auditoria falha e desfaz a transação de negócio
    Given que a partição do mês corrente de "audit_logs" está indisponível
    When "Ana" criar um processo de contratação válido
    Then a transação completa deve ser desfeita
    And nenhum processo deve ser persistido
    And a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"

  Scenario: [Falha de integração] Redis indisponível durante amostragem de access.denied
    Given que o Redis usado para contagem de amostragem está indisponível
    When ocorrerem 5 tentativas de acesso negado no mesmo minuto para o mesmo usuário
    Then cada tentativa deve gerar seu próprio "AuditLog" "access.denied" (amostragem desativada em modo seguro)
    And deve ser registrado log "warn" "audit.sampling_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Falha ao gravar `AuditLog` (partição ausente, banco indisponível) | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a operação agora. Tente novamente em instantes." | Mensagem da ação de negócio original; dados do formulário mantidos |
| `action` fora do catálogo (erro de programação) | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mensagem da ação de negócio original |
| Rota mutável sem ação de auditoria mapeada | — | — | — (falha de build/CI, nunca chega a produção) | Não aplicável |

## Dependências
- **Stories:** US-081 (persistência com Prisma e concorrência otimista — `AuditService` usa o mesmo `tx` Prisma e convenções de tabela), US-084 (logs estruturados, `correlationId` e tracing — base do contexto de requisição propagado por `AsyncLocalStorage`). Indiretas: toda story com ação mutável (ex.: US-001) consome este serviço.
- **Decisões/ADRs:** DEC-025, DEC-084, DEC-138, DEC-161; ADR-006.
- **Configurações (plataforma — variáveis de ambiente, não configuráveis por tenant, para que nenhum tenant reduza a própria trilha):** `audit.coalesce.windowMinutes`, `audit.coalesce.maxRevisionGap`, `audit.coalesce.maxSizeVariationPct`, `audit.accessDeniedSampling.windowSeconds`, `audit.accessDeniedSampling.maxPerWindow`.
- **Lacunas nas fontes canônicas:** nenhuma (contenção de `access.denied` e caráter de plataforma dos parâmetros registrados em events.md §7; janela de 10 min de coalescência já canônica).

## Impacto técnico
- Estabelece o **padrão de auditoria transacional** do produto: todo `*Handler` mutável deve receber/propagar o `tx` ativo e chamar `AuditService.record(tx, …)` antes do commit — análogo ao padrão de comando transacional de US-001, do qual é peça obrigatória.
- Particionamento mensal de `audit_logs` exige rotina de criação antecipada da partição do próximo mês (job diário idempotente); sua ausência é falha de alta severidade (RN-AUD-01, FA-03).
- Cálculo de `rowHash` (JSON canonicalizado + SHA-256) a cada escrita tem custo de CPU previsível e baixo; não deve ser paralelizado de forma que mude a ordem determinística dos campos canonicalizados.
- A amostragem depende de contadores de curto prazo (Redis); indisponibilidade do Redis degrada para "sem amostragem" (grava tudo), nunca para "sem auditoria" (RN-AUD-07, FA pertinente). A coalescência lê o último registro da chave no próprio `audit_logs`, na transação do caso de uso (DEC-071).
- Meta-teste de cobertura (RN-AUD-09) roda no CI a partir do catálogo de rotas; deve ser mantido conforme novos endpoints mutáveis forem adicionados por qualquer módulo.

## Backend
- **Módulo(s):** `audit` (dono, novo); consumido por todos os módulos com casos de uso mutáveis.
- **Casos de uso:** não é um `Command`/`Query` de API; é um serviço de aplicação (`AuditService.record`) injetado nos handlers de outros módulos.
- **Domínio:** `AuditEntry` (value object de entrada), `AuditService` (orquestra contexto, mascaramento, coalescência, amostragem, hash e persistência), `AuditHasher` (RFC 8785 + SHA-256), `AuditCoalescer`, `AccessDeniedSampler`.
- **Integrações internas:** `platform` (`RequestContext`/`AsyncLocalStorage` de US-084), `access` (dados do ator autenticado).
- **Transação:** recebe o `tx` Prisma ativo do caso de uso chamador; nunca abre `prisma.$transaction` própria; o `INSERT` em `audit_logs` participa do commit/rollback do caso de uso.

## Frontend
- **Tela(s):** nenhuma — serviço interno sem interface própria.
- **Componentes:** não aplicável.
- **Estados:** não aplicável.
- **Acessibilidade e responsividade:** não aplicável.

## Banco de dados
- **Tabelas:** `audit_logs` (criada por esta story, conforme entities.md §4: imutável, particionada por mês em `occurred_at`, PK composta `(id, occurred_at)`).
- **Migrações:** criação de `audit_logs` com partições mensais (partição nativa `RANGE` em `occurred_at`); trigger que bloqueia `UPDATE`/`DELETE`; papel de aplicação com `GRANT INSERT, SELECT` apenas; RLS `ENABLE` + `FORCE` (`tenant_id = current_setting('app.tenant_id')::uuid`, registros de plataforma visíveis só ao papel de plataforma); job agendado (diário) que garante a existência da partição do mês seguinte.
- **Índices/constraints relevantes:** `(tenant_id, occurred_at DESC)`; `(tenant_id, entity_type, entity_id, occurred_at DESC)`; `(tenant_id, process_id, occurred_at DESC)`; `(tenant_id, actor_user_id, occurred_at DESC)`; `(tenant_id, action, occurred_at DESC)` — todos por partição.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| — | — | — | Nenhum endpoint próprio. `AuditService` é biblioteca interna chamada por todos os endpoints mutáveis dos demais módulos (ver Impacto técnico e RN-AUD-09). | — | — |

## Logs
- `info` `audit.recorded` — `action`, `category`, `result`, `entityType`, `durationMs` (sem dados de negócio).
- `warn` `audit.sampling_unavailable` — Redis indisponível durante amostragem/coalescência; auditoria segue gravando tudo.
- `warn` `audit.coalesced` — contagem de registros suprimidos por coalescência no período.
- `error` `audit.write_failed` — falha ao gravar `AuditLog`; inclui `correlationId` (stack apenas em nível `debug`); sempre acompanhado do rollback da transação chamadora.
- **Nunca logar:** conteúdo de `changes` não mascarado, CPF, tokens, senha, corpo de upload (DEC-138).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| *(todas as ações do catálogo de events.md §7)* | conforme catálogo | Gravadas por este serviço em nome do caso de uso chamador | Conforme RN-AUD-03/04; esta story não introduz ação própria, apenas o mecanismo de gravação |

## Testes necessários
- **Unitários:** `AuditHasher` (determinismo do `rowHash` para o mesmo input); `AuditCoalescer` (janela, gap de revisão, variação de tamanho); `AccessDeniedSampler` (limite por janela, `suppressedCount`); mascaramento de CPF/token/texto rico.
- **Integração (Testcontainers PostgreSQL + Redis):** `INSERT` participa da transação do chamador (rollback conjunto em falha induzida); RLS impede leitura/escrita cruzada de tenant; trigger rejeita `UPDATE`/`DELETE` em `audit_logs`; partição mensal correta por `occurredAt`.
- **API/contrato:** meta-teste que varre o catálogo de rotas mutáveis (OpenAPI) e falha se alguma não tiver ação de auditoria mapeada (RN-AUD-09).
- **RBAC e multi-tenant:** gravação ocorre independentemente do resultado de autorização (inclusive em `access.denied`); isolamento por tenant verificado na suíte "tenant leak".
- **Concorrência:** 50 gravações simultâneas no mesmo tenant → 50 `rowHash` distintos, nenhuma perda.
- **E2E (Playwright):** não aplicável diretamente; cobertura via jornadas de outras stories (ex.: US-001) que verificam o `AuditLog` resultante.
- **Acessibilidade/performance:** p95 do `AuditService.record` isolado < 15 ms; sem impacto perceptível na latência das transações que o chamam.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (integração) e passando no CI
- [ ] Meta-teste de cobertura de rotas mutáveis implementado e rodando no CI (RN-AUD-09)
- [ ] `rowHash` determinístico e verificado por teste de regressão
- [ ] Mascaramento de CPF/token/texto rico verificado por teste (DEC-138)
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] Partição mensal e job de criação antecipada verificados em teste de integração
- [ ] Logs sem dados sensíveis; métricas `audit_recorded_total`, `audit_write_failed_total`, `audit_coalesced_total`
- [ ] Revisão de código e de segurança aprovadas
- [ ] `AuditService` documentado como padrão obrigatório para novos módulos mutáveis

## Estimativa
**L** — introduz um mecanismo transversal usado por todo o produto (contexto de requisição, mascaramento, hashing, coalescência, amostragem, particionamento mensal e meta-teste de cobertura), com exigências fortes de atomicidade e imutabilidade.

## Prioridade
**P0** — toda story com ação mutável já citada no backlog depende deste serviço para cumprir seu próprio critério de aceite de auditoria; sem ele, nenhuma trilha de conformidade existe.
