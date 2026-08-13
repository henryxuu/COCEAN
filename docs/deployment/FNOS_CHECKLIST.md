# FNOS 部署与 Music 识别验收清单

## 部署前

- [ ] 已记录 FNOS 版本、CPU 架构、Docker Engine 与 Compose 版本。
- [ ] 已确认 Music、data、cache、inbox、delivery 的真实绝对路径。
- [ ] Music 是现有目录且容器账号只有读与遍历权限。
- [ ] data/cache/inbox/delivery 已存在，UID/GID 与权限匹配。
- [ ] SQLite、WAL 和 SHM 只写入 data，不进入 Music 或 cache。
- [ ] data 位于 FNOS 本机文件系统，不是 SMB/NFS 网络挂载。
- [ ] 仅 Web 端口发布到局域网；数据库和 API 没有主机端口。
- [ ] 已用 `generate_web_auth.sh` 生成独立的首位管理员 bootstrap 文件，文件不在 Music/data/cache/inbox/delivery 内，未把密码写入 `.env`、日志或 Issue。
- [ ] 浏览器显示独立登录页；错误凭据返回 401，成功后使用 HttpOnly Session Cookie，`/healthz` 保持无凭据可用。
- [ ] 管理员可创建独立成员账号，浏览器可保存各自密码；数据库不保存明文登录密码。
- [ ] Web 端口未通过端口转发、UPnP 或无 TLS 的反向代理直接暴露公网；纯 HTTP 不能加密登录链路。
- [ ] 如经 FNOS 反向代理提供 HTTPS，代理保留原始 Host，并已复测同源写 API、PWA 与 Listen Range。
- [ ] `docker compose config --quiet` 或仓库静态检查通过。
- [ ] `fnos_preflight.sh` 返回 0，Compose >= 2.20，core/acceptance/maintenance/providers 四个 profile 均可展开。
- [ ] `COCEAN_VERSION` 是不可变发行标签，不是 edge/latest/dev。
- [ ] 五个目录存在且互不相同、互不包含；没有把 data/cache/inbox/delivery 放进 Music。
- [ ] `COCEAN_SCAN_EXCLUDE_DIRS` 中每一项都已人工确认不含真实音频；路径精确、区分大小写、非 symlink，且 Worker、manifest、API 验收使用同一策略。
- [ ] 容器化 PUID/PGID 权限探针通过，且 PUID/PGID 均不为 0。
- [ ] 升级前 runner 已生成并复核 `data/backups/pre-upgrade-*.sqlite` 与同名 JSON；初次安装明确记录“无旧库”。
- [ ] 备份的 `integrity_check`、外键、Schema、大小和 SHA-256 全部通过；Music 主库不属于升级写入范围。
- [ ] `COCEAN_MUSICBRAINZ_ENABLED=false`，除非已完成单独的隐私确认。
- [ ] 如使用 Still 目录，`COCEAN_DATA_DIR/still-catalog.json` 已由有权数据生成，未放进 Music 或镜像。
- [ ] 设置页显示的 Still 内容版本、记录数和 runtime checksum 与导入记录一致。

## 首次只读扫描

- [ ] 已生成 `music-before.jsonl`，且输出文件位于 Music 之外。
- [ ] Worker 能遍历 Music，没有权限拒绝或路径逃逸。
- [ ] 文件系统音频文件数与成功索引数可对账。
- [ ] 不支持格式、损坏文件和缺少标签都有可追踪错误，不被静默跳过。
- [ ] Album 聚合能正确处理 Album Artist、Disc/Track Number 和多碟目录。
- [ ] FLAC/ALAC/WAV/AIFF/DSF 等实际存在格式的位深、采样率或 DSD 倍率正确。
- [ ] 优先显示内嵌 Front Cover；无内嵌图时再识别 cover/folder/front sidecar。
- [ ] 没有封面时使用占位，不把模型生成图误认为发行封面。
- [ ] 从唱片库可以打开每个已索引 Album 的详情页。
- [ ] 详情页可见标题、Album Artist、年份、曲目/碟号、音频规格和介质标签。
- [ ] 每个数字 Track 的 Album、Album Artist/Artist、Title、Track Number 标签质量警告为 0；目录名回退未被误当成准确标签。
- [ ] ffprobe 与标签的位深/采样率/声道冲突为 0，DSD 倍率全部能确定映射。
- [ ] 元数据冲突显示来源与置信理由；模型不能把结果自动标为已核验。
- [ ] PCM Listen 只读访问原文件；DSD 浏览器模式由 Server 实时转为 PCM FLAC，均不生成或覆盖源目录内容。
- [ ] 唱片库分页总数与数据库 Album 总数一致，超过 100 张时没有静默截断。
- [ ] 扫描 `/report` 的五个 invariants 全为 true，`unprocessed=0`。
- [ ] `/files` 已完整分页，candidate、outcome、边界计数与扫描报告/旧 failures 对账。
- [ ] baseline 的全部非排除普通文件数、symlink 数与扫描发现结果一致；没有普通文件从文件系统清单中消失。
- [ ] ignored、symlink、CUE、特殊文件条目均为 0；若显式放宽，已在不公开的 baseline 中逐项确认例外不包含漏识别音频。
- [ ] 本地重算的扫描 `summaryHash` 与服务端一致，报告没有复制任何私人路径。
- [ ] 全部 Album 都已分页并逐个打开详情，不只是抽查第一页。
- [ ] 所有声明封面均完成 GET；至少达到显式配置的最小封面数。
- [ ] Listen Range 返回 206；正式飞牛首验默认逐一检查每个已索引 Track。

