# `files`

Anexos: upload, antivírus e download (DEC-040).

- **US-068 (upload seguro):** ATT-02/03/04/06 (`AttachmentController`), o `file-scan`
  (`ScanFileJob` → `ScanFileProcessor`: trava condicional, _tee_ tipo + SHA-256 + ClamAV,
  promoção quarentena → `documents`) e a máquina de estados de `Attachment` (storage.md §5).
- O alvo do anexo vem da porta `AttachmentTargetRegistry` (`#shared/files`): `process` registra
  `PROCESS`; `document`, `DOCUMENT`/`DOCUMENT_VERSION`. Os demais módulos registram os seus.
- Storage pelo `StorageService` (guarda de tenant) com o adaptador S3 do `platform`; antivírus pelo
  `ClamavClient` (`CLAMAV_HOST`) — sem ele, as varreduras ficam adiadas (nunca liberadas).
- **US-064 (documento externo):** ATT-05 `GET /attachments/{id}/download` (`GetAttachmentDownloadQuery`:
  visível → `AVAILABLE` agora → `attachment.download` antes de assinar → URL `GET` ≤ 300 s do bucket
  `documents`) — base da prévia inline (PDF/PNG/JPEG por `fetch`). O `files` serve o arquivo do anexo
  ao `document` pela porta `AttachmentFileRegistry` (`#shared/files/attachment-files.ts`,
  `FilesAttachmentFileReader`). ATT-01 e a herança de POL-09 por documento `RESTRICTED` são da US-069.
