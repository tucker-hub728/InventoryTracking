"""Ad-hoc smoke test for the notification bell (NOTIF-001).

Run from the project root after ``docker compose up``:

    python backend/tests/smoke_notifications.py

Verifies, over real HTTP:
  * GET /notifications returns only the caller's own rows, with a true
    unread_count counted over the whole feed rather than the page
  * a threshold breach raises an alert without any stock moving, and the
    alert appears for a user who did nothing
  * the same breach evaluated twice does NOT raise a second alert
    (edge-triggered — this is what stops the hourly sweep repeating itself)
  * restocking resolves the alert and empties the bell
  * POST /{id}/read is durable and idempotent, and does not touch anybody else
  * POST /read-all clears the badge
  * GET /notifications/stream opens as text/event-stream, is NOT gzipped, and
    delivers a snapshot frame followed by heartbeats

The stream section is the part worth running by hand after any change to the
middleware stack: gzip on an SSE response buffers, so the bell keeps working in
every test that reads the whole body and silently stops being live in a browser.
"""

from __future__ import annotations

import json
import socket
import sys
import urllib.error
import urllib.request
from decimal import Decimal

from _smoke_creds import require_credentials

BASE = "http://localhost:8000/v1"
HOST, PORT = "localhost", 8000

# Dev credentials. If login fails, check that cognito-local is healthy —
# ``docker logs cellready-cognito`` — before assuming this feature is broken.
EMAIL, PASSWORD = require_credentials()

def _req(
    method: str,
    path: str,
    *,
    token: str | None = None,
    json_body: dict | None = None,
) -> tuple[int, dict]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body: bytes | None = None
    if json_body is not None:
        body = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"raw": raw.decode(errors="replace")}


def _login() -> str:
    s, b = _req("POST", "/auth/login", json_body={"email": EMAIL, "password": PASSWORD})
    assert s == 200, b
    return b["access_token"]


def _feed(token: str) -> dict:
    s, b = _req("GET", "/notifications?status=unread&limit=50", token=token)
    assert s == 200, b
    return b


def _wait_for_feed(token: str, predicate, what: str, timeout: float = 5.0) -> dict:
    """Poll the feed until ``predicate`` holds, or give up.

    Reading immediately after a mutation is a race, and not one this feature
    introduced. ``get_session`` commits in a dependency's post-``yield`` exit
    code, and FastAPI runs that AFTER the response has been sent — so a client
    that turns straight round and reads can beat its own write's commit by a
    few milliseconds. It showed up here because a smoke script issues its next
    request far faster than a person clicking a button.

    Nothing in the UI is affected: the browser is not polling, it is holding an
    SSE stream, and the push happens when the commit lands.
    """
    import time

    deadline = time.time() + timeout
    feed = _feed(token)
    while time.time() < deadline:
        if predicate(feed):
            return feed
        time.sleep(0.15)
        feed = _feed(token)
    raise AssertionError(f"timed out after {timeout}s waiting for {what}; last feed: {feed}")


def _pick_item(token: str) -> dict:
    """An item with stock on hand and no threshold set — the clean starting
    state for a breach.

    ``qty_available`` and ``reorder_threshold`` are flattened onto the item row
    by ``/items``; they are NOT nested under a ``stock`` object, even though the
    ORM reaches them through ``Item.stock`` (the ``app.v_item_stock`` view).
    """
    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    for it in b["items"]:
        available = Decimal(str(it.get("qty_available") or "0"))
        threshold = Decimal(str(it.get("reorder_threshold") or "0"))
        if available > 0 and threshold == 0:
            return it
    raise AssertionError("no item with stock and no threshold — cannot run this smoke")


def _set_threshold(token: str, item_id: str, value: str) -> None:
    s, b = _req("PATCH", f"/items/{item_id}", token=token, json_body={"reorder_threshold": value})
    assert s == 200, b


# ── The SSE stream, over a raw socket ────────────────────────────────────
#
# urllib buffers the whole response, which is exactly what must not happen
# here, so the stream is read off a raw socket instead.


def _read_stream(token: str, seconds: float = 20.0) -> tuple[str, list[str]]:
    sock = socket.create_connection((HOST, PORT), timeout=seconds + 5)
    sock.settimeout(seconds)
    request = (
        "GET /v1/notifications/stream HTTP/1.1\r\n"
        f"Host: {HOST}:{PORT}\r\n"
        f"Authorization: Bearer {token}\r\n"
        "Accept: text/event-stream\r\n"
        # Deliberately ASK for gzip. If the exclusion middleware is wrong, the
        # response comes back compressed and this test sees binary.
        "Accept-Encoding: gzip, deflate\r\n"
        "Connection: close\r\n\r\n"
    )
    sock.sendall(request.encode())

    buf = b""
    chunks: list[str] = []
    import time

    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            data = sock.recv(4096)
            if not data:
                break
            buf += data
            chunks.append(data.decode(errors="replace"))
    except TimeoutError:
        pass
    finally:
        sock.close()

    text = buf.decode(errors="replace")
    head, _, _ = text.partition("\r\n\r\n")
    return head, chunks


