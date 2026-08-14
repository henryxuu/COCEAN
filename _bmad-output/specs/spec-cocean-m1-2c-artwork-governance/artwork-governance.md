# M1.2c 封面治理合同

## 资产、候选与选择

封面由三个不同概念组成：

- `ArtworkAsset`：COCEAN 缓存中的不可变图片字节，以 SHA-256 标识，记录真实 MIME、宽高、字节数和创建时间。
- `ArtworkCandidate`：资产的来源证据，可来自 `OBSERVED_EMBEDDED`、`OBSERVED_SIDECAR`、`USER_UPLOAD` 或 `MUSICBRAINZ_CAA`，并记录 LocalVersion、相对路径、图片 kind 或 Release ID。
- `ArtworkSelection`：LibraryAlbum 当前的人工决定，仅有 `SELECTED(assetSha256)`、`HIDDEN` 或不存在（自动模式）。

同一字节只存一个资产，但可以有多个来源证据。候选 ID 必须由 Album、版本、来源和资产哈希确定性生成；不得把绝对 NAS 路径返回 Web。资产文件只允许位于配置的 `cacheRoot/artwork` 内，读取时必须验证真实路径边界和 URL 哈希。

## 有效封面解析

按以下顺序解析唯一有效封面：

1. `USER_SELECTED`：使用人工选择的不可变缓存资产；即使原 LocalVersion 暂时消失也保持。
2. `USER_HIDDEN`：明确返回 `NONE`，不继续回退。
3. `AUTOMATIC_PRIMARY`：当前主 LocalVersion 中按 Front Cover、Folder Cover、分辨率、来源和哈希确定性排序的首选候选。
4. `AUTOMATIC_REPRESENTATIVE`：主版本无候选时，从其他当前成员版本确定性选择最佳候选。
5. `NONE`：没有可用候选。

API 保留现有扁平 `artwork` 供卡片和投送消费，同时增加 `selectionSource`、`assetSource`、`assetSha256`、`artworkRevision` 和候选详情。自动排序相同输入必须产生相同结果，不使用大模型或随机数。

## 本地候选与重扫

- Worker 对扫描器已验证的嵌入图和 sidecar 进行去重缓存；缓存时再次核对观察哈希，源变化则拒绝该候选且不写半成品。
- 同一 LibraryAlbum 最多返回 100 个当前候选；超过时按确定性排名截断并返回 `truncated=true`，但不得删除已经人工选择或被历史/投送引用的资产。
- 重扫重建当前观察关联，不更新或删除人工选择、上传资产、外部证据和不可变事件。
- 自动模式下，候选或主版本变化导致有效封面变化时 artworkRevision 递增；人工模式下仅候选变化不递增，来源状态可标记为暂不可用。
- `MISSING_ARTWORK` 和 `LOW_RES_ARTWORK` 保留扫描证据；当有效封面存在且宽高均不低于 600 时标记 `RESOLVED_BY_ARTWORK` 并退出默认待处理统计。隐藏封面不会把缺失问题视为已修复。

## 写入与并发合同

- `GET /api/v1/albums/:id/artwork`：登录用户读取有效封面、选择、候选及 artworkRevision。
- `POST /api/v1/albums/:id/artwork/select`：管理员提交 `requestId`、`expectedArtworkRevision` 与 `SELECT(candidateId)`、`HIDE` 或 `RESET`。
- `POST /api/v1/albums/:id/artwork/upload`：管理员以 multipart 上传图片并同时提交 requestId/revision；校验成功后创建 `USER_UPLOAD` 候选并原子选中。
- `POST /api/v1/albums/:id/artwork/import/musicbrainz`：管理员指定当前成员 LocalVersion；仅从其已确认 Release 导入 Cover Art Archive 正面图并原子选中。
- `GET /api/v1/albums/:id/artwork-history`：登录用户读取最近 100 个因果排序事件。
- `POST /api/v1/albums/:id/artwork-history/:eventId/undo`：管理员追加补偿事件，撤销最新且未被后续封面决定覆盖的事件。

`requestId` 对 Album、命令、目标候选/版本、上传源哈希或外部 Release 生成精确指纹。同 requestId 同指纹返回原结果；不同指纹、陈旧 revision、非成员版本、不可用候选或后续状态漂移返回 409，且不改变选择或事件账本。上传/下载产生但未选中的完整资产允许成为孤儿，后续仅由安全 GC 回收。

## 图片安全与外部访问

