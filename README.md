# 字幕修订合并与时轴检查库(subtitle-revision-kit)

供字幕制作团队在**交付前**使用的 Node 22 库,只使用 Node 自带模块,无需安装任何依赖、
不访问网络或数据库。它解决三件事:

1. 把同一条字幕的**多轮修订**(可能乱序、重复、冲突)合并成"当前生效版本",并把所有
   异常一次性列清楚;
2. 对合并后的**最终时轴**做交付检查(负帧、无效区间、同语言轨重叠),给出每条语言轨
   和整体的交付结论;
3. 复用合并与校验结果,把一条**干净语言轨**导出成 **SRT 或 WebVTT 交付文本**
   (`exportTrack`),帧到毫秒全程精确有理数换算、半毫秒向上取整。

## 运行环境

- Node.js **22 或更高**
- 无第三方依赖

```bash
node --version            # 确认 >= 22
npm test                  # 运行全部自动化测试(91 个用例)
npm run demo              # 运行综合示例
node examples/demo.js 我的输入.json   # 分析你自己的文件
```

## 输入数据格式

输入是一个 JSON 对象(可以直接传对象,也可以传 JSON 字符串):

```json
{
  "frameRate": { "numerator": 30000, "denominator": 1001 },
  "subtitles": [
    { "id": "S1", "language": "zh", "startFrame": 0, "endFrame": 150,
      "text": "大家好。", "speaker": "主持人" }
  ],
  "revisions": [
    { "revisionId": "r100", "targetId": "S1", "version": 1,
      "action": "update", "payload": { "text": "大家好!" } }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `frameRate` | 帧率。整数写 `25`;非整数写 `{ "numerator": 30000, "denominator": 1001 }`(也接受 `"24000/1001"` 字符串)。内部按精确有理数计算,**不使用浮点数**。 |
| `subtitles[].id` | 字幕编号,数字或非空字符串均可。 |
| `subtitles[].language` | 语言轨标识,如 `zh`、`en`。重叠只在**同一语言轨内**判定。 |
| `startFrame` / `endFrame` | 整数帧号。区间按半开 `[startFrame, endFrame)` 处理。 |
| `text` | 字幕文本(必填)。`speaker` 说话人可省略(视为 `null`)。 |
| `revisions[].revisionId` | 修订自身的独立编号。 |
| `revisions[].targetId` | 目标字幕编号。 |
| `revisions[].version` | 递增版本号,从 **1** 开始,同一字幕的修订序列必须连续。 |
| `revisions[].action` | `update`(更新)或 `withdraw`(撤回整条字幕)。 |
| `revisions[].payload` | 仅 `update` 使用,可含 `startFrame`、`endFrame`、`text`、`speaker` 中的任意字段。`speaker` 传 `null` 表示清空。不能通过修订修改编号或语言轨。 |

**修订可以乱序到达**——库总是按目标字幕分组、按版本号升序应用,数组顺序不影响结果。

## 快速上手

### 1. 出交付报告(最常用)

```js
const { analyzeDocument } = require('./src/index');
const fs = require('node:fs');

const report = analyzeDocument(fs.readFileSync('input.json', 'utf8'));

console.log(report.overall.deliverable);   // true/false,整体结论
for (const track of report.tracks) {
  console.log(track.language, track.deliverable, track.errorCount, track.warningCount);
}
for (const p of report.problems) {
  console.log(`[${p.severity}] ${p.code}: ${p.message}`);
}
```

`analyzeDocument` 返回(整体已冻结,不会被意外修改):

- `frameRate`:归一化帧率 `{ numerator, denominator, label, isIntegerRate }`,无效时为 `null`;
- `overall.deliverable`:**整体**是否可交付(帧率有效且没有任何错误);
- `overall.errorCount` / `warningCount`;
- `tracks[]`:**每条语言轨**一条记录,各自带 `deliverable`、错误/警告数、字幕计数
  (总数 / 生效 / 撤回),一条语言轨有问题不会拖累其他轨的判定;
- `problems[]`:本次输入发现的**全部**问题,按稳定顺序排列;
- `currentSubtitles[]`:合并后当前生效的字幕(撤回的不在其中)。

### 2. 按编号查看原始内容与修订历史

```js
const { loadSubtitles } = require('./src/index');
const store = loadSubtitles(input);

