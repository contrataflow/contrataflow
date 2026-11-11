---
id: US-180
title: "Conceder e encerrar acesso de suporte"
epic: EP-029
feature: FT-083
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-073, US-178]
modules: [access, identity, tenancy, audit, notification, platform]
screens: [SCR-123, SCR-037]
endpoints: [PLT-15, PLT-16, PLT-17, PLT-18, PLT-19, SUP-01, SUP-02, SUP-03]
permissions: [PLATFORM_SUPPORT_ACCESS, AUDIT_VIEW, USER_MANAGE]
events: [SupportAccessGranted, SupportAccessEnded]
---

# US-180 — Conceder e encerrar acesso de suporte

## Título
Conceder e encerrar acesso de suporte

## Descrição
**Como** operador da plataforma (`User.isPlatformOperator`, com `PLATFORM_SUPPORT_ACCESS` e MFA), **quero** conceder a mim mesmo, a partir do backoffice, um acesso de suporte a um tenant — com chamado, justificativa, perfil e prazo de até 72 horas — e encerrá-lo antes do fim quando o atendimento acabar; e, **como** administrador do órgão (`ADMIN_ORGAO`), **quero** ver quem do suporte entrou, por quê, com qual perfil e até quando, e poder encerrar esse acesso, **para** que o suporte olhe dados do tenant só com autorização rastreável, por tempo limitado e sempre à vista de quem responde pelos dados (DEC-139, DEC-208).

A story paga o DT-18 (acesso de suporte sem tela). Ela entrega a entidade `SupportAccessGrant` (entities.md §4.12), a concessão que cria o vínculo `EXTERNAL` temporário no tenant, o encerramento antecipado (pelo operador ou pelo administrador), a expiração pelo job `maintenance`, a lista do administrador (na auditoria do órgão, SCR-037) e a lista do operador (SCR-123), com auditoria `support.access_grant`/`support.access_end` e notificação ao administrador.

## Contexto
- DEC-139: operadores da plataforma **não** têm acesso a dados de tenant por padrão; o suporte é um vínculo `EXTERNAL` com validade ≤ 72 h, concedido mediante chamado, com auditoria `actorType = PLATFORM_OPERATOR` visível ao administrador. DEC-208 leva isso para uma área web própria (`/plataforma`, SCR-123) e fixa que o backoffice **não lê** processos nem documentos: quem precisa ver dado entra no tenant, com perfil e prazo, e deixa rastro na auditoria do tenant.
- No MVP 1 a concessão existe só na API/CLI de plataforma e a revogação como `support.access_revoke` (events.md do MVP 1); esta story entrega a tela e o fluxo completos e adota o nome `support.access_end` do catálogo do MVP 2 (lacuna 7).
- Regras já fixadas na FT-083, só citadas aqui: RN-PLAT-01 (operador + MFA sempre), RN-PLAT-04 (chamado, justificativa ≥ 20, perfil permitido, ≤ 72 h), RN-PLAT-05 (um `ACTIVE` por operador e tenant; perda de efeito na hora e invalidação do cache) e RN-PLAT-06 (ação auditada e visível ao administrador).
- POL-15: vínculo `EXTERNAL` só recebe perfil com `allowExternalAssignment = true`. POL-29: rotas `/platform/*` exigem operador + MFA + permissão da rota. RN-TEN-14: o provisionamento nunca cria vínculo para o operador (o suporte é este fluxo, outro).
- O administrador é avisado por notificação (`SUPPORT_ACCESS_GRANTED`, obrigatória, com e-mail — events.md §6). **Não há consentimento prévio** do administrador nas fontes do MVP 2: a feature e o épico preveem ciência e encerramento antecipado; a aprovação prévia aparece só como proposta (†) em security.md §22 e authentication.md §12 (lacuna 6).
- `tenant_memberships` tem `UNIQUE (tenant_id, user_id)`: o mesmo operador que volta ao mesmo tenant reaproveita o vínculo `EXTERNAL` anterior, e a cada concessão nasce uma nova linha de `SupportAccessGrant` (RN-PLAT-145).

## Objetivo
100% dos acessos de suporte com chamado, justificativa, perfil permitido e prazo ≤ 72 h; efeito (concessão, encerramento e expiração) em até 1 requisição, sem janela de cache; 0 acesso de suporte sem rastro na auditoria do tenant nem sem aviso ao administrador; 0 vínculo de suporte "esquecido" depois do prazo.

## Persona
- **Principal:** Operador da plataforma (`isPlatformOperator`, `PLATFORM_SUPPORT_ACCESS`, MFA), que atende um chamado.
- **Secundárias:** Administrador do órgão (`ADMIN_ORGAO`, `AUDIT_VIEW` e `USER_MANAGE`), que acompanha e pode encerrar; Auditor (`AUDITOR`) e Controle Interno (`CONTROLE_INTERNO`), que leem a lista e a trilha com `AUDIT_VIEW`; outro operador com `PLATFORM_SUPPORT_ACCESS`, que pode encerrar um acesso esquecido por um colega.

## Pré-condições
- Operador autenticado no grupo de operadores do Authentik, com sessão de MFA satisfeito (US-178) e `PLATFORM_SUPPORT_ACCESS` na sessão de plataforma.
- Tenant existente e `ACTIVE` para conceder (encerrar vale em qualquer status).
- Existe ao menos um perfil elegível no tenant (ativo, `allowExternalAssignment = true`, sem permissão `HIGH`); sem perfil elegível a concessão fica indisponível com orientação (FA-02).
- Para o lado do administrador: `AUDIT_VIEW` (ver) e `USER_MANAGE` (encerrar), com sessão de MFA quando `security.mfaPolicy` exigir (POL-14).

## Fluxo principal
1. No backoffice (SCR-123), o operador abre o tenant e a aba "Acesso de suporte" (`/plataforma/tenants/{id}/suporte`); o front chama `PLT-17` (acessos do tenant) e `PLT-18` (perfis elegíveis).
2. Ele aciona **"Conceder acesso"** e informa o número do chamado (`ticketReference`), a justificativa (≥ 20 caracteres), o perfil (somente os elegíveis de `PLT-18`) e a duração em horas (1 a 72; padrão 24). A tela mostra o texto fixo: "Você passa a ver dados deste órgão com o perfil escolhido. O administrador do órgão será avisado e pode encerrar o acesso a qualquer momento."
3. O front envia `PLT-15` com `Idempotency-Key`. A API valida operador, MFA e permissão, o tenant (`ACTIVE`), os campos, a elegibilidade do perfil, o vínculo preexistente do operador e a ausência de outro acesso `ACTIVE` do mesmo operador no tenant.
4. Em **uma transação** do papel `cf_platform` com o tenant alvo (`SystemDbService`, razão `SUPPORT_ACCESS`): cria ou reativa o `TenantMembership` `EXTERNAL` (`ACTIVE`, `expiresAt` = fim do acesso, sem convite e sem lotação), cria a `RoleAssignment` (escopo `TENANT`, `validUntil` = fim do acesso, `grantedById` = operador), grava o `SupportAccessGrant` (`ACTIVE`), a auditoria `support.access_grant` (no tenant, `actorType = PLATFORM_OPERATOR`) e o evento `SupportAccessGranted` no outbox.
5. Após o commit, a API remove (`DEL`) a chave de permissões efetivas do vínculo e responde `201` com o acesso, `ETag` e `Location`. O operador vê o acesso "Ativo até {data e hora}" e o botão **"Abrir o órgão"**, que o leva ao seletor de instituição já no tenant (SCR-101); lá a sessão exibe o aviso fixo "Acesso de suporte da plataforma — chamado {ticket} — termina em {tempo}".
6. O consumidor de notificações cria `SUPPORT_ACCESS_GRANTED` para cada vínculo `ADMIN_ORGAO` ativo do tenant (máx. 50): "A equipe de suporte da plataforma recebeu acesso ao órgão até {data e hora}. Chamado {ticket}. Perfil: {perfil}.", com e-mail.
7. O administrador abre **Auditoria › Acessos de suporte** (SCR-037, `/auditoria/suporte`), vê o acesso (operador, chamado, justificativa, perfil, início, prazo, situação) e, se tiver `USER_MANAGE`, o botão **"Encerrar acesso"**.
8. Ao terminar o atendimento, o operador (em "Acesso de suporte" ou em "Meus acessos de suporte") ou o administrador aciona o encerramento (`PLT-16` ou `SUP-03`). A API marca o acesso `ENDED` (`endedAt`, `endedById`), revoga a atribuição de perfil e o vínculo `EXTERNAL` (`REVOKED`), encerra as sessões do operador naquele tenant, audita `support.access_end`, publica `SupportAccessEnded` (`reason = ENDED`) e notifica os administradores (exceto quem encerrou).
9. Se ninguém encerrar, o job `maintenance` marca o acesso `EXPIRED` depois de `expiresAt` (vínculo `EXPIRED`, sessões encerradas, `support.access_end` com ator `SYSTEM`, `SupportAccessEnded` com `reason = EXPIRED`, aviso aos administradores). Antes de o job rodar, a tela já mostra "Expirado" e o acesso já não vale (RN-PLAT-149).

