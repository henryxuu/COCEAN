# Secret boundary

The mandatory first-owner bootstrap credential is supplied through the external
path in `COCEAN_WEB_AUTH_FILE`; generate it with
`infra/scripts/generate_web_auth.sh`. It is mounted only into Server and is used
only when the local account table is empty. Normal sign-in then uses the COCEAN
login page and local session cookies.
Do not put the generated file in this repository, `.env`, Music, data, cache or
inbox or delivery. The Compose secret is never mounted into Web or Worker.

## Provider secrets are disabled

The current COCEAN release does not accept a Qobuz URL, Cookie, password or
Token. `provider-qobuz` is held at zero replicas, has no network and mounts no
secret or writable directory.

Do not place credentials in this directory. A future release must introduce a
separately reviewed secret contract before the Provider can be enabled.
