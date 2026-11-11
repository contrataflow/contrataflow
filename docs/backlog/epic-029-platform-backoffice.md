---
id: EP-029
title: "Plataforma e backoffice"
mvp: 2
priority: P1
features: [FT-083, FT-084, FT-085]
status: Especificado
---

# EP-029 — Plataforma e backoffice

## Título
Plataforma e backoffice

## Objetivo
Tirar a operação da plataforma da linha de comando e da API crua: uma área web própria, com MFA, para provisionar tenants, acompanhar o ciclo de vida, conceder acesso de suporte com prazo e chamado, e ver a saúde operacional sem tocar em dado de processo. Em paralelo, permitir que o servidor entre com a conta gov.br que já usa (sem que isso vire acesso) e quitar quatro débitos pequenos do MVP 1 (DT-13 a DT-16).

## Contexto e problema
- No MVP 1 o provisionamento de tenant é por CLI e API de plataforma (US-099), e o acesso de suporte da DEC-139 não tem tela: DT-07 e DT-18 aceitaram isso porque havia poucos pilotos. Com mais órgãos, a operação manual vira risco e gargalo (DEC-208).
- O login gov.br ficou fora do MVP 1 (PEND-18, resolvida na DEC-207). O Authentik é o único IdP que o ContrataFlow conhece (DEC-130), e o login nativo da DEC-187 não conduz federação: a entrada por gov.br é uma fonte OIDC federada no Authentik, com vínculo explícito da identidade ([ADR-017](../adr/adr-017-govbr-login.md)).
- Os débitos DT-13 (reativar perfil), DT-14 (notificar quebra do selo de auditoria), DT-15 (diferença e adoção assistida da biblioteca de templates) e DT-16 (limite do lote da caixa de tarefas) são P2 e entram como stories deste épico (DEC-209). **DT-17 não é deste épico** (fica no EP-022).
- Princípios: o backoffice **não lê processos nem documentos** (DEC-208); gov.br **autentica, não dá acesso** (exige `TenantMembership` ativo — DEC-012, DEC-207); LGPD e CPF como HMAC (DEC-086, DEC-140).

## Escopo
- Área `/plataforma` separada das telas do órgão (SCR-123), só para operadores da plataforma (grupo próprio no Authentik, MFA sempre):
  - provisionar tenant e órgãos (mesma operação da US-099);
  - ciclo de vida do tenant (ativar, suspender, encerrar, desativar);
  - acesso de suporte: `SupportAccessGrant` com chamado, justificativa, perfil e prazo de até 72 h, encerrável antes do fim;
  - saúde operacional por tenant: filas, consumo e limites de IA, storage, reconciliação do read model.
- Login gov.br: botão em `/entrar`, fonte federada no Authentik, vínculo em "Meu perfil" ou por CPF igual ao cadastrado, `govbrTrustLevel` na sessão e na auditoria, habilitação por tenant (`auth.govbrEnabled`) e nível aceito como segundo fator (`auth.govbrCountsAsMfa`, desligado por padrão).
- DT-13: reativar perfil desativado (`RoleReactivated`).
- DT-14: notificação `AUDIT_SEAL_BROKEN` a `ADMIN_ORGAO` e `AUDITOR` quando a verificação dos selos falha, além do alerta A21.
- DT-15: aviso de atualização da biblioteca padrão de templates, diferença por `contentHash` e adoção assistida.
- DT-16: `inbox.bulkMaxItems` por tenant, dentro da faixa permitida pela plataforma.

