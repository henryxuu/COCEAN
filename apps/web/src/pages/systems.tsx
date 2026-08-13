import type {
  DeliveryTarget,
  DeviceCategory,
  DeviceOwnership,
  OwnedDevice,
} from "@cocean/contracts";
import {
  Cable,
  HardDrive,
  Headphones,
  Network,
  Pencil,
  Usb,
} from "lucide-react";
import { useState } from "react";
import { api } from "../api.js";
import {
  Button,
  EmptyState,
  PageHeader,
  SectionTitle,
  Toast,
} from "../components.js";
import { useAsync, useToast } from "../hooks.js";

type TargetMode = "USB_MOUNT" | "AK_FILE_DROP";

export function SystemsPage({ canManage }: { canManage: boolean }) {
  const devices = useAsync(() => api.devices(), []);
  const targets = useAsync(() => api.deliveryTargets(), []);
  const [adding, setAdding] = useState(false);
  const [addingTarget, setAddingTarget] = useState(false);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);
  const [manufacturer, setManufacturer] = useState("Astell&Kern");
  const [model, setModel] = useState("SP3000M");
  const [category, setCategory] = useState<DeviceCategory>("DAP");
  const [ownership, setOwnership] = useState<DeviceOwnership>("OWNED");
  const [targetMode, setTargetMode] = useState<TargetMode>("AK_FILE_DROP");
  const [targetName, setTargetName] = useState("SP3000M · AK File Drop");
  const [targetLocation, setTargetLocation] = useState("ftp://192.168.0.2/");
  const [targetUsername, setTargetUsername] = useState("");
  const [targetPassword, setTargetPassword] = useState("");
  const [targetDeviceId, setTargetDeviceId] = useState("");
  const toast = useToast();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.addDevice({ manufacturer, model, category, ownership });
      await devices.reload();
      setAdding(false);
      toast.show("设备已记录；没有生成任何播放次数");
    } catch {
      toast.show("设备记录保存失败");
    }
  };

  const changeTargetMode = (next: TargetMode) => {
    setTargetMode(next);
    setTargetLocation(
      next === "USB_MOUNT" ? "/delivery/usb" : "ftp://192.168.0.2/",
    );
    setTargetName(
      next === "USB_MOUNT" ? "外接 U 盘" : "SP3000M · AK File Drop",
    );
  };

  const submitTarget = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingTarget(true);
    try {
      const input = {
        deviceId: targetDeviceId || null,
        name: targetName,
        kind: targetMode === "USB_MOUNT" ? "MOUNTED_VOLUME" : "NETWORK",
        transport: targetMode === "USB_MOUNT" ? "USB_MOUNT" : "AK_FILE_DROP",
        location: targetLocation,
        username: targetMode === "AK_FILE_DROP" ? targetUsername : null,
        password: targetMode === "AK_FILE_DROP" ? targetPassword : null,
        enabled: true,
      } as const;
      if (editingTargetId) {
        await api.updateDeliveryTarget(editingTargetId, input);
      } else {
        await api.addDeliveryTarget(input);
      }
      await targets.reload();
      setAddingTarget(false);
      setEditingTargetId(null);
      setTargetPassword("");
      toast.show(
        editingTargetId
          ? "投送目标已更新；尚未执行任何传输"
          : "投送目标配置已保存；尚未执行任何传输",
      );
    } catch (error) {
      toast.show(
        error instanceof Error ? error.message : "投送目标配置保存失败",
      );
    } finally {
      setSavingTarget(false);
    }
  };

  const openNewTarget = () => {
    setEditingTargetId(null);
    setTargetMode("AK_FILE_DROP");
    setTargetName("SP3000M · AK File Drop");
    setTargetLocation("ftp://192.168.0.2/");
    setTargetUsername("");
    setTargetPassword("");
    setTargetDeviceId("");
    setAddingTarget(true);
  };

  const openTargetEditor = (target: DeliveryTarget) => {
    const mode =
      target.transport === "USB_MOUNT" ? "USB_MOUNT" : "AK_FILE_DROP";
    setEditingTargetId(target.id);
    setTargetMode(mode);
    setTargetName(target.name);
    setTargetLocation(target.location);
    setTargetUsername(target.username ?? "");
    setTargetPassword("");
    setTargetDeviceId(target.deviceId ?? "");
    setAddingTarget(true);
  };

  const editingTarget = (targets.data ?? []).find(
    (target) => target.id === editingTargetId,
  );

  return (
    <div className="page systems-page">
      <PageHeader
        title="我的系统"
        subtitle="记录持有设备，并配置可供后续任务使用的投送目标"
        action={
          canManage ? (
            <Button
              variant="secondary"
              onClick={() => setAdding((value) => !value)}
            >
              {adding ? "收起" : "添加设备"}
            </Button>
          ) : (
            <span className="status-pill">成员只读</span>
          )
        }
      />
      {adding ? (
        <form className="device-form surface-card" onSubmit={submit}>
          <label>
            <span>品牌</span>
            <input
              value={manufacturer}
              onChange={(event) => setManufacturer(event.target.value)}
              required
            />
          </label>
          <label>
            <span>型号</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
            />
          </label>
          <label>
            <span>类型</span>
            <select
              value={category}
              onChange={(event) =>
                setCategory(event.target.value as DeviceCategory)
              }
            >
              <option value="DAP">DAP</option>
              <option value="DAC">DAC</option>
              <option value="AMPLIFIER">放大器</option>
              <option value="HEADPHONE">耳机</option>
              <option value="SPEAKER">音箱</option>
              <option value="STREAMER">串流设备</option>
              <option value="OTHER">其他</option>
            </select>
          </label>
          <label>
            <span>持有状态</span>
            <select
              value={ownership}
              onChange={(event) =>
                setOwnership(event.target.value as DeviceOwnership)
              }
            >
              <option value="OWNED">持有</option>
              <option value="BORROWED">借用</option>
              <option value="WISHLIST">想要</option>
              <option value="SOLD">已出</option>
            </select>
          </label>
          <Button type="submit">保存设备</Button>
        </form>
      ) : null}

      {devices.error ? (
        <EmptyState
          title="设备 API 暂不可用"
          detail="设备持有状态不会用模板数据冒充。"
        />
      ) : devices.loading ? (
        <div className="detail-skeleton" />
      ) : devices.data?.length ? (
        <div className="device-list">
          {devices.data.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))}
        </div>
      ) : (
        <section className="systems-feature surface-card">
          <div className="device-glyph">AK</div>
          <div>
            <p className="eyebrow">目标设备模板 · 尚未记录</p>
            <h2>Astell&Kern SP3000M</h2>
            <p>
              可以把它记为“持有、借用、想要或已出”；能力参数要等官方来源核验后再显示。
            </p>
            <div className="capability-row">
              <span>无播放次数推断</span>
              <span>能力未核验</span>
              <span>投送未配置</span>
            </div>
          </div>
          <Button onClick={() => setAdding(true)}>记录设备</Button>
        </section>
      )}

      <section className="surface-card delivery-targets-section">
        <div className="section-heading-inline">
          <div>
            <h2>投送目标</h2>
            <p>
              SP3000M 使用 AK File Drop 提供的 FTP
              地址；保存后可从专辑详情发起真实投送。
            </p>
          </div>
          {canManage ? (
            <Button
              variant="secondary"
              onClick={() => {
                if (addingTarget) {
                  setAddingTarget(false);
                  setEditingTargetId(null);
                } else {
                  openNewTarget();
                }
              }}
            >
              {addingTarget ? "取消" : "添加目标"}
            </Button>
          ) : null}
        </div>
        {addingTarget ? (
          <form className="target-form" onSubmit={submitTarget}>
            <label>
              <span>目标类型</span>
              <select
                value={targetMode}
                onChange={(event) =>
                  changeTargetMode(event.target.value as TargetMode)
                }
              >
                <option value="USB_MOUNT">USB_MOUNT</option>
                <option value="AK_FILE_DROP">AK File Drop · FTP</option>
              </select>
            </label>
            <label>
              <span>名称</span>
              <input
                value={targetName}
                onChange={(event) => setTargetName(event.target.value)}
                required
                maxLength={160}
              />
            </label>
            <label className="target-location">
              <span>
                {targetMode === "USB_MOUNT"
                  ? "容器挂载目录"
                  : "播放器显示的 FTP 地址"}
              </span>
              <input
                value={targetLocation}
                onChange={(event) => setTargetLocation(event.target.value)}
                placeholder={
                  targetMode === "USB_MOUNT"
                    ? "/delivery/usb"
                    : "ftp://192.168.0.2/"
                }
                required
                maxLength={500}
              />
            </label>
            {targetMode === "AK_FILE_DROP" ? (
              <>
                <label>
                  <span>FTP 账号</span>
                  <input
                    value={targetUsername}
                    onChange={(event) => setTargetUsername(event.target.value)}
                    autoComplete="username"
                    required
                    maxLength={128}
                  />
                </label>
                <label>
                  <span>FTP 密码</span>
                  <input
                    value={targetPassword}
                    onChange={(event) => setTargetPassword(event.target.value)}
                    type="password"
                    autoComplete="new-password"
                    required={!editingTarget?.credentialConfigured}
                    placeholder={
                      editingTarget?.credentialConfigured
                        ? "留空则保留现有加密密码"
                        : "输入播放器显示的密码"
                    }
                    maxLength={256}
                  />
                </label>
              </>
            ) : null}
            <label>
              <span>关联设备</span>
              <select
                value={targetDeviceId}
                onChange={(event) => setTargetDeviceId(event.target.value)}
              >
                <option value="">暂不关联</option>
                {(devices.data ?? []).map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.manufacturer} {device.model}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={savingTarget}>
              {savingTarget
                ? "保存中"
                : editingTargetId
                  ? "保存修改"
                  : "保存目标"}
            </Button>
            <small className="target-form-note">
              地址、账号与密码请照抄 SP3000M 的 AK File Drop 页面。密码经 NAS
              本地密钥加密保存，页面不会回显。
            </small>
          </form>
        ) : null}
        {targets.error ? (
          <div className="boundary-note">
            <strong>投送目标 API 暂不可用</strong>
            <span>没有使用模板目标代替真实配置。</span>
          </div>
        ) : targets.loading ? (
          <div className="target-list-loading">正在读取目标配置…</div>
        ) : targets.data?.length ? (
          <div className="target-list">
            {targets.data.map((target) => (
              <TargetCard
                key={target.id}
                target={target}
                device={
                  devices.data?.find(
                    (device) => device.id === target.deviceId,
                  ) ?? null
                }
                canManage={canManage}
                onEdit={() => openTargetEditor(target)}
              />
            ))}
          </div>
        ) : (
          <div className="target-empty">
            <strong>尚未配置投送目标</strong>
            <span>
              可添加 SP3000M 的 AK File Drop（FTP），或由 FNOS 挂载的 U 盘目录。
            </span>
          </div>
        )}
        <div className="boundary-note">
          <strong>传输从专辑详情发起</strong>
          <span>
            打开任意本地数字专辑，选择目标并点击“投送专辑”；完成后记录目标、时间、文件数与校验状态。
          </span>
        </div>
      </section>

      <div className="systems-grid">
        <section className="surface-card">
          <SectionTitle title="目标类型说明" />
          <SystemRow
            icon={<Usb />}
            title="USB_MOUNT"
            detail="由 FNOS 先挂载，再把明确目录授予 Worker"
          />
          <SystemRow
            icon={<Network />}
            title="AK File Drop · FTP"
            detail="SP3000M 官方文件投送方式；使用播放器当次显示的地址和凭据"
          />
        </section>
        <section className="surface-card">
          <SectionTitle title="常用系统" />
          <SystemRow
            icon={<HardDrive />}
            title="NAS → 播放设备"
            detail="连接关系由用户定义，不自动等同于已投送"
          />
          <SystemRow
            icon={<Headphones />}
            title="播放器 → 耳机"
            detail="记录链路，不根据价格或规格评价声音"
          />
        </section>
        <section className="surface-card">
          <SectionTitle title="可信事件" />
          <SystemRow
            icon={<Cable />}
            title="已投送 Album"
            detail="只有复制完成并校验后才生成"
          />
          <p className="boundary-note">
            没有可靠播放器回执时，不显示“听了 N 次”。
          </p>
        </section>
      </div>
      <Toast message={toast.message} />
    </div>
  );
}

