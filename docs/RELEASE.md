# Shipping Clear to Air

How a change on `master` becomes something a tournament organiser downloads,
and how an installed copy finds out about it.

## What a user gets

`ClearToAir-win64-<version>.zip`, unzipped anywhere they can write to:

```
Clear to Air.exe      tray launcher (tools/launcher, built with Windows' own csc.exe)
runtime\node.exe      the Node runtime, copied from the machine that packaged
app\                  package.json · agent\ · packs\ · overlays\ · web\dist\
app\agent\data\       state.json, adapters.json, captures\ - created on first run, kept across updates
launcher.log          the launcher's lines and the agent's output (local time), rolls at 2 MB; tray > Open log
VERSION · README.txt
```

Double-click the exe: the mark appears in the tray, the agent starts hidden,
the control room opens at `http://127.0.0.1:7700/`. The tray mark is the lamp:
green = clear, amber = clear with warnings, red = preflight faults or the agent
is down (the launcher restarts it), grey = not checked yet. Quit from the tray.
Nothing is written outside the folder except the OBS collection they install.

## Where releases live

On the **public source repo**, as GitHub Releases. The repo is named in one place,
the root `package.json`:

```json
"releases": { "repo": "downstagehq/cleartoair" }
```

The organisation is **downstagehq** (display name Downstage). `github.com/downstage` is
someone else's organisation: never point anything there. **If the field is unset or the
`OWNER/` placeholder, update checks are off** (`DEFAULT_UPDATE_URL` is `null`, `/api/update` answers
`disabled: true`) and `tools/package.mjs` refuses to build unless given
`--no-update-channel` for a local test build. "OWNER" is a namespace anyone could
register, and the manifest names both the zip and its sha256, so a placeholder must
never become a live URL. Both the packager and the agent read the field. Once set,
the agent's update check is

```
https://github.com/<releases.repo>/releases/latest/download/latest.json
```

GitHub resolves `/releases/latest/` to the newest **full** release, so publishing a
release is the update, and a release marked **pre-release** (rig test builds, betas)
is never offered to installed copies. The URL is a constant in `agent/src/config.js`,
never a setting: whoever names the manifest names the zip the launcher installs.
`--update-url` / `CTA_UPDATE_URL` point a build at a staging manifest.

(The earlier plan of a separate downloads-only repo is dropped. Builds up to
0.3.0 still check `cleartoair.vercel.app/releases/latest.json`; keep that file
pointing at the newest public zip until those installs have updated once.)

## Cutting a release

1. Bump `version` in the root `package.json` (the agent reports it at `/api/version`,
   the status bar shows it, the launcher reads it from `app\package.json`), and put the
   release's notes at the top of `docs/CHANGELOG.md` (the `gh release` notes come from there).
