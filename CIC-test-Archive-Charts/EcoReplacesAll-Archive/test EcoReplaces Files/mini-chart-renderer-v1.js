(function (global) {
  var MiniColors = {
    eco: '#F58231',
    fireplace: '#E42020',
    replacement: '#911EB4'
  };

  function formatValue(value) {
    if (!Number.isFinite(value)) {
      return '—';
    }
    var abs = Math.abs(value);
    var maxFrac = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
    var formatter = new Intl.NumberFormat('en-GB', {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFrac
    });
    return formatter.format(value);
  }

  function computePercentTrend(fireplace, replacement) {
    var baseline = Math.abs(fireplace);
    var change;
    if (baseline === 0) {
      if (replacement === fireplace) {
        change = 0;
      } else {
        change = replacement > fireplace ? Infinity : -Infinity;
      }
    } else {
      change = ((replacement - fireplace) / baseline) * 100;
    }
    var absChange = Math.abs(change);
    var isFiniteChange = Number.isFinite(absChange);
    var formatted = isFiniteChange ? absChange.toFixed(1) : '∞';
    var display = change > 0 ? '+' + formatted + '%' : change < 0 ? '-' + formatted + '%' : '0%';
    var trend = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';
    return { display: display, trend: trend, value: change };
  }

  function getUnitShort(unit) {
    if (global.EmissionUnits && typeof global.EmissionUnits.formatAbbreviation === 'function') {
      var formatted = global.EmissionUnits.formatAbbreviation(unit);
      if (formatted) {
        return formatted;
      }
    }
    return unit || '';
  }

  function normalizeLabel(text) {
    return (text || '')
      .replace(/[\u0000-\u0020\u00a0\u2000-\u200f\u2028\u202f\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function styleBarAnnotations(container, labels, colors) {
    var svg = container ? container.querySelector('svg') : null;
    if (!svg) {
      return;
    }
    var normalized = labels.map(normalizeLabel);
    var texts = Array.from(svg.querySelectorAll('text')).filter(function (node) {
      return node.getAttribute('text-anchor') === 'middle';
    });
    texts.forEach(function (node, idx) {
      var content = normalizeLabel(node.textContent || '');
      var labelIndex = normalized.indexOf(content);
      var color = colors[labelIndex >= 0 ? labelIndex : idx % colors.length] || '#111827';
      node.setAttribute('fill', color);
      node.setAttribute('stroke', '#ffffff');
      node.setAttribute('stroke-width', '3');
      node.setAttribute('paint-order', 'stroke');
      node.setAttribute('font-family', '"Tiresias Infofont", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
      node.setAttribute('font-weight', '700');
      node.setAttribute('font-size', '15');
      if (node.hasAttribute('y')) {
        var currentY = Number(node.getAttribute('y'));
        if (Number.isFinite(currentY)) {
          node.setAttribute('y', String(currentY - 6));
        }
      }
      var spans = node.querySelectorAll('tspan');
      spans.forEach(function (span) {
        span.setAttribute('fill', color);
        span.setAttribute('stroke', '#ffffff');
        span.setAttribute('stroke-width', '3');
        span.setAttribute('paint-order', 'stroke');
        span.setAttribute('font-family', '"Tiresias Infofont", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
        span.setAttribute('font-weight', '700');
        span.setAttribute('font-size', '15');
      });
    });
  }

  function styleAxes(container, axisColors) {
    var svg = container ? container.querySelector('svg') : null;
    if (!svg) {
      return;
    }
    var vAxisColor = (axisColors && axisColors.labelColor) || '#0f172a';
    var majorColor = (axisColors && axisColors.majorColor) || '#cbd5e1';
    var minorColor = (axisColors && axisColors.minorColor) || '#e2e8f0';

    Array.from(svg.querySelectorAll('text[text-anchor="end"]')).forEach(function (node) {
      node.setAttribute('fill', vAxisColor);
      node.setAttribute('font-size', '12');
      node.setAttribute('font-weight', '600');
      node.removeAttribute('aria-hidden');
      node.style.opacity = '1';
    });

    Array.from(svg.querySelectorAll('g[aria-label="gridline"] line')).forEach(function (line) {
      line.setAttribute('stroke', majorColor);
      line.setAttribute('stroke-width', '1');
      line.setAttribute('opacity', '1');
    });

    Array.from(svg.querySelectorAll('g[aria-label="minor gridline"] line')).forEach(function (line) {
      line.setAttribute('stroke', minorColor);
      line.setAttribute('stroke-width', '1');
      line.setAttribute('opacity', '1');
    });
  }

  function renderCustomAxis(chart, container, ticks, options) {
    if (!chart || !chart.getChartLayoutInterface || !container) {
      return;
    }
    var cli = chart.getChartLayoutInterface();
    if (!cli || typeof cli.getXLocation !== 'function' || typeof cli.getYLocation !== 'function') {
      return;
    }
    var svg = container.querySelector('svg');
    if (!svg) {
      return;
    }

    if (!container.style.position || container.style.position === 'static') {
      container.style.position = 'relative';
    }
    var layer = container.querySelector('.mini-axis-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'mini-axis-layer';
      Object.assign(layer.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '2'
      });
      container.appendChild(layer);
    }
    layer.innerHTML = '';

    var bbox = cli.getChartAreaBoundingBox();
    var top = bbox.top || 0;
    var height = bbox.height || 0;
    var left = bbox.left || 0;
    var width = bbox.width || 0;
    var majorColor = (options && options.majorColor) || '#cbd5e1';
    var minorColor = (options && options.minorColor) || '#e2e8f0';
    var labelColor = (options && options.labelColor) || '#0f172a';

    var labels = Array.isArray(ticks) && ticks.length ? ticks : [];
    labels.forEach(function (tick, idx) {
      if (!Number.isFinite(tick)) {
        return;
      }
      var y = cli.getYLocation(tick);
      if (!Number.isFinite(y)) {
        return;
      }
      var line = document.createElement('div');
      Object.assign(line.style, {
        position: 'absolute',
        left: left + 'px',
        width: width + 'px',
        top: y + 'px',
        height: '1px',
        background: idx === 0 ? minorColor : majorColor,
        opacity: '1'
      });
      layer.appendChild(line);

      var label = document.createElement('div');
      label.textContent = formatValue(tick);
      Object.assign(label.style, {
        position: 'absolute',
        right: (width + 12) + 'px',
        top: (y - 8) + 'px',
        color: labelColor,
        fontSize: '12px',
        fontWeight: '600',
        textAlign: 'right',
        minWidth: '48px'
      });
      layer.appendChild(label);
    });

    var minorCount = (options && options.minorCount) || 0;
    if (labels.length >= 2 && minorCount > 0) {
      for (var i = 0; i < labels.length - 1; i++) {
        var start = labels[i];
        var end = labels[i + 1];
        var step = (end - start) / (minorCount + 1);
        for (var j = 1; j <= minorCount; j++) {
          var minorValue = start + step * j;
          var yMinor = cli.getYLocation(minorValue);
          if (!Number.isFinite(yMinor)) {
            continue;
          }
          var mline = document.createElement('div');
          Object.assign(mline.style, {
            position: 'absolute',
            left: left + 'px',
            width: width + 'px',
            top: yMinor + 'px',
            height: '1px',
            background: minorColor,
            opacity: '1'
          });
          layer.appendChild(mline);
        }
      }
    }
  }

  function buildTicksFromRows(rows, viewWindowMax) {
    var values = Array.isArray(rows) ? rows.map(function (r) { return Number(r && r.value) || 0; }) : [];
    var max = Math.max.apply(Math, [0].concat(values, [Number(viewWindowMax) || 0]));
    if (!Number.isFinite(max) || max <= 0) {
      return [];
    }
    var magnitude = Math.pow(10, Math.floor(Math.log10(max)));
    var candidates = [1, 2, 2.5, 5, 10].map(function (m) { return (m * magnitude) / 5; });
    var step = candidates.find(function (c) { return max / c <= 6; }) || magnitude;
    var upper = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = 0; v <= upper + 1e-9; v += step) {
      ticks.push(Number(v.toFixed(6)));
    }
    return ticks;
  }

  function removeNativeAnnotations(container) {
    var svg = container ? container.querySelector('svg') : null;
    if (!svg) {
      return;
    }
    var selectors = [
      'g[aria-label="annotation"]',
      'g[aria-label="annotations"]',
      'g[aria-label="annotation"] text',
      'g[clip-path*="annotation"] text',
      'text[text-anchor="middle"]'
    ];
    selectors.forEach(function (sel) {
      Array.from(svg.querySelectorAll(sel)).forEach(function (node) {
        node.remove();
      });
    });
  }

  function renderOverlayAnnotations(chart, container, rows, unitShort) {
    if (!chart || !chart.getChartLayoutInterface || !container) {
      return;
    }
    var svg = container.querySelector('svg');
    if (!svg) {
      return;
    }
    var cli = chart.getChartLayoutInterface();
    if (!cli || typeof cli.getXLocation !== 'function' || typeof cli.getYLocation !== 'function') {
      return;
    }

    if (!container.style.position || container.style.position === 'static') {
      container.style.position = 'relative';
    }
    var layer = container.querySelector('.mini-anno-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'mini-anno-layer';
      Object.assign(layer.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '4'
      });
      container.appendChild(layer);
    }
    layer.innerHTML = '';

    rows.forEach(function (row, idx) {
      var value = Number(row && row.value);
      if (!Number.isFinite(value)) {
        return;
      }
      var x = cli.getXLocation(idx);
      var y = cli.getYLocation(value);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      var text = document.createElement('div');
      text.className = 'mini-anno';
      var annotation = row.annotation || (formatValue(value) + (unitShort ? ' ' + unitShort : ''));
      text.textContent = annotation;
      var color = row.color || MiniColors.eco;
      Object.assign(text.style, {
        position: 'absolute',
        left: x + 'px',
        top: y + 'px',
        transform: 'translate(-50%, -18px)',
        color: color,
        fontFamily: '"Tiresias Infofont", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontWeight: '700',
        fontSize: '15px',
        WebkitTextStroke: '3px #ffffff',
        paintOrder: 'stroke',
        textShadow: '0 0 0 #ffffff'
      });
      layer.appendChild(text);
    });
  }

  function renderStackedStyleAnnotations(chart, container, rows, unitShort) {
    if (!chart || !chart.getChartLayoutInterface || !container) {
      return;
    }
    var svg = container.querySelector('svg');
    if (!svg) {
      return;
    }
    var cli = chart.getChartLayoutInterface();
    if (!cli || typeof cli.getXLocation !== 'function' || typeof cli.getYLocation !== 'function') {
      return;
    }
    if (!container.style.position || container.style.position === 'static') {
      container.style.position = 'relative';
    }
    var layer = container.querySelector('.mini-anno-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'mini-anno-layer';
      Object.assign(layer.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '4'
      });
      container.appendChild(layer);
    }
    layer.innerHTML = '';

    rows.forEach(function (row, idx) {
      var value = Number(row && row.value);
      if (!Number.isFinite(value)) {
        return;
      }
      var x = cli.getXLocation(idx);
      var y = cli.getYLocation(value);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      var span = document.createElement('span');
      span.className = 'mini-anno';
      var annotation = row.annotation || (formatValue(value) + (unitShort ? ' ' + unitShort : ''));
      span.textContent = annotation;
      var color = row.color || MiniColors.eco;
      Object.assign(span.style, {
        position: 'absolute',
        left: x + 'px',
        top: y + 'px',
        transform: 'translate(-50%, -18px)',
        color: color,
        fontFamily: '"Tiresias Infofont", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontWeight: '700',
        fontSize: '15px',
        WebkitTextStroke: '3px #ffffff',
        textShadow: '1px 1px 0 #ffffff, -1px -1px 0 #ffffff, -1px 1px 0 #ffffff, 1px -1px 0 #ffffff, 0 1px 0 #ffffff, 0 -1px 0 #ffffff, 1px 0 0 #ffffff, -1px 0 0 #ffffff, 0 0 3px rgba(255,255,255,0.9)',
        paintOrder: 'stroke',
        pointerEvents: 'none'
      });
      layer.appendChild(span);
    });
  }

  function renderOverlayFromRects(container, rows, unitShort) {
    var svg = container ? container.querySelector('svg') : null;
    if (!svg) {
      return;
    }
    var svgPoint = svg.createSVGPoint ? svg.createSVGPoint() : null;
    var mapPoint = function (x, y) {
      if (!svgPoint || !svg.getScreenCTM) {
        return null;
      }
      svgPoint.x = x;
      svgPoint.y = y;
      var ctm = svg.getScreenCTM();
      if (!ctm) {
        return null;
      }
      var screen = svgPoint.matrixTransform(ctm);
      return screen;
    };

    var rects = Array.from(svg.querySelectorAll('rect[fill]')).filter(function (r) {
      var box = r.getBBox();
      return box && box.width > 0 && box.height > 0;
    });
    if (!rects.length) {
      return;
    }
    rects.sort(function (a, b) { return a.getBBox().x - b.getBBox().x; });
    var target = rects.slice(0, rows.length);

    if (!container.style.position || container.style.position === 'static') {
      container.style.position = 'relative';
    }
    var layer = container.querySelector('.mini-anno-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'mini-anno-layer';
      Object.assign(layer.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '4'
      });
      container.appendChild(layer);
    }
    layer.innerHTML = '';

    var svgBox = svg.getBoundingClientRect();
    var containerBox = container.getBoundingClientRect();

    target.forEach(function (bar, idx) {
      var box = bar.getBBox();
      var row = rows[idx] || {};
      var value = Number(row.value);
      if (!Number.isFinite(value)) {
        return;
      }
      var text = document.createElement('div');
      var annotation = row.annotation || (formatValue(value) + (unitShort ? ' ' + unitShort : ''));
      text.className = 'mini-anno';
      text.textContent = annotation;
      var color = row.color || MiniColors.eco;

      var mapped = mapPoint ? mapPoint(box.x + box.width / 2, box.y) : null;
      var absoluteLeft = mapped ? mapped.x - containerBox.left : (svgBox.left + box.x + box.width / 2 - containerBox.left);
      var absoluteTop = mapped ? mapped.y - containerBox.top : (svgBox.top + box.y - containerBox.top);
      var lift = Number(container.dataset?.rectOverlayLift) || 10;
      absoluteTop -= lift;

      Object.assign(text.style, {
        position: 'absolute',
        left: absoluteLeft + 'px',
        top: absoluteTop + 'px',
        transform: 'translate(-50%, -4px)',
        color: color,
        fontFamily: '"Tiresias Infofont", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontWeight: '700',
        fontSize: '15px',
        WebkitTextStroke: '3px #ffffff',
        paintOrder: 'stroke',
        pointerEvents: 'none'
      });
      layer.appendChild(text);
    });
  }

  function renderMiniBarChart(config) {
    if (!config || !config.container) {
      return null;
    }
    if (!global.google || !global.google.visualization) {
      return null;
    }
    var rows = Array.isArray(config.rows) ? config.rows : [];
    var unitShort = typeof config.unitShort === 'string' ? config.unitShort : '';
    var height = Number(config.height) || 260;
    var ticks = Array.isArray(config.ticks) && config.ticks.length ? config.ticks : undefined;
    var viewWindowMax = Number.isFinite(config.viewWindowMax) ? config.viewWindowMax : undefined;
    if (!ticks || !ticks.length) {
      ticks = buildTicksFromRows(config.rows, viewWindowMax);
    }
    if (!ticks || !ticks.length) {
      ticks = undefined;
    }
    var gridlineCount = ticks && ticks.length ? Math.max(2, ticks.length) : 5;
    var minorGridlineCount = Math.max(1, Math.min(4, gridlineCount - 1));
    var labelColor = config.vAxisLabelColor || '#0f172a';
    var majorColor = config.vAxisGridColor || '#cbd5e1';
    var minorColor = config.vAxisMinorGridColor || '#e2e8f0';
    var useNativeAxis = !!config.nativeAxis;
    var axisTicks = useNativeAxis ? undefined : ticks;
    var axisViewWindowMax = useNativeAxis ? undefined : viewWindowMax;

    var dataTable = new global.google.visualization.DataTable();
    dataTable.addColumn('string', 'Scenario');
    dataTable.addColumn('number', 'Emissions');
    dataTable.addColumn({ type: 'string', role: 'style' });
    dataTable.addColumn({ type: 'string', role: 'annotation' });
    var isOverlay = !!config.overlayAnnotations;
    dataTable.addRows(
      rows.map(function (row) {
        var value = Number.isFinite(row.value) ? row.value : null;
        var label = row.label || '';
        var color = row.color || MiniColors.eco;
        var annotation = isOverlay ? '' : (row.annotation || (formatValue(row.value) + (unitShort ? ' ' + unitShort : '')));
        return [label, value, 'color: ' + color, annotation];
      })
    );

    var options = {
      height: height,
      backgroundColor: 'transparent',
      legend: { position: 'none' },
      chartArea: config.chartArea || { width: '78%', height: '74%', top: 8, left: 56, right: 18 },
      colors: rows.map(function (r) { return r.color || MiniColors.eco; }),
      hAxis: {
        textStyle: { color: 'transparent' },
        baselineColor: 'transparent',
        gridlines: { color: 'transparent' },
        ticks: []
      },
      vAxis: useNativeAxis ? {
        textStyle: { color: labelColor, fontSize: 12, fontWeight: 600 },
        baselineColor: majorColor,
        gridlines: { color: majorColor, count: gridlineCount },
        minorGridlines: { color: minorColor, count: minorGridlineCount },
        viewWindow: axisViewWindowMax === undefined ? undefined : { min: 0, max: axisViewWindowMax },
        viewWindowMode: axisTicks ? 'explicit' : 'pretty',
        ticks: axisTicks,
        textPosition: 'out'
      } : {
        textStyle: { color: 'transparent', fontSize: 12 },
        baselineColor: 'transparent',
        gridlines: { color: 'transparent', count: gridlineCount },
        minorGridlines: { color: 'transparent', count: minorGridlineCount },
        viewWindow: { min: 0, max: viewWindowMax },
        viewWindowMode: ticks ? 'explicit' : 'pretty',
        ticks: ticks,
        textPosition: 'out'
      },
      annotations: config.overlayAnnotations ? {
        textStyle: { color: 'transparent' },
        alwaysOutside: true,
        stem: { length: 0, color: 'transparent' }
      } : {
        textStyle: {
          color: '#0f172a',
          fontSize: 15,
          bold: true,
          auraColor: 'transparent',
          fontName: 'Tiresias Infofont, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        },
        alwaysOutside: true,
        stem: { length: 0, color: 'transparent' }
      },
      bar: { groupWidth: '55%' },
      animation: config.overlayAnnotations ? null : {
        startup: true,
        duration: 320,
        easing: 'out'
      },
      tooltip: { textStyle: { color: '#0f172a' } }
    };

    var chart = new global.google.visualization.ColumnChart(config.container);
    global.google.visualization.events.addListener(chart, 'ready', function () {
      var labels = rows.map(function (row) {
        return row.annotation || (formatValue(row.value) + (unitShort ? ' ' + unitShort : ''));
      });
      var colors = rows.map(function (row) { return row.color || MiniColors.eco; });

      var applyAnnotations = function () {
        if (config.overlayAnnotations) {
          removeNativeAnnotations(config.container);
          if (config.overlayMode === 'stacked-style') {
            renderStackedStyleAnnotations(chart, config.container, rows, unitShort);
          } else if (config.overlayMode === 'rects') {
            renderOverlayFromRects(config.container, rows, unitShort);
          } else {
            renderOverlayAnnotations(chart, config.container, rows, unitShort);
          }
          return;
        }
        styleBarAnnotations(config.container, labels, colors);
      };

      var finalize = function () {
        var axisColors = { labelColor: labelColor, majorColor: majorColor, minorColor: minorColor, minorCount: minorGridlineCount };
        styleAxes(config.container, axisColors);
        if (!useNativeAxis) {
          renderCustomAxis(chart, config.container, ticks || [], axisColors);
        }
        applyAnnotations();
        if (config.overlayAnnotations) {
          removeNativeAnnotations(config.container);
        }
        if (config.forceAnnotationColors && !config.overlayAnnotations) {
          var svg = config.container.querySelector('svg');
          if (svg) {
            if (svg.__annoObserver) {
              svg.__annoObserver.disconnect();
            }
            var obs = new MutationObserver(function () {
              applyAnnotations();
            });
            obs.observe(svg, { subtree: true, attributes: true, childList: true, characterData: true });
            svg.__annoObserver = obs;
          }
        }
      };

      global.requestAnimationFrame(function () {
        finalize();
        if (config.overlayAnnotations) {
          setTimeout(finalize, 240);
          setTimeout(finalize, 520);
        }
      });
    });
    chart.draw(dataTable, options);
    return chart;
  }

  global.EcoMiniCharts = {
    renderMiniBarChart: renderMiniBarChart,
    styleBarAnnotations: styleBarAnnotations,
    computePercentTrend: computePercentTrend,
    formatValue: formatValue,
    getUnitShort: getUnitShort
  };
})(window);
