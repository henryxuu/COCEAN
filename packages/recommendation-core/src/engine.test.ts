import { describe, expect, it } from "vitest";
import {
  FEATURE_CONTRACT_VERSION,
  RANKER_POLICY_VERSION,
  RECENT_EXPOSURE_PENALTY,
  baselineWeights,
  recommend,
} from "./index.js";
import type {
  AcceptedRuntimeCandidate,
  AcceptedRuntimeInput,
  CandidateIdentityAndFeatures,
  HistorySnapshot,
  KnowledgeValue,
  PrebindingFixtureCandidate,
  PrebindingFixtureInput,
  RecommendationCandidate,
  RecommendationInputEnvelope,
  SourcePath,
  StructuredMoment,
} from "./types.js";

const VERSIONS = {
  catalog: "synthetic-catalog-v1",
  semantic: "synthetic-semantic-v1",
  moment: "synthetic-moment-v1",
  listening: "synthetic-listening-v1",
  preference: "synthetic-preference-v1",
  profile: "synthetic-profile-v1",
  history: "synthetic-history-v1",
} as const;

const REVIEW_REF = "fixture-review:cocean-synthetic-v1";

const unknownKnowledge = (selectedVersion: string): KnowledgeValue => ({
  value: null,
  reliability: 0,
  selectedVersion,
  reviewRefs: [],
  evidenceRefs: [],
});

const reviewedKnowledge = (
  value: number,
  selectedVersion: string,
): KnowledgeValue => ({
  value,
  reliability: 1,
  selectedVersion,
  reviewRefs: [REVIEW_REF],
  evidenceRefs: [REVIEW_REF],
});

function history(overrides: Partial<HistorySnapshot> = {}): HistorySnapshot {
  return {
    historyVersion: VERSIONS.history,
    explicitAlbumStates: {},
    deliveredAlbumIds: [],
    deliveredRecordingFamilyIds: [],
    deliveredReleaseFamilyIds: [],
    recentlyExposedAlbumIds: [],
    recentComposerIds: [],
    recentPrimaryArtistIds: [],
    recentEnsembleIds: [],
    recentLabelIds: [],
    recentEraIds: [],
    recentDomains: [],
    replacementCount: 0,
    todaySuccessfulAdjustmentCount: 0,
    ...overrides,
  };
}

function envelope(
  sourcePath: SourcePath,
  overrides: Partial<RecommendationInputEnvelope> = {},
): RecommendationInputEnvelope {
  const common: RecommendationInputEnvelope = {
    requestId: `synthetic-request-${sourcePath}`,
    sourcePath,
    structuredMomentRef: `synthetic-moment-${sourcePath}`,
    explicitPreferenceVersion: VERSIONS.preference,
    profileSnapshotVersion: VERSIONS.profile,
    historySnapshotVersion: VERSIONS.history,
    catalogContentVersion: VERSIONS.catalog,
    semanticProfileVersion: VERSIONS.semantic,
    momentFitVersion: VERSIONS.moment,
    listeningStructureVersion: VERSIONS.listening,
    featureContractVersion: FEATURE_CONTRACT_VERSION,
    rankerPolicyVersion: RANKER_POLICY_VERSION,
    dayKey: "2026-08-12",
    storefront: "cn",
    executionMode: "prebinding-fixture",
  };
  const today =
    sourcePath === "today"
      ? {
          todayContextSnapshotRef: "synthetic-today-context:all-day",
          todayDisplayScope: "all-day" as const,
        }
      : {};
  return { ...common, ...today, ...overrides };
}

function moment(
  sourcePath: SourcePath,
  overrides: Partial<StructuredMoment> = {},
): StructuredMoment {
  return {
    sourceMode: sourcePath,
    currentStateId: "state.focus",
    activityId: "activity.reading",
    targetVector: { energy: 0.5 },
    positiveConstraints: [],
    negativeConstraints: [],
    exploration: 0.5,
    vocabularyVersion: VERSIONS.moment,
    preferenceVersion: VERSIONS.preference,
    profileVersion: VERSIONS.profile,
    ...overrides,
  };
}

function fixtureInput(
  sourcePath: SourcePath = "compass",
  overrides: Partial<PrebindingFixtureInput> = {},
): PrebindingFixtureInput {
  return {
    executionMode: "prebinding-fixture",
    envelope: envelope(sourcePath),
    moment: moment(sourcePath),
    explicitPreference: {
      preferenceVersion: VERSIONS.preference,
      preferredDomains: [],
    },
    profile: {
      profileVersion: VERSIONS.profile,
      affinities: [],
      legacyInferencePaused: false,
    },
    history: history(),
    operation: "initial-or-replay",
    fixturePackVersion: VERSIONS.catalog,
    fixturePackContentHash: "a".repeat(64),
    sourcePackRef: "synthetic-source-pack-v1",
    sourcePackHash: "b".repeat(64),
    ...overrides,
  };
}

