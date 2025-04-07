import { SHARED_CONFIG } from "./config.js";

// Store Audio objects
const sounds = {
  // Basic sounds
  walk: null,
  place: null,
  chat: null,
  use: null,
  // Emote sounds will be populated from config
};
// Keep track of sounds that failed to load to avoid repeated warnings
const loadErrors = new Set();
// Cache warnings for playing unloaded sounds to avoid console spam
const playWarnings = {};

/** Loads all defined sound effects. */
export function loadSounds() {
  console.log("Loading sounds...");

  const loadSound = (name, path, volume = 0.5) => {
    if (sounds[name] !== undefined && sounds[name] !== null) return; // Already loaded or loading

    try {
      const audio = new Audio(path);
      audio.volume = volume;
      // Optional: Preload attempt (may not always work due to browser restrictions)
      // audio.preload = 'auto';
      // audio.load();
      sounds[name] = audio;
    } catch (e) {
      if (!loadErrors.has(name)) {
        console.warn(`Sound load failed for '${name}' at ${path}:`, e.message);
        loadErrors.add(name);
      }
      sounds[name] = null; // Ensure it's null if failed
    }
  };

  // Load basic sounds
  loadSound("walk", "sounds/step.wav", 0.4);
  loadSound("place", "sounds/place.mp3", 0.6);
  loadSound("chat", "sounds/chat.mp3", 0.5);
  loadSound("use", "sounds/use.wav", 0.7);

  // Load emote sounds from SHARED_CONFIG
  if (SHARED_CONFIG?.EMOTE_DEFINITIONS) {
    Object.values(SHARED_CONFIG.EMOTE_DEFINITIONS).forEach((emoteDef) => {
      if (emoteDef.sound && sounds[emoteDef.sound] === undefined) {
        // Only load if not explicitly defined above and not already loaded
        let ext = ".wav"; // Default extension
        // Add more specific extensions if needed based on sound names
        if (emoteDef.sound === "dance") ext = ".mp3";
        const path = `sounds/${emoteDef.sound}${ext}`;
        loadSound(emoteDef.sound, path, 0.6);
      }
    });
  } else {
    console.warn(
      "Cannot load emote sounds: SHARED_CONFIG.EMOTE_DEFINITIONS not available."
    );
  }
  console.log("Sound loading process initiated.");
}

/** Attempts to play a loaded sound effect. Handles potential browser restrictions. */
export function playSound(soundName) {
  const sound = sounds[soundName];

  if (sound) {
    // Attempt to play, handle user interaction requirement errors
    sound.currentTime = 0; // Rewind before playing
    sound.play().catch((error) => {
      // Common error: NotAllowedError if user hasn't interacted with the page yet
      if (error.name === "NotAllowedError") {
        if (!playWarnings[soundName]) {
          // Show warning only once per sound
          console.warn(
            `Playback prevented for '${soundName}': User interaction required first.`
          );
          playWarnings[soundName] = true;
        }
      } else if (!playWarnings[soundName]) {
        // Log other errors once
        console.warn(
          `Sound play failed for '${soundName}':`,
          error.name,
          error.message
        );
        playWarnings[soundName] = true;
      }
    });
  } else {
    // Sound is null (failed to load) or not defined
    if (!playWarnings[soundName] && !loadErrors.has(soundName)) {
      // Avoid warning if load already failed
      console.warn(
        `Attempted to play undefined or unloaded sound: ${soundName}`
      );
      playWarnings[soundName] = true;
    }
  }
}
