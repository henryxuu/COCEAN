# Manifest 与状态机合同

## 期望清单

`DeviceDesiredAlbum` 以 `(targetId, libraryAlbumId)` 唯一，包含 `selectionMode=FOLLOW_PRIMARY|PINNED_VERSION`、可空 pinnedLocalVersionId、加入时间与 actor。清单以 `DeviceDesiredRevision` 乐观并发控制；批量增删命令携带 requestId 与 expected revision，精确重放返回同结果，不同输入复用 requestId 返回冲突。

移出 slot 不产生设备删除动作。Album 合并、拆分、主版本变化或版本不可用时，系统保留清单事件并产生待确认问题，不静默改写固定选择。

## 设备 Inventory 与差异

只读 inventory 冻结 target 身份、profile、采集时间、目录/文件相对路径、size、可获得的 mtime/hash、COCEAN receipt 及整体 digest。无法证明文件与 COCEAN receipt 一致时不得归类为 `SATISFIED`。

差异类型固定为：

- `ADD`：期望 bundle 的稳定目标目录不存在。
- `UPDATE`：期望版本变化且可写入新的内容寻址目录；旧目录成为 `EXTRA_PRESERVED`。
- `SATISFIED`：冻结源 manifest 与设备现状、receipt/验证事实一致。
- `CONFLICT`：期望目标被不明或不同内容占用、profile/凭据/身份不一致。
- `EXTRA_PRESERVED`：设备存在但不属于当前期望 manifest 的内容；永不生成删除 item。

## SyncPlan

`DeviceSyncPlan` 冻结 target/profile、desired revision、inventory digest、计划 hash、汇总与 actor。每个 `DeviceSyncItem` 冻结 Album、解析后的 LocalVersion、source bundle、兼容封面、目标目录、文件 size/SHA、差异类型、blockers 与结果；manifest 和事件 append-only。

状态：`PREVIEWED → QUEUED → RUNNING → SUCCEEDED`；预览/排队可取消。已知 blocker 使计划不可确认。运行时漂移停止后续 item 并进入 `RECOVERY_REQUIRED`；已完成并校验的 Album 不回滚、不删除，重试必须基于新 inventory 创建新的差异预览，仅执行未满足项。

Runner 按 Album 顺序处理，每张 Album 沿用冻结副本、organized-v2、非空目录失败关闭、FTP 回读/校验和 9/9 等既有投送规则。计划成功要求全部 ADD/UPDATE item verified；`EXTRA_PRESERVED` 只记录数量和摘要。

## API 与 Web

- `GET/PUT /api/v1/delivery-targets/:targetId/desired-albums`：读取或按 expected revision 批量修改清单。
- `POST /api/v1/delivery-targets/:targetId/inventory`：ADMIN 启动只读设备 inventory；GET 读取新鲜度与 digest。
- `POST /api/v1/delivery-targets/:targetId/sync-plans`：ADMIN 创建预览；`POST /sync-plans/:id/{confirm,cancel,retry}` 管理执行。
- `GET /api/v1/sync-plans` 与 `GET /:id`：角色安全任务视图。

Library 支持跨页选择并选择目标，“加入待同步”只更新清单；Album 详情同样只加入/移出 slot。任务页集中显示目标期望数、inventory 新鲜度、差异预览、冲突、确认、总体与逐 Album 进度。Systems 页面只管理 target、凭据状态和 inventory，不直接传输。

MEMBER 只见目标显示名、期望/完成数量、状态、时间和脱敏错误；不含凭据、绝对路径、完整 manifest、哈希、actor 或内部 revision。
