---
id: US-049
title: "Assumir processo recebido pela unidade"
epic: EP-008
feature: FT-033
mvp: 1
priority: P0
estimate: S
status: Especificada
depends_on: [US-047]
modules: [process, access, timeline, audit, platform]
screens: [SCR-115]
endpoints: [PRC-21]
permissions: [PROCESS_CLAIM]
events: [ProcessAssigned]
---

# US-049 — Assumir processo recebido pela unidade

## Título
Assumir processo recebido pela unidade

## Descrição
**Como** servidor lotado na unidade que está com um processo sem responsável individual, **quero** assumi-lo com um clique, **para** que fique claro, para mim e para o restante da equipe, quem está tratando o processo a partir de agora.

Assumir ("claim") é a forma mais simples de se tornar responsável por um processo que chegou à fila da unidade — seja por um primeiro encaminhamento, por uma devolução sem responsável anterior (US-048) ou por uma reatribuição para `null` (US-050). Não exige motivo nem aprovação de ninguém: basta estar lotado na unidade atual e o processo não ter responsável.

## Contexto
- Quando uma etapa não tem política de atribuição automática (`UNASSIGNED`) ou a política não resolve ninguém, o processo fica na fila da unidade — visível para todos os lotados, mas sem um responsável nominal.
- DEC-023 (custódia) trata "lotado na unidade atual" como custodiante válido mesmo sem responsável individual; esta story formaliza a transição de "fila da unidade" para "responsável individual", permissão `PROCESS_CLAIM` e política POL-04.
- Evita o problema clássico de fila compartilhada ("todo mundo pensa que é de outra pessoa"): assumir é a ação que resolve a ambiguidade.

## Objetivo
Permitir que qualquer lotado na unidade atual assuma um processo sem responsável em um único clique, sem motivo e sem conflito, com 0% de processos assumidos por quem não pertence à unidade.

## Persona
- **Principal:** servidor lotado na unidade atual do processo (`currentDepartmentId`), sem responsável individual definido.
- **Secundárias:** gestor acompanhando a fila da unidade na caixa de tarefas (SCR-013).

## Pré-condições
- Usuário possui `PROCESS_CLAIM`.
- Usuário está lotado (vínculo ativo) na `currentDepartmentId` do processo.
- O processo está `IN_PROGRESS` ou `RETURNED`, a etapa atual não é do tipo `APPROVAL`, e não há responsável individual (`currentResponsibleId IS NULL`).

## Fluxo principal
1. Na lista de processos (SCR-004), na caixa de tarefas (SCR-013) ou no painel do processo (SCR-006), o sistema exibe o botão **"Assumir"** sempre que o processo estiver sem responsável e o usuário for elegível.
2. O usuário aciona **"Assumir"**. O front envia `POST /api/v1/processes/{id}/claim` com `If-Match` (versão atual do processo), sem corpo.
3. A API, em uma transação com `app.tenant_id`:
   1. recarrega o processo com `SELECT … FOR UPDATE`; valida `If-Match`;
   2. autoriza `PROCESS_CLAIM` e confirma que o usuário está lotado na `currentDepartmentId` (POL-04);
   3. confirma que `currentResponsibleId IS NULL`; caso contrário, `PROCESS_ALREADY_ASSIGNED` (409);
   4. encerra a `ProcessAssignment` ativa sem responsável individual, se existir (`isActive = false`, `endedAt = now`), e cria a nova (`type = CLAIM`, `assigneeId = usuário`, `assignedById = null`);
   5. atualiza `ProcessStage.assigneeId` e `Process.currentResponsibleId`; incrementa `version`;
   6. cria `ProcessMovement` (`action = CLAIM`, `toUserId = usuário`, sem exigência de comentário);
   7. concede `ProcessAccess` (`USER`/`RESPONSIBLE`) ao usuário;
   8. grava `AuditLog` `process.claim`, a entrada de timeline `PROCESS_CLAIMED` e o evento `ProcessAssigned` (`assignmentType = CLAIM`);
   9. confirma a transação.
4. A API responde **200** com o processo atualizado e `ETag` com a nova versão.
5. O front invalida a lista/caixa de tarefas e o painel do processo, exibindo "Você assumiu este processo" — sem notificação a terceiros (o próprio ator já sabe).

## Fluxos alternativos
- **FA-01 — Dois usuários assumem ao mesmo tempo:** apenas o primeiro commit vence; o segundo recebe `PROCESS_ALREADY_ASSIGNED` (409) e a tela é atualizada mostrando o novo responsável.
- **FA-02 — Etapa do tipo `APPROVAL`:** o botão "Assumir" não aparece; a responsabilidade pela decisão é tratada por `Approval`/POL-03 (US-051/US-052), não por `ProcessAssignment`.
- **FA-03 — Clique duplo / reenvio automático:** a segunda requisição chega com o mesmo `If-Match` já consumido pela primeira → `VERSION_CONFLICT` (412); o front trata como sucesso já aplicado e apenas atualiza a tela a partir da resposta mais recente.

