import { ClientGameObject } from "./ClientGameObject.js";
import { SHARED_CONFIG, CLIENT_CONFIG } from "../config.js";
import { getScreenPos, shadeColor } from "../utils.js";

export class ClientFurniture extends ClientGameObject {
  constructor(dto) {
    super(dto); // Call base constructor

    this.definitionId = dto.definitionId;
    this.rotation = dto.rotation ?? 0;
    this.state = dto.state; // e.g., 'on'/'off' for lamps
    this.colorOverride = dto.colorOverride || null; // Custom hex color
    this.isDoor = dto.isDoor || false;
    this.targetRoomId = dto.targetRoomId || null;

    this.definition = null; // Cached definition from SHARED_CONFIG
    this.canRecolor = false; // From definition
    this.isSelected = false; // For edit mode selection highlight

    this._updateDefinition(); // Find and cache definition
    this.update(dto); // Apply remaining properties (like state, color) and recalculate draw order
  }

  /** Finds and caches the furniture definition from SHARED_CONFIG. */
  _updateDefinition() {
    if (!SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
      // console.warn(`Cannot update definition for ${this.id}: SHARED_CONFIG not ready.`);
      return;
    }
    if (!this.definition && this.definitionId) {
      this.definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (def) => def.id === this.definitionId
      );
      if (this.definition) {
        this.canRecolor = this.definition.canRecolor || false;
        // Ensure door status matches definition if not provided in DTO
        if (!this.isDoor && this.definition.isDoor) {
          this.isDoor = true;
          this.targetRoomId = this.definition.targetRoomId;
        }
      } else {
        console.warn(
          `ClientFurniture: Definition not found for ID ${this.definitionId}`
        );
      }
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

    // Ensure definition is loaded if missed initially
    if (!this.definition) this._updateDefinition();

    super.update(dto); // Update base properties (x, y, z) and call calculateDrawOrder via base class
  }

