---
name: validate-rag
description: Validate AI SOP Assistant retrieval, source fidelity, grounding, citations, judge decisions, and stream safety after relevant changes or during a focused RAG review. Use synthetic fixtures and existing checks; do not call live providers by default.
---

# Validate the evidence and answer path

Read [AGENTS.md](../../../AGENTS.md), the complete [technical PRD](<../../../AI SOP Assistant — Technical Product Req.md>), [RAG pipeline](../../../docs/rag-pipeline.md), and relevant [tests](../../../docs/testing.md). Keep both original PRDs unchanged. Map findings to C2–C5 and affected D1–D5/architecture invariants. A review request authorizes inspection and relevant existing checks; implement fixes only within the user's requested scope.

## Evidence eligibility and fidelity

Trace native extraction, OCR fallback, page/section/table mappings, structure-aware chunks, and revision-bound Admin verification. Check that immutable source hash, successful job, chunk snapshot, and approval agree. OCR failure or low-confidence text must not auto-activate a source.

Inspect semantic and keyword queries independently: each must constrain eligibility to manually verified ACTIVE documents before candidate selection. Exercise pending/rejected/failed/deleted documents and revocation during a request. Deduplication/retries must not introduce stale or duplicate evidence.

Verify RRF preserves candidate identity and the GPT reranker returns only supplied chunk IDs. Reject unknown IDs/schema errors. Retrieve and preserve original passages; history, prior answers, synthetic summaries, and model knowledge are not evidence. Model names and tuning values in the PRD remain subject to entitlement checks and evaluation.

## Answer checks and delivery

Use targeted synthetic cases for:

- Procedure order, exact digits/units, thresholds, conditions, section context, and tables whose headers govern cell meanings.
- Missing/forged citations, unknown chunks, wrong document mappings, genuine versus derivative page numbers, and revoked source access.
- Embedded prompt injection and follow-ups that attempt to reuse old answers as evidence.
- Judge disagreement, uncertainty, malformed output, timeout, rate limit, and provider outage.
- Disconnect/reconnect/replay and late callbacks that could leak draft text or duplicate a final message.

Require deterministic schema/source/status/claim/quantity checks and an independent judge pass. Inspect outbound stream bytes and persisted/displayed text: no procedural candidate is released before both checks pass. Progress contains allowlisted stage data only. Backend source links must reauthorize current access and expire quickly.

An unsupported question returns exactly `No SOP found for this question`, with no sources. A provider/transport/internal failure is a separate safe service error. Do not make a failed validation look like a successful supported answer.

## Evidence report

Run the relevant existing unit, real disposable PostgreSQL/pgvector integration, n8n contract, and SSE/E2E checks; report missing infrastructure rather than substituting invented results. For release-affecting model/retrieval/workflow changes, run the versioned 50-question benchmark: at least 43 correct, 100% valid supporting citations, and 0 invented steps. Record models, pipeline/workflow/configuration versions, dataset/scoring rubric, and timings. Progress latency does not measure meaningful answer latency.

Return findings by severity with file/line evidence, triggering fixtures, requirement IDs, executed checks/results, and remaining risks. Passing the set does not prove universal correctness. Confirm PRD integrity with `node .codex/scripts/check-prd-integrity.mjs`.
