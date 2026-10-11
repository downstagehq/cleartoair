# Third-party notices

Clear to Air is licensed under the GNU AGPL v3 or later (`LICENSE`), with the
overlay packs and the shared overlay renderer under MIT (`packs/LICENSE`,
`overlays/_shared/LICENSE`). It includes, or talks to, work by other people. This
file lists that work, its licence, and the terms that come with it. Full licence
texts are at the end.

The package versions below are the ones installed when this file was last
updated. Regenerate the tables before each release
(`npm ls --omit=dev --all` in `web/` and `agent/`).

## 1. Control room (`web/`, shipped as `web/dist`)

The control room is built with Vite. These runtime packages, and the packages
they depend on, are compiled into the JavaScript and CSS in `web/dist/assets/`.
Tree-shaking may leave some of them out of a given build.

| Package | Version | Licence | Copyright |
|---|---|---|---|
| react, react-dom, scheduler | 18.3.1, 18.3.1, 0.23.2 | MIT | Facebook, Inc. and its affiliates |
| zustand | 5.0.15 | MIT | 2019 Paul Henschel |
| sonner | 1.7.4 | MIT | 2023 Emil Kowalski |
| lucide-react | 0.468.0 | ISC | Lucide Contributors 2022; portions Cole Bemis 2013-2022 (Feather, MIT) |
| motion, framer-motion, motion-dom, motion-utils | 11.18.2, 11.18.2, 11.18.1, 11.18.1 | MIT | 2018 Framer B.V.; 2024 Motion B.V. |
| cmdk | 1.1.1 | MIT | 2022 Paco Coursey |
| @radix-ui/react-dialog and its @radix-ui dependencies (primitive, react-compose-refs, react-context, react-dismissable-layer, react-focus-guards, react-focus-scope, react-id, react-portal, react-presence, react-primitive, react-slot, react-use-callback-ref, react-use-controllable-state, react-use-effect-event, react-use-layout-effect) | 1.1.23 (dialog) | MIT | 2022 WorkOS |
| aria-hidden, get-nonce, react-remove-scroll, react-remove-scroll-bar, react-style-singleton, use-callback-ref, use-sidecar | 1.2.6, 1.0.1, 2.7.2, 2.3.8, 2.2.3, 1.3.3, 1.1.3 | MIT | 2017-2020 Anton Korzunov |
| detect-node-es | 1.1.0 | MIT | 2017 Ilya Kantor |
| tslib | 2.8.1 | 0BSD | Microsoft Corporation |
| tailwindcss (generated CSS, including its base "preflight" styles) | 4.3.3 | MIT | Tailwind Labs, Inc. |

Fonts in the control room come from the Fontsource packages and are copied into
`web/dist/assets/` as `.woff2` / `.woff` files:

