import { SHARED_CONFIG } from "../config.js";
import { getScreenPos } from "../utils.js"; // Needs screen position calculation

export class ClientTile {
  constructor(x, y, layoutType) {
    this.x = x;
    this.y = y;
    this.layoutType = layoutType; // 0=floor, 1=wall, 2=alt, 'X'=hole
    this.baseColor = "#b0e0b0"; // Default floor color
    this.highlight = null; // Overlay color string (e.g., 'rgba(255,0,0,0.3)')
    // Base draw order: Tiles drawn first based on Y then X. Large negative offset.
    // Lower numbers drawn first (background).
    this.drawOrder = Math.round(this.y * 100000 + this.x * 10000 - 500000);
    this._setBaseColor(); // Set color based on layout type
  }

  /** Sets the base tile color based on its layout type. */
  _setBaseColor() {
    switch (this.layoutType) {
      case 1:
        this.baseColor = "#A9A9A9";
        break; // Wall
      case 2:
        this.baseColor = "#ADD8E6";
        break; // Alt Floor
      case "X":
        this.baseColor = "#333333";
        break; // Hole
      case 0:
      default:
        this.baseColor = "#b0e0b0";
        break; // Floor
    }
  }

  /** Draws the tile on the canvas. */
  draw(ctx, camera) {
    // Ensure config and context are available
    if (
      !SHARED_CONFIG?.TILE_WIDTH_HALF ||
      !SHARED_CONFIG?.TILE_HEIGHT_HALF ||
      !ctx ||
      !camera
    ) {
      // console.warn("Tile draw skipped: config/ctx/camera not ready.");
      return;
    }

    const screenPos = getScreenPos(this.x, this.y); // Calculate screen position using util
    const zoom = camera.zoom;
    const halfW = SHARED_CONFIG.TILE_WIDTH_HALF * zoom;
    const halfH = SHARED_CONFIG.TILE_HEIGHT_HALF * zoom;

    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);

    // Define diamond tile shape path
    ctx.beginPath();
    ctx.moveTo(0, -halfH);
    ctx.lineTo(halfW, 0);
    ctx.lineTo(0, halfH);
    ctx.lineTo(-halfW, 0);
    ctx.closePath();

    // Fill with base color
    ctx.fillStyle = this.baseColor;
    ctx.fill();

    // Draw highlight overlay if active
    if (this.highlight) {
      ctx.fillStyle = this.highlight;
      ctx.fill();
    }

    // Draw outline unless it's a hole
    if (this.layoutType !== "X") {
      ctx.strokeStyle = "#444"; // Tile outline color
      ctx.lineWidth = Math.max(0.5, 1 * zoom); // Ensure minimum width
      ctx.stroke();
    }

    ctx.restore();
  }
}
