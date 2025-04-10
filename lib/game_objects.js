"use strict";

const { SHARED_CONFIG, SERVER_CONFIG } = require("./config");
const { rotateDirection: rotateDirectionFunc } = require("./utils"); // Import directly

// --- Base class for server-side game objects ---
class ServerGameObject {
  // --- NEW: Simple static counter for RUNTIME IDs (resets on server restart) ---
  // Primarily used for objects that don't need DB persistence, like Avatars.
  static _runtimeIdCounter = 0;

  /**
   * Creates a new ServerGameObject.
   * @param {number} x - Initial X coordinate.
   * @param {number} y - Initial Y coordinate.
   * @param {number} [z=0] - Initial Z coordinate.
   * @param {string | number | null} [persistentId=null] - A persistent identifier (e.g., MongoDB _id string). If null, a runtime ID is generated.
   */
  constructor(x, y, z = 0, persistentId = null) {
    // Basic check if config was loaded during require phase - Keep this constructor check
    if (!SHARED_CONFIG || !SERVER_CONFIG) {
      throw new Error(
        "Configuration not loaded before creating ServerGameObject."
      );
    }
    // If a persistentId is provided, use it.
    // Otherwise, generate a new RUNTIME ID using the simple counter.
    this.id = persistentId ?? ServerGameObject._runtimeIdCounter++;
    this.x = x; // Authoritative position X
    this.y = y; // Authoritative position Y
    this.z = z; // Authoritative position Z
    // No longer managing global persistent nextId here
  }

  /**
   * Basic Data Transfer Object for sending minimal state to clients.
   * Ensures ID is sent as a string.
   * No config check needed here.
   */
  toDTO() {
    return {
      id: String(this.id), // Always send ID as string
      x: this.x,
      y: this.y,
      z: this.z,
    };
  }
}

// --- Represents furniture items on the server (uses persistent DB ID) ---
class ServerFurniture extends ServerGameObject {
  /**
   * Creates a new ServerFurniture instance.
   * @param {string} definitionId - The ID from FURNITURE_DEFINITIONS.
   * @param {number} x - X coordinate.
   * @param {number} y - Y coordinate.
   * @param {number} z - Z coordinate.
   * @param {number} [rotation=0] - Initial rotation (0-7).
   * @param {string} dbId - The persistent MongoDB _id string for this furniture item. **Required**.
   * @param {string | null} [ownerId=null] - The persistent User _id string of the owner, or null.
   * @param {string | null} [initialState=null] - Initial state ('on', 'off').
   * @param {string | null} [initialColorOverride=null] - Initial custom color hex.
   */
  constructor(
    definitionId,
    x,
    y,
    z,
    rotation = 0,
    dbId, // Renamed from id, now mandatory DB _id string
    ownerId = null,
    initialState = null,
    initialColorOverride = null
  ) {
    // --- Keep rigorous constructor checks ---
    if (!SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
      throw new Error(
        "SHARED_CONFIG.FURNITURE_DEFINITIONS not available when creating ServerFurniture."
      );
    }
    const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (def) => def.id === definitionId
    );
    if (!definition) {
      throw new Error(`Invalid furniture definition ID: ${definitionId}`);
    }
    // --- DB ID is now required for persistent furniture ---
    if (!dbId) {
      throw new Error(
        "ServerFurniture requires a persistent database ID (dbId)."
      );
    }
    // --- End Constructor Check ---

    // Pass the MongoDB _id (dbId) as the persistentId to the base constructor
    super(x, y, z, dbId); // Sets this.id = dbId

    // Room ID needs to be set externally (e.g., by ServerRoom when loading/adding)
    this.roomId = null;

    // --- Definition Properties ---
    // Assign properties based on definition (guaranteed to exist here)
    this.definitionId = definitionId;
    this.name = definition.name;
    this.width = definition.width || 1;
    this.height = definition.height || 1;
    this.isWalkable = definition.isWalkable || false;
    this.isFlat = definition.isFlat || false;
    this.stackable =
      definition.stackable !== undefined ? definition.stackable : !this.isFlat;
    this.stackHeight = definition.stackHeight ?? (this.isFlat ? 0 : 1.0);
    this.zOffset = definition.zOffset || 0;
    this.canRecolor = definition.canRecolor || false;

    // --- Interaction Properties ---
    this.canSit = definition.canSit || false;
    // Config use OK here, config guaranteed to exist if constructor passed
    this.sitDir = definition.sitDir ?? SHARED_CONFIG.DIRECTION_SOUTH;
    this.sitHeightOffset = definition.sitHeightOffset || 0.1;
    this.canUse = definition.canUse || false;
    this.isToggle = definition.isToggle || false;

    // --- Door Properties ---
    this.isDoor = definition.isDoor || false;
    this.targetRoomId = definition.targetRoomId || null;
    this.targetX = definition.targetX;
    this.targetY = definition.targetY;

