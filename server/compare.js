// 时差对照：任选两条档案，算清标准偏移差、夏令时生效期间时差怎么变、
// 一年里哪些时段是哪个时差，以及两地当地日期最多能差几天、翻到前后一天时各自是当地几点
const { load, MIN_YEAR, MAX_YEAR } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const pad = (num) => String(num).padStart(2, '0');

// 把"第几个星期几"换算成具体日期：一到四取第 n 个，last 取当月最后一个
function nthWeekdayOfMonth(year, month, weekday, week) {
  if (week === 'last') {
    // Date.UTC 的日填 0 得到上个月最后一天，month 是一到十二的数字
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let day = lastDay;
    while (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== weekday) day -= 1;
    return day;
  }
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (Number(week) - 1) * 7;
  return day;
}

// 一段切换规则落在某一年的具体 UTC 时刻。
// 开始段上的时分是标准时钟面，结束段上的时分是夏令时钟面（例如纽约结束写两点，
// 指的是快一小时的那个两点拨回一点），折算时分别减各自的偏移
function transitionMs(zone, part, year, kind) {
  const day = nthWeekdayOfMonth(year, part.month, part.weekday, part.week);
  const localMs = Date.UTC(year, part.month - 1, day, part.hour, part.minute);
  const baseOffset = kind === 'end' ? zone.dstOffsetMinutes : zone.offsetMinutes;
  return localMs - baseOffset * MINUTE_MS;
}

// 这一年夏令时是否生效（null 表示规则在这一年不适用：早于开始年份或晚于结束年份）。
// 开始月份晚于结束月份表示跨年（南半球）：年初可能还落在上一年十月开始的那一段里
function dstActiveAt(zone, ms, year) {
  if (!zone.usesDst || year < zone.fromYear) return null;
  if (zone.toYear !== null && year > zone.toYear) return null;

  const inWindow = (startMs, endMs) => ms >= startMs && ms < endMs;
  if (zone.dstEnd.month < zone.dstStart.month) {
    // 跨年规则：年内任意时刻要么落在上一年十月到本年四月这段，要么落在本年十月到下一年四月这段
    const endingThisYear = inWindow(transitionMs(zone, zone.dstStart, year - 1, 'start'),
      transitionMs(zone, zone.dstEnd, year, 'end'));
    const startingThisYear = inWindow(transitionMs(zone, zone.dstStart, year, 'start'),
      transitionMs(zone, zone.dstEnd, year + 1, 'end'));
    return endingThisYear || startingThisYear;
  }
  return inWindow(transitionMs(zone, zone.dstStart, year, 'start'),
    transitionMs(zone, zone.dstEnd, year, 'end'));
}

// 取某一侧在给定时刻的实际偏移；规则不适用的年份只认标准偏移
function offsetAt(zone, ms, year) {
  return dstActiveAt(zone, ms, year) === true ? zone.dstOffsetMinutes : zone.offsetMinutes;
}

// 一条档案在选定年份之内的全部切换边界（跨年规则年初那段在上一年，不在年内的不收）
function yearBoundaries(zone, year) {
  if (!zone.usesDst || year < zone.fromYear) return [];
  if (zone.toYear !== null && year > zone.toYear) return [];

  const yearStart = Date.UTC(year, 0, 1);
  const nextYearStart = Date.UTC(year + 1, 0, 1);
  const marks = [];
  const push = (ms, kind) => {
    if (ms >= yearStart && ms < nextYearStart) marks.push({ ms, kind });
  };
  if (zone.dstEnd.month < zone.dstStart.month) {
    // 跨年：年初结束夏令时，年尾再开始
    push(transitionMs(zone, zone.dstEnd, year, 'end'), 'end');
    push(transitionMs(zone, zone.dstStart, year, 'start'), 'start');
  } else {
    push(transitionMs(zone, zone.dstStart, year, 'start'), 'start');
    push(transitionMs(zone, zone.dstEnd, year, 'end'), 'end');
  }
  return marks;
}

