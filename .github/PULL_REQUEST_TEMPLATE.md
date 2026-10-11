## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How you tested it

<!-- Which simulator or game, which pages, OBS version if it matters. -->

## Checklist

- [ ] `npm test` passes.
- [ ] No personal or client data: fixtures, tests, screenshots and sample state use the fictional Alpha / Bravo / Charlie / Delta teams and made-up player names. No real teams, players, events, emails or account IDs.
- [ ] No team logos, player photos or publisher artwork added. Any new font is OFL (or similar) with its licence file next to it.
- [ ] New or changed HTTP routes or WebSocket messages: I checked `agent/src/remote-policy.js`. A route remote seats should not reach has no rule; a route they should reach has a rule naming the roles, and a check in `agent/src/_selftest.js`.
- [ ] Any new secret in `settings` is added to `SECRET_PATHS` in `agent/src/remote-policy.js`.
- [ ] Screenshots attached for visual changes (control room, overlays, cards).
- [ ] Docs updated where behaviour changed (`CONTRACTS.md`, `agent/src/adapters/README.md`, `docs/`).

<!-- Your contribution is licensed under the licence of the files it changes: AGPL-3.0-or-later for the application, MIT for packs/ and overlays/_shared/. No CLA or sign-off is needed. -->
