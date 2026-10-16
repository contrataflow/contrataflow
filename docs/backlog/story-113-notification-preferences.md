---
id: US-113
title: "Preferências de notificação"
epic: EP-019
feature: FT-059
mvp: 1
priority: P2
estimate: S
status: Especificada
depends_on: [US-111]
modules: [notification]
screens: [SCR-039, SCR-036]
endpoints: [ME-05, ME-06]
permissions: []
events: []
---

# US-113 — Preferências de notificação

## Título
Preferências de notificação

## Descrição
**Como** usuário com vínculo ativo, **quero** escolher por quais canais recebo cada tipo de aviso, **para** não ser interrompido por e-mail em avisos que já acompanho dentro do produto, mantendo ligados apenas os avisos que considero essenciais.

A tela de preferências (aba "Notificações" do perfil, SCR-039, com atalho a partir do painel de notificações, SCR-036) lista cada `NotificationType` com os canais disponíveis (`IN_APP`, `EMAIL`); tipos marcados como obrigatórios no registro mantêm o canal `IN_APP` sempre ligado e não editável.

## Contexto
- O registro `NotificationType` (events.md §6) já define um padrão por tipo (ex.: `PROCESS_RECEIVED` com e-mail por padrão, `COMMENT_REPLY` só in-app); sem uma tela de preferências, esse padrão é definitivo para todo mundo.
- `NotificationPreference` (entities.md, módulo `notification`) já existe como tabela: ausência de linha = padrão do registro; a story apenas expõe a leitura/escrita dessa tabela com a trava de tipos obrigatórios.
- Tipos obrigatórios no registro (`APPROVAL_REQUESTED`, `ATTACHMENT_REJECTED`, `ROLE_CHANGED`) não podem ter o canal `IN_APP` desativado — são avisos de segurança ou de bloqueio de trabalho.

## Objetivo
Permitir que o usuário ajuste suas preferências em menos de 30 segundos e ver o efeito imediatamente na próxima notificação gerada, sem nunca conseguir desligar um canal obrigatório.

