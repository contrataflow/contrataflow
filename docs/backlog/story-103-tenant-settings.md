---
id: US-103
title: "Configurações gerais do tenant"
epic: EP-017
feature: FT-057
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-100]
modules: [tenancy, access, audit, platform]
screens: [SCR-041]
endpoints: [SET-01, SET-02, SET-03]
permissions: [SETTINGS_MANAGE]
events: [TenantSettingsChanged]
---

# US-103 — Configurações gerais do tenant

## Título
Configurações gerais do tenant

## Descrição
**Como** administrador do órgão, **quero** consultar e alterar as configurações gerais do tenant (rótulos, marca, numeração, segurança, prazos, pesquisa de preços…) a partir de um registro único e tipado, **para** adaptar o comportamento do sistema ao meu órgão sem depender de suporte técnico.

A tela SCR-041 organiza as chaves em grupos (Identidade, Marca, Numeração, Segurança, Prazos, Pesquisa de preços, Riscos, Arquivos, Notificações…); cada módulo dono registra suas próprias chaves, com schema Zod, valor padrão e indicação de leitura pública. A API expõe um `GET`/`PATCH` genéricos (`SET-01`/`SET-02`) e um subconjunto público (`SET-03`) para a interface de qualquer usuário autenticado.

## Contexto
- DEC-059 (feature flags) e dezenas de outras decisões (numeração — DEC-028; prazos — DEC-031; pesquisa de preços — Lei 14.133/2021, art. 23) definem comportamento via chave de configuração do tenant, não por código. O registro tipado (entities.md §6) é a fonte única de chaves válidas, schema e padrão.
- Hoje a maioria dos sistemas do setor público trata essas opções como "parâmetros do sistema" acessíveis só a TI; aqui o próprio administrador do órgão ajusta o comportamento, com validação e auditoria de valor anterior/novo.
- O provisionamento (US-099) grava todas as chaves do registro com o valor padrão (`tenancy.settings`, entities.md §6); esta story é dona desse seeder e da API de leitura/escrita subsequente.
- `labels.secretariat`/`labels.department` (US-102) e `numbering.*` (US-105) dependem diretamente desta story.

