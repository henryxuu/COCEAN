# COCEAN 在飞牛 FNOS 上的 Docker Compose 部署

## 当前状态

本目录既是部署合同，也是当前实现的上线入口。`apps/web`、`apps/server` 与
`apps/worker` 已提供自包含容器运行产物；开发机已完成无 Docker 的产物启动、
健康检查与合成音乐库端到端验收。实际镜像构建、Compose schema 检查和真实
Music 全库验收仍必须在带 Docker 的 FNOS 或 CI 上执行。

唯一部署入口是：

```text
infra/compose/fnos/compose.yaml
```

## 服务边界

| 服务             | 默认启用 | 职责                                           | 主机端口       | 可写目录                                               |
| ---------------- | -------- | ---------------------------------------------- | -------------- | ------------------------------------------------------ |
| `web`            | 是       | 响应式 Web/PWA 与同源 `/api` 反向代理          | `18080` 可配置 | 无                                                     |
| `server`         | 是       | API、登录、详情、试听转码与 FTP/USB 投送       | 无             | data、cache、delivery                                  |
| `worker`         | 是       | 扫描、标签解析、封面提取、任务执行             | 无             | data、cache、inbox、quarantine；MANAGED 时条件写 Music |
| `provider-qobuz` | 否       | 预留占位；当前固定为零副本且不可启动           | 无             | 无                                                     |
| `music-manifest` | 否       | 扫描前后只读不变性验收                         | 无             | data 中的验收目录                                      |
| `acceptance-api` | 否       | 全库扫描、账本、专辑、详情、封面与 Listen 验收 | 无             | data 中的聚合报告                                      |
| `db-maintenance` | 否       | 迁移前 SQLite online backup 与独立复核         | 无             | data 中的备份目录                                      |

默认 `WATCH_ONLY` 下，`server` 与 `worker` 都只能把真实音乐库看到成
`/library/music:ro`。只有部署者显式设置 `COCEAN_MUSIC_ROOT_POLICY=MANAGED`、
`COCEAN_MUSIC_READ_ONLY=false` 并通过前检时，Worker 才把该测试 Root 挂为读写；
Server 始终只读。Worker 可写独立 `/library/inbox` 与 `/library/quarantine`。容器不使用
`privileged`、不使用 host network，也不接触磁盘设备或负责安全弹出。
只有 Server 连接不发布端口的 `egress` bridge，为将来的显式元数据核验提供
出站能力；执行本地扫描的 Worker 没有外联网络，Qobuz 占位服务与 `music-manifest`
都是 `network_mode: none`。`db-maintenance` 也没有网络、Music、cache、inbox 或 secret，
只在维护 profile 中访问 data。`acceptance-api` 是唯一例外：它只连接 `internal: true` 的
backend，以 `http://server:8080` 访问未发布的内部 API；它没有 Music/Inbox
挂载、没有 egress、没有主机端口、没有 secret，也不会获得 Cookie 或 Token。

当前版本提供独立登录页和本地多用户账号。Docker secret 中的一行
`owner:password` 只在空数据库首次启动时创建管理员；后续登录使用短期 HttpOnly
Session Cookie，密码在数据库中只保存 scrypt 加盐哈希。管理员可在设置页创建、
停用成员或其他管理员账号，浏览器密码管理器可保存每个人自己的凭据。`/healthz`
保持无凭据健康检查，Web 会先向 Server 验证 Session，再转发业务 API；所有写请求
仍必须带与 Host 完全一致的 Origin。Web 不会把浏览器 Authorization 头转发给 Server。

纯 HTTP 仍不能加密登录链路，因此 Web 端口只能位于可信局域网，禁止直接映射到
公网；跨网访问必须由 FNOS 反向代理或独立网关提供 TLS，并把
`COCEAN_COOKIE_SECURE=true`。该访问边界本身不会授予 MANAGED 权限；Music 默认仍按
WATCH_ONLY 只读挂载，只有另行授权并显式配置的 MANAGED Root 才允许 Worker 受控读写。

