---
id: US-116
title: "Configurar a IA no órgão: ativação, limites e consumo"
epic: EP-020
feature: FT-060
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-094, US-103, US-111, US-115]
modules: [ai, tenancy, access, notification, audit, platform]
screens: [SCR-041]
endpoints: [AI-05, AI-06, SET-01, SET-02, SET-03]
permissions: [AI_GENERATE, SETTINGS_MANAGE]
events: [TenantSettingsChanged, AiUsageThresholdReached]
---

# US-116 — Configurar a IA no órgão: ativação, limites e consumo

## Título
Configurar a IA no órgão: ativação, limites e consumo

## Descrição
**Como** administrador do órgão, **quero** ligar ou desligar a IA, aceitar os termos de uso, definir limites de consumo e acompanhar quanto foi usado, **para** adotar a geração assistida de documentos com controle, previsibilidade de custo e conformidade com a LGPD.

A IA é opt-in: nasce desligada em todo órgão. Esta story entrega a seção "Inteligência artificial" em Configurações gerais (SCR-041) com as chaves `ai.*`, o aceite dos termos de uso, o limite mensal de tokens (com reserva por pedido) e o limite diário de pedidos por usuário, a permissão `AI_GENERATE` no catálogo e nos perfis semeados, a política POL-18 completa (`AI-05` informa se o usuário pode gerar; `AI-06` mostra o consumo) e o aviso de 80% e 100% do limite mensal. Implementa o portão do órgão (`AiTenantGate`) que a US-115 deixa como porta obrigatória.

## Contexto
- DEC-037 e DEC-079: a IA é governada pelo órgão — liga/desliga a qualquer momento, com limite de uso. PEND-22: padrão adotado é limite técnico de tokens por órgão, sem cobrança; o custo (`costUsd`) é só registrado, por geração.
- LGPD (DEC-140): o provedor é subprocessador; os termos informam finalidade, provedor, dados enviados, transferência internacional, não uso para treinamento e responsabilidade humana pelo conteúdo. A versão aceita fica registrada (`ai.termsAcceptedVersion`).
- Configurações do tenant seguem o registro de US-103 (SET-01/02/03, `SETTINGS_MANAGE`, risco `H`, POL-14); a matriz de perfis é editável em US-095, e o catálogo/perfis padrão nascem em US-094.

## Objetivo
Nenhum órgão usa IA sem decisão explícita e aceite dos termos; todo pedido respeita limites previsíveis; o administrador enxerga consumo (tokens e custo) por tipo de documento, tipo de geração e usuário, e é avisado antes de esgotar o limite.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, com `SETTINGS_MANAGE`).
- **Secundárias:** usuários com `AI_GENERATE` — `GESTOR_CONTRATACOES`, `REQUISITANTE`, `PLANEJAMENTO`, `COMPRAS`, `GESTOR_CONTRATO` — que veem a disponibilidade e o motivo quando bloqueada; encarregado de dados do órgão como leitor dos termos (sem perfil próprio).

## Pré-condições
- Usuário autenticado com vínculo ativo e `SETTINGS_MANAGE` (MFA válido, POL-14) para configurar e consultar consumo; qualquer usuário autenticado para `AI-05`.
- Catálogo de permissões com 69 itens, incluindo `AI_GENERATE` (RN-AI-21).
- Camada de IA da US-115 disponível (`AiGeneration`, `AiTenantGate` como porta).
- `AI_TERMS_VERSION` e `AI_TENANT_MAX_MONTHLY_TOKENS` definidos na plataforma.

