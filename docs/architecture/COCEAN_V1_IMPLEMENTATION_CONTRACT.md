# COCEAN v1 实施合同

> 状态：**Frozen for v1 implementation**  
> 合同版本：`1.0.0`  
> 冻结日期：2026-08-12  
> 产品形态：NAS-only、Docker Compose、响应式 Web/H5  
> Figma 文件：[`COCEAN — NAS Web Product Design`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK)  
> 适用范围：产品、设计、Web、API、Worker、Adapter、测试与外部贡献者

## 1. 合同目的与规范词

本合同把已确认的 COCEAN 产品目标和 Figma 设计冻结为 v1 的实施边界。它用于避免以下偏差：

- 把 COCEAN 实现成通用 NAS 文件管理器、下载器或完整播放器；
- 混淆 Album、发行版本、数字文件、实体唱片、外部可得版本和设备投送副本；
- 让大模型替代可追溯的目录事实、文件事实或人工确认；
- 在扫描、刮削、写回、删除和投送之间产生隐含授权；
- 前端自行发明与已批准 Figma 不一致的页面、术语或状态。

本文中的：

- **必须 / MUST**：v1 上线条件，不得省略；
- **应该 / SHOULD**：除非有书面 ADR 说明，否则必须遵循；
- **可以 / MAY**：兼容边界内的可选实现；
- **禁止 / MUST NOT**：任何模块不得绕过。

如本合同与早期方向稿冲突，以本合同为 v1 实施准绳；视觉细节仍以本文映射的 Figma 节点为准。改变冻结项必须同时更新产品文档、ADR、API 合同、测试与本合同版本。

## 2. v1 产品与运行基线

### 2.1 一句话定义

COCEAN 是部署在 NAS 上的私人音乐资源控制台：以 Album 为中心，理解本地数字音乐和实体收藏，承接 Still 推荐，帮助用户找歌、核对发行版本、整理入库，并把经过审核的副本投送到实际播放设备。

### 2.2 v1 必须成立的产品原则

1. **Album-first**：首页、唱片库、找歌和任务最终汇聚到同一 Album 身份。
2. **Private-by-default**：音乐文件、目录、封面、使用状态和凭据默认留在 NAS 与家庭网络中。
3. **Observed before proposed**：先保存文件原始观察，再生成候选；候选不得覆盖原始事实。
4. **Review before write**：扫描和匹配不等于写回；任何文件修改必须经过独立计划、预览和明确执行。
5. **Model-optional**：关闭或无法连接模型时，扫描、目录浏览、结构化找歌、推荐主链路和人工匹配仍必须可用。
6. **Provider-optional**：Qobuz、qobuz-dl、设备 Adapter 或任一外部目录不可用时，不得破坏本地唱片库。
7. **No inferred listening facts**：没有播放器可靠回执时，不显示播放次数、聆听时长或类似推断。

### 2.3 部署边界

v1 必须使用 Docker Compose 作为 NAS 部署合同，不使用 Kubernetes。最少包含以下生命周期边界：

| 部署单元     | 职责                                           | 持久化边界                                                               |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `web`        | Web/PWA 静态资源与同源 `/api` 代理             | 无持久卷、无音乐主库挂载                                                 |
| `server`     | API、页面聚合读模型、设置与任务编排            | SQLite/data、封面 cache；Music 始终只读                                  |
| `worker`     | 扫描、指纹、封面缓存、匹配、变更计划与投送任务 | SQLite/data、cache、隔离区；WATCH_ONLY Music 只读，显式 MANAGED 受控读写 |
| `SQLite WAL` | 身份、资产、提案、用户状态、任务与审计         | FNOS 本机 data 目录；禁止放在 SMB/NFS                                    |
| 可选 Adapter | Qobuz/qobuz-dl、设备协议、目录源               | 独立凭据引用与能力声明                                                   |

观察库必须以只读 Bind Mount 暴露给容器。托管库和可移动目标只能按明确配置授予受控读写权限。容器禁止使用特权模式管理裸磁盘、RAID、文件系统、挂载或格式化。

## 3. 领域身份与事实分层

### 3.1 身份层级

v1 必须保持以下概念可区分，即使首期部分记录只能匹配到较高层级：

