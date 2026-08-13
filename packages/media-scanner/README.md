# `@cocean/media-scanner`

COCEAN 的只读音频事实扫描器。它组合两类确定性数据源：

- `music-metadata`：通用标签、碟号/曲号、内嵌封面。
- 系统 `ffprobe`：容器、编码、位深、采样率、码率、声道与时长。

扫描器不提供任何写标签、移动、重命名或删除能力。生产部署应继续把 NAS 母库挂载为只读卷。

## 使用

```ts
import { scanMediaFile } from "@cocean/media-scanner";

const facts = await scanMediaFile("/music/Artist/Album/01 Track.flac", {
  rootPath: "/music",
  ffprobePath: "/usr/bin/ffprobe",
  ffprobeTimeoutMs: 30_000,
});
```

输出直接符合 `@cocean/contracts` 的 `ObservedMediaFile`：

- 文件路径、相对路径、大小与 `mtime`；
- PCM、DSD、DXD 或有损分类及完整音频规格；
- 专辑、艺术家、年份、曲号、碟号、条码、目录号与 MusicBrainz Release ID；
- 内嵌封面及 `cover/folder/front/back/disc` 旁车图片的尺寸、大小和 SHA-256；
- ffprobe 与标签解析结果冲突、DXD 推断等可审核 warning。

封面候选按“内嵌 Front → 其他内嵌类型 → 当前目录 sidecar → 明确多碟目录的
Album 父目录 sidecar”排列；上层可以保留所有候选和校验值，而不是只保留一张不可
追溯的图片。

`rootPath` 同时是安全边界：扫描前先拒绝文本路径逃逸，再通过 `realpath` 校验符号链接的实际目标。根内链接允许，指向根外的链接拒绝。多碟目录采用 `Album/CD 1/Track`、`Album/Disc 2/Track` 等明确命名时，会将上一层的专辑封面作为 fallback；搜索不会越过 `rootPath`。

## DSD 与 DXD

- DSD 根据编解码器、DSF/DFF 容器或扩展名识别；采样率映射到 DSD64–DSD512，同时兼容 44.1 kHz 和 48 kHz 基准族。
- DXD 本质为高采样率 PCM。存在明确 `DXD` 标记时直接识别；否则只在 24-bit（或位深未知）的 352.8/384/705.6/768 kHz PCM 上推断，并输出 `DXD_INFERRED_FROM_PCM_RATE`，提醒上层结合发行信息确认。
- 音频规格和发行版本是两件事：扫描器不会从 DSD/DXD 文件推断它属于哪一版 SACD 或数字发行。

## 错误模型

`scanMediaFile` 抛出 `MediaScanError`，错误包含稳定的 `code`、处理阶段、路径、是否可恢复和非敏感详情。`scanMediaFiles` 则逐文件返回成功或序列化错误，单个坏文件不会中断整批扫描。

当受支持的音频扩展名实际装着 JPEG、PNG、GIF 或 WebP 静态图片时，扫描器返回
`CONTENT_TYPE_MISMATCH`（`probe` 阶段、可恢复），不会把图片伪装误报为音频标签
损坏。真正损坏且 ffprobe 无法解析的音频仍返回 `FFPROBE_FAILED`；可解析容器中没有
音频流则返回 `UNSUPPORTED_MEDIA`。

SACD ISO、DVD-Audio `AOB` 与 DVD `VOB` 等光盘容器会在目录发现阶段明确记录为
“已知但暂不支持”，不会被当作普通附件静默跳过，也不会在缺少可靠逐曲边界时伪装
成已索引曲目。

## 测试 fixture

仓库不提交音频二进制。以下命令使用本机 ffmpeg 生成短时 FLAC、ALAC、AIFF、
MKA、24/96、DXD-rate PCM、中文路径、旁车/内嵌封面冲突、扩展名伪装图片和损坏文件样本，然后执行
集成测试。DSD64–DSD512 的技术值映射由不依赖编码器的单元测试覆盖；真实 DSF/DFF
仍必须在 FNOS 代表性专辑验收中检查：

```bash
pnpm --filter @cocean/media-scanner test:integration
```

默认 `pnpm test` 只运行不依赖系统媒体工具的单元测试。集成测试 runner 使用 EXIT trap，在成功、失败或中断时都会删除 `tests/generated-fixtures/`。如需单独清理，也可执行：

```bash
pnpm --filter @cocean/media-scanner fixtures:clean
```
