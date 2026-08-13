import type { FeatureGroup, SourcePath } from "./types.js";

export const FEATURE_CONTRACT_VERSION = "1.0.0" as const;

export const RANKER_POLICY_VERSION = "v010-gb0-baseline-1" as const;

export const ALGORITHM_VERSION = "cocean-still-v010-gb0-baseline-1" as const;

export const RECENT_EXPOSURE_PENALTY = 0.05 as const;

export const MAX_CONCENTRATION_PENALTY = 0.025 as const;

export const CONCENTRATION_PENALTY_PER_DIMENSION = 0.005 as const;

export type RankerWeights = Readonly<Partial<Record<FeatureGroup, number>>>;

const BASELINE_WEIGHTS = {
  today: {
    "explicit-profile-fit": 0.35,
    "semantic-fit": 0.25,
    "listening-fit": 0.15,
    novelty: 0.25,
  },
  ticket: {
    "moment-fit": 0.4,
    "semantic-fit": 0.25,
    "explicit-profile-fit": 0.1,
    "listening-fit": 0.1,
    novelty: 0.15,
  },
  compass: {
    "moment-fit": 0.5,
    "semantic-fit": 0.25,
    "explicit-profile-fit": 0.15,
    "listening-fit": 0.1,
  },
} as const satisfies Readonly<Record<SourcePath, RankerWeights>>;

export function baselineWeights(sourcePath: SourcePath): RankerWeights {
  return BASELINE_WEIGHTS[sourcePath];
}