// 时差写法：正数表示乙地比甲地靠前（钟面更大），整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '零时差，两地时刻相同';
  const sign = minutes > 0 ? '靠前' : '靠后';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `乙地比甲地${sign} ${parts.join(' ')}`;
}

function activeText(active) {
  if (active === null) return '夏令时规则在这一年不适用，全年按标准偏移';
  return active ? '正处在夏令时生效期内' : '处在夏令时休歇期';
}

// 把 UTC 毫秒写成"某年某月某日 时分 UTC"，跨年的端点标出次年
function pointText(ms, year) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const suffix = y === year ? '' : y === year + 1 ? '（次年）' : `（${y} 年）`;
  return `${y} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC${suffix}`;
}

// 切换边界说明：开始段是标准钟面拨到夏令钟面，结束段是夏令钟面拨回标准钟面
function transitionNote(zone, kind) {
  const part = kind === 'end' ? zone.dstEnd : zone.dstStart;
  const shift = zone.dstOffsetMinutes - zone.offsetMinutes;
  const reading = part.hour * 60 + part.minute;
  const wrap = (value) => {
    const wrapped = ((value % 1440) + 1440) % 1440;
    return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
  };
  const before = `${pad(part.hour)}:${pad(part.minute)}`;
  if (kind === 'end') {
    return `当地钟面 ${before}（夏令时）拨回 ${wrap(reading - shift)}（标准时），夏令时结束`;
  }
  return `当地钟面 ${before}（标准时）拨到 ${wrap(reading + shift)}（夏令时），夏令时开始`;
}

// 把选定年份切成若干段：收集两侧所有边界，段内各侧偏移恒定，逐段算实际时差；
// 边界本身单独记一笔切换说明。返回的每一段都标明两侧是否处在夏令时
function buildSegments(zoneA, zoneB, year) {
  const yearStart = Date.UTC(year, 0, 1);
  const nextYearStart = Date.UTC(year + 1, 0, 1);

  const marks = [];
  [{ zone: zoneA, tag: 'a' }, { zone: zoneB, tag: 'b' }].forEach(({ zone, tag }) => {
    yearBoundaries(zone, year).forEach((b) => marks.push({ ...b, tag }));
  });
  marks.sort((x, y) => x.ms - y.ms);

  const segments = [];
  const pushSpan = (fromMs, toMs) => {
    const probe = fromMs + MINUTE_MS; // 取段内一分钟，避开切换瞬间本身
    const aDst = dstActiveAt(zoneA, probe, year) === true;
    const bDst = dstActiveAt(zoneB, probe, year) === true;
    const aOffset = aDst ? zoneA.dstOffsetMinutes : zoneA.offsetMinutes;
    const bOffset = bDst ? zoneB.dstOffsetMinutes : zoneB.offsetMinutes;
    const diff = bOffset - aOffset;
    segments.push({
      type: 'span',
      fromMs,
      toMs,
      fromText: pointText(fromMs, year),
      toText: pointText(toMs, year),
      aOffsetMinutes: aOffset,
      bOffsetMinutes: bOffset,
      aDst,
      bDst,
      diffMinutes: diff,
      diffText: diffText(diff),
    });
  };

  let cursor = yearStart;
  marks.forEach((mark) => {
    if (mark.ms > cursor) pushSpan(cursor, mark.ms);
    const zone = mark.tag === 'a' ? zoneA : zoneB;
    segments.push({
      type: 'switch',
      ms: mark.ms,
      atText: pointText(mark.ms, year),
      side: mark.tag,
      sideText: mark.tag === 'a' ? '甲地' : '乙地',
      zoneName: zone.name,
      note: transitionNote(zone, mark.kind),
    });
    cursor = mark.ms;
  });
  if (cursor < nextYearStart) pushSpan(cursor, nextYearStart);

  return segments;
}

