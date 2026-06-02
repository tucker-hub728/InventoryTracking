"""Ad-hoc smoke test for the S3 / signature path.

Not a pytest — just a script that exercises the full flow against a
running stack (login → upload → reauth → fetch signature). Useful
because the multipart upload is hard to script from a shell on
Windows where path quoting bites every time.

Run from the project root:

    python backend/tests/smoke_s3.py
"""

from __future__ import annotations

import json
import struct
import sys
import urllib.parse
import urllib.request
import zlib

BASE = "http://localhost:8000/v1"
EMAIL = "admin@cellready.local"
PASSWORD = "ChangeMe!Now123"


def _tiny_png() -> bytes:
    """Build a 2x2 PNG inline so we don't need Pillow."""
    sig = b"\x89PNG\r\n\x1a\n"

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(
            ">I", zlib.crc32(t + d) & 0xFFFFFFFF
        )

    ihdr = struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0)
    rows = [b"\xff\x00\x00\xff" * 2, b"\x00\xff\x00\xff" * 2]
    raw = b"".join(b"\x00" + row for row in rows)
    idat = zlib.compress(raw)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def _request(
    method: str,
    path: str,
    *,
    token: str | None = None,
    json_body: dict | None = None,
    multipart: tuple[str, str, bytes, str] | None = None,
    expect_bytes: bool = False,
) -> tuple[int, dict | bytes]:
    """Tiny urllib wrapper that returns (status, parsed-body)."""
    url = BASE + path
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body: bytes | None = None
    if json_body is not None:
        body = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif multipart is not None:
        field, filename, content, content_type = multipart
        boundary = "----smokeboundary"
        crlf = "\r\n"
        parts = [
            f"--{boundary}",
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"',
            f"Content-Type: {content_type}",
            "",
        ]
        prefix = (crlf.join(parts) + crlf).encode()
        suffix = (crlf + f"--{boundary}--" + crlf).encode()
        body = prefix + content + suffix
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            if expect_bytes:
                return resp.status, raw
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"raw": raw.decode(errors="replace")}


def main() -> int:
    print("==> login")
    status, login_body = _request(
        "POST", "/auth/login", json_body={"email": EMAIL, "password": PASSWORD}
    )
    assert status == 200, login_body
    token: str = login_body["access_token"]  # type: ignore[index]

    print("==> upload tiny PNG")
    png_bytes = _tiny_png()
    status, up = _request(
        "POST",
        "/uploads/signature",
        token=token,
        multipart=("file", "sig.png", png_bytes, "image/png"),
    )
    assert status == 201, up
    print(f"   key={up['key']!r} size={up['size']}")  # type: ignore[index]
    key = up["key"]  # type: ignore[index]

    print("==> reauth with signature key")
    status, evt = _request(
        "POST",
        "/auth/reauth",
        token=token,
        json_body={
            "action": "movement.dispense",
            "password": PASSWORD,
            "meaning": "smoke test signature",
            "signature_image_s3_key": key,
        },
    )
    assert status == 200, evt
    print(f"   evidence_id={evt['evidence_id']}")  # type: ignore[index]
    assert evt["signature_image_s3_key"] == key, evt  # type: ignore[index]
    ev_id = evt["evidence_id"]  # type: ignore[index]

    print("==> fetch signature for evidence")
    status, body = _request(
        "GET", f"/uploads/signature/{ev_id}", token=token, expect_bytes=True
    )
    assert status == 200, body
    assert isinstance(body, bytes) and body == png_bytes, "round-trip mismatch"
    print(f"   round-tripped {len(body)} bytes — match")

    print("==> bad content type (txt) — expect 422 signature_invalid_type")
    status, err = _request(
        "POST",
        "/uploads/signature",
        token=token,
        multipart=("file", "x.txt", b"hello", "text/plain"),
    )
    assert status == 422 and err.get("code") == "signature_invalid_type", err
    print(f"   ok ({status})")

    print("==> empty body — expect 422 signature_empty")
    status, err = _request(
        "POST",
        "/uploads/signature",
        token=token,
        multipart=("file", "empty.png", b"", "image/png"),
    )
    assert status == 422 and err.get("code") == "signature_empty", err
    print(f"   ok ({status})")

    print("==> reauth without signature key, then fetch — expect 404")
    status, evt2 = _request(
        "POST",
        "/auth/reauth",
        token=token,
        json_body={"action": "movement.receipt", "password": PASSWORD},
    )
    assert status == 200, evt2
    ev2 = evt2["evidence_id"]  # type: ignore[index]
    status, err = _request("GET", f"/uploads/signature/{ev2}", token=token)
    assert status == 404 and err.get("code") == "signature_not_found", err
    print(f"   ok ({status})")

    print()
    print("ALL SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
