# `identity`

Usuários, vínculos (TenantMembership), lotação, perfil do usuário e verificação do token de acesso (DEC-040, DEC-132).

Desde a US-087 (DEC-070):

- **Pipeline de guards:** `JwksTokenVerifier` (`TokenVerifierPort`, JWKS do Authentik com `jose`) e
  `PrismaIdentityRepository` (`UserPort`/`MembershipPort` sobre `users` e `cf_user_memberships`, pelo
  `PlatformTransaction`). Com `OIDC_FAKE_SIGNING_KEY` (local/dev/test) entram o `FakeJwksProvider` e o
  `InMemoryIdentityRepository` (diretório de `shared/testing/fake-directory.ts`).
- **Chaves de perfil (`roleKeys`, spec-531):** no banco, derivadas das atribuições vigentes de perfil
  ativo do próprio vínculo — coluna `role_keys` de `cf_user_memberships` e o fragmento
  `ROLE_KEYS_OF_MEMBERSHIP` de `membersInTenant`/`searchActiveMembers` (a mesma regra nos dois);
  no modo fake, do diretório. Significado e quem decide por elas: permissions.md §1.3.
- **Casos de uso:** `StartSessionCommand` (vínculo do `sub` no primeiro login, `lastLoginAt`),
  `RecordSessionTenantCommand` (confere o vínculo e grava `auth.session_start`/`auth.tenant_switch`),
  `ListMyMembershipsQuery` (ME-04) e `GetMyProfileQuery` (ME-01).
- **Rotas:** `GET /api/v1/me`, `GET /api/v1/me/memberships` e o contrato interno do BFF
  `POST /internal/session-events` (fora de `/api/v1`, credencial de serviço `X-CF-Service-Token`).
- **Auditoria:** `AuditTrailSessionRecorder` grava `auth.session_start`/`auth.tenant_switch` pela
  porta `AUDIT_TRAIL` (US-073), na instituição ativa, com o IP, o user-agent e o hash da sessão
  informados pelo BFF.

Desde a US-088 (DEC-131 · RN-IAM-24/28):

- **Varredura de encerramentos de sessão:** `RecordSessionEndingsCommand`, agendado a cada 60 s no
  processo da API por `SessionSweepScheduler` (como o job de partições da auditoria; vai para o
  worker na US-083). Só liga com `REDIS_SESSION_URL` (obrigatória fora de local/dev/test). O BFF
  troca a sessão encerrada (logout, expiração, renovação recusada, limite de sessões, vínculo
  encerrado) por um registro de encerramento **sem tokens** e a varredura o audita:
  `auth.session_end` ou `auth.session_expired` (`sessionEndAuditAction`), na instituição ativa
  da sessão, com o **horário real do fato** (`occurredAt` = o limite atingido), o ator = dono da
  sessão e o IP/user-agent guardados no registro. Sessão nunca mais acessada é encerrada pela própria
  varredura (`sessionExpiry`); sessão acessada depois do prazo agendado é só reagendada.
- **Ordem e falhas:** uma réplica por ciclo (trava `SET NX PX 50 s`), até 500 chaves por ciclo, cada
  auditoria na sua transação. O registro de encerramento só é apagado **depois** de gravar; com o
  banco fora ele fica no Redis e é refeito no ciclo seguinte com o horário original
  (`oncePerSession` impede o registro duplicado). Sessão sem instituição ativa (FA-07) é só removida.
  Redis fora no meio do ciclo encerra o ciclo sem lançar.
- **Portas:** `SESSION_REGISTRY` (`#shared/sessions/session-registry.js`, adaptador Redis no módulo
  `platform`; em memória nos testes) e `SessionAuditPort.sessionEnded`.
- **Logs e métrica:** `auth.sessions_swept` (info: `processed`, `recorded`, `deferred`);
  `auth.session_audit_deferred`, `auth.session_sweep_failed` e `auth.session_audit_skipped` (warn);
  contador `auth_sessions_expired_total{reason}`. Nunca a chave da sessão, tokens ou IP.

Desde a US-093 (DEC-075 · RN-IAM-65..72):

- **Troca de instituição ativa:** `TENANT_SWITCHED` em `POST /internal/session-events` aceita o
  vínculo escolhido (`membershipId`), conferido contra os vínculos do próprio usuário (de outra
  pessoa → 422 `REFERENCE_NOT_FOUND`), revalida status do vínculo e da instituição no banco e grava
  `auth.tenant_switch` (`fromTenantId`, `toTenantId`, `selection`). Para a instituição já ativa é
  no-op, sem auditoria.
- **MFA do destino:** porta `TENANT_MFA_POLICY` (`security.mfaPolicy`); com `ALL` e sessão sem
  segundo fator, a resposta traz `mfaRequired = true` e nada é gravado (o BFF conclui depois do
  _step-up_). `SettingsTenantMfaPolicy` lê `security.mfaPolicy` pela porta
  `TenantMfaSettings` (fonte registrada pelo `tenancy`), com cache de 60 s por tenant apagado no
  commit do SET-02 e pelo `TenantSettingsChanged` (RN-IAM-42); no modo de identidade fake,
  `InMemoryTenantMfaPolicy`. A regra pura fica em `#shared/auth/mfa-policy.js`.
