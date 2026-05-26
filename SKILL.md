---
name: authorized-ui-replica
description: Use when creating a source-level local mirror of an authorized webpage by default, including HTML/CSS/JS/image/font capture, local asset rewriting, screenshots, resource manifests, optional visual analysis, target project stack detection, implementation briefs, and visual comparison. Do not use for unauthorized cloning, login bypass, paywall bypass, CAPTCHA bypass, anti-bot circumvention, or reuse of protected brand assets without permission.
---

# Authorized UI Replica

Use this skill to recreate a webpage UI when the user has permission to reproduce it, such as an owned site, client-authorized migration, internal product rewrite, licensed template, or approved design-system port.

The default goal is a source-level local mirror: save the rendered HTML, CSS, JavaScript, images, fonts, media, Lottie/WASM, manifest files, and runtime-discovered effect assets that are publicly loaded or referenced by an authorized page; rewrite resource URLs to local files; and produce a local `index.html` for review. Visual analysis and implementation briefs are secondary tools for rebuilding the mirror into a maintainable project.

## Hard Boundaries

- Do not help bypass login, paywalls, CAPTCHA, rate limits, bot protections, or access controls.
- Do not directly publish third-party logos, brand images, proprietary icons, paid fonts, commercial photos, or protected copy unless the user confirms authorization.
- Default mirror behavior saves publicly loaded assets for authorized review and writes `license-review.md`.
- Use source-level mirroring only for authorized pages. For ambiguous third-party sites, do not publish or redistribute the mirror.

For detailed boundaries, read `references/compliance-boundaries.md`.

## Workflow

1. Confirm the target is authorized or frame the work as a licensed/internal migration.
2. Install dependencies if needed from this skill directory:

```bash
npm install
```

3. Mirror the reference page. This is the default path:

```bash
npm run replica -- "https://example.com" --out ./replica-mirrors/example
```

Equivalent explicit command:

```bash
npm run replica -- mirror "https://example.com" --out ./replica-mirrors/example
```

4. Open the generated local mirror through local HTTP. This matters for Vue/React/Webpack/Vite single-page apps; opening `index.html` directly with `file://` can leave the app stuck on its loading screen because routing, dynamic chunks, service-worker assumptions, or runtime requests do not behave like a web origin.

```bash
npm run replica -- serve ./replica-mirrors/example
```

Then open the printed `http://127.0.0.1:<port>/` URL.

5. Verify the mirror before considering it done:

```bash
npm run replica -- verify-mirror ./replica-mirrors/example
```

6. Review `license-review.md` before publishing or moving assets into another project.
7. Optional: use capture and analysis when you want a rebuild brief instead of a direct mirror:

```bash
npm run replica -- capture "https://example.com" --out ./replica-captures/example --save-assets
npm run replica -- analyze ./replica-captures/example
npm run replica -- detect-project /path/to/target-project
npm run replica -- generate-brief ./replica-captures/example /path/to/target-project
```

8. Compare reference and local mirror or implementation:

```bash
npm run replica -- compare "https://example.com" "./replica-mirrors/example/index.html" --out ./replica-comparisons/example
```

## CLI Commands

- `mirror <url>` or `<url>`: Default command. Saves a source-level local mirror with `index.html`, local `assets/*`, `mirror-manifest.json`, `license-review.md`, and `screenshot.png`.
- `serve <mirror-dir>`: Starts a local HTTP server for reviewing a mirror. Prefer this over opening `index.html` directly, especially for SPAs and pages with dynamic JS chunks.
- `verify-mirror <mirror-dir>`: Checks that manifest resources exist, local HTML/CSS/JS references resolve, and source-origin references have been rewritten.
- `capture <url>`: Saves desktop, tablet, and mobile screenshots, HTML snapshots, DOM trees, computed styles, CSS variables, readable CSS rules, DOM asset references, and a network asset manifest.
- `analyze <capture-dir>`: Creates `design-spec.json` and `design-spec.md` with visual tokens, component candidates, layout regions, and asset replacement notes.
- `detect-project <target-dir>`: Prints detected framework, router, TypeScript, Tailwind, package manager, and recommended implementation locations.
- `generate-brief <capture-dir> <target-dir>`: Writes `replica-brief.md` for the implementing agent.
- `compare <reference-url-or-image> <local-url>`: Captures screenshots and writes a pixel-difference report.

For artifact details, read `references/output-protocol.md`. For project adaptation rules, read `references/target-stack-adaptation.md`.

## Implementation Guidance

- Treat source-level mirroring as the primary flow. Do not default back to visual-only reconstruction unless the mirror is blocked.
- During `mirror`, save page effects and runtime resources, not only visible images: JS chunks, CSS, fonts, videos, audio, Lottie, WASM, manifests, favicon/app icons, assets referenced inside saved HTML/CSS/JS, and hard-coded CDN static assets discovered in saved JS bundles.
- Do not tell the user to judge a SPA mirror by double-clicking `index.html`. Serve it over local HTTP first, then inspect console/network issues separately.
- After mirroring, always run `verify-mirror` and inspect `mirror-verify.json`; if it reports missing files or source-origin references, fix the mirror or document the blocker.
- Prefer the target repository's existing framework, components, route structure, styling system, and asset pipeline.
- Match layout, spacing, typography, breakpoints, states, and animation timing before cosmetic refactors.
- Replace protected assets through explicit placeholders such as `brandLogo`, `heroImage`, `licensedFont`, and `productScreenshot`.
- Keep generated UI maintainable: name components by page role, isolate repeated sections, and avoid importing captured third-party source code into the target app.
- Verify desktop, tablet, and mobile; do not rely on one viewport.

## Failure Handling

- If Playwright cannot launch Chromium, run `npx playwright install chromium`.
- If a page requires login or blocks automation, stop and ask for an authorized static export, screenshot set, or accessible staging URL.
- If stylesheets or scripts reference additional assets, recursively fetch those public same-origin assets when possible. Also inspect saved JS bundles for external CDN static image/font/media URLs; many SPAs build visible image URLs at runtime rather than placing them in the initial HTML.
- If the mirror stays on a loading screen, first run `serve <mirror-dir>` and open the local HTTP URL. If it still loads forever, inspect console/network errors for dynamic chunks, API calls, service-worker assumptions, or blocked third-party runtime scripts.
- If assets are missing or unauthorized, keep the mirror private, document them in `license-review.md`, and replace those assets before publication.

## Verification

Run targeted checks only:

```bash
npm run check
```

Then smoke-test the mirror path and run `verify-mirror` on the output. Do not run broad suites unless the repository requires them or the user asks.