## Persona
- **Principal:** qualquer usuário com vínculo ativo no tenant.
- **Secundárias:** administrador do órgão (decide, via `notifications.emailEnabled`, se o canal de e-mail existe para o tenant inteiro — fora do escopo desta story, que é por usuário).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`.
- Central de notificações (US-111) em operação, consultando estas preferências a cada despacho.

## Fluxo principal
1. O usuário abre "Perfil" (SCR-039) → aba "Notificações", ou clica em "Gerenciar preferências" no painel do sininho (SCR-036).
2. O front chama `ME-05`; a tela lista todos os tipos de `NotificationType` agrupados por área (Processos, Aprovações, Colaboração, Prazos, Segurança), com duas colunas de interruptor (`IN_APP`, `EMAIL`) pré-marcadas pelo padrão do registro ou pela preferência salva.
3. Tipos obrigatórios mostram o interruptor `IN_APP` ligado e desabilitado, com nota "Este aviso não pode ser desligado".
4. Se `notifications.emailEnabled` do tenant for falso, a coluna `EMAIL` inteira aparece desabilitada com a nota "E-mails estão desligados para este órgão".
5. O usuário alterna os interruptores desejados e clica em "Salvar".
6. O front envia `PUT /api/v1/me/notification-preferences` (`ME-06`) só com as combinações alteradas; a API grava cada combinação como uma linha de `NotificationPreference` (upsert) e audita `notification.preferences_update`.
7. A API responde 200; a tela confirma "Preferências salvas" e mantém os interruptores no novo estado.

## Fluxos alternativos
- **FA-01 — Restaurar padrão de um tipo:** "Usar padrão" remove a preferência salva daquele `(tipo, canal)` (a ausência de linha volta a valer o padrão do registro).
- **FA-02 — Tentativa de desligar canal obrigatório:** o interruptor fica desabilitado na UI; se a API ainda receber a tentativa (ex.: chamada direta), responde `VALIDATION_ERROR`/`NOT_ALLOWED` sem alterar nada.
- **FA-03 — Primeira visita (sem preferências salvas):** todos os interruptores refletem o padrão do registro; nenhuma linha existe em `NotificationPreference` até a primeira alteração.

## Regras de negócio
- **RN-NTF-22** — Preferência é por `(tenantId, userId, notificationType, channel)`; ausência de linha = padrão do registro (events.md §6).
- **RN-NTF-23** — Tipos marcados "obrigatória" no registro não podem ter o canal `IN_APP` desativado; a API rejeita `enabled = false` para essa combinação.
- **RN-NTF-24** — O canal `EMAIL` só tem efeito prático quando `notifications.emailEnabled` (tenant) é verdadeiro; com o tenant desligado, a preferência pode ser salva mas fica inerte (a UI explica e desabilita os controles para evitar confusão).
- **RN-NTF-25** — `PUT` em `ME-06` é um *merge*: só as combinações enviadas são alteradas; combinações omitidas mantêm o valor atual (nunca um `PUT` apaga preferências não mencionadas).
- **RN-NTF-26** — Toda alteração grava auditoria `notification.preferences_update` (categoria `SECURITY`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Interruptor por tipo/canal | `enabled` | booleano | Sim (por combinação enviada) | RN-NTF-23 | padrão do registro |
| *(agrupador, somente leitura)* | `notificationType` | `NotificationType` (registro) | — | RN-NTF-22 | events.md §6 |
| *(agrupador, somente leitura)* | `channel` | `NotificationChannel` | — | `IN_APP`\|`EMAIL` | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `notificationType`/`channel` fora dos enums/registro | API (Zod) | "Tipo de notificação inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | Desativar `IN_APP` de tipo obrigatório | API | "Este aviso não pode ser desligado." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-03 | Corpo vazio ou malformado em `ME-06` | API (Zod) | "Nenhuma alteração reconhecida." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** nenhum código formal — capacidade implícita sobre o próprio perfil (padrão `ME-*`, permissions.md §1.1), igual a US-111.
- **Políticas:** nenhuma além da própria identidade (o usuário só lê/altera as próprias preferências; não há `userId` no corpo).
- **MFA:** não exigido.
- **Sem permissão:** não autenticado → 401 `UNAUTHENTICATED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio; a alteração é lida diretamente pelo `NotificationDispatcher` (US-111) no próximo despacho. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Esta story não gera notificações; ela consulta/altera preferências usadas pelo despacho (US-111). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Preferências de notificação

  Background:
    Given que o usuário "Elisa" está autenticado no tenant "Prefeitura de São José"
    And "notifications.emailEnabled" está ativo para o tenant

  Scenario: [Sucesso] Desativar e-mail de um tipo não obrigatório
    When "Elisa" desligar o canal "EMAIL" do tipo "COMMENT_REPLY" e salvar
    Then a preferência "(COMMENT_REPLY, EMAIL, enabled=false)" deve ser gravada para "Elisa"
    And a próxima notificação "COMMENT_REPLY" para "Elisa" não deve enfileirar e-mail

  Scenario: [Validação] Tipo fora do registro
    When o front enviar "PUT /me/notification-preferences" com "notificationType" igual a "TIPO_INEXISTENTE"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_ENUM"

  Scenario: [Permissão] Tentativa de desligar canal obrigatório
    When "Elisa" enviar "PUT /me/notification-preferences" desativando "IN_APP" de "APPROVAL_REQUESTED"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"
    And a preferência de "APPROVAL_REQUESTED" não deve ser alterada

  Scenario: [Tenant incorreto] Preferências isoladas por tenant
    Given que "Elisa" também tem vínculo ativo na "Prefeitura B"
    When "Elisa" desligar "EMAIL" de "COMMENT_REPLY" na "Prefeitura de São José"
    Then a preferência na "Prefeitura B" deve permanecer no padrão do registro

  Scenario: [Duplicidade] Reenvio do mesmo PUT é idempotente
    Given que "Elisa" já desligou "EMAIL" de "COMMENT_REPLY"
    When o mesmo "PUT" for enviado novamente com os mesmos valores
    Then a API deve responder 200 sem criar linhas duplicadas

  Scenario: [Concorrência] Duas alterações simultâneas em tipos diferentes
    Given que "Elisa" envia, quase ao mesmo tempo, um "PUT" alterando "COMMENT_REPLY" e outro alterando "MENTIONED"
    When ambas as requisições forem processadas
    Then as duas preferências devem ficar salvas corretamente (RN-NTF-25)

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados está indisponível
    When "Elisa" clicar em "Salvar"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma preferência deve ser alterada

  Scenario: [Falha de integração] Configuração do tenant indisponível ao carregar a tela
    Given que o serviço de configurações do tenant está indisponível
    When "Elisa" abrir a aba "Notificações"
    Then a tela deve exibir erro com "Tentar novamente"
    And nenhuma preferência deve ser perdida
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Tipo/canal inválido | 422 | `VALIDATION_ERROR` (`INVALID_ENUM`) | "Tipo de notificação inválido." | Recarrega a lista de tipos |
| Desligar canal obrigatório | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Este aviso não pode ser desligado." | Reverte o interruptor na tela |
| Corpo vazio/malformado | 422 | `VALIDATION_ERROR` | "Nenhuma alteração reconhecida." | Mantém estado anterior |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente." | Redireciona ao login |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Botão "Tentar novamente"; mantém alterações locais |