    // --- Instance Properties ---
    this.rotation = rotateDirectionFunc(0, rotation);
    this.ownerId = ownerId; // User ObjectId string or null
    this.state = initialState ?? definition.defaultState ?? null;
    this.colorOverride = initialColorOverride || null;
  }

  /**
   * Data Transfer Object for clients. Includes persistent ID as string.
   * No config check needed here - relies on properties set in constructor.
   */
  toDTO() {
    const dto = {
      ...super.toDTO(), // Includes id (string), x, y, z
      definitionId: this.definitionId,
      rotation: this.rotation,
    };
    if (this.canUse) dto.state = this.state;
    if (this.colorOverride) dto.colorOverride = this.colorOverride;
    if (this.isDoor) {
      dto.isDoor = true;
      dto.targetRoomId = this.targetRoomId;
    }
    dto.ownerId = this.ownerId ? String(this.ownerId) : null; // Explicitly convert to string or null
    return dto;
  }

  /**
   * Generates an object suitable for saving/updating this furniture item in the DB.
   * Excludes the _id itself, as that's the document key. Requires this.roomId to be set.
   * No config check needed.
   */
  toDBSaveObject() {
    if (this.roomId === null) {
      console.warn(
        `Attempted to generate DB save object for furniture ${this.id} without roomId set!`
      );
    }
    return {
      roomId: this.roomId,
      definitionId: this.definitionId,
      x: this.x,
      y: this.y,
      z: this.z,
      rotation: this.rotation,
      ownerId: this.ownerId, // Store the User ObjectId string (or null)
      state: this.state,
      colorOverride: this.colorOverride,
    };
  }

  /**
   * Calculates the grid tiles occupied by this furniture.
   * No config check needed here.
   */
  getOccupiedTiles() {
    const tiles = [];
    const startX = Math.round(this.x);
    const startY = Math.round(this.y);
    // Use instance properties (width, height) set in constructor
    const halfW = Math.floor((this.width - 1) / 2);
    const halfH = Math.floor((this.height - 1) / 2);

    for (let dx = -halfW; dx < this.width - halfW; dx++) {
      for (let dy = -halfH; dy < this.height - halfH; dy++) {
        tiles.push({ x: startX + dx, y: startY + dy });
      }
    }
    return tiles.length > 0 ? tiles : [{ x: startX, y: startY }];
  }

  /**
   * Calculates the grid tile an avatar should stand on to interact.
   * No config check needed here - uses properties set in constructor.
   */
  getInteractionTile() {
    // Read directly from SHARED_CONFIG is fine, constructor guaranteed it exists
    const baseFacingDir = this.sitDir ?? SHARED_CONFIG.DIRECTION_SOUTH;
    const facingDir = rotateDirectionFunc(baseFacingDir, this.rotation);
    const interactionDir = rotateDirectionFunc(facingDir, 4); // 180 degrees

    let dx = 0,
      dy = 0;
    if (interactionDir === 0 || interactionDir === 1 || interactionDir === 7)
      dy = -1;
    if (interactionDir === 3 || interactionDir === 4 || interactionDir === 5)
      dy = 1;
    if (interactionDir === 1 || interactionDir === 2 || interactionDir === 3)
      dx = 1;
    if (interactionDir === 5 || interactionDir === 6 || interactionDir === 7)
      dx = -1;

    return { x: Math.round(this.x) + dx, y: Math.round(this.y) + dy };
  }

  /**
   * Handles the 'use' action. Updates in-memory state and returns changes for DB/broadcast.
   * Minimal config check reasonable for fetching the definition again.
   * @param {ServerAvatar} avatar - The initiating avatar.
   * @param {ServerRoom} room - The room context for Z calculation.
   * @returns {{ changed: boolean, updatePayload: object | null }}
   */
  use(avatar, room) {
    const result = { changed: false, updatePayload: null };
    // Check only necessary capabilities
    if (!this.canUse || this.isDoor) {
      return result;
    }

    // Re-fetch definition using the ID stored on the instance for robustness
    // Constructor already guaranteed SHARED_CONFIG.FURNITURE_DEFINITIONS exists
    const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === this.definitionId
    );
    // This check is good defense if definition somehow became invalid later, though unlikely
    if (!definition) {
      console.error(
        `ServerFurniture.use: Definition ${this.definitionId} not found in SHARED_CONFIG!`
      );
      return result;
    }

    const oldState = this.state;
    const oldZ = this.z;

    // Toggle state if applicable
    if (this.isToggle) {
      this.state = this.state === "on" ? "off" : "on";
      if (this.state !== oldState) {
        result.changed = true;
        result.updatePayload = { state: this.state };
      }
    }

    // Recalculate Z Position
    const baseZ = room.getStackHeightAt(
      Math.round(this.x),
      Math.round(this.y),
      this.id
    );
    // Use the fetched definition here
    const stateZOffset =
      this.state === "on" && definition.id === "light_simple" ? 0.01 : 0;
    const newZ = baseZ + (definition.zOffset || 0) + stateZOffset;

    if (Math.abs(this.z - newZ) > 0.001) {
      this.z = newZ;
      result.changed = true;
      // Add Z to the update payload, merging if state already changed
      result.updatePayload = { ...(result.updatePayload || {}), z: this.z };
    }

    return result;
  }

  /**
   * Changes the furniture's color override. Updates in-memory state and returns changes.
   * Minimal config check reasonable here for VALID_RECOLOR_HEX.
   * @param {string | null} hexColor - New hex color or null/"" to reset.
   * @returns {{ changed: boolean, updatePayload: object | null }}
   */
  setColorOverride(hexColor) {
    const result = { changed: false, updatePayload: null };
    if (!this.canRecolor) return result;

    // Check config needed for validation exists (constructor guaranteed base SHARED_CONFIG)
    if (!SHARED_CONFIG?.VALID_RECOLOR_HEX) {
      console.error(
        "SHARED_CONFIG.VALID_RECOLOR_HEX not available during ServerFurniture.setColorOverride()"
      );
      return result; // Return unchanged
    }

    const effectiveColor =
      hexColor === null || hexColor === "" ? null : hexColor.toUpperCase();

    if (
      effectiveColor !== null &&
      !SHARED_CONFIG.VALID_RECOLOR_HEX.includes(effectiveColor)
    ) {
      console.warn(
        `Attempted to set invalid color ${effectiveColor} on ${this.name}`
      );
      return result; // Return unchanged
    }

    if (this.colorOverride === effectiveColor) return result; // No change

    this.colorOverride = effectiveColor;
    result.changed = true;
    result.updatePayload = { colorOverride: this.colorOverride }; // Payload includes new value (could be null)
    return result;
  }
} // End ServerFurniture Class

