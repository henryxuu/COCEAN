# Still 精品目录的本地导入

COCEAN 的推荐核心与内容数据分开发布。算法代码可以开源，但当前 Still iOS 仓库中的
精品目录没有声明可随 COCEAN 重新分发的许可证，因此仓库不会复制或提交该数据文件。
拥有 Still 数据使用权的部署者，可以在本地生成最小运行包。

## 当前可用适配器

当前适配器读取 Still `still.local-curated-catalog` 0.8 格式，只保留：

- 稳定 Album 身份、标题和主要艺术家；
- Recording / Release Family；
- 已审阅的 Domain 与音乐特征 ID；
- 最小来源定位、核验时间与内容版本。

它不会复制音频、Preview、封面、歌词、Apple 编辑文案或第三方评论。只有同时满足
`verificationStatus=verified`、`editorialStatus=accepted` 的 Album 才进入运行包。

本机现有 Still Core `v0.81-core-starter.1` 已通过转换验证：410 条输入全部合格。
这证明 0.81 Core 兼容导入可用，不代表尚未产生 Accepted Runtime Snapshot 的
Still Catalog 2.0 / v0.10 数据已经完成。

## 生成运行包

输出文件必须是不存在的新路径，脚本不会覆盖已有文件：

```bash
pnpm catalog:prepare -- \
  --input "/path/to/core_curated_set.v0.8.json" \
  --output "/path/to/cocean/data/still-catalog.next.json"
```

脚本会验证记录数、稳定 ID 唯一性、接受状态，并为规范化运行内容生成 SHA-256。
将审核后的文件原子替换为 data 目录中的 `still-catalog.json`，然后重启 Server，或调用：

```text
POST /api/v1/catalog/reload
```

Server 只从部署时固定的 `COCEAN_STILL_CATALOG_PATH` 读取文件。非法结构、记录数漂移、
重复 ID 或校验和不一致都会拒绝加载；SQLite 中已激活的旧版本仍保留，不会被半成品覆盖。

目录状态可通过 `GET /api/v1/catalog/status` 核对，包括配置路径、文件可读性、活动版本、
记录数、运行校验和、安装时间和最近加载错误。

## 推荐呈现边界

导入上述运行包后，`GET /api/v1/recommendations/today` 与
`POST /api/v1/recommendations/discover` 提供可回放的目录轮换和条件检索。其运行模式固定为
`VERIFIED_CATALOG_COMPATIBILITY`，模型调用数为 0。检索理由只能来自运行包中的
`domains/features`；年代、演唱者性别、语言和 Hi-Res/DSD 等运行包未提供的事实会作为
`unsupportedTerms` 返回，不能参与排序。

`@cocean/recommendation-core` 实现的是独立的 Still v0.10 确定性算法合同。当前导入包不是
Catalog 2.0 CN Accepted Runtime Snapshot，因此 API 会同时返回
`WAITING_FOR_ACCEPTED_RUNTIME / ACCEPTED_RUNTIME_SNAPSHOT_MISSING`。两条路径不得混池，
兼容目录结果不得标记为 v0.10 正式推荐。

## 更新边界

- 内容版本不可原地改写；同一 `contentVersion` 对应不同校验和会被拒绝。
- 新版本以单个 SQLite 事务安装并切换为 active；历史版本保留用于回放和回滚。
- 目录内容不能自动改写本地音乐文件，也不能凭标题相似自动认定具体 CD、SACD 或黑胶版次。
- 外部发行核验、Still 策展身份和 NAS 本地文件身份保持三层分离。
