---
id: US-186
title: "Notificar a quebra do selo de auditoria (DT-14)"
epic: EP-029
feature: FT-085
mvp: 2
priority: P2
estimate: S
status: Especificada
depends_on: [US-074, US-111]
modules: [audit, notification, platform, access]
screens: [SCR-036, SCR-037]
endpoints: [AUD-05, NTF-01]
permissions: [AUDIT_VIEW]
events: [AuditSealBroken]
---

# US-186 — Notificar a quebra do selo de auditoria (DT-14)

## Título
Notificar a quebra do selo de auditoria

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO`) ou auditor (`AUDITOR`), **quero** receber uma notificação de prioridade alta, no sistema e por e-mail, assim que a verificação dos selos de auditoria do meu órgão detectar uma quebra de integridade, **para** agir sobre uma possível adulteração da trilha sem depender de alguém olhar o painel operacional da plataforma.

Hoje a quebra só aparece como alerta operacional (A21, para o plantão da plataforma) e como resultado `INVALID` quando alguém abre a aba "Selos" e roda a verificação (AUD-05). Esta story liga a **detecção** ao aviso: quando a verificação falha, por rotina (job diário) ou por pedido manual (AUD-05), o sistema registra o fato uma única vez, publica `AuditSealBroken` e o motor de notificações (US-111) cria `AUDIT_SEAL_BROKEN` para os vínculos ativos com `ADMIN_ORGAO` e `AUDITOR`. O aviso **não** traz conteúdo auditado: só o período, o tipo de verificação (`DIGEST` ou `CHAIN`) e a data de detecção.

## Contexto
- DT-14 (DEC-209): "quebra do selo de auditoria gera notificação (`NotificationType` novo) a `ADMIN_ORGAO` e `AUDITOR`, além do alerta operacional A21". A US-074 deixou a lacuna registrada: sem `NotificationType` para a quebra, a detecção ficou só em log, métrica e alerta (A21: "verificação falhou" é **Crítico**, para o plantão e `#cf-seguranca`).
- RN-PLAT-16 (FT-085): a quebra gera `AUDIT_SEAL_BROKEN` a `ADMIN_ORGAO` e `AUDITOR`, sem desligar o alerta A21; o texto não traz conteúdo auditado (só período, `DIGEST`/`CHAIN` e data de detecção).
- A selagem é horária (`audit-seal`, US-074); a verificação recalcula `digest` e `chainHash` selo a selo (RN-AUD-15/16) e hoje só roda sob demanda (AUD-05). O `security.md` §12 prevê que um job do `maintenance` verifica por amostragem a integridade dos selos e "alerta em divergência", mas esse job não está catalogado em `queues.md` §4.8: esta story o define (`audit-seal-verify`, RN-PLAT-269).
- `events.md` (MVP 2) já registra `AuditSealBroken` (`audit.seal_broken`; payload `sealId`, `periodStart`, `periodEnd`, `detectedAt`, `check`), o tipo `AUDIT_SEAL_BROKEN` (vínculos ativos com `ADMIN_ORGAO` e `AUDITOR`, e-mail ligado por padrão, **obrigatória**) e a ação de auditoria `audit.seal` com `result = FAILURE`.
- O motor de notificações (US-111/US-112/US-113) fornece idempotência por `sourceEventId`, e-mail por fila e a trava de tipos obrigatórios (só o canal `IN_APP`, RN-NTF-23). `Notification.priority` já admite `HIGH` (entities.md MVP 1).
- ADR-009 (trilha de auditoria): selo `INVALID` em produção segue o runbook RB-09 (a criar) do lado da plataforma; o aviso ao órgão complementa, não substitui.

## Objetivo
Notificar 100% das quebras de selo de auditoria em até 5 minutos da detecção, uma única vez por quebra, a todos os `ADMIN_ORGAO` e `AUDITOR` ativos do tenant, sem expor nenhum conteúdo auditado e sem desligar o alerta A21.

## Persona
- **Principal (destinatários):** Administrador do órgão (`ADMIN_ORGAO`) e Auditor (`AUDITOR`).
- **Secundárias:** Auditor com `AUDIT_VIEW` que dispara a verificação manual (AUD-05); operador de plantão da plataforma (continua recebendo o alerta A21); usuários sem esses perfis, que **não** recebem o aviso.

## Pré-condições
- Tenant com selos gerados pelo job `audit-seal` (US-074) e a infraestrutura de notificações em operação (US-111, US-112).
- Para a verificação manual: usuário autenticado com `AUDIT_VIEW` (risco `H`, MFA conforme POL-14).
- Ao menos um vínculo `ACTIVE` com `ADMIN_ORGAO` (garantido pela POL-12) para receber o aviso.