// --- Represents player avatars on the server (uses runtime ID) ---
class ServerAvatar extends ServerGameObject {
  /**
   * Creates a new ServerAvatar instance.
   * @param {number} x - Initial X coordinate.
   * @param {number} y - Initial Y coordinate.
   * @param {string} [name="User"] - Avatar's name.
   * @param {string | null} [socketId=null] - Associated socket ID.
   */
  constructor(x, y, name = "User", socketId = null) {
    // --- Keep Constructor Check ---
    if (!SHARED_CONFIG || !SERVER_CONFIG) {
      throw new Error("Config not available when creating ServerAvatar.");
    }
    // --- End Constructor Check ---

    // Avatars use RUNTIME IDs. Pass null for persistentId to generate one.
    // Config use is safe here because constructor check passed
    super(x, y, SHARED_CONFIG.AVATAR_DEFAULT_Z, null);
    // this.id is now the runtime ID (_runtimeIdCounter value)

    this.name = name;
    this.socketId = socketId;
    this.roomId = null; // Set by ServerRoom

    this.isAdmin = false;

    // --- Movement ---
    this.targetX = x;
    this.targetY = y;
    this.path = [];
    this.speed = SERVER_CONFIG.AVATAR_SPEED; // Use config
    this.actionAfterPath = null;

    // --- State ---
    this.state = SHARED_CONFIG.AVATAR_STATE_IDLE; // Use config
    this.direction = SHARED_CONFIG.DIRECTION_SOUTH; // Use config
    this.sittingOnFurniId = null; // Stores the MongoDB _id STRING of the furniture

    // --- Customization & Effects ---
    this.bodyColor = "#6CA0DC";
    this.emoteTimeout = null;
    this.currentEmoteId = null;

    // --- Inventory & Currency ---
    this.inventory = new Map(); // definitionId -> quantity
    this.currency = SHARED_CONFIG.DEFAULT_CURRENCY; // Use config
  }

  /**
   * Data Transfer Object for client updates. Includes runtime ID as string.
   * No config check needed here.
   */
  toDTO() {
    // Read from SHARED_CONFIG is safe here
    const emoteData =
      this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING && this.currentEmoteId
        ? { emoteId: this.currentEmoteId }
        : {};
    return {
      ...super.toDTO(), // Includes id (runtime, string), x, y, z
      name: this.name,
      roomId: this.roomId,
      state: this.state,
      direction: this.direction,
      sittingOnFurniId: this.sittingOnFurniId
        ? String(this.sittingOnFurniId)
        : null, // Send furniture DB ID string
      bodyColor: this.bodyColor,
      isAdmin: this.isAdmin,
      ...emoteData,
    };
  }

  /**
   * Simplified DTO for profile information requests. Includes runtime ID as string.
   * No config check needed.
   */
  toProfileDTO() {
    return {
      id: String(this.id), // Send runtime ID as string
      name: this.name,
      state: this.state,
      roomId: this.roomId,
      bodyColor: this.bodyColor,
      currency: this.currency,
    };
  }

  /** Adds an item (by definition ID) to the inventory. No config check needed. */
  addItem(definitionId, quantity = 1) {
    if (quantity <= 0) return false;
    const currentQuantity = this.inventory.get(definitionId) || 0;
    this.inventory.set(definitionId, currentQuantity + quantity);
    console.log(
      `Inventory: Added ${quantity}x ${definitionId} to ${
        this.name
      }. New total: ${this.inventory.get(definitionId)}`
    );
    return true;
  }

  /** Removes an item (by definition ID) from the inventory. No config check needed. */
  removeItem(definitionId, quantity = 1) {
    if (quantity <= 0) return false;
    const currentQuantity = this.inventory.get(definitionId) || 0;
    if (currentQuantity < quantity) {
      console.log(
        `Inventory: Failed to remove ${quantity}x ${definitionId} from ${this.name}. Only have ${currentQuantity}`
      );
      return false; // Not enough items
    }
    const newQuantity = currentQuantity - quantity;
    if (newQuantity === 0) {
      this.inventory.delete(definitionId);
      console.log(
        `Inventory: Removed last ${quantity}x ${definitionId} from ${this.name}.`
      );
    } else {
      this.inventory.set(definitionId, newQuantity);
      console.log(
        `Inventory: Removed ${quantity}x ${definitionId} from ${this.name}. New total: ${newQuantity}`
      );
    }
    return true;
  }

  /** Checks if the avatar has a specific item in inventory. No config check needed. */
  hasItem(definitionId, quantity = 1) {
    return (this.inventory.get(definitionId) || 0) >= quantity;
  }

  /** Gets a DTO representation of the inventory for sending to the client. No config check needed. */
  getInventoryDTO() {
    return Object.fromEntries(this.inventory.entries());
  }