- **Instituição padrão:** `setAsDefault` grava só `users.preferences.defaultTenantId` (sem
  `version`); o `session-events` devolve `defaultTenantId` para a seleção `DEFAULT` do login.

Desde a US-091 (RN-IAM-46..53 · DEC-012/130):

- **Convite (USR-03):** `InviteUserCommand` — `USER_INVITE` (+ MFA) e as referências (unidades e
  perfil ativos do tenant, validade do `EXTERNAL` ≤ `security.externalMembershipMaxDays`) numa
  leitura; sem conta no Authentik, `AuthentikAdminClient.provisionUser` (sem senha) ANTES da
  transação; numa transação: `User` (pelo e-mail, citext), `TenantMembership` `INVITED`
  (`REVOKED`/`EXPIRED` é reaproveitado), lotação, `RoleAssignment` inicial, `membership.invite` e
  `UserInvited`. Falha depois do Authentik → `removeUser` (compensação).
- **Token:** nunca na API. A transação deixa `invite_token_hash` nulo; o worker
  (`InvitationEmailEnqueuer` → `InvitationEmailSource`) gera o token no envio e grava o SHA-256.
- **Reenvio/cancelamento (USR-04/05):** reenvio zera o hash e renova 7 dias (até 5, 1 min entre
  eles — `invite_resend_count`/`invited_at`); cancelamento é revogação lógica.
- **Aceite/consulta (USR-06/14, `CROSS_TENANT_LOOKUP`):** `cf_find_invitation` pelo
  `SystemDbService`; ativação condicional (hash + validade) no tenant do convite
  (`runWithTenantScope`), `membership.activate` e `MembershipActivated`.
- **Portas:** `INVITATION_REPOSITORY` (Prisma ou o `InMemoryIdentityRepository`, que tem
  `deliverInvitation` para simular o e-mail nos testes), `AUTHENTIK_PROVISIONING` (= diretório do
  Authentik), `MEMBERSHIP_SETTINGS`; autorização, perfil e unidades pela `MembershipReferences`
  (`#shared/auth/membership-references.js`), registrada por `access` e `organization`.

Desde a US-092 (RN-IAM-54..64 · POL-12/16):

- **Gestão de vínculos (USR-07..12):** `GetMembershipQuery`, `UpdateMembershipCommand`,
  `UpdateMembershipDepartmentsCommand` e `ChangeMembershipStatusCommand` (suspender, reativar,
  revogar) sobre a porta `MEMBERSHIP_REPOSITORY` (`PrismaMembershipRepository` ou o
  `InMemoryIdentityRepository`). Toda gravação é condicional à `version` do `If-Match` (412) e as
  respostas trazem `meta.allowedActions`/`isSelf` (`DataResult` do envelope). Regras puras em
  `domain/membership-lifecycle.ts`.
- **POL-16** (próprio vínculo → 403, `access.denied` `POL-16`) e **POL-12**: a porta
  `MembershipReferences.adminMembershipIds` (lado `access`: atribuições vigentes do `ADMIN_ORGAO`)
  e `lockActiveMemberships` (`FOR UPDATE` em ordem de id, só `ACTIVE` não vencidos) — de duas
  remoções simultâneas de administradores, só uma passa (409 `LAST_ADMIN_REQUIRED`).
- **Efeitos:** `MembershipUpdated`/`Suspended`/`Reactivated`/`Revoked` no outbox (o worker invalida
  o cache de permissões e, na suspensão/revogação, encerra as sessões); depois do commit, `DEL` do
  cache `access:eff:{membershipId}` (Redis fora → `warn access.cache_invalidation_failed`). Logs
  `membership.mutation`/`membership.mutation_failed` e o histograma
  `cf_membership_mutation_duration_ms{action}`. Motivos de suspensão/revogação nunca vão para
  logs, eventos ou auditoria (só `hasReason`).

Desde a US-090 (RN-IAM-39..44 · DEC-142):

- **Redefinição do MFA (USR-13):** `ResetUserMfaCommand` — `USER_MANAGE` (+ MFA), vínculo no
  tenant (404), autoproteção (422 `NOT_ALLOWED`), não revogado (409); remove os dispositivos pela
  porta `AUTHENTIK_MFA` (`AuthentikAdminClient.resetMfa`, fora de transação, com 1 nova
  tentativa, depois 503) e grava `membership.mfa_reset` (`SECURITY`, com o motivo) numa transação
  própria. Sem escrita local além da auditoria e sem `If-Match`: idempotente. Log `identity.mfa_reset` sem o
  motivo.
- **ME-01 `mfaVerified`:** a sessão comprova o segundo fator (`amr`), sem método nem dispositivo.