## Fluxo principal
1. Todos os dias, o `maintenance` (`tenant-housekeeping`, 03:00 America/Sao_Paulo) executa por tenant o job `audit-seal-verify`: verifica os selos das últimas 48 horas e uma amostra aleatória de até 50 selos mais antigos (RN-PLAT-269), com o mesmo `SealChainVerifier` do AUD-05.
2. Se algum selo resulta `INVALID`, o verificador identifica o tipo de quebra (`digest` ou `chain`, RN-AUD-15) e o ponto de quebra (RN-AUD-16). Se todos são `VALID`, o job termina sem efeito.
3. Para cada tipo de quebra encontrado, o sistema aplica a deduplicação (RN-PLAT-262): se aquele `(selo, tipo)` já foi comunicado, nada acontece.
4. Se for uma quebra nova, **na mesma transação** o sistema grava a auditoria `audit.seal` com `result = FAILURE` (`actorType = SYSTEM`) e o evento `AuditSealBroken` no outbox; registra log `error` e a métrica que mantêm o alerta A21 (RN-PLAT-267).
5. O relay publica o evento; o `NotificationDispatcher` resolve os destinatários (vínculos ativos com `ADMIN_ORGAO` ou `AUDITOR`, RN-PLAT-264) e cria a notificação `AUDIT_SEAL_BROKEN`, prioridade `HIGH`, sem agrupamento, com o texto fixo da RN-PLAT-266.
6. Para quem tem `notifications.emailEnabled` ativo e não desligou o e-mail do tipo, a notificação nasce com `emailStatus = PENDING` e o `EmailSender` (US-112) envia o e-mail.
7. A pessoa vê o aviso no sino (SCR-036), com selo "Prioridade alta", e clica em "Ver selos", que leva à aba "Selos" da SCR-037 com o período preselecionado.
8. **Caminho manual:** na aba "Selos", o auditor escolhe um intervalo e aciona "Verificar integridade" (AUD-05). Se há quebra nova, o mesmo registro, o mesmo evento e a mesma notificação são produzidos e a resposta traz `data.notification` (`PUBLISHED`); se a quebra já foi comunicada, a resposta traz `ALREADY_NOTIFIED` com `notifiedAt` e a tela diz "Os responsáveis já foram avisados em {data}".

## Fluxos alternativos
- **FA-01 — Reverificação da mesma quebra:** no dia seguinte (ou em outra execução do AUD-05) o mesmo selo continua `INVALID`; nada é publicado nem notificado de novo. O alerta A21 segue ativo enquanto a verificação falhar.
- **FA-02 — Quebra de outro tipo ou em outro selo:** o par `(selo, tipo)` é novo, então gera novo aviso (p.ex., `DIGEST` em 14/10 e, depois, `CHAIN` em 21/10).
- **FA-03 — Vários selos afetados na mesma execução:** uma quebra de `digest` costuma tornar inválidos os selos seguintes na cadeia; o sistema emite **um** evento por tipo, referente ao selo mais antigo com aquela quebra, e informa a contagem de selos afetados em `affectedSeals` (RN-PLAT-261).
- **FA-04 — E-mail desligado:** com `notifications.emailEnabled = false` no tenant, ou preferência do usuário desligando o e-mail do tipo (RN-NTF-05), a notificação existe só no sistema (`emailStatus = SKIPPED`); o canal `IN_APP` nunca é desligável (tipo obrigatório, RN-NTF-23).
- **FA-05 — Tenant sem `AUDITOR`:** recebem só os `ADMIN_ORGAO` ativos; nunca fica sem destinatário (POL-12).
- **FA-06 — Tenant suspenso:** a verificação continua (a selagem é job essencial), mas a regra geral de tenant `SUSPENDED` conclui jobs de notificação sem efeito (`multi-tenancy.md`, efeitos da suspensão do tenant); o aviso não é criado e o A21 cobre o caso (lacuna 7).
- **FA-07 — Falha técnica da verificação:** erro de banco ou tempo esgotado **não** é quebra: o job é reprocessado pela política da fila (5 tentativas, backoff) e, esgotadas, vai à dead letter com alerta operacional; nenhum `AuditSealBroken` é publicado.
- **FA-08 — Selo removido:** a ausência de um selo faz o selo seguinte falhar em `chain`; segue a RN-PLAT-261 (`check = CHAIN`).
- **FA-09 — Quem não tem os perfis:** `REQUISITANTE`, `GESTOR_CONTRATACOES` e demais usuários não recebem o aviso, mesmo tendo `AUDIT_VIEW` concedido por perfil personalizado (RN-PLAT-264).