## Fluxo principal
1. Na SCR-041, o administrador abre a seção **"Inteligência artificial"**; o front carrega `SET-01` e `AI-06` (mês atual).
2. Aciona o interruptor **"Usar IA neste órgão"**; o `AiTermsDialog` exibe os termos da versão vigente e o campo "Li e aceito".
3. Ao confirmar, o front envia `SET-02` com `ai.enabled = true` e `ai.termsAcceptedVersion` igual à versão vigente.
4. A API valida MFA, faixas e aceite (RN-AI-16), grava as chaves, audita `settings.update`, grava `TenantSettingsChanged` no outbox e invalida o cache de configurações (RN-AI-24); responde 200.
5. O administrador ajusta o **limite mensal de tokens** e o **limite diário de pedidos por usuário** (`SET-02`).
6. A partir daí, `AI-05` devolve `canGenerate = true` para quem tem `AI_GENERATE`; os botões "Gerar com IA" (SCR-117) são habilitados.
7. A cada pedido (`AI-01`), o portão do órgão confere flag e limites sob trava por tenant e reserva a estimativa do alvo (RN-AI-18/19); ao terminar a geração, o consumo real substitui a reserva.
8. Ao cruzar 80% e 100% do limite mensal, o sistema publica `AiUsageThresholdReached` e notifica quem tem `SETTINGS_MANAGE` (RN-AI-20).
9. No `AiUsageCard`, o administrador acompanha o consumo do mês (e de meses anteriores) por tipo de documento, tipo de geração e usuário, e abre a auditoria filtrada por `ai.*`.

## Fluxos alternativos
- **FA-01 — Ligar sem aceitar os termos:** o botão "Ativar" fica desabilitado até o aceite; a API recusa com 422 `AI_TERMS_NOT_ACCEPTED`.
- **FA-02 — Nova versão dos termos:** quando `AI_TERMS_VERSION` muda, um aviso convida a aceitar a nova versão; a IA já ligada continua ligada, mas religar exige o aceite da versão vigente.
- **FA-03 — Provedor indisponível na plataforma:** `AI_PROVIDER=none` ou circuito aberto; a seção mostra o aviso e `AI-05` devolve `AI_PROVIDER_UNAVAILABLE`; a configuração continua possível.
- **FA-04 — Limite abaixo do consumo atual:** permitido (mínimo 50.000); novos pedidos recebem `AI_USAGE_LIMIT_REACHED` até o próximo mês ou novo aumento; o formulário avisa antes de salvar.
- **FA-05 — Usuário sem permissão:** `AI-05` devolve `PERMISSION_DENIED`; o botão aparece desabilitado com "Peça ao administrador do órgão" (ação oculta se o usuário não tem `AI_GENERATE` em nenhum escopo).
- **FA-06 — Limite diário atingido:** o botão fica desabilitado com "Limite diário de pedidos atingido; volta amanhã".