## Regras de negócio
- **RN-TRAM-31** — Quem pode assumir (POL-04): `PROCESS_CLAIM` + vínculo ativo com lotação na `currentDepartmentId` + processo sem responsável individual. Com responsável já definido: `PROCESS_ALREADY_ASSIGNED` (409).
- **RN-TRAM-32** — Aplicável apenas quando a etapa atual é do tipo `TASK` ou `START` e o status do processo é `IN_PROGRESS` ou `RETURNED`; em etapa `APPROVAL` ou status incompatível, `INVALID_PROCESS_STATUS` (409) — o botão nem é exibido nesses casos.
- **RN-TRAM-33** — Cria `ProcessAssignment` com `type = CLAIM` e `assignedById = null` (ação de autoatribuição: o ator já está registrado em `ProcessMovement.actorId`, não há "quem atribuiu" distinto de "quem recebeu").
- **RN-TRAM-34** — Não exige e não aceita motivo; `ProcessMovement.comment` fica nulo (ação `CLAIM` não está entre as que exigem comentário no `CHECK` de `process_movements`).
- **RN-TRAM-35** — Não gera notificação: o evento `ProcessAssigned` com `assignmentType = CLAIM` não está entre os gatilhos do tipo `PROCESS_ASSIGNED` (que cobre apenas `MANUAL`/`RETURN`), e o próprio ator é o destinatário natural, já informado pela própria ação.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| — | — | — | — | Comando sem corpo (`POST` vazio) | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Processo já tem responsável | API | "Este processo já foi assumido por {nome}." | `PROCESS_ALREADY_ASSIGNED` |
| V-02 | Usuário não lotado na unidade atual | API | "Você não pertence à unidade responsável por este processo." | `PERMISSION_DENIED` |
| V-03 | Etapa/status não elegíveis | API | "Este processo não pode ser assumido no momento." | `INVALID_PROCESS_STATUS` |
| V-04 | `If-Match` divergente | API | "Os dados do processo mudaram. Atualize a página." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `PROCESS_CLAIM` com escopo que cubra a `currentDepartmentId` (POL-04).
- **Políticas:** POL-04 (Assumir).
- **MFA:** não exigido (`PROCESS_CLAIM` é risco `L`, mas é ação de leitura de responsabilidade, não de dados sensíveis), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Assumir" não é exibido; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessAssigned` | `process.assigned` | Commit do claim | `assignmentType = CLAIM`, `fromUserId = null`, `toUserId` = quem assumiu |

Projeção síncrona: entrada `PROCESS_CLAIMED` na timeline ("{actor} assumiu o processo"); `ProcessAccess` (`RESPONSIBLE`) concedida ao usuário.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (RN-TRAM-35): `assignmentType = CLAIM` não dispara `PROCESS_ASSIGNED`, e o ator é o próprio beneficiário. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Assumir processo recebido pela unidade

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo
    And existe o processo "0012/2026" na etapa "TERMO_REFERENCIA", unidade "Setor de Compras", sem responsável

  Scenario: [Sucesso] Assumir processo sem responsável
    Given que "Felipe" está lotado no "Setor de Compras" e possui "PROCESS_CLAIM"
    When "Felipe" assumir o processo "0012/2026"
    Then o processo deve passar a ter "Felipe" como responsável atual
    And deve existir uma tramitação de ação "CLAIM"
    And deve gerar registro de auditoria "process.claim"
    And deve gerar o evento "ProcessAssigned" com "assignmentType" igual a "CLAIM"
    And nenhuma notificação deve ser enviada

  Scenario: [Validação] Etapa do tipo aprovação
    Given que o processo "0012/2026" está na etapa "APROVACAO_AUTORIDADE" (tipo "APPROVAL")
    When "Felipe" tentar assumir o processo "0012/2026"
    Then o botão "Assumir" não deve ser exibido
    And a API deve responder 409 com código "INVALID_PROCESS_STATUS" se acionada diretamente

  Scenario: [Permissão] Usuário de outra unidade
    Given que "Marina" não está lotada no "Setor de Compras"
    When "Marina" enviar POST para "/api/v1/processes/0012-2026/claim"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Processo de outro tenant
    When um usuário autenticado em "Prefeitura B" enviar POST para o processo "0012/2026" da "Prefeitura de São José"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Duplicidade] Clique duplo
    Given que "Felipe" acionou "Assumir" e a primeira requisição já foi confirmada
    When o front reenviar automaticamente a segunda requisição com o mesmo "If-Match" original
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And a tela deve exibir "Felipe" como responsável sem erro percebido pelo usuário

  Scenario: [Concorrência] Dois usuários assumem ao mesmo tempo
    Given que "Felipe" e "Marina" estão lotados no "Setor de Compras"
    When ambos enviarem "Assumir" para o processo "0012/2026" na mesma janela de tempo
    Then apenas um deles deve se tornar responsável
    And o outro deve receber 409 com código "PROCESS_ALREADY_ASSIGNED"

  Scenario: [Falha de banco] Banco indisponível durante o claim
    Given que o banco de dados fica indisponível durante a transação
    When "Felipe" assumir o processo "0012/2026"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o processo deve permanecer sem responsável

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Felipe" assumir o processo "0012/2026" com sucesso
    Then a API deve responder 200
    And o evento "ProcessAssigned" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Já tem responsável | 409 | `PROCESS_ALREADY_ASSIGNED` | "Este processo já foi assumido por {nome}." | Atualiza o painel; oculta o botão |