  /**
   * Updates avatar position based on path and delta time. Executes deferred actions upon arrival.
   * Uses furniture DB IDs for deferred actions.
   * No config check needed here - relies on constants and instance properties.
   * @param {number} deltaTimeMs - Time elapsed since last update in milliseconds.
   * @param {ServerRoom} room - Room context for executing actions.
   * @param {Function} changeRoomCallback - Callback function to trigger room change if action is 'door'. Signature: (socket, data)
   * @returns {boolean} True if the avatar's state (pos, dir, state) changed, false otherwise.
   */
  updateMovement(deltaTimeMs, room, changeRoomCallback) {
    // Accessing SHARED_CONFIG constants is safe here
    if (
      this.state !== SHARED_CONFIG.AVATAR_STATE_WALKING ||
      this.path.length === 0
    ) {
      return false;
    }

    const targetStep = this.path[0];
    const dx = targetStep.x - this.x;
    const dy = targetStep.y - this.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    // Accessing instance property 'speed' is safe
    const moveAmount = this.speed * (deltaTimeMs / 1000);

    let positionChanged = false;
    let stateOrDirectionChanged = false;

    if (distance <= moveAmount) {
      // Reached Waypoint
      this.x = targetStep.x;
      this.y = targetStep.y;
      this.path.shift();
      positionChanged = true;

      if (this.path.length === 0) {
        // Reached Final Destination
        const oldState = this.state;
        this.state = SHARED_CONFIG.AVATAR_STATE_IDLE; // Tentative
        stateOrDirectionChanged = this.state !== oldState;

        if (this.actionAfterPath) {
          const action = this.actionAfterPath;
          this.actionAfterPath = null;

          if (action.type === "sit") {
            // Use the DB ID (string) stored in action.targetId for lookup
            const furni = room.getFurnitureById(action.targetId);
            if (furni && furni.canSit && !room.isFurnitureOccupied(furni.id)) {
              if (this.executeSit(furni, room)) {
                // executeSit handles setting state
                stateOrDirectionChanged = true;
              } else {
                this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
              }
            } else {
              this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
            }
          } else if (action.type === "door") {
            if (changeRoomCallback && action.targetRoomId && action.socket) {
              changeRoomCallback(action.socket, {
                targetRoomId: action.targetRoomId,
                targetX: action.targetX,
                targetY: action.targetY,
              });
              return true; // Room change handles state
            } else {
              console.error(
                "Door action failed: Missing callback, targetRoomId, or socket.",
                action
              );
              this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
            }
          } else {
            this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
          }
        }
        // Ensure idle if not sitting after action
        if (
          this.state !== SHARED_CONFIG.AVATAR_STATE_SITTING &&
          this.state !== SHARED_CONFIG.AVATAR_STATE_IDLE
        ) {
          this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
          stateOrDirectionChanged = true;
        }
      } else {
        // Intermediate Waypoint
        const nextStep = this.path[0];
        if (this.updateDirection(nextStep.x - this.x, nextStep.y - this.y)) {
          stateOrDirectionChanged = true;
        }
      }
    } else {
      // Moving Towards Waypoint
      this.x += (dx / distance) * moveAmount;
      this.y += (dy / distance) * moveAmount;
      positionChanged = true;
      if (this.updateDirection(dx, dy)) {
        stateOrDirectionChanged = true;
      }
    }
    return positionChanged || stateOrDirectionChanged;
  }

  /**
   * Updates the avatar's facing direction based on movement vector.
   * No config check needed - uses constants only.
   */
  updateDirection(dx, dy) {
    // Accessing SHARED_CONFIG constants is safe
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;

    let newDirection = this.direction;
    const angle = Math.atan2(dy, dx);
    const pi = Math.PI;

    if (angle > -pi / 8 && angle <= pi / 8)
      newDirection = SHARED_CONFIG.DIRECTION_EAST;
    else if (angle > pi / 8 && angle <= (3 * pi) / 8)
      newDirection = SHARED_CONFIG.DIRECTION_SOUTH_EAST;
    else if (angle > (3 * pi) / 8 && angle <= (5 * pi) / 8)
      newDirection = SHARED_CONFIG.DIRECTION_SOUTH;
    else if (angle > (5 * pi) / 8 && angle <= (7 * pi) / 8)
      newDirection = SHARED_CONFIG.DIRECTION_SOUTH_WEST;
    else if (angle > (7 * pi) / 8 || angle <= (-7 * pi) / 8)
      newDirection = SHARED_CONFIG.DIRECTION_WEST;
    else if (angle > (-7 * pi) / 8 && angle <= (-5 * pi) / 8)
      newDirection = SHARED_CONFIG.DIRECTION_NORTH_WEST;
    else if (angle > (-5 * pi) / 8 && angle <= (-3 * pi) / 8)
      newDirection = SHARED_CONFIG.DIRECTION_NORTH;
    else if (angle > (-3 * pi) / 8 && angle <= -pi / 8)
      newDirection = SHARED_CONFIG.DIRECTION_NORTH_EAST;

    if (newDirection !== this.direction) {
      this.direction = newDirection;
      return true; // Direction changed
    }
    return false; // Direction did not change
  }

