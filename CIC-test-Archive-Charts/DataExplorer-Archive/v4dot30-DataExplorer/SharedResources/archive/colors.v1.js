/**
 * Archived Color Palette Module
 * Provides the original v1.0 heuristics (December 2025)
 * This file is kept for reference while v2.0 work progresses.
 */

// Distinct color palette for up to 10 series
const distinctPalette = [
  '#E42020', // Red
  '#3CB44B', // Green
  '#FFE119', // Yellow
  '#4363D8', // Blue
  '#F58231', // Orange
  '#911EB4', // Purple
  '#46F0F0', // Cyan
  '#F032E6', // Magenta
  '#BCF60C', // Lime
  '#FABEBE'  // Pink
];

// Category-based color preferences
const categoryBaseColor = {
  ecodesign: distinctPalette[4],  // Orange
  fireplace: distinctPalette[0],  // Red
  gas: distinctPalette[3],        // Blue
  power: distinctPalette[1],      // Green
  road: distinctPalette[6]        // Cyan
};

// Color assignment state
let colorCache = {};
let availableColors = [...distinctPalette];

const stoveFireplaceMatchers = [
  'stove',
  'fireplace',
  'chiminea',
  'fire pit',
  'fire-pit',
  'bonfire'
];

const restrictedGreens = new Set([
  '#3CB44B', // Bright green
  '#BCF60C'  // Lime
]);

function isStoveOrFireplace(name = '') {
  const lower = String(name).toLowerCase();
  return stoveFireplaceMatchers.some(token => lower.includes(token));
}

function pickNextAvailableColor(disallowed = new Set()) {
  const usedColors = new Set(Object.values(colorCache));
  const unrestricted = availableColors.filter(color => !usedColors.has(color));
  const filtered = unrestricted.filter(color => !disallowed.has(color));
  if (filtered.length) {
    return filtered[0];
  }
  if (unrestricted.length) {
    return unrestricted[0];
  }
  // Fall back to palette cycling if we somehow exhausted every shade
  return distinctPalette[usedColors.size % distinctPalette.length];
}

/**
 * Reset the color assignment system
 */
function resetColorSystem() {
  colorCache = {};
  availableColors = [...distinctPalette];
}

/**
 * Get a consistent color for a category/series name
 * @param {string} name - Category or series name
 * @returns {string} Hex color code
 */
function getColorForCategory(name) {
  if (!name) return '#888888';
  if (colorCache[name]) return colorCache[name];

  const lower = name.toLowerCase();
  const cat = Object.keys(categoryBaseColor).find(c => lower.includes(c));
  const treatAsStoveFireplace = isStoveOrFireplace(name);

  // Prefer category color if available
  let baseColor = cat ? categoryBaseColor[cat] : null;
  let chosenColor = baseColor;

  if (chosenColor && treatAsStoveFireplace && restrictedGreens.has(chosenColor)) {
    chosenColor = null; // Force re-selection to avoid green shades
  }

  // Avoid duplicates: if base color already used, pick next available
  if (!chosenColor || Object.values(colorCache).includes(chosenColor)) {
    const disallowed = treatAsStoveFireplace ? restrictedGreens : new Set();
    chosenColor = pickNextAvailableColor(disallowed);
  }

  // Fallback to any color if palette exhausted (shouldn't happen with ≤10)
  if (!chosenColor) {
    chosenColor = distinctPalette[Object.keys(colorCache).length % distinctPalette.length];
  }

  colorCache[name] = chosenColor;
  return chosenColor;
}

/**
 * Get the current color cache
 * @returns {Object} Map of names to colors
 */
function getColorCache() {
  return { ...colorCache };
}

/**
 * Set a specific color for a name
 * @param {string} name - Category or series name
 * @param {string} color - Hex color code
 */
function setColorForCategory(name, color) {
  colorCache[name] = color;
}

// Export color functions and constants
window.ColorsV1 = {
  distinctPalette,
  categoryBaseColor,
  resetColorSystem,
  getColorForCategory,
  getColorCache,
  setColorForCategory
};
