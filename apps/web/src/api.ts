import type {
  AlbumDetail,
  AlbumArtworkEvent,
  AlbumArtworkGovernance,
  AlbumArtworkMutationResult,
  AlbumIntroduction,
  AlbumMetadata,
  AlbumMetadataEvent,
  AlbumMetadataMutationResult,
  AlbumSummary,
  AuthSession,
  AuthUser,
  CatalogRecommendationResponse,
  CoceanSettings,
  DeliveryJob,
  DeliveryTarget,
  DeviceCategory,
  DeviceOwnership,
  LibraryStats,
  LibraryChangePlan,
  AlbumVisibilityCommand,
  AlbumVisibilityMutationResult,
  AlbumVisibilityEvent,
  LibraryIdentityDecision,
  LibraryIdentityDecisionCommand,
  LibraryIdentityDecisionResult,
  ArtworkDecisionCommand,
  UpdateAlbumMetadataCommand,
  ModelConfiguration,
  ModelVerificationStatus,
  OwnedDevice,
  PhysicalCopy,
  PhysicalMedium,
  ReleaseCandidate,
  ScanFailure,
  ScanFileResult,
  ScanJob,
  ScanReport,
  StillCatalogStatus,
} from "@cocean/contracts";
import {
  demoAlbumDetail,
  demoAlbums,
  demoScans,
  demoSettings,
  demoStats,
} from "./demo.js";

const apiBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
const forceDemo = import.meta.env.VITE_DEMO_MODE === "true";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const isFormData =
    typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(hasBody && !isFormData ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(
      response.status,
      payload?.error ?? "REQUEST_FAILED",
      payload?.message ?? response.statusText,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SystemCapabilities {
  catalogSources: Record<
    "localFiles" | "musicBrainz" | "coverArtArchive" | "acoustId" | "discogs",
    { enabled: boolean; implemented: boolean; configured?: boolean }
  >;
  providers: {
    appleMusic?: { enabled: boolean; implemented: boolean; mode?: string };
    qobuz: { enabled: boolean; implemented: boolean };
  };
  model: {
    enabled: boolean;
    implemented: boolean;
    configured?: boolean;
    verified?: boolean;
    verificationStatus?: ModelVerificationStatus;
    model?: string;
  };
  stillCatalog?: { installed: boolean };
  recommendations?: {
    catalogCompatibility: { implemented: boolean; ready: boolean };
    stillV010: { implemented: boolean; ready: boolean; reasonCode?: string };
  };
}

export interface CreateDeliveryTargetInput {
  deviceId?: string | null;
  name: string;
  kind: DeliveryTarget["kind"];
  transport: DeliveryTarget["transport"];
  location: string;
  username?: string | null;
  password?: string | null;
  enabled?: boolean;
}

export interface AlbumPage {
  items: AlbumSummary[];
  limit: number;
  offset: number;
  total: number;
}

export interface AlbumPageInput {
  search?: string;
  filter?: "ALL" | "DIGITAL" | PhysicalMedium;
  sort?: "ARTIST" | "TITLE" | "YEAR_DESC";
  issue?: import("@cocean/contracts").LibraryIssueCode | "ALL";
  limit?: number;
  offset?: number;
  visibility?: "VISIBLE" | "HIDDEN" | "ALL";
}

export interface PagedResult<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

export function buildDemoAlbumPage(input: AlbumPageInput = {}): AlbumPage {
  const search = (input.search ?? "").toLowerCase();
  const filtered = demoAlbums.filter(
    (album) =>
      `${album.title} ${album.albumArtist}`.toLowerCase().includes(search) &&
      (input.filter === "DIGITAL"
        ? album.hasDigital
        : input.filter && input.filter !== "ALL"
          ? album.physicalMedia.includes(input.filter)
          : true) &&
      (!input.issue ||
        input.issue === "ALL" ||
        album.issues?.some((issue) => issue.code === input.issue)) &&
      (!input.visibility ||
        input.visibility === "ALL" ||
        (album.visibility ?? "VISIBLE") === input.visibility),
  );
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 96;
  return {
    items: filtered.slice(offset, offset + limit),
    limit,
    offset,
    total: filtered.length,
  };
}

async function withDemo<T>(live: () => Promise<T>, demo: () => T): Promise<T> {
  if (forceDemo) return demo();
  return live();
}

export const api = {
  listenUrl(trackId: string): string {
    return `${apiBase}/api/v1/tracks/${encodeURIComponent(trackId)}/listen?mode=browser`;
  },
  session(): Promise<AuthSession> {
    return request("/api/v1/auth/session");
  },
  login(username: string, password: string): Promise<AuthSession> {
    return request("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },
  logout(): Promise<void> {
    return request("/api/v1/auth/logout", { method: "POST" });
  },
  users(): Promise<AuthUser[]> {
    return request<{ items: AuthUser[] }>("/api/v1/users").then(
      (result) => result.items,
    );
  },
  addUser(input: {
    username: string;
    displayName: string;
    password: string;
    role: AuthUser["role"];
  }): Promise<AuthUser> {
    return request("/api/v1/users", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateUser(
    id: string,
    input: {
      displayName?: string;
      password?: string;
      role?: AuthUser["role"];
      enabled?: boolean;
    },
  ): Promise<AuthUser> {
    return request(`/api/v1/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  albumPage(input: AlbumPageInput = {}): Promise<AlbumPage> {
    const params = new URLSearchParams({
      search: input.search ?? "",
      filter: input.filter ?? "ALL",
      sort: input.sort ?? "ARTIST",
      issue: input.issue ?? "ALL",
      limit: String(input.limit ?? 96),
      offset: String(input.offset ?? 0),
      visibility: input.visibility ?? "VISIBLE",
    });
    return withDemo(
      () => request(`/api/v1/albums?${params.toString()}`),
      () => buildDemoAlbumPage(input),
    );
  },
  album(id: string): Promise<AlbumDetail> {
    return withDemo(
      () => request(`/api/v1/albums/${encodeURIComponent(id)}`),
      () => demoAlbumDetail(id),
    );
  },
  setAlbumVisibility(
    albumId: string,
    command: AlbumVisibilityCommand,
  ): Promise<AlbumVisibilityMutationResult> {
    return request(`/api/v1/albums/${encodeURIComponent(albumId)}/visibility`, {
      method: "PATCH",
      body: JSON.stringify(command),
    });
  },
  albumVisibilityHistory(albumId: string): Promise<AlbumVisibilityEvent[]> {
    return request<{ items: AlbumVisibilityEvent[] }>(
      `/api/v1/albums/${encodeURIComponent(albumId)}/visibility-history`,
    ).then((result) => result.items);
  },
  createQuarantinePlan(
    albumId: string,
    input: {
      requestId: string;
      expectedLibraryRevision: number;
      localVersionId: string;
    },
  ): Promise<LibraryChangePlan> {
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/lifecycle-plans`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  confirmLifecyclePlan(
    planId: string,
    requestId: string,
  ): Promise<LibraryChangePlan> {
    return request(
      `/api/v1/lifecycle-plans/${encodeURIComponent(planId)}/confirm`,
      { method: "POST", body: JSON.stringify({ requestId }) },
    );
  },
  cancelLifecyclePlan(
    planId: string,
    requestId: string,
  ): Promise<LibraryChangePlan> {
    return request(
      `/api/v1/lifecycle-plans/${encodeURIComponent(planId)}/cancel`,
      { method: "POST", body: JSON.stringify({ requestId }) },
    );
  },
  retryLifecyclePlan(
    planId: string,
    requestId: string,
  ): Promise<LibraryChangePlan> {
    return request(
      `/api/v1/lifecycle-plans/${encodeURIComponent(planId)}/retry`,
      { method: "POST", body: JSON.stringify({ requestId }) },
    );
  },
  createRestorePlan(
    sourcePlanId: string,
    requestId: string,
  ): Promise<LibraryChangePlan> {
    return request(
      `/api/v1/lifecycle-plans/${encodeURIComponent(sourcePlanId)}/restore`,
      { method: "POST", body: JSON.stringify({ requestId }) },
    );
  },
  lifecyclePlans(): Promise<LibraryChangePlan[]> {
    return request<{ items: LibraryChangePlan[] }>(
      "/api/v1/lifecycle-plans",
    ).then((result) => result.items);
  },
  quarantinedVersions(): Promise<LibraryChangePlan[]> {
    return request<{ items: LibraryChangePlan[] }>(
      "/api/v1/lifecycle-plans/quarantine",
    ).then((result) => result.items);
  },
  albumArtwork(albumId: string): Promise<AlbumArtworkGovernance> {
    return request(`/api/v1/albums/${encodeURIComponent(albumId)}/artwork`);
  },
  artworkHistory(albumId: string): Promise<AlbumArtworkEvent[]> {
    return withDemo(
      () =>
        request<{ items: AlbumArtworkEvent[] }>(
          `/api/v1/albums/${encodeURIComponent(albumId)}/artwork-history`,
        ).then((result) => result.items),
      () => [],
    );
  },
  selectAlbumArtwork(
    albumId: string,
    command: ArtworkDecisionCommand,
  ): Promise<AlbumArtworkMutationResult> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不保存封面治理决定"),
      );
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/artwork/select`,
      { method: "POST", body: JSON.stringify(command) },
    );
  },
  uploadAlbumArtwork(
    albumId: string,
    file: File,
    input: { requestId: string; expectedArtworkRevision: number },
  ): Promise<AlbumArtworkMutationResult> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不上传封面"),
      );
    const body = new FormData();
    body.append("requestId", input.requestId);
    body.append(
      "expectedArtworkRevision",
      String(input.expectedArtworkRevision),
    );
    body.append("file", file, file.name);
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/artwork/upload`,
      { method: "POST", body },
    );
  },
  importMusicBrainzArtwork(
    albumId: string,
    input: {
      requestId: string;
      expectedArtworkRevision: number;
      localVersionId: string;
    },
  ): Promise<AlbumArtworkMutationResult> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不导入外部封面"),
      );
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/artwork/import/musicbrainz`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  undoArtworkEvent(
    albumId: string,
    eventId: string,
    input: { requestId: string; expectedArtworkRevision: number },
  ): Promise<AlbumArtworkMutationResult> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不撤销封面治理决定"),
      );
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/artwork-history/${encodeURIComponent(eventId)}/undo`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  identityDecisions(albumId: string): Promise<LibraryIdentityDecision[]> {
    return withDemo(
      () =>
        request<{ items: LibraryIdentityDecision[] }>(
          `/api/v1/albums/${encodeURIComponent(albumId)}/identity-decisions`,
        ).then((result) => result.items),
      () => [],
    );
  },
  applyIdentityDecision(
    albumId: string,
    command: LibraryIdentityDecisionCommand,
  ): Promise<LibraryIdentityDecisionResult> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不保存身份治理决定"),
      );
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/identity-decisions`,
      { method: "POST", body: JSON.stringify(command) },
    );
  },
  undoIdentityDecision(
    albumId: string,
    decisionId: string,
    input: { requestId: string; revision: number },
  ): Promise<LibraryIdentityDecisionResult> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不保存身份治理决定"),
      );
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/identity-decisions/${encodeURIComponent(decisionId)}/undo`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  albumMetadata(albumId: string): Promise<AlbumMetadata> {
    return request(`/api/v1/albums/${encodeURIComponent(albumId)}/metadata`);
  },
  metadataHistory(albumId: string): Promise<AlbumMetadataEvent[]> {
    return withDemo(
      () =>
        request<{ items: AlbumMetadataEvent[] }>(
          `/api/v1/albums/${encodeURIComponent(albumId)}/metadata-history`,
        ).then((result) => result.items),
      () => [],
    );
  },
  updateAlbumMetadata(
    albumId: string,
    command: UpdateAlbumMetadataCommand,
  ): Promise<AlbumMetadataMutationResult> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不保存元数据修改"),
      );
    return request(`/api/v1/albums/${encodeURIComponent(albumId)}/metadata`, {
      method: "PATCH",
      body: JSON.stringify(command),
    });
  },
  undoMetadataEvent(
    albumId: string,
    eventId: string,
    input: { requestId: string; expectedMetadataRevision: number },
  ): Promise<AlbumMetadataMutationResult> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不保存元数据修改"),
      );
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/metadata-history/${encodeURIComponent(eventId)}/undo`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  todayRecommendation(dayKey?: string): Promise<CatalogRecommendationResponse> {
    const query = dayKey ? `?dayKey=${encodeURIComponent(dayKey)}` : "";
    return request(`/api/v1/recommendations/today${query}`);
  },
  discoverRecommendations(
    query: string,
    limit = 12,
  ): Promise<CatalogRecommendationResponse> {
    return request("/api/v1/recommendations/discover", {
      method: "POST",
      body: JSON.stringify({ query, limit }),
    });
  },
  addPhysicalAlbum(input: {
    title: string;
    albumArtist: string;
    year: number | null;
    medium: PhysicalMedium;
  }): Promise<AlbumDetail> {
    return request("/api/v1/albums", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  matchCandidates(
    albumId: string,
    localVersionId?: string,
  ): Promise<ReleaseCandidate[]> {
    const query = localVersionId
      ? `?localVersionId=${encodeURIComponent(localVersionId)}`
      : "";
    return withDemo(
      async () =>
        (
          await request<{ items: ReleaseCandidate[] }>(
            `/api/v1/albums/${encodeURIComponent(albumId)}/match-candidates${query}`,
          )
        ).items,
      () => [],
    );
  },
  searchMatchCandidates(
    albumId: string,
    localVersionId?: string,
  ): Promise<ReleaseCandidate[]> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(
          409,
          "DEMO_WRITE_DISABLED",
          "演示模式不查询或保存外部候选",
        ),
      );
    return request<{ items: ReleaseCandidate[] }>(
      `/api/v1/albums/${encodeURIComponent(albumId)}/match-candidates`,
      {
        method: "POST",
        body: JSON.stringify({ limit: 8, localVersionId }),
      },
    ).then((result) => result.items);
  },
  confirmMatchCandidate(
    albumId: string,
    candidateId: string,
    input: {
      requestId: string;
      expectedMetadataRevision: number;
      localVersionId: string;
    },
  ): Promise<{ candidate: ReleaseCandidate; album: AlbumDetail }> {
    if (forceDemo)
      return Promise.reject(
        new ApiError(409, "DEMO_WRITE_DISABLED", "演示模式不确认外部候选"),
      );
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/match-candidates/${encodeURIComponent(candidateId)}/confirm`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },
  addPhysicalCopy(
    albumId: string,
    input: {
      medium: PhysicalMedium;
      label?: string | null;
      catalogNumber?: string | null;
      barcode?: string | null;
      country?: string | null;
      releaseYear?: number | null;
      quantity?: number;
      conditionNote?: string | null;
      storageLocation?: string | null;
    },
  ): Promise<PhysicalCopy> {
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/physical-copies`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },
  removePhysicalCopy(albumId: string, copyId: string): Promise<void> {
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/physical-copies/${encodeURIComponent(copyId)}`,
      { method: "DELETE" },
    );
  },
  devices(): Promise<OwnedDevice[]> {
    return request<{ items: OwnedDevice[] }>("/api/v1/gear/devices").then(
      (result) => result.items,
    );
  },
  addDevice(input: {
    manufacturer: string;
    model: string;
    category: DeviceCategory;
    ownership: DeviceOwnership;
  }): Promise<OwnedDevice> {
    return request("/api/v1/gear/devices", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  stats(): Promise<LibraryStats> {
    return withDemo(
      () => request("/api/v1/library/stats"),
      () => demoStats,
    );
  },
  capabilities(): Promise<SystemCapabilities> {
    return request("/api/v1/capabilities");
  },
  catalogStatus(): Promise<StillCatalogStatus> {
    return request("/api/v1/catalog/status");
  },
  async reloadCatalog(): Promise<StillCatalogStatus> {
    await request("/api/v1/catalog/reload", { method: "POST" });
    return request("/api/v1/catalog/status");
  },
  deliveryTargets(): Promise<DeliveryTarget[]> {
    return request<{ items: DeliveryTarget[] }>(
      "/api/v1/delivery-targets",
    ).then((result) => result.items);
  },
  addDeliveryTarget(input: CreateDeliveryTargetInput): Promise<DeliveryTarget> {
    return request("/api/v1/delivery-targets", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateDeliveryTarget(
    id: string,
    input: CreateDeliveryTargetInput,
  ): Promise<DeliveryTarget> {
    return request(`/api/v1/delivery-targets/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  albumDeliveries(albumId: string): Promise<DeliveryJob[]> {
    return request<{ items: DeliveryJob[] }>(
      `/api/v1/albums/${encodeURIComponent(albumId)}/deliveries`,
    ).then((result) => result.items);
  },
  deliveries(): Promise<DeliveryJob[]> {
    return request<{ items: DeliveryJob[] }>("/api/v1/deliveries").then(
      (result) => result.items,
    );
  },
  deliverAlbum(
    albumId: string,
    targetId: string,
    planId?: string,
  ): Promise<DeliveryJob> {
    return request(`/api/v1/albums/${encodeURIComponent(albumId)}/deliveries`, {
      method: "POST",
      body: JSON.stringify({ targetId, ...(planId ? { planId } : {}) }),
    });
  },
  scans(): Promise<ScanJob[]> {
    return withDemo(
      async () => (await request<{ items: ScanJob[] }>("/api/v1/scans")).items,
      () => demoScans,
    );
  },
  scanReport(scanId: string): Promise<ScanReport> {
    return request(`/api/v1/scans/${encodeURIComponent(scanId)}/report`);
  },
  scanFailures(
    scanId: string,
    limit = 100,
    offset = 0,
  ): Promise<PagedResult<ScanFailure>> {
    return request(
      `/api/v1/scans/${encodeURIComponent(scanId)}/failures?limit=${limit}&offset=${offset}`,
    );
  },
  scanFiles(
    scanId: string,
    limit = 100,
    offset = 0,
  ): Promise<PagedResult<ScanFileResult>> {
    return request(
      `/api/v1/scans/${encodeURIComponent(scanId)}/files?limit=${limit}&offset=${offset}`,
    );
  },
  startScan(
    mode: "INCREMENTAL" | "FULL" = "INCREMENTAL",
    rootId = "music",
  ): Promise<ScanJob> {
    return request("/api/v1/scans", {
      method: "POST",
      body: JSON.stringify({ rootId, mode }),
    });
  },
  cancelScan(scanId: string): Promise<ScanJob> {
    return request(`/api/v1/scans/${encodeURIComponent(scanId)}/cancel`, {
      method: "POST",
    });
  },
  retryScan(scanId: string): Promise<ScanJob> {
    return request(`/api/v1/scans/${encodeURIComponent(scanId)}/retry`, {
      method: "POST",
    });
  },
  modelConfiguration(): Promise<ModelConfiguration> {
    return request("/api/v1/model/configuration");
  },
  saveModelConfiguration(input: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKey?: string;
    clearApiKey?: boolean;
  }): Promise<ModelConfiguration> {
    return request("/api/v1/model/configuration", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  verifyModelConfiguration(): Promise<ModelConfiguration> {
    return request("/api/v1/model/configuration/verify", {
      method: "POST",
    });
  },
  albumIntroduction(albumId: string): Promise<AlbumIntroduction | null> {
    return request<{ introduction: AlbumIntroduction | null }>(
      `/api/v1/albums/${encodeURIComponent(albumId)}/introduction`,
    ).then((result) => result.introduction);
  },
  generateAlbumIntroduction(albumId: string): Promise<AlbumIntroduction> {
    return request(
      `/api/v1/albums/${encodeURIComponent(albumId)}/introduction`,
      { method: "POST" },
    );
  },
  settings(): Promise<CoceanSettings> {
    return withDemo(
      () => request("/api/v1/settings"),
      () => structuredClone(demoSettings),
    );
  },
  saveSettings(settings: CoceanSettings): Promise<CoceanSettings> {
    return request("/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
};
