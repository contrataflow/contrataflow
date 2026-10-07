---
id: FT-042
title: "Anexos"
epic: EP-011
mvp: 1
priority: P0
stories: [US-068, US-069, US-070]
status: Especificada
---

# FT-042 — Anexos

## Título
Anexos

## Épico
EP-011 — Documentos

## Descrição
Entrega o ciclo completo de arquivos anexados a qualquer alvo do processo (documento, versão, pesquisa de preços, comentário, tramitação, risco): upload seguro com quarentena e antivírus antes de qualquer disponibilização (US-068), visualização/download auditado por URL pré-assinada com prévia inline (US-069) e um indicador de presença para reduzir conflitos de edição concorrente (US-070, P2).

## Valor para o usuário e para o órgão
- Evidências e arquivos externos instruem o processo sem risco de circular malware na plataforma.
- Download sempre auditado, com trilha completa de quem acessou o quê e quando.
- Menos conflitos de edição "surpresa" entre colegas que trabalham no mesmo documento.

## Personas
- Qualquer usuário com acesso de edição ao alvo — anexa e exclui os próprios anexos.
- Qualquer usuário com `PROCESS_VIEW` — consulta, pré-visualiza e baixa anexos disponíveis.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-068 | Upload seguro de anexos | P0 | L | US-083, US-097 |
| US-069 | Visualizar e baixar anexos | P0 | S | US-068 |
| US-070 | Indicador de edição concorrente | P2 | M | US-015 |

## Escopo
- Intenção de upload → URL pré-assinada de quarentena → confirmação → varredura (*magic bytes* + ClamAV + SHA-256) → promoção a `AVAILABLE` ou `INFECTED`/`REJECTED`.
- Listagem, detalhe e download por URL pré-assinada (300 s) com auditoria prévia e prévia inline para PDF/PNG/JPEG.
- Heartbeat de presença (Redis, TTL 60 s) indicando quem está editando a mesma seção de um documento.

## Fora de escopo
- Verificação de autenticidade/assinatura do conteúdo do arquivo (fora do MVP 1).
- Edição colaborativa em tempo real com fusão automática de edições — PEND-12 (este épico entrega só o indicador de presença).

## Regras de negócio da feature
- **RN-DOC-71/72** — Intenção exige `ATTACHMENT_UPLOAD` + alvo editável; allowlist e tamanho verificados antes de assinar a URL.
- **RN-DOC-75** — Nunca libera sem varredura antivírus limpa; ClamAV fora do ar pausa o job sem promover o arquivo.
- **RN-DOC-79** — Exclusão lógica com motivo obrigatório; binário retido conforme política de retenção (PEND-07).
- **RN-DOC-83/84/85** — Download exige `AVAILABLE`; URL assinada por 300 s com `Content-Disposition: attachment`; auditoria gravada **antes** da URL.
- **RN-DOC-86** — Alvo `RESTRICTED` exige POL-09 para detalhe/download (herança registrada como proposta em storage.md §6).
- **RN-DOC-88/92** — Heartbeat de presença a cada 20 s, TTL 60 s; indisponibilidade do Redis nunca bloqueia a edição do documento (*fail-open*).

## Telas
- SCR-006, SCR-105 — componentes de anexo embutidos onde o alvo é exibido (sem tela dedicada — decisão registrada em US-068).

## Endpoints
- ATT-01 `GET /processes/{id}/attachments` — lista.
- ATT-02 `POST /attachments` — intenção de upload.
- ATT-03 `POST /attachments/{id}/confirm` — confirmação.
- ATT-04 `GET /attachments/{id}` — detalhe.
- ATT-05 `GET /attachments/{id}/download` — URL de download.
- ATT-06 `DELETE /attachments/{id}` — exclusão lógica.
- `DOC-24`/`DOC-25` `PUT`/`DELETE /documents/{id}/presence` (US-070) — heartbeat e saída de presença.

## Entidades
- `Attachment` — dono desta feature.

## Eventos
- `AttachmentUploaded`, `AttachmentRejected`, `AttachmentDeleted`.

## Permissões
- `ATTACHMENT_UPLOAD`, `ATTACHMENT_DELETE` — upload e exclusão.
- `PROCESS_VIEW` — listar, detalhar e baixar.

## Dependências
- **Stories:** US-083 (worker/filas do `file-scan`), US-097 (autorização base), US-015 (autosave, para a presença de US-070, outro épico).
- **Decisões/ADRs:** DEC-024, DEC-034, DEC-055, DEC-058, DEC-132, DEC-136, DEC-137; ADR-006.
- **Lacunas nas fontes canônicas:** nenhuma (`DOC-24`/`DOC-25` em api.md §3; herança de POL-09 por anexos ratificada em permissions.md).

## Critérios de aceite da feature
```gherkin
Feature: Anexos
  Scenario: Upload, varredura e download de um anexo
    Given que o usuário tem "ATTACHMENT_UPLOAD" sobre o documento "ETP 0003/2026"
    When ele enviar o arquivo "parecer.pdf" pelo fluxo seguro de upload
    Then o anexo deve ficar "AVAILABLE" somente após a varredura antivírus limpa
    And qualquer usuário com "PROCESS_VIEW" deve conseguir baixá-lo por URL pré-assinada
    And o download deve gerar um registro de auditoria "attachment.download"
```

## Métricas de sucesso
- 0 arquivos maliciosos promovidos a `AVAILABLE` (RN-DOC-75).
- Indicador de presença visível entre dois editores simultâneos em até 20 s (um ciclo de heartbeat).

## Riscos
- Upload de arquivo malicioso ou de tipo não permitido — mitigado por quarentena + *magic bytes* + ClamAV + allowlist (DEC-136).
- Indisponibilidade do Redis afetar a edição de documentos — mitigado pelo desenho *fail-open* de US-070 (RN-DOC-92).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas (US-070, P2, pode entrar em ciclo posterior)
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
