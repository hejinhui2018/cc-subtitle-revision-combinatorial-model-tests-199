'use strict';

/**
 * 修订合并引擎。
 *
 * 设计要点:
 * 1. 校验(重复/冲突/缺口/孤立/撤回后修改)只依赖修订内容,与数组顺序无关;
 * 2. 生效时按目标字幕分组、按版本号升序应用(乱序到达也能得到同一结果);
 * 3. 一条输入中的所有问题全部收集,绝不静默忽略;
 * 4. 完全相同的修订只生效一次(DUPLICATE_REVISION,警告);
 *    同一修订编号内容不同即冲突(REVISION_CONFLICT,错误,冲突变体一律不生效)。
 */

const { Fraction } = require('./fraction');
const { signature } = require('./canonical');
const { sanitize, deepClone, stableLabel } = require('./util');
const { ProblemCollector } = require('./problems');

const UPDATE = 'update';
const WITHDRAW = 'withdraw';

const ACTION_ALIASES = new Map([
  ['update', UPDATE],
  ['withdraw', WITHDRAW],
  ['更新', UPDATE],
  ['撤回', WITHDRAW],
]);

function isInt(value) {
  if (typeof value === 'bigint') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return /^[+-]?\d+$/.test(value.trim());
  return false;
}

function toInt(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number(value.trim());
}

function isNonEmptyId(value) {
  return (typeof value === 'string' && value.trim() !== '') ||
    (typeof value === 'number' && Number.isSafeInteger(value));
}

function normalizeId(value) {
  return typeof value === 'number' ? String(value) : value;
}

function normalizeAction(value) {
  if (typeof value !== 'string') return null;
  return ACTION_ALIASES.get(value.trim().toLowerCase()) ?? ACTION_ALIASES.get(value.trim()) ?? null;
}

/** 校验并净化一条原始字幕。返回 { ok, value } 或 { ok:false }。 */
function parseSubtitle(raw, problems) {
  const label = stableLabel(raw);
  let s;
  try {
    s = sanitize(raw, 'subtitle');
  } catch (err) {
    problems.add('INVALID_SUBTITLE', `无法解析的原始字幕(${label}): ${err.message}`, {
      sortKey: label,
    });
    return { ok: false };
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    problems.add('INVALID_SUBTITLE', `原始字幕不是对象: ${label}`, { sortKey: label });
    return { ok: false };
  }
  const missing = [];
  for (const field of ['id', 'language', 'startFrame', 'endFrame', 'text']) {
    if (s[field] === undefined || s[field] === null) missing.push(field);
  }
  if (missing.length > 0) {
    problems.add('INVALID_SUBTITLE', `字幕 ${s.id ?? '(无编号)'} 缺少字段: ${missing.join('、')}`, {
      targetId: normalizeId(s.id),
      sortKey: label,
    });
    return { ok: false };
  }
  if (!isNonEmptyId(s.id)) {
    problems.add('INVALID_SUBTITLE', `原始字幕编号无效: ${label}`, { sortKey: label });
    return { ok: false };
  }
  if (typeof s.language !== 'string' || s.language.trim() === '') {
    problems.add('INVALID_SUBTITLE', `字幕 ${s.id} 的语言轨无效`, {
      targetId: normalizeId(s.id),
      sortKey: label,
    });
    return { ok: false };
  }
  if (!isInt(s.startFrame) || !isInt(s.endFrame)) {
    problems.add('INVALID_SUBTITLE', `字幕 ${s.id} 的起止帧必须是整数`, {
      targetId: normalizeId(s.id),
      language: s.language,
    });
    return { ok: false };
  }
  if (typeof s.text !== 'string') {
    problems.add('INVALID_SUBTITLE', `字幕 ${s.id} 的文本必须是字符串`, {
      targetId: normalizeId(s.id),
      language: s.language,
    });
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      id: normalizeId(s.id),
      language: s.language,
      startFrame: toInt(s.startFrame),
      endFrame: toInt(s.endFrame),
      text: s.text,
      speaker: s.speaker === undefined || s.speaker === null ? null : String(s.speaker),
    },
  };
}

