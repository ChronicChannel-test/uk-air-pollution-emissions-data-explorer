/**
 * Data Loader Module (DEPRECATED)
 * This module is kept for compatibility but functionality has been moved to supabase.js
 * The scatter chart now uses window.supabaseModule for all data operations
 */

// For backwards compatibility, create a wrapper that delegates to supabaseModule
window.DataLoader = {
  async loadData() {
    return await window.supabaseModule.loadData();
  },
  
  getAvailableYears() {
    return window.supabaseModule.getAvailableYears();
  },
  
  getScatterData(year, pollutantId, categoryIds) {
    return window.supabaseModule.getScatterData(year, pollutantId, categoryIds);
  },
  
  getPollutantName(pollutantId) {
    return window.supabaseModule.getPollutantName(pollutantId);
  },
  
  getPollutantUnit(pollutantId) {
    return window.supabaseModule.getPollutantUnit(pollutantId);
  },
  
  getCategoryName(categoryId) {
    return window.supabaseModule.getCategoryName(categoryId);
  },
  
  get allPollutants() { 
    return window.supabaseModule.allPollutants; 
  },
  
  get allCategories() { 
    return window.supabaseModule.allCategories; 
  },
  
  get actDataPollutantId() {
    return window.supabaseModule.actDataPollutantId || window.supabaseModule.activityDataId;
  },
  get activityDataId() {
    return window.supabaseModule.actDataPollutantId || window.supabaseModule.activityDataId;
  }
};
