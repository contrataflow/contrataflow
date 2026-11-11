---
id: FT-085
title: "Débitos técnicos do MVP 1"
epic: EP-029
mvp: 2
priority: P2
stories: [US-185, US-186, US-187, US-188]
status: Especificada
---

# FT-085 — Débitos técnicos do MVP 1

## Título
Débitos técnicos do MVP 1

## Épico
EP-029 — Plataforma e backoffice

## Descrição
Quatro débitos do MVP 1 aceitos como P2 e pagos aqui (DEC-209), sem mudar contrato de API do MVP 1 de forma incompatível:
- **DT-13:** reativar um perfil desativado (hoje só dá para duplicar — ROL-07);
- **DT-14:** avisar `ADMIN_ORGAO` e `AUDITOR` quando a verificação dos selos de auditoria detecta quebra, além do alerta operacional A21;
- **DT-15:** mostrar que há atualização da biblioteca padrão de templates, com diferença por `contentHash` e adoção assistida;
- **DT-16:** tornar configurável por tenant o limite do lote da caixa de tarefas.

DT-17 (prazo da aprovação avulsa) **não** faz parte desta feature: fica no EP-022.

## Valor para o usuário e para o órgão
- O administrador reativa um perfil sem recriá-lo e sem perder o histórico de atribuições.
- Uma quebra do selo de auditoria deixa de depender de alguém olhar o painel operacional.
- O órgão sabe quando a biblioteca de templates melhorou e adota a mudança sem sobrescrever o que customizou.
- Órgãos com muito volume ajustam o lote da caixa de tarefas ao seu uso.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — reativa perfis, adota atualizações de templates e ajusta o lote.
- Auditor (`AUDITOR`) — recebe a notificação de quebra do selo.
- Gestor de contratações e Compras — usam o lote ampliado na caixa de tarefas.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-185 ⏳ | Reativar perfil desativado (DT-13) | P2 | S | US-095 |
| US-186 ⏳ | Notificar a quebra do selo de auditoria (DT-14) | P2 | S | US-074, US-111 |
| US-187 ⏳ | Atualizar a biblioteca padrão de templates com adoção assistida (DT-15) | P2 | M | US-108, US-110 |
| US-188 ⏳ | Limite configurável do lote da caixa de tarefas (DT-16) | P2 | XS | US-058, US-103 |

## Escopo
- DT-13: caso de uso de reativação (`Role.isActive` volta a `true`; `deactivatedAt`/`deactivatedById` limpos ou preservados no histórico), com auditoria e invalidação do cache de permissões.
- DT-14: notificação `AUDIT_SEAL_BROKEN` (prioridade alta, com e-mail) aos vínculos ativos de `ADMIN_ORGAO` e `AUDITOR`, a partir do evento `AuditSealBroken`.
- DT-15: aviso `TEMPLATE_LIBRARY_UPDATE` (evento `TemplateLibraryUpdateAvailable`), diferença entre a versão publicada do tenant e a da biblioteca por `libraryContentHash`, e adoção assistida criando nova versão do template.
- DT-16: chave `inbox.bulkMaxItems` (padrão 50) dentro da faixa 2..`INBOX_BULK_MAX_ITEMS` da plataforma (padrão 200); a caixa de tarefas lê o limite do tenant.

## Fora de escopo
- DT-17 (EP-022) e os demais débitos do MVP 1 (DT-01, DT-04..DT-12, DT-19, DT-20).
- Carimbo de tempo externo para selos de auditoria (DT-05, MVP 3).
- Atualização automática de templates customizados: a adoção é sempre assistida.
- Reativar processos concluídos ou cancelados (PEND-03).

## Regras de negócio da feature
- RN-PLAT-15 — Reativar perfil exige `ROLE_MANAGE`; o perfil volta com as mesmas permissões e atribuições anteriores, sem alterar restrições, e o cache de permissões dos portadores é invalidado (DEC-209, DT-13).
- RN-PLAT-16 — A quebra do selo gera notificação `AUDIT_SEAL_BROKEN` a `ADMIN_ORGAO` e `AUDITOR`, sem desligar o alerta operacional A21; o texto não traz conteúdo auditado, só período, verificação (`DIGEST` ou `CHAIN`) e data de detecção (DEC-209, DT-14).
- RN-PLAT-17 — Há atualização de template quando `libraryContentHash` da biblioteca nova difere do da versão publicada do tenant; a adoção cria **nova versão** (nunca altera a publicada) e mostra a diferença antes de confirmar (DEC-209, DT-15).
- RN-PLAT-18 — Template do tenant sem origem na biblioteca (`libraryKey` nulo) não recebe oferta de atualização (DEC-209).
- RN-PLAT-19 — `inbox.bulkMaxItems` respeita o piso 2 e o teto `INBOX_BULK_MAX_ITEMS` definido pela plataforma; valor fora da faixa é recusado (DEC-209, DT-16).

