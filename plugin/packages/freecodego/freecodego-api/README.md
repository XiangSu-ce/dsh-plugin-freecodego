---
description: "The redacted native-host client for the FreeCodeGo v1 API: per-request credentials, an HTTPS-only deployment address, and the bootstrap, quota, health, pricing, and payment routes."
kind: "package-reference"
---

# dsh-freecodego-api

English | [中文](README.zh.md)

## Summary

Redacted native-host client for the existing FreeCodeGo v1 API. It adapts the existing `/api/v1/freecodego/*` bootstrap, quota, health, model-pricing, and payment routes without creating a second backend namespace, requires an HTTPS deployment address, and rejects catalog responses containing known credential fields.

## Table of Contents

- [Credential handling](#credential-handling)
- [Routes and namespace](#routes-and-namespace)
- [Dev Note](#dev-note)

-----

<a id="credential-handling"></a>
## Credential handling

The caller supplies a short-lived access token from a host credential provider for each request. The client never stores that value.

Credential-shaped responses are refused at the boundary: a catalog response containing known credential fields is rejected rather than passed on, so a backend change cannot turn this client into a credential transport.

-----

<a id="routes-and-namespace"></a>
## Routes and namespace

The client requires an HTTPS deployment address and adapts the existing `/api/v1/freecodego/*` bootstrap, quota, health, model-pricing, and payment routes without creating a second backend namespace.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the API client exposes no independently observable package-owned relationship beyond its request tests.

The endpoint-by-endpoint contract this client implements — which field owns routing outcomes, billing, and protocol selection — is recorded in [`docs/backend-contract.zh.md`](docs/backend-contract.zh.md).

</details>

**Runtime invariant:** no stored credential; every request carries a caller-supplied short-lived token.
