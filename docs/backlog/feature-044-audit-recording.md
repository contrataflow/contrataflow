---
id: FT-044
title: "Registro de auditoria"
epic: EP-013
mvp: 1
priority: P0
stories: [US-073, US-074]
status: Especificada
---

# FT-044 — Registro de auditoria

## Título
Registro de auditoria

## Épico
EP-013 — Auditoria

## Descrição
Entrega o mecanismo que escreve a trilha de auditoria e o que garante, periodicamente, que ela não foi adulterada. O `AuditService` (US-073) é chamado por todo caso de uso mutável do produto, na mesma transação da mudança de negócio, e cuida de contexto de requisição, mascaramento, coalescência de ações de alto volume e amostragem de acessos negados. A selagem (US-074) fecha, a cada hora, um resumo criptográfico encadeado por tenant, permitindo provar — sob demanda — que nenhum registro foi alterado, removido ou inserido fora de ordem desde a selagem.

## Valor para o usuário e para o órgão
- Nenhuma ação relevante fica sem evidência: 100% das mudanças de dados, decisões e acessos negados são registrados automaticamente, sem esforço do usuário.
- A integridade da trilha é verificável criptograficamente, sustentando a trilha como prova técnica em diligências do TCU/TCE, mesmo diante de suspeita de acesso privilegiado ao banco.
- Reduz o custo de conformidade: nenhuma equipe precisa instrumentar manualmente cada tela/endpoint para "lembrar" de auditar.

## Personas
- Desenvolvedor de qualquer módulo (`audit` como dependência transversal) — como usa: chama `AuditService.record(tx, …)` dentro da transação do seu caso de uso.
- Job agendado de selagem (`ActorType = SYSTEM`) — como usa: executa a selagem horária via worker de filas (US-083).
- Auditor / administrador do órgão (`AUDITOR`, `ADMIN_ORGAO`) — como usa: consulta selos e verifica integridade na tela SCR-037 (aba "Selos").

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-073 | Registrar auditoria transacional | P0 | L | US-081, US-084 |
| US-074 | Selagem de integridade da trilha de auditoria | P1 | M | US-073, US-083 |

## Escopo
- Serviço de registro transacional (`AuditService`) com contexto automático de requisição, mascaramento de dados sensíveis e hashing determinístico por registro (`rowHash`).
- Coalescência de ações de alto volume (ex.: `document.draft_update`) e amostragem de `access.denied`.
- Selagem horária por tenant com encadeamento criptográfico (`digest`/`chainHash`) e verificação de integridade sob demanda (`AUD-04`, `AUD-05`).

## Fora de escopo
- Consulta e exportação da trilha para usuários finais — tratado em FT-045.
- Alertas automáticos de quebra de integridade — log/métrica apenas neste MVP (lacuna registrada em US-074).
- Retenção/expurgo de longo prazo de `audit_logs` — PEND-07.

## Regras de negócio da feature
- A gravação do `AuditLog` é sempre atômica com a mudança de negócio que a originou — nunca existe uma sem a outra (RN-AUD-01).
- `audit_logs` e `audit_seals` são imutáveis por trigger de banco; a única forma de "correção" é a própria cadeia de selos detectar a divergência (RN-AUD-08, RN-AUD-11, RN-AUD-15).
- Nenhum perfil, incluindo `ADMIN_ORGAO`, pode desabilitar ou contornar o registro de auditoria.

## Telas
- SCR-037 — Auditoria (`/auditoria`), aba "Selos" (US-074). US-073 não tem tela própria.

## Endpoints
- AUD-04 `GET /api/v1/audit/seals` — listar selos do tenant
- AUD-05 `POST /api/v1/audit/seals/verify` — verificar integridade de um intervalo de selos
- (US-073 não expõe endpoint próprio — serviço interno consumido por todos os endpoints mutáveis do produto)

## Entidades
- `AuditLog` — registro individual de cada ação (US-073)
- `AuditSeal` — selo de integridade por período/tenant (US-074)

## Eventos
- Nenhum. A auditoria não publica eventos de domínio (DEC-161, DEC-025); é observável via `AuditLog`/`AuditSeal`, logs e métricas.

## Permissões
- `AUDIT_VIEW` — consultar selos (`AUD-04`) e disparar verificação (`AUD-05`); o registro em si (US-073) não exige permissão própria.

## Dependências
- US-081 (persistência Prisma/concorrência otimista), US-083 (worker com filas, retries e dead letter), US-084 (logs estruturados, correlationId e tracing); DEC-025, DEC-084, DEC-138, DEC-161.

## Critérios de aceite da feature
```gherkin
Feature: Registro de auditoria
  Scenario: Jornada ponta a ponta de registro e selagem
    Given que "Ana" cria um processo de contratação válido
    When a transação de criação for confirmada
    Then deve existir um "AuditLog" "process.create" íntegro, com rowHash calculado
    And, na próxima selagem horária, esse registro deve estar incluído no "digest" do "AuditSeal" do período
    And "Clara" (perfil AUDITOR) deve conseguir verificar essa selagem como "VALID" em "/auditoria"
```

## Métricas de sucesso
- 100% das transações mutáveis com `AuditLog` correspondente (meta-teste de cobertura, RN-AUD-09)
- Atraso da selagem horária < 5 min após o fechamento da hora

## Riscos
- Agendador do job de selagem parar silenciosamente — mitigado por métrica de "selos pendentes" com alerta (ver epic-013-audit.md).
- Redis indisponível interromper amostragem/coalescência — mitigado por degradação segura (grava tudo) em vez de falhar (RN-AUD-07).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas (US-073, US-074)
- [ ] Jornada E2E da feature automatizada (criar ação → ver AuditLog → selar → verificar integridade)
- [ ] Documentação atualizada
