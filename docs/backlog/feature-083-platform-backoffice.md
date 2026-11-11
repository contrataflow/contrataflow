---
id: FT-083
title: "Backoffice da plataforma"
epic: EP-029
mvp: 2
priority: P1
stories: [US-178, US-179, US-180, US-181]
status: Especificada
---

# FT-083 — Backoffice da plataforma

## Título
Backoffice da plataforma

## Épico
EP-029 — Plataforma e backoffice

## Descrição
Área web própria (`/plataforma`, SCR-123), separada das telas do órgão, para os operadores da plataforma. Ela paga DT-07 (provisionamento sem tela) e DT-18 (acesso de suporte sem tela) com as mesmas operações que já existem na API e na CLI de plataforma (PLT-01..08 do MVP 1).

O operador entra pelo grupo próprio no Authentik, sempre com MFA. Dali ele provisiona um tenant e seus órgãos, acompanha e muda o ciclo de vida (ativar, suspender, encerrar, desativar), concede e encerra **acesso de suporte** (vínculo `EXTERNAL` por até 72 h, com chamado e justificativa) e consulta a **saúde operacional** por tenant. O backoffice **não lê processos nem documentos**: o suporte que precisa ver dados entra no tenant com perfil e prazo, e isso fica na auditoria do próprio tenant.

## Valor para o usuário e para o órgão
- O operador provisiona e suspende tenants em minutos, sem terminal e sem erro de digitação.
- O administrador do órgão enxerga quem do suporte entrou, por quê, com qual perfil e até quando.
- A equipe da plataforma detecta fila travada, limite de IA estourado ou reconciliação atrasada antes de o órgão reclamar.

## Personas
- Operador da plataforma (`User.isPlatformOperator`) — usa todo o backoffice.
- Administrador do órgão (`ADMIN_ORGAO`) — vê as ações de operador na auditoria do tenant e pode encerrar o acesso de suporte.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-178 ⏳ | Acesso ao backoffice e provisionamento de tenant e órgãos | P1 | L | US-087, US-090, US-099 |
| US-179 ⏳ | Ciclo de vida do tenant no backoffice | P1 | M | US-178 |
| US-180 ⏳ | Conceder e encerrar acesso de suporte | P1 | M | US-073, US-178 |
| US-181 ⏳ | Saúde operacional por tenant no backoffice | P1 | M | US-085, US-116, US-178 |

## Escopo
- Acesso: operador com MFA sempre; rota e menu inexistentes para quem não é operador; auditoria `backoffice.access`.
- Provisionar tenant e órgãos (a operação da US-099), com resultado e erros legíveis.
- Ciclo de vida: ativar, suspender, encerrar (com data de fim da retenção) e desativar, com confirmação e motivo.
- Acesso de suporte: `SupportAccessGrant` com chamado, justificativa (≥ 20 caracteres), perfil com `allowExternalAssignment` e expiração ≤ 72 h; encerramento antecipado pelo operador ou pelo administrador do tenant; expiração pelo job `maintenance`.
- Saúde por tenant: filas e dead-letter, consumo e limites de IA, uso de storage e situação da reconciliação do read model; só indicadores, nunca conteúdo.

## Fora de escopo
- Leitura de processo, documento, comentário ou valor de qualquer tenant (DEC-208).
- Planos comerciais, cobrança e limites por tenant (PEND-17 — DEC-210).
- Edição de configurações de negócio do tenant pelo operador (fica com o administrador do órgão).
- Substituir o Bull Board (continua para filas e dead-letter) e a CLI de plataforma.

## Regras de negócio da feature
- RN-PLAT-01 — Só `User.isPlatformOperator` acessa `/plataforma` e `/platform/*`; MFA sempre, independentemente da política do tenant (DEC-078, DEC-208, POL-29).
- RN-PLAT-02 — O backoffice não devolve dado de processo nem de documento; testes de autorização verificam a ausência dessas rotas e campos (DEC-208).
- RN-PLAT-03 — Provisionar, suspender, encerrar e desativar usam as operações de plataforma da US-099 e emitem `TenantProvisioned`, `TenantSuspended`, `TenantOffboarded` e `TenantDeactivated` (DEC-208, DEC-078).
- RN-PLAT-04 — Acesso de suporte exige chamado, justificativa com no mínimo 20 caracteres e perfil permitido para atribuição externa; a expiração não passa de 72 h após o início (DEC-139, DEC-208).
- RN-PLAT-05 — Um operador tem no máximo um acesso de suporte `ACTIVE` por tenant; ao expirar ou encerrar, o vínculo `EXTERNAL` perde efeito na hora e o cache de permissões é invalidado (DEC-139).
- RN-PLAT-06 — Toda ação de operador é auditada com `actorType = PLATFORM_OPERATOR` e fica visível ao administrador do tenant (DEC-139, DEC-208).
- RN-PLAT-07 — A saúde operacional mostra só contadores, estados e limites (filas, IA, storage, reconciliação), sem conteúdo de tenant (DEC-208).