const s = store.getSubtitle('S1');
// s.original        原始内容快照
// s.history[]       每条修订:版本、动作、编号、状态、负载、应用后的结果快照
// s.current         当前生效内容;已撤回时为 null
// s.status          'active' | 'withdrawn'
```

历史中每条修订的 `status` 含义:

| 状态 | 含义 |
| --- | --- |
| `applied` | 已生效 |
| `conflicted` | 同号异内容冲突,未生效 |
| `skipped_duplicate_version` | 同一版本出现多条不同修订,无法抉择,跳过 |
| `after_withdraw` | 字幕已撤回,该修改被忽略 |
| `invalid_payload` | 更新内容不合法,未生效 |

### 3. 按帧位置查询当前字幕

```js
store.subtitlesAtFrame(250);        // 所有语言轨,可能多条
store.subtitlesAtFrame(250, 'zh');  // 指定语言轨
```

区间是半开的:第 150 帧恰好是上一条的结束帧、下一条的开始帧(**首尾相接**)时,
只命中下一条,不视为重叠。

另有展示用(不参与判定)的精确换算:`store.frameToSeconds(30000)`、
`store.frameToTimecode(30000)`。

## 导出 SRT / WebVTT(`exportTrack`)

把**一条语言轨**合并后仍然生效的字幕导出成可交付文本。导出前会**复用**上面的合并与时轴
校验结果,绝不带着半成品往下走。

```js
const { exportTrack } = require('./src/index');