## Objetivo
Permitir que o administrador leia e altere qualquer chave do registro com validação de tipo, concorrência otimista por chave e auditoria completa, em menos de 1 minuto por alteração, sem exigir deploy ou suporte.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Qualquer usuário com vínculo `ACTIVE` (leitura pública — `SET-03`, rótulos e marca).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`.
- Para alterar: vínculo `ACTIVE` com `SETTINGS_MANAGE`. Para ler `SET-03`: qualquer vínculo `ACTIVE`.
- Tenant provisionado (todas as chaves semeadas com padrão — US-099).

## Fluxo principal
1. O administrador acessa **Administração → Configurações** (SCR-041); o front chama `GET /api/v1/settings` (`SET-01`) e agrupa as chaves conforme o registro.
2. O administrador altera um ou mais valores de um grupo (ex.: `labels.secretariat` = "Diretoria") e clica em **"Salvar"**.
3. O front valida cada chave alterada com o schema Zod correspondente e envia `PATCH /api/v1/settings` (`SET-02`) com `{ values: { chave: valor }, expectedVersions: { chave: versão } }`.
4. A API, em uma transação: valida que toda chave existe no registro (senão `SETTING_KEY_UNKNOWN`), valida cada valor pelo schema registrado, confere `expectedVersions` (senão `VERSION_CONFLICT`), grava cada `TenantSetting` com valor anterior/novo em auditoria `settings.update` e publica um único `TenantSettingsChanged` com `keys[]`.
5. A API responde **200** com os valores atualizados (e novas versões); o front mostra "Configurações salvas" e atualiza o cache local.
6. Telas que exibem rótulos/marca para qualquer usuário (ex.: cabeçalho, wizard de processo) consultam `GET /api/v1/settings/public` (`SET-03`), cacheado no cliente.

## Fluxos alternativos
- **FA-01 — Grupo de numeração:** editar `numbering.process.mask`/`scope`/`assignOn` mostra o aviso "Mudanças de escopo valem a partir do próximo número gerado" (DEC-028); a prévia (`SET-04`) é tratada em US-105.
- **FA-02 — Chave desconhecida (API/integração legada):** uma chamada `PATCH` com chave fora do registro é rejeitada por completo (nenhuma chave do lote é alterada) com `SETTING_KEY_UNKNOWN`.
- **FA-03 — Novo tenant sem a linha de uma chave recém-criada:** `GET`/`PATCH` tratam a ausência de linha como o valor padrão do registro; o seeder `tenancy.settings` grava a linha na próxima reexecução (`tenant:seed`, US-099 FA-08).
- **FA-04 — Feature flag:** chaves `features.<nome>` seguem o mesmo contrato genérico (tipo booleano), sem tela dedicada além do grupo "Funcionalidades".
- **FA-05 — Edição concorrente de chaves diferentes:** dois administradores alterando chaves distintas no mesmo `PATCH` ou em requisições separadas não conflitam entre si (concorrência é por chave).

## Regras de negócio
- **RN-TEN-52** — Somente chaves existentes no registro tipado (entities.md §6) podem ser lidas ou gravadas; chave fora do registro → `SETTING_KEY_UNKNOWN` (422).
- **RN-TEN-53** — O valor de cada chave é validado pelo schema Zod registrado pelo módulo dono (tipo, intervalo, enum do §6); o módulo pode emitir um código de violação próprio (ex.: `NUMBERING_MASK_INVALID` para `numbering.*`, US-105) em vez do genérico `VALIDATION_ERROR`.
- **RN-TEN-54** — Concorrência por chave: `PATCH` informa o `version` esperado de cada chave alterada; qualquer divergência cancela o lote inteiro (`VERSION_CONFLICT`, 412, identificando a(s) chave(s) em conflito) — tudo ou nada.
- **RN-TEN-55** — Toda alteração grava o `TenantSetting` da chave e a auditoria `settings.update` (valor anterior/novo, por chave) na mesma transação; um único evento `TenantSettingsChanged` é publicado por requisição, com `keys[]` de todas as chaves alteradas.
- **RN-TEN-56** — `SET-03` expõe somente as chaves marcadas **públicas** no registro (grupos "Identidade" e "Marca": `labels.*`, `branding.*`) a qualquer vínculo `ACTIVE`, sem exigir `SETTINGS_MANAGE`; as demais chaves nunca aparecem nessa rota.
- **RN-TEN-57** — Chave sem linha persistida (tenant provisionado antes de ela existir no registro) retorna o valor padrão do registro em `GET`; o seeder `tenancy.settings` (módulo `tenancy`, `applyToExistingTenants = true`) grava o padrão de toda chave nova em tenants existentes (US-099, RN-TEN-07) e de todas as chaves no provisionamento.
- **RN-TEN-58** — Alterar chaves de numeração (`numbering.*`) não afeta números já emitidos; a UI exibe aviso não bloqueante de que o efeito pleno de `numbering.process.scope` ocorre a partir do próximo exercício (DEC-028).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Qualquer chave do registro | `values["<chave>"]` | conforme schema da chave (§6: string, boolean, int, enum, objeto) | Não (só as alteradas) | Schema Zod da chave; RN-TEN-52/53 | padrão do registro |
| *(sistema)* Versão esperada por chave | `expectedVersions["<chave>"]` | int | Sim, por chave alterada | RN-TEN-54 | `version` atual lido em `SET-01` |

Grupos exibidos em SCR-041 (rótulo → prefixo de chave): Identidade (`labels.*`), Marca (`branding.*`), Numeração (`numbering.*`), Processos (`process.*`), Acesso (`access.*`), Aprovações (`approval.*`), Segurança (`security.*`), Prazos (`deadlines.*`), Calendário (`calendar.*`), Pesquisa de preços (`priceResearch.*`), Riscos (`risk.*`), Arquivos (`uploads.*`), Notificações (`notifications.*`), Funcionalidades (`features.*`). Catálogo completo de chaves, tipos e limites: entities.md §6.

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Chave fora do registro | API | "Configuração desconhecida: {chave}." | `SETTING_KEY_UNKNOWN` |
| V-02 | Valor fora do schema da chave (tipo/intervalo/enum) | Front + API (Zod) | "Valor inválido para {chave}." | `VALIDATION_ERROR` |
| V-03 | Máscara de numeração sem `{seq:N}`/`{year}` | Front + API | "A máscara deve conter {seq:N} e {year}." | `NUMBERING_MASK_INVALID` |
| V-04 | `expectedVersions` divergente do atual | API | "Esta configuração foi alterada por outra pessoa. Recarregue." | `VERSION_CONFLICT` |
| V-05 | `expectedVersions` ausente para chave alterada | API | "Recarregue a página de configurações e tente novamente." | `PRECONDITION_REQUIRED` |

## Permissões
- **Permissão:** `SETTINGS_MANAGE` (leitura completa e escrita), risco `H`, sem variação de escopo (sempre `TENANT`); leitura pública (`SET-03`) é capacidade implícita de qualquer vínculo `ACTIVE`.
- **Políticas:** nenhuma política contextual própria.
- **MFA:** exigido quando `security.mfaPolicy` é `ADMINS` ou `ALL` (POL-14, permissão `HIGH`).
- **Sem permissão:** tela de configurações (exceto o que já vem via `SET-03`) oculta; API responde 403 `PERMISSION_DENIED` em `SET-01`/`SET-02` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantSettingsChanged` | `tenant.settings_changed` | Commit do `PATCH` | Payload: `keys[]` (todas as chaves alteradas na requisição) |

