export type ExecutionMode = "accepted-runtime" | "prebinding-fixture";

export type SourcePath = "today" | "ticket" | "compass";

export type Storefront = "cn" | "us";

export type RequestOperation =
  "initial-or-replay" | "adjustment" | "replacement";

export type MusicDomain =
  | "classical"
  | "jazz"
  | "pop"
  | "soundtrack"
  | "ambient"
  | "electronic"
  | "world";

export type SemanticDimension =
  | "energy"
  | "warmth"
  | "brightness"
  | "tension"
  | "density"
  | "complexity"
  | "focusSupport"
  | "motion"
  | "vocalPresence"
  | "lyricDensity"
  | "foregroundness"
  | "familiarity"
  | "albumCohesion";

export type AffinityDimension =
  | "domain"
  | "genre"
  | "artist"
  | "composer"
  | "instrument"
  | "ensemble"
  | "era"
  | "label";

export type AlbumExplicitState =
  "favorite" | "listen-later" | "listened" | "disliked";

export type MomentTermBucket =
  "state" | "activity" | "direction" | "context" | "constraint";

export type ContentSafety =
  | "safe"
  | "blocking-conflict"
  | "stale-selected-revision"
  | "prohibited-status";

export type FeatureGroup =
  | "moment-fit"
  | "semantic-fit"
  | "explicit-profile-fit"
  | "listening-fit"
  | "novelty";

export interface RecommendationInputEnvelope {
  readonly requestId: string;
  readonly sourcePath: SourcePath;
  readonly structuredMomentRef: string;
  readonly todayContextSnapshotRef?: string;
  readonly todayDisplayScope?: "all-day" | "day-part";
  readonly explicitPreferenceVersion: string;
  readonly profileSnapshotVersion: string;
  readonly historySnapshotVersion: string;
  readonly catalogContentVersion: string;
  readonly semanticProfileVersion: string;
  readonly momentFitVersion: string;
  readonly listeningStructureVersion: string;
  readonly featureContractVersion: string;
  readonly rankerPolicyVersion: string;
  readonly dayKey: string;
  readonly storefront: Storefront;
  readonly executionMode: ExecutionMode;
}

export interface StructuredMoment {
  readonly sourceMode: SourcePath;
  readonly currentStateId?: string;
  readonly activityId?: string;
  readonly desiredDirectionId?: string;
  readonly contextId?: string;
  readonly targetVector: Readonly<Partial<Record<SemanticDimension, number>>>;
  readonly positiveConstraints: readonly string[];
  readonly negativeConstraints: readonly string[];
  readonly exploration: number;
  readonly vocabularyVersion: string;
  readonly preferenceVersion: string;
  readonly profileVersion: string;
}

export interface ExplicitPreferenceProfile {
  readonly preferenceVersion: string;
  /** Zero to two equal-weight musical starting points. */
  readonly preferredDomains: readonly MusicDomain[];
}

export interface InferredAffinity {
  readonly dimension: AffinityDimension;
  readonly valueId: string;
  /** Signed affinity in [-1, 1]. */
  readonly score: number;
  readonly confidence: number;
}

export interface LocalProfileSnapshot {
  readonly profileVersion: string;
  readonly affinities: readonly InferredAffinity[];
  readonly legacyInferencePaused: boolean;
}

export interface HistorySnapshot {
  readonly historyVersion: string;
  readonly explicitAlbumStates: Readonly<Record<string, AlbumExplicitState>>;
  readonly deliveredAlbumIds: readonly string[];
  readonly deliveredRecordingFamilyIds: readonly string[];
  readonly deliveredReleaseFamilyIds: readonly string[];
  readonly recentlyExposedAlbumIds: readonly string[];
  readonly recentComposerIds: readonly string[];
  readonly recentPrimaryArtistIds: readonly string[];
  readonly recentEnsembleIds: readonly string[];
  readonly recentLabelIds: readonly string[];
  readonly recentEraIds: readonly string[];
  readonly recentDomains: readonly string[];
  readonly replacementCount: number;
  readonly todaySuccessfulAdjustmentCount: number;
}

