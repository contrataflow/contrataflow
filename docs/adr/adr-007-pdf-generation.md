# ADR-007 — Geração de PDF com Gotenberg e hash SHA-256

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-060, DEC-058, DEC-085, DEC-136 |
| **Documentos** | [storage.md](../architecture/storage.md) · [queues.md §4.4](../architecture/queues.md) · [entities.md — `DocumentRendition`](../mvp-01/entities.md) · [story-067](../backlog/story-067-pdf-generation.md) · [story-109](../backlog/story-109-print-layout.md) |

## Contexto
- Todo documento tipado ou livre precisa de uma renderização oficial em PDF — para impressão, para evidência de aprovação e, no MVP 3, para assinatura — gerada a partir do conteúdo estruturado (`DocumentVersion.content` ou o rascunho), nunca redigida diretamente em PDF.
- Há três situações distintas: pré-visualizar um **rascunho** ainda não versionado, gerar o PDF de uma **versão** aprovada/finalizada, e gerar o PDF de uma versão **no momento de uma aprovação específica** (pode haver mais de uma aprovação sobre a mesma versão). As três precisam de prova de integridade (hash), mas com ciclos de retenção diferentes.
- Renderizar HTML em PDF por um motor de navegador leva segundos — incompatível com o orçamento de latência de uma requisição HTTP — e o volume é imprevisível entre tenants (um tenant gerando centenas de PDFs não pode atrasar os demais).
- Restrição de portabilidade (DEC-058): nada de serviço gerenciado proprietário de uma nuvem específica; precisa rodar também em ambiente local/on-premises.
- O pipeline deve reaproveitar a infraestrutura assíncrona já decidida (outbox/BullMQ do ADR-004) e o armazenamento S3-compatível (storage.md), e respeitar o mascaramento de valores sigilosos (POL-09) já aplicado antes da renderização.
- PDF/A-2b (formato de arquivamento de longo prazo) é pendência aberta (PEND-09): a necessidade atual é um PDF fiel, hasheado e imprimível, não necessariamente arquivístico.