function commonCandidate(
  id: string,
  overrides: Partial<CandidateIdentityAndFeatures> = {},
): CandidateIdentityAndFeatures {
  return {
    candidateId: `fixture:${id}`,
    stillAlbumId: `album:${id}`,
    albumEditionId: `edition:${id}`,
    recordingFamilyIds: [`recording:${id}`],
    releaseFamilyId: `release:${id}`,
    workIds: [`work:${id}`],
    primaryArtistId: `artist:${id}`,
    composerIds: [`composer:${id}`],
    ensembleIds: [`ensemble:${id}`],
    labelId: `label:${id}`,
    eraId: "era:modern",
    domain: "ambient",
    genreIds: ["genre:ambient"],
    instrumentIds: ["instrument:piano"],
    supportedConstraints: [],
    conflictingConstraints: [],
    semanticProfileVersion: VERSIONS.semantic,
    momentFitVersion: VERSIONS.moment,
    listeningStructureVersion: VERSIONS.listening,
    semanticValues: {
      energy: {
        ...reviewedKnowledge(0.5, VERSIONS.semantic),
        calibrationAnchorId: "anchor:energy:0.5",
      },
    },
    momentFitTerms: [
      {
        vocabularyId: "state.focus",
        bucket: "state",
        polarity: "positive",
        strength: "soft",
        confidence: 1,
        reliability: 1,
        version: VERSIONS.moment,
        reviewRef: REVIEW_REF,
        evidenceRefs: [REVIEW_REF],
      },
      {
        vocabularyId: "activity.reading",
        bucket: "activity",
        polarity: "positive",
        strength: "soft",
        confidence: 1,
        reliability: 1,
        version: VERSIONS.moment,
        reviewRef: REVIEW_REF,
        evidenceRefs: [REVIEW_REF],
      },
    ],
    listeningFit: unknownKnowledge(VERSIONS.listening),
    discoveryNovelty: unknownKnowledge(VERSIONS.catalog),
    reasonAtomRefs: [`reason:${id}`],
    contentSafety: "safe",
    ...overrides,
  };
}

function fixtureCandidate(
  id: string,
  overrides: Partial<PrebindingFixtureCandidate> = {},
): PrebindingFixtureCandidate {
  return {
    ...commonCandidate(id),
    executionMode: "prebinding-fixture",
    catalogContentVersion: VERSIONS.catalog,
    fixturePackVersion: VERSIONS.catalog,
    fixturePackContentHash: "a".repeat(64),
    sourcePackRef: "synthetic-source-pack-v1",
    sourcePackHash: "b".repeat(64),
    fixtureReviewRefs: [REVIEW_REF],
    fixtureApproval: "algorithm-test-only",
    sourceDisposition: "pilot-ready-for-binding",
    fixtureIdentityStatus: "resolved-for-test",
    fixtureAvailability: "eligible",
    bindingState: "unresolved",
    ...overrides,
  };
}

function runtimeCandidate(
  id: string,
  overrides: Partial<AcceptedRuntimeCandidate> = {},
): AcceptedRuntimeCandidate {
  return {
    ...commonCandidate(id),
    executionMode: "accepted-runtime",
    catalogContentVersion: "synthetic-runtime-v1",
    acceptedSnapshotVersion: "synthetic-runtime-v1",
    catalogStatus: "accepted",
    editionStatus: "accepted",
    identityStatus: "consistent",
    selectedRevisionsValid: true,
    binding: {
      storefront: "cn",
      matchType: "exact",
      bindingStatus: "verified",
      availabilityStatus: "available",
      revisionId: `binding:${id}`,
    },
    ...overrides,
  };
}

function runtimeInput(): AcceptedRuntimeInput {
  return {
    executionMode: "accepted-runtime",
    envelope: envelope("compass", {
      executionMode: "accepted-runtime",
      catalogContentVersion: "synthetic-runtime-v1",
    }),
    acceptedSnapshotVersion: "synthetic-runtime-v1",
    moment: moment("compass"),
    explicitPreference: {
      preferenceVersion: VERSIONS.preference,
      preferredDomains: [],
    },
    profile: {
      profileVersion: VERSIONS.profile,
      affinities: [],
      legacyInferencePaused: false,
    },
    history: history(),
    operation: "initial-or-replay",
  };
}

