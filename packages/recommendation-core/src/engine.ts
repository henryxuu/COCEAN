import { canonicalHash, stableJson, stableUnitInterval } from "./hash.js";
import {
  ALGORITHM_VERSION,
  CONCENTRATION_PENALTY_PER_DIMENSION,
  FEATURE_CONTRACT_VERSION,
  MAX_CONCENTRATION_PENALTY,
  RANKER_POLICY_VERSION,
  RECENT_EXPOSURE_PENALTY,
  baselineWeights,
} from "./policy.js";
import type {
  AcceptedRuntimeCandidate,
  AffinityDimension,
  DiversityPenaltyTrace,
  ExecutionFailure,
  FeatureContribution,
  FeatureGroup,
  HistorySnapshot,
  KnowledgeValue,
  MomentFitTerm,
  PrebindingFixtureCandidate,
  RankedCandidate,
  RecommendationCandidate,
  RecommendationDiagnostics,
  RecommendationExecutionResult,
  RecommendationFailureResult,
  RecommendationInput,
  RecommendationRankResult,
  RejectionReason,
  SemanticDimension,
  SourcePath,
  StructuredMoment,
  VersionTrace,
} from "./types.js";

interface GroupMetric {
  readonly group: FeatureGroup;
  readonly match: number;
  readonly reliability: number;
}

interface ScoredEntry {
  readonly candidate: RecommendationCandidate;
  readonly ranked: RankedCandidate;
}

interface MutableDiagnosticsState {
  hardEligibleCandidateCount: number;
  rankedCandidateCount: number;
  readonly rejectedCandidates: Record<string, RejectionReason>;
}

const SCORE_TIE_EPSILON = 1e-9;

/**
 * Runs the frozen v0.10 deterministic baseline. This module has no provider,
 * network, clock, random-number, storage, or model dependency.
 */
export function recommend(
  input: RecommendationInput,
  candidates: readonly RecommendationCandidate[],
): RecommendationExecutionResult {
  const sortedCandidates = [...candidates].sort(compareCandidateIdentity);
  const inputCanonicalHash = canonicalHash(
    sortInputCollections({ input, candidates: sortedCandidates }),
  );
  const versions = versionTrace(input);
  const state: MutableDiagnosticsState = {
    hardEligibleCandidateCount: 0,
    rankedCandidateCount: 0,
    rejectedCandidates: {},
  };

  const validationFailure = validate(input, sortedCandidates);
  if (validationFailure !== null) {
    return failureResult(
      validationFailure,
      inputCanonicalHash,
      versions,
      candidates.length,
      state,
    );
  }

  const weights = baselineWeights(input.envelope.sourcePath);
  const scored: ScoredEntry[] = [];

  for (const candidate of sortedCandidates) {
    const rejection = hardGate(candidate, input);
    if (rejection !== null) {
      state.rejectedCandidates[candidate.candidateId] = rejection;
      continue;
    }
    state.hardEligibleCandidateCount += 1;

    const activeMetrics = groupMetrics(candidate, input).filter(
      (metric) => (weights[metric.group] ?? 0) > 0 && metric.reliability > 0,
    );
    const denominator = activeMetrics.reduce(
      (sum, metric) => sum + (weights[metric.group] ?? 0),
      0,
    );
    if (denominator <= 0) {
      state.rejectedCandidates[candidate.candidateId] =
        "gate-07-path-primary-evidence";
      continue;
    }

    const contributions = activeMetrics
      .map((metric): FeatureContribution => {
        const configuredWeight = weights[metric.group] ?? 0;
        return {
          group: metric.group,
          configuredWeight,
          match: metric.match,
          reliability: metric.reliability,
          weightedContribution:
            configuredWeight * metric.match * metric.reliability,
        };
      })
      .sort((left, right) => compareText(left.group, right.group));
    const numerator = contributions.reduce(
      (sum, contribution) => sum + contribution.weightedContribution,
      0,
    );
    const baseScore = numerator / denominator;
    const diversityPenalty = calculateDiversityPenalty(
      candidate,
      input.history,
    );
    scored.push({
      candidate,
      ranked: {
        candidateId: candidate.candidateId,
        stillAlbumId: candidate.stillAlbumId,
        baseScore,
        diversityPenalty,
        finalScore: Math.max(0, baseScore - diversityPenalty.total),
        contributions,
      },
    });
  }

  scored.sort(compareScoredEntries);
  const selected = applyFamilyDiversity(scored, state.rejectedCandidates);
  state.rankedCandidateCount = selected.length;
  const primary = selected[0];
  if (primary === undefined) {
    return failureResult(
      "no-eligible-candidate",
      inputCanonicalHash,
      versions,
      candidates.length,
      state,
    );
  }

  const rankedCandidates = selected.map((entry) => entry.ranked);
  const baseCandidateIds = selected
    .slice(0, 2)
    .map((entry) => entry.candidate.stillAlbumId);
  const diagnostics = makeDiagnostics(candidates.length, state);
  const traceWithoutHash = {
    inputCanonicalHash,
    activeAlbumId: primary.candidate.stillAlbumId,
    baseCandidateIds,
    rankedCandidates,
    versions,
    diagnostics,
    modelCallCount: 0 as const,
  };
  const rankTraceHash = canonicalHash(traceWithoutHash);
  const result: RecommendationRankResult = {
    inputCanonicalHash,
    rankTraceHash,
    activeAlbumId: primary.candidate.stillAlbumId,
    baseCandidateIds,
    rankedCandidates,
    versions,
    diagnostics,
    modelCallCount: 0,
    userPayload: {
      activeAlbumId: primary.candidate.stillAlbumId,
      whyInputAtomRefs: stableUnique(primary.candidate.reasonAtomRefs),
    },
  };
  return { status: "success", result };
}

