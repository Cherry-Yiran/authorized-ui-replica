# Output Protocol

The CLI writes deterministic artifacts so another agent can continue without re-crawling unless the page changed.

## mirror

Default output directory:

```text
replica-mirrors/<host>-<timestamp>/
```

Important files:

- `index.html`: rendered HTML with local asset URL rewrites.
- `assets/*`: saved CSS, JS, image, font, media, Lottie/WASM, and runtime-discovered effect resources.
- `screenshot.png`: reference screenshot from the mirror viewport.
- `mirror-manifest.json`: original URLs, local paths, resource types, mime types, and license dispositions.
- `license-review.md`: asset review checklist before publication.
- `mirror-verify.json`: written by `verify-mirror`; records local reference checks and unresolved issues.

`mirror` is also the default command. Passing only a URL is equivalent to `mirror <url>`.

Mirror recursively scans saved HTML/CSS/JS for root asset paths such as `/_next/static`, `/assets`, `/vendor`, app icons, manifests, Lottie files, WASM, common runtime effect assets, and hard-coded external CDN static assets. This is intentional: animations, interaction effects, and visible images often live in JS chunks or are built from runtime data rather than appearing in the initial HTML.

## capture

Default output directory:

```text
replica-captures/<host>-<timestamp>/
```

Important files:

- `capture.json`: capture metadata and viewport file map.
- `network-manifest.json`: responses, resource types, mime types, asset policy, and optional saved asset paths.
- `viewports/<name>.png`: screenshot for `desktop`, `tablet`, and `mobile`.
- `viewports/<name>.html`: HTML snapshot after page load.
- `viewports/<name>.dom.json`: DOM tree with rects and short text.
- `viewports/<name>.styles.json`: visible element computed styles.
- `viewports/<name>.css-vars.json`: root CSS custom properties.
- `viewports/<name>.css-rules.json`: readable stylesheet rules.
- `viewports/<name>.dom-assets.json`: asset references found in DOM attributes.

## analyze

Writes:

- `design-spec.json`: machine-readable tokens, layout regions, component candidates, and asset replacement notes.
- `design-spec.md`: concise human-readable design summary.

## detect-project

Prints JSON to stdout. It does not mutate the target project.

## generate-brief

Writes:

- `replica-brief.md`: implementation instructions for the target project, including stack-specific file recommendations, visual tokens, replacement assets, and acceptance criteria.

## compare

Default output directory:

```text
replica-comparisons/<timestamp>/
```

Writes:

- `comparison-report.json`: per-viewport mismatch ratios and dimension differences.
- `comparison-report.md`: human-readable summary.
- `diffs/<name>.png`: pixelmatch diff images.
- `reference/<name>.png` and `local/<name>.png`: captured comparison screenshots when URLs are used.
