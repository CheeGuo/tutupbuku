---
name: council-of-agents
description: Use when an expense or purchasing transaction needs a proposed category from the business's approved chart of accounts.
---

# Council of Agents

## Purpose

Produce a traceable category recommendation from the chart of accounts the business supplied. The council advises; application rules and a human reviewer control the final classification.

## Workflow

1. Read only resolved receipt/invoice facts, the claim purpose, supplier, and the active chart of accounts. Do not classify a claim whose relevance is still disputed.
2. Ask independent perspectives to recommend an existing account code: evidence-based transaction type, business-purpose fit, and policy/risk review.
3. Require each opinion to return an account code from the supplied list, a reason, source references, and confidence. Reject invented account codes.
4. Compare the opinions. If they disagree, evidence is weak, or the description conflicts with the proposed account, set `needs_review`; do not manufacture consensus.
5. Explain a unanimous or adjudicated proposal without implying that it is a posted accounting entry.

## Output

Return the shared agent contract with every opinion in `data.opinions`, the proposed account code/label, agreement state, and any remaining question. No matching account is a valid outcome; request a chart update rather than guessing.