function validate(
  input: RecommendationInput,
  candidates: readonly RecommendationCandidate[],
): ExecutionFailure | null {
  if (
    candidates.some(
      (candidate) => candidate.executionMode !== input.executionMode,
    )
  ) {
    return "mixed-execution-modes";
  }
  if (
    input.envelope.executionMode !== input.executionMode ||
    (candidates.length > 0 &&
      input.envelope.executionMode !== candidates[0]?.executionMode)
  ) {
    return "mode-envelope-mismatch";
  }
  if (input.envelope.sourcePath !== input.moment.sourceMode) {
    return "source-path-mismatch";
  }
  if (input.envelope.featureContractVersion !== FEATURE_CONTRACT_VERSION) {
    return "feature-contract-version-mismatch";
  }
  if (input.envelope.rankerPolicyVersion !== RANKER_POLICY_VERSION) {
    return "ranker-policy-version-mismatch";
  }
  if (
    input.envelope.explicitPreferenceVersion !==
    input.explicitPreference.preferenceVersion
  ) {
    return "explicit-preference-version-mismatch";
  }
  if (input.envelope.profileSnapshotVersion !== input.profile.profileVersion) {
    return "profile-snapshot-version-mismatch";
  }
  if (input.envelope.historySnapshotVersion !== input.history.historyVersion) {
    return "history-snapshot-version-mismatch";
  }
  if (
    input.moment.preferenceVersion !==
    input.explicitPreference.preferenceVersion
  ) {
    return "moment-preference-version-mismatch";
  }
  if (input.moment.profileVersion !== input.profile.profileVersion) {
    return "moment-profile-version-mismatch";
  }
  if (input.moment.vocabularyVersion !== input.envelope.momentFitVersion) {
    return "moment-vocabulary-version-mismatch";
  }
  if (new Set(input.explicitPreference.preferredDomains).size > 2) {
    return "explicit-preference-limit-exceeded";
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.catalogContentVersion !==
        input.envelope.catalogContentVersion,
    )
  ) {
    return "catalog-content-version-mismatch";
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.semanticProfileVersion !==
        input.envelope.semanticProfileVersion,
    )
  ) {
    return "semantic-profile-version-mismatch";
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.momentFitVersion !== input.envelope.momentFitVersion,
    )
  ) {
    return "moment-vocabulary-version-mismatch";
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.listeningStructureVersion !==
        input.envelope.listeningStructureVersion,
    )
  ) {
    return "listening-structure-version-mismatch";
  }

  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    return "duplicate-candidate-id";
  }
  if (!hasValidInputValues(input, candidates)) {
    return "invalid-input-value";
  }

  if (input.executionMode === "prebinding-fixture") {
    const fixtureCandidates =
      candidates as readonly PrebindingFixtureCandidate[];
    if (
      input.fixturePackVersion !== input.envelope.catalogContentVersion ||
      fixtureCandidates.some(
        (candidate) =>
          candidate.fixturePackVersion !== input.fixturePackVersion,
      )
    ) {
      return "fixture-pack-version-mismatch";
    }
    if (
      fixtureCandidates.some(
        (candidate) =>
          candidate.fixturePackContentHash !== input.fixturePackContentHash,
      )
    ) {
      return "fixture-pack-hash-mismatch";
    }
    if (
      fixtureCandidates.some(
        (candidate) => candidate.sourcePackRef !== input.sourcePackRef,
      )
    ) {
      return "source-pack-ref-mismatch";
    }
    if (
      fixtureCandidates.some(
        (candidate) => candidate.sourcePackHash !== input.sourcePackHash,
      )
    ) {
      return "source-pack-hash-mismatch";
    }
    if (
      fixtureCandidates.some(
        (candidate) => candidate.fixtureReviewRefs.length === 0,
      )
    ) {
      return "fixture-review-ref-missing";
    }
  } else {
    const runtimeCandidates = candidates as readonly AcceptedRuntimeCandidate[];
    if (
      input.acceptedSnapshotVersion !== input.envelope.catalogContentVersion ||
      runtimeCandidates.some(
        (candidate) =>
          candidate.acceptedSnapshotVersion !== input.acceptedSnapshotVersion,
      )
    ) {
      return "accepted-snapshot-version-mismatch";
    }
  }

  for (const candidate of candidates) {
    if (
      candidate.semanticProfileVersion.length === 0 ||
      candidate.momentFitVersion.length === 0 ||
      candidate.listeningStructureVersion.length === 0 ||
      Object.values(candidate.semanticValues).some(
        (value) =>
          value !== undefined &&
          value.selectedVersion !== candidate.semanticProfileVersion,
      ) ||
      candidate.momentFitTerms.some(
        (term) => term.version !== candidate.momentFitVersion,
      )
    ) {
      return "selected-feature-version-missing";
    }
    if (candidate.listeningFit.value !== null) {
      if (
        candidate.listeningFit.selectedVersion !==
        candidate.listeningStructureVersion
      ) {
        return "listening-fit-version-mismatch";
      }
      if (!hasReviewedEvidence(candidate, candidate.listeningFit)) {
        return "listening-fit-review-evidence-missing";
      }
    }
    if (candidate.discoveryNovelty.value !== null) {
      if (
        candidate.discoveryNovelty.selectedVersion !==
        candidate.catalogContentVersion
      ) {
        return "discovery-novelty-version-mismatch";
      }
      if (!hasReviewedEvidence(candidate, candidate.discoveryNovelty)) {
        return "discovery-novelty-review-evidence-missing";
      }
    }
  }

  if (input.envelope.sourcePath === "today") {
    if (input.envelope.todayContextSnapshotRef === undefined) {
      return "today-context-missing";
    }
    if (input.envelope.todayDisplayScope !== "all-day") {
      return "today-context-not-all-day";
    }
    if (
      input.operation === "adjustment" &&
      input.history.todaySuccessfulAdjustmentCount >= 1
    ) {
      return "today-adjustment-limit-reached";
    }
  }
  if (input.envelope.sourcePath === "compass") {
    if (input.moment.currentStateId === undefined) {
      return "compass-state-missing";
    }
    if (input.moment.activityId === undefined) {
      return "compass-activity-missing";
    }
  }
  if (
    input.operation === "replacement" &&
    input.history.replacementCount >= 2
  ) {
    return "replacement-limit-reached";
  }
  return null;
}