- 接受 JPEG、PNG、WebP；单文件最多 20 MiB，宽高各最多 12,000 像素，解码像素最多 50 MP。低于 600 像素允许保存但明确标记低清。
- 不信任扩展名和请求 Content-Type；必须检查文件签名并通过真实解码/探测。损坏、多帧异常、超限、零尺寸或 MIME 不一致必须拒绝。
- 上传和外部响应先写同一文件系统的临时文件，校验并计算 SHA-256 后原子 rename；失败清理临时文件。
- Cover Art Archive 只在管理员主动请求时访问；Release ID 必须来自当前 LocalVersion 的 `USER_CONFIRMED` MusicBrainz 证据。限制 HTTPS、超时、重定向次数和响应字节，拒绝私网/本机地址及任意提供 URL。
- 预览只使用同源 `/api/v1/artwork/:hash`；响应设置正确 MIME、`X-Content-Type-Options: nosniff` 和缓存头。

## 身份治理继承

- `SET_PRIMARY`：人工 `SELECTED/HIDDEN` 不变；自动模式按新主版本重新解析，变化时 artworkRevision +1。
- `MERGE`：目标 Album 的人工决定优先；来源与目标存在不同人工决定时整体 409，要求先 RESET 一侧。只有一侧有人工作品决定时继承；自动候选按合并后成员重算。
- `SPLIT`：包含原主版本的分区继承原 Album 人工决定与历史；其他分区从自己的成员自动解析，不复制人工决定。
- 身份 `UNDO`：按不可变账本恢复封面归属并保留此后事件；若会覆盖不同人工决定则 409。
- 别名路由到当前 LibraryAlbum；历史事件通过关联表在合并拆分后仍可追溯。

## 投送与缓存生命周期

- 新投送任务创建时读取当时有效资产，并继续把实际字节、大小、SHA-256 和兼容 `cover.jpg` 冻结进 source bundle。
- 已排队、运行或完成任务不得因后续 SELECT/HIDE/RESET、重扫或身份变化而重读封面。
- 人工隐藏时新任务不包含 `cover.jpg`，但不得删除设备既有目录；现有非空目标的 fail-closed 规则不变。
- 任何被当前选择、观察候选、不可变历史或冻结投送引用的资产都不得 GC。M1.2c 不实现主动 GC，只建立可安全判断引用的模型。

## UI 验收

- 详情 Hero 封面提供“管理封面”入口；默认页面仍以唱片内容为主，不把治理工具常驻成复杂表格。
- 管理面板先显示当前有效封面和“人工选择 / 已隐藏 / 主版本自动 / 代表版本自动”状态，再按“本地候选、MusicBrainz、上传”分区。
- 候选卡展示大图、LocalVersion、嵌入/目录/上传/外部来源、宽×高、文件大小和低清提示；不使用 Hi-Res、DSD 或任何需授权 Logo 表示图片质量。
- 选择前提供大图预览；保存明确提示“仅修改 COCEAN，不写回 NAS”。HIDE 文案为“在 COCEAN 中隐藏封面”，RESET 为“恢复自动选择”。
- MEMBER 可查看候选、来源和历史，但没有选择、隐藏、上传、导入或撤销按钮；Demo 只显示有效封面和只读说明。
- 409 后刷新 artworkRevision 并保留用户当前选中的候选或待上传文件说明；上传字节不在浏览器自动重试，需用户再次确认。

## Gate

- Database：schema 19、有效优先级、独立 revision、问题消解、精确幂等、撤销、重扫、MERGE/SPLIT/SET_PRIMARY/身份撤销。
- Worker：全部本地候选缓存、哈希二次核验、临时文件清理、重复候选和截断排序。
- Server：鉴权、上传边界、真实图片探测、Cover Art Archive 限域下载、400/409、匿名证据隔离和同源 artwork GET。
- Web：候选分区、质量标签、预览、SELECT/HIDE/RESET、上传、外部导入、草稿恢复、只读角色和历史。
- Delivery：有效资产冻结、HIDDEN 无封面、缓存漂移 fail-closed、旧排队任务不变。
- 全仓：`pnpm check`、媒体生成集成、Infra、FNOS 静态/模拟、Compose 合同、格式和 `git diff --check`。
- 真实环境：经单独授权后备份 FNOS 数据库，验证 schema 19、缺失/低清封面治理、重扫保持及 SP3000M 新投送；不得覆盖设备旧目录。

