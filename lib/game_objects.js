'use strict';

// Note: config might be loaded differently depending on environment
// Assuming it's required correctly in the context where these classes are used.
// const { SHARED_CONFIG, SERVER_CONFIG } = require('./config'); // Direct require might cause issues if config isn't loaded yet
// It's often better to pass config values into constructors or methods if needed immediately.
let SHARED_CONFIG_REF; // Use a reference that gets populated later
let SERVER_CONFIG_REF;
if (typeof require !== 'undefined') {
     try {
          const configModule = require('./config');
          SHARED_CONFIG_REF = configModule.SHARED_CONFIG;
          SERVER_CONFIG_REF = configModule.SERVER_CONFIG;
     } catch (e) {
          console.error("Could not load config in game_objects.js via require:", e);
          // Fallback or error handling might be needed if running in different context
          SHARED_CONFIG_REF = global.SHARED_CONFIG || {}; // Example fallback
          SERVER_CONFIG_REF = global.SERVER_CONFIG || {}; // Example fallback
     }
} else {
     // Assume loaded globally in browser context (less common for this file)
     SHARED_CONFIG_REF = global.SHARED_CONFIG || {};
     SERVER_CONFIG_REF = global.SERVER_CONFIG || {};
}


// Utility function from utils.js (assuming utils.js is available)
let rotateDirectionFunc = (dir, amount) => (dir + amount + 8) % 8; // Default inline implementation
if (typeof require !== 'undefined') {
     try {
          rotateDirectionFunc = require('./utils').rotateDirection;
     } catch(e) { console.warn("Could not load rotateDirection from utils.js"); }
}


// Base class for server-side game objects with unique IDs
class ServerGameObject {
    // Using a getter for nextId to potentially allow more complex ID generation later
    static _nextId = 0;
    static get nextId() { return ServerGameObject._nextId; }
    static set nextId(value) { ServerGameObject._nextId = value; }

    constructor(x, y, z = 0, id = null) {
        // If an ID is provided (e.g., during loading), use it. Otherwise, generate a new one.
        // IMPORTANT: ID assignment now uses the static getter/setter
        this.id = id ?? ServerGameObject.nextId++;
        this.x = x; // Authoritative position X
        this.y = y; // Authoritative position Y
        this.z = z; // Authoritative position Z

        // Ensure the static counter is always ahead of the highest assigned ID
        // This check should happen *after* assigning the ID
        ServerGameObject.nextId = Math.max(ServerGameObject.nextId, this.id + 1);
    }

    /**
     * Basic Data Transfer Object for sending minimal state to clients.
     */
    toDTO() {
        return { id: this.id, x: this.x, y: this.y, z: this.z };
    }
}

// Represents furniture items on the server
class ServerFurniture extends ServerGameObject {
    constructor(definitionId, x, y, z, rotation = 0, id = null, ownerId = null, initialState = null, initialColorOverride = null) { // Added colorOverride
        if (!SHARED_CONFIG_REF || !SHARED_CONFIG_REF.FURNITURE_DEFINITIONS) {
             throw new Error("SHARED_CONFIG_REF not loaded or invalid when creating ServerFurniture.");
        }
        const definition = SHARED_CONFIG_REF.FURNITURE_DEFINITIONS.find(def => def.id === definitionId);
        if (!definition) {
            throw new Error(`Invalid furniture definition ID: ${definitionId}`);
        }

        super(x, y, z, id); // Pass ID to base constructor if provided

        // --- Definition Properties (Copied for easy access) ---
        this.definitionId = definitionId;
        this.name = definition.name;
        this.width = definition.width || 1;
        this.height = definition.height || 1;
        this.isWalkable = definition.isWalkable || false;
        this.isFlat = definition.isFlat || false; // e.g., rugs
        // Stackable defaults to true UNLESS isFlat is explicitly true
        this.stackable = definition.stackable !== undefined ? definition.stackable : !this.isFlat;
        // Stack height calculation: Use definition's stackHeight if present, otherwise 0 if flat, else 1.0
        this.stackHeight = definition.stackHeight ?? (this.isFlat ? 0 : 1.0);
        this.zOffset = definition.zOffset || 0;
        this.canRecolor = definition.canRecolor || false; // Store definition flag

        // --- Interaction Properties ---
        this.canSit = definition.canSit || false;
        this.sitDir = definition.sitDir ?? SHARED_CONFIG_REF.DIRECTION_SOUTH;
        this.sitHeightOffset = definition.sitHeightOffset || 0.1;
        this.canUse = definition.canUse || false;
        this.isToggle = definition.isToggle || false;

        // --- Door Properties (NEW) ---
        this.isDoor = definition.isDoor || false;
        this.targetRoomId = definition.targetRoomId || null; // Store target room/coords directly on instance if it's a door
        this.targetX = definition.targetX;
        this.targetY = definition.targetY;

        // --- Instance Properties ---
        this.rotation = rotateDirectionFunc(0, rotation); // Ensure valid rotation (0-7) using utility
        this.ownerId = ownerId; // ID of the avatar who placed it (optional)
        this.state = initialState ?? definition.defaultState ?? null; // Current state ('on', 'off', etc.)
        this.colorOverride = initialColorOverride || null; // Store custom color
    }

