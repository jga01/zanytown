import { gameState, uiState, camera } from "./gameState.js";
import { getScreenPos, shadeColor, isoToWorld, worldToIso } from "./utils.js"; // Import necessary utils
import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientTile } from "./gameObjects/ClientTile.js";
import { getClientStackHeightAt } from "./uiManager.js"; // Placement ghost needs stack height calc

let ctx = null;
let canvas = null;
// let frameCount = 0; // Optional: for debug logging frequency

/** Initializes the renderer with the canvas element and context. */
export function initRenderer(canvasElement, context) {
  canvas = canvasElement;
  ctx = context;
  if (!ctx) {
    console.error("Renderer init failed: No context provided.");
    return false;
  }
  // Setting imageSmoothingEnabled is often debated. false gives crisp pixels, true can sometimes look better for rotated/scaled assets.
  // Let's keep it false for now for the intended pixel-art/retro feel.
  ctx.imageSmoothingEnabled = false;
  console.log("Renderer initialized.");
  return true;
}

/**
 * Calculates the approximate minimum and maximum world coordinates visible on screen.
 * Includes a margin for smoother appearance near edges.
 * @param {number} margin - The margin (in world tile units) to add around the viewport.
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number } | null} Visible bounds or null if canvas/camera not ready.
 */
function getVisibleWorldBounds(margin = 2) {
  const canvas = uiState.canvas; // Get canvas from uiState
  if (!canvas || !camera) {
    // console.warn("getVisibleWorldBounds skipped: canvas or camera not ready.");
    return null;
  }

  const width = canvas.width;
  const height = canvas.height;

  // Check for zero dimensions which can cause issues with isoToWorld if zoom is 0 etc.
  if (width <= 0 || height <= 0) {
    console.warn(
      "getVisibleWorldBounds skipped: Canvas dimensions are zero or invalid."
    );
    return null;
  }

  try {
    // Convert screen corners to world coordinates using the utility function
    const topLeft = isoToWorld(0, 0);
    const topRight = isoToWorld(width, 0);
    const bottomLeft = isoToWorld(0, height);
    const bottomRight = isoToWorld(width, height);

    // Find the min/max world X and Y across all corners
    const minX =
      Math.min(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x) - margin;
    const maxX =
      Math.max(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x) + margin;
    const minY =
      Math.min(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y) - margin;
    const maxY =
      Math.max(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y) + margin;

    // Basic sanity check for results
    if (isNaN(minX) || isNaN(minY) || isNaN(maxX) || isNaN(maxY)) {
      console.warn(
        "getVisibleWorldBounds resulted in NaN values. Check camera/config state.",
        { camera, SHARED_CONFIG }
      );
      return null;
    }

    return { minX, minY, maxX, maxY };
  } catch (e) {
    console.error("Error calculating visible world bounds:", e);
    return null;
  }
}