  /**
   * Initiates movement towards a target grid coordinate.
   * Deferred action `targetId` should use the furniture's persistent DB ID (_id string).
   * No config check needed - uses constants and args.
   * @param {number} targetGridX - Target grid X coordinate.
   * @param {number} targetGridY - Target grid Y coordinate.
   * @param {ServerRoom} room - The room context for pathfinding and actions.
   * @param {object | null} deferredAction - Action to perform upon arrival (e.g., { type: 'sit', targetId: 'furni_db_id_string' }).
   * @param {Function} changeRoomCallback - Required if deferredAction might be 'door'.
   * @returns {boolean} True if the avatar's state changed (e.g., started walking or emote cleared), false otherwise.
   */
  moveTo(
    targetGridX,
    targetGridY,
    room,
    deferredAction = null,
    changeRoomCallback = null
  ) {
    // Accessing SHARED_CONFIG constants is safe
    if (this.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
      console.log(`${this.name} cannot move while sitting.`);
      return false;
    }

    let stateChangedByEmoteClear = false;
    if (this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING) {
      this.clearEmote(true); // Clear emote AND reset state
      stateChangedByEmoteClear = true;
    }
    this.actionAfterPath = null; // Clear previous deferred action

    const startX = Math.round(this.x);
    const startY = Math.round(this.y);
    const endX = Math.round(targetGridX);
    const endY = Math.round(targetGridY);

    // --- Handle reaching target immediately ---
    if (startX === endX && startY === endY) {
      const oldState = this.state;
      let stateChangedByAction = false;
      this.path = [];

      if (deferredAction) {
        this.actionAfterPath = deferredAction; // Temporarily set to execute now
        if (this.actionAfterPath.type === "sit") {
          const furni = room.getFurnitureById(this.actionAfterPath.targetId); // Use DB ID
          if (furni && furni.canSit && !room.isFurnitureOccupied(furni.id)) {
            if (this.executeSit(furni, room)) stateChangedByAction = true;
          }
        } else if (this.actionAfterPath.type === "door") {
          const action = this.actionAfterPath;
          if (changeRoomCallback && action.targetRoomId && action.socket) {
            // Trigger immediately if already at the door tile
            changeRoomCallback(action.socket, {
              targetRoomId: action.targetRoomId,
              targetX: action.targetX,
              targetY: action.targetY,
            });
            // Don't change state here, room change handles it
            return true; // State will definitely change
          } else {
            console.error(
              "moveTo: Cannot trigger door action immediately: Missing callback, targetRoomId, or socket.",
              this.actionAfterPath
            );
          }
        }
        // Clear action if executed or if not handled immediately
        if (this.actionAfterPath?.type !== "door") {
          // Keep door action pending if callback missing
          this.actionAfterPath = null;
        }
      }

      // If state isn't sitting after potential action, set to idle
      if (this.state !== SHARED_CONFIG.AVATAR_STATE_SITTING) {
        this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
        return (
          stateChangedByAction ||
          oldState !== SHARED_CONFIG.AVATAR_STATE_IDLE ||
          stateChangedByEmoteClear
        );
      }
      return stateChangedByAction || stateChangedByEmoteClear;
    }

    // --- Find Path ---
    const newPath = room.pathfinder.findPath(startX, startY, endX, endY);

    if (newPath && newPath.length > 0) {
      if (newPath[0].x === startX && newPath[0].y === startY) {
        newPath.shift();
      }

      if (newPath.length > 0) {
        // Valid path found
        this.path = newPath;
        const oldState = this.state;
        this.state = SHARED_CONFIG.AVATAR_STATE_WALKING;
        this.targetX = endX;
        this.targetY = endY;
        this.actionAfterPath = deferredAction; // Store action for arrival
        this.updateDirection(this.path[0].x - this.x, this.path[0].y - this.y);
        return this.state !== oldState || stateChangedByEmoteClear;
      } else {
        // Path found, but only contains start tile (already there) - treat same as above
        const oldState = this.state;
        let stateChangedByAction = false;
        this.path = [];
        if (deferredAction) {
          this.actionAfterPath = deferredAction;
          if (this.actionAfterPath.type === "sit") {
            /* ... try sit ... */
            const furni = room.getFurnitureById(this.actionAfterPath.targetId);
            if (furni && furni.canSit && !room.isFurnitureOccupied(furni.id)) {
              if (this.executeSit(furni, room)) stateChangedByAction = true;
            }
          } else if (this.actionAfterPath.type === "door") {
            /* ... trigger door if possible ... */
            const action = this.actionAfterPath;
            if (changeRoomCallback && action.targetRoomId && action.socket) {
              changeRoomCallback(action.socket, {
                targetRoomId: action.targetRoomId,
                targetX: action.targetX,
                targetY: action.targetY,
              });
              return true;
            }
          }
          if (this.actionAfterPath?.type !== "door")
            this.actionAfterPath = null;
        }
        if (this.state !== SHARED_CONFIG.AVATAR_STATE_SITTING) {
          this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
          return (
            stateChangedByAction ||
            oldState !== SHARED_CONFIG.AVATAR_STATE_IDLE ||
            stateChangedByEmoteClear
          );
        }
        return stateChangedByAction || stateChangedByEmoteClear;
      }
    } else {
      // No path found
      const oldState = this.state;
      this.path = [];
      this.state = SHARED_CONFIG.AVATAR_STATE_IDLE; // Ensure idle
      this.actionAfterPath = null;
      console.log(
        `No path found for ${this.name} to (${endX},${endY}). State -> idle`
      );
      return this.state !== oldState || stateChangedByEmoteClear;
    }
  }

  /**
   * Executes the sit action on a given piece of furniture.
   * Uses furniture's persistent DB ID (_id string).
   * No config check needed - uses constants and args.
   */
  executeSit(furniture, room) {
    // Accessing SHARED_CONFIG constants is safe
    if (
      this.state === SHARED_CONFIG.AVATAR_STATE_SITTING ||
      !furniture ||
      !furniture.id
    )
      return false;

    this.clearEmote(true); // Clear emote and reset state

    const oldState = this.state;
    this.state = SHARED_CONFIG.AVATAR_STATE_SITTING;
    this.path = [];
    this.actionAfterPath = null;
    this.z = furniture.z + furniture.sitHeightOffset;
    this.x = furniture.x;
    this.y = furniture.y;
    this.direction = rotateDirectionFunc(furniture.sitDir, furniture.rotation);
    this.sittingOnFurniId = String(furniture.id); // Store the DB _id STRING

    return this.state !== oldState;
  }