function success(
  input: PrebindingFixtureInput | AcceptedRuntimeInput,
  candidates: readonly RecommendationCandidate[],
) {
  const result = recommend(input, candidates);
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error(result.failure);
  return result.result;
}

describe("v010-gb0-baseline-1 policy", () => {
  it("freezes the Today, Ticket and Compass group weights", () => {
    expect(baselineWeights("today")).toEqual({
      "explicit-profile-fit": 0.35,
      "semantic-fit": 0.25,
      "listening-fit": 0.15,
      novelty: 0.25,
    });
    expect(baselineWeights("ticket")).toEqual({
      "moment-fit": 0.4,
      "semantic-fit": 0.25,
      "explicit-profile-fit": 0.1,
      "listening-fit": 0.1,
      novelty: 0.15,
    });
    expect(baselineWeights("compass")).toEqual({
      "moment-fit": 0.5,
      "semantic-fit": 0.25,
      "explicit-profile-fit": 0.15,
      "listening-fit": 0.1,
    });
  });

  it("executes all three paths with their own active group weights and one primary Album", () => {
    const cases = [
      {
        path: "today" as const,
        group: "explicit-profile-fit" as const,
        weight: 0.35,
      },
      { path: "ticket" as const, group: "moment-fit" as const, weight: 0.4 },
      { path: "compass" as const, group: "moment-fit" as const, weight: 0.5 },
    ];
    for (const testCase of cases) {
      const result = success(fixtureInput(testCase.path), [
        fixtureCandidate(`${testCase.path}-primary`),
      ]);
      expect(result.activeAlbumId).toBe(`album:${testCase.path}-primary`);
      expect(result.baseCandidateIds).toHaveLength(1);
      expect(
        result.rankedCandidates[0]?.contributions.find(
          (contribution) => contribution.group === testCase.group,
        )?.configuredWeight,
      ).toBe(testCase.weight);
      expect(result.versions.rankerPolicyVersion).toBe(RANKER_POLICY_VERSION);
      expect(result.modelCallCount).toBe(0);
    }
  });
});

describe("deterministic replay and mode isolation", () => {
  it("replays identically with a reversed source order and uses stable Album tie-breaking", () => {
    const input = fixtureInput();
    const alpha = fixtureCandidate("alpha");
    const beta = fixtureCandidate("beta");

    const first = success(input, [beta, alpha]);
    const second = success(input, [alpha, beta]);

    expect(first).toEqual(second);
    expect(first.activeAlbumId).toBe("album:alpha");
    expect(first.baseCandidateIds).toEqual(["album:alpha", "album:beta"]);
    expect(first.inputCanonicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.rankTraceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.modelCallCount).toBe(0);
    expect(first.diagnostics.modelCallCount).toBe(0);
  });

  it("fails the whole pool before scoring when runtime and fixture sources are mixed", () => {
    const result = recommend(fixtureInput(), [
      fixtureCandidate("fixture"),
      runtimeCandidate("runtime"),
    ]);

    expect(result).toEqual(
      expect.objectContaining({
        status: "unavailable",
        failure: "mixed-execution-modes",
        modelCallCount: 0,
      }),
    );
    if (result.status === "success")
      throw new Error("expected mode isolation failure");
    expect(result.diagnostics.hardEligibleCandidateCount).toBe(0);
  });

  it("accepts only exact, verified, current-storefront runtime bindings", () => {
    const input = runtimeInput();
    const valid = success(input, [runtimeCandidate("runtime-valid")]);
    expect(valid.activeAlbumId).toBe("album:runtime-valid");

    const invalid = recommend(input, [
      runtimeCandidate("runtime-invalid", {
        binding: {
          storefront: "us",
          matchType: "exact",
          bindingStatus: "verified",
          availabilityStatus: "available",
          revisionId: "binding:invalid",
        },
      }),
    ]);
    expect(invalid.status).toBe("unavailable");
    if (invalid.status === "success")
      throw new Error("expected storefront rejection");
    expect(invalid.diagnostics.rejectionCountsByReason).toEqual({
      "gate-04-storefront-availability": 1,
    });
  });
});

