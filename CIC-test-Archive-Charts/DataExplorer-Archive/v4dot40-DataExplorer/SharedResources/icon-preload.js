(function initChartIconPreloader() {
  if (window.preloadChartIcons) {
    return;
  }

  const state = {
    registry: new Set(),
    pending: [],
    container: null
  };

  function ensureContainer() {
    if (state.container) {
      return state.container;
    }
    const sink = document.createElement('div');
    sink.id = 'chart-icon-preload-sink';
    sink.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';
    sink.setAttribute('aria-hidden', 'true');
    state.container = sink;

    const attach = () => {
      if (sink.isConnected) {
        return;
      }
      if (document.body) {
        document.body.appendChild(sink);
        if (state.pending.length) {
          state.pending.splice(0).forEach(img => sink.appendChild(img));
        }
      } else {
        document.addEventListener('DOMContentLoaded', attach, { once: true });
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      attach();
    } else {
      requestAnimationFrame(attach);
    }

    return sink;
  }

  function addPlaceholder(img) {
    const sink = ensureContainer();
    if (sink.isConnected && document.body) {
      sink.appendChild(img);
    } else {
      state.pending.push(img);
    }
  }

  window.preloadChartIcons = function preloadChartIcons(iconList = []) {
    if (!Array.isArray(iconList) || !iconList.length) {
      return;
    }

    iconList.forEach(src => {
      if (typeof src !== 'string' || !src.trim() || state.registry.has(src)) {
        return;
      }
      const cleanSrc = src.trim();
      state.registry.add(cleanSrc);

      try {
        const eager = new Image();
        eager.decoding = 'async';
        eager.loading = 'eager';
        eager.src = cleanSrc;
      } catch (error) {
        console.warn('Icon preload image creation failed:', cleanSrc, error);
      }

      const placeholder = document.createElement('img');
      placeholder.src = cleanSrc;
      placeholder.alt = '';
      placeholder.decoding = 'async';
      placeholder.loading = 'eager';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.style.cssText = 'width:0;height:0;position:absolute;opacity:0;pointer-events:none;';
      addPlaceholder(placeholder);
    });
  };
})();
