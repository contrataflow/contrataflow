---
id: US-184
title: "Habilitar o gov.br no órgão e nível de confiança na política de MFA"
epic: EP-029
feature: FT-084
mvp: 2
priority: P1
estimate: S
status: Especificada
depends_on: [US-090, US-182]
modules: [tenancy, identity, access, audit]
screens: [SCR-041]
endpoints: [SET-01, SET-02, GOV-09]
permissions: [SETTINGS_MANAGE]
events: [TenantSettingsChanged]
---

# US-184 — Habilitar o gov.br no órgão e nível de confiança na política de MFA

## Título
Habilitar o gov.br no órgão e nível de confiança na política de MFA

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO`, com `SETTINGS_MANAGE`), **quero** ligar ou desligar a entrada com gov.br no meu órgão e decidir se um nível de confiança do gov.br (prata ou ouro) vale como segundo fator na política de MFA, **para** oferecer a entrada que os servidores já usam sem abrir mão do controle de quem acessa e sem enfraquecer a exigência de confirmação de identidade nas ações sensíveis por acidente.

A story acrescenta duas chaves ao registro de configurações do tenant (US-103) — `auth.govbrEnabled` (padrão `false`) e `auth.govbrCountsAsMfa` (`NEVER`, `SILVER_OR_GOLD` ou `GOLD`, padrão `NEVER`) —, um grupo "Autenticação" em SCR-041 e a leitura do estado da fonte (`GOV-09`). Ela estende `SET-01` e `SET-02` sem mudar o contrato, e faz a avaliação de MFA do `AuthorizationService` (DEC-142) reconhecer o gov.br **só** quando o órgão pediu.

## Contexto
- DEC-207 e [ADR-017](../adr/adr-017-govbr-login.md): a habilitação é **por tenant** (`auth.govbrEnabled`, padrão desligado), depois do credenciamento da plataforma no Login Único; contar o nível prata/ouro como segundo fator para a política de MFA (DEC-133) é opção do tenant, desligada por padrão. A US-182 usa `auth.govbrEnabled` na entrada e na troca de instituição; a US-183, ao vincular.
- US-103 é o mecanismo genérico: registro tipado, `PATCH` em lote com `expectedVersions` por chave (o "If-Match por chave"), auditoria `settings.update` por chave e um `TenantSettingsChanged` por requisição. Esta story **registra duas chaves** nesse mecanismo e não cria rota de escrita nova.
- US-090 / DEC-142: o `AuthorizationService.authorize` verifica o `amr` e, quando ele não comprova o fator, lê `security.mfaPolicy` do cache de 60 s por tenant (`SettingsTenantMfaPolicy`), apagado no commit do `SET-02` e pelo `TenantSettingsChanged` no worker (RN-IAM-42). O gov.br entra nessa mesma avaliação, sem novo caminho.
- Esta story **não redefine** as RN-PLAT-08 a RN-PLAT-14 da feature FT-084: detalha a RN-PLAT-12 (nível de confiança como segundo fator, padrão `NEVER`) e a RN-PLAT-13 (habilitação, padrão `false`) nas RN-PLAT-220 a RN-PLAT-239.
- **Atenção de segurança:** os níveis do gov.br indicam o grau de comprovação da **conta**, não quantos fatores foram usados naquele acesso; uma conta ouro pode entrar só com senha no gov.br. Por isso o padrão é `NEVER`, a tela avisa e alterar a chave exige segundo fator real (RN-PLAT-226). Dúvida de produto 1.
- Pessoas de teste: "Carla" (`ADMIN_ORGAO`), "Bruno" (sem permissão), "Marta" (servidora que entra com gov.br). Órgãos "Prefeitura A" e "Prefeitura B" fictícios.

## Objetivo
Permitir que o administrador habilite o gov.br e escolha o nível aceito como segundo fator em menos de 1 minuto, com validação do valor e do estado da fonte, concorrência por chave, efeito sobre as próximas requisições das sessões abertas em até 60 s em qualquer réplica, auditoria do valor anterior e novo, e 0 mudança de comportamento nos órgãos que não mexeram nas chaves.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, escopo `TENANT`; Carla).
- **Secundárias:** Servidores do órgão (veem o botão, o vínculo e a exigência de MFA mudarem); operador da plataforma, que credencia o ambiente; auditor (`AUDITOR`), que lê o `settings.update`.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `SETTINGS_MANAGE` e, quando a política exigir (`security.mfaPolicy` `ADMINS` ou `ALL`), sessão com **segundo fator real** para estas duas chaves (RN-PLAT-226).
- Para **ligar** o gov.br: ambiente credenciado no Login Único e fonte criada (`GOV-09` devolve `sourceAvailable = true`).
- As duas chaves existem no registro (`SETTING_DEFINITIONS`) e foram semeadas com o padrão, em tenants novos e existentes (RN-PLAT-234).

## Fluxo principal
1. O administrador abre **Administração › Configurações** (SCR-041, `/admin/configuracoes`) e o grupo **Autenticação**. A tela chama `SET-01` (valores e versões) e `GOV-09` (estado da fonte).
2. O grupo mostra a chave "Permitir a entrada com gov.br" (interruptor, desligado por padrão) e, abaixo, "Aceitar o gov.br como segundo fator" (seleção: "Nunca", "Níveis prata e ouro", "Somente o nível ouro"). Sem fonte disponível o interruptor fica desabilitado, com "O login com gov.br ainda não está disponível nesta plataforma. Fale com o suporte para o credenciamento.".
3. Carla liga o interruptor e clica em "Salvar". Se elevar o segundo campo acima de "Nunca", a tela pede confirmação ("Aceitar o gov.br como segundo fator reduz a confirmação de identidade nas ações sensíveis. Confirmar?").
4. O front valida o enum e envia `PATCH /api/v1/settings` (`SET-02`) com `{ values, expectedVersions }` só das chaves alteradas.
5. A API, em uma transação: confere `SETTINGS_MANAGE` e o segundo fator real, valida chave e valor, confere que a fonte está disponível se `auth.govbrEnabled` passa a `true`, confere as versões, grava as chaves, as auditorias `settings.update` (valor anterior e novo por chave) e o evento `TenantSettingsChanged`; ao confirmar, apaga o cache de 60 s da política de MFA daquele tenant na réplica.
6. A resposta **200** devolve as chaves alteradas com as novas versões; a tela mostra "Configurações salvas" e, com o gov.br ligado, o aviso "Os servidores só entram com gov.br depois de vincular a conta em Meu perfil. Sem convite não há acesso.".
7. O worker, ao consumir `TenantSettingsChanged` com qualquer das chaves, apaga o mesmo cache nas demais réplicas. A partir da próxima avaliação, as sessões abertas já seguem a regra nova (RN-PLAT-228).
8. Quando é o primeiro órgão a ligar, o botão "Entrar com gov.br" passa a aparecer em `/entrar` em até 60 s (RN-PLAT-232).

## Fluxos alternativos
- **FA-01 — Fonte indisponível:** `GOV-09` devolve `sourceAvailable = false`; ligar o gov.br é recusado na API com 422 `VALIDATION_ERROR` (`NOT_ALLOWED`) se o cliente tentar. Desligar e alterar o nível continuam permitidos.
- **FA-02 — Desligar o gov.br:** o botão deixa de valer para o órgão, vínculos existentes ficam guardados e a entrada por gov.br no órgão é recusada com `GOVBR_NOT_ENABLED` (US-182); o nível aceito como segundo fator **deixa de valer** na hora, qualquer que seja o valor guardado.
- **FA-03 — Política de MFA desligada (`NONE`):** a tela avisa "Com a política de segundo fator desligada, esta opção não tem efeito."; a chave pode ser salva.
- **FA-04 — Edição concorrente:** outra pessoa alterou a chave; `SET-02` responde 412 `VERSION_CONFLICT` com `currentVersion`; a tela recarrega os valores.
- **FA-05 — Sem alteração efetiva:** valores iguais aos atuais não geram versão, auditoria nem evento (RN-PLAT-229).
- **FA-06 — Sem segundo fator real:** 403 `MFA_REQUIRED`; o interceptador abre o *step-up* e a gravação é repetida (RN-PLAT-226).
- **FA-07 — Sessões gov.br abertas quando o gov.br é desligado:** continuam até o fim normal; só o efeito sobre o MFA muda na próxima requisição (RN-PLAT-223).
- **FA-08 — Servidor com sessão de nível insuficiente:** com `GOLD`, quem entrou com gov.br prata continua recebendo `MFA_REQUIRED` nas ações que exigem o fator e faz o *step-up* normal.

## Regras de negócio
- **RN-PLAT-220** — Registro das chaves (módulo `identity` em `SETTING_DEFINITIONS`, grupo "Autenticação", prefixo `auth.*`, rótulo de grupo novo em SCR-041): `auth.govbrEnabled` (booleano, padrão `false`) e `auth.govbrCountsAsMfa` (enum `NEVER`, `SILVER_OR_GOLD`, `GOLD`; padrão `NEVER`). Nenhuma das duas é pública: **não** entram em `SET-03` (RN-TEN-56). Valor fora do enum ou de tipo errado → 422 `VALIDATION_ERROR` (`INVALID_ENUM`/`INVALID_FORMAT`) sem alterar nada do lote (RN-TEN-53).
- **RN-PLAT-221** — Ligar exige fonte disponível: `auth.govbrEnabled = true` só é aceito se o ambiente estiver credenciado e a fonte existir (a mesma conta de `GOV-01` da US-182, sem a exigência de algum órgão habilitado); senão 422 `VALIDATION_ERROR` com `errors[{ field: "auth.govbrEnabled", code: "NOT_ALLOWED" }]` e a mensagem "O login com gov.br ainda não está disponível nesta plataforma. Fale com o suporte.". Desligar é sempre permitido.
- **RN-PLAT-222** — Efeito de `auth.govbrEnabled` (detalha RN-PLAT-11 e RN-PLAT-13): **ligado** — o órgão conta para a disponibilidade do botão, a entrada por gov.br vale para os vínculos dele (RN-PLAT-185, US-182) e quem o tem como órgão ativo pode vincular em "Meu perfil" (US-183); **desligado** — a entrada por gov.br recusa seus vínculos com `GOVBR_NOT_ENABLED`, "Vincular" some, "Desvincular" continua e os vínculos de identidade **são preservados** (a identidade é do usuário, não do órgão).
- **RN-PLAT-223** — Quando a habilitação é conferida: na entrada, na troca de instituição de uma sessão gov.br e ao vincular — **não** em toda requisição. Sessões abertas por gov.br no órgão **continuam** ao desligar a chave (a pessoa já foi autenticada; o ajuste é de entrada, não de revogação). Quem precisar derrubar acessos usa os mecanismos de vínculo (suspender ou revogar — US-092).
- **RN-PLAT-224** — Semântica de `auth.govbrCountsAsMfa` (detalha RN-PLAT-12, DEC-133): `NEVER` — o gov.br nunca comprova segundo fator; `SILVER_OR_GOLD` — comprova se o `govbr_trust_level` da sessão é `SILVER` ou `GOLD`; `GOLD` — só se for `GOLD`. `BRONZE`, nível ausente ou desconhecido **nunca** comprovam. Vale somente se `auth.govbrEnabled = true` **e** a sessão foi aberta por gov.br (`amr` contém `govbr`). A avaliação é **por tenant ativo**: a mesma sessão pode comprovar o fator em um órgão (`GOLD` configurado) e não em outro (`NEVER`).
- **RN-PLAT-225** — Onde a regra entra: na decisão de MFA do `AuthorizationService.authorize` (DEC-142) — permissões `HIGH` sob `ADMINS` e toda requisição sob `ALL` — e no `mfaVerified` de `ME-01` (SCR-039); quando comprova, não há `MFA_REQUIRED` nem *step-up*. Quando não comprova e a sessão é gov.br, `auth.mfa_required` ganha `metadata.govbrTrustLevel` para explicar a recusa. **Não vale** para: operadores da plataforma (MFA real sempre — POL-29, DEC-078), desvincular a identidade (RN-PLAT-207, exige fator real ou login gov.br ≤ 10 min) e alterar estas duas chaves (RN-PLAT-226).
- **RN-PLAT-226** — Alterar `auth.govbrEnabled` ou `auth.govbrCountsAsMfa` exige **segundo fator real** na sessão (`amr` com TOTP, WebAuthn ou equivalente) sempre que a política do tenant exigir MFA para `SETTINGS_MANAGE` (permissão `HIGH`, POL-14); o gov.br contado como fator **não** serve para esta operação, para que ninguém eleve o próprio nível de confiança com a mesma conta que quer promover. Sem fator real → 403 `MFA_REQUIRED` e *step-up*. Com `security.mfaPolicy = NONE` nada é exigido (RN-IAM-39).
- **RN-PLAT-227** — Política `NONE`: o `amr` nunca é verificado (RN-IAM-39); `auth.govbrCountsAsMfa` fica guardada, sem efeito, e a tela avisa. Ao voltar a `ADMINS` ou `ALL`, a chave passa a valer.
- **RN-PLAT-228** — Cache e propagação: `SettingsTenantMfaPolicy` (60 s por tenant, DEC-142) passa a carregar `mfaPolicy`, `govbrEnabled` e `govbrCountsAsMfa` numa só leitura; é apagado no commit do `SET-02` (réplica que gravou, efeito imediato) e pelo `TenantSettingsChanged` no worker quando `keys[]` contém qualquer das três chaves (demais réplicas); no pior caso (evento atrasado), a expiração natural limita a defasagem a 60 s. Como a decisão do MFA não entra no retrato das permissões efetivas, não há outro cache a invalidar.
- **RN-PLAT-229** — Concorrência e idempotência (RN-TEN-54): `expectedVersions` por chave; divergência cancela o lote inteiro (412 `VERSION_CONFLICT`), ausência → 428 `PRECONDITION_REQUIRED`. Um `PATCH` cujos valores já são os atuais responde 200 sem nova versão, sem `settings.update` e sem `TenantSettingsChanged` (decisão desta story, lacuna 5).
- **RN-PLAT-230** — Auditoria e evento (RN-TEN-55): `settings.update` (categoria `CONFIGURATION`) por chave alterada com valor anterior e novo (booleano e enum, sem dado sensível; `metadata`: `key`, `group = auth`), na mesma transação, e um único `TenantSettingsChanged` com `keys[]`. A decisão de MFA tomada com base no gov.br **não** gera auditoria própria: `auth.session_start` já registra `loginMethod` e `amr`, e `auth.mfa_required` registra as recusas.
- **RN-PLAT-231** — Orientação na tela: texto fixo "O gov.br confirma quem é a pessoa, mas não dá acesso: só entra quem já tem convite e vinculou a conta gov.br em Meu perfil." e, na seleção do nível, "Os níveis prata e ouro indicam conta com identidade comprovada no gov.br; não garantem que o acesso usou dois fatores." O estado da fonte vem de `GOV-09`; sem fonte, interruptor desabilitado.
- **RN-PLAT-232** — Disponibilidade do botão (US-182, RN-PLAT-180): o primeiro órgão `ACTIVE` que liga a chave faz `GOV-01` passar a `available = true` em até 60 s (cache do BFF e da API); o último que desliga a faz voltar a `false` no mesmo prazo.
- **RN-PLAT-233** — Privacidade: a tela do administrador **não** lista quem vinculou a conta gov.br nem mostra CPF; a configuração é só do órgão. Contagens de vinculados ficam fora do escopo.
- **RN-PLAT-234** — Sementes: o seeder `tenancy.settings` (US-103, `applyToExistingTenants = true`) grava `false` e `NEVER` em todos os tenants novos e existentes; `verify()` confere as duas linhas. Tenant sem linha lê o padrão do registro (RN-TEN-57).
- **RN-PLAT-235** — `GOV-09` (`GET /settings/govbr-status`): exige `SETTINGS_MANAGE`; devolve só `{ sourceAvailable }` (credenciamento e fonte), sem segredo, URL do gov.br nem dado de outros tenants; cache de 60 s.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Permitir a entrada com gov.br | `values["auth.govbrEnabled"]` | booleano (interruptor) | Não (só se alterado) | RN-PLAT-220, RN-PLAT-221 | `false` |
| Aceitar o gov.br como segundo fator | `values["auth.govbrCountsAsMfa"]` | `NEVER`, `SILVER_OR_GOLD`, `GOLD` | Não (só se alterado) | RN-PLAT-220, RN-PLAT-224 | `NEVER` |
| *(sistema)* Versão esperada por chave | `expectedVersions["<chave>"]` | inteiro | Sim, por chave alterada | RN-PLAT-229 | `version` lida em `SET-01` |
| *(leitura)* Fonte disponível | `sourceAvailable` (`GOV-09`) | booleano | — | RN-PLAT-235 | calculado |
| *(leitura)* Política de MFA vigente | `security.mfaPolicy` (`SET-01`) | `NONE`, `ADMINS`, `ALL` | — | só para o aviso da RN-PLAT-227 | tenant |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `auth.govbrCountsAsMfa` fora de `NEVER`/`SILVER_OR_GOLD`/`GOLD` | Front + API (Zod) | "Escolha uma das opções." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | `auth.govbrEnabled` não booleano | Front + API (Zod) | "Valor inválido para auth.govbrEnabled." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | Ligar o gov.br com a fonte indisponível | API | "O login com gov.br ainda não está disponível nesta plataforma. Fale com o suporte." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-04 | Chave fora do registro | API | "Configuração desconhecida: {chave}." | `SETTING_KEY_UNKNOWN` |
| V-05 | `expectedVersions` divergente | API | "Esta configuração foi alterada por outra pessoa. Recarregue." | `VERSION_CONFLICT` |
| V-06 | `expectedVersions` ausente para chave alterada | API | "Recarregue a página de configurações e tente novamente." | `PRECONDITION_REQUIRED` |
| V-07 | Sem `SETTINGS_MANAGE` | API | "Você não tem permissão para alterar configurações." | `PERMISSION_DENIED` |
| V-08 | Sem segundo fator real ao alterar estas chaves, com política que exige | API | "Confirme sua identidade para continuar." | `MFA_REQUIRED` |

## Permissões
- **Permissão:** `SETTINGS_MANAGE` (risco `H`, escopo sempre `TENANT`) em `SET-01`, `SET-02` e `GOV-09`.
- **Políticas:** POL-14 (MFA por `riskLevel`; para estas duas chaves vale o fator **real**, RN-PLAT-226), POL-29 (habilitação por tenant), DEC-142 (cache da política e avaliação de `ALL`).
- **MFA:** exigido quando `security.mfaPolicy` é `ADMINS` ou `ALL`, por `SETTINGS_MANAGE`; o gov.br contado como fator não conta para esta operação.
- **Sem permissão:** o grupo "Autenticação" não aparece; `SET-01`/`SET-02`/`GOV-09` respondem 403 `PERMISSION_DENIED` e registram `access.denied` (`reasonCode = SETTINGS_MANAGE`). `SET-03` continua acessível a qualquer vínculo, sem estas chaves.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantSettingsChanged` | `tenant.settings_changed` | Commit do `PATCH` que muda `auth.govbrEnabled` e/ou `auth.govbrCountsAsMfa` | Payload `keys[]`; consumido pelo `identity` (cache da política de MFA) e pelo `tenancy` (cache de configurações) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | Alteração de configuração não notifica (US-103); fica visível na tela e na auditoria |

