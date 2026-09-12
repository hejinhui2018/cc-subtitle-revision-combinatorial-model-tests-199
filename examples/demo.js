#!/usr/bin/env node
'use strict';

/**
 * 综合演示:读取一份 JSON 输入(修订乱序到达),
 * 输出完整的合并结果、问题清单、每条语言轨与整体交付结论,
 * 并演示按编号查历史、按帧查字幕。
 *
 * 运行:node examples/demo.js [输入文件路径]
 */

const fs = require('node:fs');
const path = require('node:path');
const { analyzeDocument, loadSubtitles, exportTrack } = require('../src/index');

const inputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'sample-input.json');

const raw = fs.readFileSync(inputPath, 'utf8');
const report = analyzeDocument(raw);
const store = loadSubtitles(raw);

const line = '─'.repeat(72);

function severityIcon(severity) {
  return severity === 'error' ? '✗ 错误' : '⚠ 警告';
}

console.log(line);
console.log('字幕修订合并与最终时轴检查报告');
console.log(line);
console.log(`帧率: ${report.frameRate ? report.frameRate.label : '(无效)'} ` +
  `(${report.frameRate && report.frameRate.isIntegerRate ? '整数帧率' : '分子/分母帧率,精确有理数计算'})`);

console.log('\n【问题清单】'); // eslint-disable-line no-console
if (report.problems.length === 0) {
  console.log('  无问题');
} else {
  report.problems.forEach((p, i) => {
    console.log(
      `${String(i + 1).padStart(2, ' ')}. [${severityIcon(p.severity)}] ${p.code}\n      ${p.message}`,
    );
  });
}

console.log('\n【每条语言轨交付结论】');
for (const t of report.tracks) {
  console.log(
    `  ${t.language.padEnd(4)} ${t.deliverable ? '✔ 可交付' : '✘ 不可交付'}  ` +
    `错误 ${t.errorCount} / 警告 ${t.warningCount}  ` +
    `(共 ${t.totalSubtitles} 条,生效 ${t.activeSubtitles} 条,撤回 ${t.withdrawnSubtitles} 条)`,
  );
}

console.log('\n【整体结论】');
console.log(`  ${report.overall.deliverable ? '✔ 可以交付' : '✘ 暂不可交付'} — ` +
  `共 ${report.overall.errorCount} 个错误、${report.overall.warningCount} 个警告,` +
  `${report.overall.trackCount} 条语言轨`);

console.log('\n【合并后的当前字幕】');
for (const s of report.currentSubtitles) {
  const start = store.frameToTimecode(s.startFrame);
  const end = store.frameToTimecode(s.endFrame);
  console.log(
    `  [${s.language}] ${s.id} 帧 ${s.startFrame}-${s.endFrame} (${start} → ${end})\n      ` +
    `${JSON.stringify(s.text)}${s.speaker ? ` — ${s.speaker}` : ''}`,
  );
}

console.log('\n【按编号查看:字幕 S3 的原始内容与修订历史】');
const s3 = store.getSubtitle('S3');
console.log(`  原始: 帧 ${s3.original.startFrame}-${s3.original.endFrame} 文本 ${JSON.stringify(s3.original.text)}`);
for (const h of s3.history) {
  console.log(`  v${h.version} ${h.action}(${h.revisionId}) → 状态:${h.status},变更:${JSON.stringify(h.payload)}`);
}
console.log(`  当前: 帧 ${s3.current.startFrame}-${s3.current.endFrame} 文本 ${JSON.stringify(s3.current.text)}`);

console.log('\n【按帧查询:第 250 帧正在显示的字幕(半开区间,首尾相接不重叠)】');
for (const s of store.subtitlesAtFrame(250)) {
  console.log(`  [${s.language}] ${s.id}: ${JSON.stringify(s.text)} (帧 ${s.startFrame}-${s.endFrame})`);
}
console.log('  第 150 帧(首尾相接点)正在显示:');
for (const s of store.subtitlesAtFrame(150)) {
  console.log(`  [${s.language}] ${s.id}: ${JSON.stringify(s.text)}`);
}

// ---------------------------------------------------------------- 导出演示