## MusicBrainz 可选访问与隐私边界

本地标签、内嵌封面、sidecar 封面和音频规格扫描不依赖网络，也不依赖模型。
基础部署默认 `COCEAN_MUSICBRAINZ_ENABLED=false`。当前版本已提供用户触发的
MusicBrainz 发行版候选搜索、候选持久化和人工确认；它不会接入自动扫描任务，
也不会自动把候选晋升为已核验事实。

启用时必须同时满足：

- `COCEAN_MUSICBRAINZ_ENABLED=true`；
- `COCEAN_METADATA_CONTACT` 是真实项目 URL 或有人维护的邮件别名；它只用于
  `COCEAN/<version> (<contact>)` User-Agent，不应填写私人 NAS 地址或密码；
- 只访问代码内固定的 MusicBrainz HTTPS API，不通过环境变量开放任意 Base URL；
- 遵守至少一秒一次的请求间隔、超时和失败退避，外部失败不阻断本地扫描；
- 发送范围只包括规范化 Album 标题、Album Artist、可选年份和结果数量；
- 不发送音频内容、内嵌或本地封面、绝对或相对路径、目录名、NAS 地址、设备清单、
  Cookie、播放历史、用户画像或大模型提示词；
- 如果未来启用 Cover Art Archive，只能在用户确认 MusicBrainz Release 候选后，
  使用公开 Release ID 获取候选封面，仍不得上传私人封面；
- 外部响应只能进入 cache 和候选证据层，不能直接写回 Music 或自动标记“已核验”。

如果希望做网络层的绝对离线部署，应同时在 FNOS 防火墙中禁止 Server 出站；
本地扫描、唱片库和详情页仍应完整工作。

## 应用镜像契约

三个应用包使用 Node 22+ 和 pnpm 11 workspace，包名分别为：

- `@cocean/web`
- `@cocean/server`
- `@cocean/worker`

每个包必须提供 `build:container` 脚本，并输出自包含的
`apps/<name>/.cocean-runtime/`：

- `start.mjs`：前台运行，正确处理 SIGTERM；
- `healthcheck.mjs`：成功返回 0，失活或依赖不可用返回非 0；
- `package.json` 与运行所需的生产依赖；
- Worker 包含明确失败的 Provider 占位入口；在适配器完成独立测试前，
  `providers` profile 不得启用。Server 运行产物还包含不启动应用、不执行迁移的
  `backup.mjs`，只供隔离的 `db-maintenance` 服务调用。

固定容器端口为 Web `3000`、Server `8080`。Worker 不监听公共端口，但
`healthcheck.mjs` 必须检查 SQLite、任务租约和事件循环是否仍可工作。Web
必须把同源 `/api` 转发到 `http://server:8080`。

## FNOS 目录和权限准备

先在飞牛管理界面确认真实绝对路径，不要猜测卷名。至少准备六个生命周期不同的
目录，以及一个独立 secret 文件：

1. Music：现有主库，只读；
2. quarantine：COCEAN 生命周期隔离区，必须位于 Music 之外；
3. data：SQLite 数据库、应用状态、内容包与验收清单；
4. cache：可重新生成的封面、指纹和刮削缓存；
5. inbox：新下载或导入内容的暂存区；
6. delivery：供 FNOS 显式挂载 U 盘的可写投送目录；没有 U 盘时也应先准备空目录；
7. 首位管理员 bootstrap secret：只读的一行 `owner:password`，必须位于上述六个目录之外；

如果部署者有权使用 Still 精品目录，先按
`docs/catalog/STILL_CATALOG_IMPORT.md` 在可信开发机生成运行包，再将最终文件放到
`COCEAN_DATA_DIR/still-catalog.json`。Compose 会把它固定映射为
`/var/lib/cocean/still-catalog.json`；不要把目录文件放进 Music，也不要在镜像中重新分发。