`FeatureFlagService`, `NumberingFacade` e `BusinessCalendarFacade` (entre outros consumidores) assinam `TenantSettingsChanged` para invalidar cache por chave.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; alteração de configuração não notifica usuários (visível na própria tela e na auditoria). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Configurações gerais do tenant

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Carla" possui o perfil "ADMIN_ORGAO" com escopo "TENANT"

  Scenario: [Sucesso] Alterar o rótulo de secretaria
    Given que "labels.secretariat" está na versão 1 com valor "Secretaria"
    When "Carla" alterar "labels.secretariat" para "Diretoria" informando a versão esperada 1
    Then a configuração deve ser atualizada para "Diretoria" na versão 2
    And deve gerar registro de auditoria "settings.update" com valor anterior "Secretaria" e novo "Diretoria"
    And deve gerar o evento "TenantSettingsChanged" com "keys" contendo "labels.secretariat"

  Scenario: [Validação] Máscara de numeração sem token obrigatório
    When "Carla" alterar "numbering.process.mask" para "PROC-{seq:4}"
    Then a API deve responder 422 com código "NUMBERING_MASK_INVALID"
    And nenhuma configuração deve ser alterada

  Scenario: [Permissão] Usuário sem SETTINGS_MANAGE
    Given que "Bruno" não possui "SETTINGS_MANAGE"
    When "Bruno" enviar PATCH para "/api/v1/settings"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    But "Bruno" deve conseguir ler "/api/v1/settings/public" normalmente

  Scenario: [Tenant incorreto] Configuração não atravessa tenants
    Given que o tenant "Prefeitura B" tem "branding.primaryColor" igual a "#000000"
    When "Carla", no tenant "Prefeitura de São José", ler "/api/v1/settings/public"
    Then a resposta não deve conter nenhum valor do tenant "Prefeitura B"

  Scenario: [Duplicidade] Reenvio do mesmo PATCH após falha de rede
    Given que "Carla" enviou a alteração de "security.sessionIdleMinutes" e não recebeu resposta
    When o front reenviar o mesmo PATCH com a mesma versão esperada
    Then a API deve aplicar a alteração uma única vez
    And a segunda tentativa deve responder "VERSION_CONFLICT" se a primeira já tiver sido aplicada

  Scenario: [Concorrência] Duas alterações da mesma chave simultâneas
    Given que "deadlines.warnBeforeBusinessDays" está na versão 5
    When "Carla" e "Diego" enviarem PATCH para a mesma chave informando a versão 5 ao mesmo tempo
    Then apenas uma alteração deve ser aplicada, avançando para a versão 6
    And a outra deve responder 412 com código "VERSION_CONFLICT" e "currentVersion" igual a 6

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados está indisponível
    When "Carla" tentar salvar uma alteração
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma chave deve ser alterada

  Scenario: [Falha de integração] Outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" salvar uma alteração válida
    Then a configuração deve ser atualizada e a API deve responder 200
    And o evento "TenantSettingsChanged" deve permanecer "PENDING" até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Chave fora do registro | 422 | `SETTING_KEY_UNKNOWN` | "Configuração desconhecida." | Remove a chave do formulário e recarrega |
