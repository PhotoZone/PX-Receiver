from __future__ import annotations

import ssl
from functools import lru_cache
from urllib import request

try:
    import certifi
except Exception:  # noqa: BLE001
    certifi = None


@lru_cache(maxsize=1)
def build_ssl_context() -> ssl.SSLContext:
    if certifi is not None:
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()


def urlopen_with_tls(req: request.Request, *, timeout: float):
    return request.urlopen(req, timeout=timeout, context=build_ssl_context())