## Still 推荐与找歌

- [ ] 首页结果标记为已核验目录兼容轮换，不冒充 v0.10 Accepted Runtime。
- [ ] 相同目录版本和日期重复请求得到相同 Today Album。
- [ ] 找歌只显示目录记录实际具备的 Domain/Feature 理由。
- [ ] 年代、演唱者性别、语言、Hi-Res/DSD 等缺失事实显示为未采用条件。
- [ ] `modelCallCount=0`，模型未接入时设置开关禁用。
- [ ] 本地严格匹配成功时能打开详情；有数字曲目时 Listen 读取真实流。
- [ ] 本地未匹配且目录有 Apple Music 链接时显示外部封面、30 秒试听和商店链接，并有来源标识。
- [ ] v0.10 状态保持 `WAITING_FOR_ACCEPTED_RUNTIME`，直到正式 Snapshot 完成独立验收。

## 可选 MusicBrainz 核验

- [ ] 本地扫描、唱片库和详情页在完全离线时可正常工作。
- [ ] 启用前已填写真实且可维护的 `COCEAN_METADATA_CONTACT`。
- [ ] 开关为 true 且 Contact 为空时，Server 按预期保持 unhealthy。
- [ ] Contact 使用项目 URL 或邮件别名，不包含 NAS 私网地址、密码或 Token。
- [ ] 请求只发送 Album 标题、Album Artist、可选年份和结果数量。
- [ ] 没有发送音频、私人封面、路径、NAS/设备信息、播放历史或模型提示词。
- [ ] 外部失败只产生可重试证据错误，不阻断本地索引。
- [ ] 外部结果只进入 cache/候选层，不自动写回源文件或标记“已核验”。
- [ ] 需要绝对离线时，FNOS 防火墙已禁止 Server 出站。
- [ ] Worker 没有 egress 网络，也没有 MusicBrainz 环境变量。

## 扫描后不变性

- [ ] `music_manifest.py verify` 返回 0。
- [ ] 扫描前后路径、大小、mtime 和逐文件 SHA-256 均无变化；只有明确接受较弱证据时才可将 Hash 模式降为 `none`。
- [ ] Music 目录内未新增数据库、缩略图、日志、临时文件或隐藏文件。
- [ ] data/cache 中可以清楚区分持久状态与可再生成缓存。
- [ ] baseline 文件在 verify 前后 SHA-256 未变化，避免用被替换的 baseline 验收。
- [ ] `api-report.json` 只有聚合计数、类型和 Hash，不含路径、URL、Cookie、Token 或密码。
- [ ] 报告中的排除目录数量与策略 Hash 与私有 manifest header 一致；报告未复制目录名。

## 一键验收闭环

- [ ] 使用 `fnos_acceptance.sh --deploy-mode build|pull|existing`，而不是只执行 `up`。
- [ ] `up --wait` 后 Web、Server、Worker 均为 running + healthy。
- [ ] 运行态 inspect 证明只读 rootfs、非 root、cap_drop、no-new-privileges 与网络隔离。
- [ ] 运行态 inspect 证明 Web、Server、Worker 的 cgroup 内存上限与 `.env` 一致。
- [ ] Server 有受控 egress；Worker 和 acceptance-api 没有 egress。
- [ ] `provider-qobuz` 没有运行中或停止状态容器。
- [ ] 人为制造 API Gate 失败时，manifest verify 仍执行且总 runner 返回非 0。
- [ ] 人为制造备份失败时，新 Server 不启动、不迁移数据库；人为制造部署后 Gate 失败时三个核心服务被停止。
- [ ] 最终输出为 `fnos-acceptance: PASS`，三个验收报告文件均存在。

## Inbox 与 Provider

- [ ] 当前 Provider 固定为零副本、无网络、无挂载、无 secret。
- [ ] 没有创建或填写 Qobuz URL、Cookie、密码或 Token。
- [ ] 占位 Provider 被直接运行时以配置错误退出，不能进入健康状态。
- [ ] 未来 Provider 必须经过独立设计与测试后，通过新版本解除禁用。
- [ ] 未来下载仍须经过身份、完整性、规格和目标路径 Gate。
- [ ] 从 Inbox 到托管库的写入需单独授权，不能借只读扫描自动发生。

## 播放器投送

- [ ] SP3000M 使用播放器 AK File Drop 页面显示的 `ftp://` 地址、账号和密码，不误标为 SMB。
- [ ] FTP 密码由 NAS 本地密钥加密保存，API 与页面均不回显。
- [ ] 专辑详情可选择目标并发起投送，完成后显示设备、传输方式、时间、文件数与校验状态。
- [ ] U 盘必须先由 FNOS 显式挂载到 `COCEAN_DELIVERY_DIR`；容器不使用 privileged，也不操作裸盘。

## 更新与回滚

- [ ] 使用不可变版本标签，已记录当前和目标版本。
- [ ] 升级前 SQLite/data 迁移可备份、可恢复。
- [ ] 升级只使用已验证的 SQLite online backup；未在 WAL 活跃时复制单个 `.sqlite` 文件。
- [ ] 旧镜像面对更高或未知 Schema 时拒绝启动，不会尝试降级读写。
- [ ] 回退前先保存失败现场并再次 verify 目标快照；恢复数据库与旧镜像版本由管理员显式执行。
- [ ] 健康检查全部通过后才视为升级完成。
- [ ] 回滚不要求修改或重扫 Music 主库。
