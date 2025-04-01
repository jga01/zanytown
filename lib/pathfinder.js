'use strict';

const { SERVER_CONFIG } = require('./config');

/**
 * Simple A* Pathfinder for the server room grid.
 */
class Pathfinder {
    constructor(room) {
        this.room = room; // Reference to the ServerRoom instance for checking walkability
    }

    // Node structure for A*
    Node = class {
        constructor(x, y, parent = null, g = 0, h = 0) {
            this.x = x;
            this.y = y;
            this.parent = parent;
            this.g = g; // Cost from start
            this.h = h; // Heuristic cost to end
            this.f = g + h; // Total estimated cost
            this.key = `${x},${y}`; // Unique key for map/set lookups
        }
    };

    // Heuristic function (Manhattan distance)
    heuristic(nodeA, nodeB) {
        const dx = Math.abs(nodeA.x - nodeB.x);
        const dy = Math.abs(nodeA.y - nodeB.y);
        return (dx + dy);
    }

    /**
     * Finds a path from (startX, startY) to (endX, endY) using A*.
     * @param {number} startX - Starting grid X.
     * @param {number} startY - Starting grid Y.
     * @param {number} endX - Target grid X.
     * @param {number} endY - Target grid Y.
     * @returns {Array<{x: number, y: number}> | null} The path as an array of points (including start, excluding end if same), or null if no path found.
     */
    findPath(startX, startY, endX, endY) {
        const startNode = new this.Node(startX, startY, null, 0, this.heuristic({ x: startX, y: startY }, { x: endX, y: endY }));
        const endNodeCoords = { x: endX, y: endY };

        // Using Map for open list allows efficient updates of node costs
        const openListMap = new Map();
        openListMap.set(startNode.key, startNode);

        const closedList = new Set(); // Stores keys of visited nodes

        // Safety limit to prevent infinite loops in case of errors
        const maxNodes = (this.room.cols || SERVER_CONFIG.DEFAULT_ROOM_COLS) * (this.room.rows || SERVER_CONFIG.DEFAULT_ROOM_ROWS) * 2;
        let count = 0;

        while (openListMap.size > 0 && count < maxNodes) {
            count++;
            // Find the node with the lowest f score in the open list
            let currentNode = null;
            let lowestF = Infinity;
            for (const node of openListMap.values()) {
                if (node.f < lowestF) {
                    lowestF = node.f;
                    currentNode = node;
                }
            }

            // Path blocked or error
            if (!currentNode) break;

            // Move current node from open to closed list
            openListMap.delete(currentNode.key);
            closedList.add(currentNode.key);

            // --- Goal Check ---
            if (currentNode.x === endX && currentNode.y === endY) {
                return this.reconstructPath(currentNode);
            }

            // --- Explore Neighbors ---
            const neighbors = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }]; // N, S, W, E
            for (const move of neighbors) {
                const neighborX = currentNode.x + move.x;
                const neighborY = currentNode.y + move.y;
                const neighborKey = `${neighborX},${neighborY}`;

                // Skip if already evaluated or unwalkable
                if (closedList.has(neighborKey)) continue;
                if (!this.room.isWalkable(neighborX, neighborY)) continue;

                // Calculate costs for neighbor
                const moveCost = 1; // Uniform cost for adjacent tiles
                const gCost = currentNode.g + moveCost;
                const hCost = this.heuristic({ x: neighborX, y: neighborY }, endNodeCoords);
                const fCost = gCost + hCost;

                const existingNode = openListMap.get(neighborKey);
                if (existingNode) {
                    // If found a better path to this neighbor, update it
                    if (gCost < existingNode.g) {
                        existingNode.parent = currentNode;
                        existingNode.g = gCost;
                        existingNode.f = fCost;
                    }
                } else {
                    // Otherwise, add new neighbor node to open list
                    openListMap.set(neighborKey, new this.Node(neighborX, neighborY, currentNode, gCost, hCost));
                }
            }
        }

        // console.warn(`Server A* Pathfinding: No path found from (${startX},${startY}) to (${endX},${endY}) or limit reached (${count} nodes).`); // Can be noisy
        return null; // No path found
    }

    // Backtrack from the end node to construct the path
    reconstructPath(endNode) {
        const path = [];
        let temp = endNode;
        while (temp !== null) {
            path.push({ x: temp.x, y: temp.y });
            temp = temp.parent;
        }
        return path.reverse(); // Return path from start to end
    }
}

// Node.js export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Pathfinder;
}