在 NAS 终端用 `id` 确认运行应用的 PUID/PGID，并让该账号对 Music 只有读和
遍历权限，对 quarantine/data/cache/inbox/delivery 有读写权限。SQLite 位于
`data/cocean.sqlite`，WAL 与 SHM 文件也只会写入 data，不会进入 Music。
data 必须位于 FNOS 本机文件系统，不能放在 SMB、NFS 或其他不保证 SQLite
锁与 WAL 语义的网络文件系统上。Server 负责先执行迁移，Worker 只在 Server
健康后启动。

Compose 使用 `create_host_path: false`，路径写错时会失败，而不会在错误位置
悄悄创建一个空 Music 目录。

该 Compose 需要支持 `name`、long-form bind mount 和条件依赖的 Docker
Compose v2；建议 FNOS 使用 Compose v2.20 或更新版本。

应用启动会拒绝数据库中任何当前版本不认识的迁移编号或迁移名称，防止回退到旧
镜像时误读更高版本 Schema。升级仍必须使用一键 runner；不要直接对活跃的 WAL
数据库复制单个 `.sqlite` 文件。

## 首次配置

在部署目录中复制环境模板，并只修改副本：

```bash
cp infra/compose/fnos/.env.example infra/compose/fnos/.env
```

先在 NAS 本地终端生成首位管理员凭据；命令只在终端显示一次随机密码，请立即保存到
密码管理器，不要把密码粘贴到聊天、`.env`、Issue 或日志：

```bash
mkdir -p /你选择的独立路径/cocean-secrets
sh infra/scripts/generate_web_auth.sh \
  /你选择的独立路径/cocean-secrets/web-basic-auth.txt owner
```

把生成文件的绝对路径填入 `.env` 的 `COCEAN_WEB_AUTH_FILE`。该名称为部署兼容键，
文件只挂到 Server 用于首次建号。前检会验证它是非 symlink 的单行普通文件、密码至少
16 字符，并拒绝它位于 Music/quarantine/data/cache/inbox/delivery
内部；实际凭据内容不会打印。

将 `.env` 中所有 `/replace/with/...` 替换为 FNOS 显示的现有绝对路径。
同时把 `COCEAN_IMAGE_NAMESPACE=replace-with-owner/...` 换成实际发布坐标，并把
`COCEAN_VERSION=edge` 换成不可变的发行标签；一键前检会拒绝 `edge`、`latest`、
`dev` 和仍含占位符的配置。
`COCEAN_HTTP_PORT` 是局域网入口，只有 Web 端口会发布到主机。
浏览器首次访问会显示 COCEAN 登录页；管理员登录后可在“设置 → 账号管理”添加多人。
仍必须确认该端口没有被路由器端口转发、UPnP 或无 TLS 的公网反向代理意外暴露。
若使用 FNOS HTTPS 反向代理，应保留原始 Host，否则同源写请求会按设计被拒绝。

`NODE_IMAGE` 默认使用 Docker Hub 官方 Node 镜像。若 FNOS 的全局 Docker Hub
代理故障，可以显式改为同一官方镜像的可信公共镜像地址；该值只参与本地构建，
不会传入运行容器。不要使用来源不明的第三方重打包镜像。
`DEBIAN_MIRROR` 默认留空并使用 Debian 官方源；仅当 NAS 到官方源不可用或速度
不可接受时，才填写可信镜像站根地址。精简基础镜像没有预装 CA 证书时，可以使用
镜像站的 HTTP 地址；镜像站只改变包的传输路径，APT 仍强制校验 Debian Release
签名，构建未启用 `trusted=yes` 或任何跳过认证选项。该值也只参与构建，不进入
运行容器。

