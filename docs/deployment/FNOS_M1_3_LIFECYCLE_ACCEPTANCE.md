# COCEAN M1.3 真实 FNOS 生命周期验收

本文只定义经管理员另行授权后的执行顺序。未获得授权时不得运行 schema 20 升级、
不得把现有 Music 主库改为 MANAGED，也不得创建真实隔离或恢复任务。

## 验收结论需要同时证明

1. 生产栈升级到 schema 20 后仍保持 `WATCH_ONLY`，Music 主库前后清单不变。
2. 独立 QA 栈的 MANAGED Root 可以完成预览、确认、隔离、恢复和重扫闭环。
3. 目标占用、事实漂移、活动扫描/投送、符号链接和双端存在均失败关闭。
4. 隐藏状态、Album ID、字段、封面、身份历史和投送历史在重扫后保持。
5. 永久删除、自动清理和设备副本删除始终没有入口或后台任务。

## 为什么使用双栈

生产栈只负责证明 schema 19→20 升级和默认只读边界。首次文件写验收另起临时
`cocean-m1-3-qa` Compose Project，使用独立端口、数据库、缓存、Music、quarantine、
inbox 和 delivery。这样即使 QA 失败，也不会把首次 MANAGED 写操作落到真实主库。

## 阶段 A：只读盘点

- 记录目标 commit、不可变镜像标签、FNOS/Docker/Compose 版本和当前容器健康状态。
- 对生产 data 使用 `db-maintenance` 创建并复核 SQLite online backup。
- 使用 `music-manifest snapshot` 保存生产 Music 主库清单；单独保存设备目录清单。
- 验证当前 schema、`PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`。
- 展开生产 Compose，确认 Server Music 为只读，Worker 在 WATCH_ONLY 下也为只读。
- 所有凭据只通过既有 secret/交互通道使用，不进入命令参数、日志或验收报告。

任一证据缺失即停止，不部署、不恢复、不删除现场。

## 阶段 B：生产栈 schema 20 升级

- 生产 `.env` 必须继续使用：
  - `COCEAN_MUSIC_ROOT_POLICY=WATCH_ONLY`
  - `COCEAN_MUSIC_READ_ONLY=true`
- 运行正式 `fnos_acceptance.sh`，由 runner 负责备份、部署、健康检查、API Gate 与
  Music before/after manifest 验证。
- 升级后确认 schema=20、integrity=ok、foreign_keys=0，核心容器使用目标不可变标签。
- 在 Web 中验证隐藏/恢复显示状态；不得创建文件隔离计划。

生产 Music manifest 不一致时立即停止核心服务，保留备份、旧镜像、日志和现场；
未经再次授权不得自动恢复数据库或修改 Music。

## 阶段 C：创建独立 MANAGED QA 栈

- 使用新的 `COMPOSE_PROJECT_NAME=cocean-m1-3-qa` 和未占用的 Web 端口。
- 六个 QA 目录全部新建且与生产目录互不包含：Music、quarantine、data、cache、
  inbox、delivery；管理员 secret 也独立。
- QA `.env` 必须显式使用：
  - `COCEAN_MUSIC_ROOT_POLICY=MANAGED`
  - `COCEAN_MUSIC_READ_ONLY=false`
- 只复制可公开重建的测试专辑到 QA Music；不复制生产数据库或私人播放历史。
- 对测试专辑记录路径、大小、mtime、SHA-256、标签和封面基线。
- `fnos_preflight.sh` 必须证明 QA Music 对配置 PUID/PGID 可写、quarantine 独立可写。

## 阶段 D：正向隔离与恢复

1. 扫描 QA Music，记录稳定 Album ID、LocalVersion ID、字段、封面和身份历史。
2. 在详情页生成隔离预览，核对 Root、文件数、总字节数和逐文件冻结证据。
3. 二次确认后等待任务成功；核对源文件消失、隔离文件存在且 SHA-256 全部相同。
4. 确认隔离区、任务账本和逐文件状态一致，QA 以外目录无变化。
5. 从隔离区生成恢复预览并确认；核对原路径恢复、隔离副本消失且哈希相同。
6. 等待增量对账，确认 Album ID、字段、封面、版本关系和审计历史保持。

## 阶段 E：失败关闭矩阵

每个场景使用新的测试副本或先恢复干净基线，禁止在同一失败现场叠加试验。

- WATCH_ONLY：改用只读 QA 栈，只允许预览阻塞，源文件零变化。
- 目标占用：在计划目标放置未知文件，任务不得覆盖或合并。
- 预览后漂移：修改源文件，确认/执行必须因大小或 SHA-256 漂移停止。
- 活动任务：制造活动扫描或投送，隔离与新投送必须互斥。
- Worker 中断：在复制后中断并重启，只能按冻结事实续跑或进入
  `RECOVERY_REQUIRED`；人工修复后使用“重新核验”。
- 双端存在、双端缺失、符号链接或特殊文件：保留现场并失败关闭。

## 阶段 F：收口

- 再次验证生产 Music 与设备目录 manifest 完全不变。
- 导出 QA 计划、事件、逐文件状态、schema/integrity/外键和容器健康证据。
- 停止并保留 QA 栈现场，直到用户确认验收结论；不得自动删除 QA 隔离文件。
- 只有用户明确授权后才能清理 QA 容器、目录或镜像。
- 生产栈继续保持 WATCH_ONLY；是否把任何真实 Root 改为 MANAGED 是新的独立决策。

## PASS 条件

只有阶段 A–F 全部有可复核证据、生产与设备 manifest 不变、QA 隔离/恢复哈希闭环
成立、失败矩阵均未覆盖未知内容，才能标记真实 FNOS M1.3 验收通过。
