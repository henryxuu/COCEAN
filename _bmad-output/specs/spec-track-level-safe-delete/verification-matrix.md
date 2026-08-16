# 验收与回退矩阵

| 层级 | 必须验证 |
|---|---|
| Contracts | 命令、状态、blocker、角色安全读视图、稳定错误码与 UTC 时间 |
| Migration/DB | 升级保留旧账本；事件 append-only；requestId 幂等/冲突；revision 并发；移动/恢复投影与定向 Album 重建 |
| Server | ADMIN/MEMBER/匿名；预览零写入；确认、取消、重试、恢复；WATCH_ONLY/活动任务/最后一曲/不可分割资产拒绝 |
| Worker | realpath 与符号链接边界；源/目标漂移；双端存在/缺失；哈希复验；中断重启；无覆盖与无部分成功 |
| Web | Album 曲目动作、预览确认、任务结果、最近删除、恢复、错误/空态、窄屏 44px、键盘焦点及草稿保持 |
| 集成 | 移动后曲数/主版本/问题/封面/投送事实正确；恢复后原路径与 SHA 一致；其他版本和共享附件不变 |
| 真实 QA | 仅独立 MANAGED fixture；before/after 清单、数据库完整性、日志与回退证据齐全；生产 Music/SP3000M 零写入 |

## 必测负例

- WATCH_ONLY、只读挂载、root 身份变化、越界路径、symlink/硬链接不确定性。
- CUE 整轨、共享文件、多文件 Track、最后一首可播放文件、活动扫描/投送/Album lifecycle。
- 预览后 size/mtime/SHA/revision 漂移，目标占用，源丢失，双端存在，跨文件系统非原子移动。
- 相同 requestId 精确重放返回同结果；不同输入复用 requestId 返回冲突且零副作用。
- MEMBER 写操作 403、匿名 401；响应与日志不含凭据、路径、哈希或 actor。

## 发布与回退

- 使用新 schema 与不可变镜像标签；升级前备份数据库，验证 integrity/外键与 Music 只读挂载。
- 首次发布保持功能开关关闭，只在 MANAGED QA Root 完成全部矩阵后开放。
- 失败时停止新计划、保留账本和现场，回退镜像/数据库；不得自动移动现场文件或清空最近删除。
