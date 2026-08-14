---
title: "M1.2c 唱片封面治理"
type: "feature"
created: "2026-08-14"
status: "done"
review_loop_iteration: 1
baseline_commit: "d6dd0a9e7d43a9a72c79bf57a716a21b8240eca9"
context:
  - "{project-root}/_bmad-output/specs/spec-cocean-m1-2c-artwork-governance/SPEC.md"
  - "{project-root}/_bmad-output/specs/spec-cocean-m1-2c-artwork-governance/artwork-governance.md"
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 缺失、低清或选错版本的封面仍污染唱片卡、详情和播放器副本；用户无法比较本地候选，也无法安全上传或导入已确认发行版封面。

**Approach:** 建立内容寻址封面资产、候选证据、独立 artworkRevision 与不可变决定账本；提供 SELECT/HIDE/RESET、上传和 MusicBrainz CAA 导入，并保持 NAS 只读和投送字节冻结。

## Boundaries & Constraints

**Always:** 本地观察、管理员上传、已确认 MusicBrainz Release 的 CAA；ADMIN 写、登录成员读；匿名只见有效封面；重扫/身份治理不丢人工选择；新任务冻结字节。

**Ask First:** 真实 FNOS schema 19；真实 CAA 下载；真实 SP3000M 再投送；Apple Music/Still 图片源；任意 URL；改变删除与 GC 语义。

**Never:** 写回或删除 NAS/嵌入图/sidecar；覆盖设备旧目录；AI 定版；自动抓图；把 artworkRevision 与身份/字段 revision 合并。

## I/O & Edge-Case Matrix

| Scenario      | Input / State            | Expected Output / Behavior           | Error Handling                                |
| ------------- | ------------------------ | ------------------------------------ | --------------------------------------------- |
| 本地选择      | 当前候选 + revision      | 选择哈希稳定生效并审计               | 候选漂移、陈旧 revision、异指纹 requestId 409 |
| 隐藏/恢复     | HIDE 或 RESET            | HIDE 返回 NONE；RESET 立即确定性回退 | 多步骤事务失败零部分写入                      |
| 上传/导入     | 合法图片或已确认 Release | 校验、原子缓存并选择                 | 超限、损坏、未确认、任意 URL 拒绝             |
| 重扫/身份变化 | 人工或自动模式           | 人工保持；自动重算；MERGE 冲突拒绝   | 历史和冻结任务不丢失                          |

</frozen-after-approval>

## Code Map

- `packages/database/src/migrations.ts` -- schema 19、资产/候选/选择/事件账本与问题状态。
- `packages/database/src/client.ts` -- 有效解析、决定、撤销、重扫与身份继承。
- `packages/contracts/src/library.ts` -- artwork 治理合同、命令、事件和候选。
- `apps/worker/src/artwork-cache.ts` -- 全部观察候选内容寻址缓存与哈希复验。
- `apps/server/src/artwork.ts` -- 上传/CAA 字节边界、真实解码、来源限制与内容寻址落盘。
- `apps/server/src/app.ts` -- 读取/选择/上传/CAA/历史 API 与同源资产响应。
- `apps/server/src/delivery.ts` -- 复用有效资产并保持 source bundle 冻结。
- `apps/web/src/pages/album-detail.tsx` -- 封面管理面板、候选、预览、历史和角色。

## Tasks & Acceptance

**Execution:**

- [x] Schema 19、合同与数据库封面领域模型。
- [x] Worker 全候选缓存、确定性排序与重扫关联。
- [x] Server SELECT/HIDE/RESET、上传、CAA、历史/撤销与安全边界。
- [x] Web 管理面板、预览、质量标签、只读角色与冲突恢复。
- [x] Delivery/问题统计/匿名隔离/身份继承回归与完整 Gate。

**Acceptance Criteria:**

- Given 缺失或低清封面，when 管理员选择本地候选、上传或导入已确认发行版，then 卡片与新投送使用同一有效资产，源文件不变。
- Given 人工决定后重扫、选主或身份变化，when 状态可无冲突继承，then 人工决定与历史保持；否则整体 409。
- Given 上传/外部响应不可信，when 格式、尺寸、地址或哈希不满足合同，then 不建立选择且不留下半成品。

## Spec Change Log

- 2026-08-14：实现 schema 19、内容寻址资产/候选/选择/事件账本、独立 revision、重扫及 MERGE/SPLIT/UNDO 继承；未改变批准后的意图和边界。
- 2026-08-14：增加受控 multipart 上传与 CAA front-1200 导入；真实解码、MIME/尺寸/像素/字节、HTTPS/域名/重定向/响应上限均 fail-closed。
- 2026-08-14：详情页增加有效封面、本地/CAA/上传候选、质量事实、ADMIN 操作、MEMBER 只读和历史撤销；未引入 Hi-Res 或任何授权 Logo。

## Design Notes

内容哈希是资产身份，候选只保存来源证据，选择只指向资产或 HIDDEN。M1.2c 不主动 GC，先保证历史与冻结投送引用永不被回收。

## Verification

- Database 59/59、Worker 73/73、Server 55/55、Web 56/56；真实 ffmpeg/ffprobe 图片解码测试通过。
- `pnpm check` 通过：类型检查、全仓测试与生产构建成功；默认媒体套件的 10 项生成 fixture 测试按设计 skipped。
- 媒体生成集成 10/10、Infra 静态/模拟 Gate、FNOS Compose 7 服务合同、Prettier 与 `git diff --check` 通过。
- 真实 FNOS schema 19、真实 CAA 下载与真实 SP3000M 再投送未执行，严格保留为另行授权项。
