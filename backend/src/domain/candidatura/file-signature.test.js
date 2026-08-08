import { describe, expect, it } from "vitest";

import { detectFileMimeType, fileSignatureMatchesDeclaredType } from "./file-signature.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
// FF D8 FF E1 = JPEG com APP1/EXIF, o que a camera do celular produz.
const JPEG_EXIF = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(16)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(16)]);

function heifWithBrand(brand) {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]), // tamanho da box
    Buffer.from("ftyp"),
    Buffer.from(brand),
    Buffer.alloc(16),
  ]);
}

describe("file-signature", () => {
  it("identifica os tipos aceitos pelo bucket de cadastro", () => {
    expect(detectFileMimeType(PNG)).toBe("image/png");
    expect(detectFileMimeType(JPEG_EXIF)).toBe("image/jpeg");
    expect(detectFileMimeType(PDF)).toBe("application/pdf");
    expect(detectFileMimeType(heifWithBrand("heic"))).toBe("image/heif");
    expect(detectFileMimeType(heifWithBrand("mif1"))).toBe("image/heif");
  });

  it("nao identifica conteudo fora da allowlist", () => {
    expect(detectFileMimeType(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectFileMimeType(Buffer.from("PK zip aqui........"))).toBeNull();
    expect(detectFileMimeType(Buffer.alloc(4))).toBeNull(); // curto demais
    expect(detectFileMimeType("nao e buffer")).toBeNull();
  });

  it("reprova quando o conteudo nao confere com o tipo declarado", () => {
    // O vetor do achado: payload arbitrario rotulado como imagem.
    expect(fileSignatureMatchesDeclaredType(Buffer.from("<html>...........</html>"), "image/png")).toBe(false);
    // Tipo aceito, mas trocado.
    expect(fileSignatureMatchesDeclaredType(PDF, "image/png")).toBe(false);
    expect(fileSignatureMatchesDeclaredType(PNG, "application/pdf")).toBe(false);
  });

  it("aceita heic e heif como equivalentes (mesmo container)", () => {
    expect(fileSignatureMatchesDeclaredType(heifWithBrand("heic"), "image/heic")).toBe(true);
    expect(fileSignatureMatchesDeclaredType(heifWithBrand("heic"), "image/heif")).toBe(true);
    expect(fileSignatureMatchesDeclaredType(heifWithBrand("hevc"), "image/heic")).toBe(true);
  });

  it("aceita marca ISO-BMFF desconhecida quando o motorista declara HEIC", () => {
    // Decisao deliberada: marca de aparelho fora de uma lista fechada viraria 415
    // e travaria o envio da CNH. O que importa e que nao ha conteudo ativo, e
    // isso a caixa `ftyp` ja garante.
    expect(fileSignatureMatchesDeclaredType(heifWithBrand("xyz9"), "image/heic")).toBe(true);
    // E continua nao valendo como PNG/JPEG/PDF.
    expect(fileSignatureMatchesDeclaredType(heifWithBrand("xyz9"), "image/png")).toBe(false);
  });

  it("aceita o caminho feliz de cada tipo", () => {
    expect(fileSignatureMatchesDeclaredType(PNG, "image/png")).toBe(true);
    expect(fileSignatureMatchesDeclaredType(JPEG_EXIF, "image/jpeg")).toBe(true);
    expect(fileSignatureMatchesDeclaredType(PDF, "application/pdf")).toBe(true);
  });
});
