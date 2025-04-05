(function () {
  "use strict";

  // Configuration loaded from server/defined after load
  let SHARED_CONFIG = null;
  let CLIENT_CONFIG = null;

  // --- Client State ---
  let canvas, ctx, gameContainer;
  let lastTimestamp = 0;
  let socket;
  const camera = { x: 0, y: 0, zoom: 1.0 };

  const gameState = {
    // Room specific state (cleared on room change)
    roomLayout: [],
    roomCols: 0,
    roomRows: 0,
    clientTiles: [],
    furniture: {}, // Map: id -> ClientFurniture instance (in current room)
    avatars: {}, // Map: id -> ClientAvatar instance (in current room)
    highlightedTile: null,
    currentRoomId: null, // Track current room ID

    // Global/Persistent state (potentially kept across room changes)
    inventory: {}, // Map: definitionId -> quantity
    myAvatarId: null,
    myCurrency: 0,
  };

  const uiState = {
    // DOM Element References
    debugDiv: null,
    chatInput: null,
    chatLogDiv: null,
    bubbleContainer: null,
    inventoryItemsDiv: null,
    pickupFurniBtn: null,
    recolorBtn: null,
    currencyDisplay: null,
    roomNameDisplay: null,
    userListPanel: null,
    userListContent: null,
    profilePanel: null,
    profileContent: null,
    profileCloseBtn: null,
    recolorPanel: null,
    recolorSwatchesDiv: null,
    recolorItemNameP: null,
    recolorCloseBtn: null,
    recolorResetBtn: null,
    shopPanel: null,
    shopItemsDiv: null,
    shopCloseBtn: null,
    openShopBtn: null,
    // UI Data
    activeChatBubbles: [],
    chatMessages: [],
    nextBubbleId: 0,
    isEditMode: false,
    editMode: {
      state: null, // Initialized in resetLocalState/initClient
      selectedInventoryItemId: null, // Item selected from INVENTORY
      selectedFurnitureId: null, // Furniture selected on the FLOOR (in current room)
      placementValid: false,
      placementRotation: 0,
    },
    activeRecolorFurniId: null, // Track which item the recolor panel is for
  };

  const inputState = {
    keysPressed: {},
    isDragging: false,
    lastMousePos: { x: 0, y: 0 },
    currentMouseScreenPos: { x: 0, y: 0 },
    currentMouseWorldPos: { x: 0, y: 0 },
    currentMouseGridPos: { x: 0, y: 0 },
  };

  // Sound objects (Audio elements loaded in init)
  const sounds = {
    walk: null,
    place: null,
    chat: null,
    use: null,
    wave: null,
    dance: null,
    happy: null,
    sad: null,
  };

  // --- Utility Functions ---

  /** Converts world coordinates (tiles) to isometric screen coordinates (pixels) relative to world origin. */
  function worldToIso(x, y) {
    if (!SHARED_CONFIG) return { x: 0, y: 0 };
    const screenX = (x - y) * SHARED_CONFIG.TILE_WIDTH_HALF;
    const screenY = (x + y) * SHARED_CONFIG.TILE_HEIGHT_HALF;
    return { x: screenX, y: screenY };
  }

  /** Converts isometric screen coordinates (pixels) relative to canvas origin back to world coordinates (tiles). */
  function isoToWorld(screenX, screenY) {
    if (!SHARED_CONFIG) return { x: 0, y: 0 };
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
  function snapToGrid(worldX, worldY) {
    return { x: Math.round(worldX), y: Math.round(worldY) };
  }

  /** Converts world coordinates to final screen position including camera pan and zoom. */
  function getScreenPos(worldX, worldY) {
    const iso = worldToIso(worldX, worldY);
    return {
      x: iso.x * camera.zoom + camera.x,
      y: iso.y * camera.zoom + camera.y,
    };
  }

  /** Lightens or darkens a hex color by a percentage. */
  function shadeColor(color, percent) {
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
  function rotateDirection(currentDir, amount) {
    return (currentDir + amount + 8) % 8;
  }

  /** Attempts to play a loaded sound effect. Handles potential browser restrictions. */
  function playSound(soundName) {
    if (sounds[soundName]) {
      sounds[soundName].currentTime = 0;
      sounds[soundName]
        .play()
        .catch((e) =>
          console.warn(`Sound play failed for ${soundName}:`, e.name, e.message)
        );
    } else {
      // Cache warnings to avoid spamming console for the same unloaded sound
      if (!playSound.warned) playSound.warned = {};
      if (!playSound.warned[soundName]) {
        console.warn(
          `Attempted to play undefined or unloaded sound: ${soundName}`
        );
        playSound.warned[soundName] = true;
      }
    }
  }

  // --- Client-Side Game Object Classes ---

  /** Base class for client-side objects with position and interpolation. */
  class ClientGameObject {
    constructor(dto) {
      this.id = dto.id;
      this.x = dto.x;
      this.y = dto.y;
      this.z = dto.z;
      this.visualX = dto.x;
      this.visualY = dto.y;
      this.visualZ = dto.z;
      this.drawOrder = 0;
      this.isVisible = true;
      this.update(dto); // Apply initial state
    }
    update(dto) {
      // Apply updates from server DTO
      if (dto.x != null) this.x = dto.x;
      if (dto.y != null) this.y = dto.y;
      if (dto.z != null) this.z = dto.z;
      this.calculateDrawOrder();
    }
    interpolate(deltaTimeFactor) {
      // Smoothly move visual representation towards target state
      this.visualX += (this.x - this.visualX) * deltaTimeFactor;
      this.visualY += (this.y - this.visualY) * deltaTimeFactor;
      this.visualZ += (this.z - this.visualZ) * deltaTimeFactor;
      // Snap if very close to target to avoid tiny oscillations
      const SNAP_THRESHOLD = 0.01;
      if (Math.abs(this.x - this.visualX) < SNAP_THRESHOLD)
        this.visualX = this.x;
      if (Math.abs(this.y - this.visualY) < SNAP_THRESHOLD)
        this.visualY = this.y;
      if (Math.abs(this.z - this.visualZ) < SNAP_THRESHOLD)
        this.visualZ = this.z;
      this.calculateDrawOrder(); // Recalculate based on interpolated position
    }
    calculateDrawOrder() {
      // Calculates isometric draw order. Objects further "back" (higher Y)
      // and further "right" (higher X) are drawn first. Z is a tie-breaker.
      // Large multipliers ensure Y priority > X priority > Z priority.
      // Base offset ensures objects are generally drawn after tiles.
      this.drawOrder =
        Math.round(
          this.visualY * 100000 + this.visualX * 10000 + this.visualZ * 1000
        ) + 1000;
    }
    draw(ctx) {
      // Base method, intended to be overridden in subclasses
    }
  }

  /** Represents a single floor/wall/hole tile for rendering. */
  class ClientTile {
    constructor(x, y, layoutType) {
      this.x = x;
      this.y = y;
      this.layoutType = layoutType;
      this.baseColor = "#b0e0b0";
      this.highlight = null; // Overlay color string (e.g., for placement/hover)
      // Base draw order: Tiles drawn first based on Y then X. Large negative offset.
      this.drawOrder = this.y * 100000 + this.x * 10000 - 500000;
      this._setBaseColor();
    }
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
    draw(ctx) {
      if (!SHARED_CONFIG) return;
      const screenPos = getScreenPos(this.x, this.y);
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
      ctx.fillStyle = this.baseColor;
      ctx.fill();
      // Draw highlight overlay if active
      if (this.highlight) {
        ctx.fillStyle = this.highlight;
        ctx.fill();
      }
      // Draw outline unless it's a hole
      if (this.layoutType !== "X") {
        ctx.strokeStyle = "#444";
        ctx.lineWidth = Math.max(0.5, 1 * zoom);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Represents a piece of furniture on the client. */
  class ClientFurniture extends ClientGameObject {
    constructor(dto) {
      super(dto);
      this.definitionId = dto.definitionId;
      this.rotation = dto.rotation;
      this.state = dto.state;
      this.colorOverride = dto.colorOverride || null;
      this.definition = null; // Cached definition
      this.canRecolor = false;
      this.isSelected = false; // For edit mode selection highlight

      this.isDoor = dto.isDoor || false;
      this.targetRoomId = dto.targetRoomId || null;

      this.updateDefinition(); // Find definition based on ID
      this.update(dto); // Apply remaining properties
    }

    /** Finds and caches the furniture definition from SHARED_CONFIG. */
    updateDefinition() {
      if (!SHARED_CONFIG) return;
      if (!this.definition && this.definitionId) {
        this.definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (def) => def.id === this.definitionId
        );
        if (this.definition) {
          this.canRecolor = this.definition.canRecolor || false;
          // Potentially update door status based on definition if not in DTO
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

    update(dto) {
      // Check if definition needs updating
      if (dto.definitionId && dto.definitionId !== this.definitionId) {
        console.warn(
          `Furniture ${this.id} definition changed from ${this.definitionId} to ${dto.definitionId}`
        );
        this.definitionId = dto.definitionId;
        this.definition = null; // Clear cache
        this.updateDefinition(); // Reload definition
      }
      // Apply other DTO properties
      if (dto.rotation != null) this.rotation = dto.rotation;
      if (dto.state != null) this.state = dto.state;
      if (dto.colorOverride !== undefined)
        this.colorOverride = dto.colorOverride;
      if (dto.isDoor !== undefined) this.isDoor = dto.isDoor;
      if (dto.targetRoomId !== undefined) this.targetRoomId = dto.targetRoomId;

      super.update(dto); // Update base properties (x, y, z)
      if (!this.definition) this.updateDefinition(); // Ensure definition is loaded if missed
    }

    draw(ctx) {
      if (
        !this.definition ||
        !this.isVisible ||
        !SHARED_CONFIG ||
        !CLIENT_CONFIG
      )
        return;
      const definition = this.definition;
      const screenPos = getScreenPos(this.visualX, this.visualY);
      const zoom = camera.zoom;

      // Calculate drawing dimensions and Z offset
      const baseDrawWidth =
        SHARED_CONFIG.TILE_WIDTH_HALF * definition.width * zoom * 1.1;
      const visualHeightFactor = definition.isFlat
        ? 0.1
        : definition.stackHeight
        ? definition.stackHeight * 1.5
        : 1.0; // Visual height representation
      const baseDrawHeight =
        SHARED_CONFIG.TILE_HEIGHT_HALF * 3 * visualHeightFactor * zoom;
      // VISUAL_Z_FACTOR converts Z units to screen pixels based on tile height
      const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
      // Calculate the Y coordinate for the *top* edge of the main furniture graphic
      const drawY =
        screenPos.y -
        baseDrawHeight +
        SHARED_CONFIG.TILE_HEIGHT_HALF * zoom -
        zOffsetPx;
      const drawX = screenPos.x - baseDrawWidth / 2;

      // Determine fill and stroke colors, prioritizing override, then state (for lamp), then definition
      let baseFill = this.colorOverride || definition.color || "#8B4513";
      if (
        !this.colorOverride &&
        definition.id === "light_simple" &&
        definition.canUse
      ) {
        baseFill = this.state === "on" ? "#FFFF00" : "#AAAAAA";
      }
      let baseStroke = shadeColor(baseFill, -50);

      // Optional: Highlight doors
      // if (this.isDoor) { baseStroke = "#00FFFF"; }

      const baseStyle = {
        fill: baseFill,
        stroke: baseStroke,
        lineWidth: Math.max(1, 1.5 * zoom),
      };

      ctx.save();
      const applyStyle = (style) => {
        ctx.fillStyle = style.fill;
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.lineWidth;
        ctx.globalAlpha = style.alpha ?? 1.0;
      };

      // --- Define Shape Path (Simplified representation of drawing logic) ---
      const defineShapePath = () => {
        ctx.beginPath();
        if (definition.isFlat) {
          // Draw flat diamond shape based on width/height and Z offset
          const currentZOffsetPx =
            this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
          const halfW = SHARED_CONFIG.TILE_WIDTH_HALF * definition.width * zoom;
          const halfH =
            SHARED_CONFIG.TILE_HEIGHT_HALF * definition.height * zoom;
          ctx.moveTo(screenPos.x, screenPos.y - halfH - currentZOffsetPx);
          ctx.lineTo(screenPos.x + halfW, screenPos.y - currentZOffsetPx);
          ctx.lineTo(screenPos.x, screenPos.y + halfH - currentZOffsetPx);
          ctx.lineTo(screenPos.x - halfW, screenPos.y - currentZOffsetPx);
          ctx.closePath();
        } else if (definition.canSit) {
          // Draw basic chair shape (seat + back based on rotation)
          const seatHeight = baseDrawHeight * 0.4;
          const backHeight = baseDrawHeight * 0.6;
          const seatWidth = baseDrawWidth;
          ctx.rect(drawX, drawY + backHeight, seatWidth, seatHeight); // Seat
          // Backrest drawing adjusted by rotation
          const backWidthFactor = 0.8;
          const backThicknessFactor = 0.15;
          const backVisualWidth = seatWidth * backWidthFactor;
          const backVisualThickness = seatWidth * backThicknessFactor;
          let backDrawX = drawX + (seatWidth - backVisualWidth) / 2;
          let backDrawY = drawY;
          let actualBackWidth = backVisualWidth;
          let actualBackHeight = backHeight;
          switch (this.rotation) {
            case SHARED_CONFIG.DIRECTION_EAST:
              backDrawX = drawX + seatWidth * 0.1;
              actualBackWidth = backVisualThickness;
              break;
            case SHARED_CONFIG.DIRECTION_WEST:
              backDrawX = drawX + seatWidth * 0.9 - backVisualThickness;
              actualBackWidth = backVisualThickness;
              break;
            case SHARED_CONFIG.DIRECTION_NORTH:
              backDrawY = drawY + backHeight * 0.8;
              actualBackHeight = backHeight * 0.2;
              break;
            // Default case (DIRECTION_SOUTH etc.) draws full width back
          }
          ctx.rect(backDrawX, backDrawY, actualBackWidth, actualBackHeight); // Back
        } else if (definition.id === "light_simple") {
          // Draw basic lamp shape (base, pole, shade)
          const lampBaseHeight = baseDrawHeight * 0.2;
          const lampPoleHeight = baseDrawHeight * 0.6;
          const lampShadeHeight = baseDrawHeight * 0.2;
          const lampWidth = baseDrawWidth * 0.5;
          const lampX = drawX + (baseDrawWidth - lampWidth) / 2;
          ctx.rect(
            lampX,
            drawY + lampPoleHeight + lampShadeHeight,
            lampWidth,
            lampBaseHeight
          ); // Base
          ctx.rect(
            lampX + lampWidth * 0.3,
            drawY + lampShadeHeight,
            lampWidth * 0.4,
            lampPoleHeight
          ); // Pole
          // Shade shape
          ctx.moveTo(lampX, drawY + lampShadeHeight);
          ctx.lineTo(lampX + lampWidth, drawY + lampShadeHeight);
          ctx.lineTo(lampX + lampWidth * 0.8, drawY);
          ctx.lineTo(lampX + lampWidth * 0.2, drawY);
          ctx.closePath();
          // Draw light cone if state is 'on'
          if (this.state === "on") {
            ctx.save();
            ctx.fillStyle = "rgba(255, 255, 180, 0.25)";
            ctx.beginPath();
            ctx.moveTo(lampX + lampWidth * 0.1, drawY + lampShadeHeight);
            ctx.lineTo(lampX + lampWidth * 0.9, drawY + lampShadeHeight);
            ctx.lineTo(
              lampX + lampWidth + 20 * zoom,
              drawY + baseDrawHeight + 30 * zoom
            );
            ctx.lineTo(lampX - 20 * zoom, drawY + baseDrawHeight + 30 * zoom);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        } else if (
          definition.id === "door_simple" ||
          definition.id === "door_to_lobby"
        ) {
          // Draw basic door shape (vertical rectangle)
          ctx.rect(
            drawX + baseDrawWidth * 0.1,
            drawY, // Use calculated top edge Y
            baseDrawWidth * 0.8,
            baseDrawHeight
          ); // Door frame
          // Draw darker panel inside
          ctx.fillStyle = shadeColor(baseFill, -20);
          ctx.fillRect(
            drawX + baseDrawWidth * 0.2,
            drawY + baseDrawHeight * 0.1,
            baseDrawWidth * 0.6,
            baseDrawHeight * 0.8
          );
        } else {
          // Default: Draw a simple box shape
          ctx.rect(drawX, drawY, baseDrawWidth, baseDrawHeight);
        }
      };
      // --- End Shape Path ---

      applyStyle(baseStyle);
      defineShapePath();
      ctx.fill();
      ctx.stroke();

      // Draw Selection Highlight if selected in edit mode
      if (this.isSelected && uiState.isEditMode) {
        const highlightStyle = {
          fill: "none",
          stroke: CLIENT_CONFIG.FURNI_SELECT_HIGHLIGHT_COLOR,
          lineWidth: Math.max(2, 3 * zoom),
          alpha: 0.8,
        };
        applyStyle(highlightStyle);
        defineShapePath(); // Redefine the path for the highlight stroke
        ctx.stroke();
      }

      // ===== START: Added Door Name Text Drawing ===== //
      if (this.isDoor && this.targetRoomId) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        ctx.font = `bold ${Math.max(7, 9 * zoom)}px Verdana`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const hintText = `-> ${this.targetRoomId}`;
        const textY = drawY - 5 * zoom; // Position above the furniture's drawn top edge
        ctx.fillText(hintText, screenPos.x, textY);
        // Reset text alignment/baseline if needed elsewhere
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
      // ====== END: Added Door Name Text Drawing ====== //

      ctx.restore(); // Corresponds to ctx.save() at the beginning
    }

    /** Helper to get grid coordinates occupied by this furniture. */
    getOccupiedTiles() {
      // Ensure config and definition are available
      if (!SHARED_CONFIG)
        return [{ x: Math.round(this.x), y: Math.round(this.y) }];
      const definition =
        this.definition ||
        SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (def) => def.id === this.definitionId
        );
      if (!definition)
        return [{ x: Math.round(this.x), y: Math.round(this.y) }];

      // Calculate tiles based on furniture center and dimensions
      const tiles = [];
      const startX = Math.round(this.x);
      const startY = Math.round(this.y);
      const width = definition.width || 1;
      const height = definition.height || 1;
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

  /** Represents an avatar (player or NPC) on the client. */
  class ClientAvatar extends ClientGameObject {
    constructor(dto) {
      super(dto);
      this.name = dto.name;
      this.state = dto.state;
      this.direction = dto.direction;
      this.sittingOnFurniId = dto.sittingOnFurniId;
      this.bodyColor = dto.bodyColor || "#6CA0DC";
      this.chatBubble = null; // Reference to the DOM element/data
      this.isPlayer = false; // Set by checkIfPlayer
      this.currentEmoteId = dto.emoteId || null;
      this.emoteEndTime = 0; // Client-side timer for visual emote ending
      this.isAdmin = dto.isAdmin || false;

      this.checkIfPlayer(); // Initial check
      this.update(dto); // Apply remaining properties
    }

    /** Sets the isPlayer flag based on gameState.myAvatarId */
    checkIfPlayer() {
      this.isPlayer =
        gameState.myAvatarId !== null && this.id === gameState.myAvatarId;
    }

    update(dto) {
      if (!SHARED_CONFIG || !CLIENT_CONFIG) return;
      this.checkIfPlayer(); // Re-check on updates

      if (dto.name != null) this.name = dto.name;

      // --- State and Emote Handling ---
      if (dto.state != null) {
        const oldState = this.state;
        const oldEmoteId = this.currentEmoteId;

        // Start new emote if state becomes EMOTING and emoteId is provided
        if (dto.state === SHARED_CONFIG.AVATAR_STATE_EMOTING && dto.emoteId) {
          // Only start if state changed OR emote ID changed
          if (
            oldState !== SHARED_CONFIG.AVATAR_STATE_EMOTING ||
            oldEmoteId !== dto.emoteId
          ) {
            this.currentEmoteId = dto.emoteId;
            const emoteDef =
              SHARED_CONFIG.EMOTE_DEFINITIONS[this.currentEmoteId];
            if (emoteDef) {
              this.emoteEndTime = Date.now() + emoteDef.duration;
              // Play sound for other players' emotes starting
              if (!this.isPlayer && emoteDef.sound) playSound(emoteDef.sound);
            } else {
              this.emoteEndTime = Date.now() + CLIENT_CONFIG.EMOTE_DURATION; // Fallback duration
              console.warn(
                `Emote definition missing for: ${this.currentEmoteId}`
              );
            }
            console.log(`${this.name} started emote: ${this.currentEmoteId}`);
          }
        } else if (
          oldState === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
          dto.state !== SHARED_CONFIG.AVATAR_STATE_EMOTING
        ) {
          // Stop existing emote if state changes away from EMOTING
          console.log(`${this.name} ended emote: ${this.currentEmoteId}`);
          this.emoteEndTime = 0;
          this.currentEmoteId = null;
        }
        this.state = dto.state;

        // Play walk sound for others starting to walk
        if (
          this.state === SHARED_CONFIG.AVATAR_STATE_WALKING &&
          oldState !== SHARED_CONFIG.AVATAR_STATE_WALKING &&
          !this.isPlayer
        ) {
          playSound("walk");
        }
      }
      // Handle emote change even if state remains EMOTING (e.g., /emote happy -> /emote wave)
      else if (
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        dto.emoteId &&
        this.currentEmoteId !== dto.emoteId
      ) {
        console.log(`${this.name} switched emote to: ${dto.emoteId}`);
        this.currentEmoteId = dto.emoteId;
        const emoteDef = SHARED_CONFIG.EMOTE_DEFINITIONS[this.currentEmoteId];
        if (emoteDef) {
          this.emoteEndTime = Date.now() + emoteDef.duration;
          if (!this.isPlayer && emoteDef.sound) playSound(emoteDef.sound);
        } else {
          this.emoteEndTime = Date.now() + CLIENT_CONFIG.EMOTE_DURATION;
        }
      }

      if (dto.direction != null) this.direction = dto.direction;
      if (dto.sittingOnFurniId !== undefined)
        this.sittingOnFurniId = dto.sittingOnFurniId;
      if (dto.bodyColor != null) this.bodyColor = dto.bodyColor;
      if (dto.isAdmin !== undefined) this.isAdmin = dto.isAdmin;

      super.update(dto); // Update base properties (x, y, z)
    }

    /** Interpolates position and handles client-side emote end prediction. */
    interpolate(deltaTimeFactor) {
      if (!SHARED_CONFIG) return;
      super.interpolate(deltaTimeFactor);

      // --- Client-side Emote End Prediction ---
      // If currently visually emoting, check if the server-defined duration has passed.
      if (
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        this.emoteEndTime > 0 &&
        Date.now() > this.emoteEndTime
      ) {
        // Predict next logical state based on context
        // Check if still logically sitting based on sittingOnFurniId
        const isSitting =
          this.sittingOnFurniId !== null &&
          gameState.furniture[this.sittingOnFurniId]; // Check furniture exists
        if (isSitting) {
          this.state = SHARED_CONFIG.AVATAR_STATE_SITTING;
        } else if (
          // Check if still moving towards a target (visual pos hasn't reached target state pos)
          Math.abs(this.x - this.visualX) > 0.1 ||
          Math.abs(this.y - this.visualY) > 0.1
        ) {
          this.state = SHARED_CONFIG.AVATAR_STATE_WALKING;
        } else {
          // Otherwise, predict idle state
          this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
        }
        // Clear emote details
        this.currentEmoteId = null;
        this.emoteEndTime = 0;
        // Note: The server will eventually send the authoritative state update.
        // This client-side prediction just makes the visual transition smoother.
      }
    }

    draw(ctx) {
      if (!this.isVisible || !SHARED_CONFIG || !CLIENT_CONFIG) return;
      const screenPos = getScreenPos(this.visualX, this.visualY);
      const zoom = camera.zoom;

      // Calculate avatar dimensions based on config and zoom
      const bodyWidth = SHARED_CONFIG.TILE_WIDTH_HALF * 0.8 * zoom;
      const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
      const headHeight = totalHeight * 0.3;
      const bodyHeight = totalHeight * 0.7;
      const headWidth = bodyWidth * 0.8;

      // Calculate drawing position considering Z offset
      const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
      const baseY =
        screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx; // Bottom Y coord
      const bodyY = baseY - bodyHeight;
      const headY = bodyY - headHeight; // Top Y coords
      const bodyX = screenPos.x - bodyWidth / 2;
      const headX = screenPos.x - headWidth / 2; // Center X coords

      // Determine visual state cues
      let isEmotingVisually =
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        this.currentEmoteId;
      let bodyOutline = shadeColor(this.bodyColor, -40);
      if (isEmotingVisually) bodyOutline = "#FFFF00"; // Yellow outline when emoting

      // Adjust body fill color based on state
      let bodyFill = this.bodyColor || CLIENT_CONFIG.AVATAR_SKIN_COLOR;
      if (this.state === SHARED_CONFIG.AVATAR_STATE_SITTING)
        bodyFill = shadeColor(this.bodyColor, -20);
      // Slightly darker when sitting
      else if (
        this.state === SHARED_CONFIG.AVATAR_STATE_WALKING ||
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING
      )
        bodyFill = shadeColor(this.bodyColor, 10); // Slightly lighter when active

      // Draw Body
      ctx.fillStyle = bodyFill;
      ctx.strokeStyle = bodyOutline;
      ctx.lineWidth = Math.max(1, 1.5 * zoom);
      ctx.fillRect(bodyX, bodyY, bodyWidth, bodyHeight);
      ctx.strokeRect(bodyX, bodyY, bodyWidth, bodyHeight);

      // Draw Head
      ctx.fillStyle = CLIENT_CONFIG.AVATAR_SKIN_COLOR;
      ctx.strokeStyle = shadeColor(CLIENT_CONFIG.AVATAR_SKIN_COLOR, -30);
      ctx.fillRect(headX, headY, headWidth, headHeight);
      ctx.strokeRect(headX, headY, headWidth, headHeight);

      // Draw Eyes (adjusted by direction)
      ctx.fillStyle = CLIENT_CONFIG.AVATAR_EYE_COLOR;
      const eyeSize = Math.max(1.5, 2 * zoom);
      const eyeY = headY + headHeight * 0.4 - eyeSize / 2;
      let eyeCenterX = headX + headWidth / 2;
      let eyeSpacingFactor = 0.25; // Default spacing for South/North
      if (
        this.direction === SHARED_CONFIG.DIRECTION_EAST ||
        this.direction === SHARED_CONFIG.DIRECTION_WEST
      )
        eyeSpacingFactor = 0.1; // Closer spacing for East/West

      // Shift eyes slightly based on facing quadrant
      if (
        this.direction >= SHARED_CONFIG.DIRECTION_SOUTH_EAST &&
        this.direction <= SHARED_CONFIG.DIRECTION_SOUTH_WEST
      )
        eyeCenterX = headX + headWidth * 0.6; // Shift right for South-facing
      else if (
        this.direction >= SHARED_CONFIG.DIRECTION_NORTH_WEST &&
        this.direction <= SHARED_CONFIG.DIRECTION_NORTH_EAST
      )
        eyeCenterX = headX + headWidth * 0.4; // Shift left for North-facing

      // Don't draw eyes if facing directly away (North)
      if (this.direction !== SHARED_CONFIG.DIRECTION_NORTH) {
        const eyeSpacing = headWidth * eyeSpacingFactor;
        ctx.fillRect(eyeCenterX - eyeSpacing, eyeY, eyeSize, eyeSize);
        ctx.fillRect(eyeCenterX + eyeSpacing - eyeSize, eyeY, eyeSize, eyeSize);
      }

      // Draw Name Tag
      ctx.font = `bold ${Math.max(8, 10 * zoom)}px Verdana`;
      ctx.textAlign = "center";
      ctx.lineWidth = Math.max(1, 2 * zoom);
      const nameY = headY - 5 * zoom; // Position above head
      // Determine name color based on admin/player status
      let nameColor = "white";
      if (this.isAdmin) nameColor = "cyan";
      if (this.isPlayer) nameColor = "yellow"; // Player's own name is yellow
      ctx.fillStyle = nameColor;
      ctx.strokeStyle = "black"; // Outline for readability
      ctx.strokeText(this.name, screenPos.x, nameY);
      ctx.fillText(this.name, screenPos.x, nameY);

      // Draw Emote Indicator Bubble
      if (isEmotingVisually) {
        ctx.fillStyle = "rgba(255, 255, 150, 0.85)"; // Semi-transparent yellow
        ctx.strokeStyle = "#555";
        ctx.lineWidth = 1;
        ctx.font = `italic bold ${Math.max(7, 9 * zoom)}px Verdana`;
        const emoteText = `* ${this.currentEmoteId} *`;
        const emoteY = nameY - 12 * zoom; // Position above name tag
        const textMetrics = ctx.measureText(emoteText);
        const textWidth = textMetrics.width;
        const bubblePadding = 4 * zoom;
        const bubbleWidth = textWidth + bubblePadding * 2;
        const bubbleHeight = 10 * zoom + bubblePadding;
        // Draw bubble background
        ctx.fillRect(
          screenPos.x - bubbleWidth / 2,
          emoteY - bubbleHeight + bubblePadding / 2,
          bubbleWidth,
          bubbleHeight
        );
        ctx.strokeRect(
          screenPos.x - bubbleWidth / 2,
          emoteY - bubbleHeight + bubblePadding / 2,
          bubbleWidth,
          bubbleHeight
        );
        // Draw emote text
        ctx.fillStyle = "#333";
        ctx.textAlign = "center";
        ctx.fillText(emoteText, screenPos.x, emoteY);
      }
    }

    /** Creates and manages the floating chat bubble UI element. */
    say(text) {
      if (!text || !text.trim() || !uiState.bubbleContainer) return;
      this.clearBubble(); // Remove previous bubble if any
      const bubbleId = `bubble-${this.id}-${uiState.nextBubbleId++}`;
      const endTime = Date.now() + CLIENT_CONFIG.CHAT_BUBBLE_DURATION;
      // Create bubble element
      const bubbleElement = document.createElement("div");
      bubbleElement.id = bubbleId;
      bubbleElement.className = "chat-bubble";
      bubbleElement.textContent = text;
      uiState.bubbleContainer.appendChild(bubbleElement);
      // Store bubble data and add to active list
      this.chatBubble = { id: bubbleId, text, endTime, element: bubbleElement };
      uiState.activeChatBubbles.push(this.chatBubble);
      this.updateChatBubblePosition(); // Set initial position
    }
    /** Updates the screen position of the chat bubble based on avatar position. */
    updateChatBubblePosition() {
      if (
        !this.chatBubble?.element ||
        !canvas ||
        !SHARED_CONFIG ||
        !CLIENT_CONFIG
      )
        return;
      // Calculate avatar's head top position on screen
      const screenPos = getScreenPos(this.visualX, this.visualY);
      const zoom = camera.zoom;
      const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
      const headHeight = totalHeight * 0.3;
      const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
      const baseY =
        screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx;
      const bodyY = baseY - totalHeight * 0.7;
      const headTopY = bodyY - headHeight;

      const bubbleElement = this.chatBubble.element;
      // Use rAF to avoid layout thrashing when reading offsetWidth/Height
      requestAnimationFrame(() => {
        if (!bubbleElement) return; // Check if bubble was cleared between request and execution
        const bubbleWidth = bubbleElement.offsetWidth;
        const bubbleHeight = bubbleElement.offsetHeight;
        // Position bubble centered above the head
        bubbleElement.style.left = `${screenPos.x}px`;
        const verticalOffsetAboveHead = 15 * zoom;
        bubbleElement.style.top = `${headTopY - verticalOffsetAboveHead}px`;
      });
    }
    /** Removes the current chat bubble UI element. */
    clearBubble() {
      if (this.chatBubble) {
        this.chatBubble.element?.remove(); // Safely remove DOM element
        // Remove from global active list
        uiState.activeChatBubbles = uiState.activeChatBubbles.filter(
          (b) => b.id !== this.chatBubble.id
        );
        this.chatBubble = null; // Clear reference on avatar
      }
    }
    /** Checks if a screen point is within the avatar's approximate bounds. */
    containsPoint(screenX, screenY) {
      if (!SHARED_CONFIG || !CLIENT_CONFIG) return false;
      // Calculate avatar's bounding box on screen
      const screenPos = getScreenPos(this.visualX, this.visualY);
      const zoom = camera.zoom;
      const bodyWidth = SHARED_CONFIG.TILE_WIDTH_HALF * 0.8 * zoom;
      const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
      const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
      const baseY =
        screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx;
      const topY = baseY - totalHeight;
      const leftX = screenPos.x - bodyWidth / 2;
      const rightX = screenPos.x + bodyWidth / 2;
      // Check if point is within bounds
      return (
        screenX >= leftX &&
        screenX <= rightX &&
        screenY >= topY &&
        screenY <= baseY
      );
    }
  }

  // --- Socket Event Handlers ---
  function setupSocketListeners() {
    if (!socket) {
      console.error("Socket not initialized before setting up listeners.");
      return;
    }

    socket.on("connect", () => {
      console.log("Connected to server with ID:", socket.id);
      if (uiState.debugDiv)
        uiState.debugDiv.textContent = "Connected. Waiting for room state...";
      logChatMessage("Connected to server!", true, "info-msg");
      // Game state is populated upon receiving 'room_state'
    });

    socket.on("disconnect", (reason) => {
      console.log("Disconnected from server. Reason:", reason);
      if (uiState.debugDiv)
        uiState.debugDiv.textContent = `Disconnected: ${reason}`;
      logChatMessage(`Disconnected: ${reason}`, true, "error-msg");
      // Reset local state entirely on disconnect
      resetLocalState();
      updateUserListPanel([]); // Clear user list UI
      hideProfilePanel();
      hideRecolorPanel();
      hideShopPanel();
      // Reset player ID
      gameState.myAvatarId = null;
    });

    socket.on("room_state", (state) => {
      // Ensure config is loaded and state is valid before processing
      if (!CLIENT_CONFIG || !state || state.id == null) {
        console.error("Received invalid room state:", state);
        return;
      }
      console.log(`Received room state for room: ${state.id}`);

      // --- Full Reset on Room Change/Join ---
      resetLocalState(); // Clear *all* previous room state

      // Apply new room state
      gameState.currentRoomId = state.id;
      gameState.roomLayout = state.layout || [];
      gameState.roomCols = state.cols || 0;
      gameState.roomRows = state.rows || 0;

      // Update UI with room name and browser title
      if (uiState.roomNameDisplay)
        uiState.roomNameDisplay.textContent = `Room: ${state.id}`;
      document.title = `ZanyTown - ${state.id}`;

      // Create client-side tile objects for the new layout
      gameState.clientTiles = [];
      for (let y = 0; y < gameState.roomRows; y++) {
        for (let x = 0; x < gameState.roomCols; x++) {
          const layoutType = gameState.roomLayout[y]?.[x] ?? 0; // Default to floor if undefined
          gameState.clientTiles.push(new ClientTile(x, y, layoutType));
        }
      }

      // Process furniture for the new room
      gameState.furniture = {}; // Clear old furniture map
      state.furniture?.forEach((dto) => {
        if (dto && dto.id != null) {
          gameState.furniture[dto.id] = new ClientFurniture(dto);
        } else {
          console.warn("Received invalid furniture DTO in room_state:", dto);
        }
      });

      // Process avatars for the new room
      gameState.avatars = {}; // Clear old avatar map
      state.avatars?.forEach((dto) => {
        if (dto && dto.id != null) {
          // Log if processing own avatar for debugging identification issues
          if (gameState.myAvatarId != null && dto.id === gameState.myAvatarId) {
            console.log(
              `[room_state] Processing MY AVATAR DTO (ID: ${dto.id})`
            );
          }
          gameState.avatars[dto.id] = new ClientAvatar(dto);
        } else {
          console.warn("Received invalid avatar DTO in room_state:", dto);
        }
      });

      // Center camera on the new room based on its dimensions
      if (canvas && gameState.roomCols > 0 && gameState.roomRows > 0) {
        const centerX = gameState.roomCols / 2;
        const centerY = gameState.roomRows / 2;
        const centerIso = worldToIso(centerX, centerY);
        // Adjust camera position to center the calculated iso point
        camera.x = canvas.width / 2 - centerIso.x * camera.zoom;
        camera.y = canvas.height / 3 - centerIso.y * camera.zoom; // Slightly offset Y for better view
      }

      logChatMessage(`Entered room: ${state.id}`, true, "info-msg");
      if (uiState.debugDiv)
        uiState.debugDiv.textContent = `Room '${state.id}' loaded.`;

      // Refresh UI elements that depend on global state but might be cleared/reset
      populateInventory(); // Refresh inventory display based on existing gameState.inventory
      updateCurrencyDisplay(); // Refresh currency display based on gameState.myCurrency
      updateShopButtonStates(); // Re-check shop button states
      // User list update is usually triggered separately by server after join.
    });

    socket.on("your_avatar_id", (id) => {
      console.log("Server assigned my avatar ID:", id);
      gameState.myAvatarId = id;
      // Update isPlayer flag for all currently loaded avatars
      Object.values(gameState.avatars).forEach((av) => av.checkIfPlayer());
      // Request user list for the current room now that we know who we are
      requestUserListUpdate();
    });

    // --- Room-Scoped Updates (Events relevant to the client's current room) ---
    socket.on("avatar_added", (avatarDTO) => {
      // Ignore if DTO is invalid or not for the current room
      if (
        !avatarDTO ||
        avatarDTO.id == null ||
        avatarDTO.roomId !== gameState.currentRoomId
      )
        return;

      if (!gameState.avatars[avatarDTO.id]) {
        gameState.avatars[avatarDTO.id] = new ClientAvatar(avatarDTO);
        console.log(
          `Avatar added to current room: ${avatarDTO.name} (ID: ${avatarDTO.id})`
        );
        gameState.avatars[avatarDTO.id].checkIfPlayer(); // Ensure isPlayer status is correct
        requestUserListUpdate(); // Update the user list panel
      } else {
        // Avatar already exists, update it (should be rare if server logic is robust)
        gameState.avatars[avatarDTO.id].update(avatarDTO);
        console.warn(
          `Received 'avatar_added' for existing ID ${avatarDTO.id} in current room. Updated.`
        );
      }
    });
    socket.on("avatar_removed", (data) => {
      if (!data || data.id == null) return;
      // Remove only if the avatar exists in the *current room's* gameState
      const removedAvatar = gameState.avatars[data.id];
      if (removedAvatar) {
        console.log(
          `Avatar removed from current room: ${removedAvatar.name} (${data.id})`
        );
        removedAvatar.clearBubble(); // Remove any chat bubble
        delete gameState.avatars[data.id]; // Remove from local state
        requestUserListUpdate(); // Update user list panel
        // If the removed avatar's profile was open, close it
        if (uiState.profilePanel?.dataset.targetId === data.id.toString()) {
          hideProfilePanel();
        }
      }
      // No warning if not found, it might be for a room we already left
    });
    socket.on("user_list_update", (users) => {
      // Server should only send the list for the room the client is currently in
      updateUserListPanel(users || []);
    });

    socket.on("chat_message", (data) => {
      if (!data || !data.text) return;
      // Find the sending avatar in the current room's state
      const avatar = data.avatarId ? gameState.avatars[data.avatarId] : null;
      const senderName = avatar ? avatar.name : data.avatarName || "Unknown";
      const messageText = `${senderName}: ${data.text}`;
      let messageClass = data.className || ""; // Use class provided by server (e.g., server-msg)
      const receivedIsAdmin = data.isAdmin || false; // Check admin flag from server

      // Show chat bubble if the avatar exists locally
      if (avatar) {
        avatar.say(data.text);
        // Play sound for messages from others or server
        if (avatar.id !== gameState.myAvatarId) playSound("chat");
      } else if (
        data.avatarName === "Server" ||
        data.avatarName === "Announcement"
      ) {
        playSound("chat"); // Play sound for server/announcement messages
      } else {
        playSound("chat"); // Play sound even if avatar not rendered locally
      }

      // Add specific styling class for admin messages in chat log
      if (receivedIsAdmin && avatar) {
        messageClass += " admin-msg";
      }

      // Log the message to the chat window
      logChatMessage(
        messageText,
        avatar?.id === gameState.myAvatarId,
        messageClass
      );
    });

    socket.on("furni_added", (furniDTO) => {
      // Add furniture if DTO is valid. Assume it's for the current room for now.
      // TODO: Server should ideally include roomId in DTO for robust cross-room handling.
      if (!furniDTO || furniDTO.id == null) return;

      let isNew = false;
      if (!gameState.furniture[furniDTO.id]) {
        gameState.furniture[furniDTO.id] = new ClientFurniture(furniDTO);
        isNew = true;
      } else {
        // Furniture already exists, update it (could happen with race conditions?)
        gameState.furniture[furniDTO.id].update(furniDTO);
        console.warn(
          `Received 'furni_added' for existing ID ${furniDTO.id} in current room. Updated.`
        );
      }
      if (isNew) {
        playSound("place"); // Play sound only for newly added furniture
      }
    });
    socket.on("furni_removed", (data) => {
      if (!data || data.id == null) return;
      // Remove only if present in the current room's state
      const removedId = data.id;
      const removedFurni = gameState.furniture[removedId];
      if (removedFurni) {
        console.log(
          `Furniture removed from current room: ${removedFurni.definition?.name} (ID: ${removedId})`
        );
        // Deselect or hide UI panels if the removed item was targeted
        if (uiState.editMode.selectedFurnitureId === removedId)
          setSelectedFurniture(null);
        if (uiState.activeRecolorFurniId === removedId) hideRecolorPanel();
        delete gameState.furniture[removedId];
      }
      // No warning if not found, might be from another room
    });

    // Action Failed Feedback
    socket.on("action_failed", (data) => {
      console.warn(`Action Failed: ${data.action}. Reason: ${data.reason}`);
      logChatMessage(
        `Action failed: ${data.reason || "Unknown"}`,
        true,
        "error-msg"
      );
    });
    // Connection Error Handling
    socket.on("connect_error", (err) => {
      console.error(`Connection Error: ${err.message}`);
      logChatMessage(`Connection Error: ${err.message}`, true, "error-msg");
      // If auth error, clear token and redirect to login
      if (
        err.message.includes("Invalid token") ||
        err.message.includes("Authentication error") ||
        err.message.includes("Token expired")
      ) {
        localStorage.removeItem("authToken");
        window.location.href = "/login.html";
      }
      if (uiState.debugDiv)
        uiState.debugDiv.textContent = `Conn Err: ${err.message}`;
      resetLocalState(); // Reset game state on connection error
    });
    // Specific Auth Errors during game operation
    socket.on("auth_error", (message) => {
      console.error("Authentication Error:", message);
      logChatMessage(message, true, "error-msg");
      localStorage.removeItem("authToken");
      window.location.href = "/login.html"; // Redirect on critical auth failure
    });
    // Forced Disconnect from Server
    socket.on("force_disconnect", (reason) => {
      console.warn("Forcefully disconnected:", reason);
      logChatMessage(`Disconnected: ${reason}`, true, "error-msg");
      localStorage.removeItem("authToken"); // Clear token
      socket.disconnect(); // Ensure socket is closed client-side
      alert(`Disconnected: ${reason}`); // Simple alert notification
      window.location.href = "/login.html"; // Redirect to login
    });

    // --- Incremental State Updates ---
    socket.on("avatar_update", (avatarDTO) => {
      if (!avatarDTO || avatarDTO.id == null) return;
      // Update only if avatar exists in the current room's state
      const avatar = gameState.avatars[avatarDTO.id];
      if (avatar) {
        avatar.update(avatarDTO);
        // If name changed, potentially refresh user list (optional, server might handle this)
        if (uiState.userListContent && avatarDTO.name) {
          const entry = uiState.userListContent.querySelector(
            `[data-userid="${avatarDTO.id}"]`
          );
          if (entry && entry.textContent !== avatarDTO.name) {
            requestUserListUpdate(); // Request a refresh if name changed
          }
        }
      }
      // Ignore updates for avatars not currently in the client's rendered room
    });
    socket.on("furni_updated", (updateData) => {
      if (!updateData || updateData.id == null) return;
      // Update only if furniture exists in the current room's state
      const furni = gameState.furniture[updateData.id];
      if (furni) {
        const oldState = furni.state;
        furni.update(updateData);
        // Play sound if state changed for a usable item
        if (
          updateData.state != null &&
          oldState !== updateData.state &&
          furni.definition?.canUse
        ) {
          playSound("use");
        }
      }
      // Ignore updates for furniture not in the current room
    });

    // --- Global State Updates (Inventory, Currency, Profile) ---
    socket.on("inventory_update", (inventoryData) => {
      console.log("Received inventory update:", inventoryData);
      gameState.inventory = inventoryData || {};
      populateInventory(); // Update inventory UI
      updateShopButtonStates(); // Update buy button states based on new inventory (though currency is main driver)
    });
    socket.on("currency_update", (data) => {
      if (data && typeof data.currency === "number") {
        console.log("Received currency update:", data.currency);
        gameState.myCurrency = data.currency;
        updateCurrencyDisplay(); // Update currency UI
        updateShopButtonStates(); // Update buy button states based on new currency
      }
    });
    socket.on("show_profile", (profileData) => {
      // Profile data is global, display it regardless of current room
      if (!profileData || !profileData.id) return;
      showProfilePanel(profileData);
    });
  }

  // --- Game Loop ---
  function gameLoop(timestamp) {
    // Don't run the loop until client config is loaded
    if (!CLIENT_CONFIG) {
      requestAnimationFrame(gameLoop);
      return;
    }

    const deltaTimeMs = timestamp - lastTimestamp;
    lastTimestamp = timestamp;
    // Cap delta time to prevent large jumps if frame rate drops significantly
    const cappedDeltaTimeMs = Math.min(deltaTimeMs, 100); // Max step of 100ms (10 FPS equivalent)
    // Calculate interpolation factor based on capped delta time and target rate (e.g., 60 FPS)
    const interpolationFactor =
      1.0 -
      Math.pow(
        1.0 - CLIENT_CONFIG.INTERPOLATION_FACTOR,
        cappedDeltaTimeMs / (1000 / 60)
      );

    // --- Update Phase ---
    handleHeldKeys(); // Process continuous camera panning from arrow keys
    updateMouseWorldPosition(); // Update mouse coordinates in world/grid space
    updateHighlights(); // Update tile/furniture highlights based on context
    // Interpolate visual positions for objects in the current room
    Object.values(gameState.avatars).forEach((a) =>
      a.interpolate(interpolationFactor)
    );
    Object.values(gameState.furniture).forEach((f) =>
      f.interpolate(interpolationFactor)
    );
    updateChatBubbles(Date.now()); // Update active chat bubble positions and expiry

    // --- Draw Phase ---
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#003366"; // Base background color if tiles don't cover everything
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Collect all drawable objects *for the current room* and sort by draw order
      const drawables = [
        ...gameState.clientTiles, // Tiles are drawn first
        ...Object.values(gameState.furniture),
        ...Object.values(gameState.avatars),
      ];
      drawables.sort((a, b) => a.drawOrder - b.drawOrder);

      // Draw all objects in sorted order
      drawables.forEach((obj) => obj.draw(ctx));

      drawPlacementGhost(ctx); // Draw placement ghost overlay if applicable
    }

    // --- UI Updates ---
    updateDebugInfo(); // Refresh debug panel text
    updateUICursor(); // Update main game cursor based on mode/drag state

    requestAnimationFrame(gameLoop); // Schedule the next frame
  }

  // --- Input Handling ---
  function setupInputListeners() {
    if (!canvas || !CLIENT_CONFIG) {
      console.error("Canvas or CLIENT_CONFIG not ready for input listeners.");
      return;
    }
    // Keyboard Listeners
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    // Mouse Listeners on Canvas
    canvas.addEventListener("click", handleCanvasClick);
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("wheel", handleMouseWheel, { passive: false }); // Need active for preventDefault
    canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // Disable right-click menu

    // UI Button Listeners
    document
      .getElementById(CLIENT_CONFIG.ZOOM_IN_BTN_ID)
      ?.addEventListener("click", () => changeZoom(CLIENT_CONFIG.ZOOM_FACTOR));
    document
      .getElementById(CLIENT_CONFIG.ZOOM_OUT_BTN_ID)
      ?.addEventListener("click", () =>
        changeZoom(1 / CLIENT_CONFIG.ZOOM_FACTOR)
      );
    document
      .getElementById(CLIENT_CONFIG.TOGGLE_EDIT_BTN_ID)
      ?.addEventListener("click", toggleEditMode);
    uiState.pickupFurniBtn?.addEventListener("click", handlePickupFurniClick);
    uiState.recolorBtn?.addEventListener("click", handleRecolorFurniClick);
    uiState.profileCloseBtn?.addEventListener("click", hideProfilePanel);
    uiState.recolorCloseBtn?.addEventListener("click", hideRecolorPanel);
    uiState.recolorResetBtn?.addEventListener("click", () => {
      if (uiState.activeRecolorFurniId) {
        console.log(
          `Requesting reset color for ${uiState.activeRecolorFurniId}`
        );
        socket?.emit("request_recolor_furni", {
          furniId: uiState.activeRecolorFurniId,
          colorHex: "", // Empty string signals reset to default
        });
        hideRecolorPanel();
      }
    });
    uiState.openShopBtn?.addEventListener("click", showShopPanel);
    uiState.shopCloseBtn?.addEventListener("click", hideShopPanel);
    document.getElementById("logout-btn")?.addEventListener("click", () => {
      localStorage.removeItem("authToken");
      socket?.disconnect();
      window.location.href = "/login.html";
    });

    // Chat Input Listener
    uiState.chatInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault(); // Prevent default newline/submission
        const text = uiState.chatInput.value.trim();
        if (text && socket?.connected) {
          socket.emit("send_chat", text); // Send chat/command to server
          uiState.chatInput.value = ""; // Clear input field
        }
      }
    });
  }

  function handleKeyDown(event) {
    if (!CLIENT_CONFIG) return;
    // Ignore most keyboard input if chat input is focused
    if (document.activeElement === uiState.chatInput && event.key !== "Enter")
      return;

    inputState.keysPressed[event.key] = true;
    const keyLower = event.key.toLowerCase();

    // --- Hotkeys (only when chat is not focused) ---
    if (document.activeElement !== uiState.chatInput) {
      // Toggle Edit Mode
      if (keyLower === "e") {
        event.preventDefault();
        toggleEditMode();
      }
      // Prevent arrow keys scrolling the page when panning camera
      if (
        ["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(keyLower)
      ) {
        event.preventDefault();
      }

      // Edit Mode specific hotkeys
      if (uiState.isEditMode) {
        // Pickup selected furniture with Delete/Backspace
        if (
          (keyLower === "delete" || keyLower === "backspace") &&
          uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI
        ) {
          event.preventDefault();
          handlePickupFurniClick(); // Trigger pickup action
        }
        // Rotate placement ghost or selected furniture with R key
        if (keyLower === "r") {
          event.preventDefault();
          if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
            // Rotate placement ghost client-side
            uiState.editMode.placementRotation = rotateDirection(
              uiState.editMode.placementRotation,
              2 // 90 degrees clockwise
            );
          } else if (
            uiState.editMode.state ===
              CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
            uiState.editMode.selectedFurnitureId
          ) {
            // Request server to rotate the selected furniture
            socket?.emit("request_rotate_furni", {
              furniId: uiState.editMode.selectedFurnitureId,
            });
          }
        }
      }
    }
  }
  function handleKeyUp(event) {
    inputState.keysPressed[event.key] = false;
  }
  /** Processes held arrow keys for continuous camera panning. */
  function handleHeldKeys() {
    if (!CLIENT_CONFIG) return;
    let dx = 0;
    let dy = 0;
    const panSpeed = CLIENT_CONFIG.CAMERA_PAN_SPEED;
    if (inputState.keysPressed["ArrowLeft"]) dx += panSpeed;
    if (inputState.keysPressed["ArrowRight"]) dx -= panSpeed;
    if (inputState.keysPressed["ArrowUp"]) dy += panSpeed;
    if (inputState.keysPressed["ArrowDown"]) dy -= panSpeed;
    if (dx !== 0 || dy !== 0) {
      moveCamera(dx, dy);
    }
  }

  function handleCanvasClick(event) {
    // Ignore clicks not directly on the canvas or if not in a room yet
    if (!CLIENT_CONFIG || event.target !== canvas || !gameState.currentRoomId)
      return;

    // Distinguish between a quick click and the end of a drag motion
    const dragThreshold = 5; // Pixels threshold to differentiate click from drag
    const dx = Math.abs(event.clientX - inputState.lastMousePos.x);
    const dy = Math.abs(event.clientY - inputState.lastMousePos.y);
    if (inputState.isDragging && (dx > dragThreshold || dy > dragThreshold)) {
      // If dragging flag is set and mouse moved significantly, ignore as drag release
      return;
    }

    const gridPos = inputState.currentMouseGridPos;
    const screenPos = inputState.currentMouseScreenPos;

    // Ignore clicks outside the valid tile area of the current room
    if (!isValidClientTile(gridPos.x, gridPos.y)) return;

    // Delegate click handling based on current mode (Edit vs Navigate)
    if (uiState.isEditMode) {
      handleEditModeClick(gridPos, screenPos);
    } else {
      handleNavigateModeClick(gridPos, screenPos);
    }
  }

  /** Handles clicks when in Edit Mode (Place/Select/Use furniture). */
  function handleEditModeClick(gridPos, screenPos) {
    if (!CLIENT_CONFIG || !SHARED_CONFIG || !gameState.currentRoomId) return;

    switch (uiState.editMode.state) {
      case CLIENT_CONFIG.EDIT_STATE_PLACING: // Attempting to place item from inventory
        if (
          uiState.editMode.placementValid && // Client-side validity check passed
          uiState.editMode.selectedInventoryItemId
        ) {
          // Client-side check if item still exists in inventory (server validates again)
          if (
            gameState.inventory[uiState.editMode.selectedInventoryItemId] > 0
          ) {
            // Send placement request to server
            socket?.emit("request_place_furni", {
              definitionId: uiState.editMode.selectedInventoryItemId,
              x: gridPos.x,
              y: gridPos.y,
              rotation: uiState.editMode.placementRotation,
            });
          } else {
            // Item disappeared from inventory somehow? Resync.
            logChatMessage(
              "You don't seem to have that item anymore.",
              true,
              "error-msg"
            );
            setSelectedInventoryItem(null); // Deselect item
          }
        } else {
          logChatMessage("Cannot place item there.", true, "error-msg");
        }
        break;

      case CLIENT_CONFIG.EDIT_STATE_NAVIGATE: // No item selected, clicking selects/uses furniture
      case CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI: // Furniture already selected
        // Find furniture at the click location in the current room
        const clickedFurniture = getTopmostFurnitureAtScreen(
          screenPos.x,
          screenPos.y
        );

        if (clickedFurniture) {
          // If the clicked item is usable (like a lamp), use it immediately
          if (clickedFurniture.definition?.canUse) {
            socket?.emit("request_use_furni", { furniId: clickedFurniture.id });
            playSound("use");
            setSelectedFurniture(null); // Deselect after using
          } else {
            // Otherwise, toggle selection of the clicked furniture
            if (uiState.editMode.selectedFurnitureId === clickedFurniture.id) {
              setSelectedFurniture(null); // Click again to deselect
            } else {
              setSelectedFurniture(clickedFurniture.id); // Select the clicked furniture
            }
          }
        } else {
          // Clicked on empty space
          setSelectedFurniture(null); // Deselect any currently selected furniture
          hideRecolorPanel(); // Hide recolor panel if empty space is clicked
        }
        break;
    }
  }

  /** Handles clicks when NOT in Edit Mode (Navigate/Sit/Use/Profile/Door). */
  function handleNavigateModeClick(gridPos, screenPos) {
    if (!socket?.connected || !SHARED_CONFIG || !gameState.currentRoomId)
      return;
    const myAvatar = gameState.avatars[gameState.myAvatarId]; // Get own avatar instance

    // 1. Check for click on another Avatar -> Request Profile
    const clickedAvatar = getAvatarAtScreen(screenPos.x, screenPos.y);
    if (clickedAvatar) {
      if (clickedAvatar.id !== gameState.myAvatarId) {
        socket.emit("request_profile", { avatarId: clickedAvatar.id }); // Request other player's profile
      } else {
        logChatMessage(
          `You clicked yourself (${clickedAvatar.name}).`,
          true,
          "info-msg"
        );
      }
      return; // Stop processing if an avatar was clicked
    }

    // 2. Check for click on own tile while sitting -> Request Stand
    if (myAvatar?.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
      const playerGridPos = snapToGrid(myAvatar.x, myAvatar.y);
      if (gridPos.x === playerGridPos.x && gridPos.y === playerGridPos.y) {
        socket.emit("request_stand"); // Request to stand up
        return;
      }
    }

    // 3. Check for click on Furniture -> Use / Sit / Enter Door
    const clickedFurniture = getTopmostFurnitureAtScreen(
      screenPos.x,
      screenPos.y
    );
    if (clickedFurniture) {
      // --- Handle Door Click ---
      if (clickedFurniture.isDoor && clickedFurniture.targetRoomId) {
        // Prepare data for room change request
        const doorData = { targetRoomId: clickedFurniture.targetRoomId };
        // Include target coords if defined in config (server uses these for spawn)
        const doorDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (d) => d.id === clickedFurniture.definitionId
        );
        if (doorDef?.targetX != null && doorDef?.targetY != null) {
          doorData.targetX = doorDef.targetX;
          doorData.targetY = doorDef.targetY;
        }
        socket.emit("request_change_room", doorData); // Send request to server
        return; // Stop processing if it was a door click
      }

      // --- Handle Usable Item Click ---
      if (clickedFurniture.definition?.canUse) {
        socket.emit("request_use_furni", { furniId: clickedFurniture.id });
        playSound("use");
        return;
      }

      // --- Handle Sittable Item Click ---
      if (clickedFurniture.definition?.canSit) {
        socket.emit("request_sit", { furniId: clickedFurniture.id });
        return;
      }
    }

    // 4. Clicked on floor tile -> Navigate (if walkable)
    if (isClientWalkable(gridPos.x, gridPos.y)) {
      socket.emit("request_move", { x: gridPos.x, y: gridPos.y });
    } else {
      // Clicked unwalkable tile (wall, hole, occupied solid)
      logChatMessage("Cannot walk there.", true, "error-msg");
    }
  }

  function handleMouseDown(event) {
    // Middle mouse (button 1) or Right mouse (button 2) starts camera drag
    if (event.button === 1 || event.button === 2) {
      inputState.isDragging = true;
      inputState.lastMousePos = { x: event.clientX, y: event.clientY }; // Record start position
      gameContainer?.classList.add("dragging"); // Apply dragging cursor style
      event.preventDefault(); // Prevent default middle/right click actions (scroll/menu)
    } else if (event.button === 0) {
      // Left mouse down - record position for click vs drag detection
      inputState.lastMousePos = { x: event.clientX, y: event.clientY };
      inputState.isDragging = false; // Assume click until mouse moves significantly
    }
  }
  function handleMouseUp(event) {
    // Stop dragging on any mouse button release
    if (inputState.isDragging) {
      inputState.isDragging = false;
      gameContainer?.classList.remove("dragging"); // Remove dragging cursor style
    }
  }
  function handleMouseLeave(event) {
    // Stop dragging if mouse leaves the canvas area
    if (inputState.isDragging) {
      inputState.isDragging = false;
      gameContainer?.classList.remove("dragging");
    }
  }

  function handleMouseMove(event) {
    if (!canvas) return;
    // Calculate mouse position relative to the canvas
    const rect = canvas.getBoundingClientRect();
    inputState.currentMouseScreenPos = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };

    // If dragging, pan the camera
    if (inputState.isDragging) {
      const dx = event.clientX - inputState.lastMousePos.x;
      const dy = event.clientY - inputState.lastMousePos.y;
      moveCamera(dx, dy);
      inputState.lastMousePos = { x: event.clientX, y: event.clientY }; // Update last position for next delta
    }

    updateMouseWorldPosition(); // Update world/grid position continuously for highlighting etc.
  }
  /** Updates cached world and grid coordinates based on current screen mouse position and camera state. */
  function updateMouseWorldPosition() {
    inputState.currentMouseWorldPos = isoToWorld(
      inputState.currentMouseScreenPos.x,
      inputState.currentMouseScreenPos.y
    );
    inputState.currentMouseGridPos = snapToGrid(
      inputState.currentMouseWorldPos.x,
      inputState.currentMouseWorldPos.y
    );
  }

  function handleMouseWheel(event) {
    if (!canvas || !CLIENT_CONFIG) return;
    event.preventDefault(); // Prevent default page scrolling behavior

    // Determine zoom direction and calculate factor
    const zoomFactor =
      event.deltaY < 0
        ? CLIENT_CONFIG.ZOOM_FACTOR // Zoom in (scroll up)
        : 1 / CLIENT_CONFIG.ZOOM_FACTOR; // Zoom out (scroll down)

    // Calculate pivot point for zooming (mouse cursor position relative to canvas)
    const rect = canvas.getBoundingClientRect();
    const pivotX = event.clientX - rect.left;
    const pivotY = event.clientY - rect.top;

    changeZoom(zoomFactor, pivotX, pivotY); // Apply zoom centered on pivot
  }
  /** Handles click on the "Pick Up" button in inventory/edit panel. */
  function handlePickupFurniClick() {
    if (!CLIENT_CONFIG || !gameState.currentRoomId) return;
    // Only allow pickup if in edit mode, furniture selected state, and an item is selected
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId
    ) {
      // Send pickup request to server
      socket?.emit("request_pickup_furni", {
        furniId: uiState.editMode.selectedFurnitureId,
      });
    } else {
      console.warn("Pickup button clicked but conditions not met.");
    }
  }
  /** Handles click on the "Recolor" button (shows the recolor panel). */
  function handleRecolorFurniClick() {
    if (!CLIENT_CONFIG || !gameState.currentRoomId) return;
    // Only allow if in edit mode, furniture selected state, and an item is selected
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId
    ) {
      const furni = gameState.furniture[uiState.editMode.selectedFurnitureId];
      // Check if the selected furniture exists and is recolorable
      if (furni && furni.canRecolor) {
        showRecolorPanel(furni.id); // Open the panel for this item
      } else {
        console.warn(
          "Recolor button clicked, but selected furniture cannot be recolored or not found."
        );
        hideRecolorPanel(); // Ensure panel is hidden if not applicable
      }
    } else {
      console.warn("Recolor button clicked, but conditions not met.");
      hideRecolorPanel();
    }
  }

  // --- Client-side Checks / Interaction Helpers (Operate on current room state) ---

  /** Checks if grid coordinates are within the current room's bounds. */
  function isValidClientTile(x, y) {
    return (
      gameState.currentRoomId != null && // Must be in a room
      x >= 0 &&
      x < gameState.roomCols &&
      y >= 0 &&
      y < gameState.roomRows
    );
  }
  /** Gets the layout type (0=floor, 1=wall, 2=alt, 'X'=hole) of a tile in the current room. */
  function getTileLayoutType(x, y) {
    return isValidClientTile(x, y) ? gameState.roomLayout[y]?.[x] : null;
  }
  /** Checks if a tile is walkable in the current room (valid floor type and not blocked by solid furniture). */
  function isClientWalkable(x, y) {
    const gx = Math.round(x);
    const gy = Math.round(y);
    if (!isValidClientTile(gx, gy)) return false;
    const layoutType = getTileLayoutType(gx, gy);
    // Walls and holes are never walkable
    if (layoutType === 1 || layoutType === "X") return false;
    // Floor/Alt floor is walkable only if not occupied by solid furniture
    return !isClientOccupiedBySolid(gx, gy);
  }
  /** Checks if a tile is occupied by solid (non-walkable, non-flat) furniture in the current room's state. */
  function isClientOccupiedBySolid(gridX, gridY) {
    // Iterate through furniture currently in the room
    return Object.values(gameState.furniture).some((f) => {
      // Check if furniture has a definition and is solid (not walkable, not flat)
      const isSolid =
        f.definition && !f.definition.isWalkable && !f.definition.isFlat;
      if (!isSolid) return false;
      // Check if any tile occupied by this solid furniture matches the target grid coordinates
      return f.getOccupiedTiles().some((t) => t.x === gridX && t.y === gridY);
    });
  }
  /** Finds the topmost avatar at a given screen coordinate in the current room. */
  function getAvatarAtScreen(screenX, screenY) {
    // Filter avatars in the current room that contain the screen point
    const candidates = Object.values(gameState.avatars).filter((a) =>
      a.containsPoint(screenX, screenY)
    );
    if (candidates.length === 0) return null;
    // Sort by draw order (descending) to find the one drawn on top
    candidates.sort((a, b) => b.drawOrder - a.drawOrder);
    return candidates[0];
  }
  /** Finds the topmost furniture at a given screen coordinate in the current room (uses approximate check). */
  function getTopmostFurnitureAtScreen(screenX, screenY) {
    if (!SHARED_CONFIG) return null;
    // Filter furniture in the current room based on approximate screen distance
    const candidates = Object.values(gameState.furniture).filter((f) => {
      if (!f.definition) return false;
      const screenPos = getScreenPos(f.visualX, f.visualY);
      // Calculate an approximate radius based on tile size, furniture dimensions, and zoom
      const approxRadius =
        (SHARED_CONFIG.TILE_WIDTH_HALF * (f.definition.width || 1) +
          SHARED_CONFIG.TILE_HEIGHT_HALF * (f.definition.height || 1)) *
        camera.zoom *
        0.6; // 0.6 is a fudge factor
      const dx = screenPos.x - screenX;
      const dy = screenPos.y - screenY;
      // Check if click is within the approximate radius
      return dx * dx + dy * dy < approxRadius * approxRadius;
    });
    if (candidates.length === 0) return null;
    // Sort by draw order (descending) to get the topmost one
    candidates.sort((a, b) => b.drawOrder - a.drawOrder);
    return candidates[0];
  }

  // --- UI Update Functions ---

  /** Updates the debug information display panel. */
  function updateDebugInfo() {
    if (!uiState.debugDiv || !SHARED_CONFIG || !CLIENT_CONFIG) return;
    const player = gameState.avatars[gameState.myAvatarId]; // Get own avatar from current room state
    const pGrid = player
      ? snapToGrid(player.visualX, player.visualY)
      : { x: "?", y: "?" };
    const pState = player ? player.state : "N/A";
    const pDir = player ? player.direction : "?";
    const mGrid = inputState.currentMouseGridPos;
    const furniCount = Object.keys(gameState.furniture).length; // Furniture count in current room
    const avatarCount = Object.keys(gameState.avatars).length; // Avatar count in current room
    const inventoryCount = Object.keys(gameState.inventory).reduce(
      (sum, key) => sum + (gameState.inventory[key] || 0),
      0 // Sum of quantities
    );
    const currentRoom = gameState.currentRoomId || "N/A";

    // Construct Edit Mode details string
    let editDetails = " Off";
    if (uiState.isEditMode) {
      editDetails = ` St: ${uiState.editMode.state}`;
      if (
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
        uiState.editMode.selectedInventoryItemId
      ) {
        const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (d) => d.id === uiState.editMode.selectedInventoryItemId
        );
        editDetails += ` Item: ${def?.name || "?"} Rot:${
          uiState.editMode.placementRotation
        } Place:${uiState.editMode.placementValid ? "OK" : "No"}`;
      } else if (
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        uiState.editMode.selectedFurnitureId
      ) {
        const f = gameState.furniture[uiState.editMode.selectedFurnitureId];
        editDetails += ` Sel: ${f?.definition?.name || "?"} (ID:${
          uiState.editMode.selectedFurnitureId
        }) Rot:${f?.rotation ?? "?"}`;
      }
    }

    // Construct Tile Info string for the tile under the mouse
    let tileInfo = "";
    if (
      gameState.highlightedTile &&
      isValidClientTile(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y
      )
    ) {
      const hx = gameState.highlightedTile.x;
      const hy = gameState.highlightedTile.y;
      const tLayout = getTileLayoutType(hx, hy);
      const stack = Object.values(gameState.furniture).filter(
        (f) => Math.round(f.visualX) === hx && Math.round(f.visualY) === hy
      );
      stack.sort((a, b) => b.visualZ - a.visualZ);
      const topFurni = stack[0];
      const stackHeight = getClientStackHeightAt(hx, hy); // Calculates based on client-side furniture state
      tileInfo = ` Tile(${hx},${hy}) L:${tLayout ?? "?"} ${
        topFurni
          ? `Top:${topFurni.definition?.name}(Z:${topFurni.visualZ.toFixed(
              2
            )}) `
          : ""
      }StackZ:${stackHeight.toFixed(2)}`;
    }

    // Update the debug panel's innerHTML
    uiState.debugDiv.innerHTML = `Room: ${currentRoom} | Player: (${pGrid.x},${
      pGrid.y
    }) St: ${pState} Dir:${pDir}<br>Mouse: (${mGrid.x},${
      mGrid.y
    })${tileInfo}<br>Camera: (${Math.round(camera.x)}, ${Math.round(
      camera.y
    )}) | Zoom: ${camera.zoom.toFixed(
      2
    )}<br>Edit Mode: ${editDetails}<br>Inv Items: ${inventoryCount} | Gold: ${
      gameState.myCurrency
    }<br>Objs: ${furniCount}|Users: ${avatarCount}|Bub: ${
      uiState.activeChatBubbles.length
    }|Sock: ${socket?.connected ? "OK" : "DOWN"}`;
  }
  /** Adds a message to the chat log UI, handling scrolling and limits. */
  function logChatMessage(message, isSelf = false, className = "") {
    if (!uiState.chatLogDiv || !CLIENT_CONFIG) return;
    const p = document.createElement("p");
    p.textContent = message;
    if (isSelf) p.classList.add("self-msg");
    if (className) {
      // Apply multiple classes if className contains spaces
      className.split(" ").forEach((cls) => {
        if (cls) p.classList.add(cls);
      });
    }

    // Check if the chat log is scrolled to the bottom before adding the new message
    const isScrolledBottom =
      uiState.chatLogDiv.scrollHeight - uiState.chatLogDiv.clientHeight <=
      uiState.chatLogDiv.scrollTop + 1; // +1 for tolerance

    // Add the new message and manage log length
    uiState.chatMessages.push(p);
    if (uiState.chatMessages.length > CLIENT_CONFIG.MAX_CHAT_LOG_MESSAGES) {
      uiState.chatMessages.shift().remove(); // Remove the oldest message element
    }
    uiState.chatLogDiv.appendChild(p);

    // Auto-scroll to the bottom only if it was already scrolled to the bottom
    if (isScrolledBottom) {
      uiState.chatLogDiv.scrollTop = uiState.chatLogDiv.scrollHeight;
    }
  }
  /** Removes expired chat bubbles and updates positions of active ones. */
  function updateChatBubbles(currentTime) {
    if (!SHARED_CONFIG || !CLIENT_CONFIG) return;
    // Filter out expired bubbles
    uiState.activeChatBubbles = uiState.activeChatBubbles.filter((bubble) => {
      if (currentTime > bubble.endTime) {
        bubble.element?.remove(); // Remove DOM element
        // Clear the reference on the owner avatar (if found in current room)
        const owner = Object.values(gameState.avatars).find(
          (a) => a.chatBubble?.id === bubble.id
        );
        if (owner) owner.chatBubble = null;
        return false; // Remove from active list
      }
      return true; // Keep in active list
    });
    // Update position for remaining active bubbles associated with avatars in the current room
    uiState.activeChatBubbles.forEach((bubble) => {
      const owner = Object.values(gameState.avatars).find(
        (a) => a.chatBubble?.id === bubble.id
      );
      owner?.updateChatBubblePosition(); // Update position if owner exists locally
    });
  }
  /** Clears and redraws the inventory UI based on gameState.inventory. */
  function populateInventory() {
    if (!uiState.inventoryItemsDiv || !SHARED_CONFIG || !CLIENT_CONFIG) return;
    uiState.inventoryItemsDiv.innerHTML = ""; // Clear previous items

    const inventory = gameState.inventory;
    const ownedItemIds = Object.keys(inventory);

    if (ownedItemIds.length === 0) {
      uiState.inventoryItemsDiv.innerHTML = "<p><i>Inventory empty.</i></p>";
      // If currently in placing mode, exit it as inventory is empty
      if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING)
        setSelectedInventoryItem(null);
      return;
    }

    // Sort items alphabetically by ID for consistent order
    ownedItemIds.sort();
    ownedItemIds.forEach((itemId) => {
      const quantity = inventory[itemId];
      if (quantity <= 0) return; // Skip items with zero quantity

      const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === itemId
      );
      if (!def) {
        console.warn(`Inventory item ${itemId} has no definition.`);
        return; // Skip items without definitions
      }

      // Create inventory item element
      const itemDiv = document.createElement("div");
      itemDiv.className = "inventory-item";
      itemDiv.dataset.itemId = def.id; // Store item ID for click handler

      // Add preview color swatch
      const previewSpan = document.createElement("span");
      previewSpan.className = "item-preview";
      previewSpan.style.backgroundColor = def.color || "#8B4513";
      itemDiv.appendChild(previewSpan);

      // Add item name and quantity
      itemDiv.appendChild(
        document.createTextNode(` ${def.name} (x${quantity})`)
      );

      // Add tooltip with item details
      itemDiv.title = `${def.name} (${def.width}x${def.height})${
        def.canSit ? " (Sittable)" : ""
      }${def.stackable ? " (Stackable)" : ""}${def.canUse ? " (Usable)" : ""}${
        def.canRecolor ? " (Recolorable)" : ""
      }`;

      // Add click listener to select item for placement
      itemDiv.addEventListener("click", () => {
        if (uiState.isEditMode) {
          // Toggle selection if already selected
          if (uiState.editMode.selectedInventoryItemId === def.id) {
            setSelectedInventoryItem(null);
          } else {
            setSelectedInventoryItem(def.id);
          }
        } else {
          // Nudge user to enable edit mode if they click inventory outside of it
          logChatMessage(
            "Enable Edit Mode (E key) to place furniture.",
            true,
            "info-msg"
          );
          // Visual feedback on the edit button
          const editBtn = document.getElementById(
            CLIENT_CONFIG.TOGGLE_EDIT_BTN_ID
          );
          if (editBtn) {
            editBtn.style.transform = "scale(1.1)";
            editBtn.style.transition = "transform 0.1s ease-out";
            setTimeout(() => {
              editBtn.style.transform = "scale(1)";
            }, 150);
          }
        }
      });

      uiState.inventoryItemsDiv.appendChild(itemDiv);
    });

    updateInventorySelection(); // Ensure correct item has 'selected' class applied
  }
  /** Updates the visual selection state (CSS class) of inventory items. */
  function updateInventorySelection() {
    if (!uiState.inventoryItemsDiv || !CLIENT_CONFIG) return;
    // Iterate through all items in the inventory UI
    uiState.inventoryItemsDiv
      .querySelectorAll(".inventory-item")
      .forEach((item) => {
        // Toggle 'selected' class based on current edit mode state and selected item ID
        item.classList.toggle(
          "selected",
          uiState.isEditMode && // Must be in edit mode
            item.dataset.itemId === uiState.editMode.selectedInventoryItemId // Item ID must match selection
        );
      });
  }
  /** Enables/disables the "Pick Up" button based on edit mode state and furniture selection. */
  function updatePickupButtonState() {
    if (uiState.pickupFurniBtn && CLIENT_CONFIG) {
      // Enable button only if in edit mode, selected furniture state, and an item is selected
      uiState.pickupFurniBtn.disabled = !(
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        uiState.editMode.selectedFurnitureId
      );
    }
  }
  /** Updates the main game container cursor based on dragging or edit mode state. */
  function updateUICursor() {
    if (!gameContainer) return;
    // Reset cursor styles first
    gameContainer.classList.remove("dragging", "edit-mode-cursor");
    gameContainer.style.cursor = "";
    // Apply specific cursor based on state
    if (inputState.isDragging) {
      gameContainer.classList.add("dragging"); // Grabbing hand cursor
    } else if (uiState.isEditMode) {
      gameContainer.classList.add("edit-mode-cursor"); // Crosshair cursor
    } else {
      gameContainer.style.cursor = "grab"; // Default grab hand cursor for navigate mode
    }
  }
  /** Shows/hides and enables/disables the "Recolor" button based on selected furniture. */
  function updateRecolorButtonState() {
    if (uiState.recolorBtn && CLIENT_CONFIG) {
      let enabled = false;
      // Check if in edit mode, furniture selected state, and an item is selected
      if (
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        uiState.editMode.selectedFurnitureId
      ) {
        // Check if the selected furniture instance allows recoloring
        const furni = gameState.furniture[uiState.editMode.selectedFurnitureId];
        enabled = furni?.canRecolor || false;
      }
      // Enable/disable the button and toggle its visibility
      uiState.recolorBtn.disabled = !enabled;
      uiState.recolorBtn.style.display = enabled ? "inline-block" : "none";
    }
  }
  /** Updates the currency display UI element. */
  function updateCurrencyDisplay() {
    if (uiState.currencyDisplay) {
      const oldValue = parseInt(
        uiState.currencyDisplay.textContent.split(": ")[1] || "0"
      );
      const newValue = gameState.myCurrency;
      uiState.currencyDisplay.textContent = `Gold: ${newValue}`;

      // Flash effect on change
      if (newValue !== oldValue) {
        const changeClass = newValue > oldValue ? "flash-green" : "flash-red";
        uiState.currencyDisplay.classList.add(changeClass);
        setTimeout(() => {
          uiState.currencyDisplay.classList.remove(changeClass);
        }, 500); // Duration of flash
      }
    }
  }
  /** Populates and displays the shop panel. */
  function showShopPanel() {
    if (!uiState.shopPanel) {
      console.error(
        "Shop panel element not found (uiState.shopPanel is null)."
      );
      return;
    }
    if (!SHARED_CONFIG?.SHOP_CATALOG) {
      console.error("Shop config (SHARED_CONFIG.SHOP_CATALOG) not loaded yet.");
      uiState.shopPanel.innerHTML = "<p><i>Loading shop data...</i></p>";
      uiState.shopPanel.style.display = "block"; // Show loading state
      return;
    }

    populateShopPanel(); // Populate content before showing
    uiState.shopPanel.style.display = "block";
  }
  /** Hides the shop panel. */
  function hideShopPanel() {
    if (uiState.shopPanel) {
      uiState.shopPanel.style.display = "none";
    } else {
      console.error(
        "Shop panel element not found (uiState.shopPanel is null) when trying to hide."
      );
    }
  }
  /** Clears and populates the shop panel UI with items from the catalog. */
  function populateShopPanel() {
    if (
      !uiState.shopItemsDiv ||
      !SHARED_CONFIG?.SHOP_CATALOG ||
      !SHARED_CONFIG?.FURNITURE_DEFINITIONS
    ) {
      console.error("Cannot populate shop: Missing UI element or config data.");
      if (uiState.shopItemsDiv)
        uiState.shopItemsDiv.innerHTML =
          "<p><i>Error loading shop data.</i></p>";
      return;
    }

    uiState.shopItemsDiv.innerHTML = ""; // Clear previous items

    if (SHARED_CONFIG.SHOP_CATALOG.length === 0) {
      uiState.shopItemsDiv.innerHTML = "<p><i>Shop is empty!</i></p>";
      return;
    }

    // Sort catalog alphabetically by item name for consistency
    const sortedCatalog = [...SHARED_CONFIG.SHOP_CATALOG].sort((a, b) => {
      const defA = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === a.itemId
      );
      const defB = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === b.itemId
      );
      const nameA = defA?.name || a.itemId;
      const nameB = defB?.name || b.itemId;
      return nameA.localeCompare(nameB);
    });

    // Create elements for each shop item
    sortedCatalog.forEach((shopEntry) => {
      const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (def) => def.id === shopEntry.itemId
      );
      if (!definition) {
        console.warn(
          `Shop item '${shopEntry.itemId}' in catalog but not definitions. Skipping.`
        );
        return; // Skip items without definitions
      }

      const itemDiv = document.createElement("div");
      itemDiv.className = "shop-item";

      // Item Info (Preview, Name)
      const infoDiv = document.createElement("div");
      infoDiv.className = "shop-item-info";
      const previewSpan = document.createElement("span");
      previewSpan.className = "item-preview";
      previewSpan.style.backgroundColor = definition.color || "#8B4513";
      infoDiv.appendChild(previewSpan);
      const nameSpan = document.createElement("span");
      nameSpan.className = "shop-item-name";
      nameSpan.textContent = definition.name || shopEntry.itemId;
      nameSpan.title = `${definition.name} (${definition.width}x${definition.height})`;
      infoDiv.appendChild(nameSpan);
      itemDiv.appendChild(infoDiv);

      // Price Display
      const priceSpan = document.createElement("span");
      priceSpan.className = "shop-item-price";
      priceSpan.textContent = `${shopEntry.price} G`;
      itemDiv.appendChild(priceSpan);

      // Buy Button
      const buyButton = document.createElement("button");
      buyButton.className = "buy-btn";
      buyButton.textContent = "Buy";
      buyButton.dataset.itemId = shopEntry.itemId; // Store item ID for click handler
      buyButton.dataset.price = shopEntry.price; // Store price for enabling/disabling

      buyButton.addEventListener("click", () => {
        if (!socket?.connected) {
          logChatMessage("Not connected to server.", true, "error-msg");
          return;
        }
        buyButton.disabled = true; // Temporarily disable to prevent double clicks
        socket.emit("request_buy_item", { itemId: shopEntry.itemId }); // Send buy request
        // Re-evaluate button state shortly after, server response will update currency/inventory
        setTimeout(() => {
          if (buyButton) updateShopButtonStates();
        }, 300);
      });
      itemDiv.appendChild(buyButton);

      uiState.shopItemsDiv.appendChild(itemDiv);
    });

    updateShopButtonStates(); // Set initial button disabled state after populating
  }
  /** Enables/disables shop buy buttons based on player currency. */
  function updateShopButtonStates() {
    if (!uiState.shopItemsDiv) return;
    const buyButtons = uiState.shopItemsDiv.querySelectorAll("button.buy-btn");
    buyButtons.forEach((button) => {
      const price = parseInt(button.dataset.price, 10);
      if (!isNaN(price)) {
        button.disabled = gameState.myCurrency < price; // Disable if cannot afford
        button.classList.toggle("cannot-afford", gameState.myCurrency < price); // Optional styling hook
      } else {
        button.disabled = true; // Disable if price data is invalid
      }
    });
  }
  /** Updates the user list UI based on data received for the current room. */
  function updateUserListPanel(users) {
    if (!uiState.userListContent || !uiState.userListPanel) return;
    uiState.userListContent.innerHTML = ""; // Clear previous list

    // Update the panel header with the current room name
    const roomTitle = gameState.currentRoomId
      ? `Users in ${gameState.currentRoomId}`
      : "Users Online";
    const header = uiState.userListPanel.querySelector("h4");
    if (header) header.textContent = roomTitle;

    if (!users || users.length === 0) {
      uiState.userListContent.innerHTML = "<li><i>Nobody here...</i></li>";
      return;
    }

    // Populate list, sorted alphabetically
    users
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((user) => {
        const li = document.createElement("li");
        li.textContent = user.name;
        li.dataset.userid = user.id; // Store user ID (runtime avatar ID from server)
        // Highlight own name in the list
        if (user.id === gameState.myAvatarId) {
          li.classList.add("self-user");
        }
        // Add click listener to request profile (unless clicking self)
        li.addEventListener("click", () => {
          if (user.id !== gameState.myAvatarId && socket?.connected) {
            socket.emit("request_profile", { avatarId: user.id });
          }
        });
        uiState.userListContent.appendChild(li);
      });
  }
  /** Sends a request to the server for the current room's user list. */
  function requestUserListUpdate() {
    if (socket?.connected) {
      socket.emit("request_user_list");
    }
  }
  /** Displays the profile panel with data received from the server. */
  function showProfilePanel(profileData) {
    if (!uiState.profilePanel || !uiState.profileContent) return;
    // Populate profile content
    uiState.profileContent.innerHTML = `<h4>${
      profileData.name || "Unknown User"
    }</h4><p>ID: ${profileData.id}</p><p>Status: ${
      profileData.state || "Idle"
    }</p><p>Look: <span class="profile-color-swatch" style="background-color: ${
      profileData.bodyColor || "#CCCCCC"
    };"></span> ${profileData.bodyColor || "Default"}</p><p>Wealth: ${
      profileData.currency === undefined
        ? "N/A"
        : profileData.currency + " Gold"
    }</p><div class="profile-actions"></div>`; // Actions placeholder
    // Store target ID for potential context-aware actions later
    uiState.profilePanel.dataset.targetId = profileData.id;
    uiState.profilePanel.style.display = "block"; // Show panel
  }
  /** Hides the profile panel. */
  function hideProfilePanel() {
    if (uiState.profilePanel) {
      uiState.profilePanel.style.display = "none";
      uiState.profilePanel.dataset.targetId = ""; // Clear target ID
      uiState.profileContent.innerHTML = ""; // Clear content
    }
  }

  // --- Recolor Panel Functions ---
  /** Populates and displays the recolor panel for a specific furniture item. */
  function showRecolorPanel(furniId) {
    const furni = gameState.furniture[furniId]; // Get furniture instance from current room state
    const panel = uiState.recolorPanel;
    const swatchesDiv = uiState.recolorSwatchesDiv;
    const itemNameP = uiState.recolorItemNameP;

    // Ensure panel, furniture, and config are valid
    if (
      !furni ||
      !panel ||
      !swatchesDiv ||
      !itemNameP ||
      !furni.canRecolor ||
      !SHARED_CONFIG
    ) {
      hideRecolorPanel(); // Hide if invalid state
      return;
    }

    // Store the ID of the item being recolored and update panel title
    uiState.activeRecolorFurniId = furniId;
    itemNameP.textContent = `Item: ${furni.definition?.name || "Unknown"}`;
    swatchesDiv.innerHTML = ""; // Clear previous color swatches

    // Populate swatches from shared config
    SHARED_CONFIG.VALID_RECOLOR_HEX.forEach((hex) => {
      const swatch = document.createElement("div");
      swatch.className = "recolor-swatch";
      swatch.style.backgroundColor = hex;
      swatch.title = hex; // Tooltip shows hex code
      swatch.dataset.colorHex = hex; // Store hex for click handler
      // Add click listener to send recolor request
      swatch.addEventListener("click", () => {
        const colorToSend = swatch.dataset.colorHex;
        socket?.emit("request_recolor_furni", {
          furniId: uiState.activeRecolorFurniId,
          colorHex: colorToSend,
        });
        hideRecolorPanel(); // Close panel after selection
      });
      swatchesDiv.appendChild(swatch);
    });

    panel.style.display = "block"; // Show the panel
  }
  /** Hides the recolor panel. */
  function hideRecolorPanel() {
    if (uiState.recolorPanel) {
      uiState.recolorPanel.style.display = "none";
    }
    uiState.activeRecolorFurniId = null; // Clear active item ID
  }

  // --- Camera Controls ---
  /** Moves the camera by a delta amount. */
  function moveCamera(dx, dy) {
    camera.x += dx;
    camera.y += dy;
    // TODO: Add camera bounds checking if desired
  }
  /** Changes camera zoom level, optionally centered on a screen pivot point. */
  function changeZoom(
    factor,
    pivotX = canvas?.width / 2,
    pivotY = canvas?.height / 2
  ) {
    if (!canvas || !CLIENT_CONFIG) return;

    const worldPosBefore = isoToWorld(pivotX, pivotY); // World coords under pivot before zoom
    const oldZoom = camera.zoom;
    // Apply zoom factor, clamping within min/max limits
    const newZoom = Math.max(
      CLIENT_CONFIG.MIN_ZOOM,
      Math.min(CLIENT_CONFIG.MAX_ZOOM, camera.zoom * factor)
    );

    if (Math.abs(newZoom - oldZoom) < 0.001) return; // Avoid tiny changes

    camera.zoom = newZoom;

    // Calculate where the same world point appears on screen *after* zoom change (if pan didn't change)
    const screenPosAfterZoomOnly = getScreenPos(
      worldPosBefore.x,
      worldPosBefore.y
    );

    // Adjust camera pan (camera.x, camera.y) to counteract the shift caused by zooming,
    // keeping the pivot point stationary on screen.
    camera.x -= screenPosAfterZoomOnly.x - pivotX;
    camera.y -= screenPosAfterZoomOnly.y - pivotY;
  }

  // --- Edit Mode Management ---
  /** Sets the current edit mode state and handles transitions between states. */
  function setEditState(newState) {
    if (!CLIENT_CONFIG || uiState.editMode.state === newState) return;
    const oldState = uiState.editMode.state;
    uiState.editMode.state = newState;

    // Clean up state when exiting specific modes
    if (oldState === CLIENT_CONFIG.EDIT_STATE_PLACING) {
      uiState.editMode.placementRotation = 0;
      uiState.editMode.placementValid = false;
      // If exited placing mode without placing, deselect inventory item
      if (newState !== CLIENT_CONFIG.EDIT_STATE_PLACING) {
        setSelectedInventoryItem(null);
      }
    }
    if (oldState === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
      // If exited selected mode without action, deselect furniture
      if (newState !== CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
        setSelectedFurniture(null);
      }
    }

    // Update UI elements affected by edit state change
    updatePickupButtonState();
    updateRecolorButtonState();
    updateInventorySelection();
    updateUICursor();
  }
  /** Sets the currently selected item from inventory for placement. */
  function setSelectedInventoryItem(definitionId) {
    if (
      !CLIENT_CONFIG ||
      uiState.editMode.selectedInventoryItemId === definitionId
    )
      return; // No change

    uiState.editMode.selectedInventoryItemId = definitionId;
    uiState.editMode.placementRotation = 0; // Reset rotation on new selection

    if (definitionId) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_PLACING); // Enter placing mode
    } else if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Exit placing mode if deselected
    }
    updateInventorySelection(); // Update visual selection in UI
  }
  /** Sets the currently selected furniture item on the floor in the current room. */
  function setSelectedFurniture(furnitureId) {
    if (
      !CLIENT_CONFIG ||
      !gameState.currentRoomId ||
      uiState.editMode.selectedFurnitureId === furnitureId
    )
      return; // No change

    // Clear visual selection from previously selected item (if any)
    if (
      uiState.editMode.selectedFurnitureId &&
      gameState.furniture[uiState.editMode.selectedFurnitureId]
    ) {
      gameState.furniture[
        uiState.editMode.selectedFurnitureId
      ].isSelected = false;
    }

    uiState.editMode.selectedFurnitureId = furnitureId;

    // Apply visual selection to the newly selected item (if valid)
    if (furnitureId && gameState.furniture[furnitureId]) {
      gameState.furniture[furnitureId].isSelected = true;
      setEditState(CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI); // Enter selected furniture state
    } else {
      // Deselected or item became invalid
      uiState.editMode.selectedFurnitureId = null;
      hideRecolorPanel(); // Hide panel if deselected
      // If we were in selected state, return to navigate state
      if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
        setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
      }
    }
    // Update buttons based on the new selection
    updatePickupButtonState();
    updateRecolorButtonState();
  }
  /** Toggles Edit Mode on/off and resets relevant states. */
  function toggleEditMode() {
    if (!CLIENT_CONFIG) return;
    uiState.isEditMode = !uiState.isEditMode;

    // Update button text and style
    const btn = document.getElementById(CLIENT_CONFIG.TOGGLE_EDIT_BTN_ID);
    if (btn) {
      btn.textContent = `Room Edit (${uiState.isEditMode ? "On" : "Off"})`;
      btn.classList.toggle("active", uiState.isEditMode);
    }

    if (!uiState.isEditMode) {
      // --- Actions when turning Edit Mode OFF ---
      clearAllHighlights(); // Remove tile highlights
      setSelectedFurniture(null); // Deselect floor furniture
      setSelectedInventoryItem(null); // Deselect inventory item
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Ensure state is navigate
      hideRecolorPanel(); // Hide recolor panel
    } else {
      // --- Actions when turning Edit Mode ON ---
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Start in navigate state within edit mode
    }

    // Update UI elements based on the new mode
    updatePickupButtonState();
    updateRecolorButtonState();
    updateInventorySelection();
    updateUICursor();
  }

  // --- Highlighting & Ghost Placement (Operates on current room) ---

  /** Updates tile highlights based on mouse position and edit mode state. */
  function updateHighlights() {
    if (
      !CLIENT_CONFIG ||
      !SHARED_CONFIG ||
      !gameState.currentRoomId ||
      gameState.clientTiles.length === 0
    )
      return;

    clearAllHighlights(); // Reset all highlights each frame

    const gridPos = inputState.currentMouseGridPos;

    // Ignore if mouse is outside the current room's valid grid area
    if (!isValidClientTile(gridPos.x, gridPos.y)) {
      gameState.highlightedTile = null;
      // If placing, mark as invalid when outside bounds
      if (
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING
      ) {
        uiState.editMode.placementValid = false;
      }
      return;
    }

    // Store the grid tile currently under the mouse
    gameState.highlightedTile = { x: gridPos.x, y: gridPos.y };

    if (uiState.isEditMode) {
      // --- Edit Mode Highlighting ---
      if (
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
        uiState.editMode.selectedInventoryItemId
      ) {
        // Highlight placement area and check validity
        const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (d) => d.id === uiState.editMode.selectedInventoryItemId
        );
        uiState.editMode.placementValid = definition
          ? isClientPlacementValid(definition, gridPos.x, gridPos.y)
          : false;
        const color = uiState.editMode.placementValid
          ? CLIENT_CONFIG.FURNI_PLACE_HIGHLIGHT_COLOR
          : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR; // Yellow/Red
        // Calculate tiles the ghost would occupy
        const ghostTiles = definition
          ? ClientFurniture.prototype.getOccupiedTiles.call({
              x: gridPos.x,
              y: gridPos.y,
              definition: definition,
            })
          : [gridPos];
        ghostTiles.forEach((tp) => setTileHighlight(tp.x, tp.y, color)); // Highlight affected tiles
      } else {
        // Highlight hovered furniture (if not the one currently selected) or the tile under mouse
        const hoveredF = getTopmostFurnitureAtScreen(
          inputState.currentMouseScreenPos.x,
          inputState.currentMouseScreenPos.y
        );
        if (hoveredF && hoveredF.id !== uiState.editMode.selectedFurnitureId) {
          hoveredF
            .getOccupiedTiles()
            .forEach((tp) =>
              setTileHighlight(
                tp.x,
                tp.y,
                CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
              )
            ); // Highlight furniture footprint
        } else if (!hoveredF && gameState.highlightedTile) {
          setTileHighlight(
            gameState.highlightedTile.x,
            gameState.highlightedTile.y,
            CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
          ); // Highlight single tile
        }
      }
    } else {
      // --- Navigate Mode Highlighting ---
      // Highlight walkable tiles
      if (
        gameState.highlightedTile &&
        isClientWalkable(
          gameState.highlightedTile.x,
          gameState.highlightedTile.y
        )
      ) {
        setTileHighlight(
          gameState.highlightedTile.x,
          gameState.highlightedTile.y,
          CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
        );
      }
      // Highlight interactable furniture (doors, usable, sittable)
      const hoveredF = getTopmostFurnitureAtScreen(
        inputState.currentMouseScreenPos.x,
        inputState.currentMouseScreenPos.y
      );
      if (
        hoveredF &&
        (hoveredF.isDoor ||
          hoveredF.definition?.canUse ||
          hoveredF.definition?.canSit)
      ) {
        hoveredF
          .getOccupiedTiles()
          .forEach((tp) =>
            setTileHighlight(
              tp.x,
              tp.y,
              CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
            )
          );
      }
    }

    // Final check: If the highlighted tile somehow became invalid (e.g., outside bounds), clear it
    if (
      gameState.highlightedTile &&
      !isValidClientTile(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y
      )
    ) {
      gameState.highlightedTile = null;
    }
  }
  /** Client-side check if placing an item at a location is valid based on current room state. */
  function isClientPlacementValid(definition, gridX, gridY) {
    if (!definition || !SHARED_CONFIG || !gameState.currentRoomId) return false;

    // Create a temporary object representing the furniture to be placed
    const tempFurniProto = { x: gridX, y: gridY, definition: definition };
    const occupiedTiles =
      ClientFurniture.prototype.getOccupiedTiles.call(tempFurniProto);

    // Check each tile the furniture would occupy
    for (const tile of occupiedTiles) {
      const gx = tile.x;
      const gy = tile.y;
      if (!isValidClientTile(gx, gy)) return false; // Out of bounds
      const tileType = getTileLayoutType(gx, gy);
      if (tileType === 1 || tileType === "X") return false; // Cannot place on Wall or Hole

      // If placing a solid (non-flat) item, check for blocking items below
      if (!definition.isFlat && !definition.isWalkable) {
        const stack = Object.values(gameState.furniture).filter(
          (f) => Math.round(f.visualX) === gx && Math.round(f.visualY) === gy
        );
        const topItemOnThisTile = stack.sort(
          (a, b) => b.visualZ - a.visualZ
        )[0];
        // Cannot place on top of a non-stackable item
        if (topItemOnThisTile && !topItemOnThisTile.definition?.stackable)
          return false;
        // Also check general solid occupation (covers cases where blocker isn't directly below)
        const solidBlocker = stack.find(
          (f) =>
            !f.definition?.isWalkable &&
            !f.definition?.isFlat &&
            !f.definition?.stackable
        );
        if (solidBlocker) return false;
      }
    }

    // Check item directly below the furniture's base tile for stackability
    const baseStack = Object.values(gameState.furniture).filter(
      (f) => Math.round(f.visualX) === gridX && Math.round(f.visualY) === gridY
    );
    const topItemOnBase = baseStack.sort((a, b) => b.visualZ - a.visualZ)[0];
    if (
      topItemOnBase &&
      !topItemOnBase.definition?.stackable &&
      !definition.isFlat
    )
      return false; // Cannot stack non-flat on non-stackable

    // Check max stack height limit
    const estimatedZ =
      getClientStackHeightAt(gridX, gridY) + (definition.zOffset || 0); // Uses client-side Z calculation
    if (estimatedZ >= SHARED_CONFIG.MAX_STACK_Z) return false; // Exceeds limit

    return true; // All checks passed
  }
  /** Sets the highlight color for a specific client tile instance in the current room. */
  function setTileHighlight(x, y, color) {
    // Find the corresponding tile object in the current room's state
    const tile = gameState.clientTiles.find((t) => t.x === x && t.y === y);
    if (tile) tile.highlight = color; // Set the highlight property
  }
  /** Clears all tile highlights and furniture selection highlights in the current room. */
  function clearAllHighlights() {
    if (!CLIENT_CONFIG || !gameState.currentRoomId) return;
    // Clear highlights from all tiles in the current room
    gameState.clientTiles.forEach((t) => (t.highlight = null));
    // Clear visual selection from all furniture instances,
    // unless one is actively selected in edit mode.
    Object.values(gameState.furniture).forEach((f) => {
      f.isSelected =
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        f.id === uiState.editMode.selectedFurnitureId;
    });
  }
  /** Draws the semi-transparent ghost image of the item being placed. */
  function drawPlacementGhost(ctx) {
    // Only draw if in edit mode, placing state, item selected, and over a valid tile
    if (
      !uiState.isEditMode ||
      uiState.editMode.state !== CLIENT_CONFIG.EDIT_STATE_PLACING ||
      !uiState.editMode.selectedInventoryItemId ||
      !gameState.highlightedTile ||
      !SHARED_CONFIG ||
      !CLIENT_CONFIG ||
      !gameState.currentRoomId
    )
      return;

    const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === uiState.editMode.selectedInventoryItemId
    );
    if (!definition) return; // Need definition to draw

    const gridX = gameState.highlightedTile.x;
    const gridY = gameState.highlightedTile.y;
    const screenPos = getScreenPos(gridX, gridY);
    const zoom = camera.zoom;

    // Set transparency and color based on placement validity
    const alpha = uiState.editMode.placementValid ? 0.6 : 0.3;
    const color = uiState.editMode.placementValid
      ? definition.color
      : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR; // Use definition color or red

    // Calculate ghost's Z position based on items below it
    const estimatedBaseZ = getClientStackHeightAt(gridX, gridY);
    const ghostZ = estimatedBaseZ + (definition.zOffset || 0);
    const zOffsetPx = ghostZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;

    // Calculate drawing dimensions similar to ClientFurniture.draw
    const baseDrawWidth =
      SHARED_CONFIG.TILE_WIDTH_HALF * definition.width * zoom * 1.1;
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

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = shadeColor(color, -50);
    ctx.lineWidth = Math.max(1, 1.5 * zoom);
    ctx.beginPath();

    // Draw ghost shape based on definition (flat diamond or box/door)
    if (definition.isFlat) {
      const hW = SHARED_CONFIG.TILE_WIDTH_HALF * definition.width * zoom;
      const hH = SHARED_CONFIG.TILE_HEIGHT_HALF * definition.height * zoom;
      ctx.moveTo(screenPos.x, screenPos.y - hH - zOffsetPx);
      ctx.lineTo(screenPos.x + hW, screenPos.y - zOffsetPx);
      ctx.lineTo(screenPos.x, screenPos.y + hH - zOffsetPx);
      ctx.lineTo(screenPos.x - hW, screenPos.y - zOffsetPx);
      ctx.closePath();
    } else if (definition.isDoor) {
      // Generic check for any door
      ctx.rect(
        drawX + baseDrawWidth * 0.1,
        drawY,
        baseDrawWidth * 0.8,
        baseDrawHeight
      );
      ctx.fillStyle = shadeColor(color, -20);
      ctx.fillRect(
        drawX + baseDrawWidth * 0.2,
        drawY + baseDrawHeight * 0.1,
        baseDrawWidth * 0.6,
        baseDrawHeight * 0.8
      );
    } else {
      ctx.rect(drawX, drawY, baseDrawWidth, baseDrawHeight); // Default box
    }
    ctx.fill();
    ctx.stroke();

    // Draw rotation indicator arrow if not flat
    if (!definition.isFlat) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.translate(screenPos.x, screenPos.y - zOffsetPx); // Move origin to tile center (Z adjusted)
      const angleRad = (uiState.editMode.placementRotation / 4) * Math.PI; // Convert direction to angle
      ctx.rotate(angleRad);
      const arrowL = SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.8;
      const arrowW = arrowL * 0.6;
      // Draw triangle pointing in placement direction
      ctx.beginPath();
      ctx.moveTo(arrowL * 0.6, 0);
      ctx.lineTo(0, -arrowW / 2);
      ctx.lineTo(0, arrowW / 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  /** Client-side estimation of stack height at a grid coordinate based on current room's visual Z positions. */
  function getClientStackHeightAt(gridX, gridY) {
    if (!SHARED_CONFIG || !gameState.currentRoomId) return 0;
    // Filter furniture in the current room at the target coordinates
    const stack = Object.values(gameState.furniture).filter(
      (f) => Math.round(f.visualX) === gridX && Math.round(f.visualY) === gridY
    );
    let highestStackableTopZ = 0.0; // Start at floor level
    stack.forEach((furni) => {
      if (!furni.definition) return;
      // Calculate the Z position of the top surface of this item
      const itemStackContrib =
        (furni.definition.stackHeight || 0) *
        SHARED_CONFIG.DEFAULT_STACK_HEIGHT;
      const itemTopZ =
        furni.visualZ + (furni.definition.isFlat ? 0 : itemStackContrib);
      // Only consider the top surface of stackable items for the next item's base Z
      if (furni.definition.stackable) {
        highestStackableTopZ = Math.max(highestStackableTopZ, itemTopZ);
      }
    });
    return highestStackableTopZ;
  }

  function debounce(func, wait, immediate) {
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

  function resizeCanvas() {
    if (!canvas || !gameContainer || !ctx) {
      console.warn("ResizeCanvas called before canvas/container ready.");
      return;
    }

    // Get the current display size of the container
    const displayWidth = gameContainer.clientWidth;
    const displayHeight = gameContainer.clientHeight;

    // Check if the canvas drawing buffer size needs to change
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      // Set the drawing buffer size to match the display size
      canvas.width = displayWidth;
      canvas.height = displayHeight;

      // Optional: Re-center camera or adjust view if needed after resize
      // This simple version just resizes, camera logic might need tweaking later
      // depending on desired aspect ratio behavior.

      console.log(`Canvas resized to: ${canvas.width}x${canvas.height}`);

      // Reset image smoothing after resize (it often gets reset)
      ctx.imageSmoothingEnabled = false;

      // No need to redraw immediately here, the game loop will handle it
    }
  }

  const debouncedResizeCanvas = debounce(resizeCanvas, 100); // Adjust debounce delay (ms) as needed

  // --- Initialization (Client) ---
  /** Initializes the client, fetches config, sets up UI, connects to socket. */
  async function initClient() {
    const token = localStorage.getItem("authToken");
    if (!token) {
      console.log("No auth token found, directing to login.");
      window.location.href = "/login.html";
      return;
    }

    console.log("Initializing Client...");

    // 1. Fetch Configuration from Server
    try {
      console.log("Fetching server configuration...");
      const response = await fetch("/api/config"); // API endpoint defined on server
      if (!response.ok)
        throw new Error(`Config fetch failed: ${response.status}`);
      SHARED_CONFIG = await response.json();
      if (!SHARED_CONFIG?.FURNITURE_DEFINITIONS)
        throw new Error("Invalid config received.");
      console.log("Server configuration loaded.");

      // 2. Define Client-Specific Configuration (depends on SHARED_CONFIG)
      CLIENT_CONFIG = {
        CANVAS_ID: "gameCanvas",
        GAME_CONTAINER_ID: "game-container",
        DEBUG_DIV_ID: "debug-content",
        CHAT_INPUT_ID: "chat-input",
        CHAT_LOG_ID: "chat-log",
        BUBBLE_CONTAINER_ID: "chat-bubbles-container",
        INVENTORY_ITEMS_ID: "inventory-items",
        PICKUP_FURNI_BTN_ID: "pickup-furni-btn",
        RECOLOR_FURNI_BTN_ID: "recolor-furni-btn",
        PLAYER_CURRENCY_ID: "player-currency",
        ROOM_NAME_DISPLAY_ID: "room-name-display",
        ZOOM_IN_BTN_ID: "zoom-in-btn",
        ZOOM_OUT_BTN_ID: "zoom-out-btn",
        TOGGLE_EDIT_BTN_ID: "toggle-edit-btn",
        USER_LIST_PANEL_ID: "user-list-panel",
        USER_LIST_CONTENT_ID: "user-list-content",
        PROFILE_PANEL_ID: "profile-panel",
        PROFILE_CONTENT_ID: "profile-content",
        PROFILE_CLOSE_BTN_ID: "profile-close-btn",
        RECOLOR_PANEL_ID: "recolor-panel",
        RECOLOR_SWATCHES_ID: "recolor-swatches",
        RECOLOR_ITEM_NAME_ID: "recolor-item-name",
        RECOLOR_CLOSE_BTN_ID: "recolor-close-btn",
        RECOLOR_RESET_BTN_ID: "recolor-reset-btn",
        SHOP_PANEL_ID: "shop-panel",
        SHOP_ITEMS_ID: "shop-items",
        SHOP_CLOSE_BTN_ID: "shop-close-btn",
        OPEN_SHOP_BTN_ID: "open-shop-btn",
        // Gameplay/Visual Settings
        MIN_ZOOM: 0.3,
        MAX_ZOOM: 2.5,
        ZOOM_FACTOR: 1.1, // Multiplier for zoom steps
        CAMERA_PAN_SPEED: 15, // Pixels per frame for key panning
        CHAT_BUBBLE_DURATION: 4000, // ms
        MAX_CHAT_LOG_MESSAGES: 50,
        EMOTE_DURATION: 2500, // Default client-side visual duration if definition missing
        AVATAR_SKIN_COLOR: "#F0DDBB",
        AVATAR_EYE_COLOR: "#000000",
        INTERPOLATION_FACTOR: 0.25, // Controls smoothness of visual movement (0-1)
        VISUAL_Z_FACTOR: SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5, // Pixels per Z unit
        // Highlight Colors (RGBA for transparency)
        FURNI_PLACE_HIGHLIGHT_COLOR: "rgba(255, 255, 0, 0.5)", // Yellowish
        FURNI_SELECT_HIGHLIGHT_COLOR: "rgba(0, 255, 255, 0.7)", // Cyan
        FURNI_HOVER_HIGHLIGHT_COLOR: "rgba(0, 200, 255, 0.3)", // Light Blue
        TILE_EDIT_HIGHLIGHT_COLOR: "rgba(255, 0, 0, 0.4)", // Reddish (invalid placement)
        // Edit Mode State Constants
        EDIT_STATE_NAVIGATE: "navigate",
        EDIT_STATE_PLACING: "placing",
        EDIT_STATE_SELECTED_FURNI: "selected_furni",
      };
      // Set initial edit mode state using the constant
      uiState.editMode.state = CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
    } catch (error) {
      console.error("FATAL: Failed to load configuration:", error);
      alert(
        `Error loading game configuration: ${error.message}\nPlease try refreshing.`
      );
      const debugDiv = document.getElementById("coords-debug"); // Try to get debug div even if CLIENT_CONFIG failed
      if (debugDiv)
        debugDiv.innerHTML = `<span style="color:red; font-weight:bold;">FATAL ERROR: Config load failed.<br>${error.message}</span>`;
      return; // Stop initialization
    }

    // 3. Get DOM Element References
    canvas = document.getElementById(CLIENT_CONFIG.CANVAS_ID);
    ctx = canvas?.getContext("2d");
    gameContainer = document.getElementById(CLIENT_CONFIG.GAME_CONTAINER_ID);
    if (!canvas || !ctx || !gameContainer) {
      console.error("FATAL: Canvas or game container not found!");
      alert("Error initializing game elements. Canvas not found.");
      return;
    }
    // Get references to all UI panels and elements defined in CLIENT_CONFIG
    uiState.debugDiv = document.getElementById(CLIENT_CONFIG.DEBUG_DIV_ID);
    uiState.chatInput = document.getElementById(CLIENT_CONFIG.CHAT_INPUT_ID);
    uiState.chatLogDiv = document.getElementById(CLIENT_CONFIG.CHAT_LOG_ID);
    uiState.bubbleContainer = document.getElementById(
      CLIENT_CONFIG.BUBBLE_CONTAINER_ID
    );
    uiState.inventoryItemsDiv = document.getElementById(
      CLIENT_CONFIG.INVENTORY_ITEMS_ID
    );
    uiState.pickupFurniBtn = document.getElementById(
      CLIENT_CONFIG.PICKUP_FURNI_BTN_ID
    );
    uiState.recolorBtn = document.getElementById(
      CLIENT_CONFIG.RECOLOR_FURNI_BTN_ID
    );
    uiState.currencyDisplay = document.getElementById(
      CLIENT_CONFIG.PLAYER_CURRENCY_ID
    );
    uiState.roomNameDisplay = document.getElementById(
      CLIENT_CONFIG.ROOM_NAME_DISPLAY_ID
    );
    uiState.userListPanel = document.getElementById(
      CLIENT_CONFIG.USER_LIST_PANEL_ID
    );
    uiState.userListContent = document.getElementById(
      CLIENT_CONFIG.USER_LIST_CONTENT_ID
    );
    uiState.profilePanel = document.getElementById(
      CLIENT_CONFIG.PROFILE_PANEL_ID
    );
    uiState.profileContent = document.getElementById(
      CLIENT_CONFIG.PROFILE_CONTENT_ID
    );
    uiState.profileCloseBtn = document.getElementById(
      CLIENT_CONFIG.PROFILE_CLOSE_BTN_ID
    );
    uiState.recolorPanel = document.getElementById(
      CLIENT_CONFIG.RECOLOR_PANEL_ID
    );
    uiState.recolorSwatchesDiv = document.getElementById(
      CLIENT_CONFIG.RECOLOR_SWATCHES_ID
    );
    uiState.recolorItemNameP = document.getElementById(
      CLIENT_CONFIG.RECOLOR_ITEM_NAME_ID
    );
    uiState.recolorCloseBtn = document.getElementById(
      CLIENT_CONFIG.RECOLOR_CLOSE_BTN_ID
    );
    uiState.recolorResetBtn = document.getElementById(
      CLIENT_CONFIG.RECOLOR_RESET_BTN_ID
    );
    uiState.shopPanel = document.getElementById(CLIENT_CONFIG.SHOP_PANEL_ID);
    uiState.shopItemsDiv = document.getElementById(CLIENT_CONFIG.SHOP_ITEMS_ID);
    uiState.shopCloseBtn = document.getElementById(
      CLIENT_CONFIG.SHOP_CLOSE_BTN_ID
    );
    uiState.openShopBtn = document.getElementById(
      CLIENT_CONFIG.OPEN_SHOP_BTN_ID
    );

    requestAnimationFrame(() => {
      resizeCanvas(); // Perform initial resize
      // Now setup input listeners AFTER initial resize might have happened
      setupInputListeners();
    });

    window.addEventListener("resize", debouncedResizeCanvas);

    ctx.imageSmoothingEnabled = false; // Use nearest-neighbor scaling for crisp pixels

    // 4. Reset Local State (clear any stale data before connecting)
    resetLocalState();
    logChatMessage("Welcome to ZanyTown!", true, "info-msg");

    // 5. Initialize Sounds
    try {
      sounds.walk = new Audio("sounds/step.wav");
      sounds.walk.volume = 0.4;
    } catch (e) {
      console.warn("Sound load failed: step.wav");
    }
    try {
      sounds.place = new Audio("sounds/place.mp3");
      sounds.place.volume = 0.6;
    } catch (e) {
      console.warn("Sound load failed: place.mp3");
    }
    try {
      sounds.chat = new Audio("sounds/chat.mp3");
      sounds.chat.volume = 0.5;
    } catch (e) {
      console.warn("Sound load failed: chat.mp3");
    }
    try {
      sounds.use = new Audio("sounds/use.wav");
      sounds.use.volume = 0.7;
    } catch (e) {
      console.warn("Sound load failed: use.wav");
    }
    // Load emote sounds based on shared config
    Object.values(SHARED_CONFIG.EMOTE_DEFINITIONS).forEach((emoteDef) => {
      if (emoteDef.sound && !sounds[emoteDef.sound]) {
        try {
          let ext = ".wav"; // Default extension
          if (emoteDef.sound === "dance") ext = ".mp3"; // Specific extension for dance
          sounds[emoteDef.sound] = new Audio(`sounds/${emoteDef.sound}${ext}`);
          sounds[emoteDef.sound].volume = 0.6;
        } catch (e) {
          console.warn(`Sound load failed: ${emoteDef.sound}`);
          sounds[emoteDef.sound] = null; // Ensure it's null if loading failed
        }
      }
    });

    // 6. Setup Input Listeners and Initial UI State
    setupInputListeners();
    hideProfilePanel(); // Ensure hidden initially
    hideRecolorPanel();
    hideShopPanel();
    updatePickupButtonState(); // Set initial state
    updateRecolorButtonState();
    updateCurrencyDisplay(); // Display initial currency (0 until server update)

    // 7. Connect to Socket.IO Server
    try {
      logChatMessage("Connecting to server...", true, "info-msg");
      const currentToken = localStorage.getItem("authToken"); // Get token again just before connect
      if (!currentToken) {
        console.log("No token found before socket connection, redirecting.");
        logChatMessage(
          "Auth token missing. Redirecting to login.",
          true,
          "error-msg"
        );
        window.location.href = "/login.html";
        return; // Stop if token missing
      }
      // Connect with authentication token
      socket = io({ auth: { token: currentToken } });
      setupSocketListeners(); // Setup listeners *before* connection events fire
    } catch (err) {
      console.error("Failed to initialize Socket.IO:", err);
      logChatMessage("Error connecting. Check console.", true, "error-msg");
      if (uiState.debugDiv) uiState.debugDiv.textContent = "Connection Error";
      return;
    }

    // 8. Start Game Loop
    console.log(
      "Client Initialized. Waiting for server connection and room state..."
    );
    lastTimestamp = performance.now();
    requestAnimationFrame(gameLoop);
  }

  /**
   * Resets the local client state, typically called on room change or disconnect.
   * Clears room-specific data like avatars, furniture, tiles, but preserves
   * global data like inventory, currency, and player ID.
   */
  function resetLocalState() {
    console.log("Resetting local client room state.");

    // --- Clear Room-Specific Game Objects ---
    Object.values(gameState.avatars).forEach((a) => a.clearBubble()); // Clear any lingering chat bubbles
    gameState.furniture = {}; // Clear furniture map
    gameState.avatars = {}; // Clear avatar map
    gameState.clientTiles = []; // Clear tile objects
    gameState.highlightedTile = null; // Clear tile highlight reference

    // Clear layout/room info
    gameState.roomLayout = [];
    gameState.roomCols = 0;
    gameState.roomRows = 0;
    gameState.currentRoomId = null; // Reset current room ID

    // --- Reset UI State related to room context ---
    uiState.activeChatBubbles.forEach((b) => b.element?.remove()); // Remove bubble DOM elements
    uiState.activeChatBubbles = []; // Clear active bubble list

    // Force edit mode off on room change/disconnect for simplicity
    uiState.isEditMode = false;
    const initialEditState = CLIENT_CONFIG
      ? CLIENT_CONFIG.EDIT_STATE_NAVIGATE
      : "navigate";
    uiState.editMode = {
      state: initialEditState,
      selectedInventoryItemId: null,
      selectedFurnitureId: null,
      placementValid: false,
      placementRotation: 0,
    };
    uiState.activeRecolorFurniId = null; // Clear recolor target

    // --- Update UI Elements to reflect reset ---
    updatePickupButtonState(); // Disable pickup button
    updateRecolorButtonState(); // Hide/disable recolor button
    updateInventorySelection(); // Deselect inventory item visually
    updateUICursor(); // Reset cursor to default navigate mode
    hideProfilePanel(); // Hide context-specific panels
    hideRecolorPanel();
    hideShopPanel(); // Close shop panel on room change/disconnect

    // Reset edit mode button appearance
    const editBtn = document.getElementById(CLIENT_CONFIG?.TOGGLE_EDIT_BTN_ID);
    if (editBtn) {
      editBtn.textContent = `Room Edit (Off)`;
      editBtn.classList.remove("active");
    }

    // Clear user list and reset header
    if (uiState.userListContent)
      uiState.userListContent.innerHTML = "<li><i>Joining room...</i></li>";
    const userListHeader = uiState.userListPanel?.querySelector("h4");
    if (userListHeader) userListHeader.textContent = "Users Online";

    // Update window title and room display text
    document.title = "ZanyTown - Connecting...";
    if (uiState.roomNameDisplay)
      uiState.roomNameDisplay.textContent = "Room: Connecting...";

    // Note: Inventory and Currency displays are NOT reset here,
    // as they represent persistent player state loaded from the server.
    // They will be updated when the server sends 'inventory_update' or 'currency_update'.
  }

  // --- Start Client Initialization on DOM Load ---
  document.addEventListener("DOMContentLoaded", initClient);
})();