    /**
     * Data Transfer Object for clients, includes state, colorOverride, and door info if applicable.
     */
    toDTO() {
        const dto = {
            ...super.toDTO(),
            definitionId: this.definitionId,
            rotation: this.rotation,
        };
        // Include state in DTO only if the item is usable
        if (this.canUse) {
            dto.state = this.state;
        }
        // Include color override if set
        if (this.colorOverride) {
            dto.colorOverride = this.colorOverride;
        }
        // --- NEW: Include door properties in DTO ---
        if (this.isDoor) {
             dto.isDoor = true;
             dto.targetRoomId = this.targetRoomId;
             // Client doesn't usually need targetX/Y, server handles spawn
             // dto.targetX = this.targetX;
             // dto.targetY = this.targetY;
        }
        return dto;
    }

    /**
     * Data representation for saving to file (includes state, colorOverride, owner).
     */
    serialize() {
        return {
            defId: this.definitionId,
            x: this.x, y: this.y, z: this.z,
            rot: this.rotation,
            owner: this.ownerId, // Persist owner
            state: this.state,   // Persist the state
            color: this.colorOverride // Persist custom color as 'color'
            // Note: Door properties (isDoor, target*) are derived from definition on load, no need to save redundantly usually
        };
    }

    /**
     * Calculates the grid tiles occupied by this furniture based on its center (x, y) and dimensions.
     * @returns {Array<{x: number, y: number}>} Array of occupied grid coordinates.
     */
    getOccupiedTiles() {
        const tiles = [];
        const startX = Math.round(this.x);
        const startY = Math.round(this.y);
        // Calculate offsets from center based on width/height
        const halfW = Math.floor((this.width - 1) / 2);
        const halfH = Math.floor((this.height - 1) / 2);

        for (let dx = -halfW; dx < this.width - halfW; dx++) {
            for (let dy = -halfH; dy < this.height - halfH; dy++) {
                tiles.push({ x: startX + dx, y: startY + dy });
            }
        }
        // Ensure at least the base tile is returned if calculations result in empty
        return tiles.length > 0 ? tiles : [{ x: startX, y: startY }];
    }

    /**
     * Calculates the grid tile an avatar should stand on to interact (sit/use/enter door) with this furniture.
     * @returns {{x: number, y: number}} The interaction grid coordinate.
     */
    getInteractionTile() {
        // Determine the direction the front of the chair/door is facing after rotation
        // Use sitDir for chairs, default to South (2) for doors/other interactables if sitDir not defined
        const baseFacingDir = this.sitDir ?? SHARED_CONFIG_REF.DIRECTION_SOUTH;
        const facingDir = rotateDirectionFunc(baseFacingDir, this.rotation);

        // The interaction spot is opposite the facing direction
        const interactionDir = rotateDirectionFunc(facingDir, 4); // Rotate 180 degrees (4 steps)

        let dx = 0, dy = 0;
        // Determine dx, dy based on the interaction direction (tile *in front* of the interaction side)
        if (interactionDir === 0 || interactionDir === 1 || interactionDir === 7) dy = -1; // NE, E, SE -> Stand North/NorthWest/NorthEast of item (Y--)
        if (interactionDir === 3 || interactionDir === 4 || interactionDir === 5) dy = 1;  // SW, W, NW -> Stand South/SouthWest/SouthEast of item (Y++)
        if (interactionDir === 1 || interactionDir === 2 || interactionDir === 3) dx = 1;  // SE, S, SW -> Stand West/NorthWest/SouthWest of item (X++)
        if (interactionDir === 5 || interactionDir === 6 || interactionDir === 7) dx = -1; // NW, N, NE -> Stand East/NorthEast/SouthEast of item (X--)

        // Ensure interaction tile is relative to the furniture's base position
        return { x: Math.round(this.x) + dx, y: Math.round(this.y) + dy };
    }