function DeviceCard({ device }: { device: OwnedDevice }) {
  const capabilities = device.capabilities.verifiedAt
    ? [
        device.capabilities.maxPcmBitDepth &&
        device.capabilities.maxPcmSampleRate
          ? `PCM ${device.capabilities.maxPcmBitDepth}/${device.capabilities.maxPcmSampleRate / 1000}`
          : null,
        device.capabilities.maxDsdRate,
        ...device.capabilities.supportedFormats,
      ].filter(Boolean)
    : ["能力未核验"];
  return (
    <section className="systems-feature surface-card">
      <div className="device-glyph">
        {device.manufacturer.slice(0, 2).toUpperCase()}
      </div>
      <div>
        <p className="eyebrow">
          {categoryLabel(device.category)} · {ownershipLabel(device.ownership)}
        </p>
        <h2>
          {device.manufacturer} {device.model}
        </h2>
        <p>{device.nickname ?? "设备能力与持有状态分开记录。"}</p>
        <div className="capability-row">
          {capabilities.map((capability) => (
            <span key={String(capability)}>{capability}</span>
          ))}
        </div>
      </div>
      <span className="status-pill">{ownershipLabel(device.ownership)}</span>
    </section>
  );
}

function TargetCard({
  target,
  device,
  canManage,
  onEdit,
}: {
  target: DeliveryTarget;
  device: OwnedDevice | null;
  canManage: boolean;
  onEdit: () => void;
}) {
  const isAkFileDrop =
    target.transport === "AK_FILE_DROP" ||
    target.transport === "FTP" ||
    target.location.toLocaleLowerCase("en-US").startsWith("ftp://");
  const type =
    target.transport === "USB_MOUNT"
      ? "USB_MOUNT"
      : isAkFileDrop
        ? "AK FILE DROP · FTP"
        : `NETWORK · ${target.transport}`;
  const deviceLabel = device
    ? `${device.manufacturer} ${device.model}`
    : target.deviceId
      ? "关联设备暂不可读"
      : "未关联设备";
  return (
    <article className="target-card">
      <div className="target-card-copy">
        <span className="target-kind">{type}</span>
        <strong>{target.name}</strong>
        <code>{target.location}</code>
        <small>
          {deviceLabel} · {target.username ? `账号 ${target.username} · ` : ""}
          {isAkFileDrop && !target.credentialConfigured
            ? "待填写 FTP 凭据 · "
            : target.credentialConfigured
              ? "凭据已加密 · "
              : ""}
          {target.verifiedAt
            ? `配置验证于 ${new Date(target.verifiedAt).toLocaleString("zh-CN")}`
            : "可达性未验证"}
        </small>
      </div>
      <div className="target-card-actions">
        {canManage ? (
          <Button variant="secondary" onClick={onEdit}>
            <Pencil /> 编辑
          </Button>
        ) : null}
        <span className="status-pill">
          {target.enabled
            ? isAkFileDrop && !target.credentialConfigured
              ? "待补凭据"
              : "已配置"
            : "已停用"}
        </span>
      </div>
    </article>
  );
}

function SystemRow({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="system-row">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}
function ownershipLabel(value: DeviceOwnership) {
  return (
    { OWNED: "持有", BORROWED: "借用", SOLD: "已出", WISHLIST: "想要" } as const
  )[value];
}
function categoryLabel(value: DeviceCategory) {
  return (
    {
      DAP: "DAP",
      DAC: "DAC",
      AMPLIFIER: "放大器",
      HEADPHONE: "耳机",
      SPEAKER: "音箱",
      STREAMER: "串流设备",
      OTHER: "其他",
    } as const
  )[value];
}