## Regras de negócio
- **RN-PLAT-260** — Gatilhos: (a) o job diário `audit-seal-verify` e (b) a verificação manual AUD-05. Ambos usam o `SealChainVerifier` (RN-AUD-15/16); selos `VALID` nunca geram evento, notificação ou auditoria. O resultado de AUD-05 continua igual ao da US-074 (por selo, `brokenAtPeriodStart`).
- **RN-PLAT-261** — Quebra e tipo: o tipo `digest` da US-074 vira `check = DIGEST` e `chain` vira `check = CHAIN` no evento. Por execução, publica-se **no máximo um** `AuditSealBroken` por tipo, para o selo mais antigo com aquele tipo de quebra (`sealId`, `periodStart`, `periodEnd`), com `detectedAt = agora` e `affectedSeals` (opcional, inteiro ≥ 1) com a quantidade de selos `INVALID` daquele tipo na execução.
- **RN-PLAT-262** — Deduplicação: a chave é `(tenantId, sealId, check)`. Antes de publicar, a API ou o worker consulta se já existe `AuditLog` `audit.seal` com `result = FAILURE` e os mesmos `metadata.sealId` e `metadata.check` (a consulta só ocorre quando há quebra, caso raro, pelo índice `(tenant_id, action, occurred_at DESC)`); existindo, **não** publica nem grava. Além disso, o `eventId` é determinístico (UUID v5 sobre `tenantId:sealId:check`) e a inserção no outbox usa `ON CONFLICT DO NOTHING`; a notificação é idempotente por `(tenant, destinatário, sourceEventId, type)` (RN-NTF-03), o que impede duplicidade mesmo depois da purga do outbox (7 dias). Não há reaviso periódico (decisão desta story; lacuna 6).
- **RN-PLAT-263** — Atomicidade: a auditoria `audit.seal` (`category = SYSTEM`, `result = FAILURE`, `actorType = SYSTEM`, `reasonCode` = `SEAL_DIGEST_MISMATCH` ou `SEAL_CHAIN_MISMATCH`, `metadata`: `sealId`, `periodStart`, `periodEnd`, `check`, `detectedBy` = `JOB` ou `MANUAL`, `requestedBy` = usuário no caso manual, `affectedSeals`) e o evento `AuditSealBroken` entram na mesma transação (RN-AUD-01/DEC-161). O registro cai no período **corrente** da trilha (RN-AUD-14 vale para o selo, não para este registro), nunca altera selos já gravados.
- **RN-PLAT-264** — Destinatários (RN-PLAT-16): vínculos `ACTIVE` do tenant com atribuição vigente de perfil **ativo** de chave `ADMIN_ORGAO` ou `AUDITOR`, em qualquer escopo, sem teto de 50 (aviso de segurança não é truncado). O evento é de sistema: a regra de excluir o ator (RN-NTF-02) não retira ninguém, inclusive quem pediu a verificação manual. Vínculo suspenso, expirado ou revogado não recebe; perfis personalizados com `AUDIT_VIEW` não recebem.
- **RN-PLAT-265** — Notificação: tipo `AUDIT_SEAL_BROKEN`, `priority = HIGH`, `entityType = AUDIT_SEAL`, `entityId = sealId`, `processId` nulo, `groupKey` nulo (sem agrupamento de 5 min: cada quebra distinta é uma notificação), `expiresAt` nulo, `link` relativo `/auditoria?aba=selos&de={periodStart}&ate={periodEnd}`. O canal `IN_APP` é obrigatório (não desligável, RN-NTF-23); o e-mail é padrão ligado, mas continua sujeito a `notifications.emailEnabled` e à preferência individual (RN-NTF-05).
- **RN-PLAT-266** — Conteúdo (POL-09, RN-NTF-07, DEC-138): `title` = "Possível quebra de integridade da trilha de auditoria"; `body` = "A verificação {do resumo dos registros (DIGEST) | do encadeamento dos selos (CHAIN)} detectou divergência no período de {início} a {fim}, em {data e hora da detecção}. Acesse Auditoria › Selos e acione a equipe de segurança do órgão." Quando `affectedSeals > 1`, acrescenta-se "{n} selos afetados." O texto **nunca** traz `digest`, `chainHash`, `recordCount`, ids de registros, nomes de pessoas, `changes` ou qualquer conteúdo auditado. O e-mail repete o mesmo texto, com assunto "[ContrataFlow] Alerta de integridade da trilha de auditoria".
- **RN-PLAT-267** — O alerta operacional A21 e o log `error` `audit.seal_verification_broken` **continuam** (RN-PLAT-16): a notificação não os resolve nem silencia, e uma falha ao notificar não impede o A21. O alerta fecha pelo runbook RB-09, do lado da plataforma.
- **RN-PLAT-268** — AUD-05 passa de leitura pura a transação de leitura e escrita condicional: só escreve (auditoria e outbox) quando há quebra nova (RN-PLAT-262). Permissão, MFA, limite de `audit.sealVerification.maxPeriods` e resultado por selo permanecem os da US-074. A resposta ganha `data.notification` (`{ status: PUBLISHED | ALREADY_NOTIFIED | NONE, notifiedAt? }`).
- **RN-PLAT-269** — Job `audit-seal-verify` (novo item de `tenant-housekeeping`, `queues.md` §4.8): verifica os selos dos últimos `AUDIT_SEAL_VERIFY_RECENT_HOURS` (padrão 48 h) e uma amostra aleatória de até `AUDIT_SEAL_VERIFY_SAMPLE_SIZE` selos mais antigos (padrão 50), variáveis de ambiente da plataforma; roda sob trava consultiva por tenant, é idempotente (RN-PLAT-262) e usa papel de leitura da trilha (`cf_worker`). Não altera nenhum selo.
- **RN-PLAT-270** — Meta de entrega: o intervalo entre `detectedAt` e a criação da `Notification` é ≤ 5 min em 100% dos casos, medido pela métrica `cf_audit_seal_break_notify_lag_seconds`; acima de 5 min gera alerta `warn` para o plantão.
- **RN-PLAT-271** — Falha de entrega de e-mail (`FAILED` após as tentativas da US-112) não afeta a notificação no sistema; a notificação `IN_APP` é criada independentemente do e-mail.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Período | `periodStart`, `periodEnd` | timestamptz | — | do selo (hora cheia) | `AuditSeal` |
| Tipo de verificação | `check` | `DIGEST`, `CHAIN` | — | RN-PLAT-261 | `SealChainVerifier` |
| Detectado em | `detectedAt` | timestamptz | — | `now()` na detecção | sistema |
| Selos afetados | `affectedSeals` | inteiro ≥ 1 | Não | RN-PLAT-261 | `SealChainVerifier` |
| Prioridade | `priority` | `HIGH` | — | RN-PLAT-265 | registro `NotificationType` |
| Situação do aviso (AUD-05) | `data.notification.status` | `PUBLISHED`, `ALREADY_NOTIFIED`, `NONE` | — | RN-PLAT-268 | resposta de AUD-05 |
| Avisado em | `data.notification.notifiedAt` | timestamptz | — | só em `ALREADY_NOTIFIED` | `AuditLog` |
| Janela do job | `AUDIT_SEAL_VERIFY_RECENT_HOURS`, `AUDIT_SEAL_VERIFY_SAMPLE_SIZE` | inteiros (ambiente) | — | RN-PLAT-269 | 48 / 50 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Intervalo de verificação acima de `audit.sealVerification.maxPeriods` | API | "Reduza o intervalo para verificar a integridade (máximo de {N} selos)." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-02 | `periodEnd` anterior a `periodStart` | Front + API | "O período final deve ser posterior ao inicial." | `VALIDATION_ERROR` |
| V-03 | Selo de outro tenant ou inexistente | API | "Selo não encontrado." | `NOT_FOUND` |
| V-04 | Sem `AUDIT_VIEW` | API | "Você não tem permissão para consultar a auditoria." | `PERMISSION_DENIED` |
| V-05 | Quebra já comunicada (`(selo, tipo)` repetido) | API / worker | — (aviso "já avisados em {data}") | — (sem erro; `ALREADY_NOTIFIED`) |

