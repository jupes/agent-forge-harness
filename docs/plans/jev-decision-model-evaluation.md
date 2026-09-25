# Jev (TypeSafe AI) as a decision layer for Game Guide AI — evaluation summary

> **Date**: 2026-09-24
> **Verdict**: not yet — contract terms are the bigger obstacle than price; a vendor-free first step exists
> **Full research** (every code reference, 72 citations): [`jupes/game-guide-ai` → `docs/forge/research/jev-decision-model-evaluation.md`](https://github.com/jupes/game-guide-ai/blob/integration/1kg-workbench/docs/forge/research/jev-decision-model-evaluation.md) (PR #93, on `integration/1kg-workbench`)
> **Published note**: <https://jupes.github.io/notes/jev-decision-layer.html>
> **Beads** (game-guide-ai tracker): research `agent-forge-harness-9z8` (closed); follow-ups listed below

---

## What Jev is

TypeSafe AI's "System One" model, in limited early access since 2026-09-15. It reads text but never
generates any. Every answer is one of three shapes, each with a confidence:

| Answer type | Returns | Limits |
| --- | --- | --- |
| `choice` | One option from a supplied list, with a probability per option | Up to 255 options, single pick |
| `score` | One level on a defined scale | 2–10 levels |
| `noul` (yes/no) | A probability 0–1 | No confidence on this type |

- **Price**: $0.042 per 1M input tokens; output free (~$0.00004 for a 1,000-token decision).
- **Latency (vendor claim)**: 70–500 ms end to end.
- **Operations**: no SLA; 1,200 requests/min, changeable without notice; the Python SDK shipped two
  breaking releases in its first week.
- **Key limit**: it cannot fill anything in. It can gate or verify a structuring call (stat block,
  spell card), never replace one — TypeSafe's own extraction recipe uses a small LLM to extract and
  Jev only to check.

## Where it would fit in Game Guide AI

| Decision | Today | Jev's role | Value per decision | Now? |
| --- | --- | --- | --- | --- |
| Stat block / spell card | Free text-pattern gate (`_looks_like_statblock`) before a paid structuring call; spell mode always makes two extra calls | Veto calls that will produce nothing | ~$0.00046 per avoided call | Only pays if ≥ 9% of gated calls are wasted (unmeasured) |
| Route to a cheaper model | User picks; only `gpt-4o-mini` enabled (already the economy tier); routing plan forbids a router-model call | Pick the cheapest adequate model | ≤ $0.00072 | Nothing to route to |
| Web-search trigger | Not built (`xiu`) | Skip unneeded searches | ~$0.0112 per avoided search | Best candidate — later |
| Answerability ("can these passages answer?") | Strict retrieval gate | Calibrated yes/no | ~$0.00126 | Blocked on licensing (`yje.6.1`) |
| Live session card trigger | Planned (`1ir`) | Fast per-utterance classifier | ~$0.015 per listening hour | Later |

At the pilot cap (500 chat turns/day) every candidate's ceiling is about **$20/month** — less than
reviewing and operating a new vendor. Jev must beat the near-free options already in hand (a
classifier on the per-turn query embedding; a one-token `gpt-4o-mini` answer), not a large LLM.

## Contract terms (Master Customer Agreement, updated 2026-09-23; read 2026-09-24)

- The first API call accepts the agreement.
- No retention bound: no obligation to keep or delete customer data, no time limit.
- Customer data may be used in perpetuity to derive "Telemetry" (defined to include classifications
  and learnings), which TypeSafe may process without restriction, including to improve its products.
- No training on customer data without consent (in writing).
- Zero data retention only on Enterprise, private terms; subprocessor list and SOC 2 not publicly
  visible.

**Consequence**: fails the Workbench threat model's written-terms gate (S-5 / SEC-39 / WT-20: only
the primary provider may see GM-private text until another provider's terms, including bounded
retention, are reviewed). No user or campaign text should reach Jev.

## Independent evidence

- **liteLLM routing benchmark** (80 synthetic cases × 3): 95.00% vs 73.75% (Claude Haiku 4.5) label
  agreement; p50 127 ms vs 688 ms; downstream answer quality not measured.
- **PriorBench** (pre-registered, 5,721 calls): 95.9% zero-shot vs 77.2% keywords; *always answers* —
  0/30 out-of-scope flagged without an explicit "none" option, at 0.99 confidence; accuracy flat
  0.50–0.95, reliable only at 0.99 (60.2% of traffic); option order moved results up to 13 points.
- Nothing tested on tabletop text; no held-out calibration study.

## Plan (beads filed in the game-guide-ai tracker)

| Bead | Task | Priority | Blocked by |
| --- | --- | --- | --- |
| `agent-forge-harness-kyr` | Record content-free structuring outcomes per mode | P2 | — |
| `agent-forge-harness-z58` | Step-0 waste report from the `yje.5.1.1` production cost records | P2 | kyr |
| `agent-forge-harness-lnf` | Block-choice labelled set (≥ 400, synthetic + SRD/wikidot, 50 adversarial) | P3 | — |
| `agent-forge-harness-cps` | Offline benchmark: heuristic vs embedding classifier vs one-token `gpt-4o-mini` vs Jev | P3 | — |
| `agent-forge-harness-idj` | **Owner**: review TypeSafe terms, decide on early access | P2 | — |
| `agent-forge-harness-dvy` | Pilot 1: offline block choice against pass thresholds | P3 | z58, lnf, cps, idj |
| `agent-forge-harness-xbt` | Pilot 2: web-fallback eligibility (synthetic prompts) | P4 | cps, idj, xiu.1.4 |
| `agent-forge-harness-61d` | Production integration of a passed pilot (fail-open, shadow first) | P4 | dvy |

**Pilot 1 pass thresholds**: ≥ 5 macro-F1 points over the best near-free arm; veto precision ≥ 0.98
at ≥ 0.99 confidence covering ≥ 50% of true `none` cases; ≥ 90% of adversarial items land on `none`;
option-order swing ≤ 3 points; p95 ≤ 300 ms, errors ≤ 1%; break-even at Step-0 rates. If Jev fails
but the embedding arm passes, adopt the embedding arm (no new vendor).

## Owner questions

1. Accept a new AI processor for chat text at all? Only with ZDR? Pay for Enterprise to get it?
2. Is the perpetual derived-Telemetry clause acceptable?
3. Keep the routing plan's "no router-model call" rule?
4. Is "block choice" a feature (cards outside their modes) or only a cost gate?
5. Expected daily turn volume after launch?
6. May licensed book excerpts go to an additional provider (`yje.6.1`)?
7. Consider a decision-model vendor for the Live Session Assistant (`1ir.1.5`)?

## Sources

- [TypeSafe AI: Introducing System One models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe API reference](https://docs.typesafe.ai/api.md) · [Models, limits, pricing](https://docs.typesafe.ai/models.md) · [jev-1.13 known weaknesses](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
- [Master Customer Agreement](https://typesafe.ai/legal/mca) · [Privacy Policy](https://typesafe.ai/legal/privacy-policy) · [DPA](https://typesafe.ai/legal/data-processing)
- [liteLLM Jev auto-router benchmark](https://docs.litellm.ai/blog/jev-auto-router-benchmark)
- [PriorBench: Jev](https://github.com/priorbench/jev)
- [TechCrunch, 2026-09-18](https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/)