`COCEAN_SCAN_EXCLUDE_DIRS` 只用于声明 Music 根目录内明确不是音乐内容的目录，
例如 Roon 备份、回收站或下载工具自己的运行环境。值必须是 JSON 字符串数组，
元素是区分大小写的精确相对路径；不支持通配符，也不能包含 `..`、绝对路径、
符号链接、重复项或相互嵌套的目录。前检会确认每个目录真实存在且仍位于 Music
根目录内。Worker、扫描前后 manifest 和 API 验收读取同一配置，因此排除目录既
不会被当成 ignored 文件，也不会从不变性清单中“前后口径不一致”。不要为了让
扫描报告变绿而排除真实音乐。FNOS `.@__thumb`、Synology `@eaDir` 与
`.AppleDouble` 是明确的系统元数据边界；其中的文件统一计为辅助文件，即使缩略图
沿用了 `.flac`、`.dsf` 等音频后缀也不会交给媒体解析器，但仍保留在不变性清单的
常规文件总数中。
验收变绿而排除包含真实音频的目录；每项排除都应先由管理员在 NAS 上核对用途。

`COCEAN_MUSICBRAINZ_ENABLED` 保持 `false` 时，
`COCEAN_METADATA_CONTACT` 可以为空；准备启用外部元数据核验时必须先填写可联系
的项目 URL 或邮件别名。当前版本不要创建或填写任何 Qobuz URL、Cookie、密码
或 Token。

启动后在设置页核对 Still 目录的内容版本、记录数与完整 runtime checksum。没有目录文件时，
唱片库、扫描和详情页仍可工作，但首页/找歌会明确显示目录未就绪，不会回退到演示推荐。

## 健康检查与环境变量映射

- Web 使用 `HOST/PORT`，健康检查访问容器内 `/healthz`；
- Server 使用 `COCEAN_HOST/COCEAN_PORT`，健康检查访问
  `/api/v1/readiness`，并同时验证 SQLite 和 `/library/music` 可读；
- Worker 不监听端口，健康检查读取 SQLite 中的 scanner heartbeat；
- Worker 的 `COCEAN_WORKER_POLL_MS`、`COCEAN_FFPROBE_PATH`、
  `COCEAN_FFPROBE_TIMEOUT_MS`、`COCEAN_WORKER_ONCE` 与
  `COCEAN_SCAN_EXCLUDE_DIRS` 均直接映射现有配置；
- Web、Server 与 Worker 默认分别限制为 256 MiB、768 MiB 与 2 GiB；Worker
  限额同时约束全库哈希产生的可回收文件页缓存，避免首次扫描挤占 NAS 其他服务。
  可以通过 `.env` 的 `COCEAN_*_MEMORY_LIMIT` 调整，但应先观察匿名内存与页缓存，
  不要仅根据 Docker 面板的合计数判断 Node 堆内存泄漏；
- 未被当前应用读取的角色名或 Inbox 环境变量不放入 Compose。Inbox 的写入边界
  由独立 bind mount 表达。
- MusicBrainz 客户端属于 Server，因此 `COCEAN_MUSICBRAINZ_ENABLED` 与
  `COCEAN_METADATA_CONTACT` 只映射给 Server；Worker 不获得元数据外联配置。
- 当 MusicBrainz 开关为 `true` 但 Contact 为空时，Server 健康检查会保持失败，
  防止以匿名或不合规 User-Agent 对外请求。

## 静态检查与启动

没有 Docker 的开发机可以先执行仓库内的结构检查。它会验证 YAML、只读
Music、分卷、四个 profile、健康检查、安全选项和必填环境变量契约：

```bash
ruby infra/scripts/validate-fnos-compose.rb
```

仓库的无 Docker 回归套件还会运行 Python 标准库模拟 API、失败分页、摘要篡改、
Range 非 206、前检负例，以及“部署失败仍执行 manifest verify”的退出路径：

```bash
sh infra/tests/run.sh
```

该检查不能替代 Docker Compose 自己的 schema 与镜像构建检查；两者都必须在
带 Docker 的 CI 或 FNOS 上通过。