/** 打印一次导出结果:成功则给出完整文本,失败则给出可识别原因与相关问题。 */
function showExport(title, input, options) {
  console.log(`\n【${title}】`);
  console.log(`  调用:exportTrack(input, ${JSON.stringify(options)})`);
  const result = exportTrack(input, options);
  if (!result.ok) {
    console.log(`  ✘ 导出失败 reasonCode=${result.reasonCode}`);
    console.log(`    ${result.message}`);
    for (const p of result.problems) {
      console.log(`    · [${p.severity}] ${p.code}: ${p.message}`);
    }
    console.log(`  返回 text = ${JSON.stringify(result.text)}(空内容,未生成半成品)`);
    return;
  }
  console.log(`  ✔ 导出成功 format=${result.format} language=${result.language} ` +
    `subtitleCount=${result.subtitleCount}` +
    (result.warnings.length ? ` warnings=${result.warnings.length}` : ''));
  console.log('  ┌─ text ────────────────────────────────────────────────');
  console.log(result.text.replace(/\n$/, '').split('\n').map((l) => `  │ ${l}`).join('\n'));
  console.log('  └───────────────────────────────────────────────────────');
}

// 干净的双语轨输入:用于直接核对取整规则与共享边界
const exportRaw = fs.readFileSync(path.join(__dirname, 'export-input.json'), 'utf8');

console.log('\n' + '═'.repeat(72));
console.log('SRT / WebVTT 交付文本导出(exportTrack)');
console.log('═'.repeat(72));

showExport('成功导出 SRT(中文轨,默认不含说话人)', exportRaw, { language: 'zh', format: 'srt' });
showExport('成功导出 WebVTT(中文轨,includeSpeaker:true)', exportRaw, {
  language: 'zh',
  format: 'vtt',
  includeSpeaker: true,
});
showExport('成功导出 WebVTT(英文轨,多行文本保留换行)', exportRaw, { language: 'en', format: 'vtt' });

// WebVTT cue identifier:编号含换行/箭头时确定性转义(单行、无 -->、不碰撞)
const weirdIdDoc = {
  frameRate: 25,
  subtitles: [
    { id: 'bad\nid', language: 'zh', startFrame: 0, endFrame: 25, text: '换行编号', speaker: null },
    { id: 'cue --> x', language: 'zh', startFrame: 25, endFrame: 50, text: '箭头编号', speaker: null },
    { id: '普通编号-☕', language: 'zh', startFrame: 50, endFrame: 75, text: '安全编号原样', speaker: null },
  ],
  revisions: [],
};
showExport('WebVTT 特殊编号转义(换行/箭头;普通 Unicode 编号原样)', weirdIdDoc, {
  language: 'zh',
  format: 'vtt',
});

showExport('不存在的语言轨 → UNKNOWN_LANGUAGE', exportRaw, { language: 'fr', format: 'srt' });
showExport('非法 format → INVALID_OPTIONS', exportRaw, { language: 'zh', format: 'txt' });

// 多语言隔离:英文轨两条重叠(自身错误),中文轨干净 —— 中文轨应照常导出
const isolationDoc = {
  frameRate: 25,
  subtitles: [
    { id: 'c1', language: 'zh', startFrame: 0, endFrame: 25, text: '中文正常。', speaker: null },
    { id: 'e1', language: 'en', startFrame: 0, endFrame: 50, text: 'overlap A', speaker: null },
    { id: 'e2', language: 'en', startFrame: 25, endFrame: 75, text: 'overlap B', speaker: null },
  ],
  revisions: [],
};
showExport('多语言隔离:英文轨重叠,干净中文轨仍可导出', isolationDoc, { language: 'zh', format: 'srt' });
showExport('多语言隔离:同一文档导出有错误的英文轨 → TRACK_HAS_ERRORS', isolationDoc, {
  language: 'en',
  format: 'srt',
});

// 主示例含一条孤立修订(r500 → 不存在的 S99),属于无法归属语言轨的错误,全局阻断
showExport('主示例导出(含孤立修订)→ UNATTRIBUTED_ERRORS 阻断', raw, {
  language: 'zh',
  format: 'srt',
});

console.log(line);