## Fluxos alternativos
- **FA-01 — Operador sem acesso ativo tenta usar o tenant:** sem `SupportAccessGrant` `ACTIVE`, qualquer rota de tenant com `X-Tenant-Id` do órgão responde `403 MEMBERSHIP_INACTIVE` (RN-TEN-20); o operador não vê dado nenhum por padrão.
- **FA-02 — Nenhum perfil elegível:** `PLT-18` volta lista vazia; a tela diz "Este órgão não tem perfil liberado para suporte. Peça ao administrador para criar ou liberar um perfil de leitura para atribuição externa." e o botão "Conceder acesso" fica desabilitado (lacuna 2).
- **FA-03 — Operador já tem acesso ativo no tenant:** `409 SUPPORT_ACCESS_ALREADY_ACTIVE` com o `grantId` existente em `meta`; a tela oferece "Ver acesso" e "Encerrar para conceder outro". Prorrogar = encerrar e conceder de novo (RN-PLAT-158).
- **FA-04 — Operador reaproveita o vínculo anterior:** em concessão posterior ao mesmo tenant, o vínculo `EXTERNAL` anterior (`EXPIRED` ou `REVOKED`) volta a `ACTIVE` com a nova validade, e as atribuições antigas continuam revogadas (RN-PLAT-145).
- **FA-05 — Operador tem vínculo de outra natureza no tenant:** vínculo `INTERNAL`, `INVITED` ou `SUSPENDED`, ou `EXTERNAL` que não veio de suporte → `409 MEMBERSHIP_ALREADY_EXISTS`; o suporte desse caso é tratado pelo administrador (fora do escopo).
- **FA-06 — Tenant fora de `ACTIVE`:** conceder em `PROVISIONING`, `SUSPENDED`, `OFFBOARDING` ou `DEACTIVATED` → `409 INVALID_STATE` ("O órgão não está ativo."). Encerrar continua permitido.
- **FA-07 — Outro operador encerra:** um colega com `PLATFORM_SUPPORT_ACCESS` pode encerrar um acesso esquecido; a auditoria traz `metadata.endedByOtherOperator = true` e o administrador é avisado do mesmo jeito.
- **FA-08 — Encerramento do tenant:** quando o tenant passa a `OFFBOARDING` ou `DEACTIVATED` (US-179), os acessos `ACTIVE` são encerrados pelo mesmo caso de uso (`metadata.cause = TENANT_LIFECYCLE`); na suspensão eles permanecem e seguem expirando (RN-PLAT-157, lacuna 9).
- **FA-09 — Administrador revoga pelo cadastro de usuários:** revogar o vínculo de suporte em Administração › Usuários (USR-12) executa o mesmo encerramento (RN-PLAT-150); suspender o vínculo ou editar a validade dele é recusado.
- **FA-10 — Acesso já encerrado ou expirado:** encerrar de novo → `409 INVALID_STATE` com `meta.currentStatus`; a tela atualiza a linha.
- **FA-11 — E-mail indisponível:** a concessão não falha; a notificação in-app é criada e o e-mail segue a política da fila `email` (5 tentativas, backoff).
- **FA-12 — Redis indisponível:** a invalidação direta do cache falha com `warn`; o efeito não depende dele, porque a autorização confere a vigência do vínculo a cada requisição (RN-PLAT-147).

