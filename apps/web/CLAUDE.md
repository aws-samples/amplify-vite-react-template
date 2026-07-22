# BuzzKill Website — Project Rules

## Content Rules
- NEVER add TM (™) anywhere on the site — remove immediately if found
- NEVER mention bed bugs — BuzzKill does not service them
- No dashes in the middle of sentences — use commas or rephrase instead
- Sound Familiar bubble text always wraps with opening `"` and closing `"` (curly/typographic quotes)
- NEVER write lines like "Every successful pest control service follows the same three steps" or any phrasing that implies the BuzzKill Method (Understand. Solve. Protect.) is a general industry practice — it is unique to BuzzKill and must always be framed as such

## Brand & Design
- GIM company colors: `#7ac142` (green), black, white
- CSS variables in use: `--bk-green: #72E000`, `--bk-cream: #F7F7F4`, `--bk-black: #0A0A0A`
- Fonts: Alfa Slab One (headings), Copperplate Gothic (body)
- Final CTA section on every page always uses the `bk-schedule-section` neon pattern (logo badge + green glow card)
- Residential pages lean cream/warm — avoid making them too dark
- Community/B2B pages can be more professional in tone but must stay on brand

## Page Structure — Service Pages
Every service page follows this 10-section order:
1. Hero
2. Sound Familiar (carousel with left/right arrows)
3. The Real Issue (dark section)
4. Root Causes / Why Your Property Attracts (accordion + sidebar quote card)
5. BuzzKill Method (UNDERSTAND / SOLVE / PROTECT)
6. What Happens When You Book (4 steps)
7. Why BuzzKill / Why Homeowners Trust BuzzKill
8. Prevention tips
9. Related Services
10. FAQ + Neon Final CTA

## Sound Familiar Section
- Always use `bk-carousel-wrap` wrapping `bk-familiar-carousel` with left/right `bk-carousel-btn` buttons
- Icons come from `creative/[service]/sounds familiar/` — copy to `public/images/` before referencing
- JSX pattern: `{item.icon ? <img src={item.icon} alt="" className="bk-familiar-icon" /> : <span className="bk-familiar-emoji" aria-hidden="true">{item.emoji}</span>}`
- Text always rendered as: `&ldquo;{item.text}&rdquo;`

## Images
- All hero images sourced from `creative/[service]/` folder — copy to `public/images/` with a clean name (e.g. `rodent-hero.png`)
- All Sound Familiar icons sourced from `creative/[service]/sounds familiar/` — copy to `public/images/` keeping original filename
- Never reference files directly from `creative/` in the site code — always copy to `public/images/` first

## Deployment & Branches
- `staging` branch → deploys to `staging.pestbuzzkill.com` (QA environment)
- `main` branch → production
- Always QA on staging before merging to main

## Tech Stack
- React 18 + TypeScript + Vite SPA
- React Router v7 for all routing
- AWS Amplify for hosting and CI/CD
- All routes defined in `src/App.tsx`
- All global styles in `src/index.css`
- Reusable components in `src/components/`

## PowerShell Rules (Windows dev environment)
- Use `New-Object System.Text.UTF8Encoding($false)` with `[System.IO.File]::WriteAllText` when writing files containing emoji — prevents mojibake
- Never use `&&` to chain commands — use `;` or `if ($?) { B }` instead
- Dev server: `cd` into project folder then run `npm run dev` — opens at `http://localhost:5173`