## Dependências
- **Stories:** US-111 (central de notificações — consome estas preferências a cada despacho; é pré-requisito funcional).
- **Decisões/ADRs:** nenhuma decisão específica além das já citadas em US-111 (DEC-024 não se aplica aqui).
- **Configurações:** `notifications.emailEnabled` (tenant; condiciona a coluna `EMAIL` da tela).
- **Lacunas nas fontes canônicas:** nenhuma. Decisões da implementação: `meta.emailEnabled` em ME-05/ME-06 (a chave `notifications.emailEnabled` não é pública em `SET-03`) e `enabled: null` em ME-06 para "Usar padrão"; o in-app desligado de um tipo opcional faz o dispatcher gravar a notificação já arquivada só para portar o e-mail (ou nada, se não há e-mail a enviar).

## Impacto técnico
- Tabela `NotificationPreference` já é prevista em entities.md; esta story só adiciona a camada de API/UI e a regra de trava de tipos obrigatórios.
- O `NotificationDispatcher` (US-111) precisa consultar esta tabela por `(userId, type, channel)` a cada despacho — recomenda-se cache de curta duração (segundos) por usuário para não sobrecarregar o banco em tenants com muitos eventos simultâneos (otimização, não bloqueante para o MVP 1).

## Backend
- **Módulo(s):** `notification` (dono de `NotificationPreference`).
- **Casos de uso:** `GetNotificationPreferencesQuery`, `UpdateNotificationPreferencesCommand`.
- **Domínio:** validação de combinação obrigatória contra `NotificationRegistry` (US-111) antes de persistir.
- **Integrações internas:** nenhuma além da leitura do registro.
- **Transação:** `UpdateNotificationPreferencesCommand` grava todas as combinações enviadas em upserts dentro de uma única transação; auditoria na mesma transação.

## Frontend
- **Tela(s):** SCR-039 (`/perfil`, aba "Notificações"); atalho em SCR-036 (`/notificacoes`).
- **Componentes:** `NotificationPreferencesGrid` (tipos agrupados por área, duas colunas de `Switch`), nota de "obrigatório" e de "e-mails desligados pelo órgão".
- **Estados:** skeleton na carga; "Preferências salvas" (toast); erro com "Tentar novamente"; interruptor em estado de carregamento individual durante o salvamento.
- **Acessibilidade e responsividade:** cada `Switch` com rótulo associado e estado anunciado (`aria-checked`); grade vira lista de cartões em telas < 768 px.

## Banco de dados
- **Tabelas:** `notification_preferences`.
- **Migrações:** criação de `notification_preferences` conforme entities.md (módulo `notification`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, user_id, notification_type, channel)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ME-05 | GET | `/api/v1/me/notification-preferences` | — | `200 { data: [{ notificationType, channel, enabled, editable }], meta: { emailEnabled } }` | 200, 401 |
| ME-06 | PUT | `/api/v1/me/notification-preferences` | `{ preferences: [{ notificationType, channel, enabled }] }` (`enabled: null` = usar padrão — FA-01) | `200 { data: [...], meta: { emailEnabled } }` | 200, 401, 422, 503 |

## Logs
- `info` `notification_preferences.updated` — quantidade de combinações alteradas, `correlationId`.
- `warn` `notification_preferences.mandatory_channel_blocked` — tipo/canal rejeitado.
- `error` genérico de falha de banco (sem dados sensíveis).
- **Nunca logar:** nada sigiloso aplicável; preferências não contêm dado sensível, mas seguem o padrão geral de DEC-138.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `notification.preferences_update` | `SECURITY` | Commit de `ME-06` | `changes`: combinações alteradas (tipo, canal, de/para); `metadata`: quantidade total |

## Testes necessários
- **Unitários:** trava de tipos obrigatórios; resolução de padrão quando não há linha salva.
- **Integração (Testcontainers):** upsert por combinação; `UNIQUE` sob concorrência; leitura pelo `NotificationDispatcher` após alteração.
- **API/contrato:** `ME-05`/`ME-06` conforme api.md.
- **RBAC e multi-tenant:** preferências de um tenant nunca afetam outro vínculo do mesmo usuário.
- **Concorrência:** dois `PUT` simultâneos em tipos diferentes não se perdem (merge).
- **E2E (Playwright):** desligar um tipo na tela e confirmar que a próxima notificação simulada respeita a escolha.
- **Acessibilidade/performance:** axe na grade de preferências.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Trava de tipos obrigatórios aplicada na API; UI desabilita os controles correspondentes
- [ ] Auditoria `notification.preferences_update` verificada em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de `ME-05`/`ME-06` atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**S** — CRUD simples sobre uma tabela já modelada, com uma regra de trava e sem workflow; a maior parte do esforço é a grade de UI com muitos tipos.

## Prioridade
**P2** — melhora a experiência e reduz ruído, mas o produto funciona com os padrões do registro mesmo sem esta story; por isso vem depois das stories P0/P1 do épico.
