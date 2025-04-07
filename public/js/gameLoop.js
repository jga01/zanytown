import { CLIENT_CONFIG } from "./config.js";
import { gameState, uiState } from "./gameState.js";
import { renderGame } from "./renderer.js";
import { handleHeldKeys, updateMouseWorldPosition } from "./inputHandler.js";
import {
  updateHighlights,
  updateDebugInfo,
  updateChatBubbles,
  updateUICursor,
} from "./uiManager.js";
import { ClientAvatar } from "./gameObjects/ClientAvatar.js"; // Needed for interpolation target type
import { ClientFurniture } from "./gameObjects/ClientFurniture.js"; // Needed for interpolation target type

let lastTimestamp = 0;
let animationFrameId = null; // To store the request ID for cancellation

/** Starts the game loop if it's not already running. */
export function startGameLoop() {
  if (animationFrameId) {
    console.warn("Attempted to start game loop, but it's already running.");
    return;
  }
  console.log("Starting game loop...");
  lastTimestamp = performance.now(); // Initialize timestamp
  // Use bind to ensure 'this' context is correct if gameLoop were a class method
  animationFrameId = requestAnimationFrame(gameLoop);
}

/** Stops the game loop. */
export function stopGameLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null; // Clear the ID
    console.log("Game loop stopped.");
  } else {
    // console.log("Game loop already stopped.");
  }
}

/** The main loop function, called recursively via requestAnimationFrame. */
function gameLoop(timestamp) {
  // --- Loop Control ---
  // Immediately schedule the next frame. If this frame takes too long, the browser
  // might skip the next scheduled frame, effectively throttling the loop.
  animationFrameId = requestAnimationFrame(gameLoop);

  // --- Prerequisites Check ---
  // Don't run update/render logic until client config is loaded
  if (!CLIENT_CONFIG) {
    // console.log("Game loop waiting for CLIENT_CONFIG..."); // Can be noisy
    return;
  }

  // --- Delta Time Calculation ---
  const deltaTimeMs = timestamp - lastTimestamp;
  lastTimestamp = timestamp;
  // Cap delta time to prevent large jumps if the tab was inactive or performance dips
  const cappedDeltaTimeMs = Math.min(deltaTimeMs, 100); // Max step of 100ms (equiv. to 10 FPS min)

  // Calculate interpolation factor based on capped delta time and target frame rate (e.g., 60 FPS)
  // This makes interpolation speed consistent regardless of actual frame rate.
  const interpolationFactor =
    1.0 -
    Math.pow(
      1.0 - CLIENT_CONFIG.INTERPOLATION_FACTOR, // Base factor per target frame
      cappedDeltaTimeMs / (1000 / 60) // Scale factor based on actual time elapsed vs target frame time
    );
  const clampedInterpolationFactor = Math.max(
    0,
    Math.min(1, interpolationFactor)
  ); // Ensure factor stays within [0, 1]

  // --- Update Phase ---
  // Process continuous input (like held keys for panning)
  handleHeldKeys();

  // Update mouse world/grid position based on current screen pos and camera
  updateMouseWorldPosition();

  // Interpolate visual positions of game objects
  Object.values(gameState.avatars || {}).forEach((a) => {
    if (a instanceof ClientAvatar && typeof a.interpolate === "function") {
      a.interpolate(clampedInterpolationFactor);
    }
  });
  Object.values(gameState.furniture || {}).forEach((f) => {
    if (f instanceof ClientFurniture && typeof f.interpolate === "function") {
      f.interpolate(clampedInterpolationFactor);
    }
  });

  // Update UI elements that change over time or depend on game state
  updateHighlights(); // Tile/furniture highlights based on mouse/mode
  updateChatBubbles(Date.now()); // Update chat bubble positions & expiry
  updateDebugInfo(); // Refresh debug panel text
  updateUICursor(); // Update main game cursor based on mode/drag state

  // --- Draw Phase ---
  renderGame(); // Call the main rendering function from renderer.js
}