## Permissões
- **Permissão:** `AUDIT_VIEW` (risco `H`, sem escopo de unidade) para AUD-05 e para a aba "Selos". Receber `AUDIT_SEAL_BROKEN` não exige permissão: vale para quem tem `ADMIN_ORGAO` ou `AUDITOR` ativo (RN-PLAT-264). O job é `SYSTEM`.
- **Políticas:** POL-14 (MFA) em AUD-05, como na US-074; POL-09 e DEC-138 no conteúdo do aviso.
- **MFA:** exigido em AUD-05 conforme `security.mfaPolicy` (`MFA_REQUIRED`); o recebimento do aviso não exige MFA, e o link leva à aba "Selos", que o exige.
- **Sem permissão:** em AUD-05, `403 PERMISSION_DENIED` com `access.denied`; sem os perfis, a pessoa não recebe a notificação. Selo de outro tenant: `404 NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AuditSealBroken` | `audit.seal_broken` | Quebra nova detectada pelo job ou por AUD-05 | Payload: `sealId`, `periodStart`, `periodEnd`, `detectedAt`, `check` (`DIGEST`/`CHAIN`) e, opcional, `affectedSeals` (campo aditivo, mesma `eventVersion`). Consumidor `N` (`NotificationDispatcher`). `eventId` determinístico (RN-PLAT-262) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AUDIT_SEAL_BROKEN` | Vínculos ativos com `ADMIN_ORGAO` e `AUDITOR` | In-app (obrigatório, prioridade `HIGH`) + e-mail (padrão ligado) | `AuditSealBroken`; uma vez por `(selo, tipo)` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Notificar a quebra do selo de auditoria

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com "notifications.emailEnabled" verdadeiro
    And "Ana" é "ADMIN_ORGAO" e "Marcos" é "AUDITOR", ambos com vínculo ativo
    And "Paulo" é "REQUISITANTE" com vínculo ativo
    And existem selos horários de 14/10/2026 até 16/10/2026
    And um "AuditLog" do período 14/10/2026 10:00–10:59 foi alterado diretamente no banco após a selagem

  Scenario: [Sucesso] O job diário detecta a quebra e avisa os responsáveis
    When o job "audit-seal-verify" do tenant for executado
    Then deve ser gerado o evento "AuditSealBroken" com "check" igual a "DIGEST" e o período 10:00–10:59
    And "Ana" e "Marcos" devem receber a notificação "AUDIT_SEAL_BROKEN" com prioridade "HIGH"
    And as duas notificações devem ter "emailStatus" igual a "PENDING"
    And deve existir um "AuditLog" "audit.seal" com "result" "FAILURE" e "reasonCode" "SEAL_DIGEST_MISMATCH"

  Scenario: [Sucesso] O texto do aviso não traz conteúdo auditado
    When "Ana" abrir a notificação "AUDIT_SEAL_BROKEN"
    Then o texto deve trazer o período, o tipo de verificação e a data de detecção
    And não deve conter "digest", "chainHash", quantidade de registros, ids de registros nem nomes de pessoas
    And o link deve levar à aba "Selos" com o período preselecionado

  Scenario: [Sucesso] Verificação manual de "Marcos" também notifica
    Given que "Marcos" tem "AUDIT_VIEW" e a quebra ainda não foi comunicada
    When "Marcos" verificar o intervalo 14/10/2026 a 16/10/2026 em "AUD-05"
    Then a resposta deve trazer o selo de 10:00 como "INVALID" e "data.notification.status" igual a "PUBLISHED"
    And "Marcos" também deve receber a notificação, pois o evento é de sistema

  Scenario: [Sucesso] Quebra de encadeamento
    Given que o selo de 12:00 foi removido do banco
    When o job "audit-seal-verify" for executado
    Then deve ser gerado um "AuditSealBroken" com "check" igual a "CHAIN" para o selo seguinte
    And o texto deve indicar "verificação do encadeamento dos selos (CHAIN)"

  Scenario: [Sucesso] O alerta operacional A21 continua disparado
    When o job "audit-seal-verify" detectar a quebra
    Then o log "error" "audit.seal_verification_broken" deve ser registrado
    And o alerta "A21" deve continuar disparado até a resolução pelo runbook

  Scenario: [Validação] Intervalo de verificação acima do limite
    When "Marcos" verificar um intervalo de 1.000 selos em "AUD-05"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    And nenhum evento "AuditSealBroken" deve ser gerado

  Scenario: [Permissão] Quem não é ADMIN_ORGAO nem AUDITOR não recebe o aviso
    When o evento "AuditSealBroken" for processado
    Then "Paulo" não deve receber nenhuma notificação "AUDIT_SEAL_BROKEN"
    And um usuário com perfil personalizado que só tem "AUDIT_VIEW" também não deve recebê-la

  Scenario: [Permissão] Verificação manual sem AUDIT_VIEW
    Given que "Paulo" não possui "AUDIT_VIEW"
    When "Paulo" enviar "POST /audit/seals/verify"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" igual a "AUDIT_VIEW"
    And nenhum evento "AuditSealBroken" deve ser gerado

  Scenario: [Tenant incorreto] A quebra de outro tenant não avisa este tenant
    Given que o tenant "Prefeitura B" tem um selo com quebra de "digest"
    When o job "audit-seal-verify" processar os dois tenants
    Then só os "ADMIN_ORGAO" e "AUDITOR" de "Prefeitura B" devem receber o aviso daquela quebra
    And "Ana" e "Marcos" não devem receber nenhuma notificação sobre "Prefeitura B"

  Scenario: [Tenant incorreto] Selo de outro tenant em AUD-05
    When "Marcos" pedir a verificação de um selo de "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] A mesma quebra não é avisada de novo no dia seguinte
    Given que a quebra do selo de 10:00 já foi comunicada
    When o job "audit-seal-verify" for executado novamente
    Then nenhum novo evento "AuditSealBroken" nem nova notificação deve ser criado
    And "data.notification.status" de uma verificação manual deve ser "ALREADY_NOTIFIED" com a data do aviso

  Scenario: [Duplicidade] Reentrega do evento ao motor de notificações
    Given que o evento "AuditSealBroken" "E1" já gerou a notificação para "Ana"
    When o job da fila "notifications" para "E1" for reprocessado
    Then nenhuma notificação adicional deve ser criada para "Ana"

  Scenario: [Concorrência] Job e verificação manual detectam a mesma quebra ao mesmo tempo
    When o job "audit-seal-verify" e a verificação manual de "Marcos" detectarem a quebra quase simultaneamente
    Then apenas um evento "AuditSealBroken" e apenas um registro "audit.seal" "FAILURE" devem ser persistidos
    And cada destinatário deve receber uma única notificação

  Scenario: [Falha de banco] Banco indisponível ao registrar a quebra na verificação manual
    Given que o banco de dados fica indisponível ao gravar a auditoria e o evento
    When "Marcos" verificar o intervalo em "AUD-05"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum registro "audit.seal" "FAILURE" nem evento deve ficar persistido
    And o job deve ser reprocessado pela política da fila, sem perder a detecção

  Scenario: [Falha de integração] Provedor de e-mail indisponível
    Given que o provedor SMTP está indisponível
    When o aviso "AUDIT_SEAL_BROKEN" for despachado
    Then a notificação no sistema deve existir para "Ana" e "Marcos"
    And o "emailStatus" deve virar "FAILED" depois das tentativas da fila "email"

  Scenario: [Falha de integração] Fila de notificações ou Redis indisponível
    Given que a fila "notifications" está indisponível
    When a quebra for detectada
    Then o evento "AuditSealBroken" deve permanecer "PENDING" no outbox
    And as notificações devem ser criadas sem perda quando a fila voltar
    And o alerta "A21" deve continuar disparado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Intervalo de verificação muito longo | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | "Reduza o intervalo para verificar a integridade (máximo de {N} selos)." | Ajusta o seletor de datas |
| Selo inexistente/outro tenant | 404 | `NOT_FOUND` | "Selo não encontrado." | Volta à lista de selos |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para consultar a auditoria." | Oculta a aba "Selos" |
| MFA ausente | 403 | `MFA_REQUIRED` | "Esta ação exige verificação adicional (MFA)." | Dispara o *step-up* |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas verificações em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco indisponível na verificação | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível verificar a integridade agora. Tente novamente em instantes." | Botão "Tentar novamente"; exibe o `correlationId` |
| Job esgota as tentativas | — | — | — (backend; alerta operacional) | Sem tela própria |

## Dependências
- **Stories:** US-074 (selagem, verificação AUD-04/AUD-05, RN-AUD-11..16; esta story resolve a lacuna de notificação que ela deixou), US-111 (motor de notificações, idempotência, tipos obrigatórios). Indiretas: US-112 (e-mail), US-113 (preferências, trava `IN_APP`), US-083 (filas e `maintenance`), US-085 (métricas e alerta A21), US-073 (auditoria), US-097 (perfis e vínculos).
- **Decisões/ADRs:** DEC-209 (DT-14), DEC-161, DEC-163, DEC-138, DEC-071, ADR-009, DEC-084; POL-09, POL-14.
- **Configurações:** `notifications.emailEnabled` (tenant); `audit.sealVerification.maxPeriods` (plataforma, US-074); novas variáveis de ambiente `AUDIT_SEAL_VERIFY_RECENT_HOURS` (48) e `AUDIT_SEAL_VERIFY_SAMPLE_SIZE` (50).
- **Lacunas nas fontes canônicas:**
  1. O job de verificação por amostragem consta em `security.md` §12 ("um job do `maintenance` verifica ... selos e alerta em divergência") mas não em `queues.md` §4.8: definido aqui como `audit-seal-verify` (RN-PLAT-269), com janela e amostra parametrizáveis; os valores 48 h e 50 selos são propostos, a validar no endurecimento.
  2. A US-074 definiu AUD-05 como "somente leitura/cálculo — não grava nada": esta story a torna transação de escrita condicional (RN-PLAT-268), com `data.notification` na resposta; ajuste de `api/13-dashboard-notifications-audit.md` e do `api.md` do MVP 2.
  3. `AuditSealBroken` não prevê `affectedSeals` (events.md) e a ação `audit.seal` com `FAILURE` não define `reasonCode`: acrescentados `affectedSeals` (opcional, aditivo) e `SEAL_DIGEST_MISMATCH`/`SEAL_CHAIN_MISMATCH`.
  4. Deduplicação sem tabela nova: `eventId` determinístico mais consulta ao `AuditLog` `audit.seal` `FAILURE`. Alternativa, se o volume de verificações crescer: tabela `audit_seal_breaches` `(tenant_id, seal_id, check, first_detected_at, notified_at)`.
  5. A US-074 usa `digest`/`chain` (minúsculas) e o evento usa `DIGEST`/`CHAIN`: mapeamento fixado na RN-PLAT-261.
  6. **Dúvida de produto:** reavisar enquanto a quebra não for tratada (p.ex., a cada 7 dias)? Adotado **sem reaviso**: a quebra de selo é permanente (a trilha é imutável) e o A21 mantém o alerta para a plataforma.
  7. A regra geral de tenant `SUSPENDED` (notificações são jobs não essenciais) suprime o aviso; avaliar tornar `AUDIT_SEAL_BROKEN` essencial. Em `OFFBOARDING`, `ADMIN_ORGAO` e `AUDITOR` mantêm leitura e o aviso segue normalmente.
  8. A US-074 sugeriu como destinatários "quem tem `AUDIT_VIEW` de risco `H`"; o `events.md` fixou `ADMIN_ORGAO` e `AUDITOR` por chave de perfil: vale o `events.md`. **Dúvida de produto:** `AUDITOR` com vínculo `EXTERNAL` (p.ex., tribunal de contas) deve receber? Adotado sim, por ser vínculo ativo.
  9. A trava de tipos obrigatórios (RN-NTF-23) protege só o canal `IN_APP`: o e-mail do aviso pode ser desligado pelo usuário. **Dúvida de produto:** travar também o e-mail deste tipo (extensão da US-113).
  10. `entityType = AUDIT_SEAL` e a rota `/auditoria?aba=selos&de=&ate=` são indicativos; confirmar com a SCR-037 no `screens.md` do MVP 2.

## Impacto técnico
- **Performance:** a verificação de 48 h de selos mais 50 amostras lê os `rowHash` desses períodos por índice `(tenant_id, occurred_at DESC)`; o job roda de madrugada, por tenant, sob trava consultiva, com meta de ≤ 5 min por tenant de alto volume (a medir). A consulta de deduplicação só ocorre quando há quebra.
- **Segurança:** o aviso é deliberadamente pobre em conteúdo (POL-09, DEC-138); o evento e a notificação não carregam `digest`, `chainHash`, contagens de registros nem dados pessoais.
- **Consistência:** auditoria, deduplicação e outbox na mesma transação; entrega *at-least-once* com idempotência no consumidor.
- **Compatibilidade:** AUD-05 ganha `data.notification` (aditivo, DEC-108); sem alteração de AUD-04 nem de NTF-01, que só passam a listar o tipo novo (`type`, `priority = HIGH`, `entityType = AUDIT_SEAL`).
- **Risco:** aviso falso por falha técnica da verificação; mitigado pela RN-PLAT-261/FA-07, que só publica quando o recálculo conclui e encontra divergência.

## Backend
- **Módulo(s):** `audit` (dono: `SealChainVerifier`, `VerifyAuditSealsCommand`, `AuditSealVerifyJob`), `notification` (registro do tipo e templates), `platform` (outbox, agendador `maintenance`), `access` (resolução de destinatários por perfil).
- **Casos de uso:** `AuditSealVerifyJob` (job `audit-seal-verify`); `VerifyAuditSealsHandler` (AUD-05, agora com escrita condicional); `DispatchNotificationJob` (US-111) com o tipo novo.
- **Domínio:** `SealBreakDetector` (agrupa quebras por tipo e escolhe o selo mais antigo, RN-PLAT-261), `SealBreakDeduplicator` (RN-PLAT-262), `AuditSealBroken.deterministicEventId(tenantId, sealId, check)`; entrada `AUDIT_SEAL_BROKEN` no `NotificationRegistry` (`packages/types`).
- **Integrações internas:** `AuditService` (`audit.seal` `FAILURE`), `OutboxWriter`, `RoleRecipientResolver` (vínculos ativos por chave de perfil), `EmailSender` (US-112).
- **Transação:** uma por quebra nova: dedupe + auditoria + outbox; o job processa os tipos em sequência, cada um em transação própria.

## Frontend
- **Tela(s):** SCR-036 (sino e lista de notificações: item com selo "Prioridade alta") e SCR-037, aba "Selos" (resultado de AUD-05 com a faixa "Os responsáveis foram avisados em {data}" ou "Já avisados em {data}").
- **Componentes:** `NotificationItem` (variante `HIGH`, ícone e texto, não só cor), `SealVerificationResult` (da US-074, com `NotificationStatusNote`), `SealList` com período preselecionado por `de`/`ate`.
- **Estados:** carregando, erro com "Tentar novamente", sucesso com e sem quebra; o aviso `HIGH` não some ao ser lido, só sai da contagem de não lidas.
- **Acessibilidade e responsividade:** prioridade comunicada por texto "Prioridade alta" e ícone; o foco vai ao resultado da verificação ao concluir; lista legível a 360 px.

## Banco de dados
- **Tabelas:** `outbox_events`, `audit_logs` (escrita), `audit_seals` (leitura), `notifications` (escrita pelo worker); nenhuma tabela nova.
- **Migrações:** nenhuma de esquema; registro do tipo `AUDIT_SEAL_BROKEN` no `NotificationRegistry` e do template de e-mail em pt-BR; índice `(tenant_id, action, occurred_at DESC)` de `audit_logs` já existe (entities.md).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, recipient_id, source_event_id, type)` em `notifications` (idempotência) e `PK (id)` de `outbox_events` com o `eventId` determinístico.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AUD-05` *(ajuste)* | POST | `/api/v1/audit/seals/verify` | `{ periodStart, periodEnd }` | `200 { data: { brokenAtPeriodStart, results[], notification: { status: "PUBLISHED" \| "ALREADY_NOTIFIED" \| "NONE", notifiedAt? } } }` | 200, 403, 404, 422, 429, 503 |
| `NTF-01` *(sem mudança de contrato)* | GET | `/api/v1/notifications` | `?cursor&limit&unreadOnly` | passa a listar `type = AUDIT_SEAL_BROKEN`, `priority = HIGH`, `entityType = AUDIT_SEAL` | 200, 401, 403, 422 |

## Logs
- `error` `audit.seal_verification_broken` — `sealId`, `periodStart`, `check`, `detectedBy`, `affectedSeals` (mantém o A21; sem conteúdo de `changes`).
- `info` `audit.seal_break_notified` — `sealId`, `check`, `eventId`, `recipientCount`, `lagSeconds`.
- `info` `audit.seal_break_already_notified` — `sealId`, `check`.
- `warn` `audit.seal_break_notify_slow` — `lagSeconds` acima de 300.
- `error` `audit.seal_verify_failed` — `errorCode`, `durationMs` (falha técnica, FA-07).
- **Nunca logar:** conteúdo de `changes` dos `AuditLog` verificados, `digest` e `chainHash` em nível `info`, endereços de e-mail completos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `audit.seal` (`result = FAILURE`) | `SYSTEM` | Quebra nova detectada | `reasonCode` = `SEAL_DIGEST_MISMATCH` ou `SEAL_CHAIN_MISMATCH`; `metadata`: `sealId`, `periodStart`, `periodEnd`, `check`, `detectedBy`, `requestedBy?`, `affectedSeals` |
| `access.denied` | `ACCESS` | AUD-05 sem `AUDIT_VIEW` | `reasonCode` = `AUDIT_VIEW` |

## Testes necessários
- **Unitários:** `SealBreakDetector` (um evento por tipo, selo mais antigo, `affectedSeals`); `SealBreakDeduplicator`; `eventId` determinístico; texto do aviso sem campos proibidos.
- **Integração (Testcontainers PostgreSQL + Redis/BullMQ):** adulteração direta no banco de teste → job → evento → notificação; reexecução sem duplicar; concorrência job × AUD-05; destinatários por perfil ativo e vínculo ativo; tenant suspenso.
- **API/contrato:** AUD-05 com `data.notification`; `NTF-01` com o tipo novo; erros.
- **RBAC e multi-tenant:** só `ADMIN_ORGAO`/`AUDITOR` ativos recebem; aviso nunca cruza tenant (suíte `test/tenant-leak`); AUD-05 sem permissão → 403.
- **Concorrência:** job e verificação manual simultâneos → um evento; dois workers sobre o mesmo tenant.
- **E2E (Playwright):** banco de teste adulterado → verificação → aviso no sino com "Prioridade alta" → link para a aba "Selos".
- **Acessibilidade/performance:** axe no item `HIGH` e no resultado; job com 48 h de selos de tenant de alto volume (meta a medir no endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria, evento e notificação verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de AUD-05 atualizado e compatível com o `api.md`
- [ ] Logs sem dados sensíveis; métricas (`cf_audit_seal_break_notify_lag_seconds`) e traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card, `queues.md` §4.8, `events.md` e fontes canônicas) atualizada
- [ ] Teste de que o aviso e o evento nunca trazem `digest`, `chainHash` nem conteúdo auditado
- [ ] Alerta A21 verificado como independente da notificação

## Estimativa
**S** — o motor de notificações, o e-mail e o verificador de selos já existem; o trabalho é o job de verificação, a deduplicação, o tipo de notificação com texto controlado e a escrita condicional do AUD-05.

## Prioridade
**P2** — débito do MVP 1 (DT-14): hoje a quebra é visível ao plantão da plataforma, mas não ao órgão; tem relevância de conformidade e não bloqueia outras stories.
