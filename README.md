# COCEAN

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

COCEAN 是部署在 NAS 上的私人 Hi-Fi 音乐资源控制台。它以 Album 为中心管理本地数字文件、实体介质、信息匹配、Still 推荐与播放器投送。

当前首发形态：响应式 Web/PWA + API + 扫描 Worker + SQLite WAL，由 Docker Compose 在飞牛 FNOS 上部署。

## 安全边界

- 音乐主库默认以 `/library/music:ro` 只读挂载；
- 标签、封面、位深、采样率和 DSD 规格由本地解析器读取，不经过模型；
- FNOS `.@__thumb`、Synology `@eaDir` 与 `.AppleDouble` 中的生成缩略图按辅助文件处理；即使沿用 `.flac/.dsf` 后缀也不会进入唱片库；
- 可选 OpenAI-compatible 模型只按需生成专辑介绍；不参与标签解析、发行定版或自动写回；
- MVP 不自动写回音乐文件，也不直接操作 NAS 裸磁盘；
- Qobuz 与下载适配器默认关闭，并与核心扫描隔离。
- Docker secret 只用于首次创建管理员；日常使用独立登录页、HttpOnly Session 与本地多用户账号，
  且纯 HTTP 不加密链路，因此仍只能发布到可信局域网，不能直接暴露公网。
- Still 的 Apple Music 来源可补充外部封面、30 秒试听与商店链接；完整浏览器播放需单独接入 MusicKit 授权。
- SP3000M 通过 AK File Drop 的 FTP 投送；Qobuz 不使用 Cookie 绕行，等待正式合作接口。

## 工作区

```text
apps/web                 响应式管理界面
apps/server              HTTP API 与静态资源服务
apps/worker              扫描和任务 Worker
packages/contracts       跨模块类型与显示规则
packages/database        SQLite Schema 与 Repository
packages/media-scanner   只读媒体解析
packages/still-catalog   Still 内容包验证与最小运行适配
packages/recommendation-core  Still 确定性推荐核心
packages/catalog-recommendation  已核验旧目录的确定性兼容检索
infra                    Docker 与 FNOS 部署
docs                     架构、部署与验收合同
```

## 本地开发

要求 Node.js 22.12+ 与 pnpm 11+。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Web 默认访问 `http://localhost:5173`，API 默认访问 `http://localhost:8787`。

完整的飞牛部署与真实 Music 目录验收步骤见 `docs/deployment/`。
Still 精品目录不会随开源仓库重新分发；本地导入说明见 `docs/catalog/STILL_CATALOG_IMPORT.md`。

贡献者请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。项目采用受保护 `main` 与
短期模块分支。源代码以 Apache-2.0 许可发布；Still 品牌资产、精品目录及其他内容包
不属于本仓库许可证授权范围，也不会随源码分发。

当前可用 UI 推荐来自版本化 Still v0.81 已核验目录的兼容轮换/检索。它只解释目录中
实际存在的 Domain 与 Feature，不把年代、人声、音频规格等缺失字段交给模型猜测。
Still v0.10 正式算法核心已经独立实现并通过合成契约测试，但在得到 CN Accepted
Runtime Snapshot 前保持 `WAITING_FOR_ACCEPTED_RUNTIME`，不会把兼容结果冒充正式结果。
