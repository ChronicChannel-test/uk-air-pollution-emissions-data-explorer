# NAEI Multi-Group Pollutant Viewer - v2.3 Modular Architecture

## Overview

This directory contains the modularized version of the NAEI Multi-Group Pollutant Viewer, with JavaScript functionality separated into distinct modules for better maintainability and organization.

## File Structure

### HTML & CSS
- **index.html** (241 lines) - Main HTML structure with complete UI, meta tags, and module script loading
- **styles.css** (558 lines) - All CSS styling including responsive design, layout, and interactive elements

### JavaScript Modules
- **supabase.js** (423 lines) - Database connectivity and data management
  - Supabase client initialization
  - Analytics tracking functions
  - Data loading functions (pollutants, groups, timeseries)
  - Group information rendering

- **main.js** (~945 lines) - Core application logic
  - Google Charts initialization
  - Chart rendering and visualization
  - UI interaction handlers
  - Group management (add, remove, drag-and-drop)
  - Color palette management
  - URL parameter parsing
  - Application initialization

- **export.js** (~845 lines) - Export and sharing functionality
  - CSV/Excel data export
  - PNG chart image generation
  - Clean PNG export (without axis labels)
  - Share URL generation and dialog
  - Email sharing integration

## Module Dependencies

```
index.html
├── styles.css
├── External CDN Libraries:
│   ├── Google Charts API
│   ├── XLSX.js (Excel export)
│   └── Supabase JS Client
└── Local JavaScript Modules (loaded in order):
    ├── supabase.js    (defines data/analytics functions)
    ├── main.js        (uses supabase functions, defines chart/UI functions)
    └── export.js      (uses main.js chart functions)
```

## Key Features

### Data Management (supabase.js)
- Privacy-friendly user analytics with fingerprinting
- Efficient data loading from Supabase tables
- Caching of pollutant and group metadata
- Comprehensive error handling

### Chart Rendering (main.js)
- Interactive Google Charts line visualization
- Dynamic color assignment by group category
- Custom legend with click-to-toggle functionality
- Responsive layout for mobile/desktop
- Smooth vs. straight line toggle
- URL sharing with state preservation

### Export Functionality (export.js)
- High-resolution PNG export with custom legend
- CSV and Excel data export with metadata
- "Clean" PNG export optimized for presentations
- Email sharing with embedded chart images
- Comprehensive error handling

## Improvements Over v2.2

1. **Modularity**: Code separated by concern for easier maintenance
2. **Readability**: Well-documented functions with JSDoc comments
3. **Maintainability**: Isolated modules reduce ripple effects from changes
4. **Reusability**: Functions can be easily reused or extended
5. **Testing**: Modular structure facilitates unit testing

## Browser Compatibility

- Modern browsers with ES6+ support
- Requires JavaScript enabled
- Responsive design for mobile and desktop
- Tested on Chrome, Firefox, Safari, Edge

## Development Notes

- All functions maintain backward compatibility with v2.2
- Global variables are minimized and clearly documented
- Event listeners properly cleaned up
- No external build tools required - runs directly in browser

## Version History

- v2.2: Monolithic implementation with embedded JavaScript
- v2.3: Modular architecture with separated concerns

## License

© Crown copyright (Defra & DESNZ) via naei.energysecurity.gov.uk  
Licensed under the Open Government Licence (OGL)
