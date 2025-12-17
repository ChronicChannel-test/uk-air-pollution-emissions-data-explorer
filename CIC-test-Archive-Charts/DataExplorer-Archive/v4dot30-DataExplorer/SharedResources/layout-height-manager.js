(function initLayoutHeightManager(global) {
  const DEFAULTS = {
    namespace: 'chart',
    wrapperSelector: '.chart-wrapper',
    chartSelector: '#chart_div',
    minChartHeight: 420,
    footerGap: 6,
    visualPadding: 0,
    minHeightDelta: 8,
    heightDebounce: 250,
    autoApplyParentMetrics: true,
    minClampDatasetKey: null,
    parentChangeThreshold: 3,
    parentChangeDebounce: 200
  };

  function create(userOptions = {}) {
    const settings = { ...DEFAULTS, ...userOptions };
    const cssViewportVar = settings.viewportVar || `--${settings.namespace}-viewport-height`;
    const cssFooterVar = settings.footerVar || `--${settings.namespace}-footer-height`;

    const datasetKey = settings.minClampDatasetKey || `${settings.namespace}MinClamp`;
    const HEIGHT_EPSILON = 1;
    const state = {
      parentFooterHeight: null,
      parentViewportHeight: null,
      lastAppliedViewport: null,
      lastAppliedFooter: null,
      lastEstimatedChartHeight: null,
      lastWrapperHeight: 0,
      wrapperElement: null,
      wrapperClampActive: false
    };

    let resizeObserver = null;
    let resizeTimer = null;
    let parentChangeTimer = null;
    let pendingParentChange = null;
    const parentChangeHandlers = new Set();

    function setCssVar(varName, value) {
      if (!varName || typeof value !== 'string') {
        return;
      }
      try {
        document.documentElement?.style?.setProperty(varName, value);
      } catch (error) {
        if (global.__NAEI_DEBUG__) {
          console.warn(`LayoutHeightManager: failed to set ${varName}`, error);
        }
      }
    }

    function applyViewportHeight(value) {
      const numeric = typeof value === 'string' ? null : Math.max(0, Math.round(Number(value) || 0));
      const finalValue = typeof value === 'string' ? value : `${numeric}px`;
      if (!finalValue || finalValue === state.lastAppliedViewport) {
        return state.lastAppliedViewport;
      }
      setCssVar(cssViewportVar, finalValue);
      state.lastAppliedViewport = finalValue;
      return finalValue;
    }

    function applyFooterReserve(pixels) {
      const numeric = Math.max(settings.footerGap, Math.round(Number(pixels) || 0));
      const padded = numeric + Math.max(0, Math.round(settings.visualPadding || 0));
      const finalValue = `${padded}px`;
      if (finalValue === state.lastAppliedFooter) {
        return state.lastAppliedFooter;
      }
      setCssVar(cssFooterVar, finalValue);
      state.lastAppliedFooter = finalValue;
      return finalValue;
    }

    function estimateChartHeight({ viewportHeight, footerReserve, chromeBuffer = 0 } = {}) {
      const safeViewport = Math.max(0, Math.round(Number(viewportHeight ?? state.parentViewportHeight) || 0));
      const safeFooter = Math.max(settings.footerGap, Math.round(Number(footerReserve ?? state.parentFooterHeight) || 0));
      const safeChrome = Math.max(0, Math.round(Number(chromeBuffer) || 0));
      const estimated = Math.max(settings.minChartHeight, safeViewport - safeFooter - safeChrome);
      state.lastEstimatedChartHeight = estimated;
      if (typeof global !== 'undefined') {
        global.__NAEI_LAST_CHART_HEIGHT = estimated;
      }
      return estimated;
    }

    function handleParentMetrics(payload = {}) {
      const previousFooter = state.parentFooterHeight;
      const previousViewport = state.parentViewportHeight;
      const footerCandidate = Number(payload.footerHeight);
      const viewportCandidate = Number(payload.viewportHeight);

      if (Number.isFinite(footerCandidate) && footerCandidate >= 0) {
        state.parentFooterHeight = Math.max(settings.footerGap, footerCandidate);
        if (settings.autoApplyParentMetrics !== false) {
          applyFooterReserve(state.parentFooterHeight + settings.footerGap);
        }
      }

      if (Number.isFinite(viewportCandidate) && viewportCandidate > 0) {
        state.parentViewportHeight = viewportCandidate;
        if (settings.autoApplyParentMetrics !== false) {
          applyViewportHeight(`${Math.round(viewportCandidate)}px`);
        }
      }

      const footerDelta = Math.abs((state.parentFooterHeight || 0) - (previousFooter || 0));
      const viewportDelta = Math.abs((state.parentViewportHeight || 0) - (previousViewport || 0));
      const threshold = Math.max(0, Math.round(settings.parentChangeThreshold || 0));
      if (Math.max(footerDelta, viewportDelta) >= threshold) {
        pendingParentChange = {
          footerHeight: state.parentFooterHeight,
          viewportHeight: state.parentViewportHeight,
          footerDelta,
          viewportDelta
        };
        if (!parentChangeTimer) {
          parentChangeTimer = setTimeout(() => {
            parentChangeTimer = null;
            const payloadToSend = pendingParentChange;
            pendingParentChange = null;
            if (!payloadToSend) {
              return;
            }
            parentChangeHandlers.forEach(handler => {
              try {
                handler(payloadToSend);
              } catch (error) {
                if (global.__NAEI_DEBUG__) {
                  console.warn('LayoutHeightManager parent change handler failed', error);
                }
              }
            });
          }, settings.parentChangeDebounce);
        }
      }

      return {
        footerHeight: state.parentFooterHeight,
        viewportHeight: state.parentViewportHeight
      };
    }

    function getWrapperElement() {
      if (state.wrapperElement && document.body.contains(state.wrapperElement)) {
        return state.wrapperElement;
      }
      state.wrapperElement = document.querySelector(settings.wrapperSelector) || null;
      return state.wrapperElement;
    }

    function clearWrapperClamp(wrapperElement = getWrapperElement()) {
      if (!wrapperElement) {
        return;
      }
      if (!state.wrapperClampActive && !(wrapperElement.dataset && wrapperElement.dataset[datasetKey])) {
        return;
      }
      wrapperElement.style.minHeight = '';
      wrapperElement.style.height = '';
      wrapperElement.style.maxHeight = '';
      if (wrapperElement.dataset && wrapperElement.dataset[datasetKey]) {
        delete wrapperElement.dataset[datasetKey];
      }
      state.wrapperClampActive = false;
    }

    function parsePixelValue(value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.round(value);
      }
      if (typeof value === 'string') {
        const parsed = parseFloat(value);
        if (!Number.isNaN(parsed)) {
          return Math.round(parsed);
        }
      }
      return null;
    }

    function ensureWrapperCapacity({
      wrapperElement = getWrapperElement(),
      chartHeight,
      chromeBeforeChart = 0,
      chromeAfterChart = 0
    } = {}) {
      if (!wrapperElement) {
        return {
          expanded: false,
          requiredHeight: null,
          finalHeight: null
        };
      }

      const minCanvas = Math.max(settings.minChartHeight, 0);
      const chromeBefore = Math.max(0, Math.round(chromeBeforeChart || 0));
      const chromeAfter = Math.max(0, Math.round(chromeAfterChart || 0));
      const numericChartHeight = Number.isFinite(chartHeight)
        ? Math.max(0, Math.round(chartHeight))
        : null;
      const effectiveChartHeight = Math.max(minCanvas, numericChartHeight || minCanvas);
      const requiredHeight = Math.round(chromeBefore + effectiveChartHeight + chromeAfter);
      const currentHeight = Math.round(wrapperElement.getBoundingClientRect?.().height || 0);
      const datasetClampActive = Boolean(wrapperElement.dataset && wrapperElement.dataset[datasetKey]);
      const currentlyClamped = state.wrapperClampActive || datasetClampActive;

      const naturalWrapperHeight = (() => {
        const viewportPx = parsePixelValue(state.lastAppliedViewport) ?? parsePixelValue(state.parentViewportHeight);
        const footerPx = parsePixelValue(state.lastAppliedFooter)
          ?? (Number.isFinite(state.parentFooterHeight)
            ? Math.round(state.parentFooterHeight + settings.footerGap + Math.max(0, Math.round(settings.visualPadding || 0)))
            : null);
        if (Number.isFinite(viewportPx) && Number.isFinite(footerPx)) {
          return Math.max(0, viewportPx - footerPx);
        }
        return null;
      })();

      const requiresClampIncrease = requiredHeight > currentHeight + HEIGHT_EPSILON;
      const clampDrifted = currentlyClamped && Math.abs(requiredHeight - currentHeight) > HEIGHT_EPSILON;

      if (requiresClampIncrease || clampDrifted) {
        wrapperElement.style.minHeight = `${requiredHeight}px`;
        wrapperElement.style.height = `${requiredHeight}px`;
        wrapperElement.style.maxHeight = `${requiredHeight}px`;
        if (wrapperElement.dataset) {
          wrapperElement.dataset[datasetKey] = '1';
        }
        state.wrapperClampActive = true;
        state.lastWrapperHeight = requiredHeight;
        return {
          expanded: true,
          requiredHeight,
          finalHeight: requiredHeight
        };
      }

      if (currentlyClamped && Number.isFinite(naturalWrapperHeight) && naturalWrapperHeight >= requiredHeight - HEIGHT_EPSILON) {
        clearWrapperClamp(wrapperElement);
        const relaxedHeight = Math.round(wrapperElement.getBoundingClientRect?.().height || naturalWrapperHeight || 0);
        return {
          expanded: false,
          requiredHeight: null,
          finalHeight: relaxedHeight
        };
      }

      return {
        expanded: false,
        requiredHeight: null,
        finalHeight: currentHeight
      };
    }

    function observeWrapper(onHeightChange) {
      if (typeof onHeightChange !== 'function' || !global.ResizeObserver) {
        return () => {};
      }

      const wrapper = document.querySelector(settings.wrapperSelector);
      if (!wrapper) {
        return () => {};
      }

      state.wrapperElement = wrapper;

      const observer = new ResizeObserver((entries) => {
        const entry = entries?.[0];
        const measured = entry?.contentRect?.height;
        const newHeight = Math.round(measured || wrapper.offsetHeight || 0);
        if (!newHeight) {
          return;
        }

        if (!state.lastWrapperHeight) {
          state.lastWrapperHeight = newHeight;
          return;
        }

        const delta = newHeight - state.lastWrapperHeight;
        if (Math.abs(delta) < settings.minHeightDelta) {
          return;
        }

        const previousHeight = state.lastWrapperHeight;
        state.lastWrapperHeight = newHeight;

        if (resizeTimer) {
          clearTimeout(resizeTimer);
        }

        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          onHeightChange({
            height: newHeight,
            previous: previousHeight,
            delta
          });
        }, settings.heightDebounce);
      });

      observer.observe(wrapper);
      resizeObserver = observer;

      return () => {
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        if (resizeTimer) {
          clearTimeout(resizeTimer);
          resizeTimer = null;
        }
      };
    }

    function disconnect() {
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      if (parentChangeTimer) {
        clearTimeout(parentChangeTimer);
        parentChangeTimer = null;
      }
    }

    function onParentViewportChange(handler) {
      if (typeof handler !== 'function') {
        return () => {};
      }
      parentChangeHandlers.add(handler);
      return () => {
        parentChangeHandlers.delete(handler);
      };
    }

    return {
      settings,
      state,
      applyViewportHeight,
      applyFooterReserve,
      estimateChartHeight,
      handleParentMetrics,
      observeWrapper,
      disconnect,
      ensureWrapperCapacity,
      getWrapperElement,
      getChartElement: () => document.querySelector(settings.chartSelector),
      getParentViewportHeight: () => state.parentViewportHeight,
      getParentFooterHeight: () => state.parentFooterHeight,
      getLastEstimatedHeight: () => state.lastEstimatedChartHeight,
      onParentViewportChange
    };
  }

  global.LayoutHeightManager = {
    create
  };
})(window);
