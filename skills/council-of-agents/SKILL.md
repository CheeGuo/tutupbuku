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

## Choosing the account

Classify by what was bought and who benefited, not by the words the employee used. When an account has a `use_when` note, follow it. Work through these questions in order:

1. **What does the receipt show?** Food or drink (café, restaurant, coffee, set meal), transport (Grab, taxi, fuel, toll, parking, fare), a telco bill or reload, office consumables, or software. The receipt decides the kind of expense; the purpose only decides between accounts of that kind.
2. **For food and drink, who was there?**
   - Anyone outside the company (client, customer, prospect, supplier, partner, investor, a named person "from" another company, or a meeting about a deal or collaboration): **Business Entertainment**. "Coffee with Ali from Company X about a collaboration" is entertainment.
   - A discussion, meeting or catch-up with named people who are not stated to be staff: treat them as outside guests and propose **Business Entertainment**. "Discussion with Mr Lim and Sarah on the tender" is entertainment unless the purpose says they are colleagues. Ask the reviewer to confirm the attendees' company.
   - Only employees (team lunch, staff refreshments, birthday, farewell, overtime meal): **Staff Welfare**.
   - Nobody stated: do not guess. Prefer `needs_info` and ask who attended.
3. **Anything from or about a telco is Telecommunications.** A merchant such as Maxis, Digi, CelcomDigi, Unifi, TM, U Mobile, Yes, Hotlink, Tune Talk or Time, or a phone, mobile, internet, broadband, fibre, postpaid, prepaid or reload charge, goes to **Telecommunications** whatever the purpose says (for example "Unifi bill for office" or "Maxis reload for client calls").
4. **For transport, the trip's reason does not change the account.** A Grab ride to a customer site is **Travel & Transport**, not entertainment, even when the purpose mentions a client.
5. **Mismatch.** If the receipt kind and the purpose disagree (fuel receipt, purpose "lunch with client"; beer tower and private room, purpose "client lunch"), do not pick an account to fit the purpose. Return `needs_info` and say what does not match.
6. A vague purpose is not a reason to give up if the receipt plus the people named make the account clear. Say which facts you used, and list what the reviewer still has to confirm (for example the attendee's company, or that the meeting took place).

## Output

Return the shared agent contract with every opinion in `data.opinions`, the proposed account code/label, agreement state, and any remaining question. No matching account is a valid outcome; request a chart update rather than guessing.