  /** Draws the furniture on the canvas. */
  draw(ctx, camera) {
    if (
      !this.definition ||
      !this.isVisible ||
      !SHARED_CONFIG ||
      !CLIENT_CONFIG ||
      !ctx ||
      !camera
    ) {
      // console.warn(`Furniture draw skipped for ${this.id}: missing dependencies.`);
      return;
    }

    const definition = this.definition;
    const screenPos = getScreenPos(this.visualX, this.visualY);
    const zoom = camera.zoom;

    // Calculate drawing dimensions and Z offset
    const baseDrawWidth =
      SHARED_CONFIG.TILE_WIDTH_HALF * (definition.width || 1) * zoom * 1.1; // Slightly wider for visual effect
    const visualHeightFactor = definition.isFlat
      ? 0.1
      : definition.stackHeight
      ? definition.stackHeight * 1.5
      : 1.0;
    const baseDrawHeight =
      SHARED_CONFIG.TILE_HEIGHT_HALF * 3 * visualHeightFactor * zoom; // Approx visual height
    const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;

    // Calculate Y for the *top* edge of the main graphic (adjusting for visual height and Z)
    const drawY =
      screenPos.y -
      baseDrawHeight +
      SHARED_CONFIG.TILE_HEIGHT_HALF * zoom -
      zOffsetPx;
    const drawX = screenPos.x - baseDrawWidth / 2; // Center X

    // Determine fill/stroke colors
    let baseFill = this.colorOverride || definition.color || "#8B4513";
    if (
      !this.colorOverride &&
      definition.id === "light_simple" &&
      definition.canUse
    ) {
      baseFill = this.state === "on" ? "#FFFF00" : "#AAAAAA"; // Lamp state color
    }
    let baseStroke = shadeColor(baseFill, -50);

    // --- Save context and apply base style ---
    ctx.save();
    const applyStyle = (style) => {
      ctx.fillStyle = style.fill || baseFill;
      ctx.strokeStyle = style.stroke || baseStroke;
      ctx.lineWidth = style.lineWidth || Math.max(1, 1.5 * zoom);
      ctx.globalAlpha = style.alpha ?? 1.0;
    };
    applyStyle({ fill: baseFill, stroke: baseStroke }); // Apply initial style

    // --- Define Shape Path Function (Simplified representations) ---
    const defineShapePath = () => {
      ctx.beginPath();
      if (definition.isFlat) {
        // Draw flat diamond centered on visual position, offset by Z
        const currentZOffsetPx =
          this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
        const halfW =
          SHARED_CONFIG.TILE_WIDTH_HALF * (definition.width || 1) * zoom;
        const halfH =
          SHARED_CONFIG.TILE_HEIGHT_HALF * (definition.height || 1) * zoom;
        ctx.moveTo(screenPos.x, screenPos.y - halfH - currentZOffsetPx);
        ctx.lineTo(screenPos.x + halfW, screenPos.y - currentZOffsetPx);
        ctx.lineTo(screenPos.x, screenPos.y + halfH - currentZOffsetPx);
        ctx.lineTo(screenPos.x - halfW, screenPos.y - currentZOffsetPx);
        ctx.closePath();
      } else if (definition.canSit) {
        // Draw basic chair (seat + back based on rotation)
        const seatHeight = baseDrawHeight * 0.4;
        const backHeight = baseDrawHeight * 0.6;
        const seatWidth = baseDrawWidth;
        // Seat rectangle path
        ctx.rect(drawX, drawY + backHeight, seatWidth, seatHeight);
        // Backrest rectangle path (simplified rotation logic)
        const backWidthFactor = 0.8;
        const backThicknessFactor = 0.15;
        const backVisualWidth = seatWidth * backWidthFactor;
        const backVisualThickness = seatWidth * backThicknessFactor;
        let backDrawX = drawX + (seatWidth - backVisualWidth) / 2;
        let actualBackWidth = backVisualWidth;
        let actualBackHeight = backHeight;
        // Adjust based on cardinal directions for simplicity
        if (this.rotation === SHARED_CONFIG.DIRECTION_EAST) {
          // Facing East (back is West)
          backDrawX = drawX + seatWidth * (1 - backThicknessFactor - 0.05); // Right side
          actualBackWidth = backVisualThickness;
        } else if (this.rotation === SHARED_CONFIG.DIRECTION_WEST) {
          // Facing West (back is East)
          backDrawX = drawX + seatWidth * 0.05; // Left side
          actualBackWidth = backVisualThickness;
        } else if (this.rotation === SHARED_CONFIG.DIRECTION_NORTH) {
          // Facing North (back is South)
          // Drawn as full width back (like South) in this simple representation
        }
        ctx.rect(backDrawX, drawY, actualBackWidth, actualBackHeight);
      } else if (definition.id === "light_simple") {
        // Draw basic lamp shape (base, pole, shade)
        const lampBaseHeight = baseDrawHeight * 0.2;
        const lampPoleHeight = baseDrawHeight * 0.6;
        const lampShadeHeight = baseDrawHeight * 0.2;
        const lampWidth = baseDrawWidth * 0.5;
        const lampX = drawX + (baseDrawWidth - lampWidth) / 2;
        // Base path
        ctx.rect(
          lampX,
          drawY + lampPoleHeight + lampShadeHeight,
          lampWidth,
          lampBaseHeight
        );
        // Pole path
        ctx.rect(
          lampX + lampWidth * 0.3,
          drawY + lampShadeHeight,
          lampWidth * 0.4,
          lampPoleHeight
        );
        // Shade path (trapezoid)
        ctx.moveTo(lampX, drawY + lampShadeHeight);
        ctx.lineTo(lampX + lampWidth, drawY + lampShadeHeight);
        ctx.lineTo(lampX + lampWidth * 0.8, drawY);
        ctx.lineTo(lampX + lampWidth * 0.2, drawY);
        ctx.closePath();
      } else if (this.isDoor) {
        // Generic door drawing
        // Draw basic door frame rectangle
        ctx.rect(
          drawX + baseDrawWidth * 0.1,
          drawY,
          baseDrawWidth * 0.8,
          baseDrawHeight
        );
        // Inner panel (drawn separately after fill/stroke)
      } else {
        // Default: Draw a simple box shape
        ctx.rect(drawX, drawY, baseDrawWidth, baseDrawHeight);
      }
    };
    // --- End Shape Path Function ---

    // Fill and Stroke the main shape
    defineShapePath();
    ctx.fill();
    ctx.stroke();

    // Specific details after base shape
    if (definition.id === "light_simple" && this.state === "on") {
      // Draw light cone if state is 'on'
      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 180, 0.25)"; // Semi-transparent yellow light
      ctx.beginPath();
      const lampWidth = baseDrawWidth * 0.5;
      const lampX = drawX + (baseDrawWidth - lampWidth) / 2;
      const lampShadeHeight = baseDrawHeight * 0.2;
      ctx.moveTo(lampX + lampWidth * 0.1, drawY + lampShadeHeight);
      ctx.lineTo(lampX + lampWidth * 0.9, drawY + lampShadeHeight);
      ctx.lineTo(
        lampX + lampWidth + 20 * zoom,
        drawY + baseDrawHeight + 30 * zoom
      ); // Wider at bottom
      ctx.lineTo(lampX - 20 * zoom, drawY + baseDrawHeight + 30 * zoom);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else if (this.isDoor) {
      // Draw darker inner panel for doors
      ctx.fillStyle = shadeColor(baseFill, -20);
      // Use same drawX, drawY, baseDrawWidth, baseDrawHeight
      ctx.fillRect(
        drawX + baseDrawWidth * 0.2,
        drawY + baseDrawHeight * 0.1,
        baseDrawWidth * 0.6,
        baseDrawHeight * 0.8
      );
    }

    // Draw Selection Highlight if selected in edit mode
    if (this.isSelected && CLIENT_CONFIG) {
      // Check CLIENT_CONFIG exists
      const highlightStyle = {
        fill: "none", // No fill for highlight outline
        stroke: CLIENT_CONFIG.FURNI_SELECT_HIGHLIGHT_COLOR,
        lineWidth: Math.max(2, 3 * zoom),
        alpha: 0.8,
      };
      applyStyle(highlightStyle); // Apply highlight style
      defineShapePath(); // Redefine the path for the highlight stroke
      ctx.stroke();
    }

    // Draw Door Name Text
    if (this.isDoor && this.targetRoomId) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.8)"; // Dark text fill
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)"; // Light text outline
      ctx.lineWidth = 2;
      ctx.font = `bold ${Math.max(7, 9 * zoom)}px Verdana`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const hintText = `-> ${this.targetRoomId}`;
      const textY = drawY - 5 * zoom; // Position above the furniture's drawn top edge
      ctx.strokeText(hintText, screenPos.x, textY); // Outline first
      ctx.fillText(hintText, screenPos.x, textY); // Fill second
      // Reset alignment/baseline if needed elsewhere (good practice)
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    ctx.restore(); // Restore context state
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