## Decisão
1. Fila dedicada `document-render` (BullMQ, "padrão B" de queues.md — enfileira **depois** do commit, `jobId = renditionId`) consome `DocumentRendition` criada `PENDING` na mesma transação do pedido (`DOC-20` prévia / `DOC-21` conteúdo ou selo de aprovação — RN-DOC-64).
2. `RenderDocumentHandler`: trava condicional para `PROCESSING`; carrega o snapshot imutável `DocumentVersion.content` (`CONTENT`/`APPROVAL_STAMPED`) ou o rascunho atual (`PREVIEW`); resolve as variáveis do `LayoutDefinition` no servidor; gera HTML sanitizado (mesmas extensões do editor — DEC-056) e envia ao **Gotenberg** para a conversão HTML → PDF.
3. Sobre o PDF devolvido: calcula SHA-256, tamanho e páginas em trânsito; grava o binário no bucket `renditions` (S3/MinIO); persiste `DocumentRendition` (`READY`, `storageKey`, `sha256`, `sizeBytes`) e publica `DocumentRenditionReady`.
4. Quatro valores de `RenditionKind`: `PREVIEW` (do rascunho, marca d'água "RASCUNHO", sem `documentVersionId`, identificada por `draftRevision`, expira em 24 h), `CONTENT` (uma por versão), `APPROVAL_STAMPED` (uma por versão × aprovação — a mesma versão pode ser aprovada mais de uma vez) e `SIGNED`, reservada ao MVP 3.
5. Armazenamento em três *buckets* S3 por ciclo de vida, não por prefixo; o *bucket* `renditions` tem versionamento e **Object Lock** habilitado na criação (retenção por objeto), com tag `cf-retention=ephemeral` para `PREVIEW` (expira em 1 dia) e `cf-retention=evidence` para `CONTENT`/`APPROVAL_STAMPED`/`SIGNED` (classes frias, sem expiração automática); a validade de 24 h do `PREVIEW` é reforçada na aplicação (`DocumentRendition.expiresAt`) porque o *lifecycle* do S3 arredonda para a meia-noite UTC.
6. A prévia de layout de template (US-109, `TPL-12`/`TPL-13`) reaproveita o **mesmo** worker/fila/Gotenberg, mas renderiza seções do rascunho + dados de exemplo em vez de uma `DocumentVersion` real, e guarda o resultado efêmero em **Redis** (TTL 24 h), sem linha em `document_renditions` — evita duplicar infraestrutura de renderização só para uma prévia descartável.
7. Erros: Gotenberg 5xx/timeout/conexão são transitórios (até 5 tentativas, *backoff* exponencial com *jitter*, base 5 s; *circuit breaker* pausa a fila sem consumir tentativa); snapshot ausente, template/layout inválido ou 4xx do Gotenberg são permanentes (sem nova tentativa). Esgotadas as tentativas: `FAILED` + `errorCode` + `errorMessage` sanitizada, evento `DocumentRenditionFailed`, notificação `DOCUMENT_RENDER_FAILED` a quem pediu e cópia na `dead-letter`.
8. Download somente por URL pré-assinada de até 300 s (nunca pelo binário via API), exigindo `status = READY` e, se `PREVIEW`, dentro da validade; herda `PROCESS_VIEW`/POL-09 do documento (o PDF de quem não atende POL-09 já foi gerado mascarado); todo download é auditado (`document.download`).
9. SLOs: `PREVIEW` p95 ≤ 15 s (interativo, prioridade 1); `CONTENT`/`APPROVAL_STAMPED` p95 ≤ 30 s (prioridade 5); re-renderizações em lote, prioridade 10 — garantidos por um semáforo de concorrência por tenant (2 jobs simultâneos de `document-render`) para que a rajada de um tenant não atrase os demais.

## Alternativas consideradas
| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| **Puppeteer/Chromium próprio** (sem Gotenberg) | Controle total do processo de renderização | A equipe passaria a gerenciar ciclo de vida do Chromium, vazamento de memória e *patches* de segurança — exatamente o que o Gotenberg já resolve, embalado e com *health check* | **Rejeitada:** reinventa uma peça já resolvida e autoalojável, sem ganho de portabilidade ou capacidade |
| **PDFKit / geração programática** (desenho direto de texto e caixas) | Sem dependência de motor de renderização HTML | Duplicaria, numa API de desenho, o layout que o editor/template já resolve (margens, cabeçalho, rodapé, timbre — US-109); divergiria da prévia em tela | **Rejeitada:** HTML → PDF mantém uma única fonte de verdade de layout, compartilhada entre tela e PDF |
| **Serviço SaaS de renderização** (API de terceiros HTML → PDF) | Sem infraestrutura própria para operar | Envia conteúdo potencialmente sigiloso (orçamento, texto jurídico) a terceiro fora do perímetro contratado; dependência proprietária viola portabilidade (DEC-058); custo recorrente por página em volume ainda não validado | **Rejeitada:** confidencialidade e portabilidade pesam mais que a conveniência operacional; o Gotenberg já entrega conveniência equivalente, autoalojado e aberto |

## Consequências
**Positivas**
- Um único pipeline (worker + Gotenberg + hash) atende prévia, conteúdo final, selo de aprovação e prévia de layout de template — uma coisa só para operar, monitorar e proteger.
- SHA-256 em todo PDF, somado ao hash exibido no rodapé, dá um vínculo íntegro e verificável entre um impresso/baixado e a versão exata do sistema — base do futuro endpoint público de verificação (MVP 3).
- Fila assíncrona com prioridade por tipo e concorrência por tenant mantém baixa a latência interativa de `PREVIEW` mesmo com outro tenant re-renderizando em lote.
- Reaproveita o "padrão B" de outbox/BullMQ do ADR-004 e o armazenamento S3 já decidido — nenhuma classe de infraestrutura nova.

**Negativas**
- Dependência rígida da disponibilidade do Gotenberg e da fidelidade de conversão do Chromium; qualquer peculiaridade do motor (fontes, quebra de página) aparece como defeito de PDF em produção, não como *bug* de código.
- O mascaramento de orçamento sigiloso (POL-09) precisa estar correto **antes** da geração do HTML — uma falha ali vaza para um PDF imutável, hasheado e potencialmente de longa vida.
- Duas mecânicas de "prévia efêmera" coexistem (`DocumentRendition`/`PREVIEW` no S3 para rascunhos vs. estado só em Redis para prévia de template no US-109) — uma superfície extra para manter consistente.
- PDF/A-2b continua pendente (PEND-09): os PDFs de hoje não têm garantia de formato arquivístico de longo prazo.

## Riscos e mitigação
| Risco | Mitigação |
|---|---|
| Indisponibilidade ou sobrecarga do Gotenberg | *Circuit breaker* pausa a fila sem consumir tentativa; instâncias com *health check*, escaladas horizontalmente (≥ 2) |
| Upgrade do Gotenberg/Chromium muda a renderização e o hash | Versão do Gotenberg fixada; testes de regressão com documentos de referência antes de atualizar |
| `PREVIEW` sobrevive além do TTL de 24 h por arredondamento do *lifecycle* do S3 (meia-noite UTC) | `expiresAt` verificado na aplicação antes de assinar qualquer URL; job `maintenance` marca `PREVIEW` vencida como `EXPIRED` |
| Conteúdo sigiloso chega sem máscara ao PDF | Mascaramento (POL-09) aplicado no mesmo caminho de dados que o renderizador HTML consome; teste de fixture com processo sigiloso (FA-05) |
| PDF/A-2b se tornar exigência antes da resolução de PEND-09 | Revisitar antes de qualquer compromisso externo de arquivamento de longo prazo (portal de transparência, assinaturas do MVP 3) |

## Critérios de revisão
- PDF/A-2b passar a ser exigência legal obrigatória (PEND-09 resolvida) → revisitar o perfil/flags de conversão do Gotenberg e validar conformidade.
- Volume/latência de `document-render` romper o SLO de forma recorrente mesmo com o semáforo por tenant → revisitar escala horizontal do worker/Gotenberg ou uma camada dedicada de renderização.
- `SIGNED` (MVP 3) ou endpoint público de verificação de hash entrarem em escopo → revisitar retenção de armazenamento (Object Lock, §9.3) e o fluxo de download/auditoria para acesso externo.
- Prévia de layout de template (estado só em Redis) deixar de ser efêmera/descartável (ex.: precisar de compartilhamento ou retenção maior) → revisitar dar a ela uma `DocumentRendition` real.

## Referências
- DEC-060, DEC-058, DEC-085, DEC-136 — [decisions.md](../architecture/decisions.md).
- [storage.md](../architecture/storage.md) (bucket `renditions`, Object Lock, chaves, §3.2 *lifecycle*); [queues.md](../architecture/queues.md) §4.4 (`document-render`); [entities.md](../mvp-01/entities.md) (`DocumentRendition`, `RenditionKind`, `RenditionStatus`).
- Stories: [US-067](../backlog/story-067-pdf-generation.md) (RN-DOC-63…70), [US-109](../backlog/story-109-print-layout.md) (`TPL-12`/`TPL-13`).
- [ADR-004](adr-004-outbox-events.md) (outbox/BullMQ reaproveitados), [ADR-006](adr-006-document-model.md) (snapshot de origem).