| Font | Package | Licence | Copyright |
|---|---|---|---|
| Inter (variable) | @fontsource-variable/inter 5.3.0 | SIL OFL 1.1 | 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| JetBrains Mono (variable) | @fontsource-variable/jetbrains-mono 5.3.0 | SIL OFL 1.1 | 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| Barlow Condensed 600 and 700 | @fontsource/barlow-condensed 5.3.0 | SIL OFL 1.1 | 2017 The Barlow Project Authors (https://github.com/jpt/barlow) |

The same `web/dist` is what the hosted relay serves (`relay/public/` is a staged
copy of it), so the same notices apply there.

## 2. Agent (`agent/`, shipped with its `node_modules`)

| Package | Version | Licence | Copyright |
|---|---|---|---|
| ws | 8.21.3 | MIT | 2011 Einar Otto Stangvik; 2013 Arnout Kazemier and contributors |
| obs-websocket-js | 5.0.8 | MIT | 2016 Brendan Hagan |
| @msgpack/msgpack | 2.8.0 | ISC | 2019 The MessagePack Community |
| crypto-js | 4.2.0 | MIT | 2009-2013 Jeff Mott; 2013-2016 Evan Vosberg |
| debug | 4.4.3 | MIT | 2014-2017 TJ Holowaychuk; 2018-2021 Josh Junon |
| ms | 2.1.3 | MIT | 2020 Vercel, Inc. |
| eventemitter3 | 5.0.4 | MIT | 2014 Arnout Kazemier |
| isomorphic-ws | 5.0.0 | MIT | 2018 Zejin Zhuang |
| type-fest (TypeScript types only) | 3.13.1 | MIT OR CC0-1.0 | Sindre Sorhus |

The relay (`relay/`) has no runtime dependencies.

## 3. Fonts in the overlays (`overlays/_shared/`)

The broadcast overlays load these TrueType files directly. All are licensed under
the SIL Open Font License 1.1. Under the OFL the fonts may be bundled and
redistributed with software, may not be sold on their own, and keep their own
licence. Each font's full OFL text, with its copyright line, sits next to it as
`overlays/_shared/fonts/<Font>-OFL.txt` and ships in every build.

| File | Font | Version | Copyright |
|---|---|---|---|
| `fonts/BarlowCondensed-Bold.ttf`, `fonts/BarlowCondensed-SemiBold.ttf` | Barlow Condensed | 1.408 | 2017 The Barlow Project Authors (https://github.com/jpt/barlow) |
| `fonts/BebasNeue-Regular.ttf` | Bebas Neue | 2.000 | 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue) |
| `fonts/Inter-Variable.ttf` | Inter | 4.001 | 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| `fonts/JetBrainsMono-Variable.ttf` | JetBrains Mono | 2.211 | 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |

These were identified from each file's own name table. No other font files are
tracked in the repository.

## 4. Node.js runtime (portable Windows build)

The portable build (`tools/package.mjs`) copies the `node.exe` that runs the
packaging script into `runtime/node.exe`. At the time of writing that is
**Node.js v24.18.0** (`node --version`).

Node.js is licensed under the MIT licence, copyright Node.js contributors and
Joyent, Inc. and other Node contributors. `node.exe` also contains third-party
components (among them V8, OpenSSL, ICU, libuv, llhttp, nghttp2, zlib, c-ares and
others) under their own licences, all reproduced in Node's `LICENSE` file:
https://github.com/nodejs/node/blob/v24.18.0/LICENSE. A copy is kept at
`licenses/node-LICENSE.txt`, and `tools/package.mjs` ships it as
`runtime/LICENSE.txt` next to `node.exe` in every portable build, with the
root `LICENSE`, `TRADEMARKS.md` and this file. Update the copy when the bundled
Node version changes.

## 5. The Windows launcher

`Clear to Air.exe` is compiled from `tools/launcher/ClearToAir.cs` with the C#
compiler that is part of the .NET Framework 4.x included with Windows. It uses
only the .NET Framework class libraries already present on Windows and bundles no
third-party code.

## 6. Data and services Clear to Air uses

These are not bundled. Clear to Air contacts them over the network when the
operator uses the feature, and their own terms apply.

### Liquipedia

The team lookup (`agent/src/liquipedia.js`) reads Liquipedia through its
MediaWiki API.

- **Licence of the text:** Liquipedia content is licensed under **CC BY-SA 3.0**,
  which requires attribution to Liquipedia as the source. Every record the agent
  returns carries a `source` (the page URL) and a `license` field. If you publish
  Liquipedia text (on air, in a file, on a site), credit Liquipedia and link the
  page.
- **API terms of use:** https://liquipedia.net/api-terms-of-use. The terms ask
  for no more than one request every 2 seconds (`action=parse` no more than one
  every 30 seconds), a custom User-Agent that identifies the project and includes
  contact information, gzip support, caching results instead of repeating
  requests, and no automated access to the generated HTML pages. The agent
  queues every request at least 2 seconds apart, calls `action=parse` only as a
  fallback for rosters the wiki generates (at most once every 30 seconds),
  requests gzip, stops and reports the wait when Liquipedia answers 429 or 503
  with `Retry-After`, and sends
  `ClearToAir/<version> (esports broadcast companion; <contact>)` where the
  operator sets the contact.
- **Images:** team logos are the teams' trademarks and player photos belong to
  their photographers; each image on Liquipedia carries its own licence. The
  agent fetches one team or roster at a time, on request, and caches it on the
  operator's PC (`packs/<game>/assets/teams/`, `packs/_players/`). Those folders
  are excluded from the repository and from the portable build. Clear to Air
  does not walk categories or mirror the wiki, and should not be changed to.

### start.gg

The `startgg` adapter imports entrants and brackets through the start.gg GraphQL
API using the operator's own API token (https://developer.start.gg/docs/intro).
It stays under start.gg's published rate limit (80 requests per 60 seconds) with
its own limit of 60. Event and player data belongs to start.gg and the event
organisers.

### valorant-api.com

`packs/valorant/pack.json` references map splash images hosted at
`media.valorant-api.com`, which the overlay pages load at runtime. Valorant-API is
an unofficial, community-run service that is not endorsed by Riot Games. The
artwork belongs to Riot Games.

### Other services

- **VDO.Ninja** (https://vdo.ninja): the generated OBS scene collection can
  include VDO.Ninja browser sources for remote talent. Not bundled; its own terms
  apply.
- **Google public STUN server** (`stun.l.google.com:19302`): the talent green
  room pages (`overlays/talent/`) use it to set up peer-to-peer WebRTC
  connections. No media passes through it.
- **GitHub Releases:** the update check reads the release manifest from the
  project's GitHub releases.
- **Cloudflare:** the hosted control room relay (`relay/`) is written to run on
  Cloudflare Workers and Durable Objects, under the account and terms of whoever
  deploys it.

## 7. Games, publishers and trademarks

Clear to Air is an independent project. It is **not affiliated with, sponsored
by or endorsed by** any game publisher, league or platform named in it.

Game names, logos, maps, heroes, champions, agents, legends, characters,
weapons and other game content are trademarks or copyrighted material of their
owners, including:

- **Counter-Strike 2** and **Dota 2**: Valve Corporation
- **VALORANT** and **League of Legends**: Riot Games, Inc.
- **Rocket League**: Psyonix LLC / Epic Games, Inc.
- **Apex Legends**: Respawn Entertainment / Electronic Arts Inc.
- **EA SPORTS FC**: Electronic Arts Inc.
- **Street Fighter 6**: Capcom Co., Ltd.
- **Tekken 8**: Bandai Namco Entertainment Inc.
- **Guilty Gear -Strive-**: Arc System Works Co., Ltd.
- **Mortal Kombat 1**: Warner Bros. Entertainment Inc.
- **OBS Studio**: the OBS Project
- **start.gg** and **Liquipedia**: their respective owners

These names appear in pack files and in the code only to identify the game, its
maps and its characters so a broadcast can label them. The game data interfaces
the adapters use (Valve Game State Integration, Riot's Live Client Data API, the
Rocket League Stats API, the Apex Legends LiveAPI) are provided by their
publishers; their use is subject to each publisher's terms.

Team names and logos belong to the teams. Player names and photos belong to the
players and photographers.

## 8. Licence texts

Each block below is the licence text exactly as the packages ship it, with the
copyright lines moved into the tables above.

### MIT License

Applies to every package marked MIT above, and to Node.js. "The above copyright
notice" refers to each package's copyright line in the tables.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License

Applies to lucide-react and @msgpack/msgpack.

```
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Zero-Clause BSD (0BSD)

Applies to tslib.

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### SIL Open Font License 1.1

Applies to Inter, JetBrains Mono, Barlow Condensed and Bebas Neue, with the
copyright lines given in sections 1 and 3.

```
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
