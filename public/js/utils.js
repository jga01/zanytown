import { SHARED_CONFIG } from "./config.js";
import { camera } from "./gameState.js";

/** Converts world coordinates (tiles) to isometric screen coordinates (pixels) relative to world origin. */
export function worldToIso(x, y) {
  // Ensure config is loaded before using it
  if (!SHARED_CONFIG?.TILE_WIDTH_HALF || !SHARED_CONFIG?.TILE_HEIGHT_HALF) {
    // console.warn("worldToIso called before SHARED_CONFIG loaded.");
    return { x: 0, y: 0 };
  }
  const screenX = (x - y) * SHARED_CONFIG.TILE_WIDTH_HALF;
  const screenY = (x + y) * SHARED_CONFIG.TILE_HEIGHT_HALF;
  return { x: screenX, y: screenY };
}

/** Converts isometric screen coordinates (pixels) relative to canvas origin back to world coordinates (tiles). */
export function isoToWorld(screenX, screenY) {
  // Ensure config and camera are ready
  if (
    !SHARED_CONFIG?.TILE_WIDTH_HALF ||
    !SHARED_CONFIG?.TILE_HEIGHT_HALF ||
    !camera
  ) {
    // console.warn("isoToWorld called before SHARED_CONFIG or camera ready.");
    return { x: 0, y: 0 };
  }
  const panAdjustedX = screenX - camera.x;
  const panAdjustedY = screenY - camera.y;
  const zoomAdjustedX = panAdjustedX / camera.zoom;
  const zoomAdjustedY = panAdjustedY / camera.zoom;
  const worldX =
    (zoomAdjustedX / SHARED_CONFIG.TILE_WIDTH_HALF +
      zoomAdjustedY / SHARED_CONFIG.TILE_HEIGHT_HALF) /
    2;
  const worldY =
    (zoomAdjustedY / SHARED_CONFIG.TILE_HEIGHT_HALF -
      zoomAdjustedX / SHARED_CONFIG.TILE_WIDTH_HALF) /
    2;
  return { x: worldX, y: worldY };
}

/** Snaps world coordinates to the nearest grid intersection. */
export function snapToGrid(worldX, worldY) {
  return { x: Math.round(worldX), y: Math.round(worldY) };
}

/** Converts world coordinates to final screen position including camera pan and zoom. */
export function getScreenPos(worldX, worldY) {
  if (!camera) {
    // console.warn("getScreenPos called before camera ready.");
    return { x: 0, y: 0 };
  }
  const iso = worldToIso(worldX, worldY);
  return {
    x: iso.x * camera.zoom + camera.x,
    y: iso.y * camera.zoom + camera.y,
  };
}

/** Lightens or darkens a hex color by a percentage. */
export function shadeColor(color, percent) {
  if (!color || color.length < 7 || color.charAt(0) !== "#") return "#808080"; // Fallback grey
  try {
    let R = parseInt(color.substring(1, 3), 16);
    let G = parseInt(color.substring(3, 5), 16);
    let B = parseInt(color.substring(5, 7), 16);
    R = parseInt((R * (100 + percent)) / 100);
    G = parseInt((G * (100 + percent)) / 100);
    B = parseInt((B * (100 + percent)) / 100);
    R = Math.max(0, Math.min(255, R));
    G = Math.max(0, Math.min(255, G));
    B = Math.max(0, Math.min(255, B));
    const RR = R.toString(16).padStart(2, "0");
    const GG = G.toString(16).padStart(2, "0");
    const BB = B.toString(16).padStart(2, "0");
    return "#" + RR + GG + BB;
  } catch (e) {
    console.error("Error shading color:", color, e);
    return "#808080";
  }
}

/** Rotates a direction (0-7) by a given amount. */
export function rotateDirection(currentDir, amount) {
  return (currentDir + amount + 8) % 8;
}

// --- ADD THIS FUNCTION ---
/** Escapes basic HTML characters to prevent injection issues when setting innerHTML. */
export function escapeHtml(unsafe) {
  if (typeof unsafe !== "string") return unsafe; // Return non-strings as-is
  return unsafe
    .replace(/&/g, "&") // Must be first
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "'"); // or '''
}
// --- END ADDED FUNCTION ---

/** Simple debounce function. */
export function debounce(func, wait, immediate) {
  let timeout;
  return function executedFunction() {
    const context = this;
    const args = arguments;
    const later = function () {
      timeout = null;
      if (!immediate) func.apply(context, args);
    };
    const callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) func.apply(context, args);
  };
}
