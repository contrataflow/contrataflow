# `identity`

Usuários, vínculos (TenantMembership), lotação, perfil do usuário e verificação do token de acesso (DEC-040, DEC-132).

Desde a US-087 (DEC-070):

- **Pipeline de guards:** `JwksTokenVerifier` (`TokenVerifierPort`, JWKS do Authentik com `jose`) e
  `PrismaIdentityRepository` (`UserPort`/`MembershipPort` sobre `users` e `cf_user_memberships`, pelo
  `PlatformTransaction`). Com `OIDC_FAKE_SIGNING_KEY` (local/dev/test) entram o `FakeJwksProvider` e o
  `InMemoryIdentityRepository` (diretório de `shared/testing/fake-directory.ts`).
- **Casos de uso:** `StartSessionCommand` (vínculo do `sub` no primeiro login, `lastLoginAt`),
  `RecordSessionTenantCommand` (confere o vínculo e grava `auth.session_start`/`auth.tenant_switch`),
  `ListMyMembershipsQuery` (ME-04) e `GetMyProfileQuery` (ME-01).
- **Rotas:** `GET /api/v1/me`, `GET /api/v1/me/memberships` e o contrato interno do BFF
  `POST /internal/session-events` (fora de `/api/v1`, credencial de serviço `X-CF-Service-Token`).
- **Auditoria:** `LogSessionAuditRecorder` registra a trilha `auth.*` como log estruturado até a
  auditoria transacional (US-073).
