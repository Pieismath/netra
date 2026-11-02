# a16z speedrun SR008 — Netra application (DRAFT)

Deadline: Sun Nov 1 2026, 11:59 PM PT. Form: https://speedrun.a16z.com/apply/form
Character limits are enforced by the form; counts are noted per field.

---

## 1. Team

**Full-time or part-time?** Part-time
**Number of full-time founders:** 0
**Total FTE employees (incl. founders):** 1  *(two half-time founders)*

### Founder details

**CEO — Jason Fang**
- Email: jaydfds@gmail.com
- Phone: +1 901 567 6086
- Country: United States · City: Philadelphia
- College: University of Pennsylvania
- Highest education: High School Degree *(currently BA, CS + Cognitive Science, '28)*
- Years of professional experience: 2
- Technical enough to build end-to-end: **Yes**
- LinkedIn: https://www.linkedin.com/in/jasonhfang/
- GitHub: https://github.com/Pieismath
- X: https://x.com/jaydfds
- Portfolio: https://jasonhfang.com/

**Co-founder — Elana Hadi**
- Email: ehadi@wharton.upenn.edu
- Phone: +1 417 766 8986
- Country: United States · City: Philadelphia
- College: The Wharton School, University of Pennsylvania (BS Economics, '28)
- LinkedIn: https://www.linkedin.com/in/elana-hadi-0bbb00279/

### Relevant experience (≤1000)

Built Netra's entire stack solo: pf firewall gating, on-chain Solana payment verification, x402 purchase/extend endpoints, a session ledger with prorated refunds, content-addressed receipts, an agent SDK with spending caps, and three hardware form factors (modelled, rendered, interactive teardown). Won Best Use of Agentic Payments on Solana with x402 at the Penn Blockchain 2026 Hackathon with it. Currently an AI Specialist at the US Department of the Treasury and on the investments committee of Penn's $8M student-run, NCUA-chartered credit union. Co-authored a Nature Communications (2025) paper (scMINER) from two summers at St. Jude building HPC analysis pipelines over 100K+ samples. Previously shipped Cascade (iOS sheet-music reader, Swift) and a multi-agent paper-replication system for a Bridgewater hackathon. CS + Cognitive Science at Penn.

### Tell us more about the team (≤1000)

Two cofounders, 50/50, both 20, both at Penn. We met on Club Tennis freshman year, found out we were in the same CIS courses, and have since done two hackathons together — including the Penn Blockchain 2026 win that produced Netra. Jason (CEO, technical) built the whole stack and designed the hardware. Elana (co-founder, GTM) is Wharton Economics, L2 Lead for Penn Blockchain Governance, a Break Through Tech AI Fellow, and a power-markets finance intern at Kiewit; she runs customer conversations, partnerships and the operator side. We work in person several times a week — Jason thinks in systems, Elana in markets and people, and we use that gap deliberately. Advisors: [MENTOR 1 — hotspot hardware], [MENTOR 2 — digital-asset investing]. Why us: we're the only team that has actually made a firewall open against an x402 payment — not a payments demo, a working gate — and we're young enough to spend the next five years on the unglamorous part: making real equipment take machine money.

---

## 2. Startup details

**Startup name:** Netra

**One-sentence pitch (≤100):**
Pay-per-use internet access an AI agent can buy by itself — answer a 402, the firewall opens.

**Startup description (≤800):**
Software can hold a wallet now, but nothing will sell it a network connection. Captive portals assume a human tapping "I agree" with a credit card; automating that is fragile and usually against the venue's terms. x402 — now Linux Foundation-governed, backed by Coinbase, Stripe and AWS — settles tens of millions of payments a month. Every one buys an API call or a file. None buys the connection itself.

Netra is a hotspot that opens only against a verified payment. A device joins and every site is blocked at the firewall. A person pays through the captive portal; an agent answers an HTTP 402 carrying price, address and deadline. Netra verifies on Solana, opens the session, refunds unused minutes pro rata, and writes a content-addressed receipt both sides can check. One gate, two kinds of buyer. Working end to end on devnet, open source.

**Primary category:** Infrastructure / Dev Tools
**Secondary category:** Crypto
**Where will you build:** United States · San Francisco
**Founded:** March 2026
**Company website:** https://pieismath.github.io/netra-viewer  *(interactive hardware teardown; repo linked below)*

**Anything else we should know? (≤1000):**
What we know that others don't: the payment half of agentic commerce is solved; the enforcement half isn't. Everyone is building ways for agents to pay for APIs. Almost nobody is doing the messy work of making real-world metered resources — connectivity first — accept that money and actually withhold service until it clears. That is what we built.

Our wedge is agent developers, not travellers: every existing x402 client can buy from a Netra hotspot with zero integration. Venue operators and events follow once there is traffic to point at. We have studied the graveyard — Wayru shut down Dec 2025, Wicrypt dropped its token, Helium only pays for carrier traffic — and need no token and no network effect on day one: one Netra hotspot is useful alone.

Limits, stated upfront: devnet only, no mainnet custody, no paying users yet. Next: mainnet USDC settlement, hosted control plane, 10 paid pilots. Raising $750k pre-seed.

Code: github.com/Pieismath/netra · Hardware: pieismath.github.io/netra-viewer

---

## 3. Additional information

**Team video (MP4):** `speedrun/netra-team-video.mp4` *(launch video + founders intro — being built)*
**Pitch deck (PDF):** `speedrun/netra-deck.pdf` *(17 slides, team slide updated for two founders)*

**Traction:**
Pre-revenue. Working end-to-end prototype on Solana devnet (firewall gating → x402 payment → verified unlock → prorated refund → content-addressed receipt). Track winner, Penn Blockchain 2026 — Best Use of Agentic Payments on Solana with x402. Open-source repo and agent SDK published. Mentors in hotspot hardware and digital-asset investing engaged since the build.

**Funding history:** None. Bootstrapped by the founders; no outside capital, no legal entity yet (Delaware C-corp planned, 50/50).

**Active fundraising round:** Opening a $750k pre-seed for 18 months of runway (engineering 55%, hardware 25%, GTM 20%). speedrun would be the first check.

**Referral:** [none / fill if applicable]

**Where did you learn about speedrun?** [ASK JASON]
**Additional info (name/handle/post/event):** [ASK JASON]

---

## Open items before submit
- [ ] Mentor names/affiliations for the team answer (or cut the sentence)
- [ ] "Where did you learn about speedrun" + detail
- [ ] Confirm Treasury role wording is current and OK to state
- [ ] Jason reviews every answer for accuracy — nothing here should be a claim he can't defend in an interview
