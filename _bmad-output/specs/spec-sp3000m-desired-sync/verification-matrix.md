# 验收与回退矩阵

| 层级 | 必须验证 |
|---|---|
| Contracts | desired commands/revision、selection mode、inventory、diff、plan/item、状态、稳定错误与角色安全读视图 |
| Migration/DB | target+Album 唯一；批量幂等/409；事件与 manifest append-only；旧 delivery jobs 不变；重开库一致 |
| Server | Library/Album 只改清单；inventory 新鲜度；预览零传输；确认/取消/重试；ADMIN/MEMBER/匿名 |
| Delivery Runner | 冻结 source/cover/target/profile；organized-v2；目录占用；重启恢复；FTP 回读；逐 Album verified |
| Web | 跨页多选、Album slot、目标选择、Tasks 差异与确认、Systems inventory；错误/空态/窄屏/键盘/草稿保持 |
| 集成 | FOLLOW_PRIMARY/PINNED、同名 Album、多碟、APE→FLAC、FLAC metadata、DSD fail-closed、8+cover=9/9 |
| 真实设备 | SP3000M before/after manifest、额外内容完全保留、只新增计划内容、路径分类正确、断线/重连/重试可解释 |

## 必测场景

- 清单批量增加、重复增加、移出、不同行为复用 requestId、revision 并发、Album 合并/拆分与版本消失。
- 设备离线、凭据缺失、inventory 过期、target/profile 变化、设备内容在预览后漂移。
- ADD、内容寻址 UPDATE、SATISFIED、CONFLICT、EXTRA_PRESERVED 混合计划；确认前不得有 FTP 写入。
- 同名目录、非空旧目录、路径截断/Unicode、多碟、封面缺失、源 SHA 漂移、等长远端损坏、重启中断。
- 后续清单变化不改变已冻结计划；失败停止后续 item，已 verified Album 不覆盖、不回滚。
- MEMBER 写操作 403、匿名 401；API、日志和报告不含凭据、绝对设备路径、哈希或完整私人清单。

## 真实验收 Gate

1. 使用不可变 Git commit、三核心同标签镜像与可验证数据库备份；schema/integrity/外键通过。
2. Music 始终 WATCH_ONLY/只读，先生成 NAS 与 SP3000M before manifest。
3. 首轮只选择独立 QA Album 集合；预览人工核对无 DELETE，明确确认后执行。
4. after manifest 证明设备额外 entries/digest 子集保持、计划文件数量/字节/目录与 verified receipt 一致。
5. 失败保留日志、inventory、manifest、旧镜像与数据库，不自动恢复或清理设备；回退只停止新计划并恢复应用/数据库版本。
