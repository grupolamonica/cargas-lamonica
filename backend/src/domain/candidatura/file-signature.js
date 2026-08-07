// Identificação de tipo de arquivo por magic bytes (assinatura), não pelo MIME
// declarado pelo cliente.
//
// O multer só olha `file.mimetype`, que vem do multipart e é escolhido por quem
// envia: um .html ou um payload arbitrário chega com "image/png" no cabeçalho e
// passa a allowlist inteira. Como o arquivo depois vira uma signed URL servida a
// operador, aceitar o rótulo do cliente é confiar no atacante (achado BX-3).
//
// Escopo deliberadamente pequeno: só os 5 tipos aceitos pelo bucket
// `cadastro-drafts`. Sem dependência nova — a lista é curta e as assinaturas são
// estáveis.

// PDF: o header "%PDF-" não precisa estar no offset 0 (a spec admite lixo antes),
// então varremos o início do arquivo, como fazem os leitores de PDF.
const PDF_HEADER_SEARCH_WINDOW = 1024;

// Família HEIF: caixa ISO-BMFF `ftyp` no offset 4.
//
// Aceitamos QUALQUER marca, não só heic/heix/hevc/mif1/msf1. A lista fechada
// seria um pouco mais estrita, mas o custo de errar é assimétrico: uma marca de
// aparelho fora da lista vira 415 e o motorista não consegue enviar a CNH — falha
// no fluxo central do cadastro. O que se perde é a distinção entre HEIC e outro
// container ISO-BMFF (um MP4, por exemplo), que não é o vetor do achado: o risco
// é conteúdo ativo (HTML/SVG/script) servido pela signed URL, e esse continua
// barrado, porque não tem caixa `ftyp` nenhuma.

function startsWithBytes(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

/**
 * Detecta o tipo real do buffer. Retorna o MIME correspondente ou null quando a
 * assinatura não bate com nenhum tipo suportado.
 */
export function detectFileMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // JPEG — FF D8 FF (variantes JFIF/EXIF compartilham o mesmo prefixo).
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  // heic e heif compartilham container; o slot aceita os dois, então devolvemos a
  // marca genérica e a checagem trata como equivalentes.
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    return "image/heif";
  }

  if (buffer.subarray(0, PDF_HEADER_SEARCH_WINDOW).includes("%PDF-")) {
    return "application/pdf";
  }

  return null;
}

/**
 * Confere o MIME declarado contra a assinatura real.
 * image/heic e image/heif são o mesmo container — tratados como equivalentes.
 */
export function fileSignatureMatchesDeclaredType(buffer, declaredContentType) {
  const detected = detectFileMimeType(buffer);

  if (!detected) {
    return false;
  }

  if (detected === "image/heif") {
    return declaredContentType === "image/heic" || declaredContentType === "image/heif";
  }

  return detected === declaredContentType;
}