function hardGate(
  candidate: RecommendationCandidate,
  input: RecommendationInput,
): RejectionReason | null {
  // Frozen gate order: mode, qualification, identity, storefront/fixture
  // availability, explicit constraints, disliked, primary evidence, session,
  // and finally content safety.
  if (candidate.executionMode !== input.executionMode) {
    return "gate-01-mode-isolation";
  }
  if (candidate.executionMode === "prebinding-fixture") {
    if (
      candidate.fixtureApproval !== "algorithm-test-only" ||
      candidate.sourceDisposition !== "pilot-ready-for-binding" ||
      candidate.bindingState !== "unresolved"
    ) {
      return "gate-02-publication-qualification";
    }
  } else if (
    candidate.catalogStatus !== "accepted" ||
    candidate.editionStatus !== "accepted" ||
    !candidate.selectedRevisionsValid
  ) {
    return "gate-02-publication-qualification";
  }

  if (
    candidate.stillAlbumId.length === 0 ||
    candidate.albumEditionId.length === 0 ||
    candidate.recordingFamilyIds.length === 0 ||
    candidate.releaseFamilyId.length === 0 ||
    (candidate.executionMode === "prebinding-fixture" &&
      candidate.fixtureIdentityStatus !== "resolved-for-test") ||
    (candidate.executionMode === "accepted-runtime" &&
      candidate.identityStatus !== "consistent")
  ) {
    return "gate-03-identity-consistency";
  }

  if (candidate.executionMode === "prebinding-fixture") {
    if (candidate.fixtureAvailability !== "eligible") {
      return "gate-04-storefront-availability";
    }
  } else if (
    candidate.binding.storefront !== input.envelope.storefront ||
    candidate.binding.matchType !== "exact" ||
    candidate.binding.bindingStatus !== "verified" ||
    candidate.binding.availabilityStatus !== "available"
  ) {
    return "gate-04-storefront-availability";
  }

  const supported = new Set(candidate.supportedConstraints);
  const conflicting = new Set(candidate.conflictingConstraints);
  if (
    !isSubset(new Set(input.moment.positiveConstraints), supported) ||
    !isDisjoint(new Set(input.moment.negativeConstraints), supported) ||
    !isDisjoint(new Set(input.moment.positiveConstraints), conflicting)
  ) {
    return "gate-05-explicit-constraint";
  }
  if (
    input.history.explicitAlbumStates[candidate.stillAlbumId] === "disliked"
  ) {
    return "gate-06-explicitly-disliked";
  }
  if (!hasPrimaryEvidence(candidate, input)) {
    return "gate-07-path-primary-evidence";
  }
  if (input.history.deliveredAlbumIds.includes(candidate.stillAlbumId)) {
    return "gate-08-session-album-duplicate";
  }
  if (
    !isDisjoint(
      new Set(input.history.deliveredRecordingFamilyIds),
      new Set(candidate.recordingFamilyIds),
    )
  ) {
    return "gate-08-session-recording-family-duplicate";
  }
  if (
    input.history.deliveredReleaseFamilyIds.includes(candidate.releaseFamilyId)
  ) {
    return "gate-08-session-release-family-duplicate";
  }
  if (candidate.contentSafety !== "safe") {
    return "gate-09-content-safety";
  }
  return null;
}

