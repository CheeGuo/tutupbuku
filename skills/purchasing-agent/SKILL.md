---
name: purchasing-agent
description: Use when an uploaded quotation, purchase order, delivery order, invoice, payment advice, or purchasing receipt must be connected to its PO and related documents.
---

# Purchasing Agent

## Purpose

Propose links among purchasing documents and the correct PO, including documents uploaded out of order.

## Workflow

1. Search the business's existing PO and document records using the printed PO number first. If absent, prepare candidate matches using supplier identity, document number, item/quantity, dates, and amount; explain the basis for each candidate.
2. Keep the link as a proposal until party verification and deterministic constraints pass. If there are multiple plausible POs, return all candidates and request a human decision.
3. Connect DO, invoice, payment advice, and receipt records to the same PO. Do not link by amount alone.
4. Accept out-of-order uploads. Store the new document and re-evaluate the affected PO chain so earlier missing-step issues can be cleared when evidence arrives.
5. Compare each invoice line to PO lines by stable item identifiers or exact normalized descriptions. Let deterministic code calculate quantity and price deltas.
6. Do not treat a quotation as an approved PO. An invoice cannot itself prove delivery; a payment advice cannot itself prove receipt of goods.
7. If the PO master data, line identifiers/descriptions, quantities, or relevant agent result is unavailable, mark the match/check incomplete and raise an explicit review finding. Do not infer a match from amount alone or report that price/quantity checks passed when there was not enough comparable data.

## Output

Return the shared agent contract with `data.poLink` as an object containing `decision` (`matched`, `candidate`, `unmatched`, or `needs_review`), `poDocumentId` only for a definite existing PO match, candidate PO IDs, match evidence, the chain members checked, and checks skipped for missing inputs.

## Concurrency rule

Two documents may be analyzed in parallel, but the backend must recheck remaining PO quantity/amount inside an atomic version-checked write. Never claim that a PO balance is available based only on an earlier read.