一键 runner 在部署前先准备目标镜像。若 data 中已有 `cocean.sqlite`，它随后通过
无网络的 `db-maintenance` 服务创建 `data/backups/pre-upgrade-<UTC>.sqlite` 及同名
JSON 证据。备份使用 SQLite online backup，并独立执行完整性、外键、Schema、大小
和 SHA-256 复核；任一步失败都会在新 Server 启动和迁移前终止。初次安装没有旧库
时会明确记录跳过。

有 Docker Compose 的环境先执行：

```bash
docker compose \
  --env-file infra/compose/fnos/.env \
  -f infra/compose/fnos/compose.yaml \
  config --quiet
```

正式启动前应直接运行宿主机前检：

```bash
sh infra/scripts/fnos_preflight.sh \
  --env-file infra/compose/fnos/.env \
  --compose-file infra/compose/fnos/compose.yaml
```

它会 fail-closed 检查 Compose >= 2.20、core/acceptance/maintenance/providers 四种 profile、
不可变镜像标签、非 0 PUID/PGID、六个目录存在且互不包含、隔离的首位管理员
secret、data 不是已知网络
文件系统、amd64/arm64 架构、Web 端口冲突，并在隔离容器中按配置 UID/GID 验证
Music 可读与 quarantine/data/cache/inbox/delivery 可写。权限探针只在五个固定可写目录
创建并立即删除随机 sentinel；WATCH_ONLY 不会写 Music，MANAGED 则会额外验证 Music
可写，也不会打印真实主机路径。若无法证明文件系统类型或权限，
前检会失败，而不是降级为警告。

使用本地源码构建并启动核心服务：

```bash
docker compose \
  --env-file infra/compose/fnos/.env \
  -f infra/compose/fnos/compose.yaml \
  up -d --build web worker
```

`web` 会通过依赖关系带起 Server。部署预构建镜像时去掉 `--build`，
并确保 `.env` 中的 registry、namespace 和 version 指向已发布版本。

查看健康状态时只看服务名、状态和健康检查，不导出完整环境变量：

```bash
docker compose -f infra/compose/fnos/compose.yaml ps
```

## 一键部署与完整验收

真实 FNOS 的推荐入口是总 runner，而不是逐条手工执行：

```bash
sh infra/scripts/fnos_acceptance.sh \
  --env-file infra/compose/fnos/.env \
  --deploy-mode build
```

`--deploy-mode` 有三个明确模式：

- `build`：从当前 monorepo 构建后启动；首次源码部署使用；
- `pull`：先拉取 `.env` 中的不可变镜像，再启动；发行版部署使用；
- `existing`：只使用本机已有镜像，不构建、不拉取；默认值，适合离线复验。

总 runner 按固定顺序执行八个 Gate：

1. 执行完整 preflight；
2. 按 `build`、`pull` 或 `existing` 模式准备不可变应用镜像，但不启动应用；
3. 在任何应用容器启动前，按与 Worker 完全相同的排除策略生成 Music 全文件
   baseline；默认记录逐文件 SHA-256，并在宿主机再次保存 baseline 文件本身的
   SHA-256；
4. 若旧数据库存在，创建并复核 online backup；备份失败时禁止启动新 Server；
5. `docker compose up -d --wait`，等待 Web、Server、Worker 全部 healthy；
6. 检查实际容器的非 root 用户、只读 rootfs、`cap_drop: ALL`、
   `no-new-privileges`、Server Music 始终 `RW=false`、Worker Music 挂载与 Root Policy
   一致、Server/Worker 网络差异、Worker ffprobe，
   并证明 Qobuz Provider 没有容器；
7. 启动一次性 `acceptance-api` 完成全库 API 验收；
8. 无论镜像准备、备份、部署、运行态检查或 API 验收成功、失败还是收到终止信号，都再次核验 baseline 自身
   SHA-256 并运行 Music manifest verify，最后传播非零退出码。

前检或 baseline 本身失败时没有可信 baseline 可供比较，因此会停止且不启动应用；
一旦 baseline 成功，退出清理路径就必须执行 verify。成功时核心服务保持运行；新部署
在健康、运行态、API 或 Music 不变性 Gate 失败时会停止 Web/Worker/Server，避免继续
写入可能已迁移的数据库。Runner 不自动覆盖数据库，已验证的升级前快照会保留供
人工诊断和显式回退。