| Fora da unidade | 403 | `PERMISSION_DENIED` | "Você não pertence à unidade responsável por este processo." | Botão não exibido |
| Status/etapa incompatíveis | 409 | `INVALID_PROCESS_STATUS` | "Este processo não pode ser assumido no momento." | Botão não exibido |
| Versão divergente | 412 | `VERSION_CONFLICT` | "Os dados do processo mudaram. Atualize a página." | Recarrega e reavalia o botão |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível assumir o processo agora. Tente novamente em instantes." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-047 (origem da fila sem responsável); US-048 (devolução pode deixar a etapa sem responsável); US-050 (atribuição manual, alternativa ao claim).
- **Decisões/ADRs:** DEC-023, DEC-024, DEC-055, DEC-104.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Ação de baixa complexidade computacional; o principal risco é concorrência na fila compartilhada — mitigado pelo índice único `(tenant_id, process_id) WHERE is_active` em `process_assignments` e pelo `If-Match` sobre `Process.version`.
- Reaproveita o padrão transacional já estabelecido (sem novidades arquiteturais).

## Backend
- **Módulo(s):** `process` (dono); fachadas de `access` (`AuthorizationService.assertCan('PROCESS_CLAIM')`), `timeline`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `ClaimProcessCommand` → `ClaimProcessHandler`.
- **Domínio:** `Process.claim(userId)`; `ProcessAssignment.claim(...)`.
- **Transação:** passos 3.1–3.9 do fluxo principal, isolamento `READ COMMITTED` + bloqueio de linha do processo.

## Frontend
- **Tela(s):** SCR-115 (ação direta, sem diálogo de confirmação — ação reversível e sem efeitos colaterais sensíveis).
- **Componentes:** `ClaimButton` (estado de carregamento, desaparece após sucesso).
- **Estados:** botão visível só quando elegível; desabilitado durante o envio; toast de sucesso; erro inline se outro usuário já assumiu.
- **Acessibilidade e responsividade:** botão com `aria-label` "Assumir este processo"; alvo de toque ≥ 44 px em mobile.

## Banco de dados
- **Tabelas:** `process_assignments`, `process_stages`, `processes`, `process_access`, `process_movements`, `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id) WHERE is_active` em `process_assignments` (garante que só um claim vence em caso de corrida).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-21 | POST | `/api/v1/processes/{id}/claim` | — (corpo vazio) + `If-Match` | `200 { data: Process }` com `currentResponsible`, `version` | 200, 403, 404, 409, 412, 428, 429, 500, 503 |

## Logs
- `info` `process.claimed` — `processId`, `userId`, `durationMs`, `correlationId`.
- `warn` `claim.conflict` — tentativa em processo já assumido (contador de corrida de fila).
- `error` `process.claim_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** dados pessoais além do `userId`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.claim` | `WORKFLOW` | Commit do claim | `changes`: `currentResponsibleId`. `metadata`: `processStageId` |
| `access.denied` | `ACCESS` | Tentativa sem lotação/permissão | `reasonCode = PROCESS_CLAIM` |

## Testes necessários
- **Unitários:** `Process.claim` rejeita quando já há responsável; aceita quando `null`.
- **Integração (Testcontainers):** corrida de dois claims simultâneos → um 200, outro 409; RLS.
- **API/contrato:** respostas e erros conforme api.md.
- **RBAC e multi-tenant:** lotado vs não lotado na unidade; processo de outro tenant → 404.
- **Concorrência:** 10 claims simultâneos no mesmo processo → exatamente um vencedor.
- **E2E (Playwright):** clicar "Assumir" na lista, na caixa de tarefas e no painel do processo.
- **Acessibilidade/performance:** axe no botão; p95 < 300 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PROCESS_CLAIM` com POL-04 aplicado na API; botão oculto quando inelegível
- [ ] Teste de corrida (dois claims simultâneos) cobrindo o índice único
- [ ] Auditoria `process.claim` e evento `ProcessAssigned` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-21 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace presentes
- [ ] Botão acessível (axe) e com alvo de toque adequado em mobile
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**S** — comando simples, sem corpo, sem regras de completude de documentos; o único cuidado real é a corrida de fila, já resolvida pelo padrão de concorrência otimista existente.

## Prioridade
**P0** — sem assumir, filas de unidade ficam sem responsável nominal, dificultando cobrança e rastreabilidade desde o primeiro MVP.
