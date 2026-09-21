// 时差对照：任选两条档案，算出标准偏移差、眼下夏令时状态、各时段时差、
// 当地日期最多差几天，以及翻日与夏令时切换的边界落在当地几点。
//
// 夏令时切换时刻按真实习惯读：开始规则的小时按标准时钟读（例如纽约凌晨两点拨到三点），
// 结束规则的小时按夏令时钟读（例如纽约凌晨两点倒回一点），种子档案的备注也是这个口径。
const { load, WEEKDAY_NAMES, MONTH_NAMES, MIN_YEAR, MAX_YEAR } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DAY_MS = 86400000;
const pad = (num) => String(num).padStart(2, '0');

// 第几个星期几：一到四直接顺推，最后一个从月底往回找
function nthWeekdayOfMonth(year, month, week, weekday) {
  if (week === 'last') {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const cur = new Date(Date.UTC(year, month - 1, lastDay));
    const diff = (cur.getUTCDay() - weekday + 7) % 7;
    return lastDay - diff;
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return 1 + offset + (Number(week) - 1) * 7;
}

// 规则里的时刻按指定偏移折算成基准时刻（UTC 毫秒）
function ruleInstantMs(year, part, offsetMinutes) {
  const day = nthWeekdayOfMonth(year, part.month, part.week, part.weekday);
  const wallMs = Date.UTC(year, part.month - 1, day, part.hour, part.minute);
  return wallMs - offsetMinutes * 60000;
}

function hasUsableDstRule(zone) {
  return zone.usesDst && zone.dstOffsetMinutes !== null && zone.dstStart && zone.dstEnd;
}

// 该档案在某一年里处在夏令时的时段（UTC 毫秒的半开区间），南半球跨年会给出两段并裁齐年界
function dstSegmentsForYear(zone, year) {
  if (!hasUsableDstRule(zone) || year < zone.fromYear || (zone.toYear !== null && year > zone.toYear)) {
    return [];
  }
  const yearStart = Date.UTC(year, 0, 1);
  const nextYearStart = Date.UTC(year + 1, 0, 1);
  // 开始按标准时钟，结束按夏令时钟
  const startMs = ruleInstantMs(year, zone.dstStart, zone.offsetMinutes);
  const endMs = ruleInstantMs(year, zone.dstEnd, zone.dstOffsetMinutes);
  const clip = (s, e) => {
    const cs = Math.max(s, yearStart);
    const ce = Math.min(e, nextYearStart);
    if (ce <= cs) return [];
    return [{
      startMs: cs,
      endMs: ce,
      carryIn: cs === yearStart && s < yearStart,
      carryOut: ce === nextYearStart && e > nextYearStart,
    }];
  };

  if (zone.dstStart.month > zone.dstEnd.month) {
    // 南半球跨年：年初延续去年开始的夏令时，入秋结束，年底再开始一段跨到下一年
    return [
      ...clip(yearStart - DAY_MS, endMs),
      ...clip(startMs, nextYearStart + DAY_MS),
    ];
  }
  if (endMs <= startMs) return clip(startMs, nextYearStart + DAY_MS);
  return clip(startMs, endMs);
}

// 某一基准时刻是否落在夏令时时段内（开始那一刻含、结束那一刻不含）
function dstActiveAt(zone, ms) {
  const year = new Date(ms).getUTCFullYear();
  return dstSegmentsForYear(zone, year).some((seg) => ms >= seg.startMs && ms < seg.endMs);
}

function activeOffsetMinutes(zone, ms) {
  return dstActiveAt(zone, ms) ? zone.dstOffsetMinutes : zone.offsetMinutes;
}

function activeMode(zone, ms) {
  return dstActiveAt(zone, ms) ? '夏令时' : '标准';
}

// 把基准时刻按某一边的偏移（或其夏令时偏移）写成当地日期与时刻
function localStamp(ms, zone, mode) {
  const offset = mode === '夏令时' ? zone.dstOffsetMinutes : zone.offsetMinutes;
  const d = new Date(ms + offset * 60000);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    mode,
  };
}

