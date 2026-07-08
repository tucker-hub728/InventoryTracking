"""User-invitation flow.

An admin invites a new user; the system reserves a Cognito identity, persists
a single-use hashed link token here, and returns an accept URL the admin hands
over (there is no email delivery). The invitee opens the URL, sets a password,
and their ``app.users`` mirror is materialised. See ``app.models.invitations``.
"""
