# Stand Corrected

**Live at [standcorrected.org](https://standcorrected.org)** (once DNS is pointed at GitHub Pages —
see *Custom domain* below; until then:
`https://davincidreams.github.io/standcorrected/`).

Search a paper. See the corrections, errata, and retractions that were published after it —
the ones that exist in the scholarly record but are almost never linked from the article page
you're actually reading.

This is a real problem: publishers print corrections that materially change a paper's results,
yet the original article page frequently carries no link, no banner, no notice. The linkage data
usually *does* exist in Crossref metadata — it's just not surfaced anywhere a reader looks.

## How it works

The site is fully static (plain HTML/CSS/JS, no backend, no API keys, no tracking) and runs
three checks for every paper, entirely in your browser:

1. **Crossref update links** — the paper's own Crossref record carries an `updated-by` array:
   every correction, erratum, retraction, or expression-of-concern notice the publisher formally
   deposited as updating that paper. This is the authoritative source. Each notice's own record is
   fetched to display its full title, journal, and date.
2. **Crossref title sweep** — some publishers never deposit update links (the exact gap this site
   exists for). The app searches Crossref for notice-style titles ("Correction to…", "Erratum…",
   "Corrigendum…") whose title overlaps the original paper's title above a token-match threshold,
   and lists them under *Possible corrections not formally linked* — clearly flagged as unverified.
3. **OpenAlex retraction flag** — `is_retracted` on the work record (sourced from the Retraction
   Watch database). If set, a red banner is shown with a link to search the Retraction Watch entry.

It also recognizes when the paper you looked up is *itself* a correction, showing what it corrects.

Search accepts a DOI (bare or as a full `doi.org` URL) or a title/author query; title queries
show ranked candidates to pick from. Every lookup gets a shareable deep link:
`…/#/doi/10.1038/s41572-020-00234-1`.

## Deployment

The site deploys from this repository's `main` branch via **GitHub Pages** (static files at the
repo root). Every push to `main` goes live automatically. The custom domain `standcorrected.org`
is configured via the `CNAME` file and the repo's Pages settings.

To run a local copy instead:

```bash
python -m http.server 8123
# open http://localhost:8123
```

(Opening `index.html` directly usually works too — both APIs are CORS-open — but serving over
HTTP is more reliable across browsers.)

### Custom domain DNS (one-time setup at your registrar)

Apex domain — add four `A` records for `@`:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

Optionally add `www` as a `CNAME` to `davincidreams.github.io`. Once DNS propagates, GitHub
issues a TLS certificate automatically; enable **Enforce HTTPS** in Settings → Pages.

## Configuration

One setting, at the top of `app.js`:

```js
mailto: '64185677+DavinciDreams@users.noreply.github.com',
```

A contact address gets you into Crossref's and OpenAlex's "polite pools" (better rate limits;
both APIs are free and key-less). It currently uses a GitHub noreply address — swap in your
real email if you prefer.

## Honest limitations

- **Coverage depends on publisher deposits.** Crossref update links only exist if the publisher
  deposited them. Major publishers (Nature, Elsevier, Springer…) are generally good; older and
  smaller records often have nothing deposited.
- **Generic-titled notices can't be title-matched.** Some journals publish corrections titled
  simply "Author Correction" with no reference to the original article title; the title sweep
  cannot connect these (only their full text reveals the target).
- **The title sweep is a heuristic.** Matches are labeled "unverified" for this reason — check
  before relying on them.
- **Not the full Retraction Watch database.** The retraction flag is per-paper via OpenAlex.
  For systematic retraction screening, use the Retraction Watch database directly.
- **Errata in PubMed/Europe PMC are not yet checked** — biomedical errata coverage there is often
  better than Crossref relations (see roadmap).

For high-stakes decisions, also click the **Crossmark** button on the publisher's page and check
Retraction Watch — the site's empty state links to both.

## Verified with real lookups

Tested end-to-end in a browser (screenshots in `gui-test-screenshots/`):

| Input | Result |
|---|---|
| `10.1038/s41572-020-00234-1` (Tendinopathy review) | 1 linked author correction, with title/journal/date |
| `10.1016/S0140-6736(97)11096-0` (Wakefield et al.) | Retracted banner + both retraction notices (2004, 2010) |
| "Growth in a Time of Debt" (title search) | 8 candidates → honest "no corrections found" + manual fallbacks |

## Roadmap ideas

- **Retraction Watch full-database backend** (free CSV download → SQLite) for expressions of
  concern and retraction detail (reasons, notices) beyond a boolean flag — this is the first
  feature that would require a small server.
- **Europe PMC / PubMed errata** for biomedical literature (`COMMENT_CORRECTION` links).
- **arXiv version diffs** — v1→v2 swaps can materially change results too.
- **Browser extension** that shows a banner directly on publisher pages — the ultimate fix for
  "the correction is published but never shown".
- **Materiality summaries** — an LLM pass over erratum abstracts to flag "changes results" vs
  "typo fixes".

## Credits

Data: [Crossref](https://www.crossref.org/) REST API and [OpenAlex](https://openalex.org/)
(including Retraction Watch data). Not affiliated with either. Please respect their
terms and rate limits.