function clockText(minutes) {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

function durationText(minutes) {
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute || !hour) parts.push(`${minute} 分`);
  return parts.join(' ');
}

// 时差的中文写法：说清谁早谁晚，整小时只写小时，余出分钟一并写出
function relativeText(diffMinutes, ahead, behind) {
  if (diffMinutes === 0) return `${ahead.name} 与 ${behind.name} 同时，没有时差`;
  const relation = diffMinutes > 0 ? '早' : '晚';
  return `${ahead.name} 比 ${behind.name}${relation} ${durationText(diffMinutes)}`;
}

function diffParts(minutes) {
  return { sign: minutes < 0 ? '-' : '+', hours: Math.floor(Math.abs(minutes) / 60), minutes: Math.abs(minutes) % 60 };
}

// 切换规则的文字描述，例如「三月第二个周日 02:00」
function ruleText(part) {
  const weekText = part.week === 'last' ? '最后一个' : `第${['一', '二', '三', '四'][Number(part.week) - 1]}个`;
  return `${MONTH_NAMES[part.month - 1]}${weekText}${WEEKDAY_NAMES[part.weekday]} ${pad(part.hour)}:${pad(part.minute)}`;
}

function validateYear(value) {
  if (value === undefined || value === null || value === '') return new Date().getUTCFullYear();
  const year = Number(pickText(String(value)));
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new ApiError(400, 'YEAR_INVALID', `对照年份要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, 'year');
  }
  return year;
}

// 一年里某条档案各次夏令时切换的边界，标准时钟与夏令时钟两种读法都给出来
function buildSwitches(zone, year) {
  if (!zone.usesDst) return null;
  const jump = zone.dstOffsetMinutes - zone.offsetMinutes;
  const result = {
    sideId: zone.id,
    name: zone.name,
    displayName: zone.displayName,
    startRuleText: zone.dstStart ? ruleText(zone.dstStart) : '',
    endRuleText: zone.dstEnd ? ruleText(zone.dstEnd) : '',
    jumpMinutes: jump,
    jumpText: `钟拨快 ${durationText(jump)}`,
    expired: zone.toYear !== null && zone.toYear < year,
    activeInYear: false,
    segments: [],
  };
  const segments = dstSegmentsForYear(zone, year);
  if (!segments.length) return result;
  result.activeInYear = true;
  result.segments = segments.map((seg) => ({
    carryIn: seg.carryIn,
    carryOut: seg.carryOut,
    // 开始：标准时钟走到 start.standard 那一刻直接跳到 start.daylight
    start: {
      standard: localStamp(seg.startMs, zone, '标准'),
      daylight: localStamp(seg.startMs, zone, '夏令时'),
    },
    // 结束：夏令时钟走到 end.daylight 那一刻倒回 end.standard
    end: {
      daylight: localStamp(seg.endMs, zone, '夏令时'),
      standard: localStamp(seg.endMs, zone, '标准'),
    },
  }));
  return result;
}

// 对照：主入口
function compare(options) {
  const input = options && typeof options === 'object' ? options : {};
  const aId = pickText(input.aZoneId);
  const bId = pickText(input.bZoneId);
  if (!aId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择第一条时区档案', 'aZoneId');
  if (!bId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择第二条时区档案', 'bZoneId');
  const year = validateYear(input.year);

  const data = load();
  const a = data.zones.find((item) => item.id === aId);
  if (!a) throw new ApiError(404, 'ZONE_NOT_FOUND', '第一条时区档案不存在或已被删除', 'aZoneId');
  const b = data.zones.find((item) => item.id === bId);
  if (!b) throw new ApiError(404, 'ZONE_NOT_FOUND', '第二条时区档案不存在或已被删除', 'bZoneId');

  const self = a.id === b.id;
  const nowMs = Date.now();
  const nowYear = new Date(nowMs).getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const nextYearStart = Date.UTC(year + 1, 0, 1);

  const standardDiff = b.offsetMinutes - a.offsetMinutes;

  // 以两边所有切换时刻为分界，逐段求这一年真正出现过的状态组合与时差
  const changePoints = [a, b].flatMap((zone) => dstSegmentsForYear(zone, year)
    .flatMap((seg) => [seg.startMs, seg.endMs])
    .filter((ms) => ms > yearStart && ms < nextYearStart));
  const points = Array.from(new Set(changePoints)).sort((x, y) => x - y);
  const bounds = [yearStart, ...points, nextYearStart];
  const intervals = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const startMs = bounds[i];
    const endMs = bounds[i + 1];
    const sampleMs = Math.floor(startMs + (endMs - startMs) / 2);
    const aMode = activeMode(a, sampleMs);
    const bMode = activeMode(b, sampleMs);
    const diff = activeOffsetMinutes(b, sampleMs) - activeOffsetMinutes(a, sampleMs);
    const last = intervals[intervals.length - 1];
    if (last && last.aMode === aMode && last.bMode === bMode && last.diffMinutes === diff) {
      last.endMs = endMs;
    } else {
      intervals.push({ startMs, endMs, aMode, bMode, diffMinutes: diff });
    }
  }

  // 各段的当地日期差与翻日边界。同一时差错开的每个公历日里，有一段时间两地日期会相差一天
  const segments = intervals.map((seg) => {
    const diff = seg.diffMinutes;
    const mod = ((diff % 1440) + 1440) % 1440;
    const minDays = Math.floor(diff / 1440);
    const maxDays = Math.ceil(diff / 1440);
    const forwardDays = Math.max(maxDays, 0);
    const backwardDays = Math.max(-minDays, 0);
    let flip;
    if (diff === 0) {
      flip = {
        kind: 'same',
        text: '两边时钟完全一致，在各自当地 00:00 同时翻日，日期始终相同',
      };
    } else {
      const leader = diff > 0 ? b : a;
      const lagger = diff > 0 ? a : b;
      // 每天从先走的一边 00:00 翻日起，到后走的一边也 00:00 翻日止，日期多差一天
      const apartMinutes = diff > 0 ? mod : 1440 - mod;
      const alignMinutes = 1440 - apartMinutes;
      const leaderFirst = mod === 0
        ? `${leader.name} 在当地 00:00 翻到新的一天时，${lagger.name} 时钟同样指向 00:00，但还停在前一天`
        : `${leader.name} 当地 00:00 翻到新的一天时，${lagger.name} 当地还停在前一天的 ${clockText(1440 - mod)}`;
      const laggerCatch = mod === 0
        ? `等到 ${lagger.name} 当地 00:00 翻日时，${leader.name} 时钟也指向 00:00，却已经是再后一天的日期`
        : `等到 ${lagger.name} 当地 00:00 翻日时，${leader.name} 当地已经是当天的 ${clockText(mod)}，两边日期重新对齐`;
      flip = {
        kind: mod === 0 ? 'wholeDay' : 'normal',
        leaderName: leader.name,
        laggerName: lagger.name,
        leaderMidnightLaggerClock: clockText(1440 - mod),
        laggerMidnightLeaderClock: clockText(mod),
        apartMinutes,
        apartText: durationText(apartMinutes),
        alignMinutes,
        alignText: durationText(alignMinutes),
        leaderFirstText: leaderFirst,
        laggerCatchText: laggerCatch,
        alwaysApart: mod === 0,
      };
    }
    let gapText;
    if (diff === 0) {
      gapText = '两边当地日期始终相同';
    } else if (mod === 0) {
      const days = diff / 1440;
      gapText = days > 0
        ? `${b.name} 的当地日期始终比 ${a.name} 后 ${days} 天，不存在重新对齐的时候`
        : `${b.name} 的当地日期始终比 ${a.name} 前 ${-days} 天，不存在重新对齐的时候`;
    } else {
      const dayText = (days) => (days === 0
        ? '两边日期相同'
        : days > 0
          ? `${b.name} 的日期比 ${a.name} 后 ${days} 天`
          : `${b.name} 的日期比 ${a.name} 前 ${-days} 天`);
      // 先走的一边已翻日、后走的一边还没翻的这段，日期差取较大的那个值
      const apartDays = diff > 0 ? maxDays : minDays;
      const alignDays = diff > 0 ? minDays : maxDays;
      gapText = `每个公历日里有 ${flip.apartText}（从先走的一边翻日起，到后走的一边也翻日止），${dayText(apartDays)}；其余 ${flip.alignText}，${dayText(alignDays)}`;
    }
    return {
      startStamp: {
        atYearStart: seg.startMs === yearStart,
        a: localStamp(seg.startMs, a, activeMode(a, seg.startMs)),
        b: localStamp(seg.startMs, b, activeMode(b, seg.startMs)),
      },
      endStamp: {
        atYearEnd: seg.endMs === nextYearStart,
        a: localStamp(seg.endMs - 1, a, activeMode(a, seg.endMs - 1)),
        b: localStamp(seg.endMs - 1, b, activeMode(b, seg.endMs - 1)),
      },
      aMode: seg.aMode,
      bMode: seg.bMode,
      diffMinutes: diff,
      diffParts: diffParts(diff),
      gap: {
        minDays,
        maxDays,
        forwardDays,
        backwardDays,
        text: gapText,
      },
      flip,
    };
  });

  const maxForwardDays = segments.reduce((acc, seg) => Math.max(acc, seg.gap.forwardDays), 0);
  const maxBackwardDays = segments.reduce((acc, seg) => Math.max(acc, seg.gap.backwardDays), 0);
  const maxDateGapDays = Math.max(maxForwardDays, maxBackwardDays);

  // 四种状态组合在这一年里是否真的出现，时差各是多少
  const pairKey = (am, bm) => `${am === '夏令时'}:${bm === '夏令时'}`;
  const occurring = new Set(intervals.map((seg) => pairKey(seg.aMode, seg.bMode)));
  const buildCase = (key, aInDst, bInDst, label) => {
    const occurs = occurring.has(pairKey(aInDst ? '夏令时' : '标准', bInDst ? '夏令时' : '标准'));
    const aOff = aInDst ? a.dstOffsetMinutes : a.offsetMinutes;
    const bOff = bInDst ? b.dstOffsetMinutes : b.offsetMinutes;
    const diff = bOff - aOff;
    return {
      key,
      label,
      occurs,
      diffMinutes: diff,
      diffParts: diffParts(diff),
      text: occurs ? relativeText(diff, b, a) : '这一年里不会出现这种状态组合',
    };
  };
  const dstCases = [
    buildCase('standard', false, false, '两边都按标准时间'),
    buildCase('aOnly', true, false, `只有 ${a.name} 处在夏令时`),
    buildCase('bOnly', false, true, `只有 ${b.name} 处在夏令时`),
    buildCase('both', true, true, '两边同时处在夏令时'),
  ];

  // 当前状态
  const aActiveNow = dstActiveAt(a, nowMs);
  const bActiveNow = dstActiveAt(b, nowMs);
  const currentDiff = activeOffsetMinutes(b, nowMs) - activeOffsetMinutes(a, nowMs);

  const sideStatusText = (zone, activeNow) => {
    if (!zone.usesDst) return '不实行夏令时';
    if (zone.toYear !== null && nowYear > zone.toYear) return `夏令时规则只生效到 ${zone.toYear} 年，目前按标准时间走`;
    return activeNow ? '正处在夏令时生效期内' : '不在夏令时生效期内，按标准时间走';
  };

  const sideInfo = (zone, activeNow) => ({
    id: zone.id,
    name: zone.name,
    displayName: zone.displayName,
    usesDst: zone.usesDst,
    dstExpired: zone.usesDst && zone.toYear !== null && nowYear > zone.toYear,
    standardOffsetMinutes: zone.offsetMinutes,
    standardOffsetText: offsetText(zone.offsetMinutes),
    dstOffsetMinutes: zone.dstOffsetMinutes,
    dstOffsetText: zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    activeNow,
    activeOffsetMinutes: activeNow ? zone.dstOffsetMinutes : zone.offsetMinutes,
    activeOffsetText: offsetText(activeNow ? zone.dstOffsetMinutes : zone.offsetMinutes),
    modeNow: activeNow ? '夏令时' : '标准',
    statusText: sideStatusText(zone, activeNow),
  });

  // 同一条档案与自己对照，或两条标准偏移相同的档案，单独给一句明确结论
  let special = null;
  if (self) {
    special = {
      code: 'SELF',
      text: '这是同一条档案与自己对照：标准偏移差为零，夏令时状态也完全相同，任何时刻都是零时差，当地日期永远相同。',
    };
  } else if (standardDiff === 0) {
    const aHas = dstSegmentsForYear(a, year).length > 0;
    const bHas = dstSegmentsForYear(b, year).length > 0;
    if (!aHas && !bHas) {
      special = {
        code: 'SAME_OFFSET_NONE_DST',
        text: `两条档案的标准偏移相同（都是 ${offsetText(a.offsetMinutes)}），${year} 年里两边都没有夏令时生效期，全年时差都是零。`,
      };
    } else {
      const aJump = aHas ? durationText(a.dstOffsetMinutes - a.offsetMinutes) : '';
      const bJump = bHas ? durationText(b.dstOffsetMinutes - b.offsetMinutes) : '';
      const parts = [`两条档案的标准偏移相同（都是 ${offsetText(a.offsetMinutes)}），两边都按标准时间时没有时差。`];
      if (aHas) parts.push(`${a.name} 单独处在夏令时（钟拨快 ${aJump}）的时段，${b.name} 比 ${a.name} 晚 ${aJump}；`);
      if (bHas) parts.push(`${b.name} 单独处在夏令时（钟拨快 ${bJump}）的时段，${b.name} 比 ${a.name} 早 ${bJump}；`);
      if (aHas && bHas) parts.push('两边同时处在夏令时的时段，各自拨快的钟互相抵消，时差又回到零。');
      parts.push('具体落在一年里的哪些时段，见下方的夏令时切换边界与年内时差分段。');
      special = { code: 'SAME_OFFSET_WITH_DST', text: parts.join('') };
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    year,
    self,
    a: sideInfo(a, aActiveNow),
    b: sideInfo(b, bActiveNow),
    standard: {
      diffMinutes: standardDiff,
      diffParts: diffParts(standardDiff),
      offsetText: `${offsetText(a.offsetMinutes)} 对 ${offsetText(b.offsetMinutes)}`,
      text: self ? '同一条档案，标准偏移差为零' : relativeText(standardDiff, b, a),
    },
    current: {
      aInDst: aActiveNow,
      bInDst: bActiveNow,
      anyInDst: aActiveNow || bActiveNow,
      diffMinutes: currentDiff,
      diffParts: diffParts(currentDiff),
      text: self
        ? '同一条档案与自己对照，当前也是零时差'
        : `当前 ${a.name}${sideStatusText(a, aActiveNow)}；${b.name}${sideStatusText(b, bActiveNow)}。此刻${relativeText(currentDiff, b, a)}。`,
    },
    dstCases,
    special,
    dateGap: {
      maxDateGapDays,
      maxForwardDays,
      maxBackwardDays,
      summaryText: self
        ? '同一条档案，当地日期永远相同'
        : maxDateGapDays === 0
          ? '这一年里两地的当地日期始终相同，不存在谁翻到前一天或后一天的情况'
          : [
              `这一年里两地当地日期最多相差 ${maxDateGapDays} 天：`,
              maxForwardDays > 0 ? `${b.name} 最多比 ${a.name} 后 ${maxForwardDays} 天；` : '',
              maxBackwardDays > 0 ? `${b.name} 最多比 ${a.name} 前 ${maxBackwardDays} 天；` : '',
              '各段从什么时刻开始错开、什么时刻重新对齐，见下方分段。',
            ].filter(Boolean).join(''),
      segments,
    },
    switches: [buildSwitches(a, year), buildSwitches(b, year)].filter(Boolean),
  };
}

module.exports = {
  compare,
  dstSegmentsForYear,
  dstActiveAt,
  nthWeekdayOfMonth,
  ruleInstantMs,
  relativeText,
};
