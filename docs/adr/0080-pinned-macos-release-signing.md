# ADR 0080: Pin the macOS release signing identity

Status: Accepted

## Context

Formal macOS packages must preserve the designated requirement of the installed app. The development identity selector prefers an available Apple Development certificate. Adding such a certificate can therefore change release identity unintentionally, causing the release package verification to reject the result after a full Universal build.

## Decision

The formal release script defaults to the public certificate fingerprint in `scripts/macos-release-identity.txt`, using the same private-key-backed certificate as existing Kiri releases. An explicit `KIRI_SIGNING_IDENTITY` still overrides this default. The development packaging selector remains independent. Identity verification against the installed app remains mandatory; the pin does not bypass it or permit ad-hoc signing.

## Consequences

Normal release rebuilds do not silently choose a newly installed development certificate. A certificate migration requires an explicit decision, pin update and installed-app identity review. Private keys remain in the local signing store and never enter the repository.
