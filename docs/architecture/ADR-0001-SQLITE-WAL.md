# ADR-0001：FNOS 首发使用 SQLite WAL

- 状态：Accepted
- 日期：2026-08-12
- 适用版本：COCEAN v1

## 决策

COCEAN v1 使用“模块化单体 + 独立扫描 Worker + SQLite WAL”。Web 只提供静态
页面和同源 API 代理；Server 与 Worker 共享 FNOS 本机 data 目录中的
`cocean.sqlite`，通过 WAL、外键和 5 秒 busy timeout 协作。数据库、WAL 与
SHM 禁止放在 SMB、NFS 或其他网络文件系统。

## 原因

首发目标是单用户私人 NAS，预计十万级曲目。此规模下，独立 PostgreSQL 会增加
内存、备份、升级和排障成本，却不会改善只读媒体解析的主要瓶颈。SQLite 让部署
保持低资源和可迁移，同时仍能提供事务、索引、迁移、任务原子领取和审计数据。

## 约束

- Server 必须先执行迁移，Worker 只在 Server 健康后启动；
- 长任务只在短事务中更新状态，不得持有数据库锁进行 ffprobe 或网络请求；
- Worker 使用心跳供容器健康检查，扫描失败逐文件持久化；
- 原始文件级备份前停止 Server/Worker，或使用 SQLite online backup；
- Music 始终独立挂载，Server 只读；Worker 在默认 WATCH_ONLY 下只读，只有显式授权的
  MANAGED Root 才受控读写，数据库、缓存与隔离区仍不得写入 Music；
- 数据量、多用户写并发或远程 HA 需求出现后，通过新 ADR 评估 PostgreSQL，
  不在 v1 预先引入。

## 已验证

2026-08-12 的本地合成验收覆盖 16/44.1、24/96、DXD、多碟、父目录封面和损坏
文件：4 个音频文件中 3 个成功、1 个形成可审计失败项，聚合为 2 张 Album；
扫描前后 5 个源目录条目的路径、大小和 mtime 均未变化。真实 FNOS 全库验收仍是
发布 Gate。