| Valor inválido para a chave | 422 | `VALIDATION_ERROR` | "Valor inválido para {chave}." | Marca o campo |
| Máscara de numeração inválida | 422 | `NUMBERING_MASK_INVALID` | "A máscara deve conter {seq:N} e {year}." | Marca o campo |
| Versão esperada ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega `SET-01` |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Esta configuração foi alterada por outra pessoa." | Recarrega valores atuais |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar configurações." | Oculta "Salvar" |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Abre desafio de MFA |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Mantém valores digitados |

## Dependências
- **Stories:** US-100 (contexto de tenant); US-099 (seeder `tenancy.settings`, provisionamento — esta story é dona do seeder consumido por RN-TEN-07 de US-099); usada por US-102 (`labels.*`), US-105 (`numbering.*`), US-106 (`calendar.*`), e por toda story que leia uma chave do §6.
- **Decisões/ADRs:** DEC-028, DEC-031, DEC-059, DEC-080..083, DEC-104; ADR-002.
- **Configurações:** todas as chaves de entities.md §6 (esta story é o mecanismo genérico de leitura/escrita de todas elas).
- **Lacunas nas fontes canônicas:** nenhuma chave, enum ou código de erro ausente; duas decisões de desenho ficam a critério desta especificação (sem alterar fonte canônica): (1) formato do `PATCH` em lote com `expectedVersions` por chave, para materializar o "If-Match por chave" citado no pacote; (2) chaves públicas de `SET-03` assumidas como os grupos `labels.*`/`branding.*`.

## Impacto técnico
- Registro tipado (`packages/types`, `SettingsRegistry`) é carregado no boot; cada módulo contribui suas chaves (padrão "registro por módulo", igual ao `TENANT_SEEDERS` de US-099) — ciclo ou chave duplicada entre módulos impede o boot.
- `GET /settings` e `/settings/public` devem ter cache curto (ETag/`Cache-Control` por tenant) por serem lidos com alta frequência (cabeçalho, wizard de processo).
- `PATCH` em lote é transacional: todas as chaves do corpo são validadas e gravadas juntas, ou nenhuma é.

## Backend
- **Módulo(s):** `tenancy` (dono do mecanismo genérico e do seeder `tenancy.settings`); cada módulo registra suas chaves (`catalog`, `organization`, `process`, `document`, `access`, `risk`, `priceResearch`…) no `SettingsRegistry`. Implementação: as definições (schema, padrão, grupo, módulo dono, leitura pública) estão em `packages/validation/src/tenancy/settings.ts` (`SETTING_DEFINITIONS`), compartilhadas com a SCR-041 — ver DEC-059 em decisions.md.
- **Casos de uso:** `GetSettingsQuery`, `GetPublicSettingsQuery`, `UpdateSettingsCommand` (lote).
- **Domínio:** `SettingsRegistry` (chave → schema Zod, padrão, grupo, `isPublic`); `TenantSetting.upsert(key, value, expectedVersion)`.
- **Contrato de seeder:** `tenancy.settings` implementa `TenantSeeder` (US-099): `seed()` grava toda chave ausente com o padrão; `verify()` confere que todas as chaves do registro têm linha.
- **Integrações internas:** `FeatureFlagService`, `NumberingFacade`, `BusinessCalendarFacade` assinam `TenantSettingsChanged` para invalidar cache.
- **Transação:** leitura/validação de todas as chaves do lote, upsert, auditoria e outbox em uma única transação com `app.tenant_id`.

