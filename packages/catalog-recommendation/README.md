# COCEAN catalog recommendation

这是 Still 版本化精选目录的确定性兼容浏览器，不冒充 Still v0.10 正式推荐运行时。

- 输入只包含当前激活的已核验目录、日期或显式查询。
- 找歌理由只来自目录中真实存在的 `domains/features`。
- 年代、演唱者性别、语言和音频规格等目录未提供的事实会显式标记为不支持。
- 结果可回放，模型调用数恒为零。
- Still v0.10 的 `accepted-runtime` 仍由 `@cocean/recommendation-core` 单独负责；没有 Accepted Runtime Snapshot 时不得把兼容结果标记为 v0.10 正式推荐。
