(function(global) {
  const namespace = global.NAEICsvUtils = global.NAEICsvUtils || {};

  function defaultFormatCsvCell(value) {
    if (value === null || value === undefined) {
      return '';
    }

    const stringValue = String(value);
    if (stringValue === '') {
      return '';
    }

    const escaped = stringValue.replace(/"/g, '""');
    return /[",\n]/.test(stringValue) ? `"${escaped}"` : escaped;
  }

  namespace.formatCsvCell = namespace.formatCsvCell || defaultFormatCsvCell;
})(window);