function hasPrimaryEvidence(
  candidate: RecommendationCandidate,
  input: RecommendationInput,
): boolean {
  if (input.envelope.sourcePath === "today") {
    return (
      Object.values(candidate.semanticValues).some(
        (value) => value?.value !== null && value?.value !== undefined,
      ) ||
      candidate.listeningFit.value !== null ||
      candidate.discoveryNovelty.value !== null ||
      candidate.domain.length > 0
    );
  }
  const selected = new Set(selectedMomentKeys(input.moment));
  return candidate.momentFitTerms.some(
    (term) =>
      term.polarity === "positive" &&
      term.reliability > 0 &&
      selected.has(`${term.bucket}|${term.vocabularyId}`),
  );
}

function groupMetrics(
  candidate: RecommendationCandidate,
  input: RecommendationInput,
): GroupMetric[] {
  const metrics: GroupMetric[] = [];
  const sourcePath = input.envelope.sourcePath;
  if (sourcePath !== "today") {
    metrics.push(momentMetric(candidate.momentFitTerms, input.moment));
  }
  const semantic = semanticMetric(candidate, input.moment);
  if (semantic !== null) metrics.push(semantic);
  metrics.push(profileMetric(candidate, input));
  if (candidate.listeningFit.value !== null) {
    metrics.push({
      group: "listening-fit",
      match: candidate.listeningFit.value,
      reliability: candidate.listeningFit.reliability,
    });
  }
  if (sourcePath === "today") {
    const rotation = stableUnitInterval(
      `${input.envelope.dayKey}|${input.envelope.catalogContentVersion}|${candidate.stillAlbumId}|${RANKER_POLICY_VERSION}`,
    );
    const novelty = candidate.discoveryNovelty;
    metrics.push(
      novelty.value === null
        ? { group: "novelty", match: rotation, reliability: 1 }
        : {
            group: "novelty",
            match: novelty.value * 0.7 + rotation * 0.3,
            reliability: novelty.reliability,
          },
    );
  } else if (
    sourcePath === "ticket" &&
    candidate.discoveryNovelty.value !== null
  ) {
    metrics.push({
      group: "novelty",
      match:
        1 -
        Math.abs(candidate.discoveryNovelty.value - input.moment.exploration),
      reliability: candidate.discoveryNovelty.reliability,
    });
  }
  return metrics;
}

