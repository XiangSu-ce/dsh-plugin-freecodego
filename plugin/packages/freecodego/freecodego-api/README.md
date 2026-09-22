---
description: "The redacted native-host client for the FreeCodeGo v1 API: per-request credentials, an HTTPS-only deployment address, and the bootstrap, quota, health, and pricing routes."
kind: "package-reference"
---

# dsh-freecodego-api

English | [中文](README.zh.md)

## Summary

Redacted native-host client for the existing FreeCodeGo v1 API. It adapts the existing `/api/v1/freecodego/*` bootstrap, quota, health, and model-pricing routes without creating a second backend namespace, requires an HTTPS deployment address, and rejects catalog responses containing known credential fields.

## Table of Contents

- [Credential handling](#credential-handling)
- [Routes and namespace](#routes-and-namespace)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="credential-handling"></a>
## Credential handling

The caller supplies a short-lived access token from a host credential provider for each request. The client never stores that value.

Credential-shaped responses are refused at the boundary: a catalog response containing known credential fields is rejected rather than passed on, so a backend change cannot turn this client into a credential transport.

-----

<a id="routes-and-namespace"></a>
## Routes and namespace

The client requires an HTTPS deployment address and adapts the existing `/api/v1/freecodego/*` bootstrap, quota, health, and model-pricing routes without creating a second backend namespace.

-----

<a id="model-experience"></a>
## Model Experience

None, as the client only exchanges credential-redacted backend payloads and registers no tool, prompt section, or session event.

#### KV Cache effect

No request text is contributed, so a call made outside a model turn cannot change the cached prefix.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **HTTPS is required** — the deployment address must be an HTTPS origin.
- **Responses are screened, not trusted** — catalog payloads carrying known credential fields are rejected.
- **One namespace only** — the client adapts the existing `/api/v1/freecodego/*` routes instead of creating a second backend namespace.
- **The quota and pricing surface is the backend's** — the client reports what the service returns, and its totals are not reconstructed from per-turn request prefixes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the API client exposes no independently observable package-owned relationship beyond its request tests.

The endpoint-by-endpoint contract this client implements — which field owns routing outcomes and protocol selection — is recorded in [`docs/backend-contract.zh.md`](docs/backend-contract.zh.md).

</details>

**Runtime invariant:** no stored credential; every request carries a caller-supplied short-lived token.
