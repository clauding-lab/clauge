// Clauge activity heatmap renderer (v0.9.4 Phase A.3).
//
// Vanilla, no deps. Single orange ramp (matches the existing Clauge accent).
// Shared between dashboard and popover via a `variant` option that swaps cell
// size and label visibility — the data shape and palette are identical.
//
// Loaded as a classic script in both surfaces:
//   <script src="/popover/heatmap.js" defer></script>   (dashboard)
//   <script src="heatmap.js" defer></script>            (popover)
//
// Exposes ClaugeHeatmap.render(rootEl, data, options) on window. Classic
// script (no ES modules) matches popover.js's existing loading convention.

(function () {
  'use strict';

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Convert a YYYY-MM-DD calendar date into a JS Date at UTC midnight. Used
  // only for day-of-week / month extraction — UTC keeps DST out of the math
  // since we treat the date as a pure calendar string from the server.
  function parseCalendarDate(yyyymmdd) {
    return new Date(`${yyyymmdd}T00:00:00Z`);
  }

  function defaultTooltip(cell) {
    const d = parseCalendarDate(cell.date);
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const parts = [];
    if (cell.sessions > 0) {
      parts.push(t('heatmap.tooltipSessions', { count: cell.sessions, plural: cell.sessions === 1 ? '' : 's' }));
    }
    if (cell.claudeAiMessages > 0) {
      parts.push(t('heatmap.tooltipMessages', { count: cell.claudeAiMessages, plural: cell.claudeAiMessages === 1 ? '' : 's' }));
    }
    if (parts.length === 0) {
      return t('heatmap.tooltipNoActivity', { weekday, date: datePart });
    }
    return t('heatmap.tooltipActivity', { weekday, date: datePart, parts: parts.join(' · ') });
  }

  // Bucket the dense day array into Sun..Sat columns. First and last weeks may
  // have leading/trailing null pads if the range doesn't align to week edges.
  function bucketIntoWeeks(days) {
    if (!days.length) return [];
    const weeks = [];
    let currentWeek = new Array(7).fill(null);
    for (const day of days) {
      const dow = parseCalendarDate(day.date).getUTCDay();
      currentWeek[dow] = day;
      if (dow === 6) {
        weeks.push(currentWeek);
        currentWeek = new Array(7).fill(null);
      }
    }
    if (currentWeek.some((c) => c !== null)) weeks.push(currentWeek);
    return weeks;
  }

  function findNonEmptyAt(table, rowIndex, colIndex) {
    const rows = table.querySelectorAll('tr');
    const row = rows[rowIndex];
    if (!row) return null;
    const cell = row.children[colIndex];
    if (!cell || !cell.classList || !cell.classList.contains('heatmap__cell')) return null;
    if (cell.classList.contains('heatmap__cell--empty')) return null;
    return cell;
  }

  function enableKeyboardNav(table) {
    table.addEventListener('keydown', (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const cell = e.target.closest && e.target.closest('.heatmap__cell');
      if (!cell || cell.classList.contains('heatmap__cell--empty')) return;
      const row = cell.parentElement;
      const rowIndex = Array.from(row.parentElement.children).indexOf(row);
      const colIndex = Array.from(row.children).indexOf(cell);
      let target = null;
      switch (e.key) {
        case 'ArrowUp':    target = findNonEmptyAt(table, rowIndex - 1, colIndex); break;
        case 'ArrowDown':  target = findNonEmptyAt(table, rowIndex + 1, colIndex); break;
        case 'ArrowLeft':  target = findNonEmptyAt(table, rowIndex, colIndex - 1); break;
        case 'ArrowRight': target = findNonEmptyAt(table, rowIndex, colIndex + 1); break;
      }
      if (target) {
        e.preventDefault();
        cell.setAttribute('tabindex', '-1');
        target.setAttribute('tabindex', '0');
        target.focus();
      }
    });
  }

  function buildMonthLabelRow(weeks, leadingEmptyCols) {
    const tr = document.createElement('tr');
    tr.className = 'heatmap__month-row';
    if (leadingEmptyCols > 0) {
      const spacer = document.createElement('th');
      spacer.setAttribute('aria-hidden', 'true');
      tr.appendChild(spacer);
    }
    let lastMonth = -1;
    for (const week of weeks) {
      const th = document.createElement('th');
      th.setAttribute('scope', 'col');
      th.className = 'heatmap__month-label';
      const firstCell = week.find((c) => c !== null);
      if (firstCell) {
        const month = parseCalendarDate(firstCell.date).getUTCMonth();
        if (month !== lastMonth) {
          th.textContent = MONTH_NAMES[month];
          lastMonth = month;
        }
      }
      tr.appendChild(th);
    }
    return tr;
  }

  function render(rootEl, data, options) {
    if (!rootEl) throw new Error('ClaugeHeatmap.render: rootEl is required');
    const opts = options || {};
    const variant = opts.variant === 'popover' ? 'popover' : 'dashboard';
    const showDayLabels = opts.showDayLabels ?? (variant === 'dashboard');
    const showMonthLabels = opts.showMonthLabels ?? (variant === 'dashboard');
    const tooltipFn = typeof opts.onHover === 'function' ? opts.onHover : defaultTooltip;

    // Clear any prior render. replaceChildren() with no args removes all
    // children safely (no innerHTML, no XSS surface).
    rootEl.replaceChildren();
    rootEl.classList.add('heatmap', `heatmap--${variant}`);

    if (!data || !Array.isArray(data.days) || data.days.length === 0) {
      rootEl.classList.add('heatmap--empty');
      return;
    }
    rootEl.classList.remove('heatmap--empty');

    const weeks = bucketIntoWeeks(data.days);
    const leadingEmptyCols = showDayLabels ? 1 : 0;

    // Auto-fit cellSize so the heatmap spans rootEl's full width on both
    // surfaces. Explicit opts.cellSize wins. rootEl.clientWidth is 0 if the
    // node isn't yet in the DOM — fall back to variant defaults in that case.
    let cellSize;
    if (Number.isFinite(opts.cellSize)) {
      cellSize = opts.cellSize;
    } else {
      const containerWidth = rootEl.clientWidth || (variant === 'popover' ? 316 : 800);
      const cellGap = variant === 'popover' ? 1 : 3;
      const labelCol = showDayLabels ? 40 : 0;
      const available = Math.max(0, containerWidth - labelCol);
      const weekCount = Math.max(1, weeks.length);
      // border-spacing puts a gap on each side of every cell:
      //   width = N * cellSize + (N + 1) * cellGap
      const fit = Math.floor((available - (weekCount + 1) * cellGap) / weekCount);
      // Cap at 32 — bigger feels chunky in screenshots, and very wide
      // dashboards (>2000px) are fine with a little right-side slack.
      cellSize = Math.max(8, Math.min(32, fit));
    }
    rootEl.style.setProperty('--cell-size', `${cellSize}px`);

    const table = document.createElement('table');
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', opts.ariaLabel || t('heatmap.ariaLabel'));

    if (showMonthLabels) {
      table.appendChild(buildMonthLabelRow(weeks, leadingEmptyCols));
    }

    for (let day = 0; day < 7; day++) {
      const row = document.createElement('tr');
      if (showDayLabels) {
        const label = document.createElement('th');
        label.setAttribute('scope', 'row');
        label.className = 'heatmap__day-label';
        // GitHub convention: only Mon/Wed/Fri are labelled (rows 1/3/5).
        label.textContent = (day === 1 || day === 3 || day === 5) ? DAY_NAMES[day] : '';
        row.appendChild(label);
      }
      for (const week of weeks) {
        const cell = week[day];
        const td = document.createElement('td');
        if (cell) {
          const intensity = Number.isFinite(cell.intensity) ? cell.intensity : 0;
          td.className = `heatmap__cell cell-${intensity}`;
          td.setAttribute('role', 'gridcell');
          td.setAttribute('tabindex', '-1');
          td.dataset.date = cell.date;
          const tip = tooltipFn(cell);
          td.setAttribute('title', tip);
          td.setAttribute('aria-label', tip);
        } else {
          td.className = 'heatmap__cell heatmap__cell--empty';
          td.setAttribute('aria-hidden', 'true');
        }
        row.appendChild(td);
      }
      table.appendChild(row);
    }

    rootEl.appendChild(table);
    enableKeyboardNav(table);

    // First focusable cell becomes the grid's tab stop.
    const first = table.querySelector('.heatmap__cell:not(.heatmap__cell--empty)');
    if (first) first.setAttribute('tabindex', '0');
  }

  // Browser export. Tests can re-import the file in a DOM env if needed.
  if (typeof window !== 'undefined') {
    window.ClaugeHeatmap = { render, bucketIntoWeeks, defaultTooltip };
  }
})();