/** The main rendering function, called every frame by the game loop. */
export function renderGame() {
  if (!ctx || !canvas || !CLIENT_CONFIG || !SHARED_CONFIG || !uiState) {
    // console.warn("Render skipped: renderer not ready or config/uiState missing.");
    return;
  }
  // frameCount++; // Optional: for debug logging

  // --- Clear Canvas ---
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Use a background color defined in CSS or a default if needed
  // Setting it here overrides CSS background for the canvas drawing area.
  ctx.fillStyle = "#003366"; // Dark blue default background
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // --- Calculate Visible Bounds ---
  const bounds = getVisibleWorldBounds(2); // Get bounds with a margin of 2 tiles
  if (!bounds) {
    // If bounds calculation fails, maybe draw *nothing* or log error prominently
    console.error("Render skipped: Could not calculate visible bounds.");
    ctx.fillStyle = "red"; // Indicate error state
    ctx.font = "20px Arial";
    ctx.textAlign = "center";
    ctx.fillText(
      "Render Error: Bounds Calculation Failed",
      canvas.width / 2,
      canvas.height / 2
    );
    return;
  }

  // --- Collect & Filter Drawable Objects ---
  let visibleDrawables = [];
  let totalObjects = 0;

  // Add Tiles
  if (gameState.clientTiles) {
    totalObjects += gameState.clientTiles.length;
    gameState.clientTiles.forEach((tile) => {
      // Check if tile center is within bounds
      if (
        tile.x >= bounds.minX &&
        tile.x <= bounds.maxX &&
        tile.y >= bounds.minY &&
        tile.y <= bounds.maxY
      ) {
        visibleDrawables.push(tile);
      }
    });
  }

  // Add Furniture
  if (gameState.furniture) {
    const furnitureArray = Object.values(gameState.furniture);
    totalObjects += furnitureArray.length;
    furnitureArray.forEach((furni) => {
      // Check visual position against bounds
      if (
        furni &&
        typeof furni.draw === "function" &&
        furni.visualX >= bounds.minX &&
        furni.visualX <= bounds.maxX &&
        furni.visualY >= bounds.minY &&
        furni.visualY <= bounds.maxY
      ) {
        // For multi-tile items, ensure *any* part is within bounds for potential drawing
        // This basic check using visualX/Y is often good enough, but can be refined.
        visibleDrawables.push(furni);
      }
      // --- Alternative check for multi-tile items (more accurate culling but slightly more complex) ---
      /*
             else if (furni && typeof furni.draw === 'function' && furni.definition && (furni.definition.width > 1 || furni.definition.height > 1) && typeof furni.getOccupiedTiles === 'function') {
                 // Check if any occupied tile intersects the bounds
                 const intersects = furni.getOccupiedTiles().some(tilePos =>
                      tilePos.x >= bounds.minX && tilePos.x <= bounds.maxX &&
                      tilePos.y >= bounds.minY && tilePos.y <= bounds.maxY
                 );
                 if (intersects) {
                     visibleDrawables.push(furni);
                 }
             }
             */
    });
  }

  // Add Avatars
  if (gameState.avatars) {
    const avatarArray = Object.values(gameState.avatars);
    totalObjects += avatarArray.length;
    avatarArray.forEach((avatar) => {
      // Check visual position against bounds
      if (
        avatar &&
        typeof avatar.draw === "function" &&
        avatar.visualX >= bounds.minX &&
        avatar.visualX <= bounds.maxX &&
        avatar.visualY >= bounds.minY &&
        avatar.visualY <= bounds.maxY
      ) {
        visibleDrawables.push(avatar);
      }
    });
  }

  // --- Sort Filtered Objects ---
  // Sort based on pre-calculated drawOrder (lower numbers drawn first)
  visibleDrawables.sort((a, b) => (a?.drawOrder ?? 0) - (b?.drawOrder ?? 0));

  // --- Debugging: Log culling effectiveness (optional) ---
  // if (frameCount % 120 === 0) {
  //   // Log every ~2 seconds
  //   console.log(
  //     `Rendering ${
  //       visibleDrawables.length
  //     } / ${totalObjects} objects. Bounds: ${JSON.stringify(bounds)}`
  //   );
  // }

  // --- Draw Filtered Objects ---
  // Iterate and call the draw method on each visible object
  visibleDrawables.forEach((obj) => {
    if (obj && typeof obj.draw === "function") {
      try {
        obj.draw(ctx, camera); // Pass context and camera state
      } catch (drawError) {
        console.error(`Error drawing object ${obj.id}:`, drawError, obj);
        // Optionally try to draw a placeholder or skip? For now, log and continue.
      }
    }
  });

  // --- Draw Overlays ---
  // Draw the placement ghost image if applicable (doesn't need culling)
  try {
    drawPlacementGhost();
  } catch (ghostError) {
    console.error("Error drawing placement ghost:", ghostError);
  }
}