  /**
   * Executes the stand action. Uses furniture's persistent DB ID.
   * No config check needed - uses constants and args.
   */
  executeStand(room) {
    // Accessing SHARED_CONFIG constants is safe
    if (this.state !== SHARED_CONFIG.AVATAR_STATE_SITTING) return false;

    this.clearEmote(false);

    const oldState = this.state;
    const oldFurniId = this.sittingOnFurniId; // This is the DB ID string
    const furni = room?.getFurnitureById(oldFurniId); // Lookup by DB ID

    // Reset avatar state regardless
    this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
    this.z = SHARED_CONFIG.AVATAR_DEFAULT_Z;
    this.sittingOnFurniId = null; // Clear link

    let movedToAdjacent = false;
    if (furni && room) {
      // Try to find a walkable adjacent tile
      const standOffsets = [
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: 1, dy: 1 },
        { dx: -1, dy: -1 },
        { dx: 1, dy: -1 },
      ];
      const currentFurniX = Math.round(furni.x);
      const currentFurniY = Math.round(furni.y);

      for (const offset of standOffsets) {
        const standX = currentFurniX + offset.dx;
        const standY = currentFurniY + offset.dy;
        if (room.isWalkable(standX, standY)) {
          this.x = standX;
          this.y = standY;
          movedToAdjacent = true;
          break;
        }
      }
    }

    if (!movedToAdjacent && furni) {
      // Fallback: place at furniture's base coords
      this.x = furni.x;
      this.y = furni.y;
    } else if (!movedToAdjacent && !furni) {
      // If original furniture is gone, avatar position remains
      console.warn(
        `${this.name} stood up but original furniture (ID: ${oldFurniId}) not found. Avatar remains at (${this.x}, ${this.y}).`
      );
    }
    return true; // State always changes from sitting to idle
  }

  /**
   * Starts an emote action.
   * Minimal config check reasonable here for EMOTE_DEFINITIONS.
   */
  executeEmote(emoteId, ioInstance) {
    // Check config for emote definitions
    const emoteDef = SHARED_CONFIG.EMOTE_DEFINITIONS?.[emoteId];
    if (!emoteDef) return false;

    // Accessing SHARED_CONFIG constants is safe
    if (
      this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING ||
      this.state === SHARED_CONFIG.AVATAR_STATE_SITTING
    ) {
      return false;
    }

    const oldState = this.state;
    this.state = SHARED_CONFIG.AVATAR_STATE_EMOTING;
    this.currentEmoteId = emoteId;
    this.clearEmote(false); // Clear previous timer

    // Accessing SERVER_CONFIG is safe
    const duration = emoteDef.duration || SERVER_CONFIG.EMOTE_DURATION_SERVER;

    this.emoteTimeout = setTimeout(() => {
      // Accessing SHARED_CONFIG constants is safe inside timeout
      if (
        this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        this.currentEmoteId === emoteId
      ) {
        this.state =
          this.path?.length > 0
            ? SHARED_CONFIG.AVATAR_STATE_WALKING
            : SHARED_CONFIG.AVATAR_STATE_IDLE;
        this.currentEmoteId = null;
        this.emoteTimeout = null;
        if (ioInstance && this.roomId) {
          ioInstance.to(this.roomId).emit("avatar_update", this.toDTO());
        } else {
          console.warn(
            "Cannot broadcast emote end: ioInstance or avatar.roomId missing."
          );
        }
      }
    }, duration);
    return true; // State changed
  }

  /**
   * Clears any active server-side emote timeout.
   * No config check needed - uses constants only.
   */
  clearEmote(resetState = false) {
    // Accessing SHARED_CONFIG constants is safe
    if (this.emoteTimeout) {
      clearTimeout(this.emoteTimeout);
      this.emoteTimeout = null;
    }
    if (resetState && this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING) {
      this.state =
        this.path?.length > 0
          ? SHARED_CONFIG.AVATAR_STATE_WALKING
          : SHARED_CONFIG.AVATAR_STATE_IDLE;
      this.currentEmoteId = null;
      // Caller responsible for broadcasting change if needed immediately
    }
  }

  /**
   * Sets the avatar's body color. No config check needed.
   */
  setBodyColor(hexColor) {
    if (!/^#[0-9A-F]{6}$/i.test(hexColor)) return false;
    const upperHex = hexColor.toUpperCase();
    if (this.bodyColor === upperHex) return false;
    this.bodyColor = upperHex;
    return true;
  }

  /** Adds currency to the avatar. No config check needed. */
  addCurrency(amount) {
    const amountInt = Math.floor(amount);
    if (typeof amountInt !== "number" || amountInt <= 0 || isNaN(amountInt))
      return false;
    this.currency += amountInt;
    console.log(
      `Currency: Added ${amountInt} to ${this.name}. New total: ${this.currency}`
    );
    return true;
  }

  /** Removes currency if sufficient funds exist. No config check needed. */
  removeCurrency(amount) {
    const amountInt = Math.floor(amount);
    if (typeof amountInt !== "number" || amountInt <= 0 || isNaN(amountInt))
      return false;
    if (this.currency >= amountInt) {
      this.currency -= amountInt;
      console.log(
        `Currency: Removed ${amountInt} from ${this.name}. New total: ${this.currency}`
      );
      return true;
    }
    console.log(
      `Currency: Failed to remove ${amountInt} from ${this.name}. Only have ${this.currency}`
    );
    return false;
  }

  /**
   * Prepares the avatar for a room change. Resets state, position, etc.
   * No config check needed - uses constants only.
   */
  prepareForRoomChange(newRoomId, targetX, targetY) {
    // Accessing SHARED_CONFIG constants is safe
    console.log(
      `${this.name} (ID: ${this.id}) preparing for room change to ${newRoomId} at (${targetX}, ${targetY})`
    );
    this.clearEmote(true); // Stop emote and reset state
    this.state = SHARED_CONFIG.AVATAR_STATE_IDLE; // Force idle
    this.path = [];
    this.actionAfterPath = null;
    this.targetX = targetX;
    this.targetY = targetY;
    this.sittingOnFurniId = null; // Cannot be sitting

    this.x = targetX;
    this.y = targetY;
    this.z = SHARED_CONFIG.AVATAR_DEFAULT_Z; // Reset Z
    this.roomId = newRoomId; // Update room ID
  }
} // End ServerAvatar Class

