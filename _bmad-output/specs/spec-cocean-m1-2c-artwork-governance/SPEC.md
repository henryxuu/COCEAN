---
id: SPEC-cocean-m1-2c-artwork-governance
companions:
  - artwork-governance.md
  - ../spec-cocean-m1-2b-field-governance/SPEC.md
  - ../spec-cocean-m1-library-integrity-governance/SPEC.md
  - ../spec-cocean-m1-library-integrity-governance/identity-and-governance.md
sources: []
---

> **Canonical contract.** 本 SPEC 与 `companions:` 是 M1.2c 唱片封面治理的完整实现与验收合同。

# COCEAN M1.2c：唱片封面治理

## Why

唱片身份和字段已经可治理，但缺失、低清或选错版本的封面仍会污染唱片卡、详情页和播放器副本。现有扫描只自动选出一个封面，用户无法比较同一唱片不同本地版本的嵌入图和目录图，也无法安全地选择、隐藏、上传或导入已核验发行版的封面。COCEAN 需要在不写回 NAS、不依赖大模型的前提下，提供可解释、可撤销、重扫不丢失的封面管理。

## Capabilities

- **CAP-1 封面候选与有效封面**
  - **intent:** 用户可以查看本地版本中的不同封面候选、当前有效封面及其来源，并理解自动选择依据。
  - **success:** 详情 API 和页面返回去重后的候选、版本归属、来源、尺寸、文件大小、类型与有效选择；卡片、详情、统计和新投送任务使用同一个有效封面。

- **CAP-2 人工选择、隐藏与恢复自动**
  - **intent:** 管理员可以选择任一可信候选、明确隐藏封面，或恢复系统按主版本自动选择。
  - **success:** `SELECT`、`HIDE`、`RESET` 使用独立 artworkRevision 原子更新；重扫和主版本变化不会覆盖人工决定，恢复自动后立即使用最新确定性候选。

- **CAP-3 上传与已确认发行版导入**
  - **intent:** 管理员可以上传自己的图片，或从已确认的 MusicBrainz Release 导入 Cover Art Archive 正面封面。
  - **success:** 图片在服务端经过真实格式、大小、像素、哈希和解码校验后写入内容寻址缓存并选中；任意 URL、未确认 Release、超限或损坏图片零治理写入。

- **CAP-4 审计、并发与身份继承**
  - **intent:** 管理员可以追溯并撤销封面决定，系统在重试、并发、MERGE、SPLIT 和身份撤销中保持可解释状态。
  - **success:** 每次决定记录 actor、requestId、前后状态与 artworkRevision；精确重试幂等，冲突和陈旧写入 409；身份继承遵循 companion 合同且不丢历史。

- **CAP-5 管理型封面体验**
  - **intent:** 用户在唱片详情即可比较封面质量、来源和版本归属，完成预览与管理，而不会误以为源文件被修改。
  - **success:** 详情页提供统一封面管理面板、候选大图预览、尺寸/来源文本标签、只读角色、错误恢复和历史；不引入 Hi-Res 或其他授权 Logo。

## Constraints

- 资产、选择、优先级、上传、外部导入、审计和身份继承必须遵循 `artwork-governance.md`。
- 有效选择优先级固定为 `USER_SELECTED / USER_HIDDEN > AUTOMATIC_PRIMARY > AUTOMATIC_REPRESENTATIVE > NONE`。
- M1.2c 在 `WATCH_ONLY` 与 `MANAGED` 中均只写 COCEAN 数据库和缓存；不得移动、改名、覆盖、写回或删除 NAS 文件、嵌入图和 sidecar。
- 本地候选读取扫描证据；上传和外部图片只允许写入 COCEAN 内容寻址缓存，必须先完整校验再建立选择。
- 外部导入仅允许已人工确认 MusicBrainz Release 对应的 Cover Art Archive；不接受任意 URL，不自动联网抓图。
- 管理员可写、登录成员只读；匿名只获得有效封面，不获得 actor、历史、候选路径或外部证据。
- identity revision、metadataRevision 与 artworkRevision 必须独立；任一失败不得部分更新选择或审计账本。
- M1.1、M1.2a、M1.2b 的身份、字段、历史、Listen、投送、分页筛选和滚动返回合同不得回归。

## Non-goals

- 不引入 Apple Music、Still 精品曲库或新的图片搜索提供方。
- 不支持任意图片 URL、AI 生成封面、无人审核批量替换或自动下载。
- 不写回音频标签、文件夹封面、目录名、文件名或播放器设备中的既有文件。
- 不实现 booklet、背面、Disc 图的多页画廊；候选可展示这些观察资产，但每张唱片只选择一个有效正面封面。
- 不实现唱片、版本或源文件删除；生命周期治理属于后续 M1.3。

## Success signal

管理员能为一张缺失或低清封面的唱片比较本地候选，选择更合适的版本封面，或从已确认 MusicBrainz Release 导入/上传图片；唱片卡与新播放器投送立即使用新封面，重扫后保持，撤销可恢复，NAS 原文件和既有排队任务不变。

## Assumptions

- Schema 19 为 `LibraryAlbum` 增加独立 artworkRevision，并以 SHA-256 内容寻址资产作为稳定选择对象。
- 真实 FNOS schema 19、真实外部下载及真实播放器再次投送均需在实施完成后单独授权验收。

