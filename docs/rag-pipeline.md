# RAG pipeline guide

Authority: [technical PRD](<../AI SOP Assistant — Technical Product Req.md>), sections 5–8, 13–16. Requirements: C2–C5 with D3–D5 source lifecycle. This describes the required path; no retrieval code or workflows exist yet.

## Ingestion and activation

1. Admin initiates a validated private upload; the backend confirms the actual object checksum/size and creates a durable idempotent job.
2. n8n extracts native PDF/DOCX text; scanned, blank, failed-native, or mixed pages invoke managed OCR where necessary. Isolated LibreOffice generates DOCX PDF derivatives; original bytes remain intact.
3. Preserve headings, paragraph boundaries, original procedure order, digits, units, acceptance conditions, table headers/cells and source locations. Do not paraphrase or silently repair evidence.
4. Chunk by structure, splitting oversized sections recursively while preserving safety-critical context. Keep stable document/snapshot/chunk identity, source hash, section/page/order/type and embedding version.
5. Embed/index into PostgreSQL but keep the document ineligible. Admin compares original/preview and extracted data with issue flags, then explicitly approves the matching successful snapshot through the backend.

Only manually verified ACTIVE snapshots are evidence. No OCR confidence or successful embedding substitutes for human review. Failure, rejection, deletion, reprocessing, or snapshot mismatch must prevent eligibility. DOCX derivative pages may differ from original pagination; prefer genuine section references to invented source page numbers.

## Retrieval and checks

1. Authorize the current user/account and conversation. Bound recent history and rewrite follow-ups into a standalone retrieval query.
2. Query pgvector semantic search and PostgreSQL full-text search. **Each branch enforces identical verified ACTIVE eligibility before candidate selection.**
3. Fuse with RRF and deduplicate by source identity. Rerank with the verified configured GPT model; accept only IDs from the supplied candidate set and use the original passages afterward.
4. Generate structured claims/procedural steps with supporting source IDs. Only those original passages are evidence; history, prior answers, summaries, and model knowledge are not.
5. Run deterministic schema, citation membership/mapping, current source status, number/unit/condition and format checks. All procedural claims must map to supporting verified chunks.
6. Obtain an independent LLM judge's claim-by-claim support decision. Fail closed on uncertainty, disagreement, malformed responses, or unavailable checks.
7. The backend rechecks current eligibility/authorization, persists the approved outcome and source references idempotently, and emits the terminal SSE event. Only then may procedural text reach the browser.

The judge is a check, not evidence or an infallible authority. A reranker returns ranked known IDs; it cannot author replacement evidence. An answer that adds a plausible extra step, changes a number/unit, drops a necessary condition, or invents a source fails validation.

## Outcomes and source access

Insufficient supporting SOP evidence produces exactly `No SOP found for this question`, with no citations. Provider downtime, timeout, rate limit, internal errors, or an unavailable validation stage produce a separate safe service error. Never disguise service failure as evidence absence or emit a candidate answer after validation failure.

Sources contain actual document/chunk identity and meaningful section/page mappings. Next.js generates short-lived authorized source access; never accept LLM-authored URLs. Check status again on resolution. Deleted/retired sources become unavailable in historical answers and cannot support new questions.

Progress is an allowlisted stage/status event, with no draft answer text. Check backend stream bytes as well as rendered UI: buffering a draft in a hidden component still exposes it to the browser. No raw token streaming before validation.

## Tuning and gates

PRD initial assumptions remain tunable: approximately 400–800-token chunks, practical ~1,000-token maximum with indivisible-unit exceptions, ~10–15% overlap when splitting, 10–20 candidates per branch, 4–6 final passages, and 6–10 recent messages. `text-embedding-3-small` is a candidate; exact dimensions/models must follow project entitlement and current documentation. ADR 23's GPT-6 Luna selection is not proof of an enabled API model ID.

Do not silently select a substitute model, language/search configuration, scoring threshold, provider region, or bridge transport. Record experiments/configuration in evaluation evidence and preserve open gates in [PLANS.md](../PLANS.md).

Run [validate-rag](../.agents/skills/validate-rag/SKILL.md) and the [testing matrix](testing.md). Release-changing model/retrieval/workflow changes require the versioned 50-question benchmark: at least 43/50 correct, 100% valid supporting citations and 0 invented procedural steps in that set. Record latency per stage and first meaningful answer separately from progress; these test results are not universal guarantees.
