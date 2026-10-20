---
id: EP-016
title: "Identidade, acesso e RBAC"
mvp: 1
priority: P0
features: [FT-051, FT-052, FT-053, FT-054]
status: Especificado
---

# EP-016 — Identidade, acesso e RBAC

## Título
Identidade, acesso e RBAC

## Objetivo
Garantir que toda pessoa que acessa o ContrataFlow seja autenticada de forma segura (OIDC/Authentik, sessão no BFF), esteja vinculada ao(s) órgão(s) corretos, e só veja e execute exatamente o que seu perfil, escopo e participação autorizam — com a autorização sempre decidida pela API, nunca pelo cliente.

## Contexto e problema
Hoje, nos órgãos, o acesso é combinado a cargos informais, planilhas de controle e credenciais compartilhadas; não há registro confiável de quem pode fazer o quê, nem separação entre quem solicita, quem aprova e quem fiscaliza — um risco direto à segregação de funções exigida pela Lei 14.133/2021 (art. 7º, § 1º) e à atuação do controle externo (art. 24, I). Este épico resolve isso com identidade federada no Authentik (DEC-130), sessão segura no BFF (DEC-053, DEC-131), um modelo de permissões com escopo (`TENANT`/`ORGANIZATION`/`DEPARTMENT`/`OWN_DEPARTMENTS` — DEC-134) e perfis padrão alinhados às personas do órgão (DEC-035).

## Escopo
- Login OIDC/PKCE via BFF, sessão em Redis, logout, expiração/renovação e recuperação de senha.
- Política de MFA por tenant com *step-up*.
- Convite, ativação de vínculo, gestão de usuários/lotações e troca de órgão ativo.
- Catálogo de permissões e os 15 perfis padrão semeados.
- Gestão de perfis e matriz de permissões; atribuição de perfis com escopo e vigência.
- Motor de autorização (API e frontend) aplicado a todas as rotas do produto.
- Perfil e preferências do próprio usuário.

## Fora de escopo
- Federação com identidade do órgão (gov.br, Entra ID) — futuro.
- Múltiplos aprovadores sequenciais por aprovação (PEND-13, módulo `workflow`).
- API pública exposta à internet (MVP 3 — DEC-053).
- Contas de serviço (`MembershipType.SERVICE`) — MVP 3.
- Encerramento remoto de sessões ativas — fora desta entrega (nota de produto; não é um ponto em aberto deste épico).
- Permissões ampliadas de Fiscal/Gestor de contrato — MVP 4.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Administrador do órgão | `ADMIN_ORGAO` | Provisiona usuários, define perfis e concede acessos |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Pode receber `ROLE_ASSIGN`; distribui acesso na própria área |
| Servidor de qualquer área | 15 perfis padrão | Autentica, troca de órgão ativo, mantém o próprio perfil |
| Auditor / consultoria externa | `AUDITOR`, `CONSULTOR_EXTERNO` | Vínculo `EXTERNAL` com vigência e acesso por participação |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-051 | Autenticação | US-087, US-088, US-089, US-090 | P0 |
| FT-052 | Usuários e vínculos | US-091, US-092, US-093 | P0 |
| FT-053 | Perfis e permissões | US-094, US-095, US-096, US-097 | P0 |
| FT-054 | Perfil do usuário | US-098 | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-087 | Login OIDC com Authentik e sessão segura no BFF | P0 | L | 8 |
| US-088 | Logout, expiração e renovação de sessão | P0 | M | 5 |
| US-089 | Recuperação de senha | P0 | S | 2 |
| US-090 | Política de MFA por tenant com step-up | P1 | M | 5 |
| US-091 | Convidar usuário e ativar vínculo | P0 | M | 5 |
| US-092 | Gerenciar usuários e lotações | P0 | M | 5 |
| US-093 | Selecionar órgão ativo | P1 | S | 2 |
| US-094 | Catálogo de permissões e perfis padrão | P0 | M | 5 |
| US-095 | Gerenciar perfis e matriz de permissões | P0 | M | 5 |
| US-096 | Atribuir perfis com escopo e vigência | P0 | M | 5 |
| US-097 | Autorização na API e no frontend | P0 | L | 8 |
| US-098 | Meu perfil e preferências | P1 | S | 2 |
| **Total** | | | | **57** |

## Módulos e entidades
- Módulos: `identity` (dono de `User`, `TenantMembership`, `MembershipDepartment`), `access` (dono de `Permission`, `Role`, `RolePermission`, `RoleAssignment`), `platform` (sessão, cache, outbox, contexto de requisição).
- Entidades consumidas: `Department`/`Organization` (EP-015, escopos), `ProcessParticipant`/`ProcessAccess` (EP-001/EP-013, visibilidade e participação).