export interface KnowledgeValue {
  /** `null` is a real unknown. The engine never substitutes a midpoint. */
  readonly value: number | null;
  readonly reliability: number;
  readonly selectedVersion: string;
  readonly reviewRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface SemanticKnowledgeValue extends KnowledgeValue {
  readonly calibrationAnchorId: string | null;
}

export interface MomentFitTerm {
  readonly vocabularyId: string;
  readonly bucket: MomentTermBucket;
  readonly polarity: "positive" | "negative";
  readonly strength: "hard" | "soft" | "unknown";
  readonly confidence: number | null;
  readonly reliability: number;
  readonly version: string;
  readonly reviewRef: string;
  readonly evidenceRefs: readonly string[];
}

export interface CandidateIdentityAndFeatures {
  /** Adapter-local stable identity, used only after Still Album identity in tie-breaking. */
  readonly candidateId: string;
  readonly stillAlbumId: string;
  readonly albumEditionId: string;
  readonly recordingFamilyIds: readonly string[];
  readonly releaseFamilyId: string;
  readonly workIds: readonly string[];
  readonly primaryArtistId: string;
  readonly composerIds: readonly string[];
  readonly ensembleIds: readonly string[];
  readonly labelId: string;
  readonly eraId: string;
  readonly domain: string;
  readonly genreIds: readonly string[];
  readonly instrumentIds: readonly string[];
  readonly supportedConstraints: readonly string[];
  readonly conflictingConstraints: readonly string[];
  readonly semanticProfileVersion: string;
  readonly momentFitVersion: string;
  readonly listeningStructureVersion: string;
  readonly semanticValues: Readonly<
    Partial<Record<SemanticDimension, SemanticKnowledgeValue>>
  >;
  readonly momentFitTerms: readonly MomentFitTerm[];
  readonly listeningFit: KnowledgeValue;
  readonly discoveryNovelty: KnowledgeValue;
  readonly reasonAtomRefs: readonly string[];
  readonly contentSafety: ContentSafety;
}

export interface PrebindingFixtureCandidate extends CandidateIdentityAndFeatures {
  readonly executionMode: "prebinding-fixture";
  readonly catalogContentVersion: string;
  readonly fixturePackVersion: string;
  readonly fixturePackContentHash: string;
  readonly sourcePackRef: string;
  readonly sourcePackHash: string;
  readonly fixtureReviewRefs: readonly string[];
  readonly fixtureApproval: "algorithm-test-only" | "invalid";
  readonly sourceDisposition: "pilot-ready-for-binding" | "repair" | "returned";
  readonly fixtureIdentityStatus:
    "resolved-for-test" | "conflicted" | "missing";
  readonly fixtureAvailability: "eligible" | "ineligible";
  readonly bindingState: "unresolved" | "invalid";
}

export interface AcceptedRuntimeCandidate extends CandidateIdentityAndFeatures {
  readonly executionMode: "accepted-runtime";
  readonly catalogContentVersion: string;
  readonly acceptedSnapshotVersion: string;
  readonly catalogStatus: "accepted" | "candidate" | "rejected";
  readonly editionStatus: "accepted" | "stale" | "rejected";
  readonly identityStatus: "consistent" | "conflicted" | "missing";
  readonly selectedRevisionsValid: boolean;
  readonly binding: {
    readonly storefront: Storefront;
    readonly matchType: "exact" | "fuzzy" | "missing";
    readonly bindingStatus: "verified" | "pending" | "rejected";
    readonly availabilityStatus: "available" | "unavailable" | "unknown";
    readonly revisionId: string;
  };
}

export type RecommendationCandidate =
  PrebindingFixtureCandidate | AcceptedRuntimeCandidate;

interface RecommendationInputBase {
  readonly envelope: RecommendationInputEnvelope;
  readonly moment: StructuredMoment;
  readonly explicitPreference: ExplicitPreferenceProfile;
  readonly profile: LocalProfileSnapshot;
  readonly history: HistorySnapshot;
  readonly operation: RequestOperation;
}

export interface PrebindingFixtureInput extends RecommendationInputBase {
  readonly executionMode: "prebinding-fixture";
  readonly fixturePackVersion: string;
  readonly fixturePackContentHash: string;
  readonly sourcePackRef: string;
  readonly sourcePackHash: string;
}

export interface AcceptedRuntimeInput extends RecommendationInputBase {
  readonly executionMode: "accepted-runtime";
  readonly acceptedSnapshotVersion: string;
}

export type RecommendationInput = PrebindingFixtureInput | AcceptedRuntimeInput;

export type RejectionReason =
  | "gate-01-mode-isolation"
  | "gate-02-publication-qualification"
  | "gate-03-identity-consistency"
  | "gate-04-storefront-availability"
  | "gate-05-explicit-constraint"
  | "gate-06-explicitly-disliked"
  | "gate-07-path-primary-evidence"
  | "gate-08-session-album-duplicate"
  | "gate-08-session-recording-family-duplicate"
  | "gate-08-session-release-family-duplicate"
  | "gate-09-content-safety";

export type ExecutionFailure =
  | "mixed-execution-modes"
  | "mode-envelope-mismatch"
  | "source-path-mismatch"
  | "feature-contract-version-mismatch"
  | "ranker-policy-version-mismatch"
  | "explicit-preference-version-mismatch"
  | "profile-snapshot-version-mismatch"
  | "history-snapshot-version-mismatch"
  | "moment-preference-version-mismatch"
  | "moment-profile-version-mismatch"
  | "moment-vocabulary-version-mismatch"
  | "semantic-profile-version-mismatch"
  | "listening-structure-version-mismatch"
  | "explicit-preference-limit-exceeded"
  | "catalog-content-version-mismatch"
  | "fixture-pack-version-mismatch"
  | "fixture-pack-hash-mismatch"
  | "source-pack-ref-mismatch"
  | "source-pack-hash-mismatch"
  | "accepted-snapshot-version-mismatch"
  | "selected-feature-version-missing"
  | "fixture-review-ref-missing"
  | "listening-fit-version-mismatch"
  | "listening-fit-review-evidence-missing"
  | "discovery-novelty-version-mismatch"
  | "discovery-novelty-review-evidence-missing"
  | "duplicate-candidate-id"
  | "invalid-input-value"
  | "today-context-missing"
  | "today-context-not-all-day"
  | "compass-state-missing"
  | "compass-activity-missing"
  | "replacement-limit-reached"
  | "today-adjustment-limit-reached"
  | "no-eligible-candidate";

export interface FeatureContribution {
  readonly group: FeatureGroup;
  readonly configuredWeight: number;
  readonly match: number;
  readonly reliability: number;
  readonly weightedContribution: number;
}

export interface DiversityPenaltyTrace {
  readonly recentExposure: number;
  readonly concentration: number;
  readonly total: number;
  readonly repeatedDimensions: readonly AffinityDimension[];
}

export interface RankedCandidate {
  readonly candidateId: string;
  readonly stillAlbumId: string;
  readonly baseScore: number;
  readonly diversityPenalty: DiversityPenaltyTrace;
  readonly finalScore: number;
  readonly contributions: readonly FeatureContribution[];
}

export interface VersionTrace {
  readonly algorithmVersion: string;
  readonly featureContractVersion: string;
  readonly rankerPolicyVersion: string;
  readonly catalogContentVersion: string;
  readonly semanticProfileVersion: string;
  readonly momentFitVersion: string;
  readonly listeningStructureVersion: string;
  readonly vocabularyVersion: string;
  readonly explicitPreferenceVersion: string;
  readonly profileSnapshotVersion: string;
  readonly historySnapshotVersion: string;
  readonly executionMode: ExecutionMode;
}

export interface RecommendationDiagnostics {
  readonly generatedCandidateCount: number;
  readonly hardEligibleCandidateCount: number;
  readonly rankedCandidateCount: number;
  readonly rejectedCandidates: Readonly<Record<string, RejectionReason>>;
  readonly rejectionCountsByReason: Readonly<
    Partial<Record<RejectionReason, number>>
  >;
  readonly modelCallCount: 0;
}

export interface RecommendationRankResult {
  readonly inputCanonicalHash: string;
  readonly rankTraceHash: string;
  readonly activeAlbumId: string;
  readonly baseCandidateIds: readonly string[];
  readonly rankedCandidates: readonly RankedCandidate[];
  readonly versions: VersionTrace;
  readonly diagnostics: RecommendationDiagnostics;
  readonly modelCallCount: 0;
  readonly userPayload: {
    readonly activeAlbumId: string;
    readonly whyInputAtomRefs: readonly string[];
  };
}

export interface RecommendationFailureResult {
  readonly status: "unavailable";
  readonly failure: ExecutionFailure;
  readonly inputCanonicalHash: string;
  readonly versions: VersionTrace;
  readonly diagnostics: RecommendationDiagnostics;
  readonly modelCallCount: 0;
}

export type RecommendationExecutionResult =
  | { readonly status: "success"; readonly result: RecommendationRankResult }
  | RecommendationFailureResult;
