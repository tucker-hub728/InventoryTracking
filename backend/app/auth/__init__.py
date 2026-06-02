"""Authentication module.

This is the **only** package allowed to import ``boto3``. Everything else
talks to Cognito through the thin functions exposed by ``cognito_client``.
This keeps the AWS SDK off the dependency graph of unrelated modules and
makes it trivial to swap the auth backend later (e.g. Auth0, Keycloak)
without grep-ing the codebase for ``boto3`` references.
"""