function momentMetric(
  terms: readonly MomentFitTerm[],
  moment: StructuredMoment,
): GroupMetric {
  const selected = stableUnique(selectedMomentKeys(moment));
  const matches = selected
    .map((key) =>
      terms.find(
        (term) =>
          `${term.bucket}|${term.vocabularyId}` === key &&
          term.polarity === "positive" &&
          term.reliability > 0,
      ),
    )
    .filter((term): term is MomentFitTerm => term !== undefined);
  return {
    group: "moment-fit",
    match: selected.length === 0 ? 0 : matches.length / selected.length,
    reliability:
      matches.length === 0
        ? 0
        : matches.reduce((sum, term) => sum + term.reliability, 0) /
          matches.length,
  };
}

function semanticMetric(
  candidate: RecommendationCandidate,
  moment: StructuredMoment,
): GroupMetric | null {
  const values: Array<{ match: number; reliability: number }> = [];
  for (const [dimension, target] of sortedEntries(
    moment.targetVector,
  ) as ReadonlyArray<readonly [SemanticDimension, number]>) {
    const knowledge = candidate.semanticValues[dimension];
    if (knowledge?.value === null || knowledge?.value === undefined) continue;
    values.push({
      match: 1 - Math.abs(target - knowledge.value),
      reliability: knowledge.reliability,
    });
  }
  if (values.length === 0) return null;
  return {
    group: "semantic-fit",
    match: average(values.map((value) => value.match)),
    reliability: average(values.map((value) => value.reliability)),
  };
}

function profileMetric(
  candidate: RecommendationCandidate,
  input: RecommendationInput,
): GroupMetric {
  const normalizedDomain = normalizeDomain(candidate.domain);
  const preferredDomains = new Set<string>(
    input.explicitPreference.preferredDomains,
  );
  const inferred = inferredAffinity(candidate, input);
  let match: number;
  if (preferredDomains.size === 0) {
    match = input.profile.legacyInferencePaused ? 0.5 : 0.5 + inferred * 0.25;
  } else {
    const explicitMatch = preferredDomains.has(normalizedDomain) ? 1 : 0;
    match =
      explicitMatch * 0.8 +
      (input.profile.legacyInferencePaused ? 0 : inferred * 0.2);
  }
  const explicitState =
    input.history.explicitAlbumStates[candidate.stillAlbumId];
  if (
    explicitState === "favorite" ||
    explicitState === "listen-later" ||
    explicitState === "listened"
  ) {
    match = 1;
  }
  return {
    group: "explicit-profile-fit",
    match: clamp(match, 0, 1),
    reliability: 1,
  };
}

