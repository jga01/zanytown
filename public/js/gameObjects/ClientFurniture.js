import { ClientGameObject } from "./ClientGameObject.js";
import { SHARED_CONFIG, CLIENT_CONFIG } from "../config.js";
import { getScreenPos, shadeColor, escapeHtml } from "../utils.js";
import { getAsset } from "../assetLoader.js";

export class ClientFurniture extends ClientGameObject {
  constructor(dto) {
    super(dto); // Call base constructor

    this.definitionId = dto.definitionId;
    this.rotation = dto.rotation ?? 0;
    this.state = dto.state; // e.g., 'on'/'off' for lamps
    this.colorOverride = dto.colorOverride || null; // Custom hex color
    this.isDoor = dto.isDoor || false;
    this.targetRoomId = dto.targetRoomId || null;

    this.ownerId = dto.ownerId || null;

    this.definition = null; // Cached definition from SHARED_CONFIG
    this.canRecolor = false; // From definition
    this.isSelected = false; // For edit mode selection highlight

    this.spriteImage = null;
    this.spriteInfo = null;

    this._updateDefinition(); // Find and cache definition
    this.update(dto); // Apply remaining properties (like state, color) and recalculate draw order
  }

  /** Finds and caches the furniture definition from SHARED_CONFIG. */
  _updateDefinition() {
    // Ensure config and definition ID exist
    if (!SHARED_CONFIG?.FURNITURE_DEFINITIONS || !this.definitionId) {
      this.definition = null;
      this.spriteInfo = null;
      this.spriteImage = null;
      return;
    }
    // Find definition
    this.definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (def) => def.id === this.definitionId
    );

