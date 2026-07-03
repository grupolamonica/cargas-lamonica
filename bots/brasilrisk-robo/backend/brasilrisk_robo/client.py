# -*- coding: utf-8 -*-
"""BRSystemClient — cliente HTTP para o BRSystem2 / Brasil Risk.

Diferente do SPX (token/JSON) e da AngelLira (REST), o BRSystem2 e um
ASP.NET MVC classico:
  - autenticacao por COOKIE de sessao (POST /Account/Login)
  - todo POST de formulario carrega um token anti-CSRF __RequestVerificationToken
    que precisa ser raspado do HTML da pagina (GET) e reenviado.

Este client cuida disso:
  - login() detecta os campos do form de login automaticamente e autentica
  - get_csrf_token(path) raspa o token de uma pagina
  - post_form()/post_multipart() injetam o token e detectam sessao expirada
"""

from __future__ import annotations

import re
import time
from typing import Any

import requests

from . import constants as K
from .logger import log_alerta, log_erro, log_info


# Token CSRF: tolera ordem name/value invertida no <input>.
_TOKEN_RE_A = re.compile(
    r'name="__RequestVerificationToken"[^>]*\bvalue="([^"]*)"', re.I)
_TOKEN_RE_B = re.compile(
    r'\bvalue="([^"]*)"[^>]*name="__RequestVerificationToken"', re.I)
_INPUT_RE = re.compile(r"<input\b[^>]*>", re.I)
_ATTR_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"')


class SessaoExpirada(RuntimeError):
    """Sessao BRSystem expirou (redirect para /Account/Login). Refazer login()."""


class BRSystemErro(RuntimeError):
    """Falha HTTP/aplicacao no BRSystem."""

    def __init__(self, msg: str, *, status: int | None = None, path: str = "",
                 body: str = ""):
        self.status = status
        self.path = path
        self.body = body
        super().__init__(f"{msg} (status={status} path={path})")


def _extrair_token(html: str) -> str | None:
    m = _TOKEN_RE_A.search(html) or _TOKEN_RE_B.search(html)
    return m.group(1) if m else None


def _parse_inputs(html: str) -> list[dict[str, str]]:
    out = []
    for tag in _INPUT_RE.findall(html):
        attrs = {k.lower(): v for k, v in _ATTR_RE.findall(tag)}
        out.append(attrs)
    return out


# UA padrao (Chrome no Windows). IMPORTANTE: o cookie cf_clearance do Cloudflare
# e amarrado ao User-Agent — pra reusar a sessao do navegador, o UA do robo tem
# que bater com o do navegador. Se nao bater, passe o seu via usar_sessao_navegador.
_UA_PADRAO = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36")


def _parse_cookie_header(header: str) -> dict[str, str]:
    """Converte 'a=1; b=2; c=3' (header Cookie do navegador) em dict."""
    out: dict[str, str] = {}
    for part in (header or "").split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