## Regras de negócio
- **RN-AI-16** — `ai.enabled` (padrão `false`, opt-in do órgão): só quem tem `SETTINGS_MANAGE` liga/desliga (SET-02, MFA conforme POL-14); ligar exige `ai.termsAcceptedVersion` igual a `AI_TERMS_VERSION` na mesma requisição ou já gravada; senão 422 `AI_TERMS_NOT_ACCEPTED`.
- **RN-AI-17** — Desligar: novas solicitações → 403 `AI_DISABLED`; gerações `QUEUED` são canceladas pelo worker ao saírem da fila (`CANCELED`/`CANCELED_BY_POLICY`); propostas `SUCCEEDED` ainda podem ser aplicadas ou descartadas (não há nova chamada ao provedor).
- **RN-AI-18** — Limite mensal `ai.monthlyTokenLimit` (mês civil no fuso do tenant): na solicitação reserva-se a estimativa do alvo (DFD 15 mil, ETP 40 mil, mapa de riscos 25 mil, TR 40 mil, ajuste de seção 6 mil tokens → `reservedTokens`); `consumido + reservado ativo + estimativa > limite` → 422 `AI_USAGE_LIMIT_REACHED`. O consumo real substitui a reserva ao terminar (pode ultrapassar o limite em até uma geração).
- **RN-AI-19** — Limite diário por usuário `ai.userDailyRequestLimit` (dia civil no fuso do tenant; gerações canceladas antes de rodar não contam) → 422 `AI_USER_DAILY_LIMIT_REACHED`. As verificações de limite são serializadas por tenant (`pg_advisory_xact_lock`).
- **RN-AI-20** — Ao cruzar 80% e 100% do limite mensal, uma vez por mês e faixa, evento `AiUsageThresholdReached` → notificação `AI_USAGE_LIMIT_WARNING` (in-app + e-mail) a quem tem `SETTINGS_MANAGE`.
- **RN-AI-21** — `AI_GENERATE` semeada nos perfis `GESTOR_CONTRATACOES`, `REQUISITANTE`, `PLANEJAMENTO`, `COMPRAS` e `GESTOR_CONTRATO`; fora da participação e de `CONSULTOR_EXTERNO`; ajustável na matriz (US-095). Catálogo de permissões passa a 69 (`packages/types/src/permissions.ts`, `introducedIn` = MVP 1 / prd-3).
- **RN-AI-22** — POL-18 avaliada em `AI-01` e revalidada no worker antes da chamada (permissão, flag e limites); falhou → `CANCELED`/`CANCELED_BY_POLICY` sem chamar o provedor e sem consumir reserva.
- **RN-AI-23** — `AI-05` informa a qualquer usuário autenticado se pode gerar no contexto (`canGenerate`, `reasons[]`, percentual do mês, uso diário próprio); `AI-06` (consumo com tokens e custo por tipo de documento, tipo de geração e usuário) exige `SETTINGS_MANAGE`.
- **RN-AI-24** — Toda alteração de `ai.*` é auditada como `settings.update` (chaves; a versão dos termos aceita fica em `changes`) e publica `TenantSettingsChanged`; o `FeatureFlagService`/cache de configurações é invalidado.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Usar IA neste órgão | `ai.enabled` | boolean | Sim | ligar exige aceite da versão vigente (RN-AI-16) | `false` |
| Termos aceitos | `ai.termsAcceptedVersion` | string \| null | Condicional | igual a `AI_TERMS_VERSION` para ligar | `null` |
| Limite mensal de tokens | `ai.monthlyTokenLimit` | int | Sim | 50.000 a `AI_TENANT_MAX_MONTHLY_TOKENS` | `2.000.000` (máx. de plataforma padrão: 20.000.000) |
| Pedidos por usuário por dia | `ai.userDailyRequestLimit` | int | Sim | 1 a 500 | `40` |
| Mês de consumo | `month` (`AI-06`) | `YYYY-MM` | Não | não pode ser futuro | mês corrente |
| *(sistema)* Versão vigente dos termos | `AI_TERMS_VERSION` | string | — | somente leitura | plataforma |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Ligar sem a versão vigente dos termos | Front + API | "Aceite os termos de uso da versão atual para ativar a IA." | `AI_TERMS_NOT_ACCEPTED` |
| V-02 | `ai.monthlyTokenLimit` fora de 50.000..máximo da plataforma | Front + API (Zod) | "Informe um limite entre 50.000 e {máximo} tokens." | `VALIDATION_ERROR` |
| V-03 | `ai.userDailyRequestLimit` fora de 1..500 | Front + API (Zod) | "Informe de 1 a 500 pedidos por dia." | `VALIDATION_ERROR` |
| V-04 | `month` fora do formato `YYYY-MM` ou no futuro | Front + API (Zod) | "Escolha um mês válido." | `VALIDATION_ERROR` |
| V-05 | Limite mensal excedido pela estimativa | API | "O limite mensal de uso de IA foi atingido." | `AI_USAGE_LIMIT_REACHED` |
| V-06 | Limite diário do usuário atingido | API | "Você atingiu o limite diário de pedidos de IA." | `AI_USER_DAILY_LIMIT_REACHED` |

