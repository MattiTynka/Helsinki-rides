# Public street facade charts

These original CC0 SVG/PNG atlases restore nine municipal building records across five owner cells. The baseline is the deployed `senate-20261020-reference-repair-v3`, manifest SHA-256 `18e40f69a271f037b6b23b257fee437cb5716fad68c10cff808833a142ee7607`. The earlier Senate facade plans and artifacts remain unchanged.

`baseline-inventory-20261020.json` is a material candidate inventory. A constant wall material alone does not establish a defect or authorize an invented facade. `plan.json` contains only the physically matched, actually referenced public elevations selected for this pass.

| Owner cell | Municipal records / selected public face |
| --- | --- |
| `c_m02_p00` | Fabianinkatu 16 and 18 east; the two distinct Aleksanterinkatu 9 south records |
| `c_m02_m02` | Fabianinkatu 26 and 28 east, including their source projecting oriel facets |
| `c_m02_p01` | Pohjoisesplanadi 25–27 south, Hotel Kämp compound |
| `c_m02_p02` | Eteläesplanadi 12 north |
| `c_m06_m01` | Mannerheimintie 5 southwest central 26m face and its narrow recess |

The `v1/<cell>/` directories hold each atlas, source SVG, profile and provenance ledger. Google Street View panoramas listed in the plan were appearance references only. No reference photographs, logos, business lettering, Google pixels or remotely fetched textures are production inputs. Window positions, proportions and colours are original architectural approximations fitted to the observed rhythm. The complete window count over the Kämp compound is explicitly approximate; two axes on the observed projecting-face rhythm are fitted to the municipal sections. Only its clearly observed single wooden portal near runtime X−210m is authored.

Mannerheimintie corner/tower wings, unobserved side/rear walls, courtyards and roof geometry retain the baseline. Kämp's unverified high front gable portions above the lower source eave retain the neutral municipal wall colour. The source roof/pavilion geometry is unchanged. These are bounded street-face repairs, not full architectural reconstructions.

## Author and apply

Use the exact converted municipal input identified by both hashes in the plan. Reuse the native city-model conversion and source register rather than substituting another CRS, building address or geometry owner. Restore the pinned baseline world into an ignored working directory before authoring.

From the repository root, with those inputs prepared:

```powershell
node tools/world/author_senate_facade_charts.ts --plan content/helsinki/city-facades/plan.json --city-model data/work/district-expansion-20261018/citymodel-expanded --baseline build/reference-world --out build/facade-authored
node tools/world/apply_delivery_facade_charts.ts --baseline build/reference-world --current build/reference-world --city-model data/work/district-expansion-20261018/citymodel-expanded --profile build/facade-authored/c_m02_p00/profile.json --out build/facade-payloads/c_m02_p00
```

Authoring requires a fresh output directory. Repeat the apply command for each cell profile. Apply against the intended current candidate if it also contains independent geometry repairs; the baseline pin remains unchanged. The CLI emits payloads and `patches.json` without editing either input world. Merge the payload maps through the release's closed-inventory assembly, then validate that exact combined manifest in the browser.

Schema 2 groups multiple source owners in one cell atlas. Each chart still names exactly one municipal building and its original source triangle indices. A shared artwork frame gives separate projecting planes one continuous elevation image, preventing duplicated entrances. Ground profiles contain nine sampled HCOL/visible-ground support heights across each full selected street frontage, 0.75m outside the projected front envelope. Only the outer 1% at either end is extrapolated. The original ground mesh, HCOL and collision remain unchanged.

Each 1024² atlas adds one detailed material draw per owner cell, about 1.333MiB of BC7/ASTC compressed GPU mip residency and 5.333MiB for a complete RGBA fallback. The distant tier remains textureless and changes only corresponding face colours. Five cells add about 6.667MiB of compressed near-tier residency in total, loaded and evicted through the existing cell streamer.

The apply gate rejects wrong source/manifest hashes, undeclared building owners, missing or reversed faces, off-plane mappings, duplicate selectors and unpinned external image resources. It preserves original BIN prefixes, source coordinates, winding and unrelated UV/images/materials; Khronos validation runs on each emitted GLB. Keep the focused facade tests, source release audits and actual Standard/Low runtime approach/texture/budget/appearance checks as separate gates. A successful offline patch is not runtime acceptance.
