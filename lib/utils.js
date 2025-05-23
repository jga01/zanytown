"use strict";

/**
 * Rotates a direction value (0-7) by a given amount, wrapping around.
 * @param {number} currentDir - The current direction (0-7).
 * @param {number} amount - The amount to rotate by (positive or negative).
 * @returns {number} The new direction (0-7).
 */
function rotateDirection(currentDir, amount) {
  return (currentDir + amount + 8) % 8;
}

function escapeHtml(unsafe) {
  if (typeof unsafe !== "string") return unsafe;
  return unsafe
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "'");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    rotateDirection,
    escapeHtml,
  };
}
