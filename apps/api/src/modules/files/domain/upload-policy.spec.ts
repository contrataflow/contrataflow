import { describe, expect, it } from 'vitest';

import { displayFileName, storageFileName } from './file-names.js';
import { classifyFinding } from './scan-verdict.js';
import { checkUpload, effectiveExtensions, extensionOf } from './upload-policy.js';

const LIMITS = { allowedExtensions: ['pdf', 'docx', 'png', 'jpg'], maxFileSizeMb: 50 };
const MB = 1024 * 1024;

describe('extensão e allowlist (RN-DOC-72)', () => {
  it.each([
    ['comprovante.PDF', 'pdf'],
    ['a.b.docx', 'docx'],
    ['sem-extensao', ''],
    ['.oculto', ''],
    ['termina.', ''],
    ['C:\\Users\\x\\foto.JPG', 'jpg'],
  ])('%s → %s', (name, extension) => {
    expect(extensionOf(name)).toBe(extension);
  });

  it('o tenant só restringe: extensão fora da plataforma não conta', () => {
    expect(effectiveExtensions({ allowedExtensions: ['pdf', 'exe'], maxFileSizeMb: 1 })).toEqual([
      'pdf',
    ]);
  });

  it('aceita extensão permitida com MIME coerente e tamanho até o limite', () => {
    expect(
      checkUpload(
        { fileName: 'a.pdf', declaredMimeType: 'application/pdf', sizeBytes: 50 * MB },
        LIMITS,
      ),
    ).toEqual({ ok: true, extension: 'pdf' });
    expect(
      checkUpload(
        { fileName: 'a.docx', declaredMimeType: 'application/octet-stream', sizeBytes: 1 },
        LIMITS,
      ),
    ).toEqual({ ok: true, extension: 'docx' });
  });

  it.each([
    ['script.exe', 'application/x-msdownload'],
    ['planilha.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['a.pdf', 'image/png'],
    ['imagem.png', 'application/pdf'],
    ['sem-extensao', 'application/pdf'],
  ])('%s (%s) → TYPE_NOT_ALLOWED', (fileName, declaredMimeType) => {
    expect(checkUpload({ fileName, declaredMimeType, sizeBytes: 10 }, LIMITS)).toEqual({
      ok: false,
      violation: 'TYPE_NOT_ALLOWED',
    });
  });

  it('acima de uploads.maxFileSizeMb → TOO_LARGE', () => {
    expect(
      checkUpload(
        { fileName: 'a.pdf', declaredMimeType: 'application/pdf', sizeBytes: 50 * MB + 1 },
        LIMITS,
      ),
    ).toEqual({ ok: false, violation: 'TOO_LARGE' });
  });
});

describe('nomes de arquivo (storage.md §4)', () => {
  it('exibição: sem caminho nem controles; vazio vira "arquivo"', () => {
    expect(displayFileName('C:\\fakepath\\Ata  da\u0007 reunião.pdf')).toBe('Ata da reunião.pdf');
    expect(displayFileName('../../etc/passwd')).toBe('passwd');
    expect(displayFileName('   ')).toBe('arquivo');
    expect(displayFileName('x'.repeat(300))).toHaveLength(255);
  });

  it('chave: NFKD sem acento, minúsculas, hífens, base ≤ 80 e extensão canônica', () => {
    expect(storageFileName('Orçamento Empresa X (v2).PDF', 'pdf')).toBe(
      'orcamento-empresa-x-v2.pdf',
    );
    expect(storageFileName('...', 'png')).toBe('arquivo.png');
    expect(storageFileName('foto.jpeg.exe', 'jpg')).toBe('foto.jpeg.jpg');
    const long = storageFileName(`${'a'.repeat(120)}.pdf`, 'pdf');
    expect(long).toBe(`${'a'.repeat(80)}.pdf`);
    expect(storageFileName('relatório final -- .docx', 'docx')).toBe('relatorio-final.docx');
  });
});

describe('veredito do antivírus (RN-DOC-76)', () => {
  it.each([
    ['Eicar-Test-Signature', 'INFECTED', 'INFECTED'],
    ['Win.Trojan.Agent-123', 'INFECTED', 'INFECTED'],
    ['Heuristics.Encrypted.PDF', 'REJECTED', 'ENCRYPTED_CONTENT'],
    ['Heuristics.Limits.Exceeded.MaxFileSize', 'REJECTED', 'SCAN_LIMITS_EXCEEDED'],
    ['Heuristics.OLE2.ContainsMacros', 'REJECTED', 'MACRO_CONTENT'],
  ])('%s → %s/%s', (signature, status, reasonCode) => {
    expect(classifyFinding(signature)).toEqual({ status, reasonCode });
  });
});
