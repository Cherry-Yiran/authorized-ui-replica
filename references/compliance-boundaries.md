# Compliance Boundaries

This skill is for authorized UI replication. Treat authorization as a product requirement, not a technical detail.

## Allowed

- Owned websites and apps.
- Client-approved migrations or redesigns.
- Internal tools where the user has permission to reproduce the UI.
- Licensed templates, themes, and design systems.
- Public pages used for measurement when the output replaces protected brand assets, images, copy, and proprietary source.

## Not Allowed

- Login bypass, paywall bypass, CAPTCHA bypass, or anti-bot circumvention.
- Downloading private resources without authorization.
- Publishing third-party logos, photos, proprietary icons, paid fonts, or distinctive brand systems without permission.
- Copying captured JavaScript/CSS into a target app as a substitute for implementation.
- Removing attribution or license notices from assets.

## Default Asset Policy

- `mirror`: saves publicly loaded and runtime-referenced assets for authorized review, including visual effects; images, fonts, media, Lottie, and similar assets are marked `saved-review-license`.
- `capture`: inventories assets by default; `--save-assets` stores assets for authorized work.
- Images: review or replace unless clearly authorized.
- Fonts: review or replace unless clearly licensed.
- CSS and JS: review before reuse; runtime scripts can still call the original site even after URL rewriting.
- Videos, audio, Lottie, WASM, manifests, and interaction effect assets: review or replace unless clearly authorized.
- Logos and brand marks: always replacement points unless explicitly authorized.

When in doubt, generate a brief with placeholders and ask for authorized assets.
