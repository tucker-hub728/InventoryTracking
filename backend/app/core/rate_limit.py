"""Sliding-window rate limiting for unauthenticated endpoints.

There was no HTTP/IP-layer throttle anywhere in the application. The only
limiter in the codebase counts failed **e-sign reauth** attempts and is keyed
on an already-authenticated ``user_id``, so it cannot slow down someone
guessing at ``/v1/auth/login``: there is no user id until the guess succeeds.
That left login, refresh and set-password open to online brute-force and
credential stuffing at whatever rate the network allows.

This module is the app-layer control for that. It is deliberately
dependency-free and in-process.

**Know what this does and does not cover.** State lives in this worker's
memory, so with N gunicorn workers an attacker gets up to N× the configured
budget, and the counters reset on deploy. That makes it a speed bump against
online guessing — which is exactly the threat here, where the attacker needs
thousands of attempts — and NOT a substitute for an edge control. The
durable fix is a WAF/CloudFront rate rule plus Cognito advanced security
(adaptive authentication); this keeps the floor from being zero in the
meantime and protects deployments that never get an edge rule.

Two keys are checked for every login attempt:
  * **per-IP** — stops one host churning through a password list.
  * **per-account** — stops a distributed attempt at one high-value account,
    which a per-IP limit alone would miss entirely.

Failures are what count. A user legitimately signing in repeatedly is not
consuming budget; only a wrong answer does, so the limit cannot lock out
someone who simply uses the app a lot.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from app.core.exceptions import RateLimitedError
from app.core.logging import get_logger

log = get_logger(__name__)


class SlidingWindowLimiter:
    """Fixed budget of events per key within a rolling time window.

    A deque of timestamps per key is enough at this scale and keeps the
    accounting exact — no bucket-boundary effect where an attacker gets a
    double allowance by straddling two fixed windows.
    """

    def __init__(self, *, max_events: int, window_seconds: float) -> None:
        self.max_events = max_events
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        # Handlers are async but run across threads under gunicorn's worker
        # model; the deques are mutated from request context, so guard them.
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def _prune(self, key: str, now: float) -> deque[float]:
        hits = self._hits[key]
        cutoff = now - self.window_seconds
        while hits and hits[0] < cutoff:
            hits.popleft()
        return hits

    def _sweep(self, now: float) -> None:
        """Drop keys with no live hits.

        Without this the dict grows one entry per distinct IP forever, which
        would turn the rate limiter into its own memory-exhaustion vector —
        the attacker just varies the source address. Runs at most once a
        minute so it costs nothing on the hot path.
        """
        if now - self._last_sweep < 60:
            return
        self._last_sweep = now
        cutoff = now - self.window_seconds
        for key in [k for k, v in self._hits.items() if not v or v[-1] < cutoff]:
            del self._hits[key]

    def check(self, key: str) -> None:
        """Raise :class:`RateLimitedError` if ``key`` is over budget.

        Read-only — call this BEFORE doing the work. It does not consume
        budget; only :meth:`record_failure` does.
        """
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            hits = self._prune(key, now)
            if len(hits) < self.max_events:
                return
            retry_after = max(1, int(self.window_seconds - (now - hits[0])))

        log.warning("auth.rate_limited", key=key, retry_after=retry_after)
        raise RateLimitedError(
            "Too many failed attempts. Please wait and try again.",
            code="rate_limited",
            details={"retry_after_seconds": retry_after},
        )

    def record_failure(self, key: str) -> None:
        """Charge one failed attempt against ``key``."""
        now = time.monotonic()
        with self._lock:
            self._prune(key, now)
            self._hits[key].append(now)

    def reset(self, key: str) -> None:
        """Clear a key's history — called on a successful authentication so a
        user who mistyped twice and then got it right starts clean."""
        with self._lock:
            self._hits.pop(key, None)


# ── Configured limiters ─────────────────────────────────────────────────────
# Budgets are deliberately generous for a human (a person who has fumbled a
# password ten times in five minutes needs a reset, not another guess) and
# ruinous for a script.

#: Per source IP, across all accounts. Catches one host walking a list.
login_ip_limiter = SlidingWindowLimiter(max_events=10, window_seconds=300)

#: Per account, across all source IPs. Catches a distributed attempt at one
#: known address, which the per-IP limiter cannot see.
login_account_limiter = SlidingWindowLimiter(max_events=10, window_seconds=900)


def client_key(ip: str | None) -> str:
    """Limiter key for a source address.

    ``None`` (no trustworthy peer — see ``_client_ip``) collapses to a single
    shared bucket rather than being skipped: unattributable traffic should
    share one budget, not get an unlimited one.
    """
    return f"ip:{ip}" if ip else "ip:unknown"


def account_key(email: str) -> str:
    return f"acct:{email.strip().lower()}"


__all__ = [
    "SlidingWindowLimiter",
    "account_key",
    "client_key",
    "login_account_limiter",
    "login_ip_limiter",
]