describe("hard gates precede scoring", () => {
  it("reports the earliest frozen rejection reason even when a rejected candidate scores well", () => {
    const bad = fixtureCandidate("bad", {
      fixtureApproval: "invalid",
      fixtureIdentityStatus: "conflicted",
      semanticValues: {
        energy: {
          ...reviewedKnowledge(0.5, VERSIONS.semantic),
          calibrationAnchorId: "anchor:perfect",
        },
      },
    });
    const result = success(fixtureInput(), [bad, fixtureCandidate("safe")]);

    expect(result.diagnostics.rejectedCandidates[bad.candidateId]).toBe(
      "gate-02-publication-qualification",
    );
    expect(
      result.rankedCandidates.some(
        (item) => item.candidateId === bad.candidateId,
      ),
    ).toBe(false);
  });

  it("requires Ticket and Compass evidence to intersect the current Moment", () => {
    const unrelated = fixtureCandidate("unrelated", {
      momentFitTerms: [
        {
          vocabularyId: "state.sleepy",
          bucket: "state",
          polarity: "positive",
          strength: "soft",
          confidence: 1,
          reliability: 1,
          version: VERSIONS.moment,
          reviewRef: REVIEW_REF,
          evidenceRefs: [REVIEW_REF],
        },
      ],
    });
    const result = success(fixtureInput(), [
      unrelated,
      fixtureCandidate("related"),
    ]);
    expect(result.diagnostics.rejectedCandidates[unrelated.candidateId]).toBe(
      "gate-07-path-primary-evidence",
    );
  });

  it("fails identity, explicit-constraint and content-safety candidates at their ordered gates", () => {
    const identity = fixtureCandidate("identity", {
      fixtureIdentityStatus: "conflicted",
      contentSafety: "blocking-conflict",
    });
    const identityResult = success(fixtureInput(), [
      identity,
      fixtureCandidate("safe-identity"),
    ]);
    expect(
      identityResult.diagnostics.rejectedCandidates[identity.candidateId],
    ).toBe("gate-03-identity-consistency");

    const constraintInput = fixtureInput("compass", {
      moment: moment("compass", {
        positiveConstraints: ["constraint.instrumental"],
      }),
    });
    const unsupported = fixtureCandidate("unsupported");
    const constraintResult = success(constraintInput, [
      unsupported,
      fixtureCandidate("supported", {
        supportedConstraints: ["constraint.instrumental"],
        momentFitTerms: [
          ...fixtureCandidate("term-source").momentFitTerms,
          {
            vocabularyId: "constraint.instrumental",
            bucket: "constraint",
            polarity: "positive",
            strength: "hard",
            confidence: 1,
            reliability: 1,
            version: VERSIONS.moment,
            reviewRef: REVIEW_REF,
            evidenceRefs: [REVIEW_REF],
          },
        ],
      }),
    ]);
    expect(
      constraintResult.diagnostics.rejectedCandidates[unsupported.candidateId],
    ).toBe("gate-05-explicit-constraint");

    const unsafe = fixtureCandidate("unsafe", {
      contentSafety: "blocking-conflict",
    });
    const safetyResult = success(fixtureInput(), [
      unsafe,
      fixtureCandidate("safe-content"),
    ]);
    expect(
      safetyResult.diagnostics.rejectedCandidates[unsafe.candidateId],
    ).toBe("gate-09-content-safety");
  });

  it("fails version mismatches before any candidate reaches a hard gate", () => {
    const invalid = fixtureCandidate("bad-version", {
      semanticProfileVersion: "synthetic-semantic-v2",
    });
    const result = recommend(fixtureInput(), [invalid]);
    expect(result).toEqual(
      expect.objectContaining({
        status: "unavailable",
        failure: "semantic-profile-version-mismatch",
      }),
    );
    if (result.status === "success")
      throw new Error("expected version failure");
    expect(result.diagnostics.hardEligibleCandidateCount).toBe(0);
  });

  it("filters exact disliked, session Album, Recording Family and Release Family independently", () => {
    const cases: ReadonlyArray<{
      name: string;
      inputHistory: HistorySnapshot;
      candidate: PrebindingFixtureCandidate;
      reason: string;
    }> = [
      {
        name: "disliked",
        inputHistory: history({
          explicitAlbumStates: { "album:blocked": "disliked" },
        }),
        candidate: fixtureCandidate("blocked"),
        reason: "gate-06-explicitly-disliked",
      },
      {
        name: "album",
        inputHistory: history({ deliveredAlbumIds: ["album:blocked"] }),
        candidate: fixtureCandidate("blocked"),
        reason: "gate-08-session-album-duplicate",
      },
      {
        name: "recording",
        inputHistory: history({
          deliveredRecordingFamilyIds: ["recording:shared"],
        }),
        candidate: fixtureCandidate("blocked", {
          recordingFamilyIds: ["recording:shared"],
        }),
        reason: "gate-08-session-recording-family-duplicate",
      },
      {
        name: "release",
        inputHistory: history({
          deliveredReleaseFamilyIds: ["release:shared"],
        }),
        candidate: fixtureCandidate("blocked", {
          releaseFamilyId: "release:shared",
        }),
        reason: "gate-08-session-release-family-duplicate",
      },
    ];

    for (const testCase of cases) {
      const input = fixtureInput("compass", { history: testCase.inputHistory });
      const result = success(input, [
        testCase.candidate,
        fixtureCandidate(`safe-${testCase.name}`),
      ]);
      expect(
        result.diagnostics.rejectedCandidates[testCase.candidate.candidateId],
      ).toBe(testCase.reason);
    }
  });

  it("returns typed input failures for an incomplete Compass and non-all-day Today", () => {
    const completeMoment = moment("compass");
    const { currentStateId: _omittedState, ...incompleteMoment } =
      completeMoment;
    const compass = fixtureInput("compass", {
      moment: incompleteMoment,
    });
    expect(recommend(compass, [fixtureCandidate("a")])).toEqual(
      expect.objectContaining({
        status: "unavailable",
        failure: "compass-state-missing",
      }),
    );

    const today = fixtureInput("today", {
      envelope: envelope("today", { todayDisplayScope: "day-part" }),
    });
    expect(recommend(today, [fixtureCandidate("a")])).toEqual(
      expect.objectContaining({
        status: "unavailable",
        failure: "today-context-not-all-day",
      }),
    );
  });
});

