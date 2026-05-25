// GAM v1 expects `dateRange` as { fixed: { startDate, endDate } }
// with `{ year, month, day }` shapes. It does NOT accept relativeDateRange
// inside the report.report_definition.date_range proto, despite what some
// docs suggest. We convert the preset names locally to keep callers ergonomic.

function ymd(d) {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

function daysAgoUtc(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function gamDateRangeFromInput({ datePreset, from, to }) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (from && to && iso.test(from) && iso.test(to)) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    return {
      fixed: {
        startDate: { year: fy, month: fm, day: fd },
        endDate: { year: ty, month: tm, day: td },
      },
    };
  }
  const preset = String(datePreset ?? 'LAST_7_DAYS').toUpperCase();
  const today = new Date();
  let startDate;
  let endDate;
  switch (preset) {
    case 'TODAY':
      startDate = endDate = today;
      break;
    case 'YESTERDAY':
      startDate = endDate = daysAgoUtc(1);
      break;
    case 'LAST_14_DAYS':
      startDate = daysAgoUtc(14);
      endDate = daysAgoUtc(1);
      break;
    case 'LAST_30_DAYS':
      startDate = daysAgoUtc(30);
      endDate = daysAgoUtc(1);
      break;
    case 'LAST_7_DAYS':
    default:
      startDate = daysAgoUtc(7);
      endDate = daysAgoUtc(1);
      break;
  }
  return {
    fixed: { startDate: ymd(startDate), endDate: ymd(endDate) },
  };
}

module.exports = { gamDateRangeFromInput };
