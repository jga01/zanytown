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
    currentRoomId: null, // NEW: Track current room ID

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
    roomNameDisplay: null, // Optional element for room name
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
      state: null, // Initialized properly in resetLocalState/initClient
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
      this.visualZ = dto.z; // Interpolated position
      this.drawOrder = 0;
      this.isVisible = true;
      this.update(dto);
    }
    update(dto) {
      // Updates target state
      if (dto.x != null) this.x = dto.x;
      if (dto.y != null) this.y = dto.y;
      if (dto.z != null) this.z = dto.z;
      this.calculateDrawOrder();
    }
    interpolate(deltaTimeFactor) {
      // Smoothly moves visual towards target
      this.visualX += (this.x - this.visualX) * deltaTimeFactor;
      this.visualY += (this.y - this.visualY) * deltaTimeFactor;
      this.visualZ += (this.z - this.visualZ) * deltaTimeFactor;
      // Snap if very close
      const SNAP_THRESHOLD = 0.01;
      if (Math.abs(this.x - this.visualX) < SNAP_THRESHOLD)
        this.visualX = this.x;
      if (Math.abs(this.y - this.visualY) < SNAP_THRESHOLD)
        this.visualY = this.y;
      if (Math.abs(this.z - this.visualZ) < SNAP_THRESHOLD)
        this.visualZ = this.z;
      this.calculateDrawOrder();
    }
    calculateDrawOrder() {
      // Calculates isometric draw order (Y > X > Z)
      // Multiply by large numbers to prioritize Y, then X, then Z for sorting
      this.drawOrder =
        Math.round(
          this.visualY * 100000 + this.visualX * 10000 + this.visualZ * 1000
        ) + 1000;
    }
    draw(ctx) {
      /* Base method, override in subclasses */
    }
  }

  /** Represents a single floor/wall/hole tile for rendering. */
  class ClientTile {
    constructor(x, y, layoutType) {
      this.x = x;
      this.y = y;
      this.layoutType = layoutType;
      this.baseColor = "#b0e0b0";
      this.highlight = null; // Highlight overlay color string
      // Drawn before objects (large negative base offset)
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
      ctx.beginPath();
      ctx.moveTo(0, -halfH);
      ctx.lineTo(halfW, 0);
      ctx.lineTo(0, halfH);
      ctx.lineTo(-halfW, 0);
      ctx.closePath(); // Diamond path
      ctx.fillStyle = this.baseColor;
      ctx.fill();
      if (this.highlight) {
        ctx.fillStyle = this.highlight;
        ctx.fill();
      } // Highlight overlay
      if (this.layoutType !== "X") {
        ctx.strokeStyle = "#444";
        ctx.lineWidth = Math.max(0.5, 1 * zoom);
        ctx.stroke();
      } // Outline unless hole
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
      this.definition = null;
      this.canRecolor = false;
      this.isSelected = false; // For edit mode selection highlight

      // --- NEW: Store door properties if received ---
      this.isDoor = dto.isDoor || false;
      this.targetRoomId = dto.targetRoomId || null;
      // Client usually doesn't need targetX/Y, but could store if useful
      // this.targetX = dto.targetX;
      // this.targetY = dto.targetY;

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
      if (dto.definitionId && dto.definitionId !== this.definitionId) {
        console.warn(
          `Furniture ${this.id} definition changed from ${this.definitionId} to ${dto.definitionId}`
        );
        this.definitionId = dto.definitionId;
        this.definition = null;
        this.updateDefinition();
      }
      if (dto.rotation != null) this.rotation = dto.rotation;
      if (dto.state != null) this.state = dto.state;
      if (dto.colorOverride !== undefined) {
        this.colorOverride = dto.colorOverride;
      }
      // Update door properties if they change via DTO
      if (dto.isDoor !== undefined) this.isDoor = dto.isDoor;
      if (dto.targetRoomId !== undefined) this.targetRoomId = dto.targetRoomId;

      super.update(dto); // Update base properties (x, y, z)
      if (!this.definition) this.updateDefinition(); // Ensure definition is loaded
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

      // Calculate dimensions and Z offset
      const baseDrawWidth =
        SHARED_CONFIG.TILE_WIDTH_HALF * definition.width * zoom * 1.1;
      const visualHeightFactor = definition.isFlat
        ? 0.1
        : definition.stackHeight
        ? definition.stackHeight * 1.5
        : 1.0;
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

      // Base Style uses colorOverride first, then definition color, fallback saddlebrown
      let baseFill = this.colorOverride || definition.color || "#8B4513";
      let baseStroke = shadeColor(baseFill, -50);

      // Specific logic for lamp state if NOT overridden by custom color
      if (!this.colorOverride && definition.id === "light_simple") {
        baseFill = this.state === "on" ? "#FFFF00" : "#AAAAAA";
        baseStroke = shadeColor(baseFill, -40);
      }

      // Visual hint for doors (Optional: uncomment if you want the cyan outline)
      // if (this.isDoor) {
      //   baseStroke = "#00FFFF";
      // }

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

      // --- Define Shape Path (Simplified representation of the geometric drawing logic) ---
      const defineShapePath = () => {
        ctx.beginPath();
        if (definition.isFlat) {
          // Draw flat diamond shape
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
          ctx.rect(drawX, drawY + backHeight, seatWidth, seatHeight);
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
          ctx.rect(backDrawX, backDrawY, actualBackWidth, actualBackHeight);
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
          ctx.moveTo(lampX, drawY + lampShadeHeight);
          ctx.lineTo(lampX + lampWidth, drawY + lampShadeHeight);
          ctx.lineTo(lampX + lampWidth * 0.8, drawY);
          ctx.lineTo(lampX + lampWidth * 0.2, drawY);
          ctx.closePath(); // Shade
          if (this.state === "on") {
            // Draw light cone if on
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
          // *** MODIFICATION: Include door_to_lobby in the drawing condition ***
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
          ); // Simple rectangle for door frame
          // Optionally add a knob or detail based on rotation?
          ctx.fillStyle = shadeColor(baseFill, -20); // Darker fill for door panel
          ctx.fillRect(
            drawX + baseDrawWidth * 0.2,
            drawY + baseDrawHeight * 0.1,
            baseDrawWidth * 0.6,
            baseDrawHeight * 0.8
          );
        } else {
          // Default box shape
          ctx.rect(drawX, drawY, baseDrawWidth, baseDrawHeight);
        }
      };
      // --- End Shape Path ---

      // Apply the style *before* defining the path if fill/stroke apply to the main shape
      applyStyle(baseStyle);
      defineShapePath();
      // Apply fill/stroke *after* path definition
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
        // Re-apply the path definition before stroking the highlight
        applyStyle(highlightStyle);
        defineShapePath(); // Define the same path again
        ctx.stroke(); // Stroke the highlight outline
      }

      // =============================================== //
      // ===== START: Added Door Name Text Drawing ===== //
      // =============================================== //
      if (this.isDoor && this.targetRoomId) {
        // Set text properties
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)"; // White text, slightly transparent
        ctx.font = `bold ${Math.max(7, 9 * zoom)}px Verdana`; // Small, bold font, scales slightly with zoom
        ctx.textAlign = "center"; // Center the text horizontally
        ctx.textBaseline = "bottom"; // Align text bottom edge to the calculated Y

        // Prepare the text
        const hintText = `-> ${this.targetRoomId}`;

        // Calculate position: Center X on the furniture, Y slightly above the furniture's top edge (`drawY`)
        const textY = drawY - 5 * zoom; // Adjust the '5 * zoom' offset as needed for appearance

        // Draw the text
        ctx.fillText(hintText, screenPos.x, textY);

        // Reset text alignment/baseline if needed by other drawing code
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
      // =============================================== //
      // ====== END: Added Door Name Text Drawing ====== //
      // =============================================== //

      ctx.restore(); // Corresponds to ctx.save() at the beginning
    }

    /** Helper to get grid coordinates occupied by this furniture. */
    getOccupiedTiles() {
      if (!SHARED_CONFIG)
        return [{ x: Math.round(this.x), y: Math.round(this.y) }];
      const definition =
        this.definition ||
        SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (def) => def.id === this.definitionId
        );
      if (!definition)
        return [{ x: Math.round(this.x), y: Math.round(this.y) }];
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
      this.chatBubble = null;
      this.isPlayer = false; // Set by checkIfPlayer based on gameState.myAvatarId
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
      this.checkIfPlayer(); // Re-check on updates in case myAvatarId changed
      if (dto.name != null) this.name = dto.name;

      // Emote Handling integrated with State Change
      if (dto.state != null) {
        const oldState = this.state;
        const oldEmoteId = this.currentEmoteId;

        // Start new emote if state becomes EMOTING and emoteId is provided
        if (dto.state === SHARED_CONFIG.AVATAR_STATE_EMOTING && dto.emoteId) {
          if (
            oldState !== SHARED_CONFIG.AVATAR_STATE_EMOTING ||
            oldEmoteId !== dto.emoteId
          ) {
            this.currentEmoteId = dto.emoteId;
            const emoteDef =
              SHARED_CONFIG.EMOTE_DEFINITIONS[this.currentEmoteId];
            if (emoteDef) {
              this.emoteEndTime = Date.now() + emoteDef.duration;
              if (!this.isPlayer && emoteDef.sound) playSound(emoteDef.sound); // Play sound for others' emotes
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
      // Handle emote change even if state remains EMOTING
      else if (
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        dto.emoteId &&
        this.currentEmoteId !== dto.emoteId
      ) {
        console.log(`${this.name} switched emote to: ${dto.emoteId}`);
        this.currentEmoteId = dto.emoteId;
        const emoteDef = SHARED_CONFIG.EMOTE_DEFINITIONS[this.currentEmoteId];
        if (emoteDef) this.emoteEndTime = Date.now() + emoteDef.duration;
        if (!this.isPlayer && emoteDef && emoteDef.sound)
          playSound(emoteDef.sound);
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
      // If emoting timer is up, revert state based on current context (sitting/moving/idle)
      if (
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        this.emoteEndTime > 0 &&
        Date.now() > this.emoteEndTime
      ) {
        // Check if still logically sitting based on sittingOnFurniId
        const isSitting =
          this.sittingOnFurniId !== null &&
          gameState.furniture[this.sittingOnFurniId];
        if (isSitting) {
          this.state = SHARED_CONFIG.AVATAR_STATE_SITTING;
        } else if (
          Math.abs(this.x - this.visualX) > 0.1 ||
          Math.abs(this.y - this.visualY) > 0.1
        ) {
          // Check if still moving towards a target
          this.state = SHARED_CONFIG.AVATAR_STATE_WALKING;
        } else {
          // Otherwise, revert to idle
          this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
        }
        this.currentEmoteId = null;
        this.emoteEndTime = 0;
      }
    }

    draw(ctx) {
      if (!this.isVisible || !SHARED_CONFIG || !CLIENT_CONFIG) return;
      const screenPos = getScreenPos(this.visualX, this.visualY);
      const zoom = camera.zoom;
      const bodyWidth = SHARED_CONFIG.TILE_WIDTH_HALF * 0.8 * zoom;
      const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
      const headHeight = totalHeight * 0.3;
      const bodyHeight = totalHeight * 0.7;
      const headWidth = bodyWidth * 0.8;
      const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
      const baseY =
        screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx; // Bottom edge
      const bodyY = baseY - bodyHeight;
      const headY = bodyY - headHeight; // Top edges
      const bodyX = screenPos.x - bodyWidth / 2;
      const headX = screenPos.x - headWidth / 2;

      let isEmotingVisually =
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        this.currentEmoteId;
      let bodyOutline = shadeColor(this.bodyColor, -40);
      if (isEmotingVisually) bodyOutline = "#FFFF00"; // Highlight outline when emoting

      // Adjust body color based on state (slightly darker/lighter)
      let bodyFill = this.bodyColor || CLIENT_CONFIG.AVATAR_SKIN_COLOR;
      if (this.state === SHARED_CONFIG.AVATAR_STATE_SITTING)
        bodyFill = shadeColor(this.bodyColor, -20);
      else if (
        this.state === SHARED_CONFIG.AVATAR_STATE_WALKING ||
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING
      )
        bodyFill = shadeColor(this.bodyColor, 10);

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

      // Draw Eyes (adjust position based on facing direction)
      ctx.fillStyle = CLIENT_CONFIG.AVATAR_EYE_COLOR;
      const eyeSize = Math.max(1.5, 2 * zoom);
      const eyeY = headY + headHeight * 0.4 - eyeSize / 2;
      let eyeCenterX = headX + headWidth / 2;
      let eyeSpacingFactor = 0.25; // Default for S/N
      if (
        this.direction === SHARED_CONFIG.DIRECTION_EAST ||
        this.direction === SHARED_CONFIG.DIRECTION_WEST
      )
        eyeSpacingFactor = 0.1; // Closer for E/W
      // Shift eyes slightly based on N/S component of direction
      if (
        this.direction >= SHARED_CONFIG.DIRECTION_SOUTH_EAST &&
        this.direction <= SHARED_CONFIG.DIRECTION_SOUTH_WEST
      )
        eyeCenterX = headX + headWidth * 0.6;
      else if (
        this.direction >= SHARED_CONFIG.DIRECTION_NORTH_WEST &&
        this.direction <= SHARED_CONFIG.DIRECTION_NORTH_EAST
      )
        eyeCenterX = headX + headWidth * 0.4;
      if (this.direction !== SHARED_CONFIG.DIRECTION_NORTH) {
        // Hide eyes when facing directly away
        const eyeSpacing = headWidth * eyeSpacingFactor;
        ctx.fillRect(eyeCenterX - eyeSpacing, eyeY, eyeSize, eyeSize);
        ctx.fillRect(eyeCenterX + eyeSpacing - eyeSize, eyeY, eyeSize, eyeSize);
      }

      // Draw Name Tag
      ctx.font = `bold ${Math.max(8, 10 * zoom)}px Verdana`;
      ctx.textAlign = "center";
      ctx.lineWidth = Math.max(1, 2 * zoom);
      const nameY = headY - 5 * zoom;
      let nameColor = "white";
      if (this.isAdmin) {
        nameColor = "cyan"; // Admins are cyan
      }
      if (this.isPlayer) {
        nameColor = "yellow"; // Player is yellow (overrides admin color for self)
      }
      ctx.fillStyle = nameColor;
      ctx.strokeStyle = "black";
      ctx.strokeText(this.name, screenPos.x, nameY);
      ctx.fillText(this.name, screenPos.x, nameY);

      // Draw Emote Indicator Bubble
      if (isEmotingVisually) {
        ctx.fillStyle = "rgba(255, 255, 150, 0.85)";
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
        ctx.fillStyle = "#333";
        ctx.textAlign = "center";
        ctx.fillText(emoteText, screenPos.x, emoteY);
      }
    }

    /** Creates and manages the floating chat bubble UI element. */
    say(text) {
      if (!text || !text.trim() || !uiState.bubbleContainer) return;
      this.clearBubble();
      const bubbleId = `bubble-${this.id}-${uiState.nextBubbleId++}`;
      const endTime = Date.now() + CLIENT_CONFIG.CHAT_BUBBLE_DURATION;
      const bubbleElement = document.createElement("div");
      bubbleElement.id = bubbleId;
      bubbleElement.className = "chat-bubble";
      bubbleElement.textContent = text;
      uiState.bubbleContainer.appendChild(bubbleElement);
      this.chatBubble = { id: bubbleId, text, endTime, element: bubbleElement };
      uiState.activeChatBubbles.push(this.chatBubble);
      this.updateChatBubblePosition();
    }
    /** Updates the screen position of the chat bubble based on avatar position. */
    updateChatBubblePosition() {
      if (
        !this.chatBubble ||
        !this.chatBubble.element ||
        !canvas ||
        !SHARED_CONFIG ||
        !CLIENT_CONFIG
      )
        return;
      const screenPos = getScreenPos(this.visualX, this.visualY);
      const zoom = camera.zoom;
      const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
      const headHeight = totalHeight * 0.3;
      const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
      const baseY =
        screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx;
      const bodyY = baseY - totalHeight * 0.7;
      const headY = bodyY - headHeight;
      const bubbleElement = this.chatBubble.element;
      requestAnimationFrame(() => {
        if (!bubbleElement) return;
        const bubbleWidth = bubbleElement.offsetWidth;
        const bubbleHeight = bubbleElement.offsetHeight;
        bubbleElement.style.left = `${screenPos.x - bubbleWidth / 2}px`;
        bubbleElement.style.top = `${headY - bubbleHeight - 10 * zoom}px`;
      });
    }
    /** Removes the current chat bubble UI element. */
    clearBubble() {
      if (this.chatBubble) {
        this.chatBubble.element?.remove();
        uiState.activeChatBubbles = uiState.activeChatBubbles.filter(
          (b) => b.id !== this.chatBubble.id
        );
        this.chatBubble = null;
      }
    }
    /** Checks if a screen point is within the avatar's approximate bounds. */
    containsPoint(screenX, screenY) {
      if (!SHARED_CONFIG || !CLIENT_CONFIG) return false;
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
      // Note: We wait for 'room_state' before the game is fully ready
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
      if (!CLIENT_CONFIG || !state || state.id == null) {
        console.error("Received invalid room state:", state);
        return; // Guard until config loaded and state is valid
      }
      console.log(`Received room state for room: ${state.id}`);

      // --- Full Reset on Room Change/Join ---
      resetLocalState(); // Clear *all* previous state before applying new one

      gameState.currentRoomId = state.id; // Store the new room ID
      gameState.roomLayout = state.layout || [];
      gameState.roomCols = state.cols || 0;
      gameState.roomRows = state.rows || 0;

      // Update UI with room name
      if (uiState.roomNameDisplay)
        uiState.roomNameDisplay.textContent = `Room: ${state.id}`;
      document.title = `ZanyTown - ${state.id}`; // Update browser tab title

      // Create tiles for the new layout
      gameState.clientTiles = [];
      for (let y = 0; y < gameState.roomRows; y++) {
        for (let x = 0; x < gameState.roomCols; x++) {
          const layoutType = gameState.roomLayout[y]?.[x] ?? 0;
          gameState.clientTiles.push(new ClientTile(x, y, layoutType));
        }
      }

      // Process furniture for the new room
      gameState.furniture = {}; // Ensure furniture map is clean
      state.furniture?.forEach((dto) => {
        if (dto && dto.id != null) {
          const newFurni = new ClientFurniture(dto);
          gameState.furniture[dto.id] = newFurni;
        } else {
          console.warn("Received invalid furniture DTO in room_state:", dto);
        }
      });

      // Process avatars for the new room
      gameState.avatars = {}; // Ensure avatar map is clean
      state.avatars?.forEach((dto) => {
        if (dto && dto.id != null) {
          if (gameState.myAvatarId != null && dto.id === gameState.myAvatarId) {
            console.log(
              `[room_state] Processing MY AVATAR DTO (ID: ${dto.id}):`,
              JSON.stringify(dto)
            );
          }

          gameState.avatars[dto.id] = new ClientAvatar(dto);
          // checkIfPlayer will be called when 'your_avatar_id' is received
        } else {
          console.warn("Received invalid avatar DTO in room_state:", dto);
        }
      });

      // Center camera on the new room
      if (canvas && gameState.roomCols > 0 && gameState.roomRows > 0) {
        const cx = gameState.roomCols / 2;
        const cy = gameState.roomRows / 2;
        const cPos = worldToIso(cx, cy);
        camera.x = canvas.width / 2 - cPos.x * camera.zoom;
        camera.y = canvas.height / 3 - cPos.y * camera.zoom;
      }

      logChatMessage(`Entered room: ${state.id}`, true, "info-msg");
      if (uiState.debugDiv)
        uiState.debugDiv.textContent = `Room '${state.id}' loaded.`;

      // User list update will be triggered by the server after this usually
      // If not, uncomment: requestUserListUpdate();
      // Inventory/Currency updates are separate and should persist across rooms unless server resets them.
      populateInventory(); // Refresh inventory display based on existing gameState.inventory
      updateCurrencyDisplay(); // Refresh currency display
    });

    socket.on("your_avatar_id", (id) => {
      console.log("Server assigned my avatar ID:", id);
      gameState.myAvatarId = id;
      // Update isPlayer flag for avatars currently loaded in gameState
      Object.values(gameState.avatars).forEach((av) => av.checkIfPlayer());
      // Request user list for the current room after getting own ID
      requestUserListUpdate();
    });

    // --- Room-Scoped Updates ---
    // These events are now expected to only arrive if the client is in the relevant Socket.IO room
    socket.on("avatar_added", (avatarDTO) => {
      if (
        !avatarDTO ||
        avatarDTO.id == null ||
        avatarDTO.roomId !== gameState.currentRoomId
      )
        return; // Ignore if not for current room
      if (!gameState.avatars[avatarDTO.id]) {
        gameState.avatars[avatarDTO.id] = new ClientAvatar(avatarDTO);
        console.log(
          `Avatar added to current room: ${avatarDTO.name} (ID: ${avatarDTO.id})`
        );
        gameState.avatars[avatarDTO.id].checkIfPlayer(); // Check if it's the player
        requestUserListUpdate(); // Update list for current room
      } else {
        // Should not happen often if server logic is correct
        gameState.avatars[avatarDTO.id].update(avatarDTO);
        console.warn(
          `Received 'avatar_added' for existing ID ${avatarDTO.id} in current room. Updated.`
        );
      }
    });
    socket.on("avatar_removed", (data) => {
      if (!data || data.id == null) return;
      // Remove ONLY if the avatar exists in the current room's gameState
      const removed = gameState.avatars[data.id];
      if (removed) {
        console.log(
          `Avatar removed from current room: ${removed.name} (${data.id})`
        );
        removed.clearBubble();
        delete gameState.avatars[data.id];
        requestUserListUpdate(); // Update list for current room
        // If profile panel target matches, hide it
        if (uiState.profilePanel?.dataset.targetId === data.id.toString()) {
          hideProfilePanel();
        }
      }
      // No warning if not found, it might be for a room we already left
    });
    socket.on("user_list_update", (users) => {
      // Server should only send list for the room the client is in
      updateUserListPanel(users || []);
    });

    socket.on("chat_message", (data) => {
      // Assume chat messages are broadcast appropriately by the server (e.g., to the correct room)
      if (!data || !data.text) return;
      // Find avatar in current room's state
      const avatar = data.avatarId ? gameState.avatars[data.avatarId] : null;
      const name = avatar ? avatar.name : data.avatarName || "Unknown"; // Use name from DTO if avatar not found locally yet
      const msg = `${name}: ${data.text}`;
      let className = data.className || "";
      const receivedIsAdmin = data.isAdmin || false; // Check for admin flag from server

      // Show bubble for player/NPC chat if avatar exists locally
      if (avatar) {
        avatar.say(data.text);
        if (avatar.id !== gameState.myAvatarId) playSound("chat");
      } else if (data.avatarName === "Server") {
        // Server messages are global? Or room specific? Assume global for now.
        playSound("chat");
      } else {
        // Chat from someone not (yet) rendered in this room?
        playSound("chat"); // Play sound anyway
      }

      if (receivedIsAdmin && avatar) {
        className += " admin-msg";
      }

      // Log message to chat window
      logChatMessage(msg, avatar?.id === gameState.myAvatarId, className);
    });

    socket.on("furni_added", (furniDTO) => {
      if (!furniDTO || furniDTO.id == null) return;
      // Add only if it's for the current room (assume server doesn't send cross-room yet)
      // OR if the DTO contains the correct roomId (safer)
      // if (furniDTO.roomId !== gameState.currentRoomId) return; // Requires server to send roomId in furni DTO

      let isNew = false;
      if (!gameState.furniture[furniDTO.id]) {
        const newFurni = new ClientFurniture(furniDTO); // Constructor handles door props now
        gameState.furniture[furniDTO.id] = newFurni;
        isNew = true;
      } else {
        gameState.furniture[furniDTO.id].update(furniDTO);
        console.warn(
          `Received 'furni_added' for existing ID ${furniDTO.id} in current room. Updated.`
        );
      }
      if (isNew) {
        playSound("place");
      }
    });
    socket.on("furni_removed", (data) => {
      if (!data || data.id == null) return;
      // Remove only if present in current room state
      const removedId = data.id;
      const removed = gameState.furniture[removedId];
      if (removed) {
        console.log(
          `Furniture removed from current room: ${removed.definition?.name} (ID: ${removedId})`
        );
        // Deselect or hide recolor panel if the removed item was targeted
        if (uiState.editMode.selectedFurnitureId === removedId)
          setSelectedFurniture(null);
        if (uiState.activeRecolorFurniId === removedId) hideRecolorPanel();
        delete gameState.furniture[removedId];
      }
      // No warning if not found, might be from another room
    });

    // Action Failed - global feedback
    socket.on("action_failed", (data) => {
      console.warn(`Action Failed: ${data.action}. Reason: ${data.reason}`);
      logChatMessage(
        `Action failed: ${data.reason || "Unknown"}`,
        true,
        "error-msg"
      );
    });
    socket.on("connect_error", (err) => {
      console.error(`Connection Error: ${err.message}`);
      logChatMessage(`Connection Error: ${err.message}`, true, "error-msg");
      if (
        err.message.includes("Invalid token") ||
        err.message.includes("Authentication error")
      ) {
        // Auth failed, clear token and redirect to login
        localStorage.removeItem("authToken");
        window.location.href = "/login.html";
      }
      if (uiState.debugDiv)
        uiState.debugDiv.textContent = `Conn Err: ${err.message}`;
      resetLocalState();
    });

    // Optional: Custom event for auth errors during data loading
    socket.on("auth_error", (message) => {
      console.error("Authentication Error:", message);
      logChatMessage(message, true, "error-msg");
      localStorage.removeItem("authToken");
      window.location.href = "/login.html";
    });

    socket.on("force_disconnect", (reason) => {
      console.warn("Forcefully disconnected:", reason);
      logChatMessage(`Disconnected: ${reason}`, true, "error-msg");
      localStorage.removeItem("authToken"); // Clear token
      socket.disconnect(); // Ensure socket is closed client-side
      // No immediate redirect, maybe show message on current page
      // Or redirect after a delay: setTimeout(() => window.location.href = '/login.html', 3000);
      alert(`Disconnected: ${reason}`); // Simple alert
      window.location.href = "/login.html"; // Immediate redirect
    });

    // Update Handlers (minimal DTOs, assume for current room)
    socket.on("avatar_update", (avatarDTO) => {
      if (!avatarDTO || avatarDTO.id == null) return;
      // Update only if avatar exists in current room state
      const avatar = gameState.avatars[avatarDTO.id];
      if (avatar) {
        avatar.update(avatarDTO);
      } else {
        // Warn if update received for avatar not in current room state (might happen briefly during room change)
        // console.warn(`Update for avatar ${avatarDTO.id} not currently in room ${gameState.currentRoomId}`);
      }
      // If name changed, update user list entry IF the avatar is in the current room list
      if (uiState.userListContent && avatarDTO.name && avatar) {
        const entry = uiState.userListContent.querySelector(
          `[data-userid="${avatarDTO.id}"]`
        );
        if (entry && entry.textContent !== avatarDTO.name) {
          requestUserListUpdate(); // Request a refresh of the current room's list
        }
      }
    });
    socket.on("furni_updated", (updateData) => {
      if (!updateData || updateData.id == null) return;
      // Update only if furniture exists in current room state
      const furni = gameState.furniture[updateData.id];
      if (furni) {
        const oldState = furni.state;
        furni.update(updateData);
        // Play sound if state changed and item is usable
        if (
          updateData.state != null &&
          oldState !== updateData.state &&
          furni.definition?.canUse
        ) {
          playSound("use");
        }
      } else {
        // console.warn(`Received 'furni_updated' for unknown/other room ID ${updateData.id}`);
      }
    });

    // Global State Updates (Inventory, Currency, Profile)
    socket.on("inventory_update", (inventoryData) => {
      console.log("Received inventory update:", inventoryData);
      gameState.inventory = inventoryData || {};
      populateInventory();
    });
    socket.on("currency_update", (data) => {
      if (data && typeof data.currency === "number") {
        console.log("Received currency update:", data.currency);
        gameState.myCurrency = data.currency;
        updateCurrencyDisplay();
        updateShopButtonStates();
      }
    });
    socket.on("show_profile", (profileData) => {
      if (!profileData || !profileData.id) return;
      showProfilePanel(profileData);
    }); // Profile is global
  }

  // --- Game Loop ---
  function gameLoop(timestamp) {
    if (!CLIENT_CONFIG) {
      requestAnimationFrame(gameLoop);
      return;
    } // Don't run until config is loaded

    const deltaTimeMs = timestamp - lastTimestamp;
    lastTimestamp = timestamp;
    const cappedDeltaTimeMs = Math.min(deltaTimeMs, 100); // Cap delta to prevent large jumps
    const interpolationFactor =
      1.0 -
      Math.pow(
        1.0 - CLIENT_CONFIG.INTERPOLATION_FACTOR,
        cappedDeltaTimeMs / (1000 / 60)
      );

    // --- Update Phase ---
    handleHeldKeys();
    updateMouseWorldPosition();
    updateHighlights(); // Operates on current room tiles/furniture
    // Interpolate only objects in the current room
    Object.values(gameState.avatars).forEach((a) =>
      a.interpolate(interpolationFactor)
    );
    Object.values(gameState.furniture).forEach((f) =>
      f.interpolate(interpolationFactor)
    );
    updateChatBubbles(timestamp); // Handles bubble expiry and position updates for visible avatars

    // --- Draw Phase ---
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#003366";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Collect all drawable objects FOR THE CURRENT ROOM and sort by draw order
      const drawables = [
        ...gameState.clientTiles,
        ...Object.values(gameState.furniture),
        ...Object.values(gameState.avatars),
      ];
      drawables.sort((a, b) => a.drawOrder - b.drawOrder);
      drawables.forEach((obj) => obj.draw(ctx));

      drawPlacementGhost(ctx); // Draw ghost overlay after main scene
    }

    // --- UI Updates ---
    updateDebugInfo();
    updateUICursor(); // Update cursor based on mode/drag state
    requestAnimationFrame(gameLoop);
  }

  // --- Input Handling ---
  function setupInputListeners() {
    if (!canvas || !CLIENT_CONFIG) {
      console.error("Canvas or CLIENT_CONFIG not ready for input listeners.");
      return;
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    canvas.addEventListener("click", handleCanvasClick);
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("wheel", handleMouseWheel, { passive: false }); // Need active for preventDefault
    canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // Disable right-click menu on canvas

    // UI Button listeners (remain mostly global)
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
    uiState.recolorBtn?.addEventListener("click", handleRecolorFurniClick); // Opens recolor panel
    uiState.profileCloseBtn?.addEventListener("click", hideProfilePanel);

    // Recolor Panel Listeners
    uiState.recolorCloseBtn?.addEventListener("click", hideRecolorPanel);
    uiState.recolorResetBtn?.addEventListener("click", () => {
      if (uiState.activeRecolorFurniId) {
        console.log(
          `Requesting reset color for ${uiState.activeRecolorFurniId}`
        );
        socket?.emit("request_recolor_furni", {
          furniId: uiState.activeRecolorFurniId,
          colorHex: "",
        }); // Empty string signals reset
        hideRecolorPanel();
      }
    });

    // Chat input listener
    uiState.chatInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault(); // Prevent default form submission/newline
        const text = uiState.chatInput.value.trim();
        if (text && socket?.connected) {
          console.log("Client sending chat/command:", text);
          // Let server handle command processing and routing
          socket.emit("send_chat", text);
          uiState.chatInput.value = "";
        }
      }
    });
    // Add shop button listeners here if not already done in init
    uiState.openShopBtn?.addEventListener("click", showShopPanel);
    uiState.shopCloseBtn?.addEventListener("click", hideShopPanel);

    document.getElementById("logout-btn")?.addEventListener("click", () => {
      localStorage.removeItem("authToken");
      socket?.disconnect(); // Disconnect the socket
      window.location.href = "/login.html"; // Redirect to login
    });
  }

  function handleKeyDown(event) {
    if (!CLIENT_CONFIG) return;
    // Ignore most keys if chat input is focused, except Enter (handled separately)
    if (document.activeElement === uiState.chatInput && event.key !== "Enter")
      return;

    inputState.keysPressed[event.key] = true;
    const keyLower = event.key.toLowerCase();

    // --- Hotkeys (ignore if chat focused) ---
    if (document.activeElement !== uiState.chatInput) {
      if (keyLower === "e") {
        event.preventDefault();
        toggleEditMode();
      }
      // Arrow keys for panning (preventDefault to stop page scroll)
      if (
        ["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(keyLower)
      ) {
        event.preventDefault();
      }

      if (uiState.isEditMode) {
        // Pickup selected furniture
        if (
          (keyLower === "delete" || keyLower === "backspace") &&
          uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI
        ) {
          event.preventDefault();
          handlePickupFurniClick();
        }
        // Rotate placement ghost or selected furniture
        if (keyLower === "r") {
          event.preventDefault();
          if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
            uiState.editMode.placementRotation = rotateDirection(
              uiState.editMode.placementRotation,
              2
            ); // Rotate ghost 90deg clockwise
          } else if (
            uiState.editMode.state ===
              CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
            uiState.editMode.selectedFurnitureId
          ) {
            socket?.emit("request_rotate_furni", {
              furniId: uiState.editMode.selectedFurnitureId,
            }); // Request server rotation
          }
        }
      }
    }
  }
  function handleKeyUp(event) {
    inputState.keysPressed[event.key] = false;
  }
  /** Processes held keys for camera panning. */
  function handleHeldKeys() {
    if (!CLIENT_CONFIG) return;
    let dx = 0;
    let dy = 0;
    if (inputState.keysPressed["ArrowLeft"])
      dx += CLIENT_CONFIG.CAMERA_PAN_SPEED;
    if (inputState.keysPressed["ArrowRight"])
      dx -= CLIENT_CONFIG.CAMERA_PAN_SPEED;
    if (inputState.keysPressed["ArrowUp"]) dy += CLIENT_CONFIG.CAMERA_PAN_SPEED;
    if (inputState.keysPressed["ArrowDown"])
      dy -= CLIENT_CONFIG.CAMERA_PAN_SPEED;
    if (dx !== 0 || dy !== 0) {
      moveCamera(dx, dy);
    }
  }

  function handleCanvasClick(event) {
    if (!CLIENT_CONFIG || event.target !== canvas || !gameState.currentRoomId)
      return; // Added room check
    // Distinguish between a click and the end of a drag
    const dragThreshold = 5;
    const dx = Math.abs(event.clientX - inputState.lastMousePos.x);
    const dy = Math.abs(event.clientY - inputState.lastMousePos.y);
    if (inputState.isDragging && (dx > dragThreshold || dy > dragThreshold))
      return; // Don't process click if it was a drag

    const gridPos = inputState.currentMouseGridPos;
    const screenPos = inputState.currentMouseScreenPos;
    if (!isValidClientTile(gridPos.x, gridPos.y)) return; // Clicked outside valid room area

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
      case CLIENT_CONFIG.EDIT_STATE_PLACING: // Attempt to place selected inventory item
        if (
          uiState.editMode.placementValid &&
          uiState.editMode.selectedInventoryItemId
        ) {
          if (
            gameState.inventory[uiState.editMode.selectedInventoryItemId] > 0
          ) {
            // Double check inventory count client-side
            console.log(
              `Requesting placement from inventory: ${uiState.editMode.selectedInventoryItemId} at ${gridPos.x},${gridPos.y}`
            );
            socket?.emit("request_place_furni", {
              definitionId: uiState.editMode.selectedInventoryItemId,
              x: gridPos.x,
              y: gridPos.y,
              rotation: uiState.editMode.placementRotation,
            });
          } else {
            logChatMessage(
              "You don't seem to have that item anymore.",
              true,
              "error-msg"
            );
            setSelectedInventoryItem(null);
          }
        } else {
          logChatMessage("Cannot place item there.", true, "error-msg");
        }
        break;
      case CLIENT_CONFIG.EDIT_STATE_NAVIGATE: // Select furniture or use usable furniture
      case CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI:
        // Find furniture in current room state
        const clickedFurniture = getTopmostFurnitureAtScreen(
          screenPos.x,
          screenPos.y
        );
        if (clickedFurniture) {
          if (clickedFurniture.definition?.canUse) {
            // If usable, use it immediately (don't select)
            socket?.emit("request_use_furni", { furniId: clickedFurniture.id });
            playSound("use");
            setSelectedFurniture(null);
          } else {
            // Otherwise, toggle selection
            if (uiState.editMode.selectedFurnitureId === clickedFurniture.id)
              setSelectedFurniture(null); // Click again to deselect
            else setSelectedFurniture(clickedFurniture.id); // Select clicked furniture
          }
        } else {
          // Clicked empty space
          setSelectedFurniture(null); // Deselect any selected furniture
          hideRecolorPanel(); // Hide recolor panel if empty space clicked
        }
        break;
    }
  }

  /** Handles clicks when NOT in Edit Mode (Navigate/Sit/Use/Profile/Door). */
  function handleNavigateModeClick(gridPos, screenPos) {
    if (!socket?.connected || !SHARED_CONFIG || !gameState.currentRoomId)
      return;
    const myAvatar = gameState.avatars[gameState.myAvatarId];

    // 1. Check for click on another Avatar (request profile)
    const clickedAvatar = getAvatarAtScreen(screenPos.x, screenPos.y); // Checks current room avatars
    if (clickedAvatar) {
      if (clickedAvatar.id !== gameState.myAvatarId) {
        console.log(
          `Requesting profile for ${clickedAvatar.name} (ID: ${clickedAvatar.id})`
        );
        socket.emit("request_profile", { avatarId: clickedAvatar.id });
      } else {
        logChatMessage(
          `You clicked yourself (${clickedAvatar.name}).`,
          true,
          "info-msg"
        );
      }
      return; // Don't process further if an avatar was clicked
    }

    // 2. Check for click on own tile while sitting (request stand)
    if (myAvatar?.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
      const playerGridPos = snapToGrid(myAvatar.x, myAvatar.y);
      if (gridPos.x === playerGridPos.x && gridPos.y === playerGridPos.y) {
        console.log("Requesting stand up from current location.");
        socket.emit("request_stand");
        return;
      }
    }

    // 3. Check for click on Furniture (Use/Sit/Door)
    const clickedFurniture = getTopmostFurnitureAtScreen(
      screenPos.x,
      screenPos.y
    ); // Checks current room furniture
    if (clickedFurniture) {
      // --- Door Check ---
      if (clickedFurniture.isDoor && clickedFurniture.targetRoomId) {
        console.log(
          `Requesting change room via door ${clickedFurniture.id} to ${clickedFurniture.targetRoomId}`
        );
        // Get definition to potentially find target coords defined there
        const doorDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (d) => d.id === clickedFurniture.definitionId
        );
        const doorData = { targetRoomId: clickedFurniture.targetRoomId };
        // Include target coords if defined in config (server uses these for spawn)
        if (doorDef && doorDef.targetX != null && doorDef.targetY != null) {
          doorData.targetX = doorDef.targetX;
          doorData.targetY = doorDef.targetY;
        }
        socket.emit("request_change_room", doorData);
        return; // Stop processing if it was a door click
      }
      // --- End Door Check ---

      if (clickedFurniture.definition?.canUse) {
        console.log(`Requesting use for furni ID: ${clickedFurniture.id}`);
        socket.emit("request_use_furni", { furniId: clickedFurniture.id });
        playSound("use");
        return;
      }
      if (clickedFurniture.definition?.canSit) {
        console.log(
          `Requesting sit on ${clickedFurniture.definition.name} (ID: ${clickedFurniture.id})`
        );
        socket.emit("request_sit", { furniId: clickedFurniture.id });
        return;
      }
    }

    // 4. Clicked on floor tile (Navigate) - check walkability in current room
    if (isClientWalkable(gridPos.x, gridPos.y)) {
      console.log(`Requesting move to: ${gridPos.x}, ${gridPos.y}`);
      socket.emit("request_move", { x: gridPos.x, y: gridPos.y });
    } else {
      logChatMessage("Cannot walk there.", true, "error-msg");
    } // Clicked unwalkable tile
  }

  function handleMouseDown(event) {
    // Middle mouse or Right mouse button for panning
    if (event.button === 1 || event.button === 2) {
      inputState.isDragging = true;
      inputState.lastMousePos = { x: event.clientX, y: event.clientY };
      gameContainer?.classList.add("dragging");
      event.preventDefault();
    } else if (event.button === 0) {
      // Left mouse down - record position for click vs drag check
      inputState.lastMousePos = { x: event.clientX, y: event.clientY };
      inputState.isDragging = false;
    }
  }
  function handleMouseUp(event) {
    if (inputState.isDragging) {
      inputState.isDragging = false;
      gameContainer?.classList.remove("dragging");
    }
  }
  function handleMouseLeave(event) {
    if (inputState.isDragging) {
      inputState.isDragging = false;
      gameContainer?.classList.remove("dragging");
    }
  } // Stop dragging if mouse leaves canvas

  function handleMouseMove(event) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    inputState.currentMouseScreenPos = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }; // Update screen position relative to canvas
    if (inputState.isDragging) {
      // Pan camera if dragging
      const dx = event.clientX - inputState.lastMousePos.x;
      const dy = event.clientY - inputState.lastMousePos.y;
      moveCamera(dx, dy);
      inputState.lastMousePos = { x: event.clientX, y: event.clientY };
    }
    updateMouseWorldPosition(); // Update world/grid position continuously
  }
  /** Updates cached world and grid coordinates based on current screen mouse position. */
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
    event.preventDefault(); // Prevent page scrolling
    const zoomFactor =
      event.deltaY < 0
        ? CLIENT_CONFIG.ZOOM_FACTOR
        : 1 / CLIENT_CONFIG.ZOOM_FACTOR; // Zoom in/out based on scroll direction
    const rect = canvas.getBoundingClientRect();
    const pivotX = event.clientX - rect.left; // Zoom centered on mouse cursor
    const pivotY = event.clientY - rect.top;
    changeZoom(zoomFactor, pivotX, pivotY);
  }
  /** Handles click on the "Pick Up" button in inventory panel. */
  function handlePickupFurniClick() {
    if (!CLIENT_CONFIG || !gameState.currentRoomId) return;
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId
    ) {
      console.log(
        `Requesting pickup for furni ID: ${uiState.editMode.selectedFurnitureId}`
      );
      socket?.emit("request_pickup_furni", {
        furniId: uiState.editMode.selectedFurnitureId,
      });
    } else {
      console.warn("Pickup button clicked but conditions not met.");
    }
  }
  /** Handles click on the "Recolor" button in inventory panel (shows the panel). */
  function handleRecolorFurniClick() {
    if (!CLIENT_CONFIG || !gameState.currentRoomId) return;
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId
    ) {
      const furni = gameState.furniture[uiState.editMode.selectedFurnitureId]; // Check current room furniture
      if (furni && furni.canRecolor) {
        console.log(
          `Opening recolor panel for ${furni.definition?.name} (ID: ${furni.id})`
        );
        showRecolorPanel(furni.id);
      } else {
        console.warn(
          "Recolor button clicked, but selected furniture cannot be recolored or not found."
        );
        hideRecolorPanel();
      }
    } else {
      console.warn("Recolor button clicked, but conditions not met.");
      hideRecolorPanel();
    }
  }

  // --- Client-side Checks / Interaction Helpers (Operate on current room state) ---
  /** Checks if grid coordinates are within current room bounds. */
  function isValidClientTile(x, y) {
    return (
      gameState.currentRoomId != null &&
      x >= 0 &&
      x < gameState.roomCols &&
      y >= 0 &&
      y < gameState.roomRows
    );
  }
  /** Gets the layout type (0=floor, 1=wall, etc.) of a tile in the current room. */
  function getTileLayoutType(x, y) {
    return isValidClientTile(x, y) ? gameState.roomLayout[y]?.[x] : null;
  }
  /** Checks if a tile is walkable in current room (valid floor/alt floor and not blocked by solid furniture). */
  function isClientWalkable(x, y) {
    const gx = Math.round(x);
    const gy = Math.round(y);
    if (!isValidClientTile(gx, gy)) return false;
    const t = getTileLayoutType(gx, gy);
    if (t === 1 || t === "X") return false;
    return !isClientOccupiedBySolid(gx, gy);
  } // Checks current room furniture
  /** Checks if a tile is occupied by solid (non-walkable, non-flat) furniture in current room. */
  function isClientOccupiedBySolid(gridX, gridY) {
    return Object.values(gameState.furniture).some(
      (f) =>
        f.definition &&
        !f.definition.isWalkable &&
        !f.definition.isFlat &&
        f.getOccupiedTiles().some((t) => t.x === gridX && t.y === gridY)
    );
  }
  /** Finds the topmost avatar at a given screen coordinate in the current room. */
  function getAvatarAtScreen(screenX, screenY) {
    const candidates = Object.values(gameState.avatars).filter((a) =>
      a.containsPoint(screenX, screenY)
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.drawOrder - a.drawOrder);
    return candidates[0];
  }
  /** Finds the topmost furniture at a given screen coordinate in the current room (approximate check). */
  function getTopmostFurnitureAtScreen(screenX, screenY) {
    if (!SHARED_CONFIG) return null;
    const candidates = Object.values(gameState.furniture).filter((f) => {
      if (!f.definition) return false;
      const sPos = getScreenPos(f.visualX, f.visualY);
      const approxR =
        (SHARED_CONFIG.TILE_WIDTH_HALF * (f.definition.width || 1) +
          SHARED_CONFIG.TILE_HEIGHT_HALF * (f.definition.height || 1)) *
        camera.zoom *
        0.6;
      const dx = sPos.x - screenX;
      const dy = sPos.y - screenY;
      return dx * dx + dy * dy < approxR * approxR;
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.drawOrder - a.drawOrder);
    return candidates[0];
  }

  // --- UI Update Functions ---
  function updateDebugInfo() {
    if (!uiState.debugDiv || !SHARED_CONFIG || !CLIENT_CONFIG) return;
    const player = gameState.avatars[gameState.myAvatarId]; // Find player in current room state
    const pGrid = player
      ? snapToGrid(player.visualX, player.visualY)
      : { x: "?", y: "?" };
    const pState = player ? player.state : "N/A";
    const pDir = player ? player.direction : "?";
    const mGrid = inputState.currentMouseGridPos;
    const furniCount = Object.keys(gameState.furniture).length; // Count furniture in current room
    const avatarCount = Object.keys(gameState.avatars).length; // Count avatars in current room
    const inventoryCount = Object.keys(gameState.inventory).reduce(
      (sum, key) => sum + (gameState.inventory[key] || 0),
      0
    );
    const currentRoom = gameState.currentRoomId || "N/A";

    // Construct Edit Mode details string
    let editDetails = " Off";
    if (uiState.isEditMode) {
      // ... (Edit mode details based on gameState.furniture in current room) ...
      editDetails = ` St: ${uiState.editMode.state}`;
      if (
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
        uiState.editMode.selectedInventoryItemId
      ) {
        const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (d) => d.id === uiState.editMode.selectedInventoryItemId
        );
        editDetails += ` Inv: ${def?.name || "?"} Rot:${
          uiState.editMode.placementRotation
        } V:${uiState.editMode.placementValid ? "Y" : "N"}`;
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
    // Construct Tile Info string (for current room)
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
      ); // Check current room furniture
      stack.sort((a, b) => b.visualZ - a.visualZ);
      const topFurni = stack[0];
      const stackHeight = getClientStackHeightAt(hx, hy); // Checks current room furniture
      tileInfo = ` Tile(${hx},${hy}) L:${tLayout ?? "?"} ${
        topFurni
          ? `Top:${topFurni.definition?.name}(Z:${topFurni.visualZ.toFixed(
              2
            )}) `
          : ""
      }StackZ:${stackHeight.toFixed(2)}`;
    }

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
  function logChatMessage(message, isSelf = false, className = "") {
    if (!uiState.chatLogDiv || !CLIENT_CONFIG) return;
    const p = document.createElement("p");
    p.textContent = message;
    if (isSelf) p.classList.add("self-msg");
    if (className) p.classList.add(className);

    if (
      message.toLowerCase().includes("[admin]") ||
      className === "admin-msg"
    ) {
      p.classList.add("adming-msg-log");
    }

    // Auto-scroll only if already near the bottom
    const isScrolledBottom =
      uiState.chatLogDiv.scrollHeight - uiState.chatLogDiv.clientHeight <=
      uiState.chatLogDiv.scrollTop + 1;
    uiState.chatMessages.push(p);
    // Limit chat log length
    if (uiState.chatMessages.length > CLIENT_CONFIG.MAX_CHAT_LOG_MESSAGES) {
      uiState.chatMessages.shift().remove();
    }
    uiState.chatLogDiv.appendChild(p);
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
        bubble.element?.remove();
        // Find owner among currently loaded avatars
        const owner = Object.values(gameState.avatars).find(
          (a) => a.chatBubble?.id === bubble.id
        );
        if (owner) owner.chatBubble = null; // Clear reference on owner avatar
        return false; // Remove from active list
      }
      return true; // Keep in active list
    });
    // Update position for remaining bubbles (only for avatars in current room)
    uiState.activeChatBubbles.forEach((bubble) => {
      const owner = Object.values(gameState.avatars).find(
        (a) => a.chatBubble?.id === bubble.id
      );
      owner?.updateChatBubblePosition();
    });
  }
  /** Clears and redraws the inventory UI based on gameState.inventory. */
  function populateInventory() {
    // Inventory is global
    if (!uiState.inventoryItemsDiv || !SHARED_CONFIG || !CLIENT_CONFIG) return;
    uiState.inventoryItemsDiv.innerHTML = "";
    const inventory = gameState.inventory;
    const ownedItemIds = Object.keys(inventory);
    if (ownedItemIds.length === 0) {
      uiState.inventoryItemsDiv.innerHTML = "<p><i>Inventory empty.</i></p>";
      if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING)
        setSelectedInventoryItem(null);
      return;
    }
    ownedItemIds.sort(); // Sort alphabetically by ID for consistent order
    ownedItemIds.forEach((itemId) => {
      const quantity = inventory[itemId];
      if (quantity <= 0) return; // Skip items with zero quantity
      const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === itemId
      );
      if (!def) {
        console.warn(`Inventory item ${itemId} has no definition.`);
        return;
      }
      const itemDiv = document.createElement("div");
      itemDiv.className = "inventory-item";
      itemDiv.dataset.itemId = def.id;
      const previewSpan = document.createElement("span");
      previewSpan.className = "item-preview";
      previewSpan.style.backgroundColor = def.color || "#8B4513";
      itemDiv.appendChild(previewSpan); // Show base color preview
      itemDiv.appendChild(
        document.createTextNode(` ${def.name} (x${quantity})`)
      );
      itemDiv.title = `${def.name} (${def.width}x${def.height})${
        def.canSit ? " (Sittable)" : ""
      }${def.stackable ? " (Stackable)" : ""}${def.canUse ? " (Usable)" : ""}${
        def.canRecolor ? " (Recolorable)" : ""
      }`; // Tooltip with details
      // Click listener to select item for placement in edit mode
      itemDiv.addEventListener("click", () => {
        if (uiState.isEditMode) {
          if (uiState.editMode.selectedInventoryItemId === def.id)
            setSelectedInventoryItem(null); // Click again to deselect
          else setSelectedInventoryItem(def.id); // Select this item
        } else {
          // If not in edit mode, nudge the user
          logChatMessage(
            "Enable Edit Mode (E key) to place furniture.",
            true,
            "info-msg"
          );
          const editBtn = document.getElementById(
            CLIENT_CONFIG.TOGGLE_EDIT_BTN_ID
          );
          if (editBtn) {
            editBtn.style.transform = "scale(1.1)";
            editBtn.style.transition = "transform 0.1s ease-out";
            setTimeout(() => {
              editBtn.style.transform = "scale(1)";
            }, 150);
          } // Visual nudge
        }
      });
      uiState.inventoryItemsDiv.appendChild(itemDiv);
    });
    updateInventorySelection(); // Apply 'selected' class if needed
  }
  /** Updates the visual selection state (CSS class) of inventory items. */
  function updateInventorySelection() {
    if (!uiState.inventoryItemsDiv || !CLIENT_CONFIG) return;
    uiState.inventoryItemsDiv
      .querySelectorAll(".inventory-item")
      .forEach((item) => {
        item.classList.toggle(
          "selected",
          uiState.isEditMode &&
            item.dataset.itemId === uiState.editMode.selectedInventoryItemId
        );
      });
  }
  /** Enables/disables the "Pick Up" button based on edit mode state. */
  function updatePickupButtonState() {
    if (uiState.pickupFurniBtn && CLIENT_CONFIG) {
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
    gameContainer.classList.remove("dragging", "edit-mode-cursor");
    gameContainer.style.cursor = "";
    if (inputState.isDragging) {
      gameContainer.classList.add("dragging");
    } else if (uiState.isEditMode) {
      gameContainer.classList.add("edit-mode-cursor");
    } else {
      gameContainer.style.cursor = "grab";
    }
  }
  /** Shows/hides and enables/disables the "Recolor" button based on selected furniture. */
  function updateRecolorButtonState() {
    if (uiState.recolorBtn && CLIENT_CONFIG) {
      let enabled = false;
      if (
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        uiState.editMode.selectedFurnitureId
      ) {
        const furni = gameState.furniture[uiState.editMode.selectedFurnitureId];
        enabled = furni?.canRecolor || false;
      }
      uiState.recolorBtn.disabled = !enabled;
      uiState.recolorBtn.style.display = enabled ? "inline-block" : "none";
    }
  }
  /** Updates the currency display UI element. */
  function updateCurrencyDisplay() {
    if (uiState.currencyDisplay) {
      uiState.currencyDisplay.textContent = `Gold: ${gameState.myCurrency}`;
    }
  }

  function showShopPanel() {
    // console.log("Attempting to show Shop Panel..."); // Optional debug log
    // Ensure the panel element exists and config is loaded (needed for populating)
    if (!uiState.shopPanel) {
      console.error(
        "Shop panel element not found (uiState.shopPanel is null)."
      );
      return;
    }
    if (!SHARED_CONFIG || !SHARED_CONFIG.SHOP_CATALOG) {
      console.error("Shop config (SHARED_CONFIG.SHOP_CATALOG) not loaded yet.");
      // Maybe add a loading indicator to the panel if desired
      uiState.shopPanel.innerHTML = "<p><i>Loading shop data...</i></p>";
      uiState.shopPanel.style.display = "block"; // Show loading state
      return;
    }

    populateShopPanel(); // Populate content before showing
    uiState.shopPanel.style.display = "block"; // Set display to block
    // console.log("Shop Panel display set to block."); // Optional debug log
  }

  function hideShopPanel() {
    // console.log("Attempting to hide Shop Panel..."); // Optional debug log
    if (uiState.shopPanel) {
      uiState.shopPanel.style.display = "none"; // Set display to none
      // console.log("Shop Panel display set to none."); // Optional debug log
    } else {
      console.error(
        "Shop panel element not found (uiState.shopPanel is null) when trying to hide."
      );
    }
  }

  function populateShopPanel() {
    // Ensure dependencies are ready
    if (
      !uiState.shopItemsDiv ||
      !SHARED_CONFIG ||
      !SHARED_CONFIG.SHOP_CATALOG ||
      !SHARED_CONFIG.FURNITURE_DEFINITIONS
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

    sortedCatalog.forEach((shopEntry) => {
      const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (def) => def.id === shopEntry.itemId
      );
      if (!definition) {
        console.warn(
          `Shop item '${shopEntry.itemId}' found in catalog but not in definitions. Skipping.`
        );
        return; // Skip items without definitions
      }

      const itemDiv = document.createElement("div");
      itemDiv.className = "shop-item";

      // Item Info (Preview, Name)
      const infoDiv = document.createElement("div");
      infoDiv.className = "shop-item-info";

      const previewSpan = document.createElement("span");
      previewSpan.className = "item-preview"; // Reuse inventory style
      previewSpan.style.backgroundColor = definition.color || "#8B4513"; // Use definition color
      infoDiv.appendChild(previewSpan);

      const nameSpan = document.createElement("span");
      nameSpan.className = "shop-item-name";
      nameSpan.textContent = definition.name || shopEntry.itemId; // Use definition name
      nameSpan.title = `${definition.name} (${definition.width}x${definition.height})`; // Add tooltip
      infoDiv.appendChild(nameSpan);

      itemDiv.appendChild(infoDiv);

      // Price
      const priceSpan = document.createElement("span");
      priceSpan.className = "shop-item-price";
      priceSpan.textContent = `${shopEntry.price} G`; // Display price with 'G' for Gold
      itemDiv.appendChild(priceSpan);

      // Buy Button
      const buyButton = document.createElement("button");
      buyButton.className = "buy-btn";
      buyButton.textContent = "Buy";
      buyButton.dataset.itemId = shopEntry.itemId; // Store item ID for the click handler
      buyButton.dataset.price = shopEntry.price; // Store price for updateShopButtonStates

      buyButton.addEventListener("click", () => {
        if (!socket || !socket.connected) {
          console.warn("Cannot buy item: Socket not connected.");
          logChatMessage("Not connected to server.", true, "error-msg");
          return;
        }
        // Disable button temporarily to prevent double clicks
        buyButton.disabled = true;
        // Emit buy request to server
        console.log(`Requesting buy item: ${shopEntry.itemId}`);
        socket.emit("request_buy_item", { itemId: shopEntry.itemId });
        // Re-enable button after a short delay OR let updateShopButtonStates handle it
        setTimeout(() => {
          if (buyButton) updateShopButtonStates();
        }, 300); // Re-evaluate state shortly after
      });

      itemDiv.appendChild(buyButton);

      uiState.shopItemsDiv.appendChild(itemDiv);
    });

    updateShopButtonStates(); // Set initial button disabled state after populating
  }

  function updateShopButtonStates() {
    // Ensure dependencies are ready
    if (!uiState.shopItemsDiv) {
      // console.warn("Cannot update shop button states: shopItemsDiv not found.");
      return;
    }

    const buyButtons = uiState.shopItemsDiv.querySelectorAll("button.buy-btn");
    // console.log(`Updating ${buyButtons.length} shop buttons. Currency: ${gameState.myCurrency}`); // Optional debug log

    buyButtons.forEach((button) => {
      const price = parseInt(button.dataset.price, 10); // Get price stored on the button
      if (!isNaN(price)) {
        button.disabled = gameState.myCurrency < price; // Disable if player has less currency than price
        // Add/remove a class for visual styling of disabled state if needed
        button.classList.toggle("cannot-afford", gameState.myCurrency < price);
      } else {
        console.warn(
          `Button for item ${button.dataset.itemId} has invalid price data.`
        );
        button.disabled = true; // Disable if price data is missing/invalid
      }
    });
  }

  /** Updates the user list UI based on data for the current room. */
  function updateUserListPanel(users) {
    if (!uiState.userListContent || !uiState.userListPanel) return;
    uiState.userListContent.innerHTML = ""; // Clear previous list
    const roomTitle = gameState.currentRoomId
      ? `Users in ${gameState.currentRoomId}`
      : "Users Online";
    // Update the panel header
    const header = uiState.userListPanel.querySelector("h4");
    if (header) header.textContent = roomTitle;

    if (!users || users.length === 0) {
      uiState.userListContent.innerHTML = "<li><i>Nobody here...</i></li>";
      return;
    }
    users
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((user) => {
        const li = document.createElement("li");
        li.textContent = user.name;
        li.dataset.userid = user.id;
        // Highlight self based on global myAvatarId
        if (user.id === gameState.myAvatarId) {
          li.classList.add("self-user");
        }
        // Click requests global profile
        li.addEventListener("click", () => {
          if (user.id !== gameState.myAvatarId && socket?.connected) {
            socket.emit("request_profile", { avatarId: user.id });
          }
        });
        uiState.userListContent.appendChild(li);
      });
  }
  /** Sends a request for the user list (server now knows which room). */
  function requestUserListUpdate() {
    if (socket?.connected) {
      socket.emit("request_user_list");
    }
  }
  /** Displays the profile panel with data received from the server. */
  function showProfilePanel(profileData) {
    if (!uiState.profilePanel || !uiState.profileContent) return;
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
    }</p><div class="profile-actions"></div>`;
    uiState.profilePanel.dataset.targetId = profileData.id;
    uiState.profilePanel.style.display = "block";
  }
  /** Hides the profile panel. */
  function hideProfilePanel() {
    if (uiState.profilePanel) {
      uiState.profilePanel.style.display = "none";
      uiState.profilePanel.dataset.targetId = "";
      uiState.profileContent.innerHTML = "";
    }
  }

  // --- Recolor Panel Functions (Operate on selected furniture in current room) ---
  function showRecolorPanel(furniId) {
    const furni = gameState.furniture[furniId]; // Check current room furniture
    const panel = uiState.recolorPanel;
    const swatchesDiv = uiState.recolorSwatchesDiv;
    const itemNameP = uiState.recolorItemNameP;
    if (
      !furni ||
      !panel ||
      !swatchesDiv ||
      !itemNameP ||
      !furni.canRecolor ||
      !SHARED_CONFIG
    ) {
      hideRecolorPanel();
      return;
    } // Ensure valid state
    uiState.activeRecolorFurniId = furniId;
    itemNameP.textContent = `Item: ${furni.definition?.name || "Unknown"}`;
    swatchesDiv.innerHTML = ""; // Clear previous swatches
    // Populate swatches from SHARED_CONFIG
    SHARED_CONFIG.VALID_RECOLOR_HEX.forEach((hex) => {
      const swatch = document.createElement("div");
      swatch.className = "recolor-swatch";
      swatch.style.backgroundColor = hex;
      swatch.title = hex;
      swatch.dataset.colorHex = hex;
      swatch.addEventListener("click", () => {
        const colorToSend = swatch.dataset.colorHex;
        console.log(
          `Requesting recolor for ${uiState.activeRecolorFurniId} to ${colorToSend}`
        );
        socket?.emit("request_recolor_furni", {
          furniId: uiState.activeRecolorFurniId,
          colorHex: colorToSend,
        });
        hideRecolorPanel(); // Close panel after selection
      });
      swatchesDiv.appendChild(swatch);
    });
    panel.style.display = "block";
  }
  function hideRecolorPanel() {
    if (uiState.recolorPanel) {
      uiState.recolorPanel.style.display = "none";
    }
    uiState.activeRecolorFurniId = null;
  }

  // --- Camera Controls ---
  function moveCamera(dx, dy) {
    camera.x += dx;
    camera.y += dy;
  }
  /** Changes camera zoom level, optionally centered on a pivot point. */
  function changeZoom(
    factor,
    pivotX = canvas?.width / 2,
    pivotY = canvas?.height / 2
  ) {
    if (!canvas || !CLIENT_CONFIG) return;
    const worldPosBefore = isoToWorld(pivotX, pivotY); // Get world coords under pivot before zoom
    const oldZoom = camera.zoom;
    const newZoom = Math.max(
      CLIENT_CONFIG.MIN_ZOOM,
      Math.min(CLIENT_CONFIG.MAX_ZOOM, camera.zoom * factor)
    ); // Apply zoom limits
    if (newZoom === oldZoom) return; // No change
    camera.zoom = newZoom;
    // Get screen coords of the same world point *after* applying only the zoom change
    const screenPosAfterZoomOnly = getScreenPos(
      worldPosBefore.x,
      worldPosBefore.y
    );
    // Adjust camera pan (camera.x, camera.y) to keep the pivot point stationary on screen
    camera.x -= screenPosAfterZoomOnly.x - pivotX;
    camera.y -= screenPosAfterZoomOnly.y - pivotY;
  }

  // --- Edit Mode Management (Operates on current room state) ---
  /** Sets the current edit mode state and handles transitions between states. */
  function setEditState(newState) {
    if (!CLIENT_CONFIG || uiState.editMode.state === newState) return;
    const oldState = uiState.editMode.state;
    uiState.editMode.state = newState;
    // Clear placement/selection state when exiting relevant modes
    if (
      oldState === CLIENT_CONFIG.EDIT_STATE_PLACING &&
      newState !== CLIENT_CONFIG.EDIT_STATE_PLACING
    ) {
      uiState.editMode.placementRotation = 0;
      uiState.editMode.placementValid = false;
      setSelectedInventoryItem(null);
    }
    if (
      oldState === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      newState !== CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI
    ) {
      setSelectedFurniture(null);
    }
    // Update UI elements affected by edit state
    updatePickupButtonState();
    updateRecolorButtonState();
    updateInventorySelection();
    updateUICursor();
  }
  /** Sets the currently selected item from inventory for placement. */
  function setSelectedInventoryItem(definitionId) {
    // Inventory is global
    if (
      !CLIENT_CONFIG ||
      uiState.editMode.selectedInventoryItemId === definitionId
    )
      return;
    uiState.editMode.selectedInventoryItemId = definitionId;
    uiState.editMode.placementRotation = 0; // Reset rotation on new selection
    if (definitionId) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_PLACING);
    } // Enter placing mode
    else if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    } // Exit placing mode if deselected
    updateInventorySelection();
  }
  /** Sets the currently selected furniture item on the floor in the current room. */
  function setSelectedFurniture(furnitureId) {
    if (
      !CLIENT_CONFIG ||
      !gameState.currentRoomId ||
      uiState.editMode.selectedFurnitureId === furnitureId
    )
      return;
    // Clear selection state on previously selected item (in current room)
    if (
      uiState.editMode.selectedFurnitureId &&
      gameState.furniture[uiState.editMode.selectedFurnitureId]
    ) {
      gameState.furniture[
        uiState.editMode.selectedFurnitureId
      ].isSelected = false;
    }
    uiState.editMode.selectedFurnitureId = furnitureId;
    // Apply selection state to newly selected item (in current room)
    if (furnitureId && gameState.furniture[furnitureId]) {
      gameState.furniture[furnitureId].isSelected = true;
      setEditState(CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI);
    } else {
      // If deselected or item invalid
      uiState.editMode.selectedFurnitureId = null;
      hideRecolorPanel(); // Hide panel if deselected
      if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
        setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
      } // Return to navigate state
    }
    updatePickupButtonState();
    updateRecolorButtonState(); // Update button states based on selection
  }
  /** Toggles Edit Mode on/off and resets relevant states. */
  function toggleEditMode() {
    if (!CLIENT_CONFIG) return;
    uiState.isEditMode = !uiState.isEditMode;
    const btn = document.getElementById(CLIENT_CONFIG.TOGGLE_EDIT_BTN_ID);
    if (btn) {
      btn.textContent = `Room Edit (${uiState.isEditMode ? "On" : "Off"})`;
      btn.classList.toggle("active", uiState.isEditMode);
    }
    if (!uiState.isEditMode) {
      // When turning OFF
      clearAllHighlights();
      setSelectedFurniture(null);
      setSelectedInventoryItem(null);
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
      hideRecolorPanel();
    } else {
      // When turning ON
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Start in navigate state within edit mode
    }
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
    clearAllHighlights(); // Reset highlights each frame for current room tiles/furniture
    const gridPos = inputState.currentMouseGridPos;
    if (!isValidClientTile(gridPos.x, gridPos.y)) {
      // Mouse outside current room
      gameState.highlightedTile = null;
      if (
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING
      ) {
        uiState.editMode.placementValid = false;
      }
      return;
    }
    gameState.highlightedTile = { x: gridPos.x, y: gridPos.y };

    if (uiState.isEditMode) {
      // Edit Mode: Placing State - Highlight placement area and check validity
      if (
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
        uiState.editMode.selectedInventoryItemId
      ) {
        const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (d) => d.id === uiState.editMode.selectedInventoryItemId
        );
        uiState.editMode.placementValid = definition
          ? isClientPlacementValid(definition, gridPos.x, gridPos.y)
          : false; // Uses current room state
        const color = uiState.editMode.placementValid
          ? CLIENT_CONFIG.FURNI_PLACE_HIGHLIGHT_COLOR
          : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR; // Yellow/Red highlight
        const ghostTiles = definition
          ? ClientFurniture.prototype.getOccupiedTiles.call({
              x: gridPos.x,
              y: gridPos.y,
              definition: definition,
            })
          : [gridPos];
        ghostTiles.forEach((tp) => setTileHighlight(tp.x, tp.y, color)); // Highlights current room tiles
      } else {
        // Edit Mode: Navigate/Selected State - Highlight hovered furniture/tile
        const hoveredF = getTopmostFurnitureAtScreen(
          inputState.currentMouseScreenPos.x,
          inputState.currentMouseScreenPos.y
        ); // Checks current room furniture
        // Highlight hovered furniture (if not the selected one) or the tile under mouse
        if (hoveredF && hoveredF.id !== uiState.editMode.selectedFurnitureId) {
          hoveredF
            .getOccupiedTiles()
            .forEach((tp) =>
              setTileHighlight(
                tp.x,
                tp.y,
                CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
              )
            );
        } else if (!hoveredF && gameState.highlightedTile) {
          setTileHighlight(
            gameState.highlightedTile.x,
            gameState.highlightedTile.y,
            CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
          );
        }
      }
    } else {
      // Navigate Mode - Highlight walkable tiles or interactable furniture in current room
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
      const hoveredF = getTopmostFurnitureAtScreen(
        inputState.currentMouseScreenPos.x,
        inputState.currentMouseScreenPos.y
      );
      // Highlight doors OR usable/sittable items
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
    // Final check if highlighted tile became invalid
    if (
      gameState.highlightedTile &&
      !isValidClientTile(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y
      )
    )
      gameState.highlightedTile = null;
  }
  /** Client-side check if placing an item at a location is valid based on current room state. */
  function isClientPlacementValid(definition, gridX, gridY) {
    if (!definition || !SHARED_CONFIG || !gameState.currentRoomId) return false;
    const tempFurniProto = { x: gridX, y: gridY, definition: definition };
    const occupiedTiles =
      ClientFurniture.prototype.getOccupiedTiles.call(tempFurniProto);
    // Check each tile the furniture would occupy in current room
    for (const tile of occupiedTiles) {
      const gx = tile.x;
      const gy = tile.y;
      if (!isValidClientTile(gx, gy)) return false; // Out of bounds
      const tileType = getTileLayoutType(gx, gy);
      if (tileType === 1 || tileType === "X") return false; // Wall or hole
      // If placing non-flat item, check for solid, non-stackable items below in current room
      if (!definition.isFlat && !definition.isWalkable) {
        const stack = Object.values(gameState.furniture).filter(
          (f) => Math.round(f.visualX) === gx && Math.round(f.visualY) === gy
        );
        const topItemOnThisTile = stack.sort(
          (a, b) => b.visualZ - a.visualZ
        )[0];
        if (topItemOnThisTile && !topItemOnThisTile.definition?.stackable)
          return false; // Directly blocked by non-stackable
        if (isClientOccupiedBySolid(gx, gy)) {
          // Check general solid occupation in current room
          // Need to verify the blocker is actually non-stackable (topItem check might miss intermediate blockers)
          const solidBlocker = stack.find(
            (f) =>
              !f.definition?.isWalkable &&
              !f.definition?.isFlat &&
              !f.definition?.stackable
          );
          if (solidBlocker) return false;
        }
      }
    }
    // Check item directly below base tile (gridX, gridY) in current room
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
    // Check max stack height using current room furniture state
    const estimatedZ =
      getClientStackHeightAt(gridX, gridY) + (definition.zOffset || 0);
    if (estimatedZ >= SHARED_CONFIG.MAX_STACK_Z) return false;
    return true; // All checks passed
  }
  /** Sets the highlight color for a specific client tile instance in the current room. */
  function setTileHighlight(x, y, color) {
    const tile = gameState.clientTiles.find((t) => t.x === x && t.y === y);
    if (tile) tile.highlight = color;
  }
  /** Clears all tile highlights and furniture selection in the current room (unless in selected state). */
  function clearAllHighlights() {
    if (!CLIENT_CONFIG || !gameState.currentRoomId) return;
    gameState.clientTiles.forEach((t) => (t.highlight = null));
    // Only clear selection visual if not currently in selected state
    if (uiState.editMode.state !== CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
      Object.values(gameState.furniture).forEach((f) => (f.isSelected = false));
    } else {
      // Ensure only the actually selected item remains highlighted
      Object.values(gameState.furniture).forEach((f) => {
        f.isSelected = f.id === uiState.editMode.selectedFurnitureId;
      });
    }
  }
  /** Draws the semi-transparent ghost image of the item being placed in the current room. */
  function drawPlacementGhost(ctx) {
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
    if (!definition) return;

    const gridX = gameState.highlightedTile.x;
    const gridY = gameState.highlightedTile.y;
    const screenPos = getScreenPos(gridX, gridY);
    const zoom = camera.zoom;
    const alpha = uiState.editMode.placementValid ? 0.6 : 0.3; // More transparent if invalid
    const color = uiState.editMode.placementValid
      ? definition.color
      : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR; // Use definition color or red
    const estimatedBaseZ = getClientStackHeightAt(gridX, gridY); // Checks current room furniture
    const ghostZ = estimatedBaseZ + (definition.zOffset || 0); // Calculate Z based on items below
    const zOffsetPx = ghostZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom; // Convert Z to pixel offset

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
    // Draw shape based on definition (flat diamond or box)
    if (definition.isFlat) {
      const hW = SHARED_CONFIG.TILE_WIDTH_HALF * definition.width * zoom;
      const hH = SHARED_CONFIG.TILE_HEIGHT_HALF * definition.height * zoom;
      ctx.moveTo(screenPos.x, screenPos.y - hH - zOffsetPx);
      ctx.lineTo(screenPos.x + hW, screenPos.y - zOffsetPx);
      ctx.lineTo(screenPos.x, screenPos.y + hH - zOffsetPx);
      ctx.lineTo(screenPos.x - hW, screenPos.y - zOffsetPx);
      ctx.closePath();
    } else if (definition.id === "door_simple") {
      // Draw ghost door
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
      ctx.rect(drawX, drawY, baseDrawWidth, baseDrawHeight);
    }
    ctx.fill();
    ctx.stroke();

    // Draw rotation indicator arrow if not flat
    if (!definition.isFlat) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.translate(screenPos.x, screenPos.y - zOffsetPx); // Move origin to tile center (adjusted for Z)
      const angleRad = (uiState.editMode.placementRotation / 4) * Math.PI; // Convert direction (0-7) to angle
      ctx.rotate(angleRad);
      const arrowL = SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.8;
      const arrowW = arrowL * 0.6; // Arrow dimensions based on zoom
      ctx.beginPath();
      ctx.moveTo(arrowL * 0.6, 0);
      ctx.lineTo(0, -arrowW / 2);
      ctx.lineTo(0, arrowW / 2);
      ctx.closePath(); // Draw triangle pointing right (before rotation)
      ctx.fill();
    }
    ctx.restore();
  }
  /** Client-side estimation of stack height at a grid coordinate based on current room's visual Z positions. */
  function getClientStackHeightAt(gridX, gridY) {
    if (!SHARED_CONFIG || !gameState.currentRoomId) return 0;
    // Filter furniture in current room
    const stack = Object.values(gameState.furniture).filter(
      (f) => Math.round(f.visualX) === gridX && Math.round(f.visualY) === gridY
    );
    let highestStackableTopZ = 0.0; // Start at floor level Z
    stack.forEach((furni) => {
      if (!furni.definition) return;
      const itemStackContrib =
        (furni.definition.stackHeight || 0) *
        SHARED_CONFIG.DEFAULT_STACK_HEIGHT;
      // Top surface Z = item's base Z + its contribution (unless flat)
      const itemTopZ =
        furni.visualZ + (furni.definition.isFlat ? 0 : itemStackContrib);
      if (furni.definition.stackable) {
        // Only surfaces of stackable items count
        highestStackableTopZ = Math.max(highestStackableTopZ, itemTopZ);
      }
    });
    return highestStackableTopZ;
  }

  // --- Initialization (Client) ---
  async function initClient() {
    const token = localStorage.getItem("authToken");
    if (!token) {
      // No token found, redirect to login page
      console.log("No auth token found, directing to login.");
      window.location.href = "/login.html";
      return;
    }

    console.log("Initializing Client...");

    // Fetch Configuration First - Crucial step before defining CLIENT_CONFIG
    try {
      console.log("Fetching server configuration from /api/config...");
      const response = await fetch("/api/config");
      if (!response.ok)
        throw new Error(
          `Failed to fetch config: ${response.status} ${response.statusText}`
        );
      SHARED_CONFIG = await response.json();
      if (
        !SHARED_CONFIG ||
        typeof SHARED_CONFIG !== "object" ||
        !SHARED_CONFIG.FURNITURE_DEFINITIONS
      )
        throw new Error("Invalid or empty configuration received.");
      console.log("Server configuration loaded successfully.");

      // Define CLIENT_CONFIG now that SHARED_CONFIG is available
      CLIENT_CONFIG = {
        CANVAS_ID: "gameCanvas",
        GAME_CONTAINER_ID: "game-container",
        DEBUG_DIV_ID: "coords-debug",
        CHAT_INPUT_ID: "chat-input",
        CHAT_LOG_ID: "chat-log",
        BUBBLE_CONTAINER_ID: "chat-bubbles-container",
        INVENTORY_ITEMS_ID: "inventory-items",
        PICKUP_FURNI_BTN_ID: "pickup-furni-btn",
        RECOLOR_FURNI_BTN_ID: "recolor-furni-btn",
        PLAYER_CURRENCY_ID: "player-currency",
        ROOM_NAME_DISPLAY_ID: "room-name-display", // Optional ID for room name display
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
        ZOOM_FACTOR: 1.1,
        CAMERA_PAN_SPEED: 15,
        CHAT_BUBBLE_DURATION: 4000,
        MAX_CHAT_LOG_MESSAGES: 50,
        EMOTE_DURATION: 2500,
        AVATAR_SKIN_COLOR: "#F0DDBB",
        AVATAR_EYE_COLOR: "#000000",
        INTERPOLATION_FACTOR: 0.25,
        VISUAL_Z_FACTOR: SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5,
        // Highlight Colors
        FURNI_PLACE_HIGHLIGHT_COLOR: "rgba(255, 255, 0, 0.5)",
        FURNI_SELECT_HIGHLIGHT_COLOR: "rgba(0, 255, 255, 0.7)",
        FURNI_HOVER_HIGHLIGHT_COLOR: "rgba(0, 200, 255, 0.3)",
        TILE_EDIT_HIGHLIGHT_COLOR: "rgba(255, 0, 0, 0.4)",
        // Edit Mode States
        EDIT_STATE_NAVIGATE: "navigate",
        EDIT_STATE_PLACING: "placing",
        EDIT_STATE_SELECTED_FURNI: "selected_furni",
      };
      // Set initial edit state using the constant
      uiState.editMode.state = CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
    } catch (error) {
      console.error("FATAL: Failed to load server configuration:", error);
      alert(
        `Error loading game configuration: ${error.message}\nPlease try refreshing the page.`
      );
      const debugDiv = document.getElementById("coords-debug");
      if (debugDiv)
        debugDiv.innerHTML = `<span style="color:red; font-weight:bold;">FATAL ERROR: Could not load config.<br>${error.message}</span>`;
      return; // Stop initialization
    }

    // Get DOM Elements
    canvas = document.getElementById(CLIENT_CONFIG.CANVAS_ID);
    ctx = canvas?.getContext("2d");
    gameContainer = document.getElementById(CLIENT_CONFIG.GAME_CONTAINER_ID);
    if (!canvas || !ctx || !gameContainer) {
      console.error("FATAL: Canvas/container not found!");
      alert("Error initializing game elements.");
      return;
    }

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

    ctx.imageSmoothingEnabled = false; // Keep pixels sharp
    resetLocalState(); // Initialize state variables *before* connecting

    logChatMessage("Welcome to ZanyTown!", true, "info-msg");

    // Initialize Sounds
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
    Object.values(SHARED_CONFIG.EMOTE_DEFINITIONS).forEach((emoteDef) => {
      const soundName = emoteDef.sound;
      if (soundName && !sounds[soundName]) {
        try {
          let ext = ".wav";
          if (soundName === "dance") ext = ".mp3";
          sounds[soundName] = new Audio(`sounds/${soundName}${ext}`);
          sounds[soundName].volume = 0.6;
          console.log(`Attempted to load sound: sounds/${soundName}${ext}`);
        } catch (e) {
          console.warn(`Sound load failed: ${soundName}`);
          sounds[soundName] = null;
        }
      }
    });

    setupInputListeners();
    hideProfilePanel();
    hideRecolorPanel();
    hideShopPanel(); // Ensure panels hidden initially
    updatePickupButtonState();
    updateRecolorButtonState();
    updateCurrencyDisplay();

    // Connect to Server
    try {
      logChatMessage("Connecting to server...", true, "info-msg");
      const token = localStorage.getItem("authToken"); // Get token again here
      if (!token) {
        // Added check here just before connection attempt
        console.log("No token found before socket connection, redirecting.");
        logChatMessage(
          "Authentication token missing. Redirecting to login.",
          true,
          "error-msg"
        );
        window.location.href = "/login.html";
        return; // Stop initialization if token missing here
      }
      // --- FIX: Pass the 'token' variable to the auth object ---
      socket = io({
        auth: { token: token }, // Correctly pass the token variable
      });
      setupSocketListeners(); // Setup listeners *before* connection fires events
    } catch (err) {
      console.error("Failed to initialize Socket.IO:", err);
      logChatMessage("Error connecting. Check console.", true, "error-msg");
      if (uiState.debugDiv) uiState.debugDiv.textContent = "Connection Error";
      return;
    }

    console.log(
      "Client Initialized. Waiting for server connection and room state..."
    );
    lastTimestamp = performance.now();
    requestAnimationFrame(gameLoop); // Start the main loop
  }

  /**
   * Resets the local client state, typically called on room change or disconnect.
   * Clears room-specific data but preserves global data like inventory/currency.
   */
  function resetLocalState() {
    console.log("Resetting local client room state.");

    // Clear room-specific game objects
    Object.values(gameState.avatars).forEach((a) => a.clearBubble()); // Clear any lingering bubbles
    gameState.furniture = {};
    gameState.avatars = {};
    gameState.clientTiles = [];
    gameState.highlightedTile = null;

    // Clear layout/room info
    gameState.roomLayout = [];
    gameState.roomCols = 0;
    gameState.roomRows = 0;
    gameState.currentRoomId = null; // Reset current room ID

    // --- Reset UI State related to room selection/placement ---
    // Clear active chat bubbles (as avatars are cleared)
    uiState.activeChatBubbles.forEach((b) => b.element?.remove());
    uiState.activeChatBubbles = [];
    // Reset edit mode state, keep edit mode toggle status (isEditMode) as is?
    // Or force edit mode off on room change? Let's force it off for simplicity.
    uiState.isEditMode = false; // Turn off edit mode on room change
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
    uiState.activeRecolorFurniId = null;

    // --- Update UI Elements to reflect reset ---
    updatePickupButtonState(); // Disable pickup button
    updateRecolorButtonState(); // Hide/disable recolor button
    updateInventorySelection(); // Deselect inventory item visually
    updateUICursor(); // Reset cursor
    hideProfilePanel(); // Hide panels tied to selection/context
    hideRecolorPanel();
    // hideShopPanel(); // Keep shop panel open if it was open? Or close? Close for now.
    hideShopPanel();

    const editBtn = document.getElementById(CLIENT_CONFIG?.TOGGLE_EDIT_BTN_ID);
    if (editBtn) {
      editBtn.textContent = `Room Edit (Off)`;
      editBtn.classList.remove("active");
    }

    // Clear user list explicitly and reset header
    if (uiState.userListContent)
      uiState.userListContent.innerHTML = "<li><i>Joining room...</i></li>";
    const userListHeader = uiState.userListPanel?.querySelector("h4");
    if (userListHeader) userListHeader.textContent = "Users Online";

    // Update window/tab title and room display
    document.title = "ZanyTown - Connecting...";
    if (uiState.roomNameDisplay)
      uiState.roomNameDisplay.textContent = "Room: Connecting...";

    // Keep inventory/currency display as is, they are persistent
    // populateInventory(); // No need to repopulate unless inventory changes
    // updateCurrencyDisplay(); // No need to update unless currency changes
  }

  // --- Start Client Initialization on DOM Load ---
  document.addEventListener("DOMContentLoaded", initClient);
})(); // End of IIFE wrapper