// --- Represents Non-Player Characters on the server (uses runtime ID) ---
class ServerNPC extends ServerAvatar {
  // <-- Inherits from ServerAvatar
  static _npcRuntimeIdCounter = 1000000; // Use a different range for NPC runtime IDs

  /**
   * Creates a new ServerNPC instance.
   * @param {object} definition - The NPC definition from npc_definitions.json.
   * @param {string} roomId - The room ID where the NPC spawns.
   */
  constructor(definition, roomId) {
    // --- Configuration Check ---
    if (!SHARED_CONFIG || !SERVER_CONFIG) {
      throw new Error("Config not available when creating ServerNPC.");
    }
    if (!definition || !definition.npcId) {
      throw new Error("Invalid NPC definition provided.");
    }
    // --- End Configuration Check ---

    // --- Call the PARENT (ServerAvatar) constructor ---
    // Pass basic avatar properties. Runtime ID will be overwritten below.
    super(
      definition.x,
      definition.y,
      definition.name || "NPC", // Pass name to Avatar constructor
      null // socketId is null for NPCs
    );
    // NPCs need distinct runtime IDs; overwrite the one generated by super()
    this.id = `npc_${ServerNPC._npcRuntimeIdCounter++}`;
    // --- End Super Call ---

    // --- NPC Specific Properties ---
    this.definitionId = definition.npcId; // Link back to definition from JSON
    this.roomId = roomId; // Set room ID (overwrites if set by super)
    this.isNPC = true; // Explicit flag to identify NPCs
    this.isPlayer = false; // NPCs are never players
    this.socketId = null; // NPCs don't have sockets

    // --- Override/Set Defaults Different from Player Avatars ---
    this.speed = SERVER_CONFIG.AVATAR_SPEED * 0.75; // Example: NPCs slightly slower
    this.direction =
      definition.initialDirection ?? SHARED_CONFIG.DIRECTION_SOUTH;
    this.bodyColor = definition.bodyColor || "#CCCCCC"; // Grey default
    this.isAdmin = false; // NPCs cannot be admins
    this.inventory = new Map(); // NPCs don't have inventory/currency
    this.currency = 0;
    this.sittingOnFurniId = null; // NPCs don't sit (currently)

    // --- AI Specific Properties ---
    this.behavior = definition.behavior || { type: "stationary" }; // Default AI behavior
    this.dialogue = definition.dialogue || []; // Lines NPC can say
    this.spawnPoint = { x: definition.x, y: definition.y }; // Remember spawn location for wandering
    this.aiState = {
      // Internal state for AI logic
      isWaiting: false,
      waitEndTime: 0,
      nextWanderTarget: null, // Could store planned target if needed
    };

    // Methods like updateMovement, updateDirection, moveTo are now inherited directly
  }

  /**
   * Updates NPC state from a server DTO (usually from initialization or future admin commands).
   * Ensures NPC-specific flags are maintained.
   * @param {object} dto - Data Transfer Object containing updates.
   */
  update(dto) {
    super.update(dto); // Call parent update for position, state, direction etc.
    this.isNPC = true; // Ensure these flags remain correct
    this.isPlayer = false;
    if (dto.npcId) this.npcId = dto.npcId; // Update definition ID if provided
    if (dto.bodyColor != null) this.bodyColor = dto.bodyColor; // Update color if needed
    // NPCs generally don't have their core properties updated via DTO after creation,
    // but this allows for potential future flexibility (e.g., admin changing name/color).
  }

  /**
   * Creates a Data Transfer Object for sending NPC state to clients.
   * Includes NPC-specific flags.
   * @returns {object} DTO suitable for client consumption.
   */
  toDTO() {
    // Start with the DTO from the parent (ServerAvatar)
    const dto = super.toDTO();

    // Add/Modify NPC-specific fields
    dto.isNPC = true; // Flag to identify as NPC on client
    dto.npcId = this.definitionId; // Send the definition ID (e.g., "bob_the_wanderer")

    // Optionally remove fields irrelevant to client-side NPCs
    // delete dto.isAdmin;
    // delete dto.currency; // Client doesn't need NPC currency/inventory

    return dto;
  }