## Critérios de aceite em Gherkin
```gherkin
Feature: Habilitar o gov.br no órgão e nível de confiança na política de MFA

  Background:
    Given que o tenant "Prefeitura A" está ativo com a política "security.mfaPolicy" igual a "ADMINS"
    And a plataforma está credenciada no Login Único
    And "Carla" tem o perfil "ADMIN_ORGAO" com "SETTINGS_MANAGE" e sessão com segundo fator real
    And "auth.govbrEnabled" está "false" na versão 1 e "auth.govbrCountsAsMfa" está "NEVER" na versão 1

  Scenario: [Sucesso] Habilitar o gov.br no órgão
    When "Carla" ligar "auth.govbrEnabled" informando a versão esperada 1
    Then a configuração deve ficar "true" na versão 2
    And deve gerar registro de auditoria "settings.update" com valor anterior "false" e novo "true"
    And deve gerar o evento "TenantSettingsChanged" com "keys" contendo "auth.govbrEnabled"

  Scenario: [Sucesso] Padrões nos órgãos sem alteração
    When "Carla" abrir o grupo "Autenticação"
    Then "auth.govbrEnabled" deve aparecer desligado e "auth.govbrCountsAsMfa" deve aparecer como "Nunca"
    And "GET /settings/public" não deve conter nenhuma chave "auth.*"

  Scenario: [Sucesso] Nível prata ou ouro vale como segundo fator
    Given que "auth.govbrEnabled" está "true" e "auth.govbrCountsAsMfa" está "SILVER_OR_GOLD"
    And "Marta" é "ADMIN_ORGAO", entrou com gov.br no nível "SILVER" e não tem segundo fator real
    When "Marta" atribuir um perfil via "ROLE_ASSIGN"
    Then a ação deve ser concluída sem "MFA_REQUIRED"
    And "ME-01" deve devolver "mfaVerified" verdadeiro

  Scenario: [Sucesso] Só o ouro vale quando configurado como GOLD
    Given que "auth.govbrCountsAsMfa" está "GOLD"
    When "Marta" entrar com gov.br no nível "SILVER" e tentar "ROLE_ASSIGN"
    Then a API deve responder 403 com código "MFA_REQUIRED"
    When "Marta" entrar com gov.br no nível "GOLD" e tentar "ROLE_ASSIGN"
    Then a ação deve ser concluída

  Scenario: [Sucesso] Bronze e nível ausente nunca valem
    Given que "auth.govbrCountsAsMfa" está "SILVER_OR_GOLD"
    When "Marta" entrar com gov.br no nível "BRONZE" e tentar "ROLE_ASSIGN"
    Then a API deve responder 403 com código "MFA_REQUIRED"
    And a auditoria "auth.mfa_required" deve registrar "govbrTrustLevel" igual a "BRONZE"

  Scenario: [Sucesso] Sessão aberta passa a seguir a regra nova
    Given que "Marta" está com sessão gov.br nível "SILVER" aberta e "auth.govbrCountsAsMfa" está "NEVER"
    When "Carla" mudar "auth.govbrCountsAsMfa" para "SILVER_OR_GOLD"
    And "Marta" tentar "ROLE_ASSIGN" na próxima requisição
    Then a ação deve ser concluída sem novo login nem "MFA_REQUIRED"

  Scenario: [Sucesso] Desligar o gov.br recusa a entrada e remove o efeito sobre o MFA
    Given que "auth.govbrEnabled" está "true", "auth.govbrCountsAsMfa" está "GOLD" e há vínculos gov.br ativos
    When "Carla" desligar "auth.govbrEnabled"
    Then "Marta" deve receber "GOVBR_NOT_ENABLED" ao entrar com gov.br na "Prefeitura A"
    And uma sessão gov.br aberta de nível "GOLD" deve deixar de comprovar o segundo fator
    And os vínculos de identidade gov.br devem continuar guardados

  Scenario: [Sucesso] Política NONE guarda o valor sem efeito
    Given que a política "security.mfaPolicy" é "NONE"
    When "Carla" mudar "auth.govbrCountsAsMfa" para "GOLD"
    Then a tela deve avisar que a opção não tem efeito com a política desligada
    And a configuração deve ser salva

  Scenario: [Validação] Nível fora do enum
    When "Carla" enviar "auth.govbrCountsAsMfa" igual a "PLATINUM"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_ENUM"
    And nenhuma configuração do lote deve ser alterada

  Scenario: [Validação] Ligar sem credenciamento da plataforma
    Given que a plataforma não está credenciada no Login Único
    When "Carla" tentar ligar "auth.govbrEnabled"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"
    And o interruptor deve aparecer desabilitado com a orientação de falar com o suporte

  Scenario: [Validação] Chave desconhecida
    When "Carla" enviar a chave "auth.govbrRequired"
    Then a API deve responder 422 com código "SETTING_KEY_UNKNOWN"

  Scenario: [Permissão] Usuário sem SETTINGS_MANAGE
    Given que "Bruno" não possui "SETTINGS_MANAGE"
    When "Bruno" enviar PATCH para "/api/v1/settings" com "auth.govbrEnabled"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Permissão] Administrador só com gov.br contado como fator
    Given que "Carla" entrou com gov.br nível "GOLD", "auth.govbrCountsAsMfa" está "GOLD" e ela não tem segundo fator real
    When "Carla" tentar mudar "auth.govbrCountsAsMfa"
    Then a API deve responder 403 com código "MFA_REQUIRED"
    And depois do passo de confirmação de identidade a alteração deve poder ser repetida

  Scenario: [Tenant incorreto] A configuração de um órgão não vale em outro
    Given que "Marta" tem vínculo na "Prefeitura A" ("GOLD") e na "Prefeitura B" ("NEVER")
    And "Marta" entrou com gov.br nível "GOLD" na "Prefeitura A"
    When "Marta" trocar para a "Prefeitura B" e tentar uma ação que exige o segundo fator
    Then a API deve responder 403 com código "MFA_REQUIRED" na "Prefeitura B"

  Scenario: [Tenant incorreto] Administrador de outro órgão
    Given que "Diego" é administrador da "Prefeitura B"
    When "Diego" tentar alterar as configurações usando o tenant da "Prefeitura A"
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"
    And nenhum valor da "Prefeitura A" deve mudar

  Scenario: [Duplicidade] Reenvio do mesmo PATCH
    Given que "Carla" ligou "auth.govbrEnabled" e não recebeu a resposta
    When o front reenviar o mesmo PATCH com a versão esperada 1
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And a alteração deve constar uma única vez na auditoria

  Scenario: [Duplicidade] Valor igual ao atual
    When "Carla" enviar "auth.govbrCountsAsMfa" igual a "NEVER" informando a versão esperada 1
    Then a API deve responder 200 sem nova versão
    And não deve gerar auditoria "settings.update" nem o evento "TenantSettingsChanged"

  Scenario: [Concorrência] Duas alterações da mesma chave
    Given que "Carla" e "Diego" têm "SETTINGS_MANAGE" na "Prefeitura A"
    When os dois enviarem "auth.govbrEnabled" informando a versão 1 ao mesmo tempo
    Then apenas um deve ser aplicado, avançando para a versão 2
    And o outro deve responder 412 com código "VERSION_CONFLICT" e "currentVersion" igual a 2

  Scenario: [Concorrência] Alteração do nível durante uma ação de risco
    Given que "Marta" está executando uma ação "HIGH" com sessão gov.br nível "SILVER"
    When "Carla" mudar o nível aceito de "SILVER_OR_GOLD" para "GOLD" durante a requisição
    Then a requisição em curso deve ser decidida com uma única política, sem estado intermediário
    And a requisição seguinte de "Marta" deve exigir o segundo fator

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados está indisponível
    When "Carla" tentar salvar "auth.govbrEnabled"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma chave deve ser alterada e a tela deve manter o valor digitado

  Scenario: [Falha de integração] Outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" salvar "auth.govbrCountsAsMfa" igual a "GOLD"
    Then a configuração deve ser atualizada e a API deve responder 200
    And a réplica que gravou deve aplicar a regra nova na próxima requisição
    And as demais réplicas devem aplicá-la em até 60 segundos
    And o evento "TenantSettingsChanged" deve permanecer "PENDING" até o relay voltar

  Scenario: [Falha de integração] Estado da fonte indisponível
    Given que a leitura do estado da fonte falha
    When "Carla" abrir o grupo "Autenticação"
    Then o interruptor de gov.br deve aparecer desabilitado com "Não foi possível verificar a fonte agora."
    And a seleção do nível aceito deve continuar editável
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Valor fora do enum ou de tipo errado | 422 | `VALIDATION_ERROR` | "Escolha uma das opções." / "Valor inválido para auth.govbrEnabled." | Marca o campo |
| Fonte indisponível ao ligar | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "O login com gov.br ainda não está disponível nesta plataforma. Fale com o suporte." | Desabilita o interruptor |
| Chave fora do registro | 422 | `SETTING_KEY_UNKNOWN` | "Configuração desconhecida." | Recarrega as chaves |
| Versão esperada ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega `SET-01` |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Esta configuração foi alterada por outra pessoa." | Recarrega os valores |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar configurações." | Oculta "Salvar" e o grupo |
| Segundo fator real exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Abre o *step-up* e repete |
| Outro tenant | 403 | `MEMBERSHIP_INACTIVE` | "Seu acesso a esta instituição não está ativo." | Redireciona |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Mantém os valores digitados |

## Dependências
- **Stories:** US-090 (política de MFA, `amr`, *step-up*, cache `SettingsTenantMfaPolicy`), US-182 (entrada por gov.br, sessão com `govbrTrustLevel`, disponibilidade). Indiretas: US-103 (registro, `SET-01`/`SET-02`, seeder, `TenantSettingsChanged`), US-097 (`AuthorizationService`), US-183 (vínculo e desvinculação), US-092 (suspender e revogar vínculos), US-099 (provisionamento semeia as chaves).
- **Decisões/ADRs:** DEC-207, ADR-017, DEC-133, DEC-142, DEC-134, DEC-059, DEC-012; POL-14, POL-29. Dependência externa: credenciamento da plataforma no Login Único.
- **Configurações:** `auth.govbrEnabled`, `auth.govbrCountsAsMfa` (entities.md §8); lê `security.mfaPolicy`; ambiente `GOVBR_LOGIN_ENABLED` (US-182).
- **Lacunas nas fontes canônicas:**
  1. O tipo `SettingDefinition` e a lista de grupos de SCR-041 (US-103) não conhecem o prefixo `auth.*`: acrescentar o grupo "Autenticação" ao registro e à tela; as chaves já constam em entities.md §8 e epic-029.
  2. A decisão de MFA do `AuthorizationService` (DEC-142) e o `mfaVerified` de `ME-01` usam só o `amr`: precisam passar a ler `loginMethod`/`govbr_trust_level` (claims do Authentik, US-182) e as duas chaves; o `RequestContext` ganha o nível de confiança. Ajuste em US-090 e authentication.md §9.
  3. `GOV-09` (`GET /settings/govbr-status`) e a regra de que ligar o gov.br exige fonte disponível não constam das fontes; proposta desta story para a tela não oferecer um interruptor que não faz nada. Alternativa: aceitar o valor e mostrar "aguardando credenciamento".
  4. O nível de confiança do gov.br mede a conta, não os fatores do acesso (ver Contexto). A DEC-207 manda tratá-lo como segundo fator opcional; o desenho aqui limita o risco (padrão `NEVER`, aviso, confirmação, fator real para mudar a chave), mas a decisão de produto e segurança deve avaliar exigir também o `amr` do gov.br com dois fatores quando o Login Único o informar.
  5. Sobre um `PATCH` sem alteração efetiva a US-103 não diz se versiona, audita ou publica; adotado "não" para estas chaves (RN-PLAT-229); se valer para todas, ajustar a US-103.
  6. Dúvidas de produto: (1) aceitar o nível como segundo fator é uma escolha do órgão, mas rebaixa a proteção das ações sensíveis; (2) sessões gov.br abertas não são encerradas ao desligar a chave (RN-PLAT-223); (3) a lista de usuários vinculados fica fora da tela do administrador (RN-PLAT-233).

## Impacto técnico
- **Segurança:** a mudança mais sensível é `auth.govbrCountsAsMfa`: reduz a exigência de segundo fator. Por isso o padrão é `NEVER`, a tela confirma e avisa, a alteração exige fator real, o nível nunca vale se `auth.govbrEnabled` está desligado e a avaliação é por tenant ativo. `BRONZE`/ausente nunca valem.
- **Compatibilidade:** nenhuma rota nova de escrita e nenhuma mudança incompatível em `SET-01`/`SET-02`; tenants existentes ganham as chaves com o padrão (`false`/`NEVER`), sem mudança de comportamento. `GOV-09` é de leitura.
- **Performance:** a política de MFA continua em **uma** leitura de cache por tenant (60 s); a decisão adicional é comparação em memória de duas strings; sem custo novo por requisição.
- **Consistência:** a invalidação é local e imediata na réplica que gravou e por evento nas demais; a defasagem máxima é a do cache (60 s).
- **Migração:** nenhuma tabela nova; o seeder `tenancy.settings` aplica as duas linhas nos tenants existentes.

## Backend
- **Módulo(s):** `tenancy` (mecanismo genérico, seeder, `SettingsRegistry`), `identity` (dono das chaves `auth.*`, `SettingsTenantMfaPolicy` ampliado, `GetGovbrStatusQuery`), `access` (`AuthorizationService`/`MfaEvaluator`), `audit`.
- **Casos de uso:** `UpdateSettingsCommand` (US-103, com o *hook* de validação das duas chaves), `GetSettingsQuery`, `GetGovbrStatusQuery` (`GOV-09`).
- **Domínio:** definições `auth.govbrEnabled` e `auth.govbrCountsAsMfa` (schema Zod, padrão, grupo); `GovbrMfaPolicy.satisfiedBy(ctx, tenantAuth)` (função pura: `enabled`, `amr` com `govbr`, nível × configuração); regra de fator real para estas chaves (`RealMfaRequired`); validação "fonte disponível ao ligar".
- **Integrações internas:** `TenantSettingsChanged` (worker invalida `SettingsTenantMfaPolicy`), `FeatureFlag`/`GovbrSourceAvailability` (a mesma conta de `GOV-01`), `AuditService`, outbox.
- **Transação:** a de `UpdateSettingsCommand` (validação do lote, gravação das chaves, auditoria e outbox juntos, com `app.tenant_id`); o cache é apagado após o commit.

## Frontend
- **Tela(s):** SCR-041 (`/admin/configuracoes`), grupo "Autenticação" (novo).
- **Componentes:** `SettingsGroupTabs` (aba nova), `SettingField` (interruptor e seleção), `GovbrSourceStatus` (texto de estado da fonte), `MfaPolicyNotice` (aviso quando a política é `NONE`), `ConfirmDialog` (confirmação ao elevar o nível), `SaveBar`.
- **Estados:** *skeleton* por grupo; interruptor desabilitado sem fonte (com texto); salvando; erro com "Tentar novamente" mantendo os valores; aviso não bloqueante para política `NONE`.
- **Acessibilidade e responsividade:** cada campo com rótulo e descrição por `aria-describedby`; o aviso sobre o significado dos níveis em texto, não em ícone; interruptor com `aria-checked`; foco volta ao campo após o erro; abas em menu suspenso abaixo de 768 px; testado com axe.

## Banco de dados
- **Tabelas:** `tenant_settings` (duas chaves novas por tenant, sem tabela nova).
- **Migrações:** nenhuma de esquema; o seeder `tenancy.settings` grava `auth.govbrEnabled = false` e `auth.govbrCountsAsMfa = "NEVER"` em tenants novos e existentes (`applyToExistingTenants`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, key)` (US-103); sem índice novo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `SET-01` (ext.) | GET | `/settings` | — | `200 { data: { "<chave>": { value, version } } }`, agora com `auth.govbrEnabled` e `auth.govbrCountsAsMfa` | 200, 403 |
| `SET-02` (ext.) | PATCH | `/settings` | `{ values: { "auth.govbrEnabled"?, "auth.govbrCountsAsMfa"? }, expectedVersions }` | `200 { data: { "<chave>": { value, version } } }` (só as alteradas) | 200, 403 (`PERMISSION_DENIED`, `MFA_REQUIRED`), 412, 422, 428, 503 |
| `GOV-09` | GET | `/settings/govbr-status` | — | `200 { data: { sourceAvailable } }` | 200, 403, 503 |