function inferredAffinity(
  candidate: RecommendationCandidate,
  input: RecommendationInput,
): number {
  if (input.profile.legacyInferencePaused) return 0;
  const candidateValues: Readonly<
    Record<AffinityDimension, ReadonlySet<string>>
  > = {
    domain: new Set([normalizeDomain(candidate.domain)]),
    genre: new Set(candidate.genreIds),
    artist: new Set([candidate.primaryArtistId]),
    composer: new Set(candidate.composerIds),
    instrument: new Set(candidate.instrumentIds),
    ensemble: new Set(candidate.ensembleIds),
    era: new Set([candidate.eraId]),
    label: new Set([candidate.labelId]),
  };
  const matches = input.profile.affinities
    .filter((affinity) =>
      candidateValues[affinity.dimension].has(affinity.valueId),
    )
    .map((affinity) => affinity.score * affinity.confidence)
    .sort((left, right) => {
      const magnitudeDifference = Math.abs(right) - Math.abs(left);
      return magnitudeDifference === 0 ? right - left : magnitudeDifference;
    });
  return matches[0] ?? 0;
}

function calculateDiversityPenalty(
  candidate: RecommendationCandidate,
  history: HistorySnapshot,
): DiversityPenaltyTrace {
  const repeatedDimensions: AffinityDimension[] = [];
  if (
    !isDisjoint(
      new Set(history.recentComposerIds),
      new Set(candidate.composerIds),
    )
  ) {
    repeatedDimensions.push("composer");
  }
  if (history.recentPrimaryArtistIds.includes(candidate.primaryArtistId)) {
    repeatedDimensions.push("artist");
  }
  if (
    !isDisjoint(
      new Set(history.recentEnsembleIds),
      new Set(candidate.ensembleIds),
    )
  ) {
    repeatedDimensions.push("ensemble");
  }
  if (history.recentLabelIds.includes(candidate.labelId)) {
    repeatedDimensions.push("label");
  }
  if (history.recentEraIds.includes(candidate.eraId)) {
    repeatedDimensions.push("era");
  }
  if (history.recentDomains.includes(normalizeDomain(candidate.domain))) {
    repeatedDimensions.push("domain");
  }
  const recentExposure = history.recentlyExposedAlbumIds.includes(
    candidate.stillAlbumId,
  )
    ? RECENT_EXPOSURE_PENALTY
    : 0;
  const concentration = Math.min(
    MAX_CONCENTRATION_PENALTY,
    repeatedDimensions.length * CONCENTRATION_PENALTY_PER_DIMENSION,
  );
  return {
    recentExposure,
    concentration,
    total: recentExposure + concentration,
    repeatedDimensions,
  };
}

function applyFamilyDiversity(
  scored: readonly ScoredEntry[],
  rejected: Record<string, RejectionReason>,
): ScoredEntry[] {
  const selected: ScoredEntry[] = [];
  const seenAlbums = new Set<string>();
  const seenRecordingFamilies = new Set<string>();
  const seenReleaseFamilies = new Set<string>();
  for (const entry of scored) {
    const candidate = entry.candidate;
    if (seenAlbums.has(candidate.stillAlbumId)) {
      rejected[candidate.candidateId] = "gate-08-session-album-duplicate";
      continue;
    }
    if (
      !isDisjoint(seenRecordingFamilies, new Set(candidate.recordingFamilyIds))
    ) {
      rejected[candidate.candidateId] =
        "gate-08-session-recording-family-duplicate";
      continue;
    }
    if (seenReleaseFamilies.has(candidate.releaseFamilyId)) {
      rejected[candidate.candidateId] =
        "gate-08-session-release-family-duplicate";
      continue;
    }
    selected.push(entry);
    seenAlbums.add(candidate.stillAlbumId);
    candidate.recordingFamilyIds.forEach((id) => seenRecordingFamilies.add(id));
    seenReleaseFamilies.add(candidate.releaseFamilyId);
  }
  return selected;
}

