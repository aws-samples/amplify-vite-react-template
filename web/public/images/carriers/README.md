# Carrier logos — section 06 of the homepage

Twelve logos, rendered as a single-line marquee scrolling right to left. Source
artwork came from `crm/CREATIVE/HOME/insurance/`; these files are normalised
copies, so re-derive them from that folder rather than editing them in place.

## Files

Source filenames were abbreviated and inconsistent, so each was renamed to match
the `slug` in the `MARKETS` array in
[`web/src/pages/index.astro`](../../../src/pages/index.astro).

| Carrier | Source | This folder |
| --- | --- | --- |
| Amwins | `awins.png` | `amwins.png` |
| CAIS | `cais.png` | `cais.png` |
| Community Association Underwriters | `cau.png` | `community-association-underwriters.png` |
| CondoLogic | `condo logic.png` | `condologic.png` |
| Distinguished | `dist.png` | `distinguished.png` |
| Greater New York | `gny.png` | `greater-new-york.png` |
| Honeycomb | `honey.png` | `honeycomb.png` |
| LIO Insurance | `lio.png` | `lio-insurance.png` |
| McGowan | `mcgrown.png` | `mcgowan.png` |
| Pathpoint | `pathpoint.png` | `pathpoint.png` |
| RPS | `rps.png` | `rps.png` |
| Travelers | `travelers .png` | `travelers.png` |

## How they were processed

Every file was resized to **120px tall** with its native aspect ratio preserved,
which is 2× the 60px-ish rendered height. Widths therefore vary (152px to 617px)
and that is intentional — forcing a common width would stretch the wide
wordmarks. Uniform *size* comes from CSS instead: each marquee slide is a fixed
200 × 92 box and `object-fit: contain` fits the mark inside it, so every logo
occupies exactly the same footprint undistorted.

No filter, tint or greyscale is applied. Each mark appears in its own colours.

## Adding or replacing a carrier

1. Add the file here using the carrier's slug as the filename.
2. Add an entry to `MARKETS` in `index.astro` with `name` and `slug`.

`name` becomes the image's `alt` text. Since the wall shows logos only, that alt
is the sole accessible label for the carrier — keep it accurate.

The marquee renders the list twice and animates to `-50%`; the second copy is
what makes the loop seamless. That is automatic, so no change is needed when the
list length changes.

## Known artwork issue

**`rps.png` is white-on-green.** It is RPS's own lockup on their brand green, so
it renders as a green tile among eleven predominantly white ones. Nothing in the
CSS causes this and recolouring a carrier's mark would be a worse trademark
problem than the visual inconsistency. If it should match the others, request a
version on a transparent or white ground from RPS.

## Before these go live

Displaying a carrier's mark asserts an active appointment *and* reproduces a
third-party trademark. Two things to confirm with Compliance:

1. Every appointment is current.
2. Each carrier's brand guidelines permit an appointed agency to display the mark
   in this context. Some require prior written approval, and some prohibit
   display alongside competitors' marks. Travelers and Amwins both publish
   guidelines worth reading.