/** 校验更新负载:只允许改 startFrame/endFrame/text/speaker,且类型必须正确。 */
function parsePayload(raw, revId, targetId, problems) {
  let p;
  try {
    p = sanitize(raw, `revision ${revId}`);
  } catch (err) {
    problems.add('INVALID_REVISION_PAYLOAD', `修订 ${revId}(目标字幕 ${targetId})的内容无法解析: ${err.message}`, {
      revisionId: revId,
      targetId,
    });
    return { ok: false };
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    problems.add('INVALID_REVISION_PAYLOAD', `修订 ${revId}(目标字幕 ${targetId})的更新内容必须是对象`, {
      revisionId: revId,
      targetId,
    });
    return { ok: false };
  }
  const allowed = new Set(['startFrame', 'endFrame', 'text', 'speaker']);
  const unknown = Object.keys(p).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    problems.add(
      'INVALID_REVISION_PAYLOAD',
      `修订 ${revId}(目标字幕 ${targetId})含非法字段 ${unknown.join('、')}(不允许修改编号或语言轨)`,
      { revisionId: revId, targetId },
    );
    return { ok: false };
  }
  if (Object.keys(p).length === 0) {
    problems.add('INVALID_REVISION_PAYLOAD', `修订 ${revId}(目标字幕 ${targetId})没有任何更新字段`, {
      revisionId: revId,
      targetId,
    });
    return { ok: false };
  }
  const out = {};
  if ('startFrame' in p) {
    if (!isInt(p.startFrame)) {
      problems.add('INVALID_REVISION_PAYLOAD', `修订 ${revId} 的 startFrame 不是整数`, {
        revisionId: revId,
        targetId,
      });
      return { ok: false };
    }
    out.startFrame = toInt(p.startFrame);
  }
  if ('endFrame' in p) {
    if (!isInt(p.endFrame)) {
      problems.add('INVALID_REVISION_PAYLOAD', `修订 ${revId} 的 endFrame 不是整数`, {
        revisionId: revId,
        targetId,
      });
      return { ok: false };
    }
    out.endFrame = toInt(p.endFrame);
  }
  if ('text' in p) {
    if (typeof p.text !== 'string') {
      problems.add('INVALID_REVISION_PAYLOAD', `修订 ${revId} 的 text 不是字符串`, {
        revisionId: revId,
        targetId,
      });
      return { ok: false };
    }
    out.text = p.text;
  }
  if ('speaker' in p) {
    out.speaker = p.speaker === null ? null : String(p.speaker);
  }
  return { ok: true, value: out };
}

/**
 * 合并入口。
 * @param {object} document { frameRate, subtitles, revisions }
 * @returns {{frameRate: (Fraction|null), subtitles: Map, issues: object[], languages: Set}}
 */