2. `node tools/package.mjs --notes "one line for the update prompt"`
   - runs `npm run build` and `npm test`
   - packs the icon, compiles the launcher
   - stages `dist/ClearToAir-win64-<v>/`, zips it, computes sha256
   - writes `dist/latest.json` (the update manifest, whose `url` is this release's zip),
     **signed** with the release key (see [Signing](#signing)), then checks the signature
     with the agent's verifier and with the launcher it just built before it finishes
   Add `--skip-build` to reuse the last build, `--repo` or `--url` to override.
   Without the private key it stops, unless `--no-update-channel` (local test build) or
   `--unsigned` (a dry run): both write an unsigned manifest that every installed copy
   refuses, and print no publish command.
3. Publish **both files to the same release** (the command is printed by step 2):
   ```
   gh release create v<version> "dist/ClearToAir-win64-<version>.zip" dist/latest.json --repo <releases.repo> --title "Clear to Air <version>" --notes "..."
   ```
   Add `--prerelease` for a test build that installed copies must not pick up.

Every installed copy checks once per six hours, or from the tray menu, and offers
the update. Both the agent and the launcher refuse a manifest that the release key
did not sign; the launcher checks the signature itself before it downloads anything,
refuses a version that is not newer than the installed one, refuses a manifest
without an https `url` and a 64-hex `sha256`, and verifies the hash before
extracting anything.

Not shipped, on purpose: `agent/data` (this rig's secrets and state), `packs/*/assets/teams`
and `packs/_players` (cached team logos and player photos belong to the teams and
players), docs, site, tools, tests.

## Signing

Every `latest.json` carries a signature from the project's **release key**, an ECDSA
P-256 key pair. The public half is built into every copy, twice:
`agent/src/release-key.js` (the agent's check in `agent/src/update.js`) and
`tools/launcher/ReleaseKey.cs` (the launcher's own check, `ManifestCheck` in
`ClearToAir.cs`). Both files are generated, never hand-edited, by
`node tools/release-key.mjs generate`, and are committed. The private half never
enters any repo.

**What is signed.** Not the JSON: a fixed byte string that Node and the C# launcher
build identically,

```
cleartoair-manifest-v1\n<version>\n<url>\n<sha256, lowercase>\n<size>\n<file>\n
```

(UTF-8; every field is checked to be printable ASCII without spaces or newlines
first). The manifest gains `"keyId"` (first 16 hex of the sha256 of the public key's
SPKI DER) and `"sig"` (ECDSA with SHA-256, IEEE P1363 `r||s`, 64 bytes, base64).
`notes` and `date` are **not** signed: they are display text in the update prompt,
so someone who controls the release could change those words, and nothing else.

**Where the private key lives.** `%USERPROFILE%\.cleartoair\release-signing-key.pem`
on the machine that cuts releases (PKCS#8 PEM, unencrypted, protected by that Windows
account's profile permissions). `CTA_RELEASE_KEY=<file>` points the packager (and
`tools/release-key.mjs`) somewhere else. `node tools/release-key.mjs show` prints the
built-in key id(s), the sha256 fingerprint, and whether the private key file matches.
Nothing ever prints the private key itself.

**Back it up, now and offline.** If the key is lost, no installed copy can ever be
updated again: every user has to download a new build by hand. Keep two copies off
this machine: the `.pem` file on a USB stick kept in a drawer (not a synced folder),
and its contents as a secure note in the password manager. Never email it, never put
it in a repo, a Drive/OneDrive folder or a chat. `generate` refuses to replace an
existing key; with `--force` it keeps the old file, renamed, rather than lose it.

**Rotating the key** (it leaked, or it is simply time):

1. `node tools/release-key.mjs generate --key <new file> --add` makes the new key and
   writes **both** public keys into `release-key.js` / `ReleaseKey.cs` (the verifiers
   accept any listed key; `keyId` picks which).
2. Cut a release that ships those files, **signed with the old key**
   (`CTA_RELEASE_KEY=<old file> node tools/package.mjs ...`). Installed copies accept
   it because they trust the old key, and from then on they also trust the new one.
3. Sign every later release with the new key (point `CTA_RELEASE_KEY` at it, or move
   it to the default path once the old file is archived). A later release drops the
   old key: `node tools/release-key.mjs drop <old keyId>`, rebuild, release. After a
   leak, do that in the very next release, so the leaked key stops being trusted.

If the old key **leaked**, step 2 is a race with whoever holds it, and copies that
never take that release stay exposed to it. Ship the rotation fast and tell users in
the release notes and on the site. If the old key is **lost**, there is no step 2:
the new key reaches users only through a manual download.

**What a compromised GitHub can and cannot do now.** Someone who takes over the
`downstagehq` organisation, the repo, or a release can:

- withhold updates (delete releases or `latest.json`): copies just stay on their version;
- re-serve an older **signed** manifest: refused, because it is not newer than what is installed;
- change `notes` / `date`: the words in the update prompt, not what gets installed;
- publish a new source tree or zips for people who download by hand: signing protects
  installed copies, not first downloads.

They cannot make an installed copy download or install anything the private key did
not sign: a changed `url`, `sha256`, `version`, `size` or `file`, a new key, or a
missing signature means the agent answers `/api/update` with
`{ok: false, available: false, error: "manifest signature invalid"}`, and the launcher
refuses before it downloads a byte. The same holds for `--update-url` /
`CTA_UPDATE_URL` and for a local process answering on port 7700.

The protection starts with the first build that carries the check: copies older than
it trust the plain `url` + `sha256` until they take one signed update.

## How an update applies

The launcher downloads the zip, checks the sha256, extracts `app\` into `app.next`,
stops the agent, moves `app\agent\data` and cached team logos across, swaps the
folders and starts the agent again - about five seconds, OBS untouched. If the zip
carries a newer `Clear to Air.exe` it lands as `Clear to Air.exe.new` and replaces
itself on the next start. `runtime\node.exe` is never replaced by an update; a new
runtime means a fresh download.

## Source checkout (developers)

`Clear to Air.cmd` still works from a checkout: installs, builds, starts the agent
and opens the control room. `npm test` = core + adapters + the hosted-relay end-to-end
suite. `/api/update` on a checkout reports `install: "source"`; the launcher is not
involved.

## The public export

The public repo is not this repo's history. `node tools/public-export.mjs` copies an
allow-listed tree into `C:\Dev\cleartoair-public`, makes one fresh commit there, and
fails if any blocklisted name, email or key-looking string is in it (see
`docs/PUBLIC-AUDIT.md`). It lists every placeholder link into the unowned `OWNER` namespace still left;
the export that gets pushed is run with `--final`, which refuses them. Releases are cut
from the exported tree.