| 实体             | 语义                                                        | 例子                  |
| ---------------- | ----------------------------------------------------------- | --------------------- |
| `Person`         | 艺术家、作曲家、指挥、演奏者等人员或团体                    | Sufjan Stevens        |
| `Work`           | 作品身份，古典音乐可包含 Movement                           | Symphony No. 5        |
| `Recording`      | 一次具体录音或演绎                                          | 某年某乐团录音        |
| `Album`          | 面向用户的专辑聚合与编辑入口                                | Carrie & Lowell       |
| `Release`        | 一次发行事件或发行版本族                                    | 2015 original release |
| `Edition`        | 由地区、介质、厂牌、目录号、条码、压片/再版等确定的具体版本 | 2015 US CD edition    |
| `Disc` / `Track` | Edition 中的盘与曲目结构                                    | Disc 1 / Track 3      |

数字文件与实体唱片应优先引用 `Edition`；Edition 未确认时可以暂时引用 Album 或 Release，但必须带匹配状态，不得伪造精确版本。

### 3.2 三层元数据事实

任何刮削与信息匹配必须保留三层互不覆盖的数据：

1. `ObservedFacts`：路径、原始标签、内嵌封面、目录封面、技术参数、文件校验值、音频指纹、读取时间；
2. `MetadataProposal`：候选身份、字段建议、封面候选、来源、冲突与解释；
3. `AppliedSnapshot`：用户批准的字段、应用范围、兼容性 Profile、执行时间、执行结果与回滚材料。

外部目录、规则与模型产生的信息不得直接写入 `ObservedFacts`。应用后的标准化结果不得删除原始观察。

### 3.3 收藏与可达对象

以下对象必须分表或以等价的强类型结构分离：

- `DigitalAsset`：NAS 中实际存在的一个音频文件；
- `DigitalCopy`：由一个或多个 DigitalAsset 组成的 Album/Edition 数字副本；
- `PhysicalCopy`：用户持有的 CD、SACD、黑胶等实体版本；
- `ExternalOffer`：Qobuz 或其他目录中可试听、可购买或可下载的外部版本；
- `DeliveryCopy`：投送到 SP3000M、U 盘、microSD 或网络目标的副本；
- `OwnedDevice`：用户持有、借用、出售或想要的设备；
- `ListeningRig`：设备之间带连接关系的命名系统。

禁止用单一 `ownershipStatus = "本地 + CD"` 表达上述对象。用户是否拥有某张 Album 必须由 DigitalCopy 或 PhysicalCopy 的存在派生；ExternalOffer 和 DeliveryCopy 不得被计入拥有状态。

## 4. v1 模块边界

v1 采用**模块化单体 + 独立 Worker/Adapter**。模块边界是代码、数据写入权、测试和未来插件的边界，不要求拆成微服务。

| 模块                    | 独占写入的数据                                                | 必须提供的能力                                               | 禁止承担                                   |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| `platform`              | 配置引用、Feature Flag、Job、审计、通知、迁移版本             | 任务编排、幂等、重试、凭据引用、健康检查                     | 唱片身份判断、文件内容解析                 |
| `catalog-identity`      | Album/Recording/Release/Edition、目录来源、证据关系           | Still Curated Base、身份解析、版本化目录、候选来源聚合       | 写本地音乐文件、保存模型结论为正式事实     |
| `library-inventory`     | Root、DigitalAsset、DigitalCopy、ObservedFacts、扫描问题      | 只读扫描、标签/封面读取、技术参数、哈希/指纹、缺轨与重复识别 | 修改精品目录、自动写标签或删除文件         |
| `recommendation`        | 推荐运行、算法版本、解释材料、反馈                            | Still 主推荐、确定性过滤/排序、可回放结果                    | 无限 Feed、依赖模型才能产出结果            |
| `discovery-acquisition` | SearchSession、ExternalOffer、AcquisitionPlan/Job             | 找歌、外部版本核对、查重、可选获取与隔离区入库               | 把下载完成视为已入库、把 Cookie 写入业务表 |
| `device-delivery`       | DeviceProfile、DeliveryTarget、DeliveryPlan/Job、DeliveryCopy | 挂载卷/网络目标、空间与差异预览、复制/上传、校验             | 修改观察库、操作裸磁盘、伪造安全弹出结果   |
| `gear-collection`       | GearModel、OwnedDevice、ListeningRig、PhysicalCopy、手工笔记  | 设备持有状态、系统链路、实体版本、理论兼容性                 | 推断音质优劣、推断播放次数                 |
| `web-shell`             | 无领域事实                                                    | 响应式 UI、路由、页面聚合、无障碍与视觉状态                  | 越过 API 直接访问 NAS 路径或 Provider      |

