import type {
  RecommendationCriterion,
  StillCatalogAlbum,
} from "@cocean/contracts";
import {
  ALGORITHM_VERSION as STILL_V010_ALGORITHM_VERSION,
  stableUnitInterval,
} from "@cocean/recommendation-core";

export const CATALOG_COMPATIBILITY_ALGORITHM_VERSION =
  "cocean-verified-catalog-rotation-v1" as const;

export interface CatalogRecommendationRequest {
  readonly kind: "TODAY" | "DISCOVER";
  readonly catalog: readonly StillCatalogAlbum[];
  readonly contentVersion: string;
  readonly dayKey: string;
  readonly query?: string;
  readonly limit?: number;
}

export interface SelectedCatalogAlbum {
  readonly album: StillCatalogAlbum;
  readonly matchedCriteria: readonly RecommendationCriterion[];
}

export interface CatalogRecommendationSelection {
  readonly sourceContentVersion: string;
  readonly algorithmVersion: typeof CATALOG_COMPATIBILITY_ALGORITHM_VERSION;
  readonly stillV010AlgorithmVersion: typeof STILL_V010_ALGORITHM_VERSION;
  readonly modelCallCount: 0;
  readonly query: {
    readonly raw: string;
    readonly supportedCriteria: readonly RecommendationCriterion[];
    readonly unsupportedTerms: readonly string[];
  };
  readonly items: readonly SelectedCatalogAlbum[];
}

interface LexiconEntry extends RecommendationCriterion {
  readonly patterns: readonly RegExp[];
}

const LEXICON: readonly LexiconEntry[] = [
  criterion("domain.classical", "古典", "DOMAIN", "classical", [
    /古典/i,
    /classical/i,
  ]),
  criterion("domain.jazz", "爵士", "DOMAIN", "jazz", [/爵士/i, /jazz/i]),
  criterion("domain.pop", "流行", "DOMAIN", "pop", [/流行/i, /\bpop\b/i]),
  criterion("domain.ambient", "氛围", "DOMAIN", "ambient", [
    /氛围/i,
    /ambient/i,
  ]),
  criterion("domain.electronic", "电子", "DOMAIN", "electronic", [
    /电子/i,
    /electronic/i,
  ]),
  criterion("domain.soundtrack", "原声", "DOMAIN", "soundtrack", [
    /原声|电影配乐/i,
    /soundtrack/i,
  ]),
  criterion("domain.world", "世界音乐", "DOMAIN", "world", [
    /世界音乐/i,
    /world music/i,
  ]),
  criterion("feature.soft", "柔和动态", "FEATURE", "musical.dynamics:soft", [
    /安静|轻柔|柔和|舒缓/i,
    /\bsoft\b|calm/i,
  ]),
  criterion("feature.warm", "温暖音色", "FEATURE", "musical.timbre:warm", [
    /温暖|不冷/i,
    /\bwarm\b/i,
  ]),
  criterion("feature.dark", "暗色音色", "FEATURE", "musical.timbre:dark", [
    /深夜|午夜|暗色|昏暗/i,
    /late[ -]?night|\bdark\b/i,
  ]),
  criterion("feature.airy", "通透音色", "FEATURE", "musical.timbre:airy", [
    /通透|空气感|轻盈/i,
    /\bairy\b/i,
  ]),
  criterion("feature.clear", "清晰音色", "FEATURE", "musical.timbre:clear", [
    /清晰|干净/i,
    /\bclear\b/i,
  ]),
  criterion(
    "feature.acoustic",
    "原声音色",
    "FEATURE",
    "musical.timbre:acoustic",
    [/原声乐器|木质|不插电/i, /acoustic/i],
  ),
  criterion(
    "feature.electronic",
    "电子音色",
    "FEATURE",
    "musical.timbre:electronic",
    [/合成器|电子音色/i, /synth/i],
  ),
  criterion("feature.sparse", "稀疏编排", "FEATURE", "musical.density:sparse", [
    /留白|稀疏|极简/i,
    /sparse|minimal/i,
  ]),
  criterion(
    "feature.spacious",
    "宽松空间",
    "FEATURE",
    "musical.density:spacious",
    [/空间感|宽松|开阔/i, /spacious/i],
  ),
  criterion("feature.steady", "稳定律动", "FEATURE", "musical.rhythm:steady", [
    /稳定|平稳|专注/i,
    /steady|focus/i,
  ]),
  criterion(
    "feature.pulse-free",
    "无脉冲感",
    "FEATURE",
    "musical.rhythm:pulse-free",
    [/无节拍|自由节奏/i, /pulse[ -]?free/i],
  ),
  criterion(
    "feature.lyrical",
    "抒情旋律",
    "FEATURE",
    "musical.melody:lyrical",
    [/抒情|歌唱性/i, /lyrical/i],
  ),
  criterion(
    "feature.continuous",
    "连续结构",
    "FEATURE",
    "musical.form:continuous",
    [/连续|沉浸/i, /continuous|immersive/i],
  ),
  criterion(
    "feature.album-arc",
    "完整专辑弧线",
    "FEATURE",
    "musical.form:album-arc",
    [/完整专辑|专辑感|从头听/i, /album arc/i],
  ),
];