## Telas
- Tela de perfis do administrador (ação "Reativar" em perfis desativados).
- Tela de templates (selo "atualização disponível", diferença e adoção assistida).
- Configurações gerais (lote da caixa de tarefas) e caixa de tarefas (SCR-013, ações em lote).
- Central de notificações (nova notificação de selo).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /roles/{id}/reactivate` — reativar perfil (par de ROL-08)
- `GET /templates/{id}/library-update` — diferença entre a versão publicada e a da biblioteca
- `POST /templates/{id}/library-update/adopt` — adotar a atualização como nova versão
- `PATCH /settings` — `inbox.bulkMaxItems` (estende SET-02); `POST /tasks/bulk-claim` e `/tasks/bulk-assign` passam a ler o limite do tenant (estende TSK-03, TSK-04)

## Entidades
- `Role` — `deactivatedAt` e `deactivatedById`.
- `DocumentTemplate` (`libraryKey`) e `DocumentTemplateVersion` (`libraryVersion`, `libraryContentHash`).
- `TenantSetting` (`inbox.bulkMaxItems`), `Notification` (tipos `AUDIT_SEAL_BROKEN`, `TEMPLATE_LIBRARY_UPDATE`).

## Eventos
- `RoleReactivated` — ao reativar perfil.
- `AuditSealBroken` — verificação dos selos falhou.
- `TemplateLibraryUpdateAvailable` — biblioteca nova com hash diferente; `TemplateLibraryUpdateAdopted` — adoção assistida.
- `TenantSettingsChanged` — mudança do lote.

## Permissões
- `ROLE_MANAGE` — reativar perfil.
- `TEMPLATE_PUBLISH` — adotar atualização de template; `TEMPLATE_VIEW` — ver a diferença.
- `SETTINGS_MANAGE` — lote da caixa de tarefas.
- `AUDIT_VIEW` — consultar a verificação dos selos.

## Dependências
- US-095 (perfis), US-074 (selos), US-111 (notificações), US-108 e US-110 (templates), US-058 e US-103 (lote e configurações); DEC-209.

## Critérios de aceite da feature
```gherkin
Feature: Débitos técnicos do MVP 1
  Scenario: Reativar perfil, adotar template e ajustar o lote
    Given que "Admin" é "ADMIN_ORGAO" e o perfil "Pregoeiro" está desativado
    When "Admin" reativar o perfil "Pregoeiro"
    And adotar a atualização da biblioteca do template "ETP" depois de conferir a diferença
    And alterar "inbox.bulkMaxItems" para 100
    Then os portadores do perfil devem recuperar as permissões
    And o template deve ganhar uma nova versão sem alterar a versão publicada anterior
    And a caixa de tarefas deve aceitar lotes de até 100 itens

  Scenario: Selo de auditoria quebrado avisa os responsáveis
    Given que a verificação dos selos encontra divergência no período de "2026-10"
    When o job de verificação terminar
    Then "ADMIN_ORGAO" e "AUDITOR" devem receber a notificação "AUDIT_SEAL_BROKEN"
    And o alerta operacional A21 deve continuar disparado
```

## Métricas de sucesso
- 100% das quebras de selo notificadas em até 5 min da detecção.
- Redução de perfis duplicados apenas para reativar (acompanhar `RoleReactivated` × `RoleCreated`).
- ≥ 70% das atualizações de template adotadas ou dispensadas explicitamente em 30 dias.

## Riscos
- Reativar perfil devolve permissões antigas a pessoas que não deveriam — auditoria `role.reactivate` e confirmação com resumo das permissões e dos portadores.
- Adoção assistida sobrescrever customização — nova versão, diferença exibida e nenhuma alteração da versão publicada.
- Lote grande demais degradar a caixa de tarefas — teto da plataforma e resultado por item.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
