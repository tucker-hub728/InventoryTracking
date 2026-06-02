"""Authorisation primitives.

Separated from ``app.auth`` because ``auth`` is *authentication* (who are
you, prove it) and ``security`` is *authorisation* (you're in — what can
you do). They share users and roles but the routes that wire them in are
different concerns. Keeps the directory tree readable.
"""
