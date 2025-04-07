import { gameState, uiState, camera } from "./gameState.js";
import { getScreenPos, shadeColor } from "./utils.js"; // Import necessary utils
import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientTile } from "./gameObjects/ClientTile.js";
import { getClientStackHeightAt } from "./uiManager.js"; // Placement ghost needs stack height calc

let ctx = null;
let canvas = null;

/** Initializes the renderer with the canvas element and context. */
export function initRenderer(canvasElement, context) {
  canvas = canvasElement;
  ctx = context;
  if (!ctx) {
    console.error("Renderer init failed: No context provided.");
    return false;
  }
  ctx.imageSmoothingEnabled = false; // Use nearest-neighbor scaling for crisp pixels
  console.log("Renderer initialized.");
  return true;
}

/** The main rendering function, called every frame by the game loop. */
export function renderGame() {
  if (!ctx || !canvas || !CLIENT_CONFIG || !SHARED_CONFIG) {
    // Don't draw if not ready
    // console.warn("Render skipped: renderer not ready or config missing.");
    return;
  }

  // --- Clear Canvas ---
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#003366"; // Dark blue default background
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // --- Collect & Sort Drawable Objects ---
  // Combine tiles, furniture, and avatars into a single array for sorting
  const drawables = [
    ...(gameState.clientTiles || []), // Add tiles first
    ...Object.values(gameState.furniture || {}), // Add furniture instances
    ...Object.values(gameState.avatars || {}), // Add avatar instances
  ];

  // Sort based on pre-calculated drawOrder (lower numbers drawn first)
  // Ensure drawOrder is a valid number for all potential objects
  drawables.sort((a, b) => (a?.drawOrder ?? 0) - (b?.drawOrder ?? 0));

  // --- Draw Objects ---
  // Iterate and call the draw method on each object
  drawables.forEach((obj) => {
    if (obj && typeof obj.draw === "function") {
      // Pass the context and camera state needed for drawing
      obj.draw(ctx, camera);
    } else {
      // console.warn("Attempted to draw object without draw method:", obj);
    }
  });

  // --- Draw Overlays ---
  // Draw the placement ghost image if applicable
  drawPlacementGhost();
}

/** Draws the semi-transparent ghost image of the item being placed in edit mode. */
function drawPlacementGhost() {
  // Check conditions for drawing the ghost
  if (
    !uiState.isEditMode ||
    uiState.editMode.state !== CLIENT_CONFIG.EDIT_STATE_PLACING ||
    !uiState.editMode.selectedInventoryItemId ||
    !gameState.highlightedTile ||
    !SHARED_CONFIG?.FURNITURE_DEFINITIONS || // Ensure definitions are loaded
    !ctx ||
    !camera
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

  // --- Use the Renderer's context and camera ---
  const currentCtx = ctx;
  const currentCamera = camera;

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
    // Draw simple door frame rectangle
    currentCtx.rect(
      drawX + baseDrawWidth * 0.1,
      drawY,
      baseDrawWidth * 0.8,
      baseDrawHeight
    );
    // Fill inner panel separately if needed (less important for ghost)
  } else {
    // Default box shape
    currentCtx.rect(drawX, drawY, baseDrawWidth, baseDrawHeight);
  }
  currentCtx.fill();
  currentCtx.stroke();

  // --- Draw Rotation Indicator Arrow (if not flat) ---
  if (!definition.isFlat) {
    currentCtx.fillStyle = "rgba(255, 255, 255, 0.7)";
    // Translate to the *center* of the tile for rotation pivot, adjust for Z
    currentCtx.translate(screenPos.x, screenPos.y - zOffsetPx);
    const angleRad = (uiState.editMode.placementRotation / 4) * Math.PI; // Convert direction 0-7 to radians
    currentCtx.rotate(angleRad);
    // Draw a simple triangle pointing East (direction 0) before rotation
    const arrowL = SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.8; // Length based on tile height
    const arrowW = arrowL * 0.6; // Width
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
    // Check if resize is actually needed
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      console.log(`Renderer canvas resized to: ${width}x${height}`);
      if (ctx) {
        // Reset any context properties affected by resize
        ctx.imageSmoothingEnabled = false;
      }
    }
  } else {
    console.warn("resizeRenderer called before canvas was ready.");
  }
}