/** Draws the semi-transparent ghost image of the item being placed in edit mode. */
function drawPlacementGhost() {
  // Check conditions for drawing the ghost
  if (
    !uiState.isEditMode ||
    uiState.editMode.state !== CLIENT_CONFIG?.EDIT_STATE_PLACING ||
    !uiState.editMode.selectedInventoryItemId ||
    !gameState.highlightedTile ||
    !SHARED_CONFIG?.FURNITURE_DEFINITIONS ||
    !ctx ||
    !camera ||
    !CLIENT_CONFIG
  ) {
    return; // Don't draw if conditions not met
  }

  const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
    (d) => d.id === uiState.editMode.selectedInventoryItemId
  );
  if (!definition) return; // Need definition to draw

  const gridX = gameState.highlightedTile.x;
  const gridY = gameState.highlightedTile.y;

  // Estimate Z position based on client-side stack calculation
  const estimatedBaseZ = getClientStackHeightAt(gridX, gridY); // Use helper from uiManager
  const ghostZ = estimatedBaseZ + (definition.zOffset || 0);

  const currentCtx = ctx; // Use the main context
  const currentCamera = camera; // Use the main camera state

  const screenPos = getScreenPos(gridX, gridY); // Util uses camera state
  const zoom = currentCamera.zoom;
  const zOffsetPx = ghostZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;

  // Determine appearance based on validity
  const alpha = uiState.editMode.placementValid ? 0.6 : 0.3;
  const color = uiState.editMode.placementValid
    ? definition.color || "#8B4513" // Use definition color or default brown
    : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR; // Red for invalid

  // --- Calculate drawing dimensions similar to ClientFurniture.draw ---
  const baseDrawWidth =
    SHARED_CONFIG.TILE_WIDTH_HALF * (definition.width || 1) * zoom * 1.1;
  const visualHeightFactor = definition.isFlat
    ? 0.1
    : definition.stackHeight
    ? definition.stackHeight * 1.5
    : 1.0;
  const baseDrawHeight =
    SHARED_CONFIG.TILE_HEIGHT_HALF * 3 * visualHeightFactor * zoom;
  const drawY =
    screenPos.y -
    baseDrawHeight +
    SHARED_CONFIG.TILE_HEIGHT_HALF * zoom -
    zOffsetPx;
  const drawX = screenPos.x - baseDrawWidth / 2;

  currentCtx.save();
  currentCtx.globalAlpha = alpha;
  currentCtx.fillStyle = color;
  currentCtx.strokeStyle = shadeColor(color, -50);
  currentCtx.lineWidth = Math.max(1, 1.5 * zoom);
  currentCtx.beginPath();

  // --- Draw Ghost Shape (Simplified versions) ---
  if (definition.isFlat) {
    const hW = SHARED_CONFIG.TILE_WIDTH_HALF * (definition.width || 1) * zoom;
    const hH = SHARED_CONFIG.TILE_HEIGHT_HALF * (definition.height || 1) * zoom;
    currentCtx.moveTo(screenPos.x, screenPos.y - hH - zOffsetPx);
    currentCtx.lineTo(screenPos.x + hW, screenPos.y - zOffsetPx);
    currentCtx.lineTo(screenPos.x, screenPos.y + hH - zOffsetPx);
    currentCtx.lineTo(screenPos.x - hW, screenPos.y - zOffsetPx);
    currentCtx.closePath();
  } else if (definition.isDoor) {
    currentCtx.rect(
      drawX + baseDrawWidth * 0.1,
      drawY,
      baseDrawWidth * 0.8,
      baseDrawHeight
    );
  } else {
    // Default box shape
    currentCtx.rect(drawX, drawY, baseDrawWidth, baseDrawHeight);
  }
  currentCtx.fill();
  currentCtx.stroke();

  // --- Draw Rotation Indicator Arrow (if not flat) ---
  if (!definition.isFlat) {
    currentCtx.fillStyle = "rgba(255, 255, 255, 0.7)";
    currentCtx.translate(screenPos.x, screenPos.y - zOffsetPx); // Translate to tile center (adjusting for Z)
    const angleRad = (uiState.editMode.placementRotation / 4) * Math.PI; // Convert direction 0-7 to radians
    currentCtx.rotate(angleRad);
    // Draw a simple triangle pointing East (direction 0) before rotation
    const arrowL = SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.8;
    const arrowW = arrowL * 0.6;
    currentCtx.beginPath();
    currentCtx.moveTo(arrowL * 0.6, 0); // Point
    currentCtx.lineTo(0, -arrowW / 2); // Base corner 1
    currentCtx.lineTo(0, arrowW / 2); // Base corner 2
    currentCtx.closePath();
    currentCtx.fill();
  }

  currentCtx.restore(); // Restore context state
}

/** Resizes the canvas drawing buffer and resets context properties. */
export function resizeRenderer(width, height) {
  if (canvas) {
    // Ensure non-zero dimensions
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);

    // Check if resize is actually needed
    if (canvas.width !== safeWidth || canvas.height !== safeHeight) {
      canvas.width = safeWidth;
      canvas.height = safeHeight;
      console.log(`Renderer canvas resized to: ${safeWidth}x${safeHeight}`);
      if (ctx) {
        // Reset any context properties affected by resize if needed
        ctx.imageSmoothingEnabled = false;
        // Other resets might go here (e.g., line width cache, etc. if you implement them)
      }
    }
  } else {
    console.warn("resizeRenderer called before canvas was ready.");
  }
}
