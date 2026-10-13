# Vendored from OpenMontage

This directory is a vendored copy of the `remotion-composer/` subdirectory of
[OpenMontage](https://github.com/openmontage/openmontage), a React-based
Remotion renderer for agentic video production.

**Upstream commit vendored**: see `remotion-composer/package.json` version
(`openmontage-remotion-composer@1.0.0`) and OpenMontage source for the exact
revision this was copied from on 2026-10-13.

**License**: AGPL-3.0 (see [LICENSE](./LICENSE) in this directory).

## What this means for yt-autopilot

- yt-autopilot itself is **private, single-user, never hosted**. The AGPL
  network-use clause is satisfied vacuously: there are no third-party users
  interacting with the pipeline over a network.
- If that ever changes — if yt-autopilot is published, hosted as a service,
  or exposes any network-facing surface — this directory and the yt-autopilot
  code that calls it must be made available to users of that service under
  AGPL. Document that decision explicitly before any such change.
- Local modifications under this directory inherit AGPL. Keep them minimal and
  prefer upstreaming improvements to OpenMontage.

## Why vendored instead of installed

The upstream package is not published to npm as a reusable library — it's a
Remotion React project meant to be rendered via `npx remotion render`. The
whole subdir is 620 KB; vendoring is simpler than a submodule and freezes the
exact version this pipeline was tested against.
