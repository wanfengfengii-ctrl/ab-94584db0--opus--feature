# Opus Archive Audit

海洋声学站归档 Ogg Opus 记录的**分页完整性审计服务**。播放器对损坏的
Ogg/Opus 流相当宽容，可能掩盖页截断、跨页丢包或时长漂移；本服务在归档前
对逻辑流做严格的结构校验，绝不做"容错式"重同步。

- `POST /api/opus/audit`（`Content-Type: audio/ogg`，体积 ≤ 8 MiB，页数 ≤ 2048）
- 可选查询参数 `logical_streams=chained`：审计由编码器重启顺序拼接的
  **1–16 段完整逻辑流（chained Ogg）**；省略时保持单流原契约
- `GET /health` 健康检查

## 链式逻辑流（`logical_streams=chained`）

水声记录器重启编码器后，可能把多段完整 Ogg Opus 逻辑流顺序写进同一个文件。
启用链式审计后，平台对整份文件一次性全链审计，而不会把后续 BOS 当作尾随数据：

- 每段必须从 **BOS 页**开始、**页序号从 0 重新计数**；前一段完整 EOS 之后，
  下一段才允许开始；
- 各段**流序列号两两不同**，段间不得交错（未到 EOS 出现其它序列号的页），
  也不得跨段续包；
- 所有 `OpusHead` 的声道数必须与**首段一致**（pre-skip、输出增益等可不同）；
- 包成帧、CRC、粒度时间线等规则**对每段独立成立**（每段粒度从 0 重新累计）；
- **8 MiB 与 2048 页限制按整份文件计算**；
- 成功响应增加 `linkCount`，`pageCount` / `audioPacketCount` /
  `decodedSamples` 为全链汇总；`playableSamples` 为各段
  `max(0, 该段末粒度 − 该段 pre-skip)` 之和。

段间交错、缺失 EOS、重复流序列号、声道变化等均返回 422，并给出**首个全局
失败页索引**与稳定错误码（如 `LINK_INTERLEAVED`、`SERIAL_NUMBER_REUSED`、
`STREAM_NOT_TERMINATED`、`CHANNEL_CONFIG_MISMATCH`、`TOO_MANY_LINKS`）。
省略参数时，含多段 BOS 的文件仍按原单流契约拒绝。

## 审计内容

每页依次核验：

1. 捕获标识 `OggS`、流结构版本（必须为 0）、保留标志位；
2. 32 位序列号（必须从 0 起严格连续）与逻辑流序列号（全流一致）；
3. 段表与正文实际长度一致；
4. 整页 Ogg CRC-32（多项式 0x04c11db7）；
5. BOS / EOS / 跨页续包标志与上一页结束状态一致，EOS 后不得再有页；
6. 前两个完整包依次为 `OpusHead`（仅接受 mapping family 0，单/立体声）
   与结构合法的 `OpusTags`，两页粒度必须为 0，跨页标签页粒度为 -1；
7. 每个音频包按 RFC 6716 TOC 解析 code 0/1/2/3 成帧（含 VBR/CBR、
   Opus padding、1275 字节帧长、120 ms 上限），校验立体声标志与
   OpusHead 声道配置一致；
8. 时间线：
   - 无完整包结束的页粒度必须为 `-1`；
   - 普通音频页粒度必须严格等于该页结束的全部包的 48 kHz 累计样本数；
   - EOS 页可向前裁剪，但粒度不得小于上一粒度，也不得超过
     "上一粒度 + 本页完成包样本数"。

## 返回

成功（200，单流契约）：

```json
{
  "pageCount": 4,
  "audioPacketCount": 3,
  "decodedSamples": 2640,
  "playableSamples": 2328
}
```

链式模式额外返回 `linkCount`，各字段为全链汇总：

```json
{
  "pageCount": 6,
  "audioPacketCount": 6,
  "decodedSamples": 5760,
  "playableSamples": 5328,
  "linkCount": 2
}
```

- `decodedSamples`：所有完整音频包按 TOC 累计的 48 kHz 解码样本数；
- `playableSamples`：单流为最终 EOS 粒度减去 OpusHead pre-skip（钳为非负）；
  链式模式下各段独立计算后求和，即真实可播放样本数。

失败返回 422（体积超限 413、空体 400、类型不符 415），并给出稳定错误码与
**首个失败页索引**：

```json
{ "error": { "code": "GRANULE_MISMATCH", "page": 3, "message": "..." } }
```

## 本地运行

```bash
npm ci
npm test          # 97 个单元/HTTP 测试
npm run build     # tsc -> dist/
npm start         # 默认 0.0.0.0:3000
```

跨页 HTTP 冒烟（先启动服务）：

```bash
BASE_URL=http://127.0.0.1:3000 node scripts/smoke.ts
```

## Docker / Compose

```bash
# 宿主机端口可配置
HOST_PORT=8080 docker compose up -d --build api

# 一次性校验：等 API 健康后执行 typecheck、单测、生产构建、跨页冒烟，
# 容器退出码汇总全部结果（任一失败非 0）
docker compose up --build verify
```

`verify` 服务通过 `depends_on: condition: service_healthy` 且 `/health`
健康检查通过后才启动，`restart: "no"`，仅运行一次。

## 目录

- `src/crc32ogg.ts` — Ogg CRC-32
- `src/opusToc.ts` — RFC 6716 TOC/成帧校验与样本数推导
- `src/audit.ts` — 页解析、包重组、标志与时间线审计
- `src/server.ts` / `src/main.ts` — HTTP 服务
- `test/` — 单测、HTTP 测试、夹具（含真实 libopus 编码样本）
- `scripts/smoke.ts` — 含跨页音频包的 HTTP 冒烟