## Telas
- SCR-123 — Backoffice da plataforma (`/plataforma`): tenants, ciclo de vida, acesso de suporte, saúde.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /platform/tenants` — provisionar tenant e órgãos (estende PLT-01)
- `GET /platform/tenants` e `GET /platform/tenants/{id}` — listar e detalhar (estende PLT-02, PLT-03)
- `POST /platform/tenants/{id}/suspend`, `/activate`, `/offboard` e `/deactivate` — ciclo de vida (PLT-04..07)
- `POST /platform/tenants/{id}/support-access` — conceder acesso de suporte
- `POST /platform/support-access/{grantId}/end` — encerrar antes do prazo
- `GET /platform/tenants/{id}/health` — saúde operacional do tenant
- `GET /support-access` — lista dos acessos de suporte, para o administrador do tenant

## Entidades
- `SupportAccessGrant` — acesso de suporte (módulo `access`).
- `Tenant`, `Organization`, `TenantMembership` (`EXTERNAL`), `User` (`isPlatformOperator`), `AuditLog`.

## Eventos
- `TenantProvisioned`, `TenantActivated`, `TenantSuspended`, `TenantOffboarded`, `TenantDeactivated` — ciclo de vida (MVP 1).
- `SupportAccessGranted` — ao conceder; `SupportAccessEnded` — ao encerrar ou expirar.

## Permissões
- `PLATFORM_TENANT_MANAGE` — provisionar e ciclo de vida.
- `PLATFORM_SUPPORT_ACCESS` — conceder e encerrar acesso de suporte.
- `PLATFORM_HEALTH_VIEW` (nova) — saúde operacional.
- `PLATFORM_QUEUE_ADMIN`, `PLATFORM_AUDIT_VIEW` — filas e auditoria de plataforma.
- `AUDIT_VIEW` (tenant) — ver as ações de operador.

## Dependências
- US-099 (provisionamento), US-087 e US-090 (autenticação e MFA), US-073 (auditoria), US-085 (storage), US-116 (limites de IA); DEC-078, DEC-139, DEC-208.
- A reconciliação do read model (EP-028) alimenta um dos indicadores de saúde; sem ela o indicador aparece como "não disponível".

## Critérios de aceite da feature
```gherkin
Feature: Backoffice da plataforma
  Scenario: Provisionar um tenant e dar suporte por tempo limitado
    Given que "Rui" é operador da plataforma com MFA ativo
    When "Rui" provisionar o tenant "prefeitura-exemplo" com um órgão principal
    And um chamado "CH-2031" exigir apoio ao administrador do órgão
    And "Rui" conceder acesso de suporte com o perfil "SUPORTE_EXTERNO" por 24 horas
    Then o acesso deve aparecer ativo na lista do administrador do tenant com o chamado e o prazo
    And a auditoria do tenant deve registrar "support.access_grant" com "actorType = PLATFORM_OPERATOR"
    And depois de 24 horas o acesso deve ficar "EXPIRED" e o vínculo externo deixar de valer

  Scenario: O backoffice não expõe dados do tenant
    Given que "Rui" está no backoffice
    When "Rui" abrir a saúde operacional do tenant "prefeitura-exemplo"
    Then devem aparecer apenas filas, consumo de IA, storage e reconciliação
    And nenhum processo, documento ou comentário do tenant deve ser retornado
```

## Métricas de sucesso
- 100% dos tenants novos provisionados pelo backoffice.
- 100% dos acessos de suporte com chamado e prazo ≤ 72 h.
- Tempo de provisionamento ≤ 10 min por tenant.

## Riscos
- Operador com acesso amplo demais — MFA sempre, permissões separadas por tela e auditoria visível ao tenant.
- Acesso de suporte esquecido — expiração automática e encerramento antecipado.
- Indicador de saúde vazar dado — só contadores e estados, com teste de autorização.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