// 标准/夏令四种偏移组合，并用年内时段标出哪些组合在选定年份真的会同时出现
function buildCombos(zoneA, zoneB, segments) {
  const modesOf = (zone) => (zone.usesDst
    ? [{ label: '标准时', offset: zone.offsetMinutes, dst: false },
       { label: '夏令时', offset: zone.dstOffsetMinutes, dst: true }]
    : [{ label: '不实行夏令时', offset: zone.offsetMinutes, dst: false }]);
  const occurring = new Set(segments
    .filter((s) => s.type === 'span')
    .map((s) => `${s.aOffsetMinutes}|${s.bOffsetMinutes}`));

  const combos = [];
  modesOf(zoneA).forEach((am) => {
    modesOf(zoneB).forEach((bm) => {
      const diff = bm.offset - am.offset;
      combos.push({
        title: `甲地${am.label}、乙地${bm.label}`,
        aMode: am.label,
        bMode: bm.label,
        aOffsetMinutes: am.offset,
        bOffsetMinutes: bm.offset,
        diffMinutes: diff,
        diffText: diffText(diff),
        occurs: occurring.has(`${am.offset}|${bm.offset}`),
      });
    });
  });
  return combos;
}

// 标准偏移相同、恰好一边实行夏令时而另一边不实行：写明年内时差变成多少、落在哪些时段
function buildEqualStandardNote(zoneA, zoneB, segments) {
  if (zoneA.offsetMinutes !== zoneB.offsetMinutes) return null;
  const dstSideA = zoneA.usesDst && !zoneB.usesDst;
  const dstSideB = zoneB.usesDst && !zoneA.usesDst;
  if (!dstSideA && !dstSideB) return null;

  const dstZone = dstSideA ? zoneA : zoneB;
  const shift = dstZone.dstOffsetMinutes - dstZone.offsetMinutes;
  const windows = segments
    .filter((s) => s.type === 'span' && s.diffMinutes !== 0)
    .map((s) => ({ fromText: s.fromText, toText: s.toText, diffMinutes: s.diffMinutes, diffText: s.diffText }));

  const shiftText = Math.abs(shift) >= 60
    ? `${Math.floor(Math.abs(shift) / 60)} 小时${Math.abs(shift) % 60 ? ` ${Math.abs(shift) % 60} 分` : ''}`
    : `${Math.abs(shift)} 分`;
  const summary = windows.length
    ? `两地标准偏移同为 ${offsetText(zoneA.offsetMinutes)}，${dstSideA ? '甲地' : '乙地'} ${dstZone.name} `
      + `实行夏令时而另一侧不实行：下列时段里 ${dstSideA ? '甲地拨快、乙地不动，乙地比甲地靠后' : '乙地拨快、甲地不动，乙地比甲地靠前'} ${shiftText}，其余时段零时差`
    : `两地标准偏移同为 ${offsetText(zoneA.offsetMinutes)}，${dstSideA ? '甲地' : '乙地'} ${dstZone.name} `
      + '虽登记了夏令时规则，但选定年份不在生效年份区间内，这一年全年零时差';

  return {
    dstSide: dstSideA ? 'a' : 'b',
    dstSideText: dstSideA ? '甲地' : '乙地',
    shiftMinutes: shift,
    shiftText,
    windows,
    summary,
  };
}

// 当地日期最多差几天：只按选定年份里真的同时出现过的两侧偏移组合统计。
// 偏移差为 D 分钟时，日期差在 floor(D/1440) 与 ceil(D/1440) 之间取值，跨度上限取后者
function buildDateGap(zoneA, zoneB, segments) {
  const pairs = new Set(segments
    .filter((s) => s.type === 'span')
    .map((s) => `${s.aOffsetMinutes}|${s.bOffsetMinutes}`));
  const diffs = [...pairs].map((key) => {
    const [a, b] = key.split('|').map(Number);
    return { diff: b - a, a, b };
  });

  let minEntry = diffs[0];
  let maxEntry = diffs[0];
  diffs.forEach((entry) => {
    if (entry.diff < minEntry.diff) minEntry = entry;
    if (entry.diff > maxEntry.diff) maxEntry = entry;
  });

  const maxAbs = Math.max(Math.abs(minEntry.diff), Math.abs(maxEntry.diff));
  const maxDays = Math.ceil(maxAbs / 1440);
  return { minEntry, maxEntry, maxDays };
}

