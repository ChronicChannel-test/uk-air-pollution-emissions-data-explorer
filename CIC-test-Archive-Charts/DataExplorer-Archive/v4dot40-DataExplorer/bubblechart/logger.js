(function initBubbleLogger() {
  if (typeof window === 'undefined') {
    return;
  }
  if (window.BubbleLogger) {
    if (window.__NAEI_DEBUG__) {
      window.BubbleLogger.setEnabled?.(true);
    }
    return;
  }

  const search = window.location?.search || '';
  const params = new URLSearchParams(search);
  const debugKeys = ['debug', 'logs', 'debugLogs'];
  const queryEnabled = debugKeys.some(key => {
    if (!params.has(key)) {
      return false;
    }
    const value = params.get(key);
    if (value == null || value === '') {
      return true;
    }
    const normalized = String(value).toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  });
  const initialEnabled = Boolean(window.__NAEI_DEBUG__ || queryEnabled);

  const logger = {
    enabled: initialEnabled,
    setEnabled(value) {
      logger.enabled = Boolean(value);
      if (logger.enabled) {
        window.__NAEI_DEBUG__ = true;
      }
    }
  };

  const forward = (level, args) => {
    if (!logger.enabled) {
      return;
    }
    const fn = console[level] || console.log;
    fn.apply(console, ['[bubble]', ...args]);
  };

  logger.log = (...args) => forward('log', args);
  logger.info = (...args) => forward('info', args);
  logger.warn = (...args) => forward('warn', args);
  logger.group = (...args) => forward('groupCollapsed', args);
  logger.groupEnd = () => {
    if (logger.enabled && console.groupEnd) {
      console.groupEnd();
    }
  };
  logger.tagged = (tag) => (...args) => logger.log(`[${tag}]`, ...args);

  window.BubbleLogger = logger;
})();