## Regras de negócio
- **RN-PLAT-140** — Quem concede: somente operador (`User.isPlatformOperator`) com `PLATFORM_SUPPORT_ACCESS` e MFA, sempre (RN-PLAT-01, POL-29). O acesso é **do próprio operador da sessão** (`operatorUserId` = usuário autenticado); não existe concessão a terceiros nem informar outro operador no corpo.
- **RN-PLAT-141** — Entradas e prazo: `ticketReference` obrigatório (3 a 80 caracteres, sem espaços nas pontas), `reason` com 20 a 1.000 caracteres, `roleId` e `durationHours` inteiro de 1 a 72 (padrão da tela: 24). O início é imediato (`startsAt = now()`); `expiresAt = startsAt + durationHours`. O banco repete o limite (`expires_at > starts_at AND expires_at <= starts_at + interval '72 hours'`) — RN-PLAT-04, DEC-139.
- **RN-PLAT-142** — Estado do tenant: só `ACTIVE` aceita concessão (`INVALID_STATE`); a transação trava a linha do tenant em modo compartilhado, de modo que uma suspensão concorrente ou termina antes (e a concessão é recusada) ou depois (e o acesso nasce e fica ineficaz até expirar). Encerrar vale em qualquer status.
- **RN-PLAT-143** — Perfil elegível: existe no tenant, está ativo (`REFERENCE_INACTIVE`), tem `allowExternalAssignment = true` (POL-15), não é o perfil protegido `ADMIN_ORGAO` e **não contém permissão de risco `HIGH`**, nem a de sigilo (DEC-139 e security.md §22 pedem perfil restrito, mais estrito que a POL-15, que admite `HIGH` com a flag — lacuna 3). Perfil com `HIGH` → `422 EXTERNAL_HIGH_RISK_ROLE`; perfil sem a flag ou protegido → `422 VALIDATION_ERROR` (`NOT_ALLOWED`). A POL-13 (anti-escalonamento) não se aplica: quem atribui é a plataforma, e não um usuário do tenant.
- **RN-PLAT-144** — No máximo um acesso `ACTIVE` por operador e tenant: índice único parcial `(tenant_id, operator_user_id) WHERE status = 'ACTIVE'` (RN-PLAT-05). Operadores diferentes podem ter acessos simultâneos no mesmo tenant. A violação do índice é traduzida em `409 SUPPORT_ACCESS_ALREADY_ACTIVE`, nunca em `500`.
- **RN-PLAT-145** — Vínculo: a concessão cria `TenantMembership` `type = EXTERNAL`, `status = ACTIVE`, `expiresAt` igual ao do acesso, sem convite (`inviteTokenHash` nulo), sem `MembershipDepartment` (o perfil é de escopo `TENANT`) e `invitedById` = operador. Se já existir vínculo do operador no tenant (`UNIQUE (tenant_id, user_id)`), ele é reaproveitado apenas quando `EXTERNAL` e `EXPIRED`/`REVOKED` e ligado a acesso de suporte anterior; qualquer outro caso → `409 MEMBERSHIP_ALREADY_EXISTS`. A atribuição de perfil nasce com `scopeType = TENANT`, `validFrom = startsAt`, `validUntil = expiresAt`, `reason` = chamado.
- **RN-PLAT-146** — Atomicidade: vínculo, atribuição, `SupportAccessGrant`, auditoria `support.access_grant` e evento no outbox são gravados na mesma transação do `cf_platform` com `app.tenant_id` do tenant alvo; qualquer falha desfaz tudo (nenhum vínculo sem grant, nenhuma auditoria sem efeito). O encerramento e a expiração seguem a mesma regra.
- **RN-PLAT-147** — Efeito imediato (RN-PLAT-05): depois do commit a API remove a chave `cf:{env}:t:{tenantId}:access:eff:{membershipId}` (RN-IAM-102) e o evento `SupportAccessGranted`/`SupportAccessEnded` aciona o `PermissionCacheInvalidator` (consumidor `C`). Como defesa em profundidade, a autorização de um vínculo `EXTERNAL` ligado a acesso de suporte confere a cada requisição `status = ACTIVE` e `expiresAt > now()` no banco, de modo que cache ou relay atrasado nunca estendem o acesso além de `expiresAt` ou depois do encerramento.
- **RN-PLAT-148** — Encerramento antecipado: só acesso `ACTIVE`. Pode encerrar o operador dono, qualquer outro operador com `PLATFORM_SUPPORT_ACCESS` (`PLT-16`) ou o administrador do tenant com `USER_MANAGE` (`SUP-03`). Efeitos na mesma transação: `status = ENDED`, `endedAt`, `endedById`; vínculo `REVOKED` (`revokedById`, `revocationReason` = "Acesso de suporte encerrado"); atribuição revogada; auditoria `support.access_end`; `SupportAccessEnded` (`reason = ENDED`). O encerramento **não** exige `If-Match` (é ação de redução de acesso e não pode falhar por versão antiga); a segunda chamada concorrente recebe `409 INVALID_STATE`. As sessões do operador naquele tenant são encerradas pelos consumidores de `MembershipRevoked`/`MembershipExpired` (authentication.md §7).
- **RN-PLAT-149** — Expiração: o job `maintenance` (execução a cada 15 minutos, proposta — lacuna 8) procura `SupportAccessGrant` `ACTIVE` com `expiresAt <= now()` por tenant e, por acesso, marca `EXPIRED`, vínculo `EXPIRED`, atribuição encerrada, auditoria `support.access_end` (`actorType = SYSTEM`, `metadata.reason = EXPIRED`) e `SupportAccessEnded` (`reason = EXPIRED`). O job é idempotente e o passo `memberships-expire` do MVP 1 ignora vínculos ligados a acesso `ACTIVE`, para não duplicar `MembershipExpired`. Enquanto o job não roda, listas e APIs exibem `status = EXPIRED` derivado de `expiresAt` e a autorização já recusa (RN-PLAT-147). A expiração do vínculo **não** depende do estado do tenant (jobs de tenant fora de `ACTIVE` não rodam — RN-TEN-12 —, mas o passo de acesso de suporte é de plataforma e percorre também tenants suspensos).
- **RN-PLAT-150** — Vínculo de suporte nas telas de usuários (US-091/US-092): o vínculo aparece com o selo "Suporte da plataforma" e link para o acesso. Revogar (`USR-12`) chama o mesmo caso de uso de encerramento (RN-PLAT-148, ator = administrador); suspender (`USR-10`), reativar (`USR-11`) e editar `expiresAt` (`USR-08`) sobre esse vínculo → `409 INVALID_STATE`. A revogação do vínculo nunca deixa o acesso `ACTIVE` sem vínculo, nem o contrário.
- **RN-PLAT-151** — Visibilidade ao administrador (RN-PLAT-06): `SUP-01` e `SUP-02` exigem `AUDIT_VIEW` e mostram operador (nome), chamado, justificativa, perfil (nome), início, prazo, situação, quem e quando encerrou. A auditoria `support.access_grant`/`support.access_end` é gravada **no tenant** com `actorType = PLATFORM_OPERATOR` (ou `SYSTEM` na expiração) e aparece na consulta de auditoria (AUD-01) com `AUDIT_VIEW`. A justificativa em texto livre fica só em `SupportAccessGrant.reason`; a auditoria guarda `reasonLength` e hash (regra de texto longo do `AuditService`).
- **RN-PLAT-152** — Ciência, não consentimento: concessão e encerramento/expiração geram a notificação `SUPPORT_ACCESS_GRANTED` (obrigatória, com e-mail, ignora preferências) a todos os vínculos `ADMIN_ORGAO` ativos (máx. 50), exceto quem executou a ação; o texto não traz a justificativa. Não existe aprovação prévia do administrador (lacuna 6).
- **RN-PLAT-153** — Ações durante o acesso: toda requisição de tenant feita por vínculo de suporte grava `actorType = PLATFORM_OPERATOR` e `metadata.supportGrantId` na auditoria, e a interface mostra o aviso fixo de acesso de suporte com o tempo restante (RN-PLAT-06). O contexto de requisição passa a carregar `supportGrantId` (lacuna 10).
- **RN-PLAT-154** — Escrita só por `cf_platform`: `support_access_grants` só aceita `INSERT`/`UPDATE` do papel `cf_platform` em contexto de operador (ou do passo de plataforma do job); `cf_app` tem `SELECT` com RLS (administrador do tenant) e nunca escreve. `SUP-03` e `USR-12` chamam o caso de uso de encerramento por `SystemDbService` com razão `SUPPORT_ACCESS`, depois de autorizar o administrador (lacuna 1).
- **RN-PLAT-155** — Isolamento: acesso, perfil ou tenant de outro lugar nunca aparece. `SUP-02`/`SUP-03` com `grantId` de outro tenant → `404 SUPPORT_ACCESS_NOT_FOUND`; `roleId` de outro tenant no corpo → `422 VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`); `tenantId` inexistente → `404 TENANT_NOT_FOUND`. `PLT-17` só lista acessos do tenant do caminho.
- **RN-PLAT-156** — Idempotência e concorrência: `PLT-15` exige `Idempotency-Key` (escopo plataforma + operador + método + rota, DEC-105) e a repetição devolve o mesmo `201` com `Idempotent-Replayed: true`; duas concessões simultâneas do mesmo operador ao mesmo tenant → uma vence, a outra recebe `409 SUPPORT_ACCESS_ALREADY_ACTIVE`; duas tentativas de encerrar → uma `200`, a outra `409 INVALID_STATE`; expiração concorrente com encerramento → vale a primeira a travar a linha (`SELECT … FOR UPDATE`), a outra é no-op.
- **RN-PLAT-157** — Ciclo de vida do tenant (US-179): em `OFFBOARDING` e `DEACTIVATED` os acessos `ACTIVE` são encerrados pelo caso de uso desta story com `metadata.cause = TENANT_LIFECYCLE`; em `SUSPENDED` permanecem e o operador recebe `403 TENANT_SUSPENDED` nas rotas de tenant. A confirmar com a US-179 (lacuna 9).
- **RN-PLAT-158** — Sem prorrogação: não há "estender prazo"; prorrogar é encerrar (ou deixar expirar) e conceder de novo, com novo chamado e nova justificativa. Não há limite de concessões, mas a lista mostra o histórico completo (KPI: acessos de suporte por tenant e por mês).
- **RN-PLAT-159** — Listagens: `PLT-17` (acessos do tenant), `PLT-19` (acessos da plataforma, com `mine`, `tenantId`, `status`) e `SUP-01` (do tenant do administrador) paginam (`page`, `pageSize` ≤ 100), ordenam por `-startsAt` e devolvem `status` derivado (`ACTIVE` com `expiresAt` vencido sai como `EXPIRED`). Nenhuma lista devolve dado de processo ou documento.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Chamado | `ticketReference` | texto (3 a 80) | Sim | RN-PLAT-141 | — |
| Justificativa | `reason` | texto (20 a 1.000) | Sim | RN-PLAT-141 | — |
| Perfil | `roleId` | uuid | Sim | `PLT-18`; RN-PLAT-143 | — |
| Duração (horas) | `durationHours` | inteiro 1 a 72 | Sim | RN-PLAT-141 | 24 |
| Operador | `operatorUserId` | uuid | — | sessão (RN-PLAT-140) | usuário autenticado |
| Início / fim | `startsAt`, `expiresAt` | data/hora | — | check ≤ 72 h | calculados |
| Situação | `status` | `ACTIVE`, `ENDED`, `EXPIRED` | — | derivado de `expiresAt` | `SupportAccessGrant` |
| Encerrado em / por | `endedAt`, `endedBy` | data/hora, `{ type, name? }` | — | `type` ∈ `OPERATOR`, `TENANT_ADMIN`, `SYSTEM` | `SupportAccessGrant` |
| Vínculo | `membershipId` | uuid | — | `EXTERNAL` | criado/reativado |
| Filtros das listas | `status`, `tenantId`, `mine`, `page`, `pageSize` | — | Não | RN-PLAT-159 | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `ticketReference` ausente, fora de 3 a 80 caracteres | Front + API (Zod) | "Informe o número do chamado." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | `reason` com menos de 20 caracteres (ou acima de 1.000) | Front + API (Zod) | "Descreva o motivo com pelo menos 20 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-03 | `durationHours` fora de 1 a 72 ou não inteiro | Front + API (Zod) | "Informe uma duração entre 1 e 72 horas." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-04 | `roleId` de outro tenant ou inexistente | API | "Perfil não encontrado neste órgão." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Perfil inativo | API | "Este perfil está inativo." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-06 | Perfil sem `allowExternalAssignment` ou protegido | API | "Este perfil não pode ser usado em acesso de suporte." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-07 | Perfil com permissão de risco `HIGH` | API | "Este perfil não pode ser atribuído a um vínculo externo." | `EXTERNAL_HIGH_RISK_ROLE` |
| V-08 | Tenant fora de `ACTIVE` ao conceder | API | "O órgão não está ativo." | `INVALID_STATE` |
| V-09 | Operador já tem acesso `ACTIVE` no tenant | API | "Você já tem um acesso de suporte ativo neste órgão." | `SUPPORT_ACCESS_ALREADY_ACTIVE` |
| V-10 | Vínculo do operador no tenant de outra natureza | API | "Você já tem um vínculo neste órgão. Procure o administrador." | `MEMBERSHIP_ALREADY_EXISTS` |
| V-11 | Encerrar acesso que não está `ACTIVE` | API | "Este acesso já foi encerrado." | `INVALID_STATE` |
| V-12 | Sem `Idempotency-Key` em `PLT-15` | API | "Atualize a página e tente novamente." | `VALIDATION_ERROR` (`REQUIRED`, cabeçalho) |

