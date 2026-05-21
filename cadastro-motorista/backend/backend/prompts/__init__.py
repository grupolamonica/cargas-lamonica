"""Pacote de prompts versionados para chamadas LLM (GPT-4o Vision).

Cada prompt deve ser tratado como contrato — mudar o texto sem bumpar
``PROMPT_VERSION`` quebra rastreabilidade de respostas em produção.
"""

from .ocr_prompts import OCR_PROMPTS, PROMPT_VERSION, OcrPrompt

__all__ = ["OCR_PROMPTS", "PROMPT_VERSION", "OcrPrompt"]