## Permissões
- **Permissão:** `SETTINGS_MANAGE` (risco `H`) para `SET-01`/`SET-02` das chaves `ai.*` e para `AI-06`; `AI-05` é capacidade implícita (vínculo ativo); `AI_GENERATE` (risco `M`, escopável) é o que habilita gerar e entra no catálogo e nos perfis semeados.
- **Políticas:** POL-14 (MFA para `SETTINGS_MANAGE`); POL-18 (`AI_GENERATE` cobrindo o processo + permissão de edição do tipo do documento alvo + POL-02 + `ai.enabled = true` + provedor disponível + limites do órgão e do usuário), avaliada em `AI-01`, no worker e (como indicação) em `AI-05`.
- **MFA:** exigido para alterar `ai.*` (403 `MFA_REQUIRED` sem verificação recente); não exigido para `AI-05`.
- **Sem permissão:** a seção não é exibida sem `SETTINGS_MANAGE`; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`. `ADMIN_ORGAO` não recebe `AI_GENERATE` por padrão (ajustável na matriz).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantSettingsChanged` | `tenant.settings_changed` | Commit de `SET-02` com chaves `ai.*` | `keys[]`; invalida o cache de configurações |
| `AiUsageThresholdReached` | `ai.usage_threshold_reached` | Commit do término da geração que faz o consumo atingir 80% ou 100% do limite mensal | `month`, `threshold` (`80`/`100`), `usedTokens`, `limitTokens`; uma vez por `(tenant, mês, faixa)` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_USAGE_LIMIT_WARNING` | Vínculos ativos com `SETTINGS_MANAGE` (máx. 50) | In-app + e-mail; não obrigatória | `AiUsageThresholdReached` (80% e 100%); texto com mês, faixa e link para a SCR-041; sem dados pessoais |

## Critérios de aceite em Gherkin
```gherkin
Feature: Configurar a IA no órgão: ativação, limites e consumo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com o provedor de IA de teste (FakeAiProvider) e "AI_TERMS_VERSION" igual a "2026-10"
    And "ai.enabled" está "false" e "ai.monthlyTokenLimit" é 50000
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO", "SETTINGS_MANAGE" e MFA válido
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO" e custódia do DFD do processo "0012/2026"

  Scenario: [Sucesso] Ligar a IA aceitando os termos
    When "Marina" enviar SET-02 com "ai.enabled" "true" e "ai.termsAcceptedVersion" "2026-10"
    Then a API deve responder 200 e "ai.enabled" deve ser "true"
    And deve gerar registro de auditoria "settings.update" com a versão "2026-10" em "changes"
    And deve gerar o evento "TenantSettingsChanged" com as chaves alteradas
    And AI-05 para "Carla" deve responder "canGenerate" "true" imediatamente

  Scenario: [Sucesso] Reserva de tokens e bloqueio pelo limite mensal
    Given que a IA está ligada e o consumo real do mês é 20000 tokens
    When "Carla" solicitar o rascunho do DFD
    Then a API deve responder 202 e a geração deve ter "reservedTokens" igual a 15000
    When "Carla" solicitar o rascunho do ETP com 40000 tokens estimados
    Then a API deve responder 422 com código "AI_USAGE_LIMIT_REACHED"
    And nenhuma geração deve ser criada
    When o provedor de IA de teste concluir a geração do DFD com 12400 tokens
    Then o consumo do mês deve ser 32400 e a reserva ativa deve ser 0

  Scenario: [Sucesso] Aviso em 80% e em 100% do limite
    Given que o consumo do mês é 39000 de 50000 tokens
    When uma geração terminar e o consumo chegar a 41000
    Then deve gerar o evento "AiUsageThresholdReached" com "threshold" 80
    And "Marina" deve receber "AI_USAGE_LIMIT_WARNING" no app e por e-mail
    When outra geração levar o consumo a 50500
    Then deve gerar o evento com "threshold" 100

  Scenario: [Sucesso] Consultar disponibilidade e consumo
    When "Carla" consultar AI-05 e "Marina" consultar AI-06 do mês corrente
    Then AI-05 não deve trazer tokens absolutos para "Carla" e deve trazer o percentual do mês e o uso diário
    And AI-06 deve trazer tokens, custo e a divisão por tipo de documento, tipo de geração e usuário

  Scenario: [Sucesso] Desligar a IA preserva as propostas prontas
    Given que existe uma geração "QUEUED" e uma proposta "SUCCEEDED" de "Carla"
    When "Marina" desligar "ai.enabled"
    Then uma nova solicitação de "Carla" deve receber 403 com código "AI_DISABLED"
    And o worker deve cancelar a geração "QUEUED" com "errorCode" "CANCELED_BY_POLICY" sem chamar o provedor
    And "Carla" ainda deve poder descartar ou aplicar a proposta "SUCCEEDED"

  Scenario: [Validação] Ligar sem aceitar os termos
    When "Marina" enviar SET-02 com "ai.enabled" "true" sem "ai.termsAcceptedVersion"
    Then a API deve responder 422 com código "AI_TERMS_NOT_ACCEPTED"
    And "ai.enabled" deve permanecer "false"

  Scenario: [Validação] Limites fora da faixa
    When "Marina" enviar "ai.monthlyTokenLimit" 49999, depois acima do máximo de plataforma, e "ai.userDailyRequestLimit" 0 e 501
    Then a API deve responder 422 com código "VALIDATION_ERROR" em cada campo

  Scenario: [Validação] Limite diário por usuário no dia civil do tenant
    Given que "Carla" já fez 40 pedidos no dia, dos quais 2 foram cancelados antes de rodar
    When "Carla" solicitar mais um pedido
    Then a API deve responder 202
    When "Carla" fizer o 41º pedido contado
    Then a API deve responder 422 com código "AI_USER_DAILY_LIMIT_REACHED"

  Scenario: [Permissão] Sem SETTINGS_MANAGE ou sem MFA
    Given que "Bruno" não possui "SETTINGS_MANAGE"
    When "Bruno" enviar SET-02 com "ai.enabled" ou consultar AI-06
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Marina" alterar "ai.enabled" sem MFA recente
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Permissão] AI_GENERATE nos perfis semeados
    Then os perfis "GESTOR_CONTRATACOES", "REQUISITANTE", "PLANEJAMENTO", "COMPRAS" e "GESTOR_CONTRATO" devem ter "AI_GENERATE"
    And "CONSULTOR_EXTERNO" e uma pessoa com participação "COLLABORATOR" sem a permissão devem receber 403 em AI-01
    And o catálogo deve ter 69 permissões

  Scenario: [Tenant incorreto] Consumo e disponibilidade isolados
    Given que o tenant "Prefeitura B" tem 80 gerações no mês
    When "Marina" consultar AI-06 e "Carla" consultar AI-05 com o processo de "Prefeitura B"
    Then AI-06 deve contar somente as gerações de "Prefeitura de São José"
    And AI-05 deve responder 404 com código "NOT_FOUND"
    And o aviso de limite não deve chegar a pessoas de outro tenant

  Scenario: [Duplicidade] Aviso de limiar não repetido no mês
    Given que o aviso de 80% do mês já foi publicado
    When outra geração terminar com o consumo ainda acima de 80%
    Then não deve haver novo evento "AiUsageThresholdReached" com "threshold" 80 no mês

  Scenario: [Concorrência] Dois pedidos disputando os últimos tokens
    Given que restam 20000 tokens no limite mensal
    When "Carla" e outro redator enviarem AI-01 de DFD (15000 tokens) ao mesmo tempo
    Then exatamente um deve receber 202 e o outro 422 com código "AI_USAGE_LIMIT_REACHED"

  Scenario: [Concorrência] Dois administradores alteram o limite
    Given que "Marina" e outra pessoa carregaram a configuração na mesma versão
    When ambas salvarem "ai.monthlyTokenLimit" com valores diferentes
    Then a segunda deve receber 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados fica indisponível durante a transação de SET-02
    When "Marina" tentar ligar a IA
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And "ai.enabled" não deve ser alterado nem auditado

  Scenario: [Falha de integração] Relay do outbox ou SMTP indisponível no aviso
    Given que o relay do outbox está indisponível quando o consumo cruza 80%
    Then a geração deve ficar "SUCCEEDED" e o evento "AiUsageThresholdReached" deve permanecer "PENDING" até o relay voltar
    Given que o SMTP está indisponível
    Then a notificação in-app deve ser criada e o e-mail deve ser reenviado pela fila "email"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem `SETTINGS_MANAGE` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para configurar a IA." | Seção oculta; API bloqueia |