推荐模块内部必须继续区分两条不可混用的执行路径：

- `accepted-runtime`：只消费 Still v0.10 Accepted Runtime Snapshot，执行正式九级硬门槛与冻结权重；
- `verified-catalog-compatibility`：只对有权导入的旧版已核验目录做日期轮换和显式标签检索，
  不生成分数、不推断缺失事实，也不宣称通过 v0.10 Storefront/Binding Gate。

在 Accepted Runtime Snapshot 缺失时，正式路径必须返回 typed unavailable；兼容路径是否可用
不能改变正式路径状态。

### 4.1 跨模块规则

- 模块只能通过版本化应用服务、领域事件或 `packages/contracts` 中的合同交互；禁止跨模块直接更新对方表。
- `catalog-identity` 是正式唱片身份的唯一写入者；`library-inventory` 只保存引用与匹配状态。
- `platform` 是长任务状态的唯一写入者；业务模块保存自己的计划和结果，但不得另造不兼容的通用 Job 状态。
- `device-delivery` 只能读取已审核的标准化元数据，并按 Device Profile 生成交付副本；禁止反向修改观察库。
- `discovery-acquisition` 获得的新候选先进入发现层，不得自动晋升 Still Curated Base。
- 所有 Adapter 必须声明能力、权限、网络目的地、凭据范围、失败语义和测试 Fixture。

## 5. 封面与元数据来源合同

v1 的刮削主链路必须优先使用确定性读取、目录服务和人工判断，不把大模型作为元数据源。

### 5.1 本地观察来源

扫描器至少读取：

1. 音频文件内嵌标签与 Front Cover；
2. Album 目录中的 `cover.*`、`folder.*`、`front.*` 等配置化候选；
3. 文件名、目录名、Disc/Track 结构与曲目时长；
4. 编码、容器、位深、采样率、DSD 倍率、声道与文件大小；
5. 文件校验值与音频内容指纹。

本地来源不因分辨率较高就自动成为正确 Edition 的封面。

### 5.2 外部来源适配

v1 应通过 Provider Adapter 接入目录与封面来源：

- MusicBrainz：公开身份、发行与曲目候选；
- Cover Art Archive：与 MusicBrainz Release 关联的封面候选；
- Discogs：可选的具体实体发行、目录号、条码与封面证据；
- Qobuz：可选的数字发行、地区可用性、试听和音质规格核对。

每个外部字段和封面必须保留 `provider`、外部对象 ID、来源 URL、抓取时间和适用的缓存/授权信息。Provider 不可用时，用户仍能使用本地观察、已有缓存与人工匹配。

### 5.3 封面选择与交付

- COCEAN 必须保留当前封面与候选封面，不得在扫描阶段覆盖；
- 候选必须展示来源、像素、格式及其对应 Edition；
- 用户确认后，高质量原图进入 COCEAN 封面缓存；
- 写入音乐文件或生成设备副本前，按目标 Profile 转为方形、sRGB、Baseline JPEG 等兼容版本；
- Profile 的像素和文件大小限制必须来自设备实测，不得凭经验写死；
- 私人封面不得发送给大模型，也不得使用生成式模型重绘、补全或增强。

## 6. 实体介质与数字规格语义

### 6.1 结构化数字规格

API 必须返回结构化字段，禁止让前端从展示字符串反向解析：

```json
{
  "family": "PCM",
  "codec": "FLAC",
  "container": "FLAC",
  "lossless": true,
  "bitDepth": 24,
  "sampleRateHz": 96000,
  "dsdRate": null,
  "bitrateKbps": null,
  "channels": 2,
  "mixedSpec": false
}
```

约束：

- PCM/DXD 主事实为位深与采样率；
- DSD 主事实为 `DSD64 / DSD128 / DSD256...`，可附 `1-bit / MHz`；
- `kbps` 只作为有损编码的主要码率，或作为次级流量事实；
- `Hi-Res` 是派生分类，不得代替精确数值；
- Album 曲目规格不一致时必须返回 `mixedSpec = true` 或明确“最高规格”，不得把最高值冒充全 Album；
- 本地、外部和投送规格分别属于 DigitalCopy、ExternalOffer、DeliveryCopy，不得复用一个字段。