## Fora de escopo
- Qualquer leitura de processo, documento ou conteúdo de tenant pelo backoffice (nem como suporte: o suporte entra como `EXTERNAL` no tenant, com perfil e prazo, e é auditado).
- Módulo de domínio novo: o backoffice reaproveita `tenancy`, `identity`, `access` e `audit`; a CLI de plataforma continua existindo.
- Planos comerciais e limites por tenant (PEND-17, decisão comercial — DEC-210); escolha de provedor de IA por órgão (DT-19).
- Criar usuário ou vínculo de tenant automaticamente por gov.br; exigir nível mínimo de confiança (opção futura da ADR-017); outros provedores federados.
- DT-17 (prazo da aprovação avulsa de documento) — EP-022.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Operador da plataforma | `User.isPlatformOperator` (fora dos perfis de tenant) | Provisionar, acompanhar e dar suporte sem CLI, com trilha auditável |
| Administrador do órgão | `ADMIN_ORGAO` | Ver quem do suporte entrou, habilitar o gov.br, reativar perfis, ajustar o lote da caixa de tarefas, adotar atualizações de templates |
| Auditor / Controle interno | `AUDITOR`, `CONTROLE_INTERNO` | Ser avisado quando o selo de auditoria quebra e ver as ações de operador na auditoria do tenant |
| Servidor | Qualquer perfil de tenant | Entrar com a conta gov.br e vincular/desvincular a identidade em "Meu perfil" |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-083 | Backoffice da plataforma | US-178, US-179, US-180, US-181 | P1 |
| FT-084 | Login gov.br | US-182, US-183, US-184 | P1 |
| FT-085 | Débitos técnicos do MVP 1 | US-185, US-186, US-187, US-188 | P2 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-178 | Acesso ao backoffice e provisionamento de tenant e órgãos | P1 | L | 8 |
| US-179 | Ciclo de vida do tenant no backoffice | P1 | M | 5 |
| US-180 | Conceder e encerrar acesso de suporte | P1 | M | 5 |
| US-181 | Saúde operacional por tenant no backoffice | P1 | M | 5 |
| US-182 | Entrar com gov.br via Authentik | P1 | L | 8 |
| US-183 | Vincular e desvincular a identidade gov.br | P1 | M | 5 |
| US-184 | Habilitar o gov.br no órgão e nível de confiança na política de MFA | P1 | S | 2 |
| US-185 | Reativar perfil desativado (DT-13) | P2 | S | 2 |
| US-186 | Notificar a quebra do selo de auditoria (DT-14) | P2 | S | 2 |
| US-187 | Atualizar a biblioteca padrão de templates com adoção assistida (DT-15) | P2 | M | 5 |
| US-188 | Limite configurável do lote da caixa de tarefas (DT-16) | P2 | XS | 1 |
| **Total** | | | | **48** |

## Módulos e entidades
- Módulos: `tenancy` (provisionamento e ciclo de vida), `identity` (gov.br), `access` (acesso de suporte, perfis), `audit` (selos e ações de operador); ajustes em `notification`, `document` (biblioteca de templates) e `inbox` (lote). Backoffice sem módulo de domínio novo.
- Entidades: `UserExternalIdentity` e `SupportAccessGrant` (novas — [entities.md §4.12](../mvp-02/entities.md)); `Role` (`deactivatedAt`/`deactivatedById`, §5.13); `DocumentTemplate`/`DocumentTemplateVersion` (`libraryKey`, `libraryVersion`, `libraryContentHash`, §5.10); `TenantSetting` (`auth.govbrEnabled`, `auth.govbrCountsAsMfa`, `inbox.bulkMaxItems`); consumidas: `Tenant`, `Organization`, `TenantMembership`, `User`, `AuditLog`.

## Telas
- SCR-123 — Backoffice da plataforma (`/plataforma`, área separada).
- SCR-001 — Login (botão "Entrar com gov.br" e mensagens de recusa) e o perfil do usuário ("Meu perfil", vínculo gov.br).
- Telas do administrador existentes, ampliadas: perfis (reativar), templates (atualização disponível), configurações gerais (gov.br e lote), auditoria (ações de operador).

## Integrações
- Authentik: fonte OAuth do gov.br (Login Único) e grupo de operadores; depende do credenciamento da plataforma no Login Único (externo, opcional por tenant).
- Internas: API de plataforma `/platform/*` (PLT-01..08 do MVP 1), filas e relatórios de saúde, `NotificationDispatcher`, outbox, job `maintenance` (expiração dos acessos de suporte).

## Eventos principais
- `SupportAccessGranted`, `SupportAccessEnded`, `GovbrIdentityLinked`, `GovbrIdentityUnlinked`, `RoleReactivated`, `AuditSealBroken`, `TemplateLibraryUpdateAvailable`, `TemplateLibraryUpdateAdopted`; do MVP 1: `TenantProvisioned`, `TenantActivated`, `TenantSuspended`, `TenantOffboarded`, `TenantDeactivated`, `TenantSettingsChanged`.

