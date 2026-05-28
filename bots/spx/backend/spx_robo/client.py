"""SPXClient: wrapper fino sobre requests.Session.

- Carrega cookies de arquivo JSON (auth.carregar_sessao_cookies)
- Anexa headers obrigatorios (device-id, app, version) em todo request
- Retry exponencial em rede / 5xx
- Detecta sessao expirada (401, 302 pra /login) e lanca SessaoExpirada
- Helpers .get_json() e .post_json() validam retcode automaticamente
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

from . import auth
from . import constants as K
from .logger import log_alerta, log_erro, log_info


_BASE_URL_DEFAULT = "https://logistics.myagencyservice.com.br"


class SessaoExpirada(RuntimeError):
    """Sessao SPX expirou — operador precisa reexportar cookies."""


class APIErro(RuntimeError):
    """retcode != 0 retornado pela API. Inclui retcode e message originais."""

    def __init__(self, retcode: int, message: str, *, path: str = "", data: Any = None):
        self.retcode = retcode
        self.message = message
        self.path = path
        self.data = data
        super().__init__(f"[{retcode}] {message} (path={path})")


def _base_url() -> str:
    return (os.getenv("SPX_BASE_URL") or _BASE_URL_DEFAULT).rstrip("/")


class SPXClient:
    """Cliente HTTP SPX. Inicializa com cookies + headers obrigatorios."""

    def __init__(
        self,
        cookie_file: Path | str | None = None,
        *,
        base_url: str | None = None,
        device_id: str | None = None,
        version: str | None = None,
        timeout: float = 30.0,
    ):
        self.base_url = (base_url or _base_url()).rstrip("/")
        self.timeout = timeout
        self.device_id = device_id or os.getenv("SPX_DEVICE_ID") or ""
        self.version = version or os.getenv("SPX_VERSION") or ""
        if not self.device_id:
            log_alerta("[client] SPX_DEVICE_ID nao definido — algumas chamadas podem falhar")
        if not self.version:
            log_alerta("[client] SPX_VERSION nao definido — usando placeholder")

        self._session = requests.Session()
        cookies = auth.carregar_sessao_cookies(cookie_file)
        self._session.cookies.update(cookies)
        self._session.headers.update(self._base_headers())

        # PERSISTENCIA DE COOKIES (2026-05-26): guarda path pra escrita posterior.
        # Apos cada request bem-sucedido, snapshot da jar e save_cookies_from_jar()
        # mantem o arquivo com a sessao mais recente — servidor SPX rotaciona
        # cookies em chamadas validas, entao isso renova a sessao sozinho
        # enquanto o sistema rodar regularmente.
        self._cookie_file_path = (
            Path(cookie_file).expanduser().resolve()
            if cookie_file
            else None
        )
        self._last_cookie_save_ts: float = 0.0
        self._last_cookie_snapshot: dict[str, str] = dict(
            (c.name, c.value or "") for c in self._session.cookies
        )

    # ── Headers ────────────────────────────────────────────────────────

    def _base_headers(self) -> dict[str, str]:
        h = {
            "Accept": K.HEADER_ACCEPT,
            "Content-Type": K.HEADER_CONTENT_TYPE_JSON,
            "app": K.HEADER_APP,
            "Origin": self.base_url,
            "Referer": f"{self.base_url}/",
        }
        if self.device_id:
            h["device-id"] = self.device_id
        if self.version:
            h["version"] = self.version
        return h

    # ── Request central ────────────────────────────────────────────────

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json_body: dict | None = None,
        files: dict | None = None,
        data: dict | None = None,
        timeout: float | None = None,
        max_retries: int = 3,
        allow_redirects: bool = False,
    ) -> requests.Response:
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        timeout = timeout or self.timeout

        # multipart: deixa requests setar o Content-Type com boundary correto.
        # NOTA: requests.Session mantem 'Content-Type: application/json' como default;
        # passar None explicitamente FORÇA o requests a remover esse header e calcular
        # o multipart/form-data;boundary=... dinamicamente a partir do dict `files`.
        headers = None
        if files is not None:
            headers = {k: v for k, v in self._base_headers().items() if k != "Content-Type"}
            headers["Content-Type"] = None  # type: ignore[assignment]

        last_err: Exception | None = None
        for tentativa in range(1, max_retries + 1):
            try:
                resp = self._session.request(
                    method.upper(), url,
                    params=params, json=json_body,
                    files=files, data=data,
                    headers=headers,
                    timeout=timeout,
                    allow_redirects=allow_redirects,
                )
                # 302 pra accounts.myagencyservice.com.br = sessao expirada
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("Location", "")
                    if "accounts.myagencyservice.com.br" in loc or "/login" in loc:
                        raise SessaoExpirada(
                            f"Sessao expirada (redirect para {urlparse(loc).netloc}). "
                            f"Reexporte cookies do Chrome."
                        )
                if resp.status_code == 401:
                    raise SessaoExpirada(f"401 em {path} — cookies invalidos/expirados")
                if resp.status_code >= 500 and tentativa < max_retries:
                    espera = 2 ** (tentativa - 1)
                    log_alerta(f"[client] {resp.status_code} em {path}, retry {tentativa}/{max_retries} em {espera}s")
                    time.sleep(espera)
                    continue
                # Persiste cookies apos resposta valida (Set-Cookie do servidor SPX
                # rotaciona a sessao). Debounced + skip-if-unchanged via snapshot.
                if resp.status_code < 400:
                    self._persistir_cookies_se_mudaram()
                return resp
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_err = exc
                if tentativa < max_retries:
                    espera = 2 ** (tentativa - 1)
                    log_alerta(f"[client] {type(exc).__name__} em {path}, retry {tentativa}/{max_retries} em {espera}s")
                    time.sleep(espera)
        assert last_err is not None
        raise last_err

    # ── Helpers que validam retcode ──────────────────────────────────────

    def _parse_envelope(self, resp: requests.Response, path: str) -> Any:
        """Valida o envelope {retcode, message, data}. Lanca APIErro se retcode != 0."""
        try:
            j = resp.json()
        except ValueError:
            raise APIErro(-1, f"resposta nao-JSON (status={resp.status_code}): {resp.text[:300]}", path=path)
        rc = j.get("retcode")
        msg = j.get("message", "")
        if rc != K.SUCCESS:
            human = K.RETCODE_MESSAGES.get(rc, msg or "erro desconhecido")
            log_erro(f"[client] {path} retornou retcode={rc} ({human})")
            raise APIErro(rc, human, path=path, data=j.get("data"))
        return j.get("data")

    def get_json(self, path: str, *, params: dict | None = None, timeout: float | None = None) -> Any:
        resp = self.request("GET", path, params=params, timeout=timeout)
        resp.raise_for_status()
        return self._parse_envelope(resp, path)

    def post_json(self, path: str, body: dict, *, timeout: float | None = None) -> Any:
        resp = self.request("POST", path, json_body=body, timeout=timeout)
        resp.raise_for_status()
        return self._parse_envelope(resp, path)

    def post_multipart(self, path: str, *, files: dict, data: dict | None = None, timeout: float | None = None) -> Any:
        resp = self.request("POST", path, files=files, data=data, timeout=timeout or 90.0)
        resp.raise_for_status()
        return self._parse_envelope(resp, path)

    # ── Health-check ────────────────────────────────────────────────────

    def ping(self) -> bool:
        """Smoke-test: tenta GET /api/basicserver/agency/account/current_user/basic_info.
        Retorna True se sessao valida.
        """
        try:
            self.get_json("/api/basicserver/agency/account/current_user/basic_info")
            return True
        except (SessaoExpirada, APIErro) as exc:
            log_alerta(f"[client] ping falhou: {exc}")
            return False

    def close(self) -> None:
        # Persiste antes de fechar — captura qualquer rotacao de cookie que o
        # servidor SPX tenha mandado nas ultimas chamadas.
        try:
            self._persistir_cookies_se_mudaram(force=True)
        except Exception:
            pass
        self._session.close()

    # ── Persistencia de cookies (PERSIST. 2026-05-26) ──────────────────────

    def _persistir_cookies_se_mudaram(self, *, force: bool = False) -> None:
        """Compara snapshot da jar com a anterior; se mudou, salva no arquivo.

        Args:
            force: ignora debounce (usado em close() pra garantir flush final).

        Estrategia:
        - Debounce: nao escreve mais que 1x a cada 30s (evita I/O excessivo)
        - Skip-if-unchanged: compara dict {name: value} pra detectar rotacao
        - Defensivo: nunca propaga excecao — falha silenciosa logada
        """
        try:
            now = time.time()
            if not force and (now - self._last_cookie_save_ts) < 30:
                return
            snapshot = dict((c.name, c.value or "") for c in self._session.cookies)
            if snapshot == self._last_cookie_snapshot:
                self._last_cookie_save_ts = now
                return
            escreveu = auth.save_cookies_from_jar(self._session.cookies, self._cookie_file_path)
            if escreveu:
                mudou = [n for n in snapshot if self._last_cookie_snapshot.get(n) != snapshot.get(n)]
                log_info(f"[client] cookies persistidos — mudaram: {sorted(mudou)[:5]}{'...' if len(mudou) > 5 else ''}")
            self._last_cookie_snapshot = snapshot
            self._last_cookie_save_ts = now
        except Exception as exc:
            log_alerta(f"[client] persistencia de cookies falhou (continuando): {exc}")
