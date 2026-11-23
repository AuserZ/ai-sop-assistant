import {
  retrievalDefaults,
  RetrievalError,
  type ActiveChunkCandidate,
  type FusedCandidate,
  type KeywordCandidate,
  type SemanticCandidate,
} from "./contracts";

function hasMatchingSnapshotIdentity(left: ActiveChunkCandidate, right: ActiveChunkCandidate): boolean {
  return (
    left.chunkId === right.chunkId &&
    left.documentId === right.documentId &&
    left.jobId === right.jobId &&
    left.pipelineVersion === right.pipelineVersion &&
    left.sourceSha256 === right.sourceSha256 &&
    left.contentHash === right.contentHash
  );
}

export function fuseHybridCandidates(
  semantic: SemanticCandidate[],
  keyword: KeywordCandidate[],
  options: { rrfK?: number; maxCandidates?: number } = {},
): FusedCandidate[] {
  const rrfK = options.rrfK ?? retrievalDefaults.rrfK;
  const maxCandidates = options.maxCandidates ?? retrievalDefaults.maxRerankCandidates;

  if (!Number.isInteger(rrfK) || rrfK < 1 || !Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new RetrievalError("RETRIEVAL_INVALID_INPUT", false, 400);
  }

  const fusedById = new Map<string, FusedCandidate>();

  for (let index = 0; index < semantic.length; index++) {
    const candidate = semantic[index];
    const rank = candidate.semanticRank >= 1 ? candidate.semanticRank : index + 1;
    const contribution = 1 / (rrfK + rank);
    const existing = fusedById.get(candidate.chunkId);

    if (existing) {
      if (!hasMatchingSnapshotIdentity(existing, candidate)) {
        throw new RetrievalError("RETRIEVAL_IDENTITY_CONFLICT", false, 500);
      }
      if (existing.semanticRank === null || rank < existing.semanticRank) {
        const previousContribution = existing.semanticRank !== null ? 1 / (rrfK + existing.semanticRank) : 0;
        existing.rrfScore = existing.rrfScore - previousContribution + contribution;
        existing.semanticRank = rank;
        existing.cosineDistance = candidate.cosineDistance;
        existing.bestBranchRank = Math.min(existing.bestBranchRank, rank);
      }
      continue;
    }

    fusedById.set(candidate.chunkId, {
      chunkId: candidate.chunkId,
      documentId: candidate.documentId,
      documentTitle: candidate.documentTitle,
      fileName: candidate.fileName,
      jobId: candidate.jobId,
      pipelineVersion: candidate.pipelineVersion,
      sourceSha256: candidate.sourceSha256,
      sequence: candidate.sequence,
      sectionPath: candidate.sectionPath,
      pageStart: candidate.pageStart,
      pageEnd: candidate.pageEnd,
      contentType: candidate.contentType,
      text: candidate.text,
      contentHash: candidate.contentHash,
      tokenEstimate: candidate.tokenEstimate,
      rrfScore: contribution,
      semanticRank: rank,
      keywordRank: null,
      bestBranchRank: rank,
      cosineDistance: candidate.cosineDistance,
      keywordScore: null,
    });
  }

  for (let index = 0; index < keyword.length; index++) {
    const candidate = keyword[index];
    const rank = candidate.keywordRank >= 1 ? candidate.keywordRank : index + 1;
    const contribution = 1 / (rrfK + rank);
    const existing = fusedById.get(candidate.chunkId);

    if (existing) {
      if (!hasMatchingSnapshotIdentity(existing, candidate)) {
        throw new RetrievalError("RETRIEVAL_IDENTITY_CONFLICT", false, 500);
      }
      if (existing.keywordRank === null || rank < existing.keywordRank) {
        const previousContribution = existing.keywordRank !== null ? 1 / (rrfK + existing.keywordRank) : 0;
        existing.rrfScore = existing.rrfScore - previousContribution + contribution;
        existing.keywordRank = rank;
        existing.keywordScore = candidate.keywordScore;
        existing.bestBranchRank = Math.min(existing.bestBranchRank, rank);
      }
      continue;
    }

    fusedById.set(candidate.chunkId, {
      chunkId: candidate.chunkId,
      documentId: candidate.documentId,
      documentTitle: candidate.documentTitle,
      fileName: candidate.fileName,
      jobId: candidate.jobId,
      pipelineVersion: candidate.pipelineVersion,
      sourceSha256: candidate.sourceSha256,
      sequence: candidate.sequence,
      sectionPath: candidate.sectionPath,
      pageStart: candidate.pageStart,
      pageEnd: candidate.pageEnd,
      contentType: candidate.contentType,
      text: candidate.text,
      contentHash: candidate.contentHash,
      tokenEstimate: candidate.tokenEstimate,
      rrfScore: contribution,
      semanticRank: null,
      keywordRank: rank,
      bestBranchRank: rank,
      cosineDistance: null,
      keywordScore: candidate.keywordScore,
    });
  }

  return Array.from(fusedById.values())
    .sort((left, right) => {
      const scoreDiff = right.rrfScore - left.rrfScore;
      if (Math.abs(scoreDiff) > 1e-12) return scoreDiff;
      if (left.bestBranchRank !== right.bestBranchRank) {
        return left.bestBranchRank - right.bestBranchRank;
      }
      return left.chunkId.localeCompare(right.chunkId);
    })
    .slice(0, maxCandidates);
}
