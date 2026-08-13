import type {
  AuthUser,
  CoceanSettings,
  ModelConfiguration,
  StillCatalogStatus,
} from "@cocean/contracts";
import {
  CheckCircle2,
  HardDrive,
  Monitor,
  Moon,
  Network,
  KeyRound,
  PlugZap,
  RefreshCw,
  Save,
  Sun,
  Usb,
  UserPlus,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.js";
import {
  Button,
  PageHeader,
  SettingRow,
  Toast,
  Toggle,
} from "../components.js";
import { demoSettings } from "../demo.js";
import { useAsync, useToast } from "../hooks.js";
import { applyTheme } from "../theme.js";

const sections = [
  { id: "settings-resources", label: "资源与扫描" },
  { id: "settings-transfer", label: "导入与传输" },
  { id: "settings-policy", label: "保存策略" },
  { id: "settings-catalog", label: "Still 目录" },
  { id: "settings-sources", label: "信息来源" },
  { id: "settings-assist", label: "智能辅助" },
  { id: "settings-accounts", label: "账号管理" },
  { id: "settings-appearance", label: "外观" },
];

interface ReadinessStatus {
  status: string;
  musicRoot: {
    path: string;
    readable: boolean;
    kind: "directory" | "missing" | "other";
    readOnlyPolicy: boolean;
    mountReadOnlyVerified: boolean | null;
  };
}

export function SettingsPage() {
  const loaded = useAsync(() => api.settings(), []);
  const capabilities = useAsync(() => api.capabilities(), []);
  const readiness = useAsync(loadReadiness, []);
  const catalog = useAsync(() => api.catalogStatus(), []);
  const session = useAsync(() => api.session(), []);
  const modelConfiguration = useAsync(() => api.modelConfiguration(), []);
  const users = useAsync(() => api.users(), []);
  const [settings, setSettings] = useState<CoceanSettings>(demoSettings);
  const [reloadingCatalog, setReloadingCatalog] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [verifyingModel, setVerifyingModel] = useState(false);
  const [modelDraft, setModelDraft] = useState({
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "",
    apiKey: "",
  });
  const [userDraft, setUserDraft] = useState<{
    username: string;
    displayName: string;
    password: string;
    role: AuthUser["role"];
  }>({ username: "", displayName: "", password: "", role: "MEMBER" });
  const [addingUser, setAddingUser] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (loaded.data) {
      setSettings(loaded.data);
      applyTheme(loaded.data.theme);
    }
  }, [loaded.data]);
  useEffect(() => {
    if (!modelConfiguration.data) return;
    setModelDraft({
      enabled: modelConfiguration.data.enabled,
      baseUrl: modelConfiguration.data.baseUrl,
      model: modelConfiguration.data.model,
      apiKey: "",
    });
  }, [modelConfiguration.data]);
  const update = <K extends keyof CoceanSettings>(
    key: K,
    value: CoceanSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));
  const updateRoot = (
    rootId: string,
    patch: Partial<CoceanSettings["libraryRoots"][number]>,
  ) =>
    setSettings((current) => ({
      ...current,
      libraryRoots: current.libraryRoots.map((item) =>
        item.id === rootId ? { ...item, ...patch } : item,
      ),
    }));
  const modelImplemented = capabilities.data?.model.implemented === true;
  const modelStatus = modelConfiguration.loading
    ? "正在读取连接"
    : modelConfiguration.error
      ? "模型状态不可用"
      : modelConfiguration.data?.verificationStatus === "VERIFIED"
        ? modelConfiguration.data.enabled
          ? "已验证并启用"
          : "已验证 · 未启用"
        : modelConfiguration.data?.verificationStatus === "FAILED"
          ? "验证失败"
          : modelConfiguration.data?.model &&
              modelConfiguration.data.apiKeyConfigured
            ? "等待验证"
            : modelImplemented
              ? "等待配置"
              : "尚未接入";
  const isAdmin = session.data?.user.role === "ADMIN";
  const root = readiness.data?.musicRoot ?? null;
  const rootStatus = readiness.loading
    ? "正在检查"
    : readiness.error
      ? "检查失败"
      : root?.readable && root.kind === "directory"
        ? "目录可读"
        : "等待挂载";
  const save = async () => {
    const effectiveSettings = {
      ...(modelImplemented
        ? settings
        : {
            ...settings,
            naturalLanguageDiscoveryEnabled: false,
            evidenceSummaryEnabled: false,
          }),
      scanOnStart: false,
      deviceCopyMetadataEnabled: false,
    };
    try {
      const result = await api.saveSettings(effectiveSettings);
      setSettings(result);
      applyTheme(result.theme);
      toast.show("设置已保存");
    } catch (error) {
      toast.show(
        error instanceof Error
          ? `设置保存失败：${error.message}`
          : "设置保存失败；更改未生效",
      );
    }
  };
  const reloadCatalog = async () => {
    setReloadingCatalog(true);
    try {
      await api.reloadCatalog();
      await catalog.reload();
      toast.show("Still 目录已重新加载");
    } catch (error) {
      toast.show(
        error instanceof Error ? error.message : "Still 目录重新加载失败",
      );
    } finally {
      setReloadingCatalog(false);
    }
  };
  const saveModel = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingModel(true);
    try {
      const saved = await api.saveModelConfiguration({
        enabled: modelDraft.enabled,
        baseUrl: modelDraft.baseUrl,
        model: modelDraft.model,
        ...(modelDraft.apiKey ? { apiKey: modelDraft.apiKey } : {}),
      });
      setModelDraft((value) => ({ ...value, apiKey: "" }));
      let verificationError: string | null = null;
      if (saved.enabled && saved.apiKeyConfigured && saved.model) {
        setVerifyingModel(true);
        try {
          await api.verifyModelConfiguration();
        } catch (error) {
          verificationError =
            error instanceof Error ? error.message : "连接验证失败";
        } finally {
          setVerifyingModel(false);
        }
      }
      await Promise.all([modelConfiguration.reload(), capabilities.reload()]);
      toast.show(
        verificationError
          ? `配置已保存；验证失败：${verificationError}`
          : saved.enabled
            ? "模型配置已保存并通过连接验证"
            : "模型配置已保存；启用前可先验证连接",
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "模型配置保存失败");
    } finally {
      setSavingModel(false);
    }
  };
  const verifyModel = async () => {
    setVerifyingModel(true);
    try {
      await api.verifyModelConfiguration();
      await Promise.all([modelConfiguration.reload(), capabilities.reload()]);
      toast.show("模型连接验证通过");
    } catch (error) {
      await Promise.all([modelConfiguration.reload(), capabilities.reload()]);
      toast.show(
        error instanceof Error
          ? `模型验证失败：${error.message}`
          : "模型验证失败",
      );
    } finally {
      setVerifyingModel(false);
    }
  };
  const addUser = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.addUser(userDraft);
      setUserDraft({
        username: "",
        displayName: "",
        password: "",
        role: "MEMBER",
      });
      setAddingUser(false);
      await users.reload();
      toast.show("账号已创建");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "账号创建失败");
    }
  };
  const toggleUser = async (user: AuthUser) => {
    try {
      await api.updateUser(user.id, { enabled: !user.enabled });
      await users.reload();
      toast.show(user.enabled ? "账号已停用" : "账号已启用");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "账号状态更新失败");
    }
  };
  return (
    <div className="page settings-page">
      <PageHeader
        title="设置"
        subtitle="先把来源、权限与保存边界配置清楚，再让系统扫描"
        action={<span className="status-pill">NAS 首次部署</span>}
      />
      {loaded.error ? (
        <div className="boundary-note">
          <strong>设置 API 暂不可用</strong>
          <span>当前显示安全默认值，保存不会伪装为成功。</span>
        </div>
      ) : null}
      <div className="settings-layout">
        <aside
          className="settings-sections surface-card"
          aria-label="设置页面导航"
        >
          <small>设置项目</small>
          {sections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              <span />
              {section.label}
            </a>
          ))}
          <div className="boundary-note">
            <strong>部署提示</strong>
            <span>
              NAS 主机路径在 FNOS Compose 中填写；容器内路径保持固定。
            </span>
          </div>
        </aside>
        <div className="settings-content">
          <section
            id="settings-resources"
            className="surface-card music-root-card"
          >
            <div className="section-heading-inline">
              <div>
                <h2>音乐目录</h2>
                <p>
                  NAS 主机路径由 FNOS Compose
                  配置；此处只检查容器内的实际挂载，不在浏览器修改路径。
                </p>
              </div>
              <span className="status-pill">{rootStatus}</span>
            </div>
            <div className="mount-row">
              <HardDrive />
              <div aria-live="polite">
                <small>容器实际路径 · Compose 以 :ro 挂载</small>
                <strong>
                  {root?.path ??
                    settings.libraryRoots[0]?.containerPath ??
                    "/library/music"}
                </strong>
                <small>
                  {readiness.error
                    ? "无法连接 Readiness；请检查 Server 容器"
                    : `${root?.readable ? "可读取" : "不可读取"} · ${root ? rootKindLabel(root.kind) : "状态读取中"} · ${root?.readOnlyPolicy ? "只读策略已配置；运行态由部署验收确认" : "只读策略未配置"}`}
                </small>
              </div>
              <Button
                variant="secondary"
                disabled={readiness.loading}
                onClick={() => void readiness.reload()}
              >
                {readiness.loading ? "检查中" : "重新检查"}
              </Button>
            </div>
            <div className="scan-facts">
              <span>文件标签</span>
              <span>内嵌封面</span>
              <span>cover / folder / front</span>
              <span>音频规格</span>
              <small>本地确定性读取，不使用模型</small>
            </div>
            {settings.libraryRoots.map((libraryRoot) => (
              <div className="settings-root-automation" key={libraryRoot.id}>
                <SettingRow
                  title={`${libraryRoot.name} 自动发现`}
                  help="按计划只读增量扫描；新目录需经过至少 60 秒的两次一致观察后才会入库"
                  control={
                    <Toggle
                      checked={libraryRoot.autoDiscoveryEnabled}
                      disabled={!isAdmin}
                      onChange={(checked) =>
                        updateRoot(libraryRoot.id, {
                          autoDiscoveryEnabled: checked,
                        })
                      }
                    />
                  }
                />
                <SettingRow
                  title="扫描间隔"
                  help="每个音乐根目录独立配置，允许 1–1440 分钟；默认 5 分钟"
                  control={
                    <label className="settings-number-control">
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        step={1}
                        value={libraryRoot.autoDiscoveryIntervalMinutes}
                        disabled={!isAdmin}
                        onChange={(event) =>
                          updateRoot(libraryRoot.id, {
                            autoDiscoveryIntervalMinutes: Number(
                              event.target.value,
                            ),
                          })
                        }
                      />
                      <span>分钟</span>
                    </label>
                  }
                />
              </div>
            ))}
          </section>
          <div className="settings-two-col">
            <section id="settings-transfer" className="surface-card">
              <h2>导入与传输</h2>
              <SettingRow
                title="外接 U 盘"
                help="FNOS 挂载后映射到 /delivery/usb；只向明确选择的目标目录复制"
                control={
                  <span className="status-pill">
                    <Usb /> FNOS 配置
                  </span>
                }
              />
              <SettingRow
                title="网络传输"
                help="在“我的系统”中保存目标地址；当前不代表网络可达"
                control={
                  <span className="status-pill">
                    <Network /> 目标配置
                  </span>
                }
              />
            </section>
            <section id="settings-policy" className="surface-card">
              <h2>保存策略</h2>
              <SettingRow
                title="只保存到 COCEAN"
                help="V1 固定策略，源音乐文件保持不变"
                control={<Toggle checked disabled />}
              />
              <SettingRow
                title="写回音乐主库"
                help="V1 不开放；未来也必须逐项预览并备份"
                control={<Toggle checked={false} disabled />}
              />
              <SettingRow
                title="投送副本"
                help="FTP / U 盘投送会逐文件复制并校验；不回写音乐主库标签"
                control={<span className="status-pill">已开放</span>}
              />
            </section>
          </div>
          <section id="settings-catalog" className="surface-card catalog-card">
            <div className="section-heading-inline">
              <div>
                <h2>Still 精品目录</h2>
                <p>
                  版本化目录由 FNOS Compose
                  挂载；重新加载不会用演示数据替代缺失或无效文件。
                </p>
              </div>
              <span className="status-pill">
                {catalogStatusLabel(
                  catalog.data,
                  catalog.loading,
                  catalog.error,
                )}
              </span>
            </div>
            {catalog.error ? (
              <div className="boundary-note">
                <strong>目录状态 API 暂不可用</strong>
                <span>{catalog.error.message}</span>
              </div>
            ) : (
              <>
                <div className="catalog-status-grid">
                  <CatalogFact
                    label="内容版本"
                    value={catalog.data?.activeContentVersion ?? "未加载"}
                  />
                  <CatalogFact
                    label="记录数"
                    value={(catalog.data?.recordCount ?? 0).toLocaleString()}
                  />
                  <CatalogFact
                    label="来源 Schema"
                    value={
                      [
                        catalog.data?.sourceSchemaId,
                        catalog.data?.sourceSchemaVersion,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"
                    }
                  />
                  <CatalogFact
                    label="安装时间"
                    value={formatDateTime(catalog.data?.installedAt)}
                  />
                  <CatalogFact
                    label="Runtime checksum"
                    value={catalog.data?.runtimeChecksum ?? "—"}
                    code
                  />
                </div>
                {catalog.data?.lastLoadError ? (
                  <div className="catalog-error">
                    <strong>上次加载失败</strong>
                    <span>{catalog.data.lastLoadError}</span>
                  </div>
                ) : null}
                {catalog.data && !catalog.data.fileAvailable ? (
                  <div className="boundary-note">
                    <strong>未发现 Still 目录文件</strong>
                    <span>
                      请通过 FNOS Compose 将目录文件挂载到{" "}
                      {catalog.data.configuredPath}；当前不会使用模板数据代替。
                    </span>
                  </div>
                ) : null}
              </>
            )}
            <footer className="catalog-actions">
              <div>
                <small>配置路径</small>
                <code>{catalog.data?.configuredPath ?? "状态读取中"}</code>
              </div>
              <Button
                variant="secondary"
                disabled={reloadingCatalog || catalog.loading}
                onClick={() => void reloadCatalog()}
              >
                <RefreshCw />
                {reloadingCatalog ? "加载中" : "重新加载"}
              </Button>
            </footer>
          </section>
          <div className="settings-two-col grow">
            <section
              id="settings-sources"
              className="surface-card providers-card"
            >
              <div className="section-heading-inline">
                <h2>信息来源优先级</h2>
                <small>只显示真实实现状态</small>
              </div>
              <Provider
                index={1}
                title="本地标签与封面"
                detail="始终读取 · 不使用模型"
                status="已启用"
                on
              />
              <Provider
                index={2}
                title="MusicBrainz"
                detail="用户触发的发行版候选"
                status={
                  capabilities.data?.catalogSources.musicBrainz.configured
                    ? "已配置"
                    : capabilities.data?.catalogSources.musicBrainz.enabled
                      ? "缺少联系信息"
                      : "部署环境关闭"
                }
                on={Boolean(
                  capabilities.data?.catalogSources.musicBrainz.configured,
                )}
              />
              <Provider
                index={3}
                title="Apple Music"
                detail="Still 目录链接的封面与 30 秒试听"
                status={
                  capabilities.data?.providers.appleMusic?.enabled
                    ? "已启用"
                    : "部署环境关闭"
                }
                on={Boolean(capabilities.data?.providers.appleMusic?.enabled)}
              />
              <Provider
                index={4}
                title="Cover Art Archive / AcoustID"
                detail="精确发行封面与录音指纹"
                status="下一阶段"
              />
              <Provider
                index={5}
                title="Qobuz"
                detail="需官方合作接口；不使用 Cookie 绕行"
                status="未接入"
              />
            </section>
            <section id="settings-assist" className="surface-card">
              <div className="section-heading-inline">
                <h2>智能辅助与外部服务</h2>
                <span>{modelStatus}</span>
              </div>
              <SettingRow
                title="找歌语义理解"
                help="当前仍由版本化 Still 标签确定性检索；模型语义扩展下一阶段接入"
                control={<Toggle checked={false} disabled />}
              />
              <SettingRow
                title="专辑介绍"
                help="在详情页按需生成；只使用本地标题、艺术家、年份、厂牌与曲目事实"
                control={
                  <Toggle
                    checked={Boolean(capabilities.data?.model.configured)}
                    disabled
                  />
                }
              />
              <SettingRow
                title="自动写回 / 自动定版"
                help="模型不能执行，固定关闭"
                control={<Toggle checked={false} disabled />}
              />
              <div className="qobuz-adapter">
                <div>
                  <PlugZap />
                  <strong>Qobuz 正式集成边界</strong>
                </div>
                <span className="status-pill">当前版本硬关闭</span>
                <p>
                  当前不接受账号 Cookie。未来取得正式合作 API
                  后，才开放搜索、试听或完整播放；适配器与核心扫描隔离。
                </p>
              </div>
              {isAdmin ? (
                <div className="model-connections">
                  <div className="model-connections-heading">
                    <strong>已保存的模型</strong>
                    <small>当前版本支持一个主要 OpenAI-compatible 连接</small>
                  </div>
                  {modelConfiguration.data?.model ||
                  modelConfiguration.data?.apiKeyConfigured ? (
                    <div className="model-connection-card">
                      <span
                        className={`model-breath-dot ${modelConnectionTone(modelConfiguration.data)}`}
                        aria-hidden="true"
                      />
                      <div className="model-connection-copy">
                        <small>OPENAI-COMPATIBLE</small>
                        <strong>
                          {modelConfiguration.data.model || "未填写模型名称"}
                        </strong>
                        <span>{modelConfiguration.data.baseUrl}</span>
                      </div>
                      <div className="model-connection-state">
                        <span className="status-pill">
                          {modelVerificationLabel(modelConfiguration.data)}
                        </span>
                        <small>
                          {modelConfiguration.data.apiKeyConfigured
                            ? "API Key 已加密保存"
                            : "等待 API Key"}
                        </small>
                        {modelConfiguration.data.lastCheckedAt ? (
                          <small>
                            最近验证 ·{" "}
                            {formatModelCheckTime(
                              modelConfiguration.data.lastCheckedAt,
                            )}
                          </small>
                        ) : null}
                        {modelConfiguration.data.verificationMessage ? (
                          <small>
                            {modelConfiguration.data.verificationMessage}
                          </small>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={
                          savingModel ||
                          verifyingModel ||
                          !modelConfiguration.data.model ||
                          !modelConfiguration.data.apiKeyConfigured
                        }
                        onClick={() => void verifyModel()}
                      >
                        <CheckCircle2 />
                        {verifyingModel ? "正在验证" : "验证连接"}
                      </Button>
                    </div>
                  ) : (
                    <div className="model-connection-empty">
                      <span
                        className="model-breath-dot is-idle"
                        aria-hidden="true"
                      />
                      <div>
                        <strong>尚未添加模型连接</strong>
                        <small>
                          填写下方连接后，可在专辑详情按需生成介绍。
                        </small>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
              {isAdmin ? (
                <form className="model-config-form" onSubmit={saveModel}>
                  <div className="section-heading-inline">
                    <div>
                      <strong>
                        <KeyRound /> OpenAI-compatible 模型
                      </strong>
                      <small>API Key 加密保存在 NAS，页面永不回显</small>
                    </div>
                    <Toggle
                      checked={modelDraft.enabled}
                      onChange={(enabled) =>
                        setModelDraft((value) => ({ ...value, enabled }))
                      }
                    />
                  </div>
                  <label>
                    <span>Base URL</span>
                    <input
                      type="url"
                      value={modelDraft.baseUrl}
                      onChange={(event) =>
                        setModelDraft((value) => ({
                          ...value,
                          baseUrl: event.target.value,
                        }))
                      }
                      required
                    />
                  </label>
                  <label>
                    <span>模型名称</span>
                    <input
                      value={modelDraft.model}
                      onChange={(event) =>
                        setModelDraft((value) => ({
                          ...value,
                          model: event.target.value,
                        }))
                      }
                      placeholder="gpt-5-mini"
                      required={modelDraft.enabled}
                    />
                  </label>
                  <label>
                    <span>API Key</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={modelDraft.apiKey}
                      onChange={(event) =>
                        setModelDraft((value) => ({
                          ...value,
                          apiKey: event.target.value,
                        }))
                      }
                      placeholder={
                        modelConfiguration.data?.apiKeyConfigured
                          ? "已配置；留空保持不变"
                          : "输入 API Key"
                      }
                    />
                  </label>
                  <Button
                    type="submit"
                    disabled={savingModel || verifyingModel}
                  >
                    {savingModel
                      ? verifyingModel
                        ? "保存并验证中"
                        : "保存中"
                      : "保存模型配置"}
                  </Button>
                </form>
              ) : (
                <small className="settings-admin-note">
                  只有管理员可修改模型连接。
                </small>
              )}
            </section>
          </div>
          <section
            id="settings-accounts"
            className="surface-card accounts-card"
          >
            <div className="section-heading-inline">
              <div>
                <h2>账号管理</h2>
                <p>每个人使用独立账号；浏览器可保存密码，不共享管理员凭据。</p>
              </div>
              {isAdmin ? (
                <Button
                  variant="secondary"
                  onClick={() => setAddingUser((value) => !value)}
                >
                  <UserPlus /> {addingUser ? "取消" : "添加账号"}
                </Button>
              ) : null}
            </div>
            {addingUser ? (
              <form className="account-form" onSubmit={addUser}>
                <label>
                  <span>登录账号</span>
                  <input
                    autoComplete="off"
                    value={userDraft.username}
                    onChange={(event) =>
                      setUserDraft((value) => ({
                        ...value,
                        username: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  <span>显示名称</span>
                  <input
                    value={userDraft.displayName}
                    onChange={(event) =>
                      setUserDraft((value) => ({
                        ...value,
                        displayName: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  <span>初始密码（至少 10 位）</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    value={userDraft.password}
                    onChange={(event) =>
                      setUserDraft((value) => ({
                        ...value,
                        password: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  <span>角色</span>
                  <select
                    value={userDraft.role}
                    onChange={(event) =>
                      setUserDraft((value) => ({
                        ...value,
                        role: event.target.value as AuthUser["role"],
                      }))
                    }
                  >
                    <option value="MEMBER">成员</option>
                    <option value="ADMIN">管理员</option>
                  </select>
                </label>
                <Button type="submit">创建账号</Button>
              </form>
            ) : null}
            {users.data?.length ? (
              <div className="account-list">
                {users.data.map((user) => (
                  <div className="account-row" key={user.id}>
                    <div>
                      <strong>{user.displayName}</strong>
                      <small>
                        @{user.username} ·{" "}
                        {user.role === "ADMIN" ? "管理员" : "成员"}
                      </small>
                    </div>
                    <span className="status-pill">
                      {user.enabled ? "可登录" : "已停用"}
                    </span>
                    {user.id !== session.data?.user.id ? (
                      <Button
                        variant="quiet"
                        onClick={() => void toggleUser(user)}
                      >
                        {user.enabled ? "停用" : "启用"}
                      </Button>
                    ) : (
                      <small>当前账号</small>
                    )}
                  </div>
                ))}
              </div>
            ) : users.error && !isAdmin ? (
              <small className="settings-admin-note">
                只有管理员可查看与添加账号。
              </small>
            ) : null}
          </section>
          <section
            id="settings-appearance"
            className="surface-card appearance-card"
          >
            <div className="section-heading-inline">
              <div>
                <h2>外观</h2>
                <p>
                  沿用 Still v0.10 的系统白、暖黑和中性色；保存成功后立即切换。
                </p>
              </div>
              <span>{themeLabel(settings.theme)}</span>
            </div>
            <div
              className="theme-options"
              role="radiogroup"
              aria-label="外观主题"
            >
              <ThemeOption
                label="System"
                detail="跟随设备"
                icon={<Monitor />}
                selected={settings.theme === "SYSTEM"}
                onClick={() => update("theme", "SYSTEM")}
              />
              <ThemeOption
                label="Light"
                detail="系统白"
                icon={<Sun />}
                selected={settings.theme === "LIGHT"}
                onClick={() => update("theme", "LIGHT")}
              />
              <ThemeOption
                label="Dark"
                detail="Still 暖黑"
                icon={<Moon />}
                selected={settings.theme === "DARK"}
                onClick={() => update("theme", "DARK")}
              />
            </div>
          </section>
          <footer className="settings-footer">
            <span>外观保存后立即生效；未实现能力保持固定关闭</span>
            <div>
              <Button
                variant="secondary"
                onClick={() => setSettings(structuredClone(demoSettings))}
              >
                恢复默认
              </Button>
              <Button onClick={save}>
                <Save /> 保存设置
              </Button>
            </div>
          </footer>
        </div>
      </div>
      <Toast message={toast.message} />
    </div>
  );
}

function Provider({
  index,
  title,
  detail,
  status,
  on,
}: {
  index: number;
  title: string;
  detail: string;
  status: string;
  on?: boolean;
}) {
  return (
    <div className="provider-row">
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <small>
          {detail} · {status}
        </small>
      </div>
      {on ? <CheckCircle2 /> : <span className="provider-off" />}
    </div>
  );
}
function modelConnectionTone(configuration: ModelConfiguration) {
  if (configuration.verificationStatus === "VERIFIED") return "is-ready";
  if (configuration.verificationStatus === "FAILED") return "is-failed";
  return "is-idle";
}
function modelVerificationLabel(configuration: ModelConfiguration) {
  if (configuration.verificationStatus === "VERIFIED")
    return configuration.enabled ? "已验证 · 已启用" : "已验证 · 未启用";
  if (configuration.verificationStatus === "FAILED") return "验证失败";
  return "等待验证";
}
function formatModelCheckTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function CatalogFact({
  label,
  value,
  code,
}: {
  label: string;
  value: string;
  code?: boolean;
}) {
  return (
    <div className={`catalog-fact${code ? " is-code" : ""}`}>
      <small>{label}</small>
      {code ? <code title={value}>{value}</code> : <strong>{value}</strong>}
    </div>
  );
}
function ThemeOption({
  label,
  detail,
  icon,
  selected,
  onClick,
}: {
  label: string;
  detail: string;
  icon: ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`theme-option${selected ? " is-active" : ""}`}
      role="radio"
      aria-checked={selected}
      onClick={onClick}
    >
      <span>{icon}</span>
      <strong>{label}</strong>
      <small>{detail}</small>
    </button>
  );
}
function catalogStatusLabel(
  status: StillCatalogStatus | null,
  loading: boolean,
  error: Error | null,
) {
  if (loading) return "读取中";
  if (error) return "状态不可用";
  if (status?.lastLoadError) return "加载失败";
  if (status?.activeContentVersion) return "已加载";
  return status?.fileAvailable ? "等待加载" : "等待目录";
}
function formatDateTime(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
}
function themeLabel(theme: CoceanSettings["theme"]) {
  return ({ SYSTEM: "System", LIGHT: "Light", DARK: "Dark" } as const)[theme];
}
function rootKindLabel(kind: ReadinessStatus["musicRoot"]["kind"]) {
  return (
    { directory: "目录", missing: "路径不存在", other: "不是目录" } as const
  )[kind];
}

async function loadReadiness(): Promise<ReadinessStatus> {
  const apiBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
  const response = await fetch(`${apiBase}/api/v1/readiness`, {
    headers: { accept: "application/json" },
  });
  const payload = (await response
    .json()
    .catch(() => null)) as ReadinessStatus | null;
  if (!payload?.musicRoot || (!response.ok && response.status !== 503))
    throw new Error("无法读取 NAS 音乐目录状态");
  return payload;
}
