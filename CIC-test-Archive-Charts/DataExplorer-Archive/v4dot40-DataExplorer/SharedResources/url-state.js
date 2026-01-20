(function initNaeiUrlState(global) {
  if (global.NAEIUrlState) {
    return;
  }

  function splitPathSegments(pathname) {
    if (!pathname || typeof pathname !== 'string') {
      return [];
    }
    return pathname.split('/').filter(Boolean);
  }

  function removeFileSegment(segments) {
    if (!segments.length) {
      return segments;
    }
    const last = segments[segments.length - 1];
    if (last && last.includes('.')) {
      segments.pop();
    }
    return segments;
  }

  function computeBasePath(levelsUp = 1) {
    const safeLevels = Number.isFinite(levelsUp) ? Math.max(0, Math.floor(levelsUp)) : 1;
    const segments = removeFileSegment(splitPathSegments(global.location.pathname));

    let remaining = safeLevels;
    while (remaining > 0 && segments.length) {
      segments.pop();
      remaining -= 1;
    }

    return segments.length ? `/${segments.join('/')}/` : '/';
  }

  function serializeQuery(value) {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return value.replace(/^[?&]+/, '').trim();
    }

    if (value instanceof URLSearchParams) {
      return value.toString();
    }

    if (Array.isArray(value)) {
      return value
        .map(entry => serializeQuery(entry))
        .filter(Boolean)
        .join('&');
    }

    const params = new URLSearchParams();
    Object.entries(value).forEach(([key, val]) => {
      if (val === undefined || val === null || val === '') {
        return;
      }
      if (Array.isArray(val)) {
        params.set(key, val.join(','));
        return;
      }
      params.set(key, val);
    });
    return params.toString();
  }

  function buildShareUrl(queryInput, options = {}) {
    const origin = options.origin || global.location.origin;
    const basePath = options.basePath || computeBasePath(options.levelsUp ?? 1);
    const queryString = serializeQuery(queryInput || options.params);
    if (!queryString) {
      return `${origin}${basePath}`;
    }
    return `${origin}${basePath}?${queryString}`;
  }

  global.NAEIUrlState = {
    buildShareUrl,
    buildQueryString: serializeQuery,
    getViewerBasePath(levelsUp = 1) {
      return computeBasePath(levelsUp);
    },
    getViewerBaseUrl(levelsUp = 1) {
      return `${global.location.origin}${computeBasePath(levelsUp)}`;
    }
  };
})(window);