    /**
     * Handles the 'use' action triggered by an avatar.
     * Toggles state for toggleable items. Recalculates Z based on stack height if needed.
     * Note: Door interaction is handled separately via room change logic.
     * @param {ServerAvatar} avatar - The avatar initiating the use action.
     * @param {ServerRoom} room - The room context for Z calculation.
     * @returns {boolean} True if the furniture's state or Z position changed, false otherwise.
     */
    use(avatar, room) {
        // Do not handle door usage here, it's managed by handleChangeRoom
        if (!this.canUse || this.isDoor) return false;
        if (!SHARED_CONFIG_REF || !SHARED_CONFIG_REF.FURNITURE_DEFINITIONS) return false;

        let changed = false;
        const oldState = this.state;
        const oldZ = this.z;

        if (this.isToggle) {
            if (this.state === 'on') this.state = 'off';
            else this.state = 'on';
            changed = this.state !== oldState;
        }

        // Recalculate Z Position (Example: only if state affects zOffset or stackHeight implicitly)
        // Find the definition again for safety
        const definition = SHARED_CONFIG_REF.FURNITURE_DEFINITIONS.find(d => d.id === this.definitionId);
        if (!definition) return changed; // Return if state changed but definition missing for Z calc

        // Calculate base Z excluding self
        const baseZ = room.getStackHeightAt(Math.round(this.x), Math.round(this.y), this.id);
        // Example: Add a small Z offset for 'on' state of a simple light
        const stateZOffset = (this.state === 'on' && definition.id === 'light_simple') ? 0.01 : 0;
        const newZ = baseZ + (definition.zOffset || 0) + stateZOffset;

        // Update Z if it changed significantly
        if (Math.abs(this.z - newZ) > 0.001) {
            this.z = newZ;
            changed = true; // Mark as changed if Z was updated
        }

        return changed; // Return true if either state or Z changed
    }

    /**
    * Changes the furniture's color override.
    * @param {string | null} hexColor - The new hex color string (or null/empty to reset). Must be in SHARED_CONFIG.VALID_RECOLOR_HEX if not null/empty.
    * @returns {boolean} True if color was changed, false otherwise.
    */
    setColorOverride(hexColor) {
        if (!this.canRecolor) return false;
        if (!SHARED_CONFIG_REF || !SHARED_CONFIG_REF.VALID_RECOLOR_HEX) {
             console.warn("Cannot set color override: SHARED_CONFIG_REF missing or invalid.");
             return false;
        }

        // Allow null/empty string to reset the override
        const effectiveColor = (hexColor === null || hexColor === '') ? null : hexColor.toUpperCase();

        // If setting a color, validate it against the allowed list
        if (effectiveColor !== null && !SHARED_CONFIG_REF.VALID_RECOLOR_HEX.includes(effectiveColor)) {
            console.warn(`Attempted to set invalid color ${effectiveColor} on ${this.name}`);
            return false;
        }

        // Check if the color actually changed
        if (this.colorOverride === effectiveColor) return false; // No change

        this.colorOverride = effectiveColor;
        return true;
    }
}

// Represents player avatars on the server
class ServerAvatar extends ServerGameObject {
    constructor(x, y, name = "User", id = null, socketId = null) {
         if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) {
              throw new Error("SHARED_CONFIG_REF or SERVER_CONFIG_REF not loaded when creating ServerAvatar.");
         }
        super(x, y, SHARED_CONFIG_REF.AVATAR_DEFAULT_Z, id); // Avatars start at base Z using config ref

        this.name = name;
        this.socketId = socketId; // Link to the corresponding socket connection
        this.roomId = null;       // NEW: ID of the room the avatar is currently in (Set by room logic)

        // --- Movement ---
        this.targetX = x;           // Target grid X for pathfinding
        this.targetY = y;           // Target grid Y for pathfinding
        this.path = [];             // Array of {x, y} steps from pathfinder
        this.speed = SERVER_CONFIG_REF.AVATAR_SPEED; // Tiles per second from config ref
        this.actionAfterPath = null; // e.g., { type: 'sit', targetId: furni.id } or { type: 'door', targetRoomId: 'xyz', ... }

        // --- State ---
        this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // idle, walking, sitting, emoting from config ref
        this.direction = SHARED_CONFIG_REF.DIRECTION_SOUTH; // Facing direction (0-7) from config ref
        this.sittingOnFurniId = null; // ID of furniture being sat on, or null

        // --- Customization & Effects ---
        this.bodyColor = '#6CA0DC'; // Default blue, changeable via command
        this.emoteTimeout = null; // Stores setTimeout ID for server-side emote duration
        this.currentEmoteId = null; // Track which emote is active