### 6.2 卡片与详情显示合同

| 场景         | 数字规格                                       | 实体介质                     |
| ------------ | ---------------------------------------------- | ---------------------------- |
| Album Card   | `24/96`、`16/44.1`、`DSD128`、`混合规格`       | `CD`、`SACD`、`黑胶` 标签    |
| Album Detail | `HI-RES · 24-bit / 96 kHz · FLAC`              | “我的版本”内逐个列出 Edition |
| Track/File   | 完整编码、位深、采样率、声道、码率、时长、大小 | 不适用                       |

`TrackSummary.sizeBytes` 必须来自扫描观察到的真实文件大小；Web 将字节值转换为人类可读单位。禁止从路径、码率与时长估算或填入演示值。

纯 `CD` 标签在 v1 UI 中**只表示用户持有的实体 CD**。数字 CD 规格必须显示 `16/44.1`，不能显示为孤立的 `CD`。同理，`SACD` 表示实体介质，数字文件必须显示 `DSD64` 等实际规格。数字 DSD 文件不自动证明用户持有 SACD。

### 6.3 实体唱片字段

`PhysicalCopy` 至少支持：

- `medium`；
- 关联 `editionId`，未确认时关联较高层身份并带匹配状态；
- 厂牌、目录号、条码、地区、发行年、再版/压片信息；
- 数量、品相、购买日期和价格（可选）、存放位置、备注；
- 是否已抓轨、对应 DigitalCopy、抓轨验证状态。

唱片库筛选可以使用 `全部 / 数字 / CD / SACD / 黑胶`。同一 Album 可以命中多个筛选；卡片中无需重复显示“本地”“拥有”或“已核验”。

## 7. 页面与 API 合同

### 7.1 API 通用约束

- 基础路径：`/api/v1`；
- 长任务返回 `202 Accepted` 和 `jobId`；
- 所有可重试写操作必须支持 `Idempotency-Key`；
- 列表使用游标分页，不依赖不稳定的页码；
- 时间使用 ISO 8601 UTC，ID 使用不带业务含义的稳定 ID；
- 错误体至少包含 `code`、`message`、`details`、`requestId`；
- 高风险动作必须先创建 Plan，再独立执行；Plan 必须包含影响对象、目标范围、空间估算、冲突、可恢复方式和过期时间；
- API 不返回 Cookie、Token、API Key、加密材料或完整敏感请求体；
- 页面聚合 API 可以组合多个模块的只读结果，但不得成为领域事实写入者。

### 7.2 页面需求与最小 API

