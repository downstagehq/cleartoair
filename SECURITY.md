# Security policy

Clear to Air runs on the PC that puts a show on air. It holds the OBS password and
can cut program, start the stream and drive the graphics. A security bug here can
take a live broadcast off air or put something on it that should not be there.
Thank you for reporting carefully.

## How to report

**Report privately. Do not open a public issue, discussion or pull request for a
vulnerability.**

- **How:** GitHub private vulnerability reporting, under the repository's
  **Security** tab, "Report a vulnerability":
  https://github.com/downstagehq/cleartoair/security/advisories/new
- **Or email** security@downstage.co.za. Please do not post details anywhere public.

Please include:

- the Clear to Air version (Setup tab, or `GET /api/version`) and whether it is the
  portable build or a source checkout;
- what an attacker needs first (a seat, an invite link, a page open in the
  operator's browser, code on the same PC, ...);
- steps to reproduce, and what happened compared with what should have happened;
- logs if they help (`launcher.log` next to `Clear to Air.exe`, or tray menu → Open log;
  from a source checkout, the agent window's output), **with passwords,
  tokens, invite links and room ids removed**.

If you are not sure whether something is a security issue, report it privately
anyway.

## What we will try to do

We are a small team, so these are intentions, not guarantees:

- acknowledge your report within 5 working days;
- give a first assessment within 10 working days;
- fix serious issues in the next release, and tell you before it ships;
- credit you in the release notes if you want to be credited.

Please give us a reasonable chance to ship a fix before you publish details. We
will agree a date with you.

## Supported versions

Clear to Air is pre-1.0. Only the **latest release** gets security fixes. The
in-app updater (and the tray launcher in the portable build) will tell you when a
new one is out.

| Version | Supported |
|---|---|
| latest 0.x release | yes |
| older releases | no, please update |

## In scope

Everything in this repository. These areas matter most, because they are where
something outside the broadcast PC meets something inside it:

### The hosted relay (`relay/`)

A Cloudflare Worker plus a Durable Object per rig that lets a browser elsewhere
reach the agent through a WebSocket the agent dialled out. It is treated as
untrusted: it forwards and labels requests, the agent decides. We especially want
to hear about:

- joining a room without a valid invite, reusing an expired or spent invite, or
  keeping a seat after the operator closed it;
- claiming, taking over or reading another rig's room (room ids and the room key
  hash);
- getting around the seat cookie (`HttpOnly; Secure; SameSite=Lax`) or the
  `Sec-Fetch-Site: same-origin` requirement on `/api/**`, `/packs/**` and `/ws`;
- anything the relay stores or logs that it should not.

### Remote seats on the agent (`agent/src/remote.js`, `agent/src/remote-policy.js`)

- **Deny by default.** A route that is not listed in `remote-policy.js` must be
  unreachable from a seat. Any route, method or WebSocket message you can reach
  that is not listed is a bug.
- **Roles.** A viewer that can write, a scorer that can cut program or change
  graphics, a producer still waiting at the door that can do anything beyond
  asking who it is, or stream control without the operator switching it on.
- **Redaction.** The OBS password, GSI token, start.gg token and VDO.Ninja
  password must never reach a seat: not in a REST answer, the `hello` frame, a
  `state` push, a log line or an error message.
- **Patches.** No seat may write `settings` or `live`, however deeply nested the
  patch.
- **Invite codes.** Guessing, replaying or forging one.

### The local API guard (`agent/src/http.js`, `guardRequest`)

The agent listens on `127.0.0.1:7700`. A web page in the operator's browser must
not be able to drive it. The guard requires the `Host` header to name the agent
on loopback (against DNS rebinding), checks `Origin` against an allow-list,
refuses `Sec-Fetch-Site: cross-site` and `same-site` on `/api/*` and WebSocket
upgrades, and requires `Content-Type: application/json` on writes. A way past any
of these from an ordinary web page is in scope. So is reading files outside the
served folders.

### The update channel

`agent/src/update.js` only reports that an update exists. The Windows launcher
(`tools/launcher/ClearToAir.cs`) downloads and swaps it. It must refuse a
non-https download link, refuse a manifest without a `sha256`, verify the zip
before extracting anything, and refuse any zip entry that would land outside the
staging folder (zip slip). A way to make it run or install something it should
not is in scope.

Known limitation: releases are not code-signed yet, and the checksum comes from
the same release manifest as the download link. The checksum protects against a
damaged or swapped download, not against a compromised release.

### Game feeds (`agent/src/adapters/`)

The CS2 and Dota 2 receivers check the GSI `auth.token` on every POST, and bind
loopback only. Getting a payload accepted without the token, or getting any
adapter to listen beyond loopback, is in scope. The legacy fallback token `cta`
is used only when no token is configured anywhere; the agent generates a token on
first start.

### Also in scope

The talent pages (`overlays/talent/`) and their signalling in
`agent/src/talent.js`, the Liquipedia and start.gg clients, the OBS collection
installer, and the control room itself.

## Out of scope

- Attacks that need code already running on the broadcast PC, or the operator's
  Windows account.
- Someone who was deliberately given a producer seat doing what a producer is
  allowed to do.
- Exposing the agent beyond loopback on purpose (a reverse proxy, port
  forwarding) and then attacking it that way.
- Volume denial of service against a self-hosted relay or the hosted relay.
- Bugs in OBS Studio, obs-websocket, the games, VDO.Ninja, Cloudflare, GitHub,
  Liquipedia or start.gg. Report those to them. If Clear to Air uses one of them
  unsafely, that part is in scope.
- Forks and modified builds.
- Scanner output without a working impact (missing headers, version banners).
- Anti-cheat and terms-of-service questions. Those are not security issues; open
  a normal issue.

## Testing safely

Test against your own install and your own relay. Do not test against rooms,
seats or shows that are not yours, and do not test against the hosted relay
beyond your own room. If you find someone else's data, stop and tell us.