| MFA ausente | 403 | `MFA_REQUIRED` | "Confirme sua identidade para alterar esta configuração." | Abre a verificação |
| Termos não aceitos | 422 | `AI_TERMS_NOT_ACCEPTED` | "Aceite os termos de uso da versão atual para ativar a IA." | Reabre o `AiTermsDialog` |
| Valor fora da faixa | 422 | `VALIDATION_ERROR` | "Informe um valor dentro da faixa permitida." | Marca o campo |
| IA desligada | 403 | `AI_DISABLED` | "A IA está desligada neste órgão." | Botão desabilitado com explicação |
| Limite mensal | 422 | `AI_USAGE_LIMIT_REACHED` | "O limite mensal de uso de IA foi atingido." | Botão desabilitado; sugere falar com o administrador |
| Limite diário | 422 | `AI_USER_DAILY_LIMIT_REACHED` | "Você atingiu o limite diário de pedidos de IA." | Botão desabilitado até o dia seguinte |
| Versão divergente | 412 | `VERSION_CONFLICT` | "A configuração foi alterada por outra pessoa. Recarregue." | Recarrega os valores |
| Processo ou tenant inexistente (`AI-05`) | 404 | `NOT_FOUND` | "Processo não encontrado." | Trata como indisponível |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Mantém os valores digitados |