const result = exportTrack(input, { language: 'zh', format: 'srt' });
if (!result.ok) {
  console.log(result.reasonCode); // 机器可识别的失败原因
  console.log(result.message);    // 人类可读说明
  console.log(result.problems);   // 相关问题(与 analyzeDocument 同结构)
} else {
  console.log(result.format, result.language, result.subtitleCount);
  fs.writeFileSync('zh.srt', result.text);
}
```

### 参数

| 参数 | 说明 |
| --- | --- |
| `input` | 与 `analyzeDocument` 相同,对象或 JSON 字符串。 |
| `options.language` | **必填**,要导出的语言轨标识。 |
| `options.format` | **必填**,只接受 `'srt'` 或 `'vtt'`。 |
| `options.includeSpeaker` | 布尔,默认 **`false`**。为 `true` 且该条字幕有说话人时,在正文最前面加一行 `说话人: 正文`;为 `false`(默认)时**不输出说话人**,只导出正文。说话人为空时该选项无作用。字幕文本中原有的换行始终原样保留。 |

### 成功返回

```js
{
  ok: true,
  format: 'srt',          // 实际格式
  language: 'zh',         // 实际语言轨
  subtitleCount: 2,       // 导出的 cue 数量(撤回的不计)
  text: '1\n00:00:00,000 --> 00:00:05,005\n……\n', // 完整文本
  warnings: [ /* 该语言轨上的 warning,不阻止导出 */ ],
}
```

- 只导出**修订合并后仍然生效**的字幕(已撤回的不导出),并按
  **起始帧 → 结束帧 → 字幕编号**稳定排序,打乱输入数组不影响输出。
- **SRT**:序号从 **1** 开始连续编号,时间戳 `HH:MM:SS,mmm`(逗号)。
- **WebVTT**:以 `WEBVTT` 文件头开头,带字幕编号(使用文档中的稳定字幕 id),
  时间戳 `HH:MM:SS.mmm`(点号)。

  **cue identifier 映射规则**:字幕编号允许任意非空字符串,但 WebVTT 的 cue
  identifier 必须是**单行**且**不能包含时间箭头 `-->`**。因此:

  - 编号不含 CR(`\r`)、LF(`\n`)、`-->`、百分号 `%` 时(包括普通中文、emoji 等
    任意 Unicode、空格、单个短横线)**原样使用**;
  - 否则在编号前加固定前缀 `esc:`,并对下列字符做确定性的百分号编码,
    结果保证单行、无 `-->`:

    | 原字符 | 编码 |
    | --- | --- |
    | `%` | `%25` |
    | LF 换行 | `%0A` |
    | CR 回车 | `%0D` |
    | `-->` | `%2D%2D%3E` |

    例如 `bad\nid` → `esc:bad%0Aid`,`bad --> id` → `esc:bad %2D%2D%3E id`。
    先编码 `%` 使该映射为单射:像 `bad%0Aid` 这种字面编号会变成
    `esc:bad%250Aid`,不会与 `bad\nid` 的产物碰撞;`esc:` 前缀也让转义产物
    不可能与任何原样编号相同。该映射只影响 WebVTT 的 identifier,
    **不影响 SRT 的连续序号,也不影响正文内容**。
- 整条语言轨的字幕全部撤回(空轨)时仍算成功:`subtitleCount` 为 `0`,
  SRT `text` 为空串,WebVTT `text` 仅为 `WEBVTT\n`。

### 失败返回(不生成半成品)

`ok:false` 时 `text` 恒为空串、`subtitleCount` 为 0,并给出可识别的 `reasonCode`:

| `reasonCode` | 触发条件 |
| --- | --- |
| `INVALID_OPTIONS` | 缺 `language`、`format` 不是 `srt`/`vtt`、`includeSpeaker` 非布尔等。 |
| `INVALID_DOCUMENT` | 输入连解析都通不过(如非法 JSON)。 |
| `INVALID_FRAME_RATE` | 帧率无效或缺失,无法换算时间,**全局阻断**。 |
| `UNATTRIBUTED_ERRORS` | 存在**无法归属到任何语言轨**的 error(如孤立修订 `DANGLING_REVISION`、`INVALID_DOCUMENT`),**全局阻断**;`problems` 中给出这些错误。 |
| `UNKNOWN_LANGUAGE` | 指定的语言轨在合并结果中不存在(没有任何字幕归属该轨)。 |
| `TRACK_HAS_ERRORS` | 所选语言轨自身有 error(重叠、无效区间、负帧、该轨修订错误等);其他轨的 error **不在内**,也不影响本轨。 |
| `ZERO_DURATION_CUE` | 某条**正帧区间**(start < end)换算取整后起止毫秒相同(被压成 0ms),生成它会得到无效 cue,因而整条导出失败。 |

阻断规则要点:

- **帧率无效**或**无法归属语言轨的 error** → 任何轨都导不出;
- **所选轨自身有 error** → 该轨导不出,失败结果的 `problems` 列出相关错误;
- **其他语言轨的 error 不阻止当前干净轨导出**(多语言隔离);
- **warning 永远不阻止导出**,成功时放在 `warnings`、因轨错误失败时也一并回传。

### 帧 → 毫秒取整规则(可直接核对)

- 换算公式:`毫秒 = round(帧号 × 1000 × 帧率分母 / 帧率分子)`,全程基于现有的
  **BigInt 精确有理数**,不使用任何浮点运算。
- 按**最接近的毫秒**四舍五入;**恰好半毫秒时向上**(朝 +∞)。
  以 30000/1001(29.97fps)为例:

  | 帧 | 精确毫秒 | 导出时间戳 |
  | --- | --- | --- |
  | 1 | 33.366… | `00:00:00,033` |
  | 2 | 66.733… | `00:00:00,067` |
  | 15 | 500.5(恰好半毫秒) | `00:00:00,501`(**向上**) |
  | 150 | 5005 整 | `00:00:05,005` |

- **同一帧只换算一次并复用结果**:相邻字幕共享同一帧边界(上一条结束帧 = 下一条
  起始帧,首尾相接)时,导出的上一条结束时间与下一条开始时间**逐字符完全一致**。

## 会报告哪些问题

问题分两级:**error(错误,阻止该语言轨交付)** 与 **warning(警告,不阻止交付)**。
一次输入中的问题会**全部返回**,不会遇到第一个就停止;顺序固定
(按 问题类别 → 语言轨 → 字幕编号 → 修订编号 → 版本 排列),打乱输入数组不会改变结果。

| 代码 | 级别 | 含义与处理方式 |
| --- --- | --- |
| `INVALID_FRAME_RATE` | 错误 | 帧率缺失、不是正数或无法解析。 |
| `INVALID_DOCUMENT` | 错误 | 文档本身不是对象、`subtitles`/`revisions` 不是数组等。 |
| `INVALID_SUBTITLE` | 错误 | 字幕缺字段、帧号不是整数、语言轨或文本非法等,该条不纳入。 |
| `DUPLICATE_SUBTITLE_ID` | 错误 | 原始字幕编号重复,无法决定以哪条为准,**均不纳入**(不依赖数组顺序)。 |
| `INVALID_REVISION` | 错误 | 修订缺字段、动作不是 update/withdraw、版本号不是正整数等。 |
| `REVISION_CONFLICT` | 错误 | **同一修订编号对应不同内容**(更新内容、动作、目标或版本不同),该编号的所有变体一律不生效。 |
| `DUPLICATE_REVISION` | 警告 | 完全相同的修订(对象键顺序不同也算相同)重复出现,**只生效一次**。 |
| `DUPLICATE_VERSION` | 错误 | 同一字幕同一版本对应多条不同修订,该版本全部跳过。 |
| `VERSION_GAP` | 错误 | 版本序列不从 1 开始或中间有缺口(如只有 v1 和 v3);其余版本仍按序应用,但需补件。 |
| `DANGLING_REVISION` | 错误 | 修订引用了不存在的字幕编号。 |
| `INVALID_REVISION_PAYLOAD` | 错误 | 更新含非法字段(如试图改编号/语言轨)、字段类型错误、空负载,或撤回却带了负载。 |
| `REVISION_AFTER_WITHDRAW` | 错误 | 字幕已撤回后仍有修订试图修改,该修改被忽略。 |
| `NEGATIVE_FRAME` | 错误 | 最终时轴中存在负帧号。 |
| `INVALID_INTERVAL` | 错误 | `endFrame <= startFrame`(零时长或反转)。 |
| `OVERLAPPING_SUBTITLES` | 错误 | 同一语言轨内区间相交,问题中给出重叠区间;首尾相接不报。 |

冲突与重复的区别举例:

```jsonc
// 完全相同(含对象键顺序不同)→ DUPLICATE_REVISION 警告,只生效一次
{ "revisionId": "r1", "targetId": "S1", "version": 1, "action": "update", "payload": { "text": "A", "speaker": "甲" } }
{ "revisionId": "r1", "targetId": "S1", "version": 1, "action": "update", "payload": { "speaker": "甲", "text": "A" } }