describe("missing evidence, exposure and diversity", () => {
  it("removes an unknown group from the denominator instead of scoring it as zero", () => {
    const input = fixtureInput("ticket");
    const sparse = fixtureCandidate("sparse");
    const sparseResult = success(input, [sparse]).rankedCandidates[0]!;
    const neutralListening = sparseResult.baseScore;
    const rich = fixtureCandidate("rich", {
      listeningFit: reviewedKnowledge(neutralListening, VERSIONS.listening),
    });
    const richResult = success(input, [rich]).rankedCandidates[0]!;

    expect(
      sparseResult.contributions.some(
        (contribution) => contribution.group === "listening-fit",
      ),
    ).toBe(false);
    expect(
      richResult.contributions.find(
        (contribution) => contribution.group === "listening-fit",
      )?.configuredWeight,
    ).toBe(0.1);
    expect(richResult.baseScore).toBeCloseTo(sparseResult.baseScore, 12);
  });

  it("deterministically downranks a recently exposed Album", () => {
    const alpha = fixtureCandidate("alpha");
    const beta = fixtureCandidate("beta");
    const base = fixtureInput();
    expect(success(base, [beta, alpha]).activeAlbumId).toBe("album:alpha");

    const exposedInput = fixtureInput("compass", {
      history: history({ recentlyExposedAlbumIds: ["album:alpha"] }),
    });
    const exposed = success(exposedInput, [beta, alpha]);
    expect(exposed.activeAlbumId).toBe("album:beta");
    expect(
      exposed.rankedCandidates.find(
        (candidate) => candidate.stillAlbumId === "album:alpha",
      )?.diversityPenalty.recentExposure,
    ).toBe(RECENT_EXPOSURE_PENALTY);
  });

  it("keeps only the highest-ranked Album from each recording and release family", () => {
    const primary = fixtureCandidate("a-primary", {
      recordingFamilyIds: ["recording:shared"],
      releaseFamilyId: "release:shared",
    });
    const sameRecording = fixtureCandidate("b-same-recording", {
      recordingFamilyIds: ["recording:shared"],
      releaseFamilyId: "release:other-b",
    });
    const independent = fixtureCandidate("c-independent");
    const sameRelease = fixtureCandidate("d-same-release", {
      recordingFamilyIds: ["recording:other-d"],
      releaseFamilyId: "release:shared",
    });

    const result = success(fixtureInput(), [
      sameRelease,
      independent,
      sameRecording,
      primary,
    ]);

    expect(
      result.rankedCandidates.map((candidate) => candidate.stillAlbumId),
    ).toEqual(["album:a-primary", "album:c-independent"]);
    expect(
      result.diagnostics.rejectedCandidates[sameRecording.candidateId],
    ).toBe("gate-08-session-recording-family-duplicate");
    expect(result.diagnostics.rejectedCandidates[sameRelease.candidateId]).toBe(
      "gate-08-session-release-family-duplicate",
    );
    expect(result.activeAlbumId).toBe("album:a-primary");
    expect(result.userPayload).toEqual({
      activeAlbumId: "album:a-primary",
      whyInputAtomRefs: ["reason:a-primary"],
    });
  });
});