| 页面/路由                             | 页面必须回答                                                                    | 最小 API                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/today`                              | 今天推荐哪张 Album、为什么、我有什么版本、需要处理什么、有什么任务进行中        | `GET /home`、`GET /recommendations/today`、`GET /tasks?scope=active&limit=5`                                                                                           |
| `/library`                            | 我的唱片库有哪些 Album，数字规格和实体介质是什么，有哪些异常                    | `GET /library/albums`、`GET /library/facets`、`POST /library/scan-jobs`                                                                                                |
| `/albums/{albumId}`                   | 这是什么 Album/Release/Edition，我有哪些数字/实体版本，外部和投送状态分别是什么 | `GET /albums/{albumId}`、`GET /albums/{albumId}/tracks`、`GET /albums/{albumId}/copies`                                                                                |
| `/albums/{albumId}/information-match` | 原文件是什么、建议修改什么、来源依据和冲突是什么、应用到哪里                    | `GET /albums/{albumId}/metadata-review`、`POST /albums/{albumId}/candidate-searches`、`POST /albums/{albumId}/metadata-plans`、`POST /metadata-plans/{planId}/execute` |
| `/find`                               | 用户想听什么、系统理解成哪些条件、哪些 Still 候选匹配、是否已有、外部哪里可核对 | `POST /discovery/searches`、`GET /discovery/searches/{searchId}`、`GET /albums/{albumId}/external-offers`                                                              |
| `/settings`                           | 唱片库位置、信息来源、智能辅助、外部服务、投送、外观、系统与备份如何配置        | `GET /settings`、`PATCH /settings`、`GET /integrations`、`PUT /integrations/{provider}`、`POST /integrations/{provider}/connection-tests`                              |
| `/tasks`                              | 扫描、获取、整理和投送当前到哪一步，失败原因与可恢复动作是什么                  | `GET /tasks`、`GET /tasks/{jobId}`、`POST /tasks/{jobId}/retry`、`POST /tasks/{jobId}/cancel`                                                                          |
| `/systems`                            | 我持有哪些设备、如何组成系统、选择的音频路径理论上是否兼容                      | `GET/POST /gear/devices`、`GET/POST /gear/rigs`、`GET /gear/rigs/{rigId}/compatibility`                                                                                |

### 7.3 页面读模型

#### Album Card

必须包含：`albumId`、标题、Artist、发行年、`artworkRef`、数字紧凑规格、实体介质集合、异常标记。禁止返回或渲染“已核验 · 本地 + CD”一类组合文案。

#### Album Detail

必须分区返回：

- Album/Recording/Release/Edition 身份；
- `digitalCopies[]`；
- `physicalCopies[]`；
- `externalOffers[]`；
- `deliveryCopies[]`；
- 曲目与 Disc 结构；
- 信息匹配摘要。

曲目必须按 API 返回的真实 `discNumber` 分组，并显示真实 `trackNumber`；缺失序号时显示“未标记”，不得按数组位置补造 Disc/Track 序号。每轨数字规格与文件大小必须来自结构化字段。

“我的版本”只包括 DigitalCopy 与 PhysicalCopy；ExternalOffer 使用“可获取版本”，DeliveryCopy 使用“已投送至……”。

#### Find Music

搜索请求必须同时支持结构化条件和自然语言描述。结果必须包含：

- Still/目录候选身份和来源；
- 可理解的 `whyThisMatch`；
- 结构化 `interpretedFilters`；
- 本地是否已有以及已有的具体副本；
- 外部可得版本及其独立规格；
- 模型关闭或失败时的降级状态。

#### Listen

主操作文案使用 `Listen`，拼写不得使用 `Lisen`。`Play` 仅用于已经进入播放控件后的播放状态。试听/播放是文件与曲目验证能力，不得扩展为 v1 的完整播放器中心。媒体流接口必须支持授权和 HTTP Range，且不得暴露 NAS 绝对路径。

Home 与 Find Music 的 `Listen` 只有在对应本地 Album 已解析到真实 Track ID 后才能启用。未匹配本地、只有实体记录、无已索引曲目或详情读取失败时，必须禁用并显示具体原因；禁止点击后只用 Toast 冒充播放校验。

### 7.4 已批准的辅助路由

用户已批准 `/tasks` 与 `/systems` 作为 v1 辅助页面继续实施，但两者当前没有冻结的精确页面主体节点。它们必须复用 Foundations `8:51`、已批准的颜色/排版/圆角/间距 token、核心组件与响应式规则；可以形成可用页面，但不得宣称与不存在的 Figma 页面节点逐像素一致。

- `/tasks` 当前只可展示 API 返回的真实 Music 扫描任务。获取、信息匹配、入库、投送、重试或取消尚未接入时，必须显示能力边界或诚实空态，禁止用扫描状态或模板时间线代替；
- `/systems` 当前可以展示真实设备持有记录和 USB/网络投送目标配置。目标配置不得显示成在线、已挂载、可达、已传输或已校验；尚未实现的 Listening Rig、兼容性判断与传输记录必须隐藏或使用诚实空态；
- 新增可执行能力仍必须先具备对应 API、状态语义、失败处理与验收，不因“辅助页面”获得越权实现许可；
- 若页面无法满足上述边界，必须通过 Feature Flag 隐藏入口，不得发布死链接。

## 8. 大模型实施边界

### 8.1 允许的两个场景

#### 找歌辅助

模型可以：

- 把自然语言转换为可见、可编辑的年代、流派、氛围、乐器、场景等结构化条件；
- 在 Still/目录已经召回的候选中辅助排列；
- 基于已有证据生成受约束的推荐解释；
- 生成目录搜索词和同义表达。

#### 信息匹配辅助

模型可以：

- 从混乱的文件名和原始标签中生成搜索词；
- 汇总 Current/Proposed/Evidence 的差异；
- 用自然语言解释目录号、年份、地区、曲目数或封面 Edition 冲突；
- 对既有候选给出审阅顺序。

### 8.2 绝对禁止

模型不得：

- 读取并宣称文件的真实编码、位深、采样率、DSD 倍率、哈希或音频指纹；
- 单独确认 Recording、Release 或 Edition；
- 作为字段或封面的唯一证据来源；
- 把任何记录标记为“来源已匹配”或“用户已确认”；
- 自动写标签、封面、目录，移动、删除、下载或投送文件；
- 生成、增强或上传私人封面；
- 根据设备价格、格式或采样率生成听感优劣结论；
- 暴露模型名、向量、内部 Prompt 或伪精确 AI 分数作为用户决策依据。

### 8.3 降级与可追溯性

- 目录召回和确定性推荐必须先于模型执行；
- 模型输入不得包含绝对 NAS 路径、凭据或原始私人封面；
- 模型输出必须标记为 `MODEL_ASSIST`，只能进入解释或候选层；
- 模型超时、失败或关闭时，API 必须返回基础候选和 `assistUnavailable`，不能把整页变成错误；
- 设置必须允许分别关闭“找歌辅助”和“信息匹配辅助”；
- UI 使用“辅助判断”或“智能辅助”，不建立独立 AI 顶层模块。

## 9. 只读扫描验收合同

扫描是 v1 的首要信任边界。无论 Root 为观察库还是托管库，**扫描动作本身永远只读**；写标签、封面、目录或文件是后续独立 Plan。

### 9.1 权限验收

- 新增音乐根目录默认 `WATCH_ONLY`；
- 观察库容器挂载必须为只读；
- 扫描期间不得创建 sidecar、`.cocean`、临时文件或目录封面；
- 不得执行 rename、move、delete、truncate、chmod、chown 或标签写入；
- 符号链接不得逃逸配置的根目录；
- 缓存、缩略图、指纹和数据库必须写入独立 COCEAN 卷；
- 扫描前后源文件大小、修改时间、音频内容校验值必须一致。

### 9.2 数据验收

每个可读取文件至少形成：

- 规范化但可追溯的相对路径；
- 文件大小、修改时间和稳定文件身份；
- 原始标签快照；
- 内嵌/目录封面候选及来源；
- 编码、容器、位深、采样率或 DSD 倍率、声道、时长；
- 整文件校验值与音频内容指纹/校验身份；
- Disc/Track 序号及 Album 聚合候选；
- 扫描结果或明确的问题代码。

扫描不得调用大模型才能完成上述事实提取。

### 9.3 行为验收

- 对同一未变化目录重复扫描必须幂等，不产生重复资产；
- 新增、修改、缺失和恢复的文件必须被增量识别；
- 单个损坏、无权限或不支持文件不得让整个 Root 失败；
- 取消或 Worker 重启后任务可恢复，最终状态可审计；
- 扫描完成必须给出文件数、Album 候选数、问题数、耗时与未处理原因；
- 外部目录不可用时，本地扫描仍必须成功；
- 日志不得记录凭据、完整敏感请求体或未经缩减的私人路径清单。

### 9.4 Golden Library

合并任何解析器、规则、指纹、标签或封面来源变更前，必须通过固定 Golden Library，至少覆盖：

- 普通流行 Album；
- 多碟、合辑和 Box Set；
- 古典 Work/Movement、Composer、Conductor、Orchestra；
- FLAC、ALAC/AAC、MP3、DSF/DSD；
- 同录音不同发行、同 Album 不同地区/再版；
- 内嵌封面、目录封面、封面冲突和缺封面；
- 混合规格 Album；
- 非拉丁字符、长标题、重复文件、缺轨与损坏文件。

测试必须验证“没有修改任何源文件”，而不只验证扫描结果正确。

## 10. 关键状态枚举

API 枚举使用稳定英文值；中文仅为 UI 映射，前端不得以中文文案作为业务判断。

### 10.1 根目录与扫描

```text
LibraryRootMode = WATCH_ONLY | MANAGED
ScanJobStatus   = QUEUED | RUNNING | COMPLETED | COMPLETED_WITH_WARNINGS | FAILED | CANCELLED
FileState       = NEW | INDEXED | CHANGED | MISSING | UNREADABLE | UNSUPPORTED
```

`MANAGED` 只表示该 Root 可在后续明确计划中写入，不扩大扫描权限。

### 10.2 身份匹配与元数据

```text
MatchStatus     = UNMATCHED | NEEDS_REVIEW | SOURCE_MATCHED | USER_CONFIRMED | TRACKS_INCOMPLETE
ProposalStatus  = DRAFT | REVIEW_REQUIRED | APPROVED | REJECTED | APPLIED | FAILED
MetadataScope   = COCEAN_ONLY | MANAGED_SOURCE | DELIVERY_COPY
EvidenceKind    = OBSERVED | CATALOG | USER | MODEL_ASSIST
```

`MODEL_ASSIST` 永远不能单独把 MatchStatus 推进到 `SOURCE_MATCHED` 或 `USER_CONFIRMED`。

### 10.3 介质、设备与投送

```text
PhysicalMedium  = CD | SACD | VINYL | CASSETTE | BLU_RAY_AUDIO | OTHER
DeviceOwnership = OWNED | BORROWED | SOLD | WISHLIST
DeliveryTarget  = MOUNTED_VOLUME | NETWORK
DeliveryStatus  = PLANNED | PREPARING | COPYING | VERIFYING | VERIFIED |
                  WAITING_SAFE_EJECT | SUCCEEDED | FAILED | CANCELLED