// 翻日边界：D 为乙减甲的分钟差。
// 乙靠前（D>0）时：乙到当地 00:00 那一刻差距最大，甲的钟面是 (1440-D%1440)%1440；
//   甲到当地 00:00 时差距收拢，乙的钟面是 D%1440。
// 乙靠后（D<0）时把甲乙互换，结论对称。
function clockText(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

function buildDateBoundaries(zoneA, zoneB, gap) {
  const list = [];
  const { minEntry, maxEntry, maxDays } = gap;

  if (maxEntry.diff > 0) {
    const d = maxEntry.diff;
    const lead = Math.ceil(d / 1440);
    const openClock = clockText(-d); // 乙翻到新一天 00:00 时，甲的钟面
    const closeClock = clockText(d); // 甲翻到 00:00 时，乙的钟面
    list.push({
      direction: 'ahead',
      pairText: `按甲地 ${offsetText(maxEntry.a)}、乙地 ${offsetText(maxEntry.b)} 计`,
      leadDays: lead,
      sameDateEver: d < 1440,
      openText: `乙地当地 00:00 翻到新的一天时，甲地还是${lead >= 2 ? `前 ${lead} 天` : '前一天'}的 ${openClock}，此刻两地日期相差 ${lead} 天`,
      closeText: d % 1440 === 0
        ? '偏移差恰好是整天，两地永远相差同样的天数，不存在同天的时段'
        : `甲地当地 00:00 翻日时，乙地已经是 ${closeClock}，此刻差距收拢到 ${Math.floor(d / 1440)} 天`,
    });
  }

  if (minEntry.diff < 0) {
    const e = -minEntry.diff;
    const behind = Math.ceil(e / 1440);
    const openClock = clockText(e); // 甲翻到新一天 00:00 时，乙的钟面应是 -E
    const closeClock = clockText(-e); // 乙翻到 00:00 时，甲的钟面
    list.push({
      direction: 'behind',
      pairText: `按甲地 ${offsetText(minEntry.a)}、乙地 ${offsetText(minEntry.b)} 计`,
      behindDays: behind,
      sameDateEver: e < 1440,
      openText: `甲地当地 00:00 翻到新的一天时，乙地还是${behind >= 2 ? `前 ${behind} 天` : '前一天'}的 ${clockText(-e)}，此刻两地日期相差 ${behind} 天`,
      closeText: e % 1440 === 0
        ? '偏移差恰好是整天，两地永远相差同样的天数，不存在同天的时段'
        : `乙地当地 00:00 翻日时，甲地已经是 ${clockText(e)}，此刻差距收拢到 ${Math.floor(e / 1440)} 天`,
    });
  }

  return { list, maxDays };
}

function zoneSummary(zone) {
  return {
    zoneId: zone.id,
    name: zone.name,
    displayName: zone.displayName,
    offsetMinutes: zone.offsetMinutes,
    offsetText: offsetText(zone.offsetMinutes),
    usesDst: zone.usesDst,
    dstOffsetMinutes: zone.dstOffsetMinutes,
    dstOffsetText: zone.usesDst && zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    fromYear: zone.fromYear,
    toYear: zone.toYear,
  };
}

function validateYear(value) {
  if (value === undefined || value === null || value === '') return new Date().getUTCFullYear();
  const raw = typeof value === 'number' ? value : Number(pickText(String(value)));
  if (!Number.isInteger(raw) || raw < MIN_YEAR || raw > MAX_YEAR) {
    throw new ApiError(400, 'YEAR_INVALID', `年份要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, 'year');
  }
  return raw;
}

// 同一条档案与自己对照：任何时刻都是零时差
function sameZoneResult(zone, year) {
  const nowMs = Date.now();
  const nowYear = new Date().getUTCFullYear();
  const active = dstActiveAt(zone, nowMs, nowYear);
  return {
    sameZone: true,
    year,
    a: zoneSummary(zone),
    b: zoneSummary(zone),
    standardDiffMinutes: 0,
    standardDiffText: '同一条档案与自己对照，标准偏移差为零，结论为零时差',
    current: {
      checkedAt: new Date(nowMs).toISOString(),
      aActive: active,
      bActive: active,
      aActiveText: activeText(active),
      bActiveText: activeText(active),
      nowDiffMinutes: 0,
      nowDiffText: '同一地没有时差；夏令时切换时两边的钟一起拨，依旧是零时差',
    },
    combos: [],
    segments: [],
    equalStandard: null,
    dateGapText: '同一地当地日期永远相同，不会翻到前一天或后一天',
    dateBoundaries: [],
  };
}

function compare(options) {
  const input = options && typeof options === 'object' ? options : {};
  const aId = pickText(input.aZoneId);
  const bId = pickText(input.bZoneId);
  if (!aId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择甲地档案', 'aZoneId');
  if (!bId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择乙地档案', 'bZoneId');
  const year = validateYear(input.year);

  const data = load();
  const zoneA = data.zones.find((item) => item.id === aId);
  if (!zoneA) throw new ApiError(404, 'ZONE_NOT_FOUND', '甲地档案不存在或已被删除', 'aZoneId');
  const zoneB = data.zones.find((item) => item.id === bId);
  if (!zoneB) throw new ApiError(404, 'ZONE_NOT_FOUND', '乙地档案不存在或已被删除', 'bZoneId');

  if (zoneA.id === zoneB.id) return sameZoneResult(zoneA, year);

  const standardDiff = zoneB.offsetMinutes - zoneA.offsetMinutes;
  const segments = buildSegments(zoneA, zoneB, year);
  const combos = buildCombos(zoneA, zoneB, segments);
  const equalStandard = buildEqualStandardNote(zoneA, zoneB, segments);
  const gap = buildDateGap(zoneA, zoneB, segments);
  const { list: dateBoundaries, maxDays } = buildDateBoundaries(zoneA, zoneB, gap);

  const nowMs = Date.now();
  const nowYear = new Date().getUTCFullYear();
  const aActive = dstActiveAt(zoneA, nowMs, nowYear);
  const bActive = dstActiveAt(zoneB, nowMs, nowYear);
  const nowDiff = offsetAt(zoneB, nowMs, nowYear) - offsetAt(zoneA, nowMs, nowYear);

  const dateGapText = maxDays === 0
    ? '选定年份里两侧实际偏移始终相同，当地日期不会错开'
    : `只按选定年份里实际出现的偏移组合算，两地当地日期最多可能相差 ${maxDays} 天`;

  return {
    sameZone: false,
    year,
    a: zoneSummary(zoneA),
    b: zoneSummary(zoneB),
    standardDiffMinutes: standardDiff,
    standardDiffText: diffText(standardDiff),
    current: {
      checkedAt: new Date(nowMs).toISOString(),
      aActive,
      bActive,
      aActiveText: activeText(aActive),
      bActiveText: activeText(bActive),
      oneSideInDst: aActive === true || bActive === true,
      nowDiffMinutes: nowDiff,
      nowDiffText: diffText(nowDiff),
    },
    combos,
    segments,
    equalStandard,
    dateGap: {
      maxDays,
      minDiff: gap.minEntry.diff,
      maxDiff: gap.maxEntry.diff,
      minDiffText: diffText(gap.minEntry.diff),
      maxDiffText: diffText(gap.maxEntry.diff),
    },
    dateGapText,
    dateBoundaries,
  };
}

module.exports = {
  compare,
  diffText,
  nthWeekdayOfMonth,
  transitionMs,
  dstActiveAt,
};
