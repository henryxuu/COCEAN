# 参与 COCEAN 开发

COCEAN 采用短分支、受保护 `main` 和模块所有权清晰的协作方式。所有变更通过
Pull Request 合入；不要直接向 `main` 推送。

## 分支与变更范围

- 功能：`feature/<module>-<topic>`；
- 修复：`fix/<module>-<topic>`；
- 文档：`docs/<topic>`；
- Codex 工作分支：`codex/<topic>`。

分支应短期存在。一次 PR 优先只改变一个模块及其合同/测试；跨模块变更需要在 PR
说明中列出数据合同、迁移顺序和回滚方式。

主要模块边界：

- `apps/web`：浏览器 UI，不直接读取 NAS 文件或保存 Provider 凭据；
- `apps/server`：HTTP API、设置与读模型；
- `apps/worker`：只读扫描、后台任务和受控交付；
- `packages/contracts`：跨模块类型，变更需同步消费者测试；
- `packages/database`：SQLite 迁移与 Repository；
- `packages/media-scanner`：确定性媒体事实，不调用模型或外部元数据源；
- `packages/recommendation-*`：版本化、可回放的推荐逻辑；
- `infra`：容器、FNOS 部署与验收 Gate。

## 本地检查

提交前至少运行：

```bash
pnpm check
pnpm --filter @cocean/media-scanner test:integration
ruby infra/scripts/validate-fnos-compose.rb
```

如果变更涉及容器，还必须在有 Docker 的环境执行 Compose config、镜像构建和合成
Music 库验收；本机单测不能替代真实 FNOS 验收。

## 不可突破的产品边界

- Music 观察库始终只读；扫描不得写标签、封面、目录、隐藏文件或数据库；
- 位深、采样率、码率、DSD 倍率、标签和封面来自本地解析器，不来自模型；
- 模型结果只能进入语义辅助、解释或候选证据层；
- CD、SACD、黑胶表示实体副本，数字文件显示实际音频规格；
- 外部 Provider 默认关闭，凭据不得写入代码、数据库普通字段、日志、fixture 或 PR；
- 破坏性整理、覆盖、删除和投送必须是显式计划，且具备预览、校验和恢复边界。

## 测试数据与隐私

不要提交真实私人音乐、封面、绝对 NAS 路径、Cookie、Token、序列号、购买记录或
播放历史。媒体回归样本应由脚本生成，或使用明确允许再分发的最小 fixture。

Still 精品目录是独立内容包，不随开源代码重新分发。测试使用合成目录；运行时内容
包通过部署数据目录注入。

## 数据库与 API 变更

- SQLite 迁移只向前追加，不修改已经发布的迁移；
- 迁移需测试从上一版本升级，并说明备份/回滚条件；
- API 与共享 schema 同步修改，错误状态必须是可机器判断的结构；
- 扫描结果必须可对账、可分页、可回放，不得用下一次扫描覆盖历史证据。

## Pull Request 最低说明

PR 描述需包含：问题场景、用户可见结果、变更模块、验证证据、数据/隐私影响，以及
必要的部署或回滚说明。UI 变更还需说明对应的 Still iOS v0.10 / COCEAN Figma
节点或经过批准的设计 token 依据。

## 授权边界

源代码采用 Apache-2.0 许可证。该许可证不授予 Still 标志、品牌资产、精品目录、
第三方元数据或 Provider 内容的使用权；这些内容不应提交到本仓库。
