# M1.2b 字段治理合同

## 字段作用域与校验

| 作用域 | 字段 | 允许值 | 显式清空 |
| --- | --- | --- | --- |
| `LibraryAlbum` | `title` | 去首尾空白后 1–300 字符，无控制字符 | 不允许 |
| `LibraryAlbum` | `albumArtist` | 去首尾空白后 1–300 字符，无控制字符 | 不允许 |
| `LibraryAlbum` | `year` | 整数 1000 至当前年 + 1 | 允许 |
| `LocalVersion` | `label` | 最多 300 字符，无控制字符 | 允许 |
| `LocalVersion` | `catalogNumber` | 最多 100 字符，无控制字符 | 允许 |
| `LocalVersion` | `barcode` | 8、12、13 或 14 位数字 | 允许 |
| `LocalVersion` | `country` | 两位大写国家码 | 允许 |
| `LocalVersion` | `releaseDate` | `YYYY`、`YYYY-MM` 或有效 `YYYY-MM-DD` | 允许 |

覆盖记录存在且值为 `null` 表示显式清空；删除覆盖记录表示恢复到下一优先级。标题和专辑艺术家不能显式清空。输入按 Unicode 文本保存，不进行会改变用户拼写的自动规范化。

## 值来源与有效值

每个字段返回以下结构：

- `observed`：扫描标签或路径回退值，含 `OBSERVED_TAG` 或 `PATH_FALLBACK` 来源与 LocalVersion 证据。
- `confirmedExternal`：用户从现有信息匹配候选确认的值，含提供方、候选 ID 和确认时间。
- `userOverride`：管理员直接写入的值或显式 `null`，含 actor 和更新时间。
- `effectiveValue` 与 `effectiveSource`：按固定优先级解析后的唯一结果。

信息匹配确认只写 `CONFIRMED_EXTERNAL` 层，不再用 `COALESCE` 修改扫描观察列。已有已确认匹配继续可读，并在迁移后产生等价的外部确认值。

## 写入合同

- `PATCH /api/v1/albums/:id/metadata`：管理员提交 `requestId`、`expectedMetadataRevision` 与一至多个字段命令；字段命令为 `SET(value)`、`CLEAR` 或 `RESET`。
- `GET /api/v1/albums/:id/metadata-history`：登录用户读取按因果顺序返回的最近 100 个事件。
- `POST /api/v1/albums/:id/metadata-history/:eventId/undo`：管理员撤销最新且未被后续元数据事件覆盖的事件。
- API 解析当前 ID、LocalVersion ID 和历史别名到稳定 `LibraryAlbum`，但版本级字段必须验证目标仍是当前成员。
- 一个请求内的全部命令共用一次 metadataRevision 递增和一条审计事件；任一命令无效则整个事务回滚。

`requestId` 对完整规范化命令生成精确指纹。同 requestId 与同指纹返回原结果；同 requestId 不同指纹返回 409。撤销追加补偿事件，不更新或删除既有账本行。

## 身份治理继承

- `SET_PRIMARY`：唱片级人工覆盖不变；未覆盖字段从新主版本重新解析观察值。版本级覆盖随 LocalVersion 保持。
- `MERGE`：目标唱片级人工覆盖保留；来源与目标同字段存在不同人工值时拒绝合并并要求先处理冲突；版本级覆盖随成员并入。外部确认值只在无冲突时合并。
- `SPLIT`：原主版本分区继承原唱片级人工覆盖；新分区仅继承能由其成员观察事实支持且没有冲突的已确认外部值，默认不复制唱片级人工覆盖；版本级覆盖随成员移动。
- `UNDO` 身份决定：按账本 before state 恢复字段归属，不丢弃此后新增的字段事件；若无法无冲突恢复则拒绝。
- 暂时消失的人工 LocalVersion 保留版本级覆盖；重新出现后按稳定 ID 恢复。

## 问题与读取语义

- 扫描仍生成不可变的 `MISSING_IDENTITY`、`BROKEN_TEXT` 等观察证据。
- 如果对应有效标题和专辑艺术家非空且无乱码，则相关问题标记为 `RESOLVED_BY_METADATA`，不进入待处理数量和默认问题筛选。
- 清除或重置覆盖导致异常重新成为有效值时，问题自动回到待处理状态。
- 唱片列表、详情标题、搜索、排序、投送目录与播放器副本标签读取有效字段；源文件路径、哈希和观察标签始终读取扫描事实。
- 投送任务在排队时继续冻结当时的有效字段，后续字段修改不改变已排队任务。

## UI 验收

- 详情页新增“元数据”治理区，先显示有效标题、专辑艺术家和年份，再按 LocalVersion 显示发行字段。
- 每行同时呈现有效值、来源和观察值；仅存在差异时展开候选与历史，避免默认信息过载。
- 管理员编辑使用明确的“保存修改”“清空有效值”“恢复扫描值”文案；保存前显示将修改的字段数且说明仅改 COCEAN 数据库。
- 输入校验在本地即时提示，服务端仍执行同一规则；409 后刷新最新 metadataRevision，同时保留未提交草稿。
- 成员可查看来源与历史但没有编辑、清空、恢复或撤销按钮；Demo 显示只读说明。

## Gate

- Database：schema 18 迁移、有效值优先级、显式 null、幂等/冲突、撤销、重扫、MERGE/SPLIT/SET_PRIMARY 继承。
- Server：登录读取、ADMIN 写入、MEMBER 拒绝、400/409、事务零部分写入、信息匹配改写。
- Web：字段来源、作用域、表单校验、草稿保持、只读角色、历史与撤销、真实页面 wiring。
- 全仓：`pnpm check`、媒体生成集成、FNOS 静态/模拟、Compose 合同与 `git diff --check`。
- 真实 FNOS：先备份数据库；验证 schema 18、一个空白/异常字段修订、重扫保持、撤销恢复和 Music 清单不变。未经用户再次授权不执行任何源文件写操作。