## Permissões
- **Permissão:** `PLATFORM_SUPPORT_ACCESS` para `PLT-15` a `PLT-19` (operador, MFA sempre — RN-PLAT-01). `AUDIT_VIEW` (risco `H`) para `SUP-01`/`SUP-02`; `USER_MANAGE` (risco `H`) para `SUP-03` — o administrador usa a mesma permissão que já revoga vínculos (lacuna 5).
- **Políticas:** POL-29 (rotas `/platform/*`: operador + MFA + permissão da rota; o backoffice não lê processos nem documentos), POL-15 (externos), POL-14 (MFA do administrador conforme `security.mfaPolicy`), POL-12 e POL-16 não se aplicam (o vínculo de suporte não é administrativo). POL-13 não se aplica (RN-PLAT-143).
- **MFA:** sempre para o operador; para o administrador, conforme POL-14 (sem MFA onde a política exige → `403 MFA_REQUIRED`; ponto de dúvida sobre isentar o encerramento — dúvida de produto 2).
- **Sem permissão:** `403 PERMISSION_DENIED` (e `access.denied` na auditoria do tenant, nos `SUP-*`; nas rotas de plataforma, na auditoria de plataforma) — a rota e o menu do backoffice não existem para quem não é operador. Recurso de outro tenant: `404`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `SupportAccessGranted` | `support_access.granted` | Commit de `PLT-15` | `grantId`, `membershipId`, `operatorUserId`, `roleKey`, `expiresAt`, `ticketReference`; consumidores `C` (`PermissionCacheInvalidator`) e `N` (notificação) |
| `SupportAccessEnded` | `support_access.ended` | Commit de `PLT-16`, `SUP-03`, `USR-12`, expiração (job) ou ciclo de vida do tenant | `grantId`, `membershipId`, `reason` (`ENDED`, `EXPIRED`); consumidores `C` e `N` |
| `MembershipRevoked` / `MembershipExpired` | `membership.revoked` / `membership.expired` | Mesma transação do encerramento / da expiração | Já existentes (MVP 1); encerram as sessões do operador no tenant |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `SUPPORT_ACCESS_GRANTED` | Vínculos `ADMIN_ORGAO` ativos do tenant (máx. 50), exceto quem executou a ação | In-app + e-mail (obrigatória — ignora preferências) | `SupportAccessGranted` e `SupportAccessEnded` (texto distinto: "recebeu acesso", "teve o acesso encerrado", "teve o acesso expirado") |