function merge(document) {
  const problems = new ProblemCollector();

  let raw;
  try {
    raw = sanitize(document, 'document');
  } catch (err) {
    problems.add('INVALID_DOCUMENT', `输入文档无法解析: ${err.message}`);
    return finalize(null, new Map(), problems, new Set());
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.add('INVALID_DOCUMENT', '输入文档必须是对象');
    return finalize(null, new Map(), problems, new Set());
  }

  // ---- 帧率 ----
  let frameRate = null;
  if (raw.frameRate === undefined || raw.frameRate === null) {
    problems.add('INVALID_FRAME_RATE', '缺少 frameRate 字段');
  } else {
    try {
      frameRate = Fraction.fromFrameRate(raw.frameRate);
      if (frameRate.num <= 0n || frameRate.den <= 0n) {
        problems.add('INVALID_FRAME_RATE', `帧率必须为正数,收到: ${frameRate}`);
        frameRate = null;
      }
    } catch (err) {
      problems.add('INVALID_FRAME_RATE', `帧率无效: ${err.message}`);
    }
  }

  // ---- 原始字幕 ----
  // 重复编号无法确定以哪条为准:报错并全部跳过(不依赖数组顺序,保证排列无关)
  const subtitles = new Map();
  const rawSubtitles = Array.isArray(raw.subtitles) ? raw.subtitles : [];
  if (!Array.isArray(raw.subtitles)) {
    problems.add('INVALID_DOCUMENT', 'subtitles 必须是数组');
  }
  const parsedSubtitles = [];
  const subtitleCounts = new Map();
  for (const entry of rawSubtitles) {
    const parsed = parseSubtitle(entry, problems);
    if (!parsed.ok) continue;
    parsedSubtitles.push(parsed.value);
    subtitleCounts.set(parsed.value.id, (subtitleCounts.get(parsed.value.id) ?? 0) + 1);
  }
  for (const s of parsedSubtitles) {
    if (subtitleCounts.get(s.id) > 1) {
      problems.add('DUPLICATE_SUBTITLE_ID', `原始字幕编号 ${s.id} 出现 ${subtitleCounts.get(s.id)} 次,无法确定以哪条为准,均不纳入`, {
        targetId: s.id,
        language: s.language,
      });
      continue;
    }
    subtitles.set(s.id, {
      ...deepClone(s),
      status: 'active',
      history: [
        {
          kind: 'origin',
          version: 0,
          snapshot: deepClone(s),
        },
      ],
    });
  }

  // ---- 修订:结构校验与分组 ----
  const rawRevisions = Array.isArray(raw.revisions) ? raw.revisions : [];
  if (raw.revisions !== undefined && !Array.isArray(raw.revisions)) {
    problems.add('INVALID_DOCUMENT', 'revisions 必须是数组');
  }

  // revisionId -> Map(sig -> {count, sample})  用于重复/冲突判定
  const byRevisionId = new Map();
  // targetId -> 结构合法的修订数组
  const byTarget = new Map();

  rawRevisions.forEach((entry) => {
    const label = stableLabel(entry);
    let r;
    try {
      r = sanitize(entry, 'revision');
    } catch (err) {
      problems.add('INVALID_REVISION', `无法解析的修订(${label}): ${err.message}`, { sortKey: label });
      return;
    }
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      problems.add('INVALID_REVISION', `修订不是对象: ${label}`, { sortKey: label });
      return;
    }
    const missing = [];
    for (const field of ['revisionId', 'targetId', 'version', 'action']) {
      if (r[field] === undefined || r[field] === null) missing.push(field);
    }
    if (missing.length > 0) {
      problems.add(
        'INVALID_REVISION',
        `修订 ${r.revisionId ?? '(无编号)'} 缺少字段: ${missing.join('、')}`,
        { revisionId: normalizeId(r.revisionId), targetId: normalizeId(r.targetId), sortKey: label },
      );
      return;
    }
    if (!isNonEmptyId(r.revisionId) || !isNonEmptyId(r.targetId)) {
      problems.add('INVALID_REVISION', `修订 ${normalizeId(r.revisionId)} 的编号或目标编号无效`, {
        revisionId: normalizeId(r.revisionId),
        targetId: normalizeId(r.targetId),
        sortKey: label,
      });
      return;
    }
    const revisionId = normalizeId(r.revisionId);
    const targetId = normalizeId(r.targetId);
    if (!isInt(r.version) || toInt(r.version) <= 0) {
      problems.add('INVALID_REVISION', `修订 ${revisionId} 的版本号必须是正整数,收到: ${r.version}`, {
        revisionId,
        targetId,
      });
      return;
    }
    const action = normalizeAction(r.action);
    if (!action) {
      problems.add('INVALID_REVISION', `修订 ${revisionId} 的动作无效: ${r.action}(只支持 update/withdraw)`, {
        revisionId,
        targetId,
      });
      return;
    }

    // 登记到 revisionId 内容分组(包含动作与目标,换目标也算不同内容)
    const sig = signature({ targetId, version: toInt(r.version), action, payload: r.payload ?? null });
    let sigMap = byRevisionId.get(revisionId);
    if (!sigMap) {
      sigMap = new Map();
      byRevisionId.set(revisionId, sigMap);
    }
    const seen = sigMap.get(sig);
    if (seen) seen.count += 1;
    else sigMap.set(sig, { count: 1, revision: r, revisionId, targetId, version: toInt(r.version), action });

    const group = byTarget.get(targetId);
    if (!group) byTarget.set(targetId, [r]);
    else group.push(r);
  });

  // ---- 同一 revisionId:重复 vs 冲突 ----
  const conflictedRevisionIds = new Set(); // 这些修订任何变体都不生效
  for (const [revisionId, sigMap] of byRevisionId) {
    if (sigMap.size > 1) {
      const entries = [...sigMap.values()];
      const rawLabels = entries.map((v) => `v${v.version}/${v.action}`);
      const variantLabels = [...new Set(rawLabels)].sort();
      const allTargets = [...new Set(entries.map((v) => v.targetId))].sort();
      // 确定性选择归属目标:存在的字幕优先,再取编号最小者
      const existing = allTargets.filter((t) => subtitles.has(t));
      const anchorTarget = existing[0] ?? allTargets[0];
      // 若版本/动作标签不足以区分变体,说明差异在更新负载或目标上
      const variantText = variantLabels.length === entries.length
        ? `(${variantLabels.join('、')})`
        : `(版本/动作相同但目标或更新内容不同,共 ${entries.length} 份)`;
      problems.add(
        'REVISION_CONFLICT',
        `修订编号 ${revisionId} 对应 ${entries.length} 份互不相同的内容${variantText},全部不予生效`,
        {
          revisionId,
          targetId: anchorTarget,
          language: subtitles.has(anchorTarget) ? subtitles.get(anchorTarget).language : undefined,
          otherTargetIds: allTargets.filter((t) => t !== anchorTarget),
          sortKey: allTargets.join(','),
        },
      );
      conflictedRevisionIds.add(revisionId);
    } else {
      const [entry] = sigMap.values();
      if (entry.count > 1) {
        problems.add(
          'DUPLICATE_REVISION',
          `修订 ${revisionId}(目标字幕 ${entry.targetId},v${entry.version})重复出现 ${entry.count} 次,只生效一次`,
          {
            revisionId,
            targetId: entry.targetId,
            version: entry.version,
            language: subtitles.has(entry.targetId) ? subtitles.get(entry.targetId).language : undefined,
          },
        );
      }
    }
  }

  // ---- 孤立修订:目标字幕不存在 ----
  const danglingTargets = new Set();
  for (const targetId of byTarget.keys()) {
    if (!subtitles.has(targetId)) {
      danglingTargets.add(targetId);
      const revs = byTarget.get(targetId);
      const ids = [...new Set(revs.map((r) => normalizeId(r.revisionId)))].sort();
      problems.add(
        'DANGLING_REVISION',
        `有 ${ids.length} 条修订引用了不存在的字幕 ${targetId}: ${ids.join('、')}`,
        { targetId, sortKey: ids.join(',') },
      );
    }
  }

  // ---- 按目标应用修订(版本升序),并检查版本缺口/同版异内容/撤回后修改 ----
  for (const [targetId, revs] of byTarget.entries()) {
    if (!subtitles.has(targetId)) continue; // 孤立目标已报错,不参与应用
    const target = subtitles.get(targetId);

    // 按 (revisionId, 内容签名) 去重;冲突修订保留每个不同变体各一条
    const candidates = [];
    const seenCandidate = new Set();
    for (const r of revs) {
      const revisionId = normalizeId(r.revisionId);
      const sig = signature({
        targetId,
        version: toInt(r.version),
        action: normalizeAction(r.action),
        payload: r.payload ?? null,
      });
      const key = `${revisionId} ${sig}`;
      if (seenCandidate.has(key)) continue;
      seenCandidate.add(key);
      candidates.push({ r, revisionId, conflicted: conflictedRevisionIds.has(revisionId) });
    }

    // 版本 -> 该版本下的候选修订(理论上一版一条;多条即异常)
    const byVersion = new Map();
    for (const c of candidates) {
      const v = toInt(c.r.version);
      if (!byVersion.has(v)) byVersion.set(v, []);
      byVersion.get(v).push(c);
    }
    const versions = [...byVersion.keys()].sort((a, b) => a - b);

    // 版本缺口:版本号必须从 1 起连续(冲突修订也占用其版本号)
    if (versions.length > 0) {
      const maxV = versions[versions.length - 1];
      for (let v = 1; v < maxV; v++) {
        if (!byVersion.has(v)) {
          problems.add('VERSION_GAP', `字幕 ${targetId} 的修订序列缺少版本 v${v}(现有最高版本 v${maxV})`, {
            targetId,
            language: target.language,
            version: v,
          });
        }
      }
    }

    // 同版本多条不同修订编号 → DUPLICATE_VERSION(同号异内容已在冲突阶段处理)
    for (const [v, list] of byVersion.entries()) {
      const distinctIds = new Set(list.filter((c) => !c.conflicted).map((c) => c.revisionId));
      if (distinctIds.size > 1) {
        problems.add(
          'DUPLICATE_VERSION',
          `字幕 ${targetId} 的版本 v${v} 对应多条不同修订: ${[...distinctIds].sort().join('、')}`,
          { targetId, language: target.language, version: v, sortKey: [...distinctIds].sort().join(',') },
        );
      }
    }

    const snapshotOf = () => ({
      id: target.id,
      language: target.language,
      startFrame: target.startFrame,
      endFrame: target.endFrame,
      text: target.text,
      speaker: target.speaker,
    });

    // 逐版本应用;同版本多条时全部跳过(已报 DUPLICATE_VERSION),保证结果确定
    let withdrawnAt = null; // 生效撤回所在版本
    for (const v of versions) {
      const list = byVersion.get(v);
      const goodIds = new Set(list.filter((c) => !c.conflicted).map((c) => c.revisionId));
      const ambiguous = goodIds.size > 1;

      for (const c of list) {
        const { r, revisionId, conflicted } = c;
        const action = normalizeAction(r.action);
        const baseRecord = { kind: 'revision', revisionId, version: v, action };

        if (conflicted) {
          target.history.push({ ...baseRecord, status: 'conflicted', payload: extractPayload(r) });
          continue;
        }
        if (ambiguous) {
          target.history.push({ ...baseRecord, status: 'skipped_duplicate_version', payload: extractPayload(r) });
          continue;
        }
        if (withdrawnAt !== null) {
          problems.add(
            'REVISION_AFTER_WITHDRAW',
            `字幕 ${targetId} 已在 v${withdrawnAt} 被撤回,修订 ${revisionId}(v${v})仍然尝试修改,已忽略`,
            { targetId, language: target.language, revisionId, version: v },
          );
          target.history.push({ ...baseRecord, status: 'after_withdraw', payload: extractPayload(r) });
          continue;
        }

        if (action === WITHDRAW) {
          if (r.payload !== undefined && r.payload !== null) {
            problems.add('INVALID_REVISION_PAYLOAD', `撤回修订 ${revisionId}(v${v})不应携带更新内容`, {
              revisionId, targetId, version: v,
            });
            target.history.push({ ...baseRecord, status: 'invalid_payload', payload: extractPayload(r) });
            continue;
          }
          target.status = 'withdrawn';
          withdrawnAt = v;
          target.history.push({ ...baseRecord, status: 'applied', payload: null, snapshot: snapshotOf() });
          continue;
        }

        // update
        const parsedPayload = parsePayload(r.payload, revisionId, targetId, problems);
        if (!parsedPayload.ok) {
          target.history.push({
            ...baseRecord,
            status: 'invalid_payload',
            payload: r.payload === undefined ? null : deepClone(r.payload),
          });
          continue;
        }
        Object.assign(target, parsedPayload.value);
        target.history.push({
          ...baseRecord,
          status: 'applied',
          payload: deepClone(parsedPayload.value),
          snapshot: snapshotOf(),
        });
      }
    }
  }

  return finalize(frameRate, subtitles, problems, danglingTargets);
}

function extractPayload(r) {
  return r.payload === undefined || r.payload === null ? null : deepClone(r.payload);
}

function finalize(frameRate, subtitles, problems, danglingTargets) {
  return {
    frameRate,
    subtitles,
    issues: problems.items,
    danglingTargets,
  };
}

module.exports = { merge, UPDATE, WITHDRAW, isInt, toInt, normalizeId };
