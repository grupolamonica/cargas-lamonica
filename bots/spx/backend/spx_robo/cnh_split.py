"""Split da CNH-e (PDF) em frente/verso (imagens PNG) para upload no SPX.

O SPX exige IMAGENS separadas em license_img_front/back, mas o cadastro guarda a
CNH como 1 PDF (foto da CNH-e gov.br — frente+verso na mesma página, em blocos
VERDES). Este módulo renderiza a página a 300 DPI e recorta as 2 regiões verdes
(com fallback geométrico). Portado fielmente de CortePDFFrenteeVerso/processor.py
da produção.

⚠ Dependências pesadas (PyMuPDF/opencv/numpy/Pillow) são importadas LAZY dentro
das funções: se a imagem do container ainda não tiver as libs, `import cnh_split`
NÃO quebra o boot — o split só falha (best-effort) e o caller cai no PDF cru.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("spx_cnh_split")


def process_cnh_pdf(pdf_bytes: bytes) -> tuple[bytes, bytes]:
    """Recebe os bytes de um CNH-e PDF e retorna (frente_png, verso_png)."""
    import io

    import fitz  # PyMuPDF
    import cv2
    import numpy as np
    from PIL import Image

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    if len(doc) == 0:
        raise ValueError("O PDF está vazio.")

    page = doc[0]

    # DPI 300
    zoom = 300 / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)

    img_data = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        img_data = cv2.cvtColor(img_data, cv2.COLOR_RGBA2RGB)

    # ── Busca dirigida por regiões VERDES (CNH-e gov.br) ──────────────────────
    hsv = cv2.cvtColor(img_data, cv2.COLOR_RGB2HSV)
    lower_green = np.array([30, 40, 40])
    upper_green = np.array([90, 255, 255])
    mask = cv2.inRange(hsv, lower_green, upper_green)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (35, 35))
    mask_closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask_dilated = cv2.dilate(mask_closed, kernel, iterations=1)

    contours, _ = cv2.findContours(mask_dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    frente_crop, verso_crop = None, None

    if contours:
        valid_contours = sorted(contours, key=cv2.contourArea, reverse=True)
        valid_contours = [c for c in valid_contours if cv2.contourArea(c) > 50000]

        if len(valid_contours) >= 2:
            bbox1 = cv2.boundingRect(valid_contours[0])
            bbox2 = cv2.boundingRect(valid_contours[1])
            boxes = sorted([bbox1, bbox2], key=lambda b: b[1])  # frente = topo
            x1, y1, w1, h1 = boxes[0]
            x2, y2, w2, h2 = x1, y1 + h1, w1, h1  # verso logo abaixo
            pd = 15
            h_img, w_img = img_data.shape[:2]
            frente_crop = img_data[max(0, y1 - pd):min(h_img, y1 + h1 + pd), max(0, x1 - pd):min(w_img, x1 + w1 + pd)]
            verso_crop = img_data[max(0, y2 - pd):min(h_img, y2 + h2 + pd), max(0, x2 - pd):min(w_img, x2 + w2 + pd)]
        elif len(valid_contours) == 1:
            x1, y1, w1, h1 = cv2.boundingRect(valid_contours[0])
            if h1 >= w1 * 0.8:
                # frente+verso grudados no mesmo bloco → corta na metade
                x2, y2, w2, h2 = x1, y1 + h1 // 2, w1, h1 - h1 // 2
                h1 = h1 // 2
            else:
                x2, y2, w2, h2 = x1, y1 + h1, w1, h1
            pd = 15
            h_img, w_img = img_data.shape[:2]
            frente_crop = img_data[max(0, y1 - pd):min(h_img, y1 + h1 + pd), max(0, x1 - pd):min(w_img, x1 + w1 + pd)]
            verso_crop = img_data[max(0, y2 - pd):min(h_img, y2 + h2 + pd), max(0, x2 - pd):min(w_img, x2 + w2 + pd)]

    # Fallback geométrico se a máscara verde falhar (CNH ocupa a metade superior)
    if frente_crop is None or verso_crop is None:
        cnh_completa = img_data[0:img_data.shape[0] // 2, :]
        cnh_h, cnh_w = cnh_completa.shape[:2]
        frente_crop = cnh_completa[0:cnh_h // 2, 0:cnh_w]
        verso_crop = cnh_completa[cnh_h // 2:cnh_h, 0:cnh_w]

    def _to_png(arr) -> bytes:
        out = io.BytesIO()
        Image.fromarray(arr).save(out, format="PNG")
        return out.getvalue()

    return _to_png(frente_crop), _to_png(verso_crop)


def split_cnh_to_files(pdf_path: str | Path) -> tuple[str | None, str | None]:
    """Lê um PDF de CNH, faz o split e grava frente/verso como PNG ao lado do
    arquivo (mesma pasta do sandbox). Retorna (frente_path, verso_path), ou
    (None, None) em qualquer falha (best-effort — caller cai no arquivo cru).
    """
    try:
        p = Path(pdf_path)
        if not p.is_file():
            return None, None
        frente_bytes, verso_bytes = process_cnh_pdf(p.read_bytes())
        frente_path = p.with_name(f"{p.stem}_cnh_frente.png")
        verso_path = p.with_name(f"{p.stem}_cnh_verso.png")
        frente_path.write_bytes(frente_bytes)
        verso_path.write_bytes(verso_bytes)
        log.info("CNH split OK: %s -> %s + %s", p.name, frente_path.name, verso_path.name)
        return str(frente_path), str(verso_path)
    except Exception as exc:
        log.warning("CNH split falhou para %s: %r (usando arquivo cru)", pdf_path, exc)
        return None, None
