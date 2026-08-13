# @cocean/recommendation-core

COCEAN 的平台中立、零模型 Still v0.10 确定性推荐核心。实现冻结的
`V010-REC-FEATURE-01 / v010-gb0-baseline-1` 行为，不依赖 UI、数据库、网络、
Provider、系统时间或随机数。

## 核心边界

- `accepted-runtime` 与 `prebinding-fixture` 使用显式判别类型；混池会在评分前
  fail closed。
- 硬门槛顺序固定为：模式、发布/样张资格、身份、Storefront/测试可用性、显式
  约束、精确 Album 不喜欢、路径主证据、Session Album/Recording/Release Family、
  内容安全。
- Today、Ticket、Compass 使用冻结组权重；unknown 不补 `0` 或 `0.5`，对应组从
  有效分母移除。零项显式音乐起点的 Profile 组按合同保持中性 `0.5`。
- 最近曝光在基础分后固定扣减 `0.05`；Composer、Primary Artist、Ensemble、Label、
  Era、Domain 集中度每项扣减 `0.005`，合计最高 `0.025`。
- 同分依次按 Still Album ID、Adapter Candidate ID 排序。所有集合型输入在输入
  Hash 中规范化，因此候选与偏好输入顺序不改变回放。
- 成功结果恰好有一个 `activeAlbumId`；`baseCandidateIds` 最多两张，仅供内部交付。
  无合格候选返回 typed `unavailable`，不会伪造 Album。
- 输出包括输入 SHA-256、Rank Trace SHA-256、全部版本引用、组贡献、拒绝原因与计数；
  用户 Payload 只包含 Album ID 和已审核 reason atom 引用。
- `modelCallCount` 在结果与诊断中均为字面量 `0`，包内没有模型调用接口。

## 调用

```ts
import { recommend } from "@cocean/recommendation-core";

const execution = recommend(input, candidates);
if (execution.status === "success") {
  console.log(execution.result.activeAlbumId);
} else {
  console.log(execution.failure);
}
```

调用方负责把只读 Catalog、Structured Moment、显式偏好、本机画像和冻结历史投影为
本包类型。核心只验证治理状态、版本与特征，不读取或写回任何源数据。

## 证据边界

测试全部使用 COCEAN 自建 synthetic fixture，不包含 Still Golden Pack、私有曲库、
Apple Token、封面或音频。`prebinding-fixture` 结果不证明 Apple Music 可达性；
`accepted-runtime` 仅接受调用方已经提供的 Accepted Snapshot 与当前 Storefront
`exact + verified + available` Binding 事实。
