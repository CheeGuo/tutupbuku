---
version: alpha
colors:
  canvas: "#F1F5F3"
  surface: "#FFFFFF"
  ink: "#193638"
  muted: "#597173"
  line: "#CFDAD7"
  brand: "#176A63"
  brand-soft: "#DDEDE8"
  warning: "#A95D22"
  warning-soft: "#F8E9D7"
  danger: "#9B3D3B"
  success: "#286C55"
typography:
  display:
    fontFamily: "Georgia, 'Times New Roman', serif"
  sans:
    fontFamily: "Aptos, 'Segoe UI', system-ui, sans-serif"
  data:
    fontFamily: "Consolas, 'Courier New', monospace"
rounded:
  control: "8px"
  panel: "12px"
spacing:
  unit: "4px"
components:
  button:
    height: "42px"
  field:
    height: "44px"
  focus:
    color: "#176A63"
    width: "3px"
---

# Design context

## Overview

TutupBuku is an operations desk for Malaysian SME finance teams receiving purchasing documents and employee claims. The product surface should feel like a well-kept working ledger: legible, accountable, and calm when a document needs human attention. This is a product interface, not an accounting-software marketing page.

The visual signature is a connected document trail: named agent and purchasing steps sit on a thin ledger line, making order and current review state visible without implying a fake percentage. Keep the rest of the interface quiet and highly readable.

## Colors

Use the cool paper canvas and white panels for working surfaces. Petrol green marks primary actions and approved business context. Warm amber is reserved for review and missing evidence; red is reserved for verified blocking errors. Always pair color with a textual state label. The palette deliberately avoids generic cream-and-terracotta stationery styling and the black-neon AI dashboard look.

## Typography

Use Georgia sparingly for page titles and the product wordmark, Aptos/Segoe UI for interface copy, and Consolas for account codes, document numbers, amounts, and timestamps. Keep body copy at 16px or larger where space permits and retain tabular numerals for money.

## Layout

Use a responsive 12-column desktop content grid with a compact persistent left navigation rail and a broad work area. At tablet widths, navigation becomes a horizontal row; at phone widths, stack forms and summary panels and keep data tables inside an explicitly labeled horizontal scroll region. Maintain generous line length for policy and issue explanations, with denser alignment only in record tables and ledger timelines.

## Elevation & Depth

Use borders as the primary grouping device. Reserve a very soft shadow for dialogs and the floating upload feedback panel; avoid stacked shadows on routine cards.

## Shapes

Panels use a 12px radius, fields and buttons 8px, and status markers use a small square with a clear label. Avoid pill-shaped dashboard cards and decorative gradients.

## Components

Buttons keep a stable 42px height through idle and busy states. Fields have a 44px minimum height, persistent labels, inline errors, and a 3px visible petrol focus ring. Data tables use true table markup. Progress uses the document-chain ledger line with named stages rather than percentage estimates.

## Do's and Don'ts

- Do show a source quote, page/row/line, and the next human action beside each material issue.
- Do distinguish “uploaded”, “processing”, “needs review”, “needs setup”, “approved”, and “failed”.
- Do use Malaysian Ringgit with two decimals when displaying integer sen.
- Don't say a document is reconciled or approved because an AI agent finished.
- Don't use sample transaction content in the live empty state.
- Don't encode severity using color alone.
