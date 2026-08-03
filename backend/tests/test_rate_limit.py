"""Unit tests for the auth rate limiter (VR-002).

These exercise the limiter directly rather than through HTTP: the point is
the accounting (window, budget, pruning, reset), and driving it through
Cognito would make the tests slow and dependent on the emulator.
"""

from __future__ import annotations

import pytest
from app.core.exceptions import RateLimitedError
from app.core.rate_limit import SlidingWindowLimiter, account_key, client_key


def test_allows_up_to_the_budget() -> None:
    limiter = SlidingWindowLimiter(max_events=3, window_seconds=60)
    for _ in range(3):
        limiter.check("k")  # must not raise
        limiter.record_failure("k")


def test_blocks_once_budget_is_spent() -> None:
    limiter = SlidingWindowLimiter(max_events=3, window_seconds=60)
    for _ in range(3):
        limiter.record_failure("k")

    with pytest.raises(RateLimitedError) as excinfo:
        limiter.check("k")
    assert excinfo.value.code == "rate_limited"
    # The client is told how long to wait rather than left guessing.
    assert excinfo.value.details["retry_after_seconds"] > 0


def test_keys_are_independent() -> None:
    """One account being throttled must not lock out everyone else."""
    limiter = SlidingWindowLimiter(max_events=2, window_seconds=60)
    for _ in range(2):
        limiter.record_failure("a")

    with pytest.raises(RateLimitedError):
        limiter.check("a")
    limiter.check("b")  # unaffected


def test_window_expiry_restores_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """Old hits fall out of the sliding window."""
    clock = {"now": 1000.0}
    monkeypatch.setattr("app.core.rate_limit.time.monotonic", lambda: clock["now"])

    limiter = SlidingWindowLimiter(max_events=2, window_seconds=60)
    limiter.record_failure("k")
    limiter.record_failure("k")
    with pytest.raises(RateLimitedError):
        limiter.check("k")

    clock["now"] += 61  # past the window
    limiter.check("k")  # budget is back


def test_success_resets_the_key() -> None:
    """A user who fumbles then succeeds doesn't carry failures forward."""
    limiter = SlidingWindowLimiter(max_events=2, window_seconds=60)
    limiter.record_failure("k")
    limiter.record_failure("k")
    limiter.reset("k")
    limiter.check("k")


def test_sweep_does_not_grow_unboundedly(monkeypatch: pytest.MonkeyPatch) -> None:
    """Distinct keys must not accumulate forever.

    Without pruning, the limiter is itself a memory-exhaustion vector: an
    attacker just varies the source address to add a dict entry per request.
    """
    clock = {"now": 1000.0}
    monkeypatch.setattr("app.core.rate_limit.time.monotonic", lambda: clock["now"])

    limiter = SlidingWindowLimiter(max_events=5, window_seconds=10)
    for i in range(100):
        limiter.record_failure(f"ip:10.0.0.{i}")
    assert len(limiter._hits) == 100

    # Move past the window and trigger the (rate-limited) sweep.
    clock["now"] += 3600
    limiter.check("ip:new")

    # All 100 expired keys are gone. The key just checked remains — `check`
    # touches the defaultdict after the sweep — which is the live one, not a leak.
    assert "ip:10.0.0.0" not in limiter._hits
    assert "ip:10.0.0.99" not in limiter._hits
    assert set(limiter._hits) <= {"ip:new"}


def test_key_helpers() -> None:
    assert client_key("203.0.113.5") == "ip:203.0.113.5"
    # Unattributable traffic shares one bucket rather than bypassing the limit.
    assert client_key(None) == "ip:unknown"
    # Case/whitespace-insensitive so an attacker can't get a fresh budget by
    # varying the capitalisation of the address they're attacking.
    assert account_key("  Alice@Example.COM ") == account_key("alice@example.com")