const UNSUPPORTED: readonly {
  readonly label: string;
  readonly patterns: readonly RegExp[];
}[] = [
  {
    label: "年代",
    patterns: [
      /\b(?:19|20)?\d0\s*(?:s\b|年代)/i,
      /[八九零一二三四五六七]十年代/,
    ],
  },
  {
    label: "演唱者性别",
    patterns: [/女声|男声|女性歌手|男性歌手/i, /female|male vocal/i],
  },
  { label: "人声属性", patterns: [/人声|纯音乐|器乐/i, /vocal|instrumental/i] },
  {
    label: "语言",
    patterns: [
      /中文|粤语|日语|英语|法语|德语/i,
      /chinese|japanese|english|french|german/i,
    ],
  },
  {
    label: "Hi-Res/DSD 规格",
    patterns: [/hi[ -]?res|dsd|\b\d{2,3}\s*k(?:hz)?\b/i],
  },
];

export function selectCatalogRecommendations(
  request: CatalogRecommendationRequest,
): CatalogRecommendationSelection {
  const raw = request.query?.trim() ?? "";
  const supportedCriteria =
    request.kind === "DISCOVER" ? extractCriteria(raw) : [];
  const unsupportedTerms =
    request.kind === "DISCOVER" ? extractUnsupported(raw) : [];
  const limit = Math.min(
    Math.max(request.limit ?? (request.kind === "TODAY" ? 1 : 12), 1),
    50,
  );
  const normalizedQuery = normalize(raw);
  const ranked = request.catalog
    .filter((album) => album.contentVersion === request.contentVersion)
    .map((album) => {
      const matchedCriteria = supportedCriteria.filter((item) =>
        item.kind === "DOMAIN"
          ? album.domains.some(
              (domain) => normalize(domain) === normalize(item.catalogValue),
            )
          : item.kind === "FEATURE"
            ? album.features.includes(item.catalogValue)
            : false,
      );
      const identityMatch =
        normalizedQuery.length >= 2 &&
        normalize(`${album.title} ${album.artist}`).includes(normalizedQuery);
      const score = matchedCriteria.length + (identityMatch ? 2 : 0);
      const rotation = stableUnitInterval(
        `${request.contentVersion}\u0000${request.dayKey}\u0000${album.id}`,
      );
      return { album, matchedCriteria, score, rotation };
    })
    .filter(
      (entry) =>
        request.kind === "TODAY" ||
        (supportedCriteria.length === 0 && normalizedQuery.length === 0) ||
        entry.score > 0,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.rotation - left.rotation ||
        left.album.id.localeCompare(right.album.id),
    )
    .slice(0, limit)
    .map(({ album, matchedCriteria }) => ({ album, matchedCriteria }));

  return {
    sourceContentVersion: request.contentVersion,
    algorithmVersion: CATALOG_COMPATIBILITY_ALGORITHM_VERSION,
    stillV010AlgorithmVersion: STILL_V010_ALGORITHM_VERSION,
    modelCallCount: 0,
    query: { raw, supportedCriteria, unsupportedTerms },
    items: ranked,
  };
}

function extractCriteria(value: string): RecommendationCriterion[] {
  return LEXICON.filter((entry) =>
    entry.patterns.some((pattern) => pattern.test(value)),
  ).map(({ patterns: _patterns, ...criterionValue }) => criterionValue);
}

function extractUnsupported(value: string): string[] {
  return UNSUPPORTED.filter((entry) =>
    entry.patterns.some((pattern) => pattern.test(value)),
  ).map((entry) => entry.label);
}

function criterion(
  id: string,
  label: string,
  kind: "DOMAIN" | "FEATURE",
  catalogValue: string,
  patterns: readonly RegExp[],
): LexiconEntry {
  return { id, label, kind, catalogValue, patterns };
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}
