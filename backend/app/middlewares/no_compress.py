"""Keep GZip away from streaming endpoints.

``GZipMiddleware`` honours ``minimum_size`` only for a response it receives
whole. A streaming response arrives as ``http.response.body`` messages with
``more_body=True``, and the middleware compresses those unconditionally — zlib
then buffers, because it has no way to know a flush point is wanted, and the
client receives nothing until enough bytes have accumulated or the response
ends. For a server-sent-events endpoint that means the bell appears to work in
tests (the stream does eventually flush) while showing nothing live, which is
the most expensive kind of broken.

Rather than fork or subclass ``GZipMiddleware``, this strips ``accept-encoding``
from the request before it gets there. GZip only engages when the client asks
for it, so removing the ask is enough, and it leaves the compression policy for
every other route exactly as it was.

**Registration order is the whole trick.** Starlette's ``add_middleware``
inserts at position 0 and the resulting stack is built outermost-first, so the
*last* middleware added is the *outermost* one. This must therefore be added
**after** ``GZipMiddleware`` in ``create_app`` to run **before** it. Added
before, it would sit inside GZip, strip a header GZip had already read, and do
nothing at all — silently.

Written as pure ASGI rather than ``BaseHTTPMiddleware`` on purpose: it needs to
mutate the request scope, and it must not interpose itself on the response
body of a long-lived stream.
"""

from __future__ import annotations

from collections.abc import Iterable

from starlette.types import ASGIApp, Receive, Scope, Send


class NoCompressPathsMiddleware:
    """Drop ``accept-encoding`` for requests whose path matches a prefix."""

    def __init__(self, app: ASGIApp, *, prefixes: Iterable[str] = ()) -> None:
        self.app = app
        self.prefixes = tuple(prefixes)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and self._matches(scope.get("path", "")):
            # Scope headers are a list of (name, value) byte pairs. Rebuild it
            # without the encoding negotiation; everything downstream, GZip
            # included, then sees a client that asked for identity.
            scope = dict(scope)
            scope["headers"] = [
                (name, value)
                for name, value in scope["headers"]
                if name.lower() != b"accept-encoding"
            ]
        await self.app(scope, receive, send)

    def _matches(self, path: str) -> bool:
        return any(path.startswith(p) for p in self.prefixes)
