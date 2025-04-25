import { SHARED_CONFIG } from "../config.js";
import { getScreenPos } from "../utils.js"; // Needs screen position calculation
import { getAsset } from "../assetLoader.js";

export class ClientTile {
  /**
   * Creates a new ClientTile instance.
   * @param {number} x - The world X coordinate of the tile.
   * @param {number} y - The world Y coordinate of the tile.
   * @param {number|string} layoutType - The type identifier from the room layout.
   */
  constructor(x, y, layoutType) {
    this.x = x;
    this.y = y;
    this.layoutType = String(layoutType); // Ensure type is string for lookup
    this.highlight = null; // Overlay color string (e.g., 'rgba(255,0,0,0.3)') or null

    // --- Sprite Information ---
    this.spriteSheetUrl = SHARED_CONFIG?.TILE_SPRITE_SHEET_URL || null;
    this.spriteImage = null; // Will hold the Image object
    this.frameData = null; // Will hold {x, y, w, h, anchor} for this tile type

    this._loadSpriteData(); // Load sprite data based on layoutType

    // Base draw order: Tiles drawn first based on Y then X.
    this.drawOrder = Math.round(this.y * 100000 + this.x * 1000 - 500000);
  }

  /**
   * Loads the sprite sheet image and frame data for this tile type.
   */
  _loadSpriteData() {
    if (!this.spriteSheetUrl) {
      console.warn(
        `Tile (${this.x},${this.y}): TILE_SPRITE_SHEET_URL not defined in config.`
      );
      return;
    }

    // Get the preloaded image asset
    this.spriteImage = getAsset(this.spriteSheetUrl);
    if (!this.spriteImage) {
      console.error(
        `Tile (${this.x},${this.y}): Sprite image not loaded/found in cache for ${this.spriteSheetUrl}`
      );
      return; // Cannot proceed without the image
    }

    // Find the specific frame data for this tile's layoutType
    const definitions = SHARED_CONFIG?.TILE_SPRITE_DEFINITIONS;
    this.frameData =
      definitions?.[this.layoutType] || definitions?.["default"] || null;

    if (!this.frameData) {
      console.warn(
        `Tile (${this.x},${this.y}): No sprite definition found for layoutType '${this.layoutType}' or default.`
      );
    } else if (this.frameData.w == null || this.frameData.h == null) {
      console.error(
        `Tile (${this.x},${this.y}): Invalid frame data for layoutType '${this.layoutType}':`,
        this.frameData
      );
      this.frameData = null; // Invalidate if dimensions missing
    }
  }

  /**
   * Draws the tile sprite onto the provided canvas context.
   * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
   * @param {object} camera - The camera state object ({x, y, zoom}).
   */
  draw(ctx, camera) {
    // --- Essential Checks ---
    // Check if sprite data was successfully loaded
    if (!this.spriteImage || !this.frameData || !ctx || !camera) {
      // Optional: Draw a fallback colored rectangle if sprite failed
      if (ctx && camera) {
        // console.warn(`Drawing fallback for tile (${this.x},${this.y}) due to missing sprite data.`);
        this._drawFallbackColor(ctx, camera);
      }
      return;
    }
    // Added check for valid dimensions in frameData
    if (
      !this.frameData.w ||
      !this.frameData.h ||
      this.frameData.w <= 0 ||
      this.frameData.h <= 0
    ) {
      console.error(
        `Tile (${this.x},${this.y}): Invalid frame dimensions in frameData.w=${this.frameData.w}, h=${this.frameData.h}`
      );
      this._drawFallbackColor(ctx, camera); // Draw fallback
      return;
    }

    // --- Source Rect (sx, sy, sw, sh) ---
    const sx = this.frameData.x ?? 0;
    const sy = this.frameData.y ?? 0;
    const sw = this.frameData.w; // Already validated
    const sh = this.frameData.h; // Already validated

    // --- Destination Size (dw, dh) ---
    const zoom = camera.zoom;
    const dw = sw * zoom;
    const dh = sh * zoom;

    // --- Destination Position (dx, dy) ---
    const screenPos = getScreenPos(this.x, this.y); // Gets center point on screen

    // Use anchor defined in TILE_SPRITE_DEFINITIONS
    const anchor = this.frameData.anchor || { x: sw / 2, y: sh / 2 }; // Default to center if missing
    const anchorX = anchor.x ?? sw / 2;
    const anchorY = anchor.y ?? sh / 2;

    const anchorOffsetX = anchorX * zoom;
    const anchorOffsetY = anchorY * zoom;

    // Calculate top-left corner for drawing
    const dx = screenPos.x - anchorOffsetX;
    const dy = screenPos.y - anchorOffsetY; // Tiles typically don't have Z offset

    // --- Drawing ---
    ctx.save();
    try {
      // Draw the tile sprite
      ctx.drawImage(this.spriteImage, sx, sy, sw, sh, dx, dy, dw, dh);

      // --- Draw Highlight Overlay ---
      if (this.highlight) {
        ctx.fillStyle = this.highlight;
        // Draw a rectangle over the drawn sprite area
        ctx.fillRect(dx, dy, dw, dh);
        // Note: This rectangle won't perfectly match the isometric diamond shape.
        // For a shape-matched highlight, you'd need to draw the sprite again
        // with a color tint using globalCompositeOperation, which is more complex.
      }
    } catch (e) {
      console.error(`Error drawing tile sprite (${this.x},${this.y}):`, e);
      // Draw an error indicator rectangle
      ctx.fillStyle = "rgba(255, 0, 0, 0.5)"; // Semi-transparent red
      ctx.fillRect(dx, dy, dw || 10, dh || 5); // Use fallback size if dw/dh invalid
    } finally {
      ctx.restore(); // Restore context state
    }
  }

  /**
   * Draws a fallback colored diamond if sprite rendering fails.
   * (Essentially the old procedural drawing logic)
   */
  _drawFallbackColor(ctx, camera) {
    const tileWidthHalf = SHARED_CONFIG?.TILE_WIDTH_HALF;
    const tileHeightHalf = SHARED_CONFIG?.TILE_HEIGHT_HALF;
    if (tileWidthHalf == null || tileHeightHalf == null) return; // Need dimensions

    const screenPos = getScreenPos(this.x, this.y);
    const zoom = camera.zoom;
    const halfW = tileWidthHalf * zoom;
    const halfH = tileHeightHalf * zoom;

    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);
    ctx.beginPath();
    ctx.moveTo(0, -halfH);
    ctx.lineTo(halfW, 0);
    ctx.lineTo(0, halfH);
    ctx.lineTo(-halfW, 0);
    ctx.closePath();

    // Use a fallback color based on type or just a default error color
    let fallbackColor = "#FF00FF"; // Magenta default error
    switch (this.layoutType) {
      case "1":
        fallbackColor = "#A9A9A9";
        break;
      case "2":
        fallbackColor = "#ADD8E6";
        break;
      case "X":
        fallbackColor = "#333333";
        break;
      case "0":
        fallbackColor = "#b0e0b0";
        break;
    }
    ctx.fillStyle = fallbackColor;
    ctx.fill();

    if (this.highlight) {
      ctx.fillStyle = this.highlight;
      ctx.fill();
    }
    if (this.layoutType !== "X") {
      ctx.strokeStyle = "#444";
      ctx.lineWidth = Math.max(0.5, 1 * zoom);
      ctx.stroke();
    }
    ctx.restore();
  }
}