class BRSystemClient:
    def __init__(self, *, base_url: str | None = None, timeout: float = 30.0,
                 user_agent: str | None = None):
        self.base_url = (base_url or K.BASE_URL).rstrip("/")
        self.timeout = timeout
        self.sess = requests.Session()
        self.sess.headers.update({
            "User-Agent": user_agent or _UA_PADRAO,
            "Accept-Language": "pt-BR,pt;q=0.9",
        })
        self.autenticado = False

    def usar_sessao_navegador(self, cookie_header: str,
                              *, user_agent: str | None = None) -> None:
        """Reusa a sessao JA logada do navegador (pula login/senha e o Cloudflare).

        cookie_header: o valor do header `Cookie` copiado do DevTools (Network ->
            qualquer request do br2 -> Request Headers -> Cookie). Deve conter o
            cookie de sessao do app E o `cf_clearance` do Cloudflare.
        user_agent: copie o seu (mesmo lugar, header User-Agent). O cf_clearance
            so vale com o MESMO UA do navegador.
        """
        cookies = _parse_cookie_header(cookie_header)
        if not cookies:
            raise BRSystemErro("cookie_header vazio/invalido")
        if user_agent:
            self.sess.headers["User-Agent"] = user_agent
        self.sess.cookies.update(cookies)
        self.autenticado = True
        log_info(f"[sessao] reusando {len(cookies)} cookies do navegador "
                 f"(tem cf_clearance={'cf_clearance' in cookies})")

    # ── URL / sessao ───────────────────────────────────────────────────────

    def url(self, path: str) -> str:
        return f"{self.base_url}{path if path.startswith('/') else '/' + path}"

    def _checar_sessao(self, resp: requests.Response) -> None:
        # BRSystem redireciona pra /Account/Login quando a sessao cai.
        final = resp.url or ""
        if "/Account/Login" in final and self.autenticado:
            raise SessaoExpirada("redirecionado para /Account/Login")

    # ── Auth ────────────────────────────────────────────────────────────────

    def login(self, usuario: str, senha: str, *, extra: dict | None = None) -> None:
        """Autentica e guarda o cookie de sessao na Session.

        Detecta os campos do form de /Account/Login automaticamente (campo
        type=password -> senha; primeiro text/email -> usuario), entao nao
        depende dos nomes exatos. Passe `extra` para sobrescrever/adicionar.
        """
        login_url = self.url("/Account/Login")
        r = self.sess.get(login_url, timeout=self.timeout)
        r.raise_for_status()
        html = r.text

        token = _extrair_token(html)
        inputs = _parse_inputs(html)

        data: dict[str, str] = {}
        user_field = None
        pass_field = None
        for inp in inputs:
            name = inp.get("name")
            if not name:
                continue
            itype = (inp.get("type") or "text").lower()
            if itype == "password" and pass_field is None:
                pass_field = name
            elif itype in ("text", "email") and user_field is None \
                    and name != "__RequestVerificationToken":
                user_field = name
            elif itype == "hidden":
                data[name] = inp.get("value", "")

        if token:
            data["__RequestVerificationToken"] = token
        # Fallbacks se a deteccao falhar (CONFIRMAR nomes reais no HAR/HTML).
        data[user_field or "Login"] = usuario
        data[pass_field or "Senha"] = senha
        if extra:
            data.update(extra)

        log_info(f"[login] POST /Account/Login user_field={user_field} pass_field={pass_field}")
        resp = self.sess.post(login_url, data=data, timeout=self.timeout,
                              allow_redirects=True)
        resp.raise_for_status()

        # Sucesso = saiu da pagina de login.
        if "/Account/Login" in (resp.url or ""):
            raise BRSystemErro("login falhou (continuou em /Account/Login)",
                               status=resp.status_code, path="/Account/Login",
                               body=resp.text[:300])
        self.autenticado = True
        log_info("[login] sessao estabelecida")

    # ── CSRF / GET / POST ────────────────────────────────────────────────────

    def get_csrf_token(self, path: str) -> str:
        """GET na pagina e raspa o __RequestVerificationToken do HTML."""
        r = self.get(path)
        token = _extrair_token(r.text)
        if not token:
            log_alerta(f"[csrf] token nao encontrado em {path}")
        return token or ""

    def get(self, path: str, *, params: dict | None = None) -> requests.Response:
        r = self.sess.get(self.url(path), params=params, timeout=self.timeout)
        self._checar_sessao(r)
        return r

    def get_json(self, path: str, *, params: dict | None = None) -> Any:
        r = self.get(path, params=params)
        r.raise_for_status()
        try:
            return r.json()
        except ValueError:
            raise BRSystemErro("resposta nao-JSON", status=r.status_code,
                               path=path, body=r.text[:300])

    def post_form(self, path: str, data: dict, *, token: str | None = None,
                  add_token_from: str | None = None) -> requests.Response:
        """POST application/x-www-form-urlencoded.

        token: valor do CSRF (se None e add_token_from setado, raspa de la).
        """
        body = dict(data)
        if token is None and add_token_from:
            token = self.get_csrf_token(add_token_from)
        if token:
            body.setdefault("__RequestVerificationToken", token)
        r = self.sess.post(self.url(path), data=body, timeout=self.timeout,
                           allow_redirects=True)
        self._checar_sessao(r)
        return r

    def post_multipart(self, path: str, *, data: dict | None = None,
                       files: dict, token: str | None = None) -> requests.Response:
        body = dict(data or {})
        if token:
            body.setdefault("__RequestVerificationToken", token)
        r = self.sess.post(self.url(path), data=body, files=files,
                           timeout=self.timeout * 3)
        self._checar_sessao(r)
        return r
