# Third-party software and content notices

The [MIT license](LICENSE) applies to original Helsinki-rides code and
documentation. It does not replace the licenses of the software, data, artwork
or models below. An asset being mentioned by a build recipe does not put that
asset in the source distribution or create redistribution rights.

This source release intentionally omits the generated world, raw data and source
models. See [release scope and exclusions](docs/open-source-release.md) and the
[source register](docs/source-register.md) for adaptation history. Existing
explicit CC0 artwork dedications remain in force.

## Vendored Basis Universal decoder

`apps/game/public/basis/basis_transcoder.js` and
`apps/game/public/basis/basis_transcoder.wasm` are unmodified copies supplied with
Three.js **0.186.1**, whose Basis README identifies them as **Apache-2.0**.
Byte-for-byte comparison with the pinned installed Three.js package was performed
on 2026-10-19. The embedded decoder's upstream commit is not recorded; do not infer
it from a current upstream branch or from the separate encoder build.

| File | SHA-256 |
| --- | --- |
| `basis_transcoder.js` | `8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1` |
| `basis_transcoder.wasm` | `6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a` |

Upstream: [Basis Universal](https://github.com/BinomialLLC/basis_universal).
License: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
The full Apache license is reproduced below. The Basis attribution notice below
is retained from the installed `ktx2-encoder` 0.6.0 package's upstream notice.
Keep this notice and license with redistributed decoder files and hosted builds;
repository visibility does not remove license obligations.

```
Basis Universal™ Supercompressed GPU Texture Compression Library

Copyright © 2016–2026 Binomial LLC.
All rights reserved except as granted under the Apache 2.0 license
(https://github.com/BinomialLLC/basis_universal/blob/master/LICENSE).
"Basis Universal" is a trademark of Binomial LLC.

The documents in the Basis Universal wiki, and the Basis Universal library,
example, and tool source code, fall under the Apache 2.0 license, unless
otherwise explicitly indicated.

Redistributions or derivative works must include a readable copy of the
attribution notices from this NOTICE file (see Apache License 2.0 §4(d)).
```

## Installed dependencies

Dependencies are installed using `pnpm-lock.yaml`; `node_modules/` is not part of
the source export. Their exact upstream licenses and notices remain in their own
packages. This table identifies direct dependencies and is not a replacement for
the notices of transitive components in a compiled binary distribution.

| Package | Pinned version | Declared license | Use |
| --- | --- | --- | --- |
| `three` | 0.186.1 | MIT, copyright 2010–2026 three.js authors | Browser rendering and glTF/texture loaders |
| `@dimforge/rapier3d-deterministic-compat` | 0.21.0 | Apache-2.0, copyright 2020 Sébastien Crozet | Deterministic browser physics/WASM |
| `@gltf-transform/core`, `extensions`, `functions` | 4.5.1 | MIT | Offline asset processing |
| `earcut` | 3.2.4 | ISC | Offline polygon triangulation |
| `gltf-validator` | 2.0.0-dev.3.10 | Apache-2.0 | Offline asset validation |
| `ktx2-encoder` | 0.6.0 | MIT; bundled Basis encoder Apache-2.0 and component notices | Offline textures |
| `meshoptimizer` | 1.3.0 | MIT | Mesh encoding/decoding; preserve runtime decoder notice when bundled |
| `playwright` | 1.63.0 | Apache-2.0 | Verification tooling |
| `polygon-clipping` | 0.15.7 | MIT | Offline geometry processing |
| `sharp` | 0.35.5 | Apache-2.0; bundled platform/libvips components have additional licenses | Offline image processing |
| `typescript` | 7.0.2 | Apache-2.0 | Build/type checks |
| `vite` | 8.3.4 | MIT; dependencies have their own notices | Build tooling |
| `@types/node`, `@types/three` | 24.19.2 / 0.186.0 | MIT | Development declarations |

Before distributing compiled JavaScript, WASM, native tooling or containers,
inventory their actual bundled dependencies and retain applicable copyright,
license and NOTICE texts. In particular, the installed Windows Sharp package
declares `Apache-2.0 AND LGPL-3.0-or-later`; no Sharp/native binaries are shipped
by this source-only export. Node, pnpm, Python and Blender installations are not
bundled. Kimodo code/checkpoints are not bundled.

The Three.js MIT notice and full Apache-2.0 text are reproduced at the end of
this file for the principal browser dependencies. A future hosted build must
deliver the applicable notices with the application, rather than relying only on
their presence in an unpublished source repository.

## Photographs included in the source export

The source export preserves the photographs' encoded pixels. Non-rendering EXIF
and XMP metadata is removed from the two Estates export copies; original author
and license credit is retained here and in `credits.json`. That ledger records
both original source hashes and exported file hashes. The development originals
remain unchanged. Derived game textures have the adaptations described below;
their image/data license remains separate from MIT.

| Local file | Attribution and source | License and changes to derived textures |
| --- | --- | --- |
| `content/assets/facades/estates/front-2021.jpg` | “House of the Estates Facade 2021-06-08,” © Josefiina Alanen, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:House_of_the_Estates_Facade_2021-06-08.jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); cropped, reprojected and reconstructed |
| `content/assets/facades/estates/park-2022.jpg` | “House of the Estates Park 2022-07-20,” © Josefiina Alanen, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:House_of_the_Estates_Park_2022-07-20.jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); cropped, reprojected and reconstructed |
| `content/assets/facades/esplanadi/catani-valtonen.jpg` | Pohjoisesplanadi 31 facade photograph, Marja Valtonen / Helsinki City Museum, [museum record](https://hkm.finna.fi/Record/hkm.0930CD28-8917-4792-A315-631BC6E7A029) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); rectified, repeated clean corresponding bays and removed photographed foreground objects |

The Estates `credits.json` and Esplanadi `source-ledger.json` retain exact image
hashes, source/license URLs and adaptation records. Keep them with redistributed
images and retain credit for derivative textures.

The three unused Estates `DSC05064.jpg`, `DSC05070.jpg` and `DSC05072.jpg`
research photographs are by Daderot, **CC0**, as recorded in the two Commons
metadata JSON files. They are omitted from the source export. The metadata may
remain. Jampe's “Kirkkokatu - panoramio (1)” is a CC BY-SA 3.0 visual reference
only, not a distributed image or texture donor.

## Explicitly dedicated original artwork

The `canalside-original.png` and `.svg` files under
`content/helsinki/district-expansion/facade-charts/canalside-v1/`, `canalside-v2/`
and `canalside-v3/` are original procedural project artwork, **CC0-1.0**, as
declared in their source ledgers. Their architectural references do not supply
image pixels. The original granite paving and embedded tram rail artwork is also
explicitly CC0 in its production credits. These dedications remain unchanged by
the MIT code license. [CC0 terms](https://creativecommons.org/publicdomain/zero/1.0/)

## Separately obtained geographic data

The source export contains configurations, provenance and some test fixtures;
it does not include the full raw map archive or generated world. Derived data
records retain the source license even where stored in JSON alongside MIT code.

- **City of Helsinki:** textured LoD2 city information model, 2021 terrain,
  building-register footprints, public street/green parts and tree layers,
  **CC BY 4.0**, © City of Helsinki. Derived game content is converted, tiled,
  atlased, color-graded, resampled, compressed and locally reconstructed as
  individually documented. [City information](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d),
  [license](https://creativecommons.org/licenses/by/4.0/).
- **OpenStreetMap:** road/footway/tram/coastline/steps data,
  **ODbL 1.0**, © OpenStreetMap contributors.
  [Copyright and attribution](https://www.openstreetmap.org/copyright),
  [license](https://opendatacommons.org/licenses/odbl/1-0/).
  Preserve attribution and applicable database share-alike/source availability
  obligations. MIT does not relicense OSM-derived databases or fixture excerpts.

Source IDs, snapshots and modifications are listed in `docs/source-register.md`
and `content/helsinki/*/sources.json`. A future distributed asset packet must
retain those notices and exact source identities. The 2017 photo-mesh is removed
and is not a source of the current game.

## Characters, motion and owner-supplied assets

These binaries are excluded from the source Git tree. The separately distributed
browser beta packet retains these notices. This section records known provenance;
the owner will provide remaining supplied-asset copyright details as described
in [the public beta record](docs/public-game-release.md). No unverified license
grant is inferred from the request to publish the game.

- **Finn**, modified from **Snow v4.2**, and **Rain**, modified into the Poliisi
  officer: © Blender Studio, **CC BY 4.0** according to the copied source
  ledgers. Source sources: [Snow](https://studio.blender.org/characters/snow/),
  [Rain](https://studio.blender.org/characters/rain/). Owner-supplied modifications,
  KTX2 encoding, sockets, gameplay/jump/vehicle-entry poses and bounded skin/texture
  corrections are individually documented in the source register.
- **Supplied movement:** Finn's ledger identifies NVIDIA
  **Kimodo-SOMA-RP-v1.2**. Generator code is Apache-2.0; the checkpoint is separately
  under the [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/).
  Its exact revision/hash is missing. The supplied exported movement is not
  relicensed Apache-2.0 by this notice. Rain's supplied output is reused without
  claiming to reproduce the original inference. Confirm the supplied adaptation
  and motion rights before publishing a playable packet.
- **Quaternius Universal Animation Library, free Standard edition:** **CC0-1.0**,
  historical locomotion inputs superseded by the supplied native exports.
  [Quaternius](https://quaternius.com/). No library archive is in the source export.
- **Rigged Mustang-derived Lumi GT/patrol car, low-poly Helsinki Cathedral and
  Alexander II monument:** supplied by the project owner. Their redistribution
  licenses are not established by the current source register. In particular,
  the Alexander exporter states that original licensing was not supplied.
  These assets and derivatives are excluded from the source grant/export until
  provenance and rights are recorded or cleared replacements are used.

## Reference-only material

Google Maps/Street View, operator photographs, architectural drawings, museum
reference images and research composites may guide manual interpretation but do
not automatically permit redistribution. Their image pixels are not included
unless specifically identified above as licensed production input. Reference
downloads and evidence under `data/` are excluded. Do not treat a credited link
as a license to copy an image into a release.

## Three.js MIT license

```text
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Apache License 2.0

The following license applies to the Basis decoder and the named Apache-licensed
dependencies; it does not change the project's MIT license or any data license.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2020 Dimforge EURL

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
