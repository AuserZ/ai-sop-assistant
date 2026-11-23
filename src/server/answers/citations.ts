import type { AuthDatabase } from "../auth/rate-limit";
import { documentLibraryBounds } from "../documents/contracts";
import type {
  ActiveChunkCandidate,
  RerankedPassage,
  SnapshotIdentity,
} from "../retrieval/contracts";
import { loadOriginalActivePassagesByIds } from "../retrieval/search";
import {
  supportedAnswerSourceSchema,
  type GeneratorClaim,
  type SupportedAnswerSource,
} from "./contracts";

export type CitationResolutionResult =
  | { ok: true; sources: SupportedAnswerSource[] }
  | { ok: false; reason: "SOURCE_ELIGIBILITY_REVOKED" };

function sanitizeSectionParam(section: string): string {
  return section
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, documentLibraryBounds.maximumSectionLength);
}

export function buildBackendSourcePath(
  documentId: string,
  section: string,
  pageStart: number | null,
): string {
  const params = new URLSearchParams();
  const cleanSection = sanitizeSectionParam(section);
  if (cleanSection.length > 0) {
    params.set("section", cleanSection);
  }
  if (
    pageStart !== null &&
    Number.isInteger(pageStart) &&
    pageStart >= 1 &&
    pageStart <= documentLibraryBounds.maximumPageNumber
  ) {
    params.set("page", String(pageStart));
  }

  const base = `/api/documents/${encodeURIComponent(documentId)}/source`;
  const query = params.toString();
  return query.length > 0 ? `${base}?${query}` : base;
}

function matchesSnapshotIdentity(
  row: ActiveChunkCandidate,
  expected: SnapshotIdentity,
): boolean {
  return (
    row.chunkId === expected.chunkId &&
    row.documentId === expected.documentId &&
    row.jobId === expected.jobId &&
    row.pipelineVersion === expected.pipelineVersion &&
    row.sourceSha256 === expected.sourceSha256 &&
    row.contentHash === expected.contentHash
  );
}

export async function resolveVerifiedCitations(
  claims: GeneratorClaim[],
  originalPassages: RerankedPassage[],
  options: {
    database?: AuthDatabase;
    loadOriginalPassagesImpl?: typeof loadOriginalActivePassagesByIds;
  } = {},
): Promise<CitationResolutionResult> {
  const passageById = new Map(originalPassages.map((passage) => [passage.chunkId, passage]));
  const orderedSnapshots: SnapshotIdentity[] = [];
  const seenChunkIds = new Set<string>();

  for (const claim of claims) {
    for (const chunkId of claim.chunkIds) {
      if (seenChunkIds.has(chunkId)) continue;
      const passage = passageById.get(chunkId);
      if (!passage) {
        return { ok: false, reason: "SOURCE_ELIGIBILITY_REVOKED" };
      }
      seenChunkIds.add(chunkId);
      orderedSnapshots.push({
        chunkId: passage.chunkId,
        documentId: passage.documentId,
        jobId: passage.jobId,
        pipelineVersion: passage.pipelineVersion,
        sourceSha256: passage.sourceSha256,
        contentHash: passage.contentHash,
      });
    }
  }

  if (orderedSnapshots.length === 0) {
    return { ok: false, reason: "SOURCE_ELIGIBILITY_REVOKED" };
  }

  const loadOriginal = options.loadOriginalPassagesImpl ?? loadOriginalActivePassagesByIds;
  const liveRows = await loadOriginal(orderedSnapshots, { database: options.database });
  const liveRowById = new Map(liveRows.map((row) => [row.chunkId, row]));

  const sources: SupportedAnswerSource[] = [];

  for (const expected of orderedSnapshots) {
    const live = liveRowById.get(expected.chunkId);
    if (!live || !matchesSnapshotIdentity(live, expected)) {
      return { ok: false, reason: "SOURCE_ELIGIBILITY_REVOKED" };
    }

    const sourceDraft: SupportedAnswerSource = {
      documentId: live.documentId,
      chunkId: live.chunkId,
      sopTitle: live.documentTitle,
      section: live.sectionPath,
      sourcePath: buildBackendSourcePath(live.documentId, live.sectionPath, live.pageStart),
      ...(live.pageStart !== null ? { pageStart: live.pageStart } : {}),
      ...(live.pageEnd !== null ? { pageEnd: live.pageEnd } : {}),
    };

    sources.push(supportedAnswerSourceSchema.parse(sourceDraft));
  }

  return { ok: true, sources };
}