        // --- Inventory & Currency ---
        this.inventory = new Map(); // Use Map: definitionId -> quantity
        this.currency = SHARED_CONFIG_REF.DEFAULT_CURRENCY; // Added from config ref
    }

    /**
     * Data Transfer Object for client updates. Includes emoteId if emoting and roomId.
     */
    toDTO() {
         if (!SHARED_CONFIG_REF) return { id: this.id, name: this.name }; // Minimal DTO if config missing

        const emoteData = this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING ? { emoteId: this.currentEmoteId } : {};
        return {
            ...super.toDTO(), // Includes id, x, y, z
            name: this.name,
            roomId: this.roomId, // Include current room ID
            state: this.state,
            direction: this.direction,
            sittingOnFurniId: this.sittingOnFurniId,
            bodyColor: this.bodyColor,
            ...emoteData // Add emoteId if applicable
        };
    }

    /**
     * Simplified DTO for profile information requests. Includes currency.
     */
    toProfileDTO() {
        return {
            id: this.id,
            name: this.name,
            state: this.state, // Include current state
            roomId: this.roomId, // Include current room
            bodyColor: this.bodyColor,
            currency: this.currency, // Added currency
            // Could add inventory summary later if needed
        };
    }

    /** Adds an item (by definition ID) to the inventory. */
    addItem(definitionId, quantity = 1) {
        if (quantity <= 0) return false;
        const currentQuantity = this.inventory.get(definitionId) || 0;
        this.inventory.set(definitionId, currentQuantity + quantity);
        console.log(`Inventory: Added ${quantity}x ${definitionId} to ${this.name}. New total: ${this.inventory.get(definitionId)}`);
        return true;
    }

    /** Removes an item (by definition ID) from the inventory. */
    removeItem(definitionId, quantity = 1) {
        if (quantity <= 0) return false;
        const currentQuantity = this.inventory.get(definitionId) || 0;
        if (currentQuantity < quantity) {
            console.log(`Inventory: Failed to remove ${quantity}x ${definitionId} from ${this.name}. Only have ${currentQuantity}`);
            return false; // Not enough items
        }
        const newQuantity = currentQuantity - quantity;
        if (newQuantity === 0) {
            this.inventory.delete(definitionId); // Remove entry if quantity is zero
            console.log(`Inventory: Removed last ${quantity}x ${definitionId} from ${this.name}.`);
        } else {
            this.inventory.set(definitionId, newQuantity);
            console.log(`Inventory: Removed ${quantity}x ${definitionId} from ${this.name}. New total: ${newQuantity}`);
        }
        return true;
    }

    /** Checks if the avatar has a specific item in inventory. */
    hasItem(definitionId, quantity = 1) {
        return (this.inventory.get(definitionId) || 0) >= quantity;
    }

    /** Gets a DTO representation of the inventory for sending to the client. */
    getInventoryDTO() {
        // Convert Map to a simple object for JSON serialization
        const inventoryObj = {};
        for (const [defId, quantity] of this.inventory.entries()) {
            inventoryObj[defId] = quantity;
        }
        return inventoryObj;
    }


    /**
     * Updates avatar position based on path and delta time. Executes deferred actions upon arrival.
     * @param {number} deltaTimeMs - Time elapsed since last update in milliseconds.
     * @param {ServerRoom} room - Room context for executing actions.
     * @param {Function} changeRoomCallback - Callback function to trigger room change if action is 'door'. Signature: (socket, data)
     * @returns {boolean} True if the avatar's state (pos, dir, state) changed, false otherwise.
     */
    updateMovement(deltaTimeMs, room, changeRoomCallback) { // Added changeRoomCallback
         if (!SHARED_CONFIG_REF) return false; // Need config for states

        if (this.state !== SHARED_CONFIG_REF.AVATAR_STATE_WALKING || this.path.length === 0) {
            return false; // Not walking or no path
        }

        const targetStep = this.path[0];
        const dx = targetStep.x - this.x;
        const dy = targetStep.y - this.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const moveAmount = this.speed * (deltaTimeMs / 1000); // Dist = speed * time

        let positionChanged = false;
        let stateOrDirectionChanged = false;

        if (distance <= moveAmount) {
            // --- Reached Waypoint ---
            this.x = targetStep.x;
            this.y = targetStep.y;
            this.path.shift(); // Remove reached step
            positionChanged = true;

            if (this.path.length === 0) {
                // --- Reached Final Destination ---
                const oldState = this.state;
                this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // Tentatively set to idle
                stateOrDirectionChanged = this.state !== oldState;

                // Execute deferred action if present
                if (this.actionAfterPath) {
                    const action = this.actionAfterPath;
                    this.actionAfterPath = null; // Clear action first

                    if (action.type === 'sit') {
                        const furni = room.getFurnitureById(action.targetId);
                        if (furni && furni.canSit && !room.isFurnitureOccupied(furni.id)) {
                            if (this.executeSit(furni, room)) { // executeSit resets state if successful
                                stateOrDirectionChanged = true;
                            } else { this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; } // Ensure idle if sit fails
                        } else { this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; } // Ensure idle if furni invalid
                    }
                    // --- NEW: Handle Door Action ---
                    else if (action.type === 'door') {
                         // Room change is handled externally by the callback
                         if (changeRoomCallback && action.targetRoomId && action.socket) {
                              console.log(`${this.name} reached door, triggering room change to ${action.targetRoomId}`);
                              // Change room callback expects socket and data { targetRoomId, targetX?, targetY? }
                              changeRoomCallback(action.socket, {
                                   targetRoomId: action.targetRoomId,
                                   targetX: action.targetX,
                                   targetY: action.targetY
                              });
                              // State after room change is handled by prepareForRoomChange, no need to set here
                              // Return true immediately as state WILL change drastically
                              return true;
                         } else {
                              console.error("Door action failed: Missing callback, targetRoomId, or socket in action data.", action);
                              this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // Fallback to idle
                         }
                    }
                    // Add other action types here (e.g., 'use')
                    else {
                        this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // Default to idle if action unhandled
                    }
                }
                // If no action was taken or action didn't set a specific state (like sitting), ensure idle
                if (this.state !== SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
                     // state might already be idle, but ensure consistency
                     if(this.state !== SHARED_CONFIG_REF.AVATAR_STATE_IDLE) {
                          this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
                          stateOrDirectionChanged = true;
                     }
                }

            } else {
                // --- Reached Intermediate Waypoint ---
                // Update direction towards the *next* step
                const nextStep = this.path[0];
                if (this.updateDirection(nextStep.x - this.x, nextStep.y - this.y)) {
                    stateOrDirectionChanged = true;
                }
            }
        } else {
            // --- Moving Towards Waypoint ---
            this.x += (dx / distance) * moveAmount;
            this.y += (dy / distance) * moveAmount;
            positionChanged = true;
            // Update direction based on current movement vector
            if (this.updateDirection(dx, dy)) {
                stateOrDirectionChanged = true;
            }
        }

        return positionChanged || stateOrDirectionChanged;
    }

    /**
     * Updates the avatar's facing direction based on movement vector (dx, dy).
     * @param {number} dx - Change in X.
     * @param {number} dy - Change in Y.
     * @returns {boolean} True if the direction changed, false otherwise.
     */
    updateDirection(dx, dy) {
         if (!SHARED_CONFIG_REF) return false;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false; // No significant movement

        let newDirection = this.direction;
        const angle = Math.atan2(dy, dx); // atan2 handles quadrants correctly
        const pi = Math.PI;

        // Map angle ranges to directions (0-7)
        // Angles range from -PI to +PI
        if (angle > -pi / 8 && angle <= pi / 8) newDirection = SHARED_CONFIG_REF.DIRECTION_EAST;         // ~0 degrees
        else if (angle > pi / 8 && angle <= 3 * pi / 8) newDirection = SHARED_CONFIG_REF.DIRECTION_SOUTH_EAST; // ~45 degrees
        else if (angle > 3 * pi / 8 && angle <= 5 * pi / 8) newDirection = SHARED_CONFIG_REF.DIRECTION_SOUTH;       // ~90 degrees
        else if (angle > 5 * pi / 8 && angle <= 7 * pi / 8) newDirection = SHARED_CONFIG_REF.DIRECTION_SOUTH_WEST; // ~135 degrees
        else if (angle > 7 * pi / 8 || angle <= -7 * pi / 8) newDirection = SHARED_CONFIG_REF.DIRECTION_WEST;        // ~180 degrees
        else if (angle > -7 * pi / 8 && angle <= -5 * pi / 8) newDirection = SHARED_CONFIG_REF.DIRECTION_NORTH_WEST; // ~-135 degrees
        else if (angle > -5 * pi / 8 && angle <= -3 * pi / 8) newDirection = SHARED_CONFIG_REF.DIRECTION_NORTH;       // ~-90 degrees
        else if (angle > -3 * pi / 8 && angle <= -pi / 8) newDirection = SHARED_CONFIG_REF.DIRECTION_NORTH_EAST; // ~-45 degrees

        if (newDirection !== this.direction) {
            this.direction = newDirection;
            return true; // Direction changed
        }
        return false; // Direction did not change
    }

    /**
     * Initiates movement towards a target grid coordinate. Clears emote state if active.
     * @param {number} targetGridX - Target grid X coordinate.
     * @param {number} targetGridY - Target grid Y coordinate.
     * @param {ServerRoom} room - The room context for pathfinding and actions.
     * @param {object | null} deferredAction - Action to perform upon arrival (e.g., { type: 'sit', targetId: ... } or { type: 'door', targetRoomId: ..., socket: ...}).
     * @returns {boolean} True if the avatar's state changed (e.g., started walking or emote cleared), false otherwise.
     */
    moveTo(targetGridX, targetGridY, room, deferredAction = null) {
        if (!SHARED_CONFIG_REF) return false;
        if (this.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
            console.log(`${this.name} cannot move while sitting.`);
            return false;
        }

        let stateChangedByEmoteClear = false;
        if (this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING) {
             // Clear emote timer AND reset state (to IDLE or WALKING based on path presence)
            this.clearEmote(true);
            stateChangedByEmoteClear = true; // Indicate that state *definitely* changed due to emote clear
        }
        this.actionAfterPath = null; // Clear previous deferred action

        const startX = Math.round(this.x);
        const startY = Math.round(this.y);
        const endX = Math.round(targetGridX);
        const endY = Math.round(targetGridY);

        // Check if already at the target
        if (startX === endX && startY === endY) {
            const oldState = this.state;
            let stateChangedByAction = false;
            this.path = []; // Clear any residual path

            if (deferredAction) {
                 this.actionAfterPath = deferredAction; // Temporarily set to execute now
                 if (this.actionAfterPath.type === 'sit') {
                     const furni = room.getFurnitureById(this.actionAfterPath.targetId);
                     if (furni && furni.canSit && !room.isFurnitureOccupied(furni.id)) {
                         if (this.executeSit(furni, room)) stateChangedByAction = true;
                     }
                 } else if (this.actionAfterPath.type === 'door') {
                      // Door action should be handled by caller/update loop, not directly here
                      console.warn("moveTo: Reached target which is a door entry point, but cannot trigger change directly. Action remains pending.");
                       // Keep actionAfterPath set so updateMovement can trigger it
                       // Fall through to set state to idle for now.
                 }
                 // Clear action if executed or if it's not a type handled immediately
                 if (this.actionAfterPath?.type !== 'door') {
                      this.actionAfterPath = null;
                 }
            }

            // If state isn't sitting after potential action, set to idle
            if (this.state !== SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
                this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
                // State changed if it wasn't idle before OR if action set state OR if emote was cleared
                return stateChangedByAction || (oldState !== SHARED_CONFIG_REF.AVATAR_STATE_IDLE) || stateChangedByEmoteClear;
            }
             // If state IS sitting, return true if action set it or emote was cleared
            return stateChangedByAction || stateChangedByEmoteClear;
        }

        // Find path using the room's pathfinder
        const newPath = room.pathfinder.findPath(startX, startY, endX, endY);

        if (newPath && newPath.length > 0) {
            // Remove starting node if it's the current location
            if (newPath[0].x === startX && newPath[0].y === startY) {
                newPath.shift();
            }

            if (newPath.length > 0) {
                // --- Valid path found, start walking ---
                this.path = newPath;
                const oldState = this.state;
                this.state = SHARED_CONFIG_REF.AVATAR_STATE_WALKING;
                this.targetX = endX; // Store final target grid coords
                this.targetY = endY;
                this.actionAfterPath = deferredAction; // Store action for later execution upon arrival
                // Set initial direction towards the first step
                this.updateDirection(this.path[0].x - this.x, this.path[0].y - this.y);
                // Return true if state changed (e.g., from idle to walking) OR if emote was cleared
                return (this.state !== oldState) || stateChangedByEmoteClear;
            } else {
                // Path found, but only contains start tile (we are already there)
                // Treat same as initial check: handle deferred action now
                const oldState = this.state;
                let stateChangedByAction = false;
                this.path = [];
                if (deferredAction) {
                    this.actionAfterPath = deferredAction;
                     if (this.actionAfterPath.type === 'sit') { /* ... try sit ... */ }
                     else if (this.actionAfterPath.type === 'door') { /* ... keep action pending ... */ }
                     if (this.actionAfterPath?.type !== 'door') this.actionAfterPath = null;
                }
                if (this.state !== SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
                     this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
                     return stateChangedByAction || (oldState !== SHARED_CONFIG_REF.AVATAR_STATE_IDLE) || stateChangedByEmoteClear;
                }
                return stateChangedByAction || stateChangedByEmoteClear;
            }
        } else {
            // --- No path found ---
            const oldState = this.state;
            this.path = [];
            this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // Ensure idle state
            this.actionAfterPath = null;
            console.log(`No path found for ${this.name} to (${endX},${endY}). State -> idle`);
            // Return true if state changed (e.g., was walking but path failed) OR if emote was cleared
            return (this.state !== oldState) || stateChangedByEmoteClear;
        }
    }

    /**
     * Executes the sit action on a given piece of furniture.
     * @param {ServerFurniture} furniture - The furniture to sit on.
     * @param {ServerRoom} room - The room context (unused here but good practice).
     * @returns {boolean} True if the avatar successfully sat down (state changed), false otherwise.
     */
    executeSit(furniture, room) { // room context might be useful later
        if (!SHARED_CONFIG_REF) return false;
        // Cannot sit if already sitting or furniture invalid/missing
        if (this.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING || !furniture) return false;

        this.clearEmote(true); // Clear any active emote AND reset state first

        const oldState = this.state; // State should be idle now after clearEmote(true)
        this.state = SHARED_CONFIG_REF.AVATAR_STATE_SITTING;
        this.path = []; // Clear path
        this.actionAfterPath = null;

        // Set avatar position and Z based on furniture
        this.z = furniture.z + furniture.sitHeightOffset;
        this.x = furniture.x; // Snap to furniture center for visual consistency
        this.y = furniture.y;

        // Set direction based on furniture's sit direction and rotation
        this.direction = rotateDirectionFunc(furniture.sitDir, furniture.rotation);
        this.sittingOnFurniId = furniture.id; // Link avatar to furniture

        return this.state !== oldState; // Return true if state changed from idle/walking to sitting
    }

    /**
     * Executes the stand action. Finds a walkable adjacent tile if possible.
     * @param {ServerRoom} room - The room context for finding a walkable stand position.
     * @returns {boolean} True if the avatar successfully stood up (state changed), false otherwise.
     */
    executeStand(room) {
        if (!SHARED_CONFIG_REF) return false;
        if (this.state !== SHARED_CONFIG_REF.AVATAR_STATE_SITTING) return false; // Can only stand if sitting

        this.clearEmote(false); // Clear any emote timer, don't reset state yet

        const oldState = this.state;
        const oldFurniId = this.sittingOnFurniId;
        const furni = room?.getFurnitureById(oldFurniId); // Find the furniture they were on

        // Reset avatar state regardless of finding a spot
        this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
        this.z = SHARED_CONFIG_REF.AVATAR_DEFAULT_Z; // Reset Z to floor level
        this.sittingOnFurniId = null; // Unlink from furniture

        let movedToAdjacent = false;
        if (furni && room) {
            // Try to find a walkable tile adjacent to the furniture's base
            const standOffsets = [
                { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, // Cardinal
                { dx: -1, dy: 1 }, { dx: 1, dy: 1 }, { dx: -1, dy: -1 }, { dx: 1, dy: -1 } // Diagonal
            ];
            const currentFurniX = Math.round(furni.x);
            const currentFurniY = Math.round(furni.y);

            for (const offset of standOffsets) {
                const standX = currentFurniX + offset.dx;
                const standY = currentFurniY + offset.dy;
                // Check walkability in the provided room context
                if (room.isWalkable(standX, standY)) {
                    this.x = standX; // Move avatar to the valid spot
                    this.y = standY;
                    movedToAdjacent = true;
                    break; // Found a spot, stop searching
                }
            }
        }

        // If no adjacent spot found, place avatar at furniture's base coords (might be unwalkable)
        if (!movedToAdjacent) {
            if (furni) {
                 this.x = furni.x; this.y = furni.y;
            } else {
                 // If original furniture is gone, avatar position remains where it was (now possibly invalid)
                 console.warn(`${this.name} stood up but original furniture (ID: ${oldFurniId}) not found. Avatar remains at (${this.x}, ${this.y}).`);
            }
        }
        // Return true because state changed from sitting to idle
        return true;
    }

    /**
     * Starts an emote action for a fixed duration based on definition.
     * Sets state to 'emoting', stores emoteId, schedules state reset.
     * @param {string} emoteId - The ID of the emote from EMOTE_DEFINITIONS.
     * @param {SocketIO.Server} ioInstance - The Socket.IO server instance (needed for broadcast on timeout).
     * @returns {boolean} True if the emote started successfully, false otherwise.
     */
    executeEmote(emoteId, ioInstance) {
         if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) return false;
        const emoteDef = SHARED_CONFIG_REF.EMOTE_DEFINITIONS[emoteId];
        if (!emoteDef) {
            console.warn(`${this.name} tried unknown emote: ${emoteId}`);
            return false;
        }

        // Don't start emote if already emoting or sitting
        if (this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING || this.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
            return false;
        }

        const oldState = this.state;
        this.state = SHARED_CONFIG_REF.AVATAR_STATE_EMOTING;
        this.currentEmoteId = emoteId; // Store the active emote ID
        // console.log(`${this.name} started emoting: ${emoteId}.`);

        this.clearEmote(false); // Clear previous timer only, don't reset state yet

        // Use duration from emote definition, fallback to server default
        const duration = emoteDef.duration || SERVER_CONFIG_REF.EMOTE_DURATION_SERVER;

        this.emoteTimeout = setTimeout(() => {
            // Check if still performing the *same* emote when timer fires
            if (this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING && this.currentEmoteId === emoteId) {
                // Determine state to return to (Idle, unless path pending)
                this.state = (this.path?.length > 0) ? SHARED_CONFIG_REF.AVATAR_STATE_WALKING : SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
                // console.log(`${this.name} finished emoting ${this.currentEmoteId}. State -> ${this.state}`);
                this.currentEmoteId = null; // Clear active emote ID
                this.emoteTimeout = null;

                // Broadcast the state update (DTO will no longer include emoteId)
                // We need the room context here, which isn't available directly in setTimeout
                // The game loop or socket handler needs to detect this state change or
                // ioInstance needs to be the global one, and we need the room ID.
                if (ioInstance && this.roomId) {
                     ioInstance.to(this.roomId).emit('avatar_update', this.toDTO());
                } else {
                     console.warn("Cannot broadcast emote end: ioInstance or avatar.roomId missing.");
                }
            }
        }, duration);

        return true; // Return true because state changed from idle/walking to emoting
    }

    /**
     * Clears any active server-side emote timeout. Optionally resets state immediately.
     * @param {boolean} resetState - If true, also immediately sets state back to idle/walking and clears currentEmoteId.
     */
    clearEmote(resetState = false) {
         if (!SHARED_CONFIG_REF) return;
        if (this.emoteTimeout) {
            clearTimeout(this.emoteTimeout);
            this.emoteTimeout = null;
        }
        if (resetState && this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING) {
             // Determine state to return to based on path presence
            this.state = (this.path?.length > 0) ? SHARED_CONFIG_REF.AVATAR_STATE_WALKING : SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
            this.currentEmoteId = null;
            // Note: Caller (e.g., moveTo, executeSit) is responsible for broadcasting state change if needed immediately.
        }
    }

    /**
     * Sets the avatar's body color.
     * @param {string} hexColor - The desired color in #RRGGBB format.
     * @returns {boolean} True if the color was valid and changed, false otherwise.
     */
    setBodyColor(hexColor) {
        if (!/^#[0-9A-F]{6}$/i.test(hexColor)) {
            console.warn(`Invalid color format for ${this.name}: ${hexColor}. Expected #RRGGBB.`);
            return false;
        }
        const upperHex = hexColor.toUpperCase();
        if (this.bodyColor === upperHex) return false; // No change needed

        this.bodyColor = upperHex;
        return true; // Color changed
    }

    /**
     * Adds currency to the avatar.
     * @param {number} amount - Amount to add (must be positive integer).
     * @returns {boolean} True if currency was added.
     */
    addCurrency(amount) {
        const amountInt = Math.floor(amount);
        if (typeof amountInt !== 'number' || amountInt <= 0 || isNaN(amountInt)) return false;
        this.currency += amountInt;
        console.log(`Currency: Added ${amountInt} to ${this.name}. New total: ${this.currency}`);
        return true;
    }

    /**
     * Removes currency if sufficient funds exist.
     * @param {number} amount - Amount to remove (must be positive integer).
     * @returns {boolean} True if currency was removed, false if insufficient funds or invalid amount.
     */
    removeCurrency(amount) {
        const amountInt = Math.floor(amount);
        if (typeof amountInt !== 'number' || amountInt <= 0 || isNaN(amountInt)) return false;
        if (this.currency >= amountInt) {
            this.currency -= amountInt;
            console.log(`Currency: Removed ${amountInt} from ${this.name}. New total: ${this.currency}`);
            return true;
        }
        console.log(`Currency: Failed to remove ${amountInt} from ${this.name}. Only have ${this.currency}`);
        return false; // Insufficient funds
    }

    /**
     * Prepares the avatar for a room change. Resets state, position, etc.
     * @param {string} newRoomId - The ID of the room being entered.
     * @param {number} targetX - The target X coordinate in the new room.
     * @param {number} targetY - The target Y coordinate in the new room.
     */
    prepareForRoomChange(newRoomId, targetX, targetY) {
         if (!SHARED_CONFIG_REF) return;
        console.log(`${this.name} (ID: ${this.id}) preparing for room change to ${newRoomId} at (${targetX}, ${targetY})`);
        // Reset state and movement
        this.clearEmote(true); // Stop emote and reset state to idle/walking
        this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // Force idle on room change
        this.path = [];
        this.actionAfterPath = null;
        this.targetX = targetX; // Store target for potential immediate interpolation
        this.targetY = targetY;
        this.sittingOnFurniId = null; // Cannot be sitting after room change

        // Set new position and room ID
        this.x = targetX;
        this.y = targetY;
        this.z = SHARED_CONFIG_REF.AVATAR_DEFAULT_Z; // Reset Z to default floor level
        this.roomId = newRoomId; // Update room ID
    }
}

// Node.js export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ServerGameObject,
        ServerFurniture,
        ServerAvatar,
        // Expose config refs if needed by other modules requiring this one
        // This is generally not ideal, dependency injection is better
        // _SHARED_CONFIG_REF: SHARED_CONFIG_REF,
        // _SERVER_CONFIG_REF: SERVER_CONFIG_REF,
    };
}