## Permissões envolvidas
- Plataforma (DEC-208, [permissions.md §8](../mvp-02/permissions.md)): `PLATFORM_TENANT_MANAGE`, `PLATFORM_SUPPORT_ACCESS`, `PLATFORM_QUEUE_ADMIN`, `PLATFORM_AUDIT_VIEW`, `PLATFORM_HEALTH_VIEW` (nova).
- Tenant (MVP 1): `ROLE_MANAGE` (reativar), `TEMPLATE_PUBLISH` (adotar atualização), `SETTINGS_MANAGE` (gov.br e lote), `AUDIT_VIEW` (ver ações de operador).
- Política POL-29 (backoffice e identidade federada).

## Regras configuráveis
- `auth.govbrEnabled` — habilita o gov.br no tenant (padrão `false`).
- `auth.govbrCountsAsMfa` — `NEVER` (padrão), `SILVER_OR_GOLD` ou `GOLD`: nível gov.br aceito como segundo fator.
- `inbox.bulkMaxItems` — lote da caixa de tarefas (padrão 50; 2 até `INBOX_BULK_MAX_ITEMS` da plataforma, padrão 200).
- `workflow.offerSeedUpdates` (do EP-021) segue a mesma lógica de oferta, mas a atualização de templates (DT-15) é independente dela.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tenants provisionados pelo backoffice (e não pela CLI) | 100% após a entrega | `TenantProvisioned` com origem; auditoria `backoffice.access` |
| Acessos de suporte com chamado e prazo ≤ 72 h | 100%; 0 acessos sem encerramento ou expiração | `SupportAccessGrant` |
| Logins por gov.br nos tenants habilitados | ≥ 40% dos logins em 3 meses (a validar com o piloto) | auditoria `auth.govbr_login` |
| Recusas de gov.br por falta de vínculo resolvidas em até 1 dia útil | ≥ 90% | auditoria `auth.govbr_login` (falhas) × `GovbrIdentityLinked` |
| Quebra de selo notificada em até 5 min da detecção | 100% | `AuditSealBroken` × `Notification` |
| Perfis reativados em vez de duplicados | Tendência de queda de duplicações | `RoleReactivated` × `RoleCreated` |

## Dependências
- **Depende de:** EP-009 (autenticação e MFA), EP-013 (auditoria e selos), EP-015 (worker, filas e outbox), EP-016 (permissões e perfis), EP-017 (tenancy e provisionamento), EP-018 (templates), EP-019 (notificações), EP-020 (consumo de IA exibido na saúde).
- **Habilita:** operação de vários tenants em produção; MVP 3 (assinatura gov.br reaproveita o credenciamento — critério de revisão da ADR-017).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Credenciamento no Login Único atrasa | Alta | Médio | Fonte só é criada com credenciais; botão oculto sem ela; login por usuário e senha mantido |
| Vínculo gov.br com a pessoa errada | Baixa | Alto | Vínculo só por ação do próprio usuário autenticado ou CPF (HMAC) igual ao cadastrado; auditoria; desvincular em "Meu perfil" |
| Backoffice vira porta para dados de tenant | Baixa | Alto | Nenhuma rota devolve dado de processo ou documento; `cf_platform` só em contexto de operador; teste de autorização dedicado |
| Acesso de suporte esquecido | Média | Alto | Expiração ≤ 72 h pelo job `maintenance`, aviso ao administrador, encerramento antecipado por qualquer das partes |
| CPF passa a ser dado guardado | Média | Médio | HMAC, máscara, fora de logs; inventário de dados e termos atualizados (DEC-140) |
| Indisponibilidade do gov.br | Média | Baixo | Afeta só quem entra por ele; mensagem clara |

## Pontos em aberto
- Dependência externa: credenciamento da plataforma no Login Único (registrada no plano de entrega; sem PEND novo — PEND-18 foi resolvida pela DEC-207).
- "A validar com o piloto": se algum órgão exigirá nível mínimo de confiança (hoje só atributo — ADR-017) e qual nível aceitar como segundo fator.
- Rotas, contratos e layout do backoffice (SCR-123) ficam para o `api.md` e o `screens.md` do MVP 2.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando (provisionar tenant → suporte com prazo; entrar com gov.br com e sem vínculo)
- [ ] Teste de autorização: operador sem MFA recebe `MFA_REQUIRED`; nenhuma rota do backoffice devolve dado de processo
- [ ] Documentação e treinamento (guia do operador e do administrador) atualizados
