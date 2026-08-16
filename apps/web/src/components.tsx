import type { AlbumSummary, AuthUser, PhysicalMedium } from "@cocean/contracts";
import { formatFullAudioSpec } from "@cocean/contracts";
import {
  AudioLines,
  Disc3,
  FolderSearch2,
  Library,
  ListTodo,
  LogOut,
  Search,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import type { MouseEvent, PropsWithChildren, ReactNode } from "react";
import { NavLink } from "react-router-dom";

const navigation = [
  { to: "/library", label: "唱片库", icon: Library },
  { to: "/tasks", label: "任务", icon: ListTodo },
  { to: "/systems", label: "我的系统", icon: AudioLines },
];

export function PageShell({
  children,
  user,
  onLogout,
}: PropsWithChildren<{ user: AuthUser; onLogout: () => void }>) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="应用侧栏">
        <BrandLockup />
        <nav className="sidebar-nav" aria-label="桌面主导航">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `nav-item${isActive ? " is-active" : ""}`
              }
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-account">
          <div>
            <small>{user.role === "ADMIN" ? "管理员" : "成员"}</small>
            <strong>{user.displayName}</strong>
          </div>
          <button type="button" aria-label="退出登录" onClick={onLogout}>
            <LogOut />
          </button>
        </div>
        <nav className="sidebar-footer-nav" aria-label="桌面设置导航">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `nav-item settings-link${isActive ? " is-active" : ""}`
            }
          >
            <Settings aria-hidden="true" />
            <span>设置</span>
          </NavLink>
        </nav>
        <div className="nas-status">
          <span>COCEAN NAS</span>
          <strong>Music · 安全策略</strong>
        </div>
      </aside>
      <main className="main-content">{children}</main>
      <nav className="mobile-nav" aria-label="移动主导航">
        {navigation.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => (isActive ? "is-active" : "")}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
        <NavLink
          to="/settings"
          className={({ isActive }) => (isActive ? "is-active" : "")}
        >
          <Settings aria-hidden="true" />
          <span>设置</span>
        </NavLink>
      </nav>
    </div>
  );
}

export function BrandLockup() {
  return (
    <NavLink to="/library" className="brand-lockup" aria-label="COCEAN 唱片库">
      <span className="brand-mark" aria-hidden="true">
        C
      </span>
      <strong>COCEAN</strong>
    </NavLink>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet";
}) {
  return (
    <button className={`button ${variant}`} {...props}>
      {children}
    </button>
  );
}

export function MediaTag({ medium }: { medium: PhysicalMedium }) {
  const label: Record<PhysicalMedium, string> = {
    CD: "CD",
    SACD: "SACD",
    VINYL: "黑胶",
    CASSETTE: "磁带",
    BLURAY_AUDIO: "Blu-ray Audio",
    OTHER: "其他",
  };
  return <span className="media-tag">{label[medium]}</span>;
}

export function AudioSpecBadge({
  label,
  full,
}: {
  label: string | null;
  full?: string | null;
}) {
  if (!label) return null;
  return (
    <span className="audio-badge" title={full ?? undefined}>
      {libraryAudioBadgeLabel(label)}
    </span>
  );
}

export function libraryAudioBadgeLabel(label: string): string {
  return /^\d+(?:\.\d+)?\/\d/.test(label) ? `PCM ${label}` : label;
}

export function AlbumArtwork({
  album,
  size = "card",
}: {
  album: Pick<AlbumSummary, "id" | "title" | "artwork">;
  size?: "card" | "hero" | "small";
}) {
  const style = album.artwork.url
    ? { backgroundImage: `url(${album.artwork.url})` }
    : undefined;
  return (
    <div
      className={`album-artwork artwork-${size}${album.artwork.url ? " has-artwork" : " is-placeholder"}`}
      style={style}
    >
      {!album.artwork.url ? (
        <span>
          <small>无封面</small>
          {album.title}
        </span>
      ) : null}
    </div>
  );
}

export function AlbumCard({
  album,
  to,
  onOpen,
  onAuxOpen,
  onContextOpen,
}: {
  album: AlbumSummary;
  to?: string;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onAuxOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onContextOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const full = album.audioSummary
    ? formatFullAudioSpec(album.audioSummary)
    : null;
  return (
    <NavLink
      to={to ?? `/albums/${album.id}`}
      className="album-card"
      onClick={onOpen}
      onAuxClick={onAuxOpen}
      onContextMenu={onContextOpen}
    >
      <div className="album-card-art">
        <AlbumArtwork album={album} />
        <AudioSpecBadge
          label={album.mixedAudioSpecs ? "混合规格" : album.audioBadge}
          full={full}
        />
      </div>
      <h3>{album.title}</h3>
      <p>
        {album.albumArtist}
        {album.year ? ` · ${album.year}` : ""}
      </p>
      <div className="tag-row">
        {album.physicalMedia.map((medium) => (
          <MediaTag key={medium} medium={medium} />
        ))}
        {(album.versionCount ?? 1) > 1 ? (
          <span className="media-tag">{album.versionCount} 个本地版本</span>
        ) : null}
        {album.issues?.[0] ? (
          <span className="issue-tag">
            {libraryIssueLabel(album.issues[0].code)}
          </span>
        ) : album.matchStatus === "TRACKS_INCOMPLETE" ? (
          <span className="issue-tag">曲目不完整</span>
        ) : null}
      </div>
    </NavLink>
  );
}

export function libraryIssueLabel(
  code: NonNullable<AlbumSummary["issues"]>[number]["code"],
): string {
  return {
    IDENTITY_OVERLAP: "待确认分组",
    INCOMPLETE_TRACKS: "曲目不完整",
    MISSING_ARTWORK: "缺少封面",
    LOW_RES_ARTWORK: "低清封面",
    MIXED_AUDIO_SPECS: "混合规格",
    BROKEN_TEXT: "字段异常",
    MISSING_IDENTITY: "身份缺失",
  }[code];
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <FolderSearch2 aria-hidden="true" />
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </section>
  );
}

export function LoadingGrid() {
  return (
    <div className="album-grid" aria-label="正在加载">
      {Array.from({ length: 8 }, (_, i) => (
        <div className="album-skeleton" key={i} />
      ))}
    </div>
  );
}

export function SectionTitle({
  title,
  meta,
}: {
  title: string;
  meta?: string;
}) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}

export function SearchField(
  props: React.InputHTMLAttributes<HTMLInputElement>,
) {
  return (
    <label className="search-field">
      <Search aria-hidden="true" />
      <input {...props} />
    </label>
  );
}

export function FilterPill({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      className={`filter-pill${active ? " is-active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle${checked ? " is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
    >
      <span />
    </button>
  );
}

export function SettingRow({
  title,
  help,
  control,
}: {
  title: string;
  help: string;
  control: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <span>{help}</span>
      </div>
      {control}
    </div>
  );
}

export function Toast({ message }: { message: string | null }) {
  return message ? (
    <div className="toast" role="status">
      {message}
    </div>
  ) : null;
}

export function IconLabel({ children }: PropsWithChildren) {
  return (
    <span className="icon-label">
      <SlidersHorizontal aria-hidden="true" />
      {children}
    </span>
  );
}