// 同号但内容不同 → REVISION_CONFLICT 错误,两条都不生效,必须人工裁决
{ "revisionId": "r2", "targetId": "S1", "version": 1, "action": "update", "payload": { "text": "A" } }
{ "revisionId": "r2", "targetId": "S1", "version": 1, "action": "update", "payload": { "text": "B" } }
```

## 精确性与稳定性保证

- **帧率/时间换算全部用 BigInt 有理数**完成,边界比较(相等、首尾相接)不经过浮点,
  例如 29.97fps 下第 30000 帧被严格判定为恰好第 1001 秒。导出 SRT/WebVTT 的帧→毫秒
  换算同样全程整数运算,四舍五入到毫秒、半毫秒向上。
- 输入数组无论怎么排列,合并结果与问题清单都**完全一致**;测试中有专门的排列不变性用例。
- 所有查询返回的对象/数组都是**深拷贝并冻结**的,外部修改无法影响内部状态;每次查询
  返回独立副本。
- 输入可以是 JS 对象,也可以是 JSON 字符串(内部用 `JSON.parse` 语义,不接受 NaN 等)。

## 目录结构

```
src/
  fraction.js   精确有理数(帧率、帧↔秒换算、毫秒四舍五入)
  canonical.js  规范签名(重复/冲突判定,与键顺序无关)
  util.js       输入净化、深拷贝/冻结、稳定标签
  problems.js   问题登记与稳定排序
  merge.js      修订合并引擎
  timeline.js   最终时轴检查
  export.js     SRT / WebVTT 导出(exportTrack)
  index.js      对外 API:analyzeDocument / loadSubtitles / exportTrack
test/           node:test 自动化测试(91 个用例)
examples/
  sample-input.json  综合示例输入(乱序修订 + 编号冲突 + 时轴重叠)
  export-input.json  干净的双语轨导出示例(首尾相接 + 多行文本 + 说话人)
  demo.js            可读报告与导出演示
```

## 作为脚本批量检查文件

```bash
node examples/demo.js path/to/input.json
```

如需在流水线中使用,建议直接调用 `analyzeDocument`,以 `overall.deliverable` 和各轨
`tracks[i].deliverable` 作为门禁,以 `problems[]` 作为返工清单。