## Dependências
- **Stories:** US-115 (`AiGeneration`, porta `AiTenantGate`, worker), US-103 (registro de configurações, SET-01/02/03, cache), US-094 (catálogo e perfis padrão), US-111 (central de notificações e tipos). Indiretas: US-095 (matriz de permissões), US-097. Habilita: US-117 a US-121 (disponibilidade e limites antes de gerar).
- **Decisões/ADRs:** DEC-037, DEC-076, DEC-079, DEC-140, DEC-164; ADR-013 (PEND-21); PEND-22 (modelo de custo e limites padrão); POL-14, POL-18.
- **Configurações:** `ai.enabled`, `ai.termsAcceptedVersion`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit` (por tenant, nenhuma pública); `AI_TENANT_MAX_MONTHLY_TOKENS`, `AI_TERMS_VERSION` (plataforma).
- **Lacunas nas fontes canônicas:**
  1. *(Resolvida na DEC-079 e em api/14-tenant-administration.md, 2026-10-16.)* SET-01 devolve `meta.aiTerms = { currentVersion, provider }`; o texto dos termos fica versionado no repositório com `AI_TERMS_VERSION`.
  2. *(Resolvida na DEC-079.)* Tabela de reserva registrada (DFD 15 mil, ETP 40 mil, mapa de riscos 25 mil, TR 40 mil, ajuste 6 mil).
  3. *(Resolvida na DEC-079.)* `AiUsageThresholdReached` com `eventId` determinístico (UUID v5 de tenant + mês + faixa), outbox com `ON CONFLICT DO NOTHING` sob a trava do tenant e unicidade de `notifications` por `source_event_id`.
  4. *(Resolvida na DEC-079.)* Consumo atribuído ao mês do `createdAt` no fuso do tenant; limite reduzido abaixo do consumo bloqueia só novos pedidos.
  5. *(Implementação, 2026-10-17.)* O envelope de eventos (DEC-160) exige UUIDv7: o `eventId` determinístico do `AiUsageThresholdReached` é um UUIDv7 com o instante do início do mês e o hash de `(tenant, mês, faixa)` (`naturalKeyId`), gravado com `OutboxWriter.recordOnce` (`ON CONFLICT (id) DO NOTHING`), em vez de UUID v5. `meta.aiTerms` do SET-01 traz também `maxMonthlyTokens` (teto da plataforma, para a mensagem e a validação no front). O link "auditoria filtrada por `ai.*`" aponta para `/auditoria?action=ai.*`; o filtro por ação entra com a lista de registros da SCR de auditoria. O cache de configurações não precisa de invalidação explícita: o portão lê `ai.*` no `tx` (`TenancyFacade.settingValues`, sem cache).

## Impacto técnico
- A reserva é derivada, sem contador: `reservado ativo` = soma de `reservedTokens` das gerações `QUEUED`/`RUNNING` do mês; o consumo é a soma de `totalTokens` das demais. Não há deriva a corrigir; o índice `(tenant_id, created_at)` sustenta as somas.
- A trava `pg_advisory_xact_lock` por tenant cobre só a verificação + inserção do `AI-01` (transação curta, DEC-079); `AI-05` não trava e é indicativo — `AI-01` é a decisão final.
- Revalidação no worker: flag, permissão do solicitante (`AI_GENERATE` + permissão do tipo), consumo real já esgotado (≥ limite) e contagem diária sem a própria geração; falhou → `CANCELED_BY_POLICY` sem consumir reserva.
- Cache de configurações invalidado no commit de `SET-02`; com Redis fora, a leitura cai no banco (`TenancyFacade.getSetting`). `ai.*` nunca aparece em `SET-03`.

## Backend
- **Módulo(s):** `ai` (dono do portão, de `AI-05`/`AI-06` e do limiar), `tenancy` (registro de chaves `ai.*`, `FeatureFlagService`), `access` (catálogo, perfis semeados, POL-18), `notification`, `audit`, `platform`.
- **Casos de uso:** `GetAiAvailabilityQuery` (`AI-05`); `GetAiUsageQuery` (`AI-06`); `AiTenantGateImpl` (`check`/`reserve`/`revalidate`); `PublishAiUsageThresholdHandler` (no término da geração); `AiUsageLimitWarningHandler` (notificação); extensão de `UpdateSettingsCommand` (`SET-02`) com o validador das chaves `ai.*`.
- **Domínio:** `AiGenerationPolicy` (POL-18: combina `AuthorizationService`, flag, provedor e limites e devolve `reasons[]`, reutilizada por `AI-01`, worker e `AI-05`); `AiUsageCalculator` (mês e dia civis no fuso do tenant); tabela de estimativas por alvo.
- **Integrações internas:** `TenancyFacade.getSetting`; `AuthorizationService`; `MembershipFacade` (destinatários com `SETTINGS_MANAGE`); `AuditService.record`; `OutboxWriter`.
- **Transação:** `SET-02`: validação + gravação + auditoria + outbox em uma transação, cache invalidado após o commit. `AI-01`: trava por tenant + verificação + inserção `QUEUED` com `reservedTokens` (compartilha a transação da US-115). Término da geração: gravação do consumo + checagem de limiar + outbox na transação do resultado.

## Frontend
- **Tela(s):** SCR-041 (`/admin/configuracoes`), seção "Inteligência artificial"; estados dos botões em SCR-117 e nos editores (SCR-007, SCR-008, SCR-011, SCR-012).
- **Componentes:** `AiSettingsSection` (interruptor, campos de limite, aviso de versão dos termos, aviso de provedor indisponível), `AiTermsDialog`, `AiUsageCard` (seletor de mês, barra de uso com percentual em texto, custo, tabelas por tipo de documento, tipo de geração e usuário, link para a auditoria filtrada por `ai.*`), hook `useAiAvailability` (`AI-05`) que mapeia `reasons[]` para mensagens.
- **Estados:** carregando (skeleton); vazio ("Nenhuma geração neste mês"); erro (falha de carga com "Tentar novamente"); sucesso (toast "Configuração salva"); confirmação ao desligar.
- **Acessibilidade e responsividade:** interruptor com `role="switch"` e rótulo; diálogo com foco preso e fechável por teclado; barra de uso com texto alternativo ("45% do limite usado"), sem depender só de cor; tabelas viram listas em telas abaixo de 768 px.

## Banco de dados
- **Tabelas:** `tenant_settings` (quatro chaves `ai.*`), `permissions` e `role_permissions` (seed de `AI_GENERATE`), leitura de `ai_generations`, `audit_logs`, `outbox_events`, `notifications`.
- **Migrações:** seed idempotente de `AI_GENERATE` no catálogo e nos perfis do sistema (novos e existentes); sem alteração de esquema.
- **Índices/constraints relevantes:** reaproveita `(tenant_id, created_at)`, `(tenant_id, created_by_id, created_at)` e `(tenant_id, status, expires_at)` de `ai_generations`; unicidade do aviso por `(tenant, mês, faixa)` conforme a lacuna 3.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-05` | GET | `/ai/availability?processId=&documentId=` | — | `200 { data: { enabled, providerAvailable, canGenerate, reasons: ['AI_DISABLED'\|'AI_PROVIDER_UNAVAILABLE'\|'AI_USAGE_LIMIT_REACHED'\|'AI_USER_DAILY_LIMIT_REACHED'\|'PERMISSION_DENIED'\|'DOCUMENT_NOT_EDITABLE'], monthly: { percentUsed }, userDaily: { used, limit } } }` (tokens absolutos só para `SETTINGS_MANAGE`) | 200, 401, 404 |
| `AI-06` | GET | `/ai/usage?month=YYYY-MM` | — | `200 { data: { month, limitTokens, usedTokens, reservedTokens, costUsd, generations: { total, byStatus }, byDocumentType, byKind, byUser: [{ userId, name, generations, totalTokens }] } }` | 200, 401, 403, 422 |
| `SET-01` | GET | `/settings` | — | chaves `ai.*` incluídas para `SETTINGS_MANAGE` | 200, 403 |
| `SET-02` | PATCH | `/settings` | `{ "ai.enabled": true, "ai.termsAcceptedVersion": "2026-10", "ai.monthlyTokenLimit": 2000000, "ai.userDailyRequestLimit": 40 }` + `If-Match` por chave | `200` com as chaves atualizadas | 200, 403, 412, 422, 428, 503 |
| `SET-03` | GET | `/settings/public` | — | nunca devolve `ai.*` | 200 |