function hasValidInputValues(
  input: RecommendationInput,
  candidates: readonly RecommendationCandidate[],
): boolean {
  const requiredInputStrings = [
    input.envelope.requestId,
    input.envelope.structuredMomentRef,
    input.envelope.explicitPreferenceVersion,
    input.envelope.profileSnapshotVersion,
    input.envelope.historySnapshotVersion,
    input.envelope.catalogContentVersion,
    input.envelope.semanticProfileVersion,
    input.envelope.momentFitVersion,
    input.envelope.listeningStructureVersion,
    input.envelope.featureContractVersion,
    input.envelope.rankerPolicyVersion,
    input.envelope.dayKey,
    input.moment.vocabularyVersion,
    input.moment.preferenceVersion,
    input.moment.profileVersion,
  ];
  if (requiredInputStrings.some((value) => value.length === 0)) return false;
  if (!inUnitInterval(input.moment.exploration)) return false;
  if (
    Object.values(input.moment.targetVector).some(
      (value) => value !== undefined && !inUnitInterval(value),
    )
  ) {
    return false;
  }
  if (
    !Number.isInteger(input.history.replacementCount) ||
    input.history.replacementCount < 0 ||
    !Number.isInteger(input.history.todaySuccessfulAdjustmentCount) ||
    input.history.todaySuccessfulAdjustmentCount < 0
  ) {
    return false;
  }
  if (
    input.profile.affinities.some(
      (affinity) =>
        affinity.valueId.length === 0 ||
        !Number.isFinite(affinity.score) ||
        affinity.score < -1 ||
        affinity.score > 1 ||
        !inUnitInterval(affinity.confidence),
    )
  ) {
    return false;
  }
  return candidates.every((candidate) => {
    if (candidate.candidateId.length === 0) return false;
    const knowledgeValues: KnowledgeValue[] = [
      ...Object.values(candidate.semanticValues).filter(
        (value): value is NonNullable<typeof value> => value !== undefined,
      ),
      candidate.listeningFit,
      candidate.discoveryNovelty,
    ];
    if (knowledgeValues.some((value) => !isValidKnowledgeValue(value))) {
      return false;
    }
    return candidate.momentFitTerms.every(
      (term) =>
        term.vocabularyId.length > 0 &&
        term.version.length > 0 &&
        term.reviewRef.length > 0 &&
        (term.confidence === null || inUnitInterval(term.confidence)) &&
        inUnitInterval(term.reliability) &&
        (term.confidence !== null || term.reliability === 0),
    );
  });
}

function isValidKnowledgeValue(value: KnowledgeValue): boolean {
  return (
    value.selectedVersion.length > 0 &&
    inUnitInterval(value.reliability) &&
    (value.value === null
      ? value.reliability === 0 && value.evidenceRefs.length === 0
      : inUnitInterval(value.value))
  );
}

function hasReviewedEvidence(
  candidate: RecommendationCandidate,
  value: KnowledgeValue,
): boolean {
  const shared = new Set(
    value.reviewRefs.filter((review) => value.evidenceRefs.includes(review)),
  );
  if (shared.size === 0) return false;
  if (candidate.executionMode === "accepted-runtime") return true;
  return candidate.fixtureReviewRefs.some(
    (review) => review.startsWith("fixture-review:") && shared.has(review),
  );
}

function selectedMomentKeys(moment: StructuredMoment): string[] {
  const keys: string[] = [];
  if (moment.currentStateId !== undefined) {
    keys.push(`state|${moment.currentStateId}`);
  }
  if (moment.activityId !== undefined) {
    keys.push(`activity|${moment.activityId}`);
  }
  if (moment.desiredDirectionId !== undefined) {
    keys.push(`direction|${moment.desiredDirectionId}`);
  }
  if (moment.contextId !== undefined) {
    keys.push(`context|${moment.contextId}`);
  }
  moment.positiveConstraints.forEach((value) =>
    keys.push(`constraint|${value}`),
  );
  return keys;
}