API 验收是 P0 Gate，不是只看首页能否打开。它会：

- 默认 POST 创建新的 `music` 全库扫描并轮询到终态；若显式配置安全的既有扫描 ID，
  则只 GET/轮询该任务并复用其不可变证据，不会再发起扫描；
- 完整分页读取旧 `/failures`，与 `failedFiles` 交叉核对；
- 读取扫描总报告，完整分页读取逐文件 ledger，在内存中核对 candidates、processed、
  PARSED/UNSUPPORTED/FAILED/SKIPPED、边界证据、所有不变量，并按服务端规范重算
  SHA-256 `summaryHash`；
- 从完整 ledger 按 `extension + outcome + errorCode` 聚合不支持格式；只有
  `UNSUPPORTED + UNSUPPORTED_MEDIA` 且扩展名和数量落在显式策略内才可放行，真正的
  `FAILED` 使用独立的零容忍额度；
- 逐行读取扫描前的 Music baseline，把其中每个普通文件和符号链接与本次扫描计数、
  ledger 路径集合对账；默认拒绝任何 ignored 文件、跳过的 symlink、CUE 或特殊文件
  系统条目，避免“扩展名未识别但验收仍通过”；
- 完整分页读取全部 Album，逐个打开详情并对账专辑、数字专辑、聚合问题、曲目和文件数；
- 对所有已声明封面执行 GET，并验证 image Content-Type 和非空响应；
- 默认对每个已索引 Track 发送一字节 Range 请求，严格要求 206、
  `Accept-Ranges: bytes` 和合法 `Content-Range`；同时要求详情页 Track ID 集合与
  扫描 ledger 的 PARSED media ID 集合完全相等，不能漏曲、重复挂载或跨 Album 重复；
- 对每个 Track 校验安全相对路径、非零文件大小、Codec、Container、采样率、声道、
  PCM/DXD 位深及 DSD 倍率；`UNKNOWN` 规格会直接阻断正式验收；
- 所有声明封面不仅要返回 image Content-Type，还必须与 URL 中的 SHA-256 一致。

报告写入 `COCEAN_DATA_DIR/acceptance/api-report.json`。它只包含 Gate 状态、计数、
outcome/candidate/不支持扩展名聚合和摘要 Hash；复用扫描时只记录
`reusedExistingScan=true`，不会记录扫描 ID。报告不复制曲名、专辑名、相对或绝对路径、
NAS 地址、Base URL、响应正文、Cookie、Token 或密码。失败响应也只保留固定的
Gate 名和安全错误类别。扫描逐文件路径会参与内存中的摘要核验，但不进入报告。
`music-before.jsonl` 与 `music-after.jsonl` 为了证明文件不变性，必然包含相对路径；
它们必须留在不对 Web 发布的 data 目录中，不能作为公开诊断附件发送。

以下 `.env` 项控制真实库验收策略：

- `COCEAN_ACCEPTANCE_MAX_FAILURES=0`：只控制完整 ledger 中 `outcome=FAILED` 的真实
  扫描/解析失败，默认零容忍；它不会被 ISO 等 `UNSUPPORTED` 消耗，也不能用不支持
  格式策略掩盖损坏 FLAC；
- `COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS={}`：默认不接受任何不支持格式。
  经过逐项核对后可按小写扩展名声明显式数量上限，例如 `{\".iso\":220}`；只有
  `outcome=UNSUPPORTED`、`errorCode=UNSUPPORTED_MEDIA` 且实际数量不超过上限时放行，
  且 ledger 必须把它标为 `KNOWN_UNSUPPORTED_AUDIO`。策略只接受当前扫描器明确认知但
  暂不能建立逐曲事实的格式（如 `.iso`、`.sacd`、`.dts`、`.aob`、`.vob`）；`.flac` 等受支持格式不能
  写入豁免，未列出的扩展名、错误码不匹配或超量都会阻断；