## Frontend
- **Tela(s):** SCR-041 (`/admin/configuracoes`), por grupo.
- **Componentes:** `SettingsGroupTabs`, `SettingField` (renderiza o editor certo pelo tipo do schema: texto, interruptor, número, seleção, cor), `SaveBar` (mostra alterações pendentes e versões).
- **Estados:** skeleton por grupo; erro com "Tentar novamente"; indicador de "salvando…"; aviso não bloqueante para chaves com efeito futuro (RN-TEN-58).
- **Acessibilidade e responsividade:** cada campo com rótulo e descrição associados; contraste AA no seletor de cor (`branding.primaryColor`); abas em menu suspenso em telas < 768 px.

## Banco de dados
- **Tabelas:** `tenant_settings`.
- **Migrações:** `20261015240000_tenant_settings` — tabela `tenant_settings` (entities.md §4: check do formato da chave, trigger de imutabilidade de tenant e chave, RLS, sem `DELETE`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, key)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| SET-01 | GET | `/settings` | — | `200 { data: { "<chave>": { value, version } } }` (todas as chaves do registro) | 200, 403 |
| SET-02 | PATCH | `/settings` | `{ values: { "<chave>": valor }, expectedVersions: { "<chave>": versão } }` | `200 { data: { "<chave>": { value, version } } }` (somente as alteradas) | 200, 403, 412, 422, 428 |
| SET-03 | GET | `/settings/public` | — | `200 { data: { "<chave>": valor } }` (somente chaves públicas) | 200, 401 |

## Logs
- `info` `settings.updated` — `keys[]`, `tenantId`, `userId`, `correlationId`.
- `warn` `settings.unknown_key_rejected` — chave fora do registro.
- `error` `settings.save_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** valores de chaves de segurança sensíveis, se alguma vier a existir (hoje nenhuma chave do §6 é sigilosa).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `settings.update` | `CONFIGURATION` | Commit do `PATCH`, uma entrada por chave alterada | `changes`: valor anterior/novo; `metadata`: `key`, `group` |
| `access.denied` | `ACCESS` | Tentativa sem `SETTINGS_MANAGE` | `reasonCode = SETTINGS_MANAGE` |

## Testes necessários
- **Unitários:** `SettingsRegistry` (validação por schema, detecção de chave duplicada/ciclo entre módulos); RN-TEN-52..58.
- **Integração (Testcontainers):** `PATCH` em lote tudo-ou-nada; `SETTING_KEY_UNKNOWN`; seeder `tenancy.settings` idempotente (reexecução sem duplicar linhas) e aplicando chave nova a tenant existente.
- **API/contrato:** respostas e erros de `SET-01..03` conforme api.md.
- **RBAC e multi-tenant:** com/sem `SETTINGS_MANAGE`; `SET-03` acessível sem a permissão; RLS impede leitura cruzada entre tenants.
- **Concorrência:** duas alterações da mesma chave simultâneas (cenário Gherkin acima); alterações de chaves diferentes não se bloqueiam.
- **E2E (Playwright):** alterar um rótulo e ver o reflexo imediato na tela de criação de processo.
- **Acessibilidade/performance:** axe nos editores de configuração; `GET /settings` com ~30 chaves em p95 < 200 ms.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `SETTINGS_MANAGE` aplicado em `SET-01`/`SET-02`; `SET-03` acessível sem a permissão; UI esconde "Salvar" sem permissão
- [ ] Auditoria `settings.update` e evento `TenantSettingsChanged` verificados em teste
- [ ] Seeder `tenancy.settings` cobre todas as chaves de entities.md §6, testado em provisionamento e em reaplicação a tenant existente
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de SET-01..03 atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — mecanismo genérico (registro tipado, validação por schema, concorrência por chave, seeder, rota pública) reutilizado por praticamente todas as outras stories do produto.

## Prioridade
**P0** — toda configuração de numeração, prazos, segurança e rótulos do tenant depende deste mecanismo.