## Logs
- `info` `ai.settings_changed` — `keys`, `actorId`, `termsVersion`; `ai.usage_threshold_reached` — `month`, `threshold`, `usedTokens`, `limitTokens`.
- `info` `ai.generation_policy_canceled` — `generationId`, motivo (`AI_DISABLED`, `PERMISSION_DENIED`, `AI_USAGE_LIMIT_REACHED`, `AI_USER_DAILY_LIMIT_REACHED`).
- `warn` `ai.limit_overshoot` — consumo acima do limite por uma geração; `idempotency.store_unavailable`.
- **Nunca logar:** resumo, instrução, contexto ou saída das gerações; nomes de usuários nos agregados; texto dos termos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `settings.update` | `CONFIGURATION` | Commit de `SET-02` com `ai.*` | `changes`: chave → antes/depois (para os termos, a versão aceita); `metadata`: `keys` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = SETTINGS_MANAGE` |

## Testes necessários
- **Unitários:** `AiGenerationPolicy` (cada `reason`); aritmética de reserva e consumo; limites de mês e dia civis em fusos distintos; detecção de limiar (80/100, uma vez por faixa); regra dos termos; validadores de faixa.
- **Integração (Testcontainers PostgreSQL + Redis):** `pg_advisory_xact_lock` serializando `AI-01`; reserva derivada; cancelamento por política no worker; seed de `AI_GENERATE` (novo tenant e tenant existente); `AI-06` agregado; notificação a no máximo 50 destinatários; invalidação de cache; RLS.
- **API/contrato:** `AI-05`, `AI-06`, `SET-01`/`SET-02`/`SET-03` conforme api.md; `ai.*` ausente em `SET-03`; `AI-05` coerente com `AI-01` (`canGenerate = true` não é recusado por política).
- **RBAC e multi-tenant:** `AI_GENERATE` por perfil semeado, participação e `CONSULTOR_EXTERNO`; `SETTINGS_MANAGE` + MFA; teste novo na suíte `test/tenant-leak` (consumo, disponibilidade e aviso de outro tenant).
- **Concorrência:** pedidos simultâneos nos últimos tokens; duas alterações de limite com `If-Match`; desligar durante o enfileiramento.
- **E2E (Playwright):** admin liga com termos → usuário vê o botão habilitado → limite diário/mensal desabilita com explicação → desligar.
- **Acessibilidade/performance:** axe na seção e no diálogo; `AI-05` e `AI-06` na suíte de performance (sem benchmark no card).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI do lote
- [ ] `SETTINGS_MANAGE`, MFA (POL-14) e POL-18 aplicados na API; seção e botões conforme as regras
- [ ] Reserva, consumo real e serialização por tenant comprovados por teste de concorrência
- [ ] Auditoria `settings.update`, `TenantSettingsChanged` e `AiUsageThresholdReached` verificados em teste
- [ ] `AI_GENERATE` no catálogo (69 permissões) e nos perfis semeados, sem tocar perfis personalizados
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `AI-05`/`AI-06` compatível com api.md; `ai.*` fora de `SET-03`
- [ ] Logs sem conteúdo de geração; seção acessível (axe) e responsiva (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card, DEC-079 e api.md quanto às lacunas) atualizada

## Estimativa
**M** — reaproveita o registro de configurações (US-103), o catálogo de permissões (US-094) e a camada da US-115; a complexidade está na reserva de tokens serializada por tenant, na revalidação no worker e no limiar de aviso, sem novas entidades.

## Prioridade
**P1** — sem a decisão explícita do órgão e sem limites, a IA não pode ser liberada (LGPD e previsibilidade de custo); bloqueia as US-117 a US-121.