## Telas
- SCR-001 — Login (`/entrar`)
- SCR-002 — Recuperar senha (`/recuperar-senha`)
- SCR-029 — Usuários (`/admin/usuarios`, `/admin/usuarios/[userId]`)
- SCR-030 — Perfis (`/admin/perfis`)
- SCR-031 — Permissões — matriz do perfil (`/admin/perfis/[roleId]`)
- SCR-039 — Meu perfil (`/perfil`)
- SCR-101 — Seleção de órgão (`/selecionar-orgao`)
- SCR-102 — Aceite de convite (`/convite/[token]`)
- SCR-111 — Páginas de erro e estados globais (403/404/500/sessão expirada/sem vínculo)

## Integrações
- **Externa:** Authentik (OIDC Authorization Code + PKCE, API administrativa para provisionamento e MFA — DEC-130).
- **Interna:** Redis (sessão, cache de permissões efetivas, idempotência — DEC-131/DEC-134), fila `email` (convites), `AsyncLocalStorage` (contexto de requisição — DEC-132).

## Eventos principais
- `UserInvited`, `MembershipActivated`, `MembershipUpdated`, `MembershipSuspended`, `MembershipReactivated`, `MembershipRevoked`, `MembershipExpired`
- `RoleCreated`, `RoleUpdated`, `RoleAssigned`, `RoleRevoked`

## Permissões envolvidas
- `USER_VIEW`, `USER_INVITE`, `USER_MANAGE`, `ROLE_VIEW`, `ROLE_MANAGE`, `ROLE_ASSIGN`
- O motor de autorização entregue por US-097 aplica, além destas, as 68 permissões do catálogo do MVP 1 (permissions.md §2) usadas pelos demais épicos.

## Regras configuráveis
- `security.mfaPolicy` (`NONE`/`ADMINS`/`ALL`) — exige MFA conforme risco da permissão.
- `security.sessionIdleMinutes` / `security.sessionAbsoluteHours` — duração da sessão.
- `security.externalMembershipMaxDays` — teto de vigência de vínculos `EXTERNAL`.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Rotas mutáveis com permissão/política declarada | 100% | Meta-teste de build (US-097) |
| Overhead de autorização (cache quente) | p95 < 5 ms | Teste de carga (US-097) |
| Tempo de ativação de convite (envio → vínculo `ACTIVE`) | < 48 h (mediana) | Telemetria de `UserInvited`→`MembershipActivated` |
| Incidentes de escalonamento de privilégio | 0 | Auditoria `access.denied` com `reasonCode = PRIVILEGE_ESCALATION_FORBIDDEN` |

## Dependências
- **Depende de:** EP-015 (estrutura organizacional — órgãos e unidades usados como escopo das atribuições), EP-017 (pré-requisito listado em `epics.md`).
- **Habilita:** EP-001 (Processo de contratação), EP-011 (Documentos) e, na prática, todos os demais épicos do MVP 1 — nenhuma ação de negócio existe sem autenticação e RBAC.

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Escalonamento de privilégio (usuário concede a si mesmo mais acesso) | Baixa | Alto | POL-13 (anti-escalonamento) em toda atribuição/edição de perfil; auditoria dedicada |
| Tenant perde o último administrador | Média | Alto | POL-12 (anti-bloqueio) bloqueia a ação com `LAST_ADMIN_REQUIRED` |
| Indisponibilidade do Redis de sessão | Baixa | Alto | Cluster HA Multi-AZ (DEC-131); BFF responde 503 de forma previsível |
| Vazamento de dados entre tenants | Baixa | Alto | RLS por `tenant_id` + suíte de testes "tenant leak" em toda rota |
| Rota nova esquece de declarar permissão | Média | Alto | Meta-teste de build falha o CI (US-097, RN-IAM-101) |

## Pontos em aberto
- Nenhum. As lacunas identificadas durante a especificação das stories (ver seção "Dependências → Lacunas nas fontes canônicas" de cada card) foram resolvidas com o conceito canônico mais próximo e não configuram pendência aberta deste épico.

## Definition of Done do épico
- [ ] Todas as features concluídas (FT-051 a FT-054)
- [ ] KPIs instrumentados (overhead de autorização, cobertura de decorators, tempo de ativação)
- [ ] Testes E2E das jornadas do épico passando (login → seleção de órgão → uso autorizado → logout; convite → ativação → atribuição de perfil)
- [ ] Suíte "tenant leak" cobrindo todas as rotas do épico
- [ ] Documentação e guia do usuário (login, convite, perfis, meu perfil) atualizados