- `COCEAN_ACCEPTANCE_EXISTING_SCAN_ID=`：默认留空并创建新扫描。只在扫描已经完成、
  Music 仍是同一只读快照且需要避免重复读取大库时，填写该任务的 UUID/安全标识；
  验收会直接 GET/轮询它并继续执行全部 ledger、Album 详情、封面和 Listen Range Gate，
  不会 POST 新扫描。若无法证明扫描与当前 Music/程序版本对应，应留空重扫；
- `COCEAN_ACCEPTANCE_MANIFEST_HASH=sha256`：默认逐文件复核内容哈希，证明扫描前后
  不只是大小与 mtime 相同；只有明确接受较弱证据时才可设为 `none`；
- `COCEAN_SCAN_EXCLUDE_DIRS=[]`：仅允许经过人工核对的非音乐目录；报告只记录
  排除项数量和策略 Hash，不泄露目录名，私有 manifest header 保留完整口径供复验；
- `COCEAN_ACCEPTANCE_MIN_ALBUMS=1`：至少识别的 Album 数；
- `COCEAN_ACCEPTANCE_MIN_ARTWORKS=1`：至少成功 GET 的真实封面数；
- `COCEAN_ACCEPTANCE_MAX_MISSING_ARTWORKS=0`：默认不接受缺封面 Album；若源库确实
  无图，需要人工核对后显式提高，报告仍保留缺失总数；
- `COCEAN_ACCEPTANCE_MAX_ALBUM_ISSUES=0`：默认不接受缺 Disc、缺 Track 或重复曲位；
- `COCEAN_ACCEPTANCE_MAX_IGNORED_FILES=0`：默认不允许扩展名边界之外的普通文件被
  静默略过；需要例外时应先在私有 baseline 中逐项确认它们不是音频；
- `COCEAN_ACCEPTANCE_MAX_SKIPPED_SYMLINKS=0`：默认不允许符号链接；显式放宽只代表
  接受“链接不作为 Track 入库”，不会跟随链接扫描；
- `COCEAN_ACCEPTANCE_MAX_CUE_FILES=0`：当前 CUE 只作 sidecar，不拆整轨，故正式首验
  默认阻断；确认库中 CUE 不代表待拆分音频后才能提高；
- `COCEAN_ACCEPTANCE_MAX_OTHER_ENTRIES=0`：默认拒绝 socket/device 等非普通条目；
- `COCEAN_ACCEPTANCE_MAX_TAG_WARNINGS=0`：默认要求每个数字 Track 都有 Album、
  Album Artist/Artist、Title 与 Track Number；目录/文件名回退只保证 UI 可读，不能
  被当作播放器标签已经准确的证据；
- `COCEAN_ACCEPTANCE_MAX_TECHNICAL_WARNINGS=0`：默认拒绝 ffprobe 与标签规格冲突，
  以及无法映射到 DSD64/128/256/512 的采样率；
- `COCEAN_ACCEPTANCE_SCAN_TIMEOUT=7200`：新扫描或仍在运行的复用扫描最长等待秒数；
- `COCEAN_ACCEPTANCE_LISTEN_MODE=representative|each-album|each-track`：试听覆盖级别，
  正式首验默认 `each-track`。

如果库里确实没有任何封面，可以把最小封面数设为 0，并同步提高允许缺封面数；
这代表“人工接受无封面”，不能证明刮削封面质量。

## 可选 Provider

当前版本不得启用 `providers` profile，也没有受支持的启用命令。Compose 将
`provider-qobuz` 固定为 `scale: 0`、`restart: no`、`network_mode: none`，
不给它 Music、Inbox、cache 或 secret；即使管理员绕过副本数直接运行占位入口，
进程也会以配置错误退出，健康检查恒定失败。