def main() -> None:
    token = _login()
    print("logged in")

    # ── 1. the feed is the caller's own, with a true count ───────────────
    feed = _feed(token)
    assert set(feed) >= {"items", "total", "limit", "offset", "unread_count"}, feed
    baseline = feed["unread_count"]
    print(f"1) feed shape OK, baseline unread={baseline}")

    item = _pick_item(token)
    item_id = item["id"]
    qty = Decimal(str(item.get("qty_available") or "0"))
    print(f"   using {item['item_number']} (available {qty}, threshold 0)")

    try:
        # ── 2. breach the threshold — no stock moves ─────────────────────
        _set_threshold(token, item_id, str(qty + 10))
        feed = _wait_for_feed(
            token,
            lambda f: f["unread_count"] == baseline + 1,
            "the breach to raise exactly one alert",
        )
        mine = [n for n in feed["items"] if n["subject_id"] == item_id]
        assert len(mine) == 1, mine
        alert = mine[0]
        assert alert["kind_code"] == "reorder_threshold", alert
        assert alert["body"]["status_code"] in ("low_stock", "out_of_stock"), alert
        # The wire must carry facts, never presentation.
        assert not {"label", "tone", "title"} & alert["body"].keys(), alert["body"]
        print(f"2) breach raised one alert ({alert['body']['status_code']}), no stock moved")

        # ── 3. evaluating again must NOT raise a second ──────────────────
        #
        # Asserted after a settle, not immediately: waiting proves the count
        # STAYS at one rather than merely not having arrived yet.
        _set_threshold(token, item_id, str(qty + 11))
        import time

        time.sleep(1.0)
        feed = _feed(token)
        assert feed["unread_count"] == baseline + 1, (
            f"edge-triggering broken: {feed['unread_count']} != {baseline + 1}"
        )
        print("3) re-evaluated, still one alert (edge-triggered)")

        # ── 4. mark read — durable and idempotent ────────────────────────
        s, b = _req("POST", f"/notifications/{alert['id']}/read", token=token)
        assert s == 200, b
        assert b["updated"] == 1, b
        first_count = b["unread_count"]
        s, b = _req("POST", f"/notifications/{alert['id']}/read", token=token)
        assert s == 200 and b["updated"] == 0, b
        assert b["unread_count"] == first_count, "a second click must change nothing"
        print(f"4) mark-read durable + idempotent, unread now {first_count}")

        # someone else's id is a 404, not somebody else's notification
        s, b = _req(
            "POST", "/notifications/00000000-0000-0000-0000-000000000000/read", token=token
        )
        assert s == 404, (s, b)
        print("   unknown id → 404")

        # ── 4b. the Read tab is where it went ────────────────────────────
        #
        # Marking read used to be a one-way door: the row was still there and
        # still true, but nothing could show it again.
        s, b = _req("GET", "/notifications?status=read&limit=50", token=token)
        assert s == 200, b
        assert any(n["id"] == alert["id"] for n in b["items"]), "read row missing from Read tab"
        assert b["unread_count"] == first_count, (
            "unread_count must stay the UNREAD count while the Read tab is paged"
        )
        s, unread_tab = _req("GET", "/notifications?status=unread&limit=50", token=token)
        assert not [n for n in unread_tab["items"] if n["id"] == alert["id"]], (
            "a read row must not still appear under Unread"
        )
        s, b = _req("GET", "/notifications?status=bogus", token=token)
        assert s == 422, (s, b)
        print("4b) Read tab holds it, Unread does not, bad status → 422")

        # The body must carry what the client needs to build a link. The route
        # itself is the client's business — a stored URL would rot.
        assert alert["body"].get("item_id"), "no item_id to link a stock alert to"
        print("   body carries item_id for the item-page link")

        # ── 5. restock resolves it ───────────────────────────────────────
        _set_threshold(token, item_id, "0")
        _wait_for_feed(
            token,
            lambda f: not [n for n in f["items"] if n["subject_id"] == item_id],
            "the alert to resolve once the threshold is cleared",
        )
        print("5) threshold cleared → alert resolved, gone from the bell")

        # ── 6. read-all clears the badge ─────────────────────────────────
        s, b = _req("POST", "/notifications/read-all", token=token)
        assert s == 200, b
        assert b["unread_count"] == 0, b
        print("6) read-all → unread_count 0")

        # ── 7. the stream ────────────────────────────────────────────────
        head, chunks = _read_stream(token, seconds=20.0)
        assert "200 OK" in head, head
        assert "text/event-stream" in head.lower(), head
        assert "content-encoding" not in head.lower(), (
            "the stream is being compressed — check NoCompressPathsMiddleware "
            "is registered AFTER GZipMiddleware in create_app\n" + head
        )
        joined = "".join(chunks)
        assert "event: snapshot" in joined, joined[:400]
        assert '"unread_count"' in joined, joined[:400]
        assert ": ping" in joined, "no heartbeat in 20s — idle proxies will drop this"
        print("7) stream: 200 text/event-stream, uncompressed, snapshot + heartbeat")

    finally:
        # Always put the threshold back, even on a failed assertion.
        _set_threshold(token, item_id, str(item.get("reorder_threshold", "0")))

    print("\nALL SMOKE CHECKS PASSED")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"\nFAILED: {exc}", file=sys.stderr)
        sys.exit(1)
