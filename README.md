# ZanyTown - Isometric Web Sandbox

![image](https://github.com/user-attachments/assets/8cdf32e6-83ea-485e-b192-137b9feeed87)

ZanyTown is a simple, browser-based isometric sandbox game where players can explore rooms, interact with furniture, chat with others, and customize their environment. Built with Node.js, Socket.IO, Express, and MongoDB.

## Features

*   **Real-time Multiplayer:** See other players move and interact in real-time using Socket.IO.
*   **Isometric View:** Classic 2.5D isometric perspective.
*   **Avatar Movement:** Click to move with A* pathfinding. Avatars interpolate smoothly between points.
*   **Furniture Interaction:**
    *   Place, rotate, and pick up furniture items.
    *   Sit on chairs.
    *   Toggle usable items (like lamps).
    *   Stack items (within limits).
    *   Recolor owned furniture with valid hex codes.
*   **Multi-Room Navigation:** Move between different rooms using interactive doors.
*   **Chat:** Global text chat with floating chat bubbles above avatars.
*   **Inventory & Currency:** Players have persistent inventories and currency (Gold).
*   **Shop:** Buy furniture items from a catalog using in-game currency.
*   **User Authentication:** Secure login and registration using JWT and bcrypt.
*   **Persistence:** Player progress (inventory, currency, position, color) and room state (furniture placement) are saved to a MongoDB database.
*   **Server Console:** Basic administrative commands via the server console (kick, give items, teleport, etc.).

## Technology Stack

*   **Backend:** Node.js, Express.js
*   **Real-time:** Socket.IO
*   **Database:** MongoDB with Mongoose ODM
*   **Authentication:** JSON Web Tokens (JWT), bcrypt
*   **Frontend:** HTML5 Canvas, CSS3, Vanilla JavaScript
*   **Environment:** dotenv

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes.

### Prerequisites

*   **Node.js & npm:** Download and install from [nodejs.org](https://nodejs.org/). (Includes npm)
*   **MongoDB:** Download and install from [mongodb.com](https://www.mongodb.com/try/download/community) or use a cloud service like MongoDB Atlas. Ensure your MongoDB server is running.

### Installation & Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/your-repository-name.git
    cd your-repository-name
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**
    Create a `.env` file in the root directory of the project. Copy the contents of `.env.example` (if provided) or add the following variables, replacing the placeholders with your actual values:

    ```dotenv
    # Database connection string
    DATABASE_URL=mongodb://localhost:27017/zanytown # Replace with your MongoDB connection string

    # JWT Secret Key (Choose a strong, random string)
    JWT_SECRET=your_super_secret_jwt_key_here

    # Port for the server to run on (optional, defaults to 3000)
    PORT=3000

    # Bcrypt Salt Rounds (optional, defaults to 10)
    BCRYPT_SALT_ROUNDS=10
    ```
    *   **`DATABASE_URL`**: Your MongoDB connection string.
    *   **`JWT_SECRET`**: A strong, secret key for signing authentication tokens. Keep this private!

4.  **Run the server:**
    ```bash
    npm start
    ```
    (This assumes you have a `start` script in your `package.json` like `"start": "node server.js"`. If not, use `node server.js` directly.)

5.  **Access the game:**
    Open your web browser and navigate to `http://localhost:3000` (or the port you specified in `.env`). You should be redirected to the login/register page (`/login.html`).

## Project Structure

```
.
├── lib/                # Core backend game logic
│   ├── config.js       # Shared and Server configurations (furniture defs, etc.)
│   ├── db.js           # MongoDB connection setup
│   ├── game_objects.js # Server-side classes (Avatar, Furniture)
│   ├── pathfinder.js   # A* Pathfinding logic
│   ├── room.js         # Server-side room management (DB interaction)
│   └── utils.js        # Utility functions (e.g., rotateDirection)
├── models/             # Mongoose schemas/models
│   ├── furniture.js    # Furniture item schema
│   ├── roomState.js    # Room layout/metadata schema
│   └── user.js         # User schema (auth, player state)
├── public/             # Client-side files served to the browser
│   ├── js/
│   │   └── auth.js     # Login/Register page logic
│   ├── sounds/         # Sound effects (placeholders)
│   ├── client.js       # Main client-side game logic
│   ├── index.html      # Main game page HTML
│   ├── login.html      # Login/Register page HTML
│   └── style.css       # Stylesheet for the game
├── routes/             # Express route definitions
│   └── authRoutes.js   # Login/Register API endpoints
├── .env                # Environment variables (ignored by Git)
├── .gitignore          # Files/folders ignored by Git
├── package.json        # Project dependencies and scripts
├── server.js           # Main server entry point (Express, Socket.IO setup)
├── server_console.js   # Server-side console command handler
└── server_socket_handlers.js # Socket.IO event handlers
```

## Gameplay & Controls

*   **Movement:** Left-click on a walkable tile to move your avatar.
*   **Interaction:**
    *   Left-click on usable furniture (e.g., lamps) to toggle them.
    *   Left-click on sittable furniture (chairs) to sit.
    *   Left-click on yourself while sitting to stand up.
    *   Left-click on doors to change rooms.
    *   Left-click on other players to view their profile (basic info).
*   **Chat:** Type messages in the chat input box at the bottom right and press Enter.
*   **Commands:** Type `/` followed by a command in the chat box:
    *   `/wave`, `/dance`, `/happy`, `/sad`: Perform an emote.
    *   `/emote <emote_id>`: Perform a specific emote by ID.
    *   `/setcolor #RRGGBB`: Change your avatar's body color (e.g., `/setcolor #FF0000`).
    *   `/join <room_id>`: Attempt to join a different room.
*   **Camera:**
    *   Middle-click + Drag OR Right-click + Drag to pan the camera.
    *   Mouse Wheel Scroll Up/Down OR use Zoom In/Out buttons to zoom.
*   **Edit Mode:**
    *   Press `E` or click the "Room Edit" button to toggle Edit Mode.
    *   **Placing:** Click an item in your inventory, then click a valid tile on the floor. Press `R` to rotate the placement ghost.
    *   **Selecting:** Click furniture on the floor to select it.
    *   **Moving:** (Currently not implemented directly - Pick up and re-place)
    *   **Rotating:** Select furniture, then press `R` to rotate it.
    *   **Picking Up:** Select furniture, then click the "Pick Up" button or press `Delete`/`Backspace`.
    *   **Recoloring:** Select owned, recolorable furniture, click the "Recolor" button, and choose a color swatch. Click "Reset Color" to revert to default.
*   **Shop:** Click the "Shop" button to open the catalog. Click "Buy" on an item if you have enough gold.
*   **Logout:** Click the "Logout" button.

## License

Copyright © 2025 Tiago Goossen de Andrade. All rights reserved.

```

**Remember to:**

1.  **Replace Placeholders:**
    *   Add a cool screenshot or GIF at the top.
    *   Update the `git clone` URL with your actual repository URL.
    *   Choose and add a `LICENSE` file if you haven't already.
2.  **Verify `package.json` Scripts:** Ensure the `npm start` command works, or provide the correct command (e.g., `node server.js`).
3.  **Create `.env.example`:** It's good practice to have an `.env.example` file showing the required variables, excluding the actual secrets.
4.  **Add Sounds:** Make sure the sound files referenced in `client.js` (e.g., `sounds/step.wav`, `sounds/place.mp3`) actually exist in the `public/sounds/` directory.
5.  **Review and Customize:** Read through the generated README and adjust any details to better fit your project's specifics or future plans.