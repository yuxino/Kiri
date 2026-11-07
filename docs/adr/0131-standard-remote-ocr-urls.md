# 0131 — Standard remote OCR URL validation

Date: 2026-11-07

Status: accepted

## Context

ADR 0007 restricts remote OCR to HTTPS, with a plain-HTTP exception only for
exact loopback development endpoints. This prevents users from saving a
self-hosted OpenAI-compatible OCR service at an RFC 1918 LAN address, as
reported in Issue #202. The product decision is to use the conventional AI
application model: accept standard HTTP or HTTPS service URLs rather than
maintaining a public/private address allowlist. Connection success is checked
only when the user explicitly sends an OCR image.

## Decision

- Remote OCR accepts absolute HTTP and HTTPS base URLs with a hostname on
  public or private networks. The profile name and model remain required.
- URLs must not contain userinfo, query parameters, or fragments because Kiri
  appends `/chat/completions` to the validated base path. Unsupported schemes
  and malformed URLs are rejected.
- The profile dialog validates the URL before IPC, keeps the draft open, and
  shows one localized validation message beside the Base URL field. Rust applies
  the same boundary checks before saving and again before a remote request.
- Exact loopback hosts and literal RFC 1918 private IPv4 addresses use the
  direct client with system proxy discovery disabled for either scheme. Other
  endpoints use the normal system-proxy client. This routing distinction does
  not restrict which standard URLs can be saved.
- Disabled redirects, disabled automatic retry/fallback, bounded requests,
  secure credential storage, and per-image destination disclosure with explicit
  Send/Retry remain unchanged.
- Plain HTTP does not encrypt the API key, selected image, or recognized text
  in transit. Users must trust the configured endpoint and network; HTTPS is
  recommended outside a trusted local environment.

## Consequences

Users can save and use a self-hosted OCR service at an address such as
`http://192.168.96.241:8002/v1`, including when editing an existing profile
while preserving its saved key. Public HTTP endpoints are also accepted as an
explicit product choice. A network observer can read or modify unencrypted HTTP
traffic, so accepting a URL never implies that it is safe or reachable.

## Verification

Component tests cover malformed URLs, unsupported schemes, userinfo, query
parameters, fragments, public HTTP, and the Issue URL, including the inline
message and preserved draft. Rust tests cover the same validation boundary,
endpoint construction, credential preservation, and direct/system-proxy route
classification. Tests use in-memory credentials and do not contact a real OCR
service or exercise a live proxy connection.
