# English and Finnish

The start screen offers Finnish and British flags with the explicit labels
**Suomi** and **English**. English is the default. Selecting a language updates
the current screen immediately and stores the explicit selection under
`helsinki-rides:language`. Storage failures leave the selection usable for the
current visit. Language buttons support native keyboard navigation, expose their
selection through `aria-pressed`, and never start play or request pointer lock.
The document's language, title and description follow the selection.

`apps/game/src/i18n/catalog.ts` contains complete English and Finnish messages.
The catalog covers loading, controls, graphics choices, explanatory credits,
drop-in landmarks, weapons, vehicle interactions, recovery, vehicle damage,
wanted status, world streaming, death/arrest destinations and diagnostics.
Place names use their Finnish equivalents where appropriate. Street addresses,
vehicle names, source authors and license names retain their identities. The
simulation and world data always keep the original labels; only presentation
changes. There is no third-party translation service or extra language download.

The English catalog defines typed message keys and interpolation parameters.
Numbers use the chosen locale. Render messages through `textContent`; translated
credit templates reuse existing authored link nodes rather than parsing HTML.
Keep complete messages together so Finnish word order and inflection can differ
from English. Add each new key to both catalogs with matching parameters.

Run the focused source checks with:

```sh
node --test apps/game/test/i18n.test.ts tools/verify/test/input.test.ts
```

For a served ordinary production build, including the world payload:

```sh
node tools/verify/verify-language.mjs --url http://127.0.0.1:5317/Helsinki-rides/ --out build/language-check
```

The browser check exercises both languages, native keyboard selection/start,
persistence in both directions, unavailable storage, source-link preservation,
Finnish drop-in/HUD presentation and a short viewport. Its captures require
visual review; automated assertions alone do not approve appearance.
