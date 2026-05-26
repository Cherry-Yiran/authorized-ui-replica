# Target Stack Adaptation

The CLI detects the target project and recommends implementation locations. The implementing agent should still inspect local conventions before editing.

## Next.js

- App Router: prefer `app/page.tsx` or a route-specific `app/<route>/page.tsx`.
- Pages Router: prefer `pages/index.tsx` or a route-specific page.
- Put repeated pieces under `components/`.
- Put authorized replacement assets under `public/replica-assets/`.
- If Tailwind is present, use project tokens and utilities. Otherwise prefer CSS Modules.

## Vite or React

- Prefer `src/App.tsx` or the existing route/view entry.
- Put repeated pieces under `src/components/`.
- Put local assets under `src/assets/` or the existing asset folder.
- Use Tailwind when configured; otherwise follow existing CSS, CSS Modules, or CSS-in-JS patterns.

## Static HTML

- Prefer `index.html`, `styles.css`, and `script.js`.
- Keep sections semantic and responsive.
- Put authorized replacement assets under `assets/`.

## Unknown

- Generate the brief with a React + Tailwind fallback recommendation.
- Do not create a framework migration unless the user explicitly asks.