    if (this.definition) {
      this.canRecolor = this.definition.canRecolor || false;
      this.isDoor = this.definition.isDoor || false; // Ensure correct door status
      this.targetRoomId = this.definition.targetRoomId || null;
      // --- Get Sprite Info ---
      this.spriteInfo = this.definition.sprite || null;
      if (this.definition.spriteSheetUrl) {
        // Assumes imageCache is globally accessible or passed in
        this.spriteImage = getAsset(this.definition.spriteSheetUrl);
        if (!this.spriteImage) {
          console.warn(
            `Sprite image not found in cache for URL: ${this.definition.spriteSheetUrl}`
          );
          // Assign a placeholder?
        }
      } else {
        this.spriteImage = null; // No sprite sheet defined
      }
    } else {
      console.warn(
        `ClientFurniture: Definition not found for ID ${this.definitionId}`
      );
      this.definition = null;
      this.spriteInfo = null;
      this.spriteImage = null;
    }
  }

  /** Updates furniture state from a server DTO. */
  update(dto) {
    // Check if definition needs updating (should be rare)
    if (dto.definitionId && dto.definitionId !== this.definitionId) {
      console.warn(
        `Furniture ${this.id} definition changed from ${this.definitionId} to ${dto.definitionId}`
      );
      this.definitionId = dto.definitionId;
      this.definition = null; // Clear cache
      this._updateDefinition(); // Reload definition
    }

    // Apply other DTO properties
    if (dto.rotation != null) this.rotation = dto.rotation;
    if (dto.state !== undefined) this.state = dto.state; // Allow null state
    if (dto.colorOverride !== undefined) this.colorOverride = dto.colorOverride;
    if (dto.isDoor !== undefined) this.isDoor = dto.isDoor;
    if (dto.targetRoomId !== undefined) this.targetRoomId = dto.targetRoomId;

    if (dto.ownerId !== undefined) this.ownerId = dto.ownerId;

    // Ensure definition is loaded if missed initially
    if (!this.definition) this._updateDefinition();

    super.update(dto); // Update base properties (x, y, z) and call calculateDrawOrder via base class
  }

  /** Draws the furniture on the canvas. */
  draw(ctx, camera) {
    // --- Essential Checks ---
    if (
      !this.isVisible ||
      !this.spriteImage ||
      !this.spriteInfo ||
      !ctx ||
      !camera ||
      !SHARED_CONFIG ||
      !CLIENT_CONFIG
    ) {
      // Optionally draw a fallback rectangle if sprite is missing but definition exists
      // if (this.definition && ctx && camera) { /* draw fallback shape */ }
      // console.warn(`Furniture draw skipped for ${this.id}: missing dependencies or assets.`);
      return;
    }

    // --- Determine Source Frame (sx, sy, sw, sh) ---
    let frameData = { ...(this.spriteInfo.base || {}) }; // Start with base frame, create copy

    // Apply state variation (e.g., lamp on/off)
    if (
      this.spriteInfo.states &&
      this.state &&
      this.spriteInfo.states[this.state]
    ) {
      frameData = { ...frameData, ...this.spriteInfo.states[this.state] }; // Merge state info over base/previous
    }

    // Apply rotation variation
    // Option 1: Using spriteInfo.rotations array (more explicit)
    if (this.spriteInfo.rotations && this.spriteInfo.rotations[this.rotation]) {
      frameData = { ...frameData, ...this.spriteInfo.rotations[this.rotation] }; // Merge rotation info
    }
    // Option 2: Using sequential frames (example assuming horizontal strip for N/S/E/W)
    // else if (this.spriteInfo.frameWidth && this.rotation % 2 === 0 && this.rotation < 8) { // Only handle cardinal for simple example
    //     const baseFrameX = this.spriteInfo.base?.x ?? 0;
    //     const rotationIndexMap = { 0: 0, 2: 1, 4: 2, 6: 3 }; // Map direction to frame index offset
    //     const frameIndex = rotationIndexMap[this.rotation] ?? 0;
    //     frameData.x = baseFrameX + (frameIndex * this.spriteInfo.frameWidth);
    //     // Note: This assumes frameWidth/height/anchor are the same for all rotations.
    //     // If they differ, this logic needs to be more complex or use the rotations array method.
    // }

    const sx = frameData.x ?? 0;
    const sy = frameData.y ?? 0;
    const sw = frameData.w ?? 0; // Source width from sprite sheet
    const sh = frameData.h ?? 0; // Source height from sprite sheet

    // --- Validate Source ---
    if (sw <= 0 || sh <= 0) {
      console.warn(
        `Invalid frame dimensions (w=${sw}, h=${sh}) for furniture ${this.id} (State: ${this.state}, Rot: ${this.rotation})`
      );
      return; // Don't draw if source dimensions are invalid
    }

    // --- Calculate Destination Size (dw, dh) ---
    const dw = sw * camera.zoom; // Destination width on canvas
    const dh = sh * camera.zoom; // Destination height on canvas

    // --- Calculate Destination Position (dx, dy) ---
    // 1. Get base screen position for the logical world coordinates
    const screenPos = getScreenPos(this.visualX, this.visualY);

    // 2. Calculate Z offset in pixels
    const zOffsetFactor =
      CLIENT_CONFIG.VISUAL_Z_FACTOR ?? SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5;
    const zOffsetPx = (this.visualZ || 0) * zOffsetFactor * camera.zoom;

    // 3. Determine anchor point relative to sprite frame, scaled by zoom
    // Anchor point defines where the sprite's origin is relative to the logical grid point.
    // Use anchor from the specific frame if defined, fallback to spriteInfo anchor, fallback to default (bottom-center).
    const anchorX = frameData.anchor?.x ?? this.spriteInfo.anchor?.x ?? sw / 2;
    const anchorY = frameData.anchor?.y ?? this.spriteInfo.anchor?.y ?? sh; // Default to bottom
    const anchorOffsetX = anchorX * camera.zoom;
    const anchorOffsetY = anchorY * camera.zoom;

    // 4. Calculate final top-left drawing position (dx, dy)
    const dx = screenPos.x - anchorOffsetX;
    const dy = screenPos.y - anchorOffsetY - zOffsetPx; // Z offset lifts the sprite vertically

    // --- Draw the Sprite ---
    ctx.save();
    try {
      // Tinting - Method 1: globalCompositeOperation (simpler, less accurate colors)
      // if (this.canRecolor && this.colorOverride) {
      //     ctx.drawImage(this.spriteImage, sx, sy, sw, sh, dx, dy, dw, dh); // Draw base image
      //     ctx.globalCompositeOperation = 'source-atop'; // Draw only where base image has pixels
      //     ctx.fillStyle = this.colorOverride;
      //     ctx.fillRect(dx, dy, dw, dh); // Fill with tint color
      //     ctx.globalCompositeOperation = 'source-over'; // Reset composite mode
      // } else {
      //     // Draw normally if no tint needed
      ctx.drawImage(this.spriteImage, sx, sy, sw, sh, dx, dy, dw, dh);
      // }
      // Note: More advanced tinting might involve creating an offscreen canvas,
      // manipulating pixel data, or using WebGL shaders. Keep it simple for now.
    } catch (e) {
      console.error(
        `Error drawing furniture sprite ${this.id} (${this.definitionId}):`,
        e
      );
      // Optionally draw a red box as an error indicator
      ctx.fillStyle = "red";
      ctx.fillRect(dx, dy, dw || 20, dh || 20);
    }

    // --- Draw Highlights / Other Overlays (after sprite) ---
    // Example: Selection highlight in edit mode
    if (this.isSelected && CLIENT_CONFIG.FURNI_SELECT_HIGHLIGHT_COLOR) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = CLIENT_CONFIG.FURNI_SELECT_HIGHLIGHT_COLOR;
      ctx.lineWidth = Math.max(2, 3 * camera.zoom); // Thicker highlight
      ctx.strokeRect(dx, dy, dw, dh); // Draw bounding box highlight
      ctx.globalAlpha = 1.0;
    }
    // Example: Hover highlight (less intrusive) - could be handled by uiManager's highlights
    // if (this.isHovered && CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR) {
    //     ctx.fillStyle = CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR;
    //     ctx.fillRect(dx, dy, dw, dh);
    // }

    // Draw Door Name Text (if applicable)
    if (this.isDoor && this.targetRoomId) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)"; // White text fill
      ctx.strokeStyle = "rgba(0, 0, 0, 0.8)"; // Black text outline
      ctx.lineWidth = Math.max(1, 2 * camera.zoom);
      ctx.font = `bold ${Math.max(7, 9 * camera.zoom)}px Verdana`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom"; // Align text bottom to position above sprite
      const hintText = `-> ${escapeHtml(this.targetRoomId)}`;
      const textY = dy - 5 * camera.zoom; // Position slightly above the drawn sprite's top edge
      ctx.strokeText(hintText, dx + dw / 2, textY); // Outline first
      ctx.fillText(hintText, dx + dw / 2, textY); // Fill second
    }

    ctx.restore(); // Restore context state (like globalAlpha)
  }
  /** Helper to get grid coordinates occupied by this furniture based on its definition and position. */
  getOccupiedTiles() {
    // Use the cached definition if available
    const definition = this.definition;
    if (!definition || !SHARED_CONFIG) {
      // Fallback if definition not loaded yet
      return [{ x: Math.round(this.x), y: Math.round(this.y) }];
    }

    const tiles = [];
    const startX = Math.round(this.x);
    const startY = Math.round(this.y);
    const width = definition.width || 1;
    const height = definition.height || 1;
    // Centered placement logic
    const halfW = Math.floor((width - 1) / 2);
    const halfH = Math.floor((height - 1) / 2);

    for (let dx = -halfW; dx < width - halfW; dx++) {
      for (let dy = -halfH; dy < height - halfH; dy++) {
        tiles.push({ x: startX + dx, y: startY + dy });
      }
    }
    // Ensure at least the base tile is returned for 1x1 items
    return tiles.length > 0 ? tiles : [{ x: startX, y: startY }];
  }
}