function versionTrace(input: RecommendationInput): VersionTrace {
  return {
    algorithmVersion: ALGORITHM_VERSION,
    featureContractVersion: input.envelope.featureContractVersion,
    rankerPolicyVersion: input.envelope.rankerPolicyVersion,
    catalogContentVersion: input.envelope.catalogContentVersion,
    semanticProfileVersion: input.envelope.semanticProfileVersion,
    momentFitVersion: input.envelope.momentFitVersion,
    listeningStructureVersion: input.envelope.listeningStructureVersion,
    vocabularyVersion: input.moment.vocabularyVersion,
    explicitPreferenceVersion: input.envelope.explicitPreferenceVersion,
    profileSnapshotVersion: input.envelope.profileSnapshotVersion,
    historySnapshotVersion: input.envelope.historySnapshotVersion,
    executionMode: input.executionMode,
  };
}

function failureResult(
  failure: ExecutionFailure,
  inputCanonicalHash: string,
  versions: VersionTrace,
  generatedCandidateCount: number,
  state: MutableDiagnosticsState,
): RecommendationFailureResult {
  return {
    status: "unavailable",
    failure,
    inputCanonicalHash,
    versions,
    diagnostics: makeDiagnostics(generatedCandidateCount, state),
    modelCallCount: 0,
  };
}

function makeDiagnostics(
  generatedCandidateCount: number,
  state: MutableDiagnosticsState,
): RecommendationDiagnostics {
  const rejectionCountsByReason: Partial<Record<RejectionReason, number>> = {};
  for (const reason of Object.values(state.rejectedCandidates)) {
    rejectionCountsByReason[reason] =
      (rejectionCountsByReason[reason] ?? 0) + 1;
  }
  return {
    generatedCandidateCount,
    hardEligibleCandidateCount: state.hardEligibleCandidateCount,
    rankedCandidateCount: state.rankedCandidateCount,
    rejectedCandidates: sortRecord(state.rejectedCandidates),
    rejectionCountsByReason: sortRecord(rejectionCountsByReason),
    modelCallCount: 0,
  };
}

function compareCandidateIdentity(
  left: RecommendationCandidate,
  right: RecommendationCandidate,
): number {
  return compareText(left.candidateId, right.candidateId);
}

function compareScoredEntries(left: ScoredEntry, right: ScoredEntry): number {
  const scoreDifference = right.ranked.finalScore - left.ranked.finalScore;
  if (Math.abs(scoreDifference) > SCORE_TIE_EPSILON) return scoreDifference;
  const albumDifference = compareText(
    left.candidate.stillAlbumId,
    right.candidate.stillAlbumId,
  );
  if (albumDifference !== 0) return albumDifference;
  return compareText(left.candidate.candidateId, right.candidate.candidateId);
}

function normalizeDomain(domain: string): MusicDomainForComparison {
  switch (domain) {
    case "album-first-pop":
      return "pop";
    case "ambient-modern-classical":
      return "ambient";
    case "world-folk":
      return "world";
    default:
      return domain;
  }
}

type MusicDomainForComparison = string;

function inUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isSubset<T>(
  subset: ReadonlySet<T>,
  superset: ReadonlySet<T>,
): boolean {
  for (const value of subset) if (!superset.has(value)) return false;
  return true;
}

function isDisjoint<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  for (const value of left) if (right.has(value)) return false;
  return true;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function sortedEntries<T extends object>(
  value: T,
): ReadonlyArray<readonly [string, unknown]> {
  return Object.entries(value).sort(([left], [right]) =>
    compareText(left, right),
  );
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => compareText(left, right)),
  );
}

/** Input arrays are semantic sets in the frozen contract, so order is neutral. */
function sortInputCollections(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(sortInputCollections)
      .sort((left, right) => compareText(stableJson(left), stableJson(right)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, sortInputCollections(item)]),
    );
  }
  return value;
}

/** Locale-independent UTF-16 lexical ordering for cross-platform replay. */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