## Critérios de aceite em Gherkin
```gherkin
Feature: Conceder e encerrar acesso de suporte

  Background:
    Given que o tenant "Prefeitura A" está "ACTIVE"
    And "Rui" é operador da plataforma com MFA e "PLATFORM_SUPPORT_ACCESS"
    And "Dora" é operadora da plataforma com MFA e "PLATFORM_SUPPORT_ACCESS"
    And "Marta" é "ADMIN_ORGAO" da "Prefeitura A" com "AUDIT_VIEW" e "USER_MANAGE"
    And o perfil "SUPORTE_EXTERNO" está ativo com "allowExternalAssignment" verdadeiro e só permissões de leitura de risco baixo
    And o tenant "Prefeitura B" também está "ACTIVE" com o perfil "SUPORTE_EXTERNO"

  Scenario: [Sucesso] Conceder acesso de suporte por 24 horas
    When "Rui" conceder acesso à "Prefeitura A" com o chamado "CH-2031", a justificativa "Apoiar o administrador na configuração do fluxo de aprovação" e o perfil "SUPORTE_EXTERNO" por 24 horas
    Then a API deve responder 201 com o acesso "ACTIVE" e "expiresAt" 24 horas após "startsAt"
    And deve existir um vínculo "EXTERNAL" "ACTIVE" de "Rui" na "Prefeitura A" com a mesma validade
    And a auditoria da "Prefeitura A" deve registrar "support.access_grant" com "actorType" "PLATFORM_OPERATOR" e o chamado "CH-2031"
    And o evento "SupportAccessGranted" deve ser publicado uma única vez

  Scenario: [Sucesso] O acesso vale na hora
    Given que "Rui" conseguiu o acesso à "Prefeitura A"
    When "Rui" abrir o órgão e pedir "GET /processes" com o "X-Tenant-Id" da "Prefeitura A"
    Then a API deve responder 200 limitada às permissões do perfil "SUPORTE_EXTERNO"
    And a auditoria dessas ações deve ter "actorType" "PLATFORM_OPERATOR" e "metadata.supportGrantId"
    And a tela deve mostrar "Acesso de suporte da plataforma — chamado CH-2031"

  Scenario: [Sucesso] O administrador vê o acesso e é avisado
    Given que "Rui" conseguiu o acesso à "Prefeitura A" com o chamado "CH-2031"
    When "Marta" abrir "Auditoria › Acessos de suporte"
    Then deve ver "Rui", o chamado "CH-2031", a justificativa, o perfil "SUPORTE_EXTERNO", o início, o prazo e a situação "Ativo"
    And "Marta" deve ter a notificação "SUPPORT_ACCESS_GRANTED" com o chamado e o prazo, sem a justificativa

  Scenario: [Sucesso] Encerrar antes do prazo pelo operador
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura A" e uma sessão aberta no órgão
    When "Rui" encerrar o acesso
    Then o acesso deve ficar "ENDED" com "endedById" de "Rui"
    And o vínculo "EXTERNAL" deve ficar "REVOKED" e a sessão de "Rui" na "Prefeitura A" deve ser encerrada
    And "Rui" deve receber 403 "MEMBERSHIP_INACTIVE" ao pedir "GET /processes" na "Prefeitura A"
    And a auditoria deve registrar "support.access_end" e o evento "SupportAccessEnded" com "reason" "ENDED"
    And "Marta" deve ser avisada do encerramento

  Scenario: [Sucesso] Encerrar antes do prazo pelo administrador
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura A"
    When "Marta" encerrar o acesso em "Auditoria › Acessos de suporte"
    Then o acesso deve ficar "ENDED" com "endedBy.type" "TENANT_ADMIN"
    And "Rui" deve perder o acesso na próxima requisição, sem esperar o cache
    And "Marta" não deve receber notificação da própria ação, mas outro "ADMIN_ORGAO" deve receber

  Scenario: [Sucesso] Expiração pelo job de manutenção
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura A" que venceu há 5 minutos
    When o job "maintenance" processar os acessos de suporte
    Then o acesso deve ficar "EXPIRED" e o vínculo "EXPIRED"
    And a auditoria deve registrar "support.access_end" com "actorType" "SYSTEM" e o evento "SupportAccessEnded" com "reason" "EXPIRED"
    And o administrador deve ser avisado

  Scenario: [Sucesso] Acesso vencido já é recusado antes do job
    Given que o acesso de "Rui" venceu há 2 minutos e o job ainda não rodou
    When "Rui" pedir "GET /processes" na "Prefeitura A"
    Then a API deve responder 403 "MEMBERSHIP_INACTIVE"
    And a lista de "Marta" deve mostrar a situação "Expirado"

  Scenario: [Sucesso] Nova concessão reaproveita o vínculo anterior
    Given que o acesso anterior de "Rui" na "Prefeitura A" está "EXPIRED"
    When "Rui" conceder novo acesso com o chamado "CH-2088"
    Then deve existir um novo acesso "ACTIVE" e o mesmo vínculo "EXTERNAL" deve voltar a "ACTIVE" com a nova validade
    And o histórico deve listar os dois acessos

  Scenario: [Sucesso] Dois operadores com acesso ao mesmo tenant
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura A"
    When "Dora" conceder acesso à "Prefeitura A" com o chamado "CH-2090"
    Then a API deve responder 201 e os dois acessos devem ficar "ACTIVE"

  Scenario: [Sucesso] Outro operador encerra um acesso esquecido
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura A"
    When "Dora" encerrar o acesso de "Rui"
    Then o acesso deve ficar "ENDED" com "endedBy.type" "OPERATOR"
    And a auditoria deve ter "metadata.endedByOtherOperator" verdadeiro

  Scenario: [Sucesso] Revogar o vínculo de suporte pelo cadastro de usuários
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura A"
    When "Marta" revogar o vínculo de "Rui" em "Administração › Usuários"
    Then o acesso de suporte deve ficar "ENDED" e não deve restar acesso "ACTIVE" sem vínculo

  Scenario: [Sucesso] Só aparecem perfis elegíveis
    When "Rui" abrir a concessão para a "Prefeitura A"
    Then a lista de perfis deve trazer "SUPORTE_EXTERNO" e não deve trazer "ADMIN_ORGAO" nem perfis com permissão de risco alto

  Scenario: [Validação] Justificativa curta, duração e chamado inválidos
    When "Rui" tentar conceder com chamado vazio, justificativa "ajuda" e duração de 73 horas
    Then a API deve responder 422 com código "VALIDATION_ERROR" apontando "ticketReference", "reason" e "durationHours"
    And nada deve ser gravado

  Scenario: [Validação] Perfil de risco alto
    Given que o perfil "GESTOR_CONTRATACOES" tem permissão de risco alto
    When "Rui" tentar conceder o acesso com esse perfil
    Then a API deve responder 422 com código "EXTERNAL_HIGH_RISK_ROLE"

  Scenario: [Validação] Perfil sem liberação para externos
    Given que o perfil "SOMENTE_LEITURA" tem "allowExternalAssignment" falso
    When "Rui" tentar conceder o acesso com esse perfil
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"

  Scenario: [Validação] Tenant suspenso não recebe concessão
    Given que a "Prefeitura A" está "SUSPENDED"
    When "Rui" tentar conceder o acesso
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Validação] O banco recusa prazo acima de 72 horas
    When uma escrita direta tentar gravar um acesso com "expiresAt" 80 horas após "startsAt"
    Then o banco deve rejeitar pela restrição de 72 horas

  Scenario: [Permissão] Sem a permissão de suporte
    Given que "Lia" é operadora sem "PLATFORM_SUPPORT_ACCESS"
    When "Lia" pedir "POST /platform/tenants/{id}/support-access"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria de plataforma "access.denied"

  Scenario: [Permissão] Quem não é operador
    Given que "Marta" é "ADMIN_ORGAO" e não é operadora
    When "Marta" pedir "GET /platform/support-access"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And a rota "/plataforma" não deve existir para ela

  Scenario: [Permissão] Operador sem MFA
    Given que "Rui" está com a sessão sem MFA satisfeito
    When "Rui" tentar conceder acesso
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Permissão] Sem acesso concedido o operador não vê nada do tenant
    Given que "Rui" não tem acesso "ACTIVE" à "Prefeitura A"
    When "Rui" pedir "GET /processes" com o "X-Tenant-Id" da "Prefeitura A"
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Permissão] Administrador sem USER_MANAGE não encerra
    Given que "Caio" tem "AUDIT_VIEW" e não tem "USER_MANAGE"
    When "Caio" tentar encerrar o acesso de "Rui"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And o acesso deve continuar "ACTIVE"
    And "Caio" deve ver a lista, sem o botão "Encerrar acesso"

  Scenario: [Tenant incorreto] Acesso de outro tenant não aparece nem se encerra
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura B"
    When "Marta" pedir "GET /support-access" e "POST /support-access/{id}/end" com o id do acesso da "Prefeitura B"
    Then a lista da "Prefeitura A" não deve conter o acesso da "Prefeitura B"
    And o encerramento deve responder 404 com código "SUPPORT_ACCESS_NOT_FOUND"

  Scenario: [Tenant incorreto] Perfil de outro tenant na concessão
    When "Rui" conceder acesso à "Prefeitura A" com o "roleId" do perfil "SUPORTE_EXTERNO" da "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"

  Scenario: [Tenant incorreto] Tenant inexistente
    When "Rui" pedir "POST /platform/tenants/{id}/support-access" com um tenant inexistente
    Then a API deve responder 404 com código "TENANT_NOT_FOUND"

  Scenario: [Duplicidade] Segundo acesso ativo do mesmo operador no mesmo tenant
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura A"
    When "Rui" tentar conceder outro acesso à "Prefeitura A"
    Then a API deve responder 409 com código "SUPPORT_ACCESS_ALREADY_ACTIVE" com o "grantId" existente
    And deve existir um único vínculo e um único acesso "ACTIVE"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Rui" concedeu o acesso com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo corpo e "Idempotent-Replayed" verdadeiro
    And deve existir um único acesso, uma única auditoria e um único evento

  Scenario: [Duplicidade] Operador com vínculo interno no tenant
    Given que "Rui" já tem um vínculo "INTERNAL" "ACTIVE" na "Prefeitura A"
    When "Rui" tentar conceder o acesso
    Then a API deve responder 409 com código "MEMBERSHIP_ALREADY_EXISTS"

  Scenario: [Duplicidade] Encerrar um acesso já encerrado
    Given que o acesso de "Rui" já está "ENDED"
    When "Marta" tentar encerrá-lo de novo
    Then a API deve responder 409 com código "INVALID_STATE" e o estado atual
    And não deve haver nova auditoria nem novo evento

  Scenario: [Concorrência] Duas concessões simultâneas do mesmo operador
    When "Rui" enviar duas concessões à "Prefeitura A" ao mesmo tempo
    Then uma deve responder 201 e a outra 409 com código "SUPPORT_ACCESS_ALREADY_ACTIVE"
    And deve existir um único acesso "ACTIVE"

  Scenario: [Concorrência] Operador e administrador encerram juntos
    Given que "Rui" tem acesso "ACTIVE" à "Prefeitura A"
    When "Rui" e "Marta" encerrarem o mesmo acesso ao mesmo tempo
    Then uma chamada deve responder 200 e a outra 409 com código "INVALID_STATE"
    And deve existir uma única auditoria "support.access_end" e um único evento "SupportAccessEnded"

  Scenario: [Concorrência] Suspensão do tenant durante a concessão
    When "Rui" conceder o acesso enquanto a "Prefeitura A" é suspensa
    Then a concessão deve terminar antes da suspensão ou ser recusada com 409 "INVALID_STATE"
    And nunca deve restar vínculo sem acesso, nem acesso sem vínculo

  Scenario: [Concorrência] Expiração e encerramento ao mesmo tempo
    Given que o acesso de "Rui" acabou de vencer
    When o job de manutenção e "Marta" tentarem encerrar o acesso juntos
    Then apenas uma das ações deve gravar o encerramento
    And deve existir um único evento "SupportAccessEnded"

  Scenario: [Falha de banco] Banco indisponível ao conceder
    Given que o banco de dados fica indisponível durante a transação de "PLT-15"
    When "Rui" conceder o acesso
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e "Retry-After"
    And nenhum vínculo, atribuição, acesso, auditoria ou evento deve ter sido gravado
    And a tela deve manter o formulário com "Tentar novamente"

  Scenario: [Falha de banco] Banco indisponível ao encerrar
    Given que o banco de dados fica indisponível durante o encerramento
    When "Marta" encerrar o acesso
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o acesso deve continuar "ACTIVE" e a tela deve oferecer "Tentar novamente"

  Scenario: [Falha de integração] E-mail indisponível
    Given que o provedor de e-mail está indisponível
    When "Rui" conceder o acesso
    Then a API deve responder 201
    And a notificação in-app a "Marta" deve ser criada e o e-mail deve ficar em novas tentativas

  Scenario: [Falha de integração] Redis indisponível
    Given que o Redis está indisponível
    When "Rui" conceder o acesso e depois "Marta" o encerrar
    Then as duas respostas devem ser de sucesso, com log "warn" de cache indisponível
    And "Rui" deve perder o acesso na requisição seguinte ao encerramento

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Marta" encerrar o acesso
    Then a API deve responder 200 e o acesso deve estar "ENDED" com o vínculo "REVOKED"
    And o evento "SupportAccessEnded" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca cada campo |
| Perfil de risco alto | 422 | `EXTERNAL_HIGH_RISK_ROLE` | "Este perfil não pode ser atribuído a um vínculo externo." | Remove o perfil da lista |
| Tenant fora de `ACTIVE` | 409 | `INVALID_STATE` | "O órgão não está ativo." | Desabilita "Conceder acesso" |
| Acesso já ativo do operador | 409 | `SUPPORT_ACCESS_ALREADY_ACTIVE` | "Você já tem um acesso de suporte ativo neste órgão." | Oferece "Ver acesso" |
| Vínculo do operador de outra natureza | 409 | `MEMBERSHIP_ALREADY_EXISTS` | "Você já tem um vínculo neste órgão. Procure o administrador." | Mensagem sem ação |
| Acesso não está ativo (encerrar) | 409 | `INVALID_STATE` | "Este acesso já foi encerrado." | Atualiza a linha |
| Chave de idempotência em processamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "Sua solicitação está em andamento." | Aguarda e consulta `PLT-17` |
| Chave reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Operador sem MFA | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Conduz ao passo de MFA |
| Sem permissão / não é operador | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta o menu; rota 403 |
| Vínculo inativo no tenant | 403 | `MEMBERSHIP_INACTIVE` | "Você não tem acesso a este órgão." | Volta ao seletor |
| Tenant inexistente (plataforma) | 404 | `TENANT_NOT_FOUND` | "Órgão não encontrado." | Volta à lista de tenants |
| Acesso de outro tenant ou inexistente | 404 | `SUPPORT_ACCESS_NOT_FOUND` | "Acesso de suporte não encontrado." | Volta à lista |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | "Tentar novamente", formulário mantido |

## Dependências
- **Stories:** US-073 (auditoria transacional: `AuditService`, `actorType = PLATFORM_OPERATOR`), US-178 (acesso ao backoffice, operador com MFA e a navegação da SCR-123). Indiretas: US-099 (operações de plataforma e `SystemDbService`), US-100 (isolamento, papéis e RLS), US-091/US-092 (vínculos `EXTERNAL`, revogação), US-095/US-096 (perfis, `allowExternalAssignment`, POL-15), US-097 (cache de permissões), US-112 e US-111 (notificação e e-mail), US-075 (consulta de auditoria), US-179 (ciclo de vida do tenant).
- **Decisões/ADRs:** DEC-139, DEC-208, DEC-076, DEC-078, DEC-132, DEC-105, DEC-161; ADR-002, ADR-009; POL-29, POL-15, POL-14.
- **Configurações:** nenhuma chave de tenant nova. Duração máxima fixa em 72 h (check no banco); agenda do job de expiração (`support-access-expire`) como proposta (lacuna 8).
- **Lacunas nas fontes canônicas:**
  1. **Papel de banco e razão do `SystemDbService`:** multi-tenancy.md §5.3 e a RN-TEN-28 listam as razões fechadas (`TENANT_LIFECYCLE`, `TENANT_PROVISIONING`, `TENANT_ENUMERATION`, `USER_MEMBERSHIPS_LOOKUP`, `INVITATION_LOOKUP`, `PLATFORM_AUDIT`) e dão a `cf_platform` apenas `tenants`, auditoria de plataforma e o agregado `Tenant` do outbox, "nenhuma tabela de negócio". Concessão e encerramento precisam, numa única transação, gravar `support_access_grants`, `tenant_memberships`, `role_assignments`, `audit_logs` (política `actor_type = PLATFORM_OPERATOR` já prevista) e `outbox_events` (agregado novo `SupportAccess`). Proposta: nova razão `SUPPORT_ACCESS` e políticas RLS `TO cf_platform` por tabela, restritas a `app.tenant_id` do tenant alvo, a vínculos `EXTERNAL` ligados a acesso de suporte e ao agregado `SupportAccess`; registrar em ADR-002/multi-tenancy.md §5.3 e §6 e no dependency-cruiser (`system-prisma-allowlist`). Alternativa: funções `SECURITY DEFINER` (`cf_definer`) por operação — a auditoria com `rowHash` pede que a gravação fique na aplicação.
  2. **Perfil padrão de suporte inexistente:** a feature usa o perfil "SUPORTE_EXTERNO" e security.md §22/authentication.md §12 falam em "padrão `SOMENTE_LEITURA`", mas o seeder (US-094) só marca `allowExternalAssignment` em `AUDITOR` e `CONSULTOR_EXTERNO` (que não é de suporte e o `AUDITOR` tem `AUDIT_VIEW`, risco `H`). Sem perfil elegível, nenhum tenant recém-provisionado aceita suporte. Proposta: o seeder `access.defaultRoles` cria `SUPORTE_EXTERNO` (leitura, sem `HIGH`, sem sigilo, `allowExternalAssignment = true`) — ajuste em US-094/US-099/US-178 e no `tenant:seed` para tenants existentes.
  3. **Divergência POL-15 × security.md §22:** a POL-15 admite perfil com permissão `HIGH` desde que `allowExternalAssignment = true` (`AUDITOR`), enquanto DEC-139/security.md §22 dizem "perfis com permissões `HIGH` vedados". Esta story adota o mais restrito para o suporte (RN-PLAT-143); confirmar com o produto.
  4. **Interação com `UNIQUE (tenant_id, user_id)` de `tenant_memberships`:** o desenho do reaproveitamento do vínculo `EXTERNAL` (RN-PLAT-145) não está nas fontes; `RoleAssignment` de suporte sem `MembershipDepartment` e sem convite também não (RN-IAM-56 pede ≥ 1 unidade; precisa de exceção para vínculo de suporte).
  5. **Permissão do administrador:** não há permissão própria nem no épico (só `AUDIT_VIEW`, `ROLE_MANAGE`, `SETTINGS_MANAGE`, `TEMPLATE_PUBLISH`); proposta de usar `AUDIT_VIEW` (ver) e `USER_MANAGE` (encerrar). Alternativa: `SUPPORT_ACCESS_MANAGE` nova, de risco `H`, só do `ADMIN_ORGAO`.
  6. **Consentimento/ciência do administrador:** EP-029, FT-083 e DEC-139 pedem ciência e encerramento antecipado; a aprovação prévia aparece como proposta† (configuração de tenant) em security.md §22 e authentication.md §12. Esta story entrega ciência pós-concessão. **Dúvida de produto:** é suficiente para órgãos com exigência de aprovação prévia (controle externo)?
  7. **Nome da ação de auditoria:** MVP 1 (events.md §7, security.md, authentication.md §12/§13, multi-tenancy.md §10) usa `support.access_revoke`; o catálogo do MVP 2 (events.md §7) usa `support.access_end`. Adotado `support.access_end`; atualizar as fontes do MVP 1 e a coluna `Ação` do catálogo.
  8. **Agenda da expiração:** "job `maintenance`" (feature e entidade) não tem frequência nem nome em queues.md §4.8/§12; o `memberships-expire` é diário e daria até ~24 h de atraso na materialização (o efeito real não depende dele — RN-PLAT-147). Proposta: passo `support-access-expire` no `maintenance-reconcile` (a cada 15 min) e ajuste do `memberships-expire`.
  9. **Interação com o ciclo de vida do tenant (US-179):** quem encerra os acessos `ACTIVE` em `OFFBOARDING`/`DEACTIVATED` e se a suspensão os mantém não está definido; proposta nesta story (RN-PLAT-157), a confirmar na US-179.
  10. **Ator e contexto de requisição:** a `actorType = PLATFORM_OPERATOR` com `onBehalfOfUserId` (security.md §22) cobre ações "em nome de"; para o acesso de suporte comum é preciso `supportGrantId` no `RequestContext` e a regra de derivar o ator do vínculo (RN-PLAT-153) — ajuste em US-084/US-132.
  11. **Tela do administrador:** nenhuma SCR do MVP 2 é dona da lista do lado do tenant (a SCR-123 é do operador). Proposta: aba "Acessos de suporte" na SCR-037 (Auditoria, `/auditoria/suporte`) e selo na SCR-029; `screens.md` do MVP 2 deve registrar.
  12. **Tipo de notificação único:** events.md §6 tem `SUPPORT_ACCESS_GRANTED` para `Granted` e `Ended`; o texto distinto por evento (RN-PLAT-152) precisa de modelo e `payload.kind`.
  13. **Códigos novos fora de api.md:** `SUPPORT_ACCESS_NOT_FOUND`, `SUPPORT_ACCESS_ALREADY_ACTIVE` e o uso de `INVALID_STATE`, `MEMBERSHIP_ALREADY_EXISTS` e `EXTERNAL_HIGH_RISK_ROLE` neste fluxo.

## Impacto técnico
- **Performance:** concessão e encerramento são operações pontuais (p95 ≤ 500 ms); listas paginadas por índice `(tenant_id, status, starts_at DESC)`; o job de expiração varre apenas `status = 'ACTIVE' AND expires_at <= now()` por índice parcial.
- **Segurança:** superfície de maior risco do backoffice. Mitigações: MFA sempre, perfil restrito (sem `HIGH`, sem sigilo), prazo no banco, vínculo único, vigência conferida em cada requisição, auditoria dentro do tenant e aviso obrigatório ao administrador. A justificativa em texto livre nunca vai para log nem para a auditoria (só tamanho e hash).
- **Consistência:** vínculo, atribuição, acesso, auditoria e outbox na mesma transação; estados derivados na leitura cobrem a janela até o job.
- **Compatibilidade:** `PLT-01..08` do MVP 1 não mudam; `USR-08/10/11/12` ganham a regra de vínculo de suporte (aditivo, retorno de erro `INVALID_STATE` em casos antes impossíveis); a lista de eventos de auditoria do MVP 1 troca `support.access_revoke` por `support.access_end`.
- **Risco operacional:** perfil de suporte configurado de forma ampla pelo administrador (a flag `allowExternalAssignment` é do tenant) — mitigado pela recusa de `HIGH` e pela exibição do perfil no aviso.

## Backend
- **Módulo(s):** `access` (dono de `SupportAccessGrant`, elegibilidade de perfil, `RoleAssignment`), `identity` (vínculo `EXTERNAL`, sessões), `tenancy` (estado do tenant, `SystemDbService`), `audit`, `notification`, `platform` (`OutboxWriter`, idempotência, `PlatformCache`); sem módulo de domínio novo (DEC-208).
- **Casos de uso:** `GrantSupportAccessCommand` (`PLT-15`), `EndSupportAccessCommand` (`PLT-16`, `SUP-03`, `USR-12`, ciclo de vida), `ExpireSupportAccessJob` (`maintenance`), `ListTenantSupportAccessQuery` (`PLT-17`), `ListSupportEligibleRolesQuery` (`PLT-18`), `ListPlatformSupportAccessQuery` (`PLT-19`), `ListTenantAdminSupportAccessQuery` (`SUP-01`), `GetSupportAccessQuery` (`SUP-02`).
- **Domínio:** `SupportAccessGrant` (agregado: estados `ACTIVE`/`ENDED`/`EXPIRED`, invariantes RN-PLAT-141..149), `SupportRoleEligibilityPolicy` (POL-15 + `HIGH` + protegido), `SupportMembershipLinker` (cria ou reativa o vínculo), `SupportAccessStatusResolver` (status derivado).
- **Integrações internas:** `SystemDbService` (razão `SUPPORT_ACCESS`), `AuditService`, `OutboxWriter`, `PermissionCacheInvalidator` (consumidor `C`), `NotificationDispatcher` (consumidor `N`), `SessionTerminator` (consumidores de `MembershipRevoked`/`MembershipExpired`), `AuthorizationService` (vigência do vínculo de suporte).
- **Transação:** única, do `cf_platform`, com `app.tenant_id` do alvo: trava `tenants` (compartilhada na concessão) → trava/lê vínculo (`FOR UPDATE`) → grava vínculo, atribuição e acesso → auditoria → outbox → commit → `DEL` do cache.

## Frontend
- **Tela(s):** SCR-123 (`/plataforma/tenants/{id}/suporte` e `/plataforma/suporte` — "Meus acessos de suporte") e SCR-037 (aba "Acessos de suporte", `/auditoria/suporte`); aviso de sessão no `AppShell` do órgão (US-086).
- **Componentes:** `SupportAccessForm` (chamado, justificativa com contador, `RoleSelect` de `PLT-18`, duração com atalhos 4/24/72 h), `SupportAccessTable` (situação por texto e ícone, prazo relativo e absoluto, filtros), `EndSupportAccessDialog` (confirmação), `SupportSessionBanner` ("Acesso de suporte da plataforma — chamado {ticket} — termina em {tempo}"), `SupportMembershipBadge` (na lista de usuários), `ImpactNotice`.
- **Estados:** loading (skeleton), vazio ("Nenhum acesso de suporte neste órgão."), sem perfil elegível (FA-02), erro com "Tentar novamente" e `correlationId`, sucesso com toast "Acesso concedido até {data}"; confirmação de encerramento com o texto "O operador perde o acesso agora e a sessão dele neste órgão é encerrada.".
- **Acessibilidade e responsividade:** situação por texto e ícone (não só cor); diálogo com foco preso e retorno ao botão; contador da justificativa lido por `aria-live`; tabela em cartões abaixo de 768 px; o aviso de sessão tem `role="status"` e não some ao rolar.

## Banco de dados
- **Tabelas:** `support_access_grants` (módulo `access` — entities.md §4.12, migração **M2-20**); alterações de dados em `tenant_memberships` e `role_assignments` (módulos `identity`/`access`); `audit_logs` e `outbox_events` pelas vias existentes. Nenhuma tabela nova além da do §4.12.
- **Migrações:** **M2-20** (`support_access_grants`; reversível por ser tabela nova), com RLS `ENABLE`/`FORCE`, política `tenant_isolation` de leitura para `cf_app`, políticas de escrita para `cf_platform` (lacuna 1) e entrada nas suítes de tenant leak e de autorização; seed do perfil `SUPORTE_EXTERNO` (lacuna 2) em migração de dados própria.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, operator_user_id) WHERE status = 'ACTIVE'`; `CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '72 hours')`; `CHECK (status <> 'ENDED' OR ended_at IS NOT NULL)`; FK compostas `(tenant_id, membership_id)` e `(tenant_id, role_id)`; índices `(tenant_id, status, starts_at DESC)`, `(operator_user_id, status)` e parcial `(expires_at) WHERE status = 'ACTIVE'` (job).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PLT-15` | POST | `/api/v1/platform/tenants/{tenantId}/support-access` | `{ ticketReference, reason, roleId, durationHours }` + `Idempotency-Key` | `201 { data: SupportAccessGrant }` + `Location`, `ETag` | 201, 403, 404, 409, 422, 429, 503 |
| `PLT-16` | POST | `/api/v1/platform/support-access/{grantId}/end` | `{}` | `200 { data: SupportAccessGrant }` | 200, 403, 404, 409, 429, 503 |
| `PLT-17` | GET | `/api/v1/platform/tenants/{tenantId}/support-access` | `?status=&page=&pageSize=` | `200 { data: SupportAccessGrant[], meta }` | 200, 403, 404, 422, 429, 503 |
| `PLT-18` | GET | `/api/v1/platform/tenants/{tenantId}/support-access/eligible-roles` | — | `200 { data: [{ id, key, name }] }` (só perfis elegíveis; sem permissões) | 200, 403, 404, 429, 503 |
| `PLT-19` | GET | `/api/v1/platform/support-access` | `?mine=&tenantId=&status=&page=&pageSize=` | `200 { data: SupportAccessGrant[] (com tenant { id, slug, name }), meta }` | 200, 403, 422, 429, 503 |
| `SUP-01` | GET | `/api/v1/support-access` | `?status=&page=&pageSize=` (tenant de `X-Tenant-Id`) | `200 { data: SupportAccessGrant[], meta }` | 200, 401, 403, 422, 429, 503 |
| `SUP-02` | GET | `/api/v1/support-access/{grantId}` | — | `200 { data: SupportAccessGrant }` | 200, 401, 403, 404, 429, 503 |
| `SUP-03` | POST | `/api/v1/support-access/{grantId}/end` | `{}` | `200 { data: SupportAccessGrant }` | 200, 401, 403, 404, 409, 429, 503 |

`SupportAccessGrant` = `{ id, operator { userId, name }, ticketReference, reason, role { id, key, name }, startsAt, expiresAt, status, endedAt, endedBy { type, name? } \| null, createdAt, version }`; a visão de plataforma acrescenta `tenant { id, slug, name }`. Nenhum campo traz dado de processo, documento ou comentário. Rotas `PLT-*` têm `x-tenant-scope = PLATFORM`; `SUP-*` têm `TENANT`.

## Logs
- `info` `support_access.granted` — `grantId`, `tenantId`, `operatorUserId`, `roleKey`, `durationHours`, `durationMs`, `correlationId`.
- `info` `support_access.ended` — `grantId`, `tenantId`, `reason` (`ENDED`/`EXPIRED`), `endedByType`, `correlationId`.
- `info` `system_db.call` — `reason = SUPPORT_ACCESS`, `caller`, `outcome`, `durationMs` (padrão do `SystemDbService`).
- `warn` `support_access.cache_invalidation_failed`, `warn` `support_access.notification_failed`, `warn` `support_access.rejected` (`errorCode`, sem corpo).
- `error` `support_access.persist_failed` — `errorCode`, `durationMs`.
- **Nunca logar:** `reason` (justificativa), `ticketReference` além do hash em nível `debug`, e-mail e nome do operador ou do administrador, tokens, conteúdo de qualquer recurso do tenant.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `support.access_grant` | `SECURITY` | Commit de `PLT-15` (no tenant, `actorType = PLATFORM_OPERATOR`) | `entityType = SupportAccessGrant`; `metadata`: `grantId`, `ticketReference`, `roleKey`, `expiresAt`, `durationHours`, `reasonLength`, `reasonHash`, `membershipReused` |
| `support.access_end` | `SECURITY` | Commit de `PLT-16`, `SUP-03`, `USR-12` (ator: operador ou administrador), expiração (`actorType = SYSTEM`) ou ciclo de vida do tenant (`SYSTEM`) | `metadata`: `grantId`, `reason` (`ENDED`/`EXPIRED`), `endedByType`, `endedByOtherOperator?`, `cause?` (`TENANT_LIFECYCLE`) |
| *(ações do operador no tenant)* | conforme a ação | Durante o acesso | `actorType = PLATFORM_OPERATOR`, `metadata.supportGrantId` (RN-PLAT-153) |
| `access.denied` | `ACCESS` | 403 em `PLT-15..19` (auditoria de plataforma) e em `SUP-01..03` (auditoria do tenant) | `reasonCode` = `PLATFORM_SUPPORT_ACCESS`, `AUDIT_VIEW` ou `USER_MANAGE` |

## Testes necessários
- **Unitários:** `SupportAccessGrant` (transições, prazo ≤ 72 h, status derivado), `SupportRoleEligibilityPolicy` (flag, `HIGH`, protegido, inativo), `SupportMembershipLinker` (criar, reaproveitar, recusar vínculo de outra natureza), validação Zod, idempotência.
- **Integração (Testcontainers PostgreSQL):** concessão, encerramento e expiração com vínculo, atribuição, auditoria e outbox atômicos; check de 72 h; índice único parcial; RLS (`cf_app` só lê; `cf_platform` escreve apenas no tenant alvo e em vínculos de suporte); reaproveitamento do vínculo; job de expiração idempotente; `USR-12` encerrando o acesso; falha no meio da transação desfaz tudo.
- **API/contrato:** `PLT-15..19` e `SUP-01..03` conforme o `api.md` do MVP 2; `Idempotency-Key`; códigos de erro; ausência de qualquer campo de dado de processo ou documento nas respostas.
- **RBAC e multi-tenant:** só operador com MFA e `PLATFORM_SUPPORT_ACCESS`; `SUP-*` por `AUDIT_VIEW`/`USER_MANAGE`; acesso, perfil e tenant de outro lugar → 404/422 (suíte `test/tenant-leak`: `support_access_grants` e as rotas `SUP-*`); operador sem acesso ativo → 403 `MEMBERSHIP_INACTIVE` em rotas de tenant; teste de autorização de que nenhuma rota `/platform/*` devolve processo ou documento.
- **Concorrência:** concessões simultâneas do mesmo operador; encerramentos simultâneos; concessão × suspensão do tenant; expiração × encerramento; replay de idempotência.
- **Segurança/efeito imediato:** vigência conferida no banco com cache aquecido e com Redis fora; sessão do operador encerrada no encerramento; ações durante o acesso com `actorType = PLATFORM_OPERATOR`.
- **E2E (Playwright):** provisionar tenant → conceder suporte por 24 h → administrador vê e é avisado → operador abre o órgão com o aviso fixo → administrador encerra → operador perde o acesso.
- **Acessibilidade/performance:** axe nas telas de concessão e na lista; teclado completo no diálogo de encerramento; job de expiração com 10.000 acessos `ACTIVE` vencidos concluindo em lotes (p95 do lote ≤ 1 s) como teste de sanidade.

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
- [ ] Migração M2-20 revisada (reversível) e políticas RLS de `cf_platform` revisadas
- [ ] Teste prova que concessão, encerramento e expiração são atômicos e que a vigência é conferida a cada requisição
- [ ] Teste prova que nenhuma rota `/platform/*` devolve dado de processo ou documento (DEC-208)
- [ ] Lacunas 1 a 3 e 7 registradas nas fontes canônicas (ADR-002, multi-tenancy.md, seeder de perfis, events.md)

## Estimativa
**M** — uma entidade, oito endpoints e um job, com transação de plataforma sobre vínculo, atribuição, auditoria e outbox; o peso está na segurança (vigência por requisição, perfil restrito, isolamento) e nas regras de concorrência, não no volume de tela (um formulário e duas listas).

## Prioridade
**P1** — paga o DT-18 e é o contraponto de segurança do backoffice (DEC-208: nenhum dado de tenant sem acesso temporário e rastreável); depende da US-178 e é pré-requisito para operar mais de um órgão sem a CLI.