## Logs
- `info` `settings.updated` — `keys[]` (inclui `auth.govbrEnabled`/`auth.govbrCountsAsMfa`), `tenantId`, `userId`, `correlationId` (valores não vão ao log).
- `info` `identity.mfa_policy_cache_invalidated` — `tenantId`, `source` (`COMMIT` ou `EVENT`).
- `warn` `settings.unknown_key_rejected`; `warn` `settings.govbr_source_unavailable` (tentativa de ligar sem fonte).
- `error` `settings.save_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** claims do token, `amr` completo, CPF ou qualquer dado de identidade gov.br; o nível de confiança só como enum agregado em métrica (`mfa_decisions_total{viaGovbr,level}`).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `settings.update` | `CONFIGURATION` | Commit do `PATCH`, uma entrada por chave alterada | `changes`: valor anterior/novo; `metadata`: `key`, `group = auth` |
| `access.denied` | `ACCESS` | Tentativa sem `SETTINGS_MANAGE` | `reasonCode = SETTINGS_MANAGE` |
| `auth.mfa_required` | `SECURITY` | Recusa por falta de segundo fator (MVP 1) | `metadata` ganha `govbrTrustLevel` quando a sessão é gov.br |

## Testes necessários
- **Unitários:** `GovbrMfaPolicy` (tabela: chave × nível × `govbrEnabled` × origem do login × `amr` real; `BRONZE` e ausente nunca); schemas das duas chaves; regra de fator real nas duas chaves; "ligar exige fonte".
- **Integração (Testcontainers):** `PATCH` em lote tudo-ou-nada com as novas chaves; seeder idempotente em tenants existentes; invalidação do cache por commit e por `TenantSettingsChanged`; sessão aberta avaliada pela política nova na próxima requisição; `SET-03` sem `auth.*`.
- **API/contrato:** `SET-01`, `SET-02`, `GOV-09`; códigos de erro; `ME-01.mfaVerified` por tenant.
- **RBAC e multi-tenant:** com e sem `SETTINGS_MANAGE`; gov.br como fator **não** vale para alterar as chaves; a mesma sessão em dois tenants com configurações diferentes; RLS entre tenants (suíte `test/tenant-leak`).
- **Concorrência:** duas alterações da mesma chave; mudança do nível durante ação `HIGH`; réplicas com cache de idades diferentes (≤ 60 s).
- **E2E (Playwright, IdP federado simulado):** ligar o gov.br e ver o botão em `/entrar`; sessão gov.br prata faz ação `HIGH` sem *step-up* com `SILVER_OR_GOLD` e com *step-up* com `GOLD`; desligar e ver `GOVBR_NOT_ENABLED`.
- **Acessibilidade/performance:** axe no grupo "Autenticação"; `GET /settings` com as chaves novas p95 < 200 ms (como na US-103).

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
- [ ] Tabela de decisão de `GovbrMfaPolicy` coberta (níveis × chave × política) e `BRONZE`/ausente nunca comprovam o fator
- [ ] Teste de que o gov.br contado como segundo fator não autoriza alterar as duas chaves
- [ ] Teste de invalidação do cache (commit e evento) e de `SET-03` sem chaves `auth.*`

## Estimativa
**S** — duas chaves no registro que a US-103 já oferece, um grupo e dois campos na tela, `GOV-09` e a ampliação do cache e da decisão de MFA já existentes; o custo está na tabela de decisão, na regra de fator real e nos testes de propagação, não em estrutura nova.

## Prioridade
**P1** — sem a habilitação por órgão o botão e a entrada por gov.br não existem (padrão `false`); é critério de saída do MVP 2 junto das US-182 e US-183, mas o login por usuário e senha segue como caminho principal enquanto o credenciamento não chega.