  /**
   * Core AI update logic, called every server tick by the main game loop.
   * Handles movement interpolation and AI decision making.
   * @param {number} deltaTimeMs - Time elapsed since last tick in milliseconds.
   * @param {import('./room')} room - The ServerRoom instance the NPC is in.
   * @returns {boolean} True if the NPC's state (pos, dir, state) changed, false otherwise.
   */
  updateAI(deltaTimeMs, room) {
    // 1. Handle Movement (calls inherited ServerAvatar.updateMovement)
    // Pass an empty function for the room change callback as NPCs don't use doors this way.
    let stateChanged = this.updateMovement(deltaTimeMs, room, () => {});

    // Safety check: Prevent NPCs getting stuck in 'walking' state if path disappears unexpectedly
    if (
      this.state === SHARED_CONFIG.AVATAR_STATE_WALKING &&
      this.path.length === 0 &&
      !this.actionAfterPath // Not expecting an action after path (NPCs don't usually sit/use doors)
    ) {
      // console.log(`NPC ${this.name} finished path unexpectedly, setting state to IDLE.`);
      this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
      stateChanged = true;
    }

    // 2. AI Decision Making (only if idle and not currently waiting)
    if (
      this.state === SHARED_CONFIG.AVATAR_STATE_IDLE &&
      !this.aiState.isWaiting
    ) {
      // --- Stationary Behavior ---
      if (this.behavior.type === "stationary") {
        if (this.behavior.lookAround && Math.random() < 0.02) {
          // Small chance to turn
          const oldDir = this.direction;
          this.direction = Math.floor(Math.random() * 8);
          if (this.direction !== oldDir) stateChanged = true;
        }
        // Otherwise, stays idle.
      }
      // --- Wander Behavior ---
      else if (this.behavior.type === "wander") {
        // Decide whether to wander or wait
        if (Math.random() < 0.7) {
          // 70% chance to wander
          const radius = this.behavior.wanderRadius || 4;
          let targetX, targetY;
          let attempts = 0;
          const MAX_ATTEMPTS = 10;

          // Find a valid, walkable random target within radius of spawn point
          do {
            targetX =
              this.spawnPoint.x +
              Math.floor(Math.random() * (radius * 2 + 1)) -
              radius;
            targetY =
              this.spawnPoint.y +
              Math.floor(Math.random() * (radius * 2 + 1)) -
              radius;
            attempts++;
          } while (
            !room.isWalkable(targetX, targetY) && // Check walkability using room method
            attempts < MAX_ATTEMPTS
          );

          // If a valid target was found and it's not the current spot
          if (
            attempts < MAX_ATTEMPTS &&
            (targetX !== Math.round(this.x) || targetY !== Math.round(this.y))
          ) {
            // console.log(`NPC ${this.name} starting wander to (${targetX}, ${targetY})`);
            // Call inherited moveTo directly. Pass empty room change callback.
            if (this.moveTo(targetX, targetY, room, null, () => {})) {
              stateChanged = true; // State changed to walking
            } else {
              // Failed to find path (e.g., blocked), just wait instead
              // console.log(`NPC ${this.name} wander path failed, waiting.`);
              this._setWait(this.behavior.minWaitMs, this.behavior.maxWaitMs);
            }
          } else {
            // Couldn't find valid wander target after attempts, just wait
            // console.log(`NPC ${this.name} failed to find wander target, waiting.`);
            this._setWait(this.behavior.minWaitMs, this.behavior.maxWaitMs);
          }
        } else {
          // 30% chance to wait
          // console.log(`NPC ${this.name} deciding to wait.`);
          this._setWait(this.behavior.minWaitMs, this.behavior.maxWaitMs);
        }
      }
      // Add other behavior types ('patrol', 'follow', etc.) here later if needed
    }

    // 3. Handle Waiting state countdown
    if (this.aiState.isWaiting && Date.now() > this.aiState.waitEndTime) {
      // console.log(`NPC ${this.name} finished waiting.`);
      this.aiState.isWaiting = false;
      // AI will make a new decision on the *next* tick. No state change needed here.
    }

    return stateChanged; // Return true if position/state/direction changed this tick
  }

  /**
   * Helper method to put the NPC into a waiting state for a random duration.
   * @param {number} [minMs=2000] - Minimum wait time in milliseconds.
   * @param {number} [maxMs=5000] - Maximum wait time in milliseconds.
   */
  _setWait(minMs = 2000, maxMs = 5000) {
    this.aiState.isWaiting = true;
    const waitTime = minMs + Math.random() * (maxMs - minMs);
    this.aiState.waitEndTime = Date.now() + waitTime;
    // Ensure NPC is visually idle while waiting (stops walking animation etc.)
    if (this.state !== SHARED_CONFIG.AVATAR_STATE_IDLE) {
      this.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
      // stateChanged should be returned by updateAI if this happens
    }
  }

  /**
   * Handles interaction initiated by a player avatar.
   * Makes the NPC face the player and returns dialogue/state changes.
   * @param {ServerAvatar} avatar - The player avatar initiating the interaction.
   * @returns {{interaction: boolean, dialogue?: string, directionChanged?: boolean} | null}
   *          An object describing the interaction result, or null if no interaction.
   */
  interact(avatar) {
    let directionChanged = false;

    // Make NPC face the player first
    const dx = avatar.x - this.x;
    const dy = avatar.y - this.y;
    if (this.updateDirection(dx, dy)) {
      directionChanged = true;
      // Note: The broadcast of this direction change will now be handled
      // by the socket handler based on the return value of this method.
      console.log(`NPC ${this.name} turned to face ${avatar.name}`);
    }

    // Check if there's dialogue to provide
    if (this.dialogue && this.dialogue.length > 0) {
      // Select a random dialogue line
      const line =
        this.dialogue[Math.floor(Math.random() * this.dialogue.length)];

      console.log(
        `NPC ${this.name} selected dialogue for ${avatar.name}: "${line}"`
      );

      // Return the interaction result
      return {
        interaction: true,
        dialogue: line,
        directionChanged: directionChanged, // Indicate if the NPC turned
      };
    }

    // No dialogue, but NPC might have turned. Return only direction change if it happened.
    if (directionChanged) {
      return {
        interaction: false, // No dialogue interaction occurred
        directionChanged: true,
      };
    }

    // No dialogue and no direction change
    return null; // Indicate no interaction or state change happened
  }
} // --- End ServerNPC Class ---

// Node.js export
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ServerGameObject,
    ServerFurniture,
    ServerAvatar,
    ServerNPC,
  };
}
