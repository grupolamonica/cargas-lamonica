#!/usr/bin/env python
"""Smoke isolado do cliente GPT-4o Vision.

Uso::

    cd cadastro-motorista/backend
    python scripts/test_gpt4o_vision.py --doc cnh --image samples/cnh.jpg
    python scripts/test_gpt4o_vision.py --doc rntrc --image samples/rntrc.png

Lê ``.env`` da raiz do sidecar (mesmo path do config.py), chama ``extract()``
e imprime envelope JSON + tokens/USD consumidos.

Útil para validar prompts antes de plugar nos endpoints da Fase 2.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import sys
from pathlib import Path


_HERE = Path(__file__).resolve()
_SIDECAR_ROOT = _HERE.parent.parent  # cadastro-motorista/backend/
sys.path.insert(0, str(_SIDECAR_ROOT))


from backend import gpt4o_vision  # noqa: E402
from backend.prompts import OCR_PROMPTS  # noqa: E402


VALID_DOCS = sorted(OCR_PROMPTS.keys())


def _read_image_as_b64(path: Path) -> str:
    raw = path.read_bytes()
    if not raw:
        raise SystemExit(f"Arquivo vazio: {path}")
    return base64.b64encode(raw).decode("ascii")


def _validate_envelope_shape(env: dict) -> list[str]:
    """Retorna lista de problemas no envelope (vazia = OK)."""
    issues = []
    if not isinstance(env, dict):
        return ["envelope nao eh dict"]
    if env.get("code") != 200:
        issues.append(f"code != 200 (got {env.get('code')})")
    data = env.get("data")
    if not isinstance(data, list) or not data:
        issues.append("data deve ser lista nao-vazia")
        return issues
    item = data[0]
    if not isinstance(item, dict):
        issues.append("data[0] nao eh dict")
        return issues
    if "campos" not in item or not isinstance(item["campos"], dict):
        issues.append("data[0].campos ausente ou nao-dict")
    header = env.get("header")
    if not isinstance(header, dict):
        issues.append("header ausente")
    elif header.get("provider") != "gpt4o-vision":
        issues.append(f"header.provider != gpt4o-vision (got {header.get('provider')})")
    return issues


async def _run(doc_type: str, image_path: Path) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if not gpt4o_vision.init_client_from_env():
        print(
            "[FAIL] Cliente Vision nao inicializou — OPENAI_API_KEY ausente "
            "no .env ou openai SDK nao instalado.",
            file=sys.stderr,
        )
        return 2

    print(f"[INFO] doc_type={doc_type} image={image_path}")
    image_b64 = _read_image_as_b64(image_path)
    print(f"[INFO] imagem: {len(image_b64)} bytes (base64)")

    try:
        env = await gpt4o_vision.extract(doc_type, image_b64)
    except gpt4o_vision.GPT4oVisionError as exc:
        print(f"[FAIL] {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    issues = _validate_envelope_shape(env)
    if issues:
        print(f"[FAIL] Envelope invalido:", file=sys.stderr)
        for issue in issues:
            print(f"  - {issue}", file=sys.stderr)
        print("Envelope recebido:", file=sys.stderr)
        json.dump(env, sys.stderr, indent=2, ensure_ascii=False)
        return 1

    print("[OK]  Envelope valido. Campos extraidos:")
    campos = env["data"][0]["campos"]
    for k, v in campos.items():
        valor = v.get("valor") if isinstance(v, dict) else v
        print(f"   {k:32s} = {valor!r}")

    header = env.get("header", {})
    tokens = header.get("tokens", {})
    print()
    print(f"[INFO] model={header.get('model')} prompt_version={header.get('prompt_version')}")
    print(
        f"[INFO] tokens: in={tokens.get('in')} out={tokens.get('out')} "
        f"usd=${tokens.get('usd')}"
    )

    snap = gpt4o_vision.budget_snapshot()
    print(
        f"[INFO] budget UTC={snap['date_utc']} "
        f"spent=${snap['spent_usd']:.4f}/{snap['limit_usd']:.2f} "
        f"calls={snap['calls']}"
    )
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--doc",
        required=True,
        choices=VALID_DOCS,
        help=f"Tipo de documento. Opcoes: {', '.join(VALID_DOCS)}",
    )
    parser.add_argument(
        "--image",
        required=True,
        type=Path,
        help="Caminho para imagem (JPEG/PNG). PDFs nao sao suportados — rasterize antes.",
    )
    args = parser.parse_args()

    if not args.image.is_file():
        parser.error(f"Imagem nao encontrada: {args.image}")

    sys.exit(asyncio.run(_run(args.doc, args.image)))


if __name__ == "__main__":
    main()