```

`VERIFIED` 表示数据复制与校验完成；它不等于 NAS 已安全卸载。只有 NAS 平台返回真实结果时才能进入已弹出状态；否则 UI 必须提示用户前往 NAS 完成安全弹出。

### 10.4 获取任务与通用任务

```text
AcquisitionStatus = PLANNED | FETCHING | DOWNLOADED | VALIDATING | READY_TO_IMPORT |
                    IMPORTING | SUCCEEDED | FAILED | CANCELLED
JobStatus         = QUEUED | RUNNING | PAUSED | SUCCEEDED | FAILED | CANCELLED
```

`DOWNLOADED` 不等于 `SUCCEEDED`，必须经过完整性、身份、权限和目标路径检查后才能入库。

## 11. Figma 节点映射

以下节点是 v1 已冻结页面和核心组件的视觉真相源。实现应复用对应语义、信息层级、Light/Dark 模式与组件，不得只凭截图近似重建。

### 11.1 页面

| 页面                      | System Light                                                                     | System Dark                                                                      |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Home Desktop              | [`38:2`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=38-2)       | [`38:108`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=38-108)   |
| Home Mobile H5            | [`39:2`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=39-2)       | [`39:54`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=39-54)     |
| Library Desktop           | [`62:18`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=62-18)     | [`62:896`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=62-896)   |
| Album Detail Desktop      | [`62:1155`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=62-1155) | [`62:1290`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=62-1290) |
| Information Match Desktop | [`64:125`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=64-125)   | [`65:1226`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=65-1226) |
| Find Music Desktop        | [`68:13`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=68-13)     | [`68:1584`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=68-1584) |
| Settings Desktop          | [`69:13`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=69-13)     | [`71:100`](https://www.figma.com/design/xTAOVAiFaO9wgqeIqONeNK?node-id=71-100)   |

### 11.2 核心组件

| 组件                  | Node ID  | 实施用途                                         |
| --------------------- | -------- | ------------------------------------------------ |
| Brand Lockup          | `11:8`   | Still v0.10 标志与 COCEAN 字标                   |
| Audio Spec Badge      | `14:18`  | 数字规格，不承担实体介质语义                     |
| Verification Status   | `16:26`  | 信息匹配上下文，不在普通卡片显示正向状态         |
| Button                | `16:62`  | v0.10 full-pill 主次操作                         |
| Navigation Item       | `17:30`  | 桌面/移动导航语义基础                            |
| Library Health Metric | `18:22`  | “需要处理”摘要                                   |
| Task Timeline Row     | `19:62`  | 长任务阶段、失败与恢复动作                       |
| Metadata Diff Row     | `22:86`  | 原文件 / 建议修改 / 来源依据                     |
| Delivery Target Card  | `24:86`  | 挂载卷与网络目标                                 |
| Album Hero            | `36:71`  | Album-first 主视觉与 `Listen`                    |
| Media Tag             | `51:237` | `CD / SACD / 黑胶` 实体介质标签                  |
| Album Card            | `54:13`  | 唱片库、找歌结果的 Album 复用单元                |
| Desktop Sidebar       | `58:961` | 今日、唱片库、找歌、我的系统、任务；设置固定左下 |

### 11.3 实施约束

- 设计系统 Foundations 以节点 `8:51` 为准；
- 主字体为 Noto Sans SC；Dark 使用暖黑与奶油文字，不改成纯黑白；
- 主操作使用 full-pill；Album artwork 是主要内容色，不新增固定品牌强调色；
- 设置必须位于桌面侧栏左下，NAS 状态保持更低层辅助信息；
- 导航使用“找歌”，不恢复为含义重叠的“发现”；
- 首页与卡片不得出现“已核验 · 本地 + CD”或“试听核验”；
- `Listen` 是入口动作，`Play` 只表示播放器状态；
- 当前只有 Home 有冻结的 Mobile H5 页面。其他移动页面在获得批准的 Figma 节点前，不得擅自把桌面并排信息简单缩小；可以通过 Feature Flag 限制入口。
- 未冻结精确 Mobile 节点的已批准页面可以做可访问性的响应式降级：窄屏必须单列、保留数字规格/实体介质/真实状态和至少 44px 的关键触控目标。该降级只代表可用性适配，不得宣称通过精确 Figma Mobile 视觉验收，也不得隐藏关键事实来换取版面。

## 12. 安全与审计底线

- 凭据必须由平台凭据存储管理，领域表只保存引用；
- Cookie、Token、API Key 不得进入普通日志、任务参数、浏览器持久存储或导出文件；
- 下载、写回、移动、删除和投送必须写审计事件，并关联发起人、Plan、目标、结果和恢复材料；
- 删除默认进入隔离区，除非用户在独立高风险流程中明确永久删除；
- Qobuz/qobuz-dl 作为可替换 Adapter，不是核心数据库或授权中心；
- 只有用户确认具备合法使用权的内容才能进入永久音乐库；
- Web 不直接访问客户端磁盘、NAS 裸设备或挂载 API。

## 13. v1 明确不做

1. Windows/macOS Companion、第二套本地服务端或桌面安装包；
2. Roon Server、Roon Ready 播放端、DSP、完整在线播放服务或播放器中心；
3. 无限推荐流、排行榜门户、社交 Feed、公共用户主页或多租户；
4. Kubernetes、复杂微服务拆分或跨模块共享数据库写入；
5. 自动修改观察库，或把扫描、匹配当作写回授权；
6. 无人审核的批量标签、封面、目录修改、覆盖、移动或永久删除；
7. 用模型确认发行事实、生成封面、评价器材声音或执行文件操作；
8. 在没有播放器可靠回执时生成播放次数、聆听时长或使用排行；
9. 把 Qobuz 可用规格、本地文件规格和设备投送规格合并成一个“最佳音质”；
10. 自动获取或永久保存用户无合法使用权的流媒体内容；
11. 同时适配所有 NAS、播放器、标签格式和设备协议；
12. 支持只暴露 MTP、必须安装桌面驱动或厂商专用软件的设备连接；
13. 由 Docker 容器格式化、挂载、卸载或管理裸磁盘；
14. 根据采样率、位深、DSD 倍率或器材价格推断主观音质；
15. 在缺少批准 Figma 时上线空页面、死导航或自行发明核心交互；7.4 已批准辅助页面的诚实数据展示与空态除外，但不得冒充精确 Figma 节点。

## 14. v1 完成判定

v1 只有同时满足以下条件才可标记完成：

- 本合同中的模块写入边界有代码结构和自动测试约束；
- 观察库只读扫描通过 Golden Library，且证明源文件零修改；
- 模型和所有可选 Provider 关闭时，本地库、目录浏览、Still 主推荐和人工匹配可运行；
- 数字规格、实体介质、外部版本与投送副本在 API 和 UI 中保持分离；
- 已冻结页面通过对应 Figma Light/Dark 视觉验收；
- 所有高风险动作经过 Plan、预览、幂等执行、审计和可恢复验证；
- SP3000M 或挂载卷至少有一条真实 Fixture 完成“计划—生成副本—复制/上传—校验”的闭环；
- `/tasks` 与 `/systems` 满足 7.4 的辅助页面边界；任何未实现能力均为诚实空态或被 Feature Flag 安全隐藏，且不宣称具备精确页面节点视觉验收；
- 安全检查确认日志、数据库和浏览器不泄露 Cookie、Token、API Key 与完整敏感请求体。
