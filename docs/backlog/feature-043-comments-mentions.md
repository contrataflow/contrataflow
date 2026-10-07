---
id: FT-043
title: "Comentários e menções"
epic: EP-012
mvp: 1
priority: P0
stories: [US-071, US-072]
status: Especificada
---

# FT-043 — Comentários e menções

## Título
Comentários e menções

## Épico
EP-012 — Comentários

## Descrição
Entrega o espaço de discussão contextual do processo: comentários no processo e em documentos (com âncora opcional em seção), respostas, edição e exclusão pelo autor, moderação por quem tem `COMMENT_MODERATE`, e menção a usuários e unidades dentro do texto, com notificação a quem tem visibilidade do processo.

## Valor para o usuário e para o órgão
- Substitui e-mails e mensageiros paralelos por uma discussão rastreável dentro do próprio processo.
- Reduz o tempo de resposta a pendências ao notificar diretamente quem precisa agir (menção) ou quem foi respondido.
- Preserva evidência: nada é excluído fisicamente (DEC-034); moderação registra motivo.

## Personas
- Área requisitante / colaborador / consultor (`REQUISITANTE`, `COLABORADOR`, `CONSULTANT`) — comenta, responde, menciona.
- Gestor de contratações / perfil com `COMMENT_MODERATE` — modera comentários de terceiros.
- Perfis só leitura (`AUDITOR`, `SOMENTE_LEITURA`) — leem comentários sem comentar.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-071 | Comentar no processo e em documentos | P0 | M | US-001, US-059 |
| US-072 | Mencionar usuários e unidades | P1 | M | US-071, US-111 |

## Escopo
- Comentar no processo e em documentos, com âncora opcional em seção.
- Responder (1 nível), editar (até 15 min pelo autor) e excluir (autor ou moderação).
- Autocomplete `@` para usuários e unidades (até 50 membros) com visibilidade do processo; notificação `MENTIONED`.

## Fora de escopo
- Comentários restritos por unidade (PEND-11).
- Resolução de comentário (`resolvedAt`/`resolvedById`) — P2, fora do MVP 1.
- Reações, anexos em comentário, histórico de versões do texto.

## Regras de negócio da feature
- Visibilidade do comentário = visibilidade do processo (DEC-024); documento `RESTRICTED` mascara o conteúdo para quem não atende POL-09 (RN-CMT-13).
- Processo em status final (`CANCELED`/`COMPLETED`/`PUBLISHED`) deixa comentários somente leitura, exceto moderação (RN-CMT-08).
- Menção só é possível e só notifica quem tem visibilidade do processo; unidades com mais de 50 membros ativos não são sugeridas (RN-CMT-21/22).
- Notificações desta feature (`COMMENT_REPLY`, `MENTIONED`) nunca levam valores do processo (POL-09).

## Telas
- SCR-006 — Detalhe do processo (`/processos/[id]`, aba Comentários)
- SCR-007 a SCR-012, SCR-105 — editores de documento com comentário embutido (detalhadas nas stories)

## Endpoints
- CMT-01 `GET /processes/{id}/comments` — listar comentários
- CMT-02 `POST /processes/{id}/comments` — criar/responder (com menções)
- CMT-03 `PATCH /comments/{id}` — editar (até 15 min)
- CMT-04 `DELETE /comments/{id}` — excluir (autor ou moderação)
- CMT-05 `GET /processes/{id}/mention-candidates?q=` — candidatos de menção

## Entidades
- `Comment` — comentário (processo ou documento, com resposta de 1 nível)
- `Mention` — menção a usuário ou unidade dentro de um comentário

## Eventos
- `CommentCreated` — criação/resposta
- `CommentUpdated` — edição
- `CommentDeleted` — exclusão (própria ou moderação)
- `UserMentioned` — menção criada

## Permissões
- `COMMENT_CREATE` — comentar, responder, mencionar
- `COMMENT_MODERATE` — excluir comentário de terceiro com motivo
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — ver conteúdo de comentário em documento com orçamento sigiloso (POL-09)

## Dependências
- **Features/stories:** US-001 (processo), US-059 (timeline), US-111 (`NotificationDispatcher`), US-012 (participantes), US-097 (visibilidade/escopo).
- **Decisões:** DEC-010, DEC-024, DEC-034, DEC-036, DEC-040, POL-09.

## Critérios de aceite da feature
```gherkin
Feature: Comentários e menções
  Scenario: Discutir a instrução de ponta a ponta, com menção
    Given que "Marcos" comenta no processo "0012/2026" mencionando "Cláudia"
    When "Cláudia" recebe a notificação "MENTIONED" e responde ao comentário de "Marcos"
    Then "Marcos" deve receber a notificação "COMMENT_REPLY"
    And a aba Comentários deve mostrar a thread com os dois comentários e a entrada "COMMENT_ADDED" na timeline
```

## Métricas de sucesso
- ≥ 50% dos processos ativos com ao menos um comentário em 30 dias.
- ≥ 99% das notificações `COMMENT_REPLY`/`MENTIONED` entregues com sucesso.

## Riscos
- XSS via rich text — mitigado por schema restrito server-side (RN-CMT-03).
- Menção notificar quem não tem acesso — mitigado por revalidação de visibilidade no commit (RN-CMT-22).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas (US-071, US-072)
- [ ] Jornada E2E da feature automatizada (comentar → mencionar → notificar → responder)
- [ ] Documentação atualizada