未来版本只有在外部 Provider 的权限、凭据存储、合法使用边界和独立测试全部完成
后，才能通过一次明确的 Compose 版本变更解除禁用。届时它仍只能是外部服务桥接
器，不是 COCEAN 的目录事实源，也不能绕过 Inbox 的完整性与入库 Gate。

## 扫描前后只读验收

一键 runner 已自动执行本节流程。以下命令只用于拆分诊断或人工复核。

首次扫描前生成 baseline：

```bash
docker compose \
  --env-file infra/compose/fnos/.env \
  -f infra/compose/fnos/compose.yaml \
  --profile acceptance run --rm music-manifest \
  snapshot --root /library/music \
  --output /var/lib/cocean/acceptance/music-before.jsonl \
  --hash sha256
```

在 UI 完成一次全库扫描并能从唱片库打开详情页后，执行：

```bash
docker compose \
  --env-file infra/compose/fnos/.env \
  -f infra/compose/fnos/compose.yaml \
  --profile acceptance run --rm music-manifest \
  verify --root /library/music \
  --baseline /var/lib/cocean/acceptance/music-before.jsonl \
  --output /var/lib/cocean/acceptance/music-after.jsonl
```

返回 0 表示所有文件与 sidecar 的相对路径、类型、字节大小、纳秒级 mtime 和
SHA-256 均未变化；返回 2 表示发现差异。全库哈希会增加 I/O，但它是首次正式
验收“源目录未修改”的默认强证据，verify 会自动沿用 baseline 的哈希模式。

## 本地验证边界与 FNOS 上线 Gate

当前开发机没有可用 Docker Engine，因此本仓库已经实际通过的是 Ruby 结构校验、
Shell 语法、Python 模拟全 API、前检负例、数据库 online backup 测试和退出清理模拟；
不能据此宣称真实 NAS 已验收。GitHub workflow 会在 Linux Docker runner 上执行四种
`docker compose config --quiet`、全仓测试、真实生成式音频扫描、amd64 运行镜像与
arm64 实际构建 Gate。

最终上线仍必须在目标 FNOS 上让以下命令返回 0：

```bash
sh infra/scripts/fnos_acceptance.sh \
  --env-file infra/compose/fnos/.env \
  --deploy-mode build
```

只有该命令同时产生 `api-report.json`、`music-before.jsonl`、`music-after.jsonl`，
最终打印 `fnos-acceptance: PASS`，并能从局域网 Web 打开唱片库和任意详情页，才算
完成“部署 + 真实 Music 识别 + 只读证明”。

## 多架构镜像

Buildx Bake 默认同时构建 `linux/amd64` 与 `linux/arm64`。先只查看构建计划：

```bash
sh infra/scripts/buildx.sh --print
```

设置发布坐标后推送多架构 manifest：

```bash
REGISTRY=ghcr.io \
IMAGE_NAMESPACE=your-account/cocean \
VERSION=0.1.0 \
sh infra/scripts/buildx.sh --push
```

本地 `--load` 只支持一个平台，需同时设置
`COCEAN_PLATFORMS=linux/amd64` 或 `linux/arm64`。正式版本使用不可变版本号，
保留上一版本镜像与 `data/backups/` 中的 SQLite 证据，避免只依赖 `latest`。

如升级失败，先保留新版本容器日志和当前数据库副本，再用维护服务对目标备份执行：

```bash
docker compose \
  --env-file infra/compose/fnos/.env \
  -f infra/compose/fnos/compose.yaml \
  --profile maintenance run --rm db-maintenance \
  verify pre-upgrade-YYYYMMDDTHHMMSSZ
```

只有 verify 返回 0，且 Web/Worker/Server 已停止，才可以在 FNOS 主机侧保存当前
`cocean.sqlite`、`-wal`、`-shm` 后，将对应备份恢复为 `cocean.sqlite`，再把
`COCEAN_VERSION` 改回匹配该备份的不可变旧版本。恢复会覆盖应用状态，因此不是
runner 的隐式动作，必须由管理员显式执行并重新跑完整验收。
