document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("login-form");
  const registerForm = document.getElementById("register-form");
  const loginErrorDiv = document.getElementById("login-error");
  const registerErrorDiv = document.getElementById("register-error");
  const registerSuccessDiv = document.getElementById("register-success");

  // --- Helper to display errors ---
  function displayError(element, message) {
    if (element) {
      element.textContent = message || ""; // Clear if message is empty/null
    }
  }

  // --- Login Handler ---
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault(); // Prevent default page reload
      displayError(loginErrorDiv); // Clear previous errors
      displayError(registerSuccessDiv); // Clear registration success message

      const usernameInput = document.getElementById("login-username");
      const passwordInput = document.getElementById("login-password");

      const username = usernameInput.value.trim();
      const password = passwordInput.value.trim();

      if (!username || !password) {
        displayError(loginErrorDiv, "Please enter both username and password.");
        return;
      }

      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ username, password }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.message || `HTTP error! status: ${response.status}`
          );
        }

        // --- Login Success ---
        console.log("Login successful:", data);
        if (data.token) {
          localStorage.setItem("authToken", data.token); // Store the JWT
          // Redirect to the main game page
          window.location.href = "/"; // Or '/index.html'
        } else {
          throw new Error("Login successful, but no token received.");
        }
      } catch (error) {
        console.error("Login failed:", error);
        displayError(
          loginErrorDiv,
          error.message || "Login failed. Please try again."
        );
        // Clear inputs on failure? Maybe not password.
        // passwordInput.value = '';
      }
    });
  }

  // --- Registration Handler ---
  if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      displayError(registerErrorDiv); // Clear previous errors
      displayError(registerSuccessDiv); // Clear previous success message

      const usernameInput = document.getElementById("register-username");
      const passwordInput = document.getElementById("register-password");
      // const confirmPasswordInput = document.getElementById('register-confirm-password'); // If using confirm

      const username = usernameInput.value.trim();
      const password = passwordInput.value.trim();
      // const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value.trim() : password; // If using confirm

      if (!username || !password) {
        displayError(
          registerErrorDiv,
          "Please enter both username and password."
        );
        return;
      }
      if (password.length < 6) {
        displayError(
          registerErrorDiv,
          "Password must be at least 6 characters."
        );
        return;
      }
      // if (password !== confirmPassword) { // If using confirm
      //     displayError(registerErrorDiv, 'Passwords do not match.');
      //     return;
      // }

      try {
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ username, password }),
        });

        const data = await response.json();

        if (!response.ok) {
          // Handle specific validation errors if backend sends them
          let errorMsg =
            data.message || `HTTP error! status: ${response.status}`;
          if (data.errors) {
            // Example: combine multiple validation errors
            errorMsg = Object.values(data.errors)
              .map((err) => err.message)
              .join(" ");
          }
          throw new Error(errorMsg);
        }

        // --- Registration Success ---
        console.log("Registration successful:", data);
        registerSuccessDiv.textContent =
          data.message || "Registration successful! Please log in.";
        registerForm.reset(); // Clear the form fields
      } catch (error) {
        console.error("Registration failed:", error);
        displayError(
          registerErrorDiv,
          error.message || "Registration failed. Please try again."
        );
      }
    });
  }

  // --- Auto-redirect if already logged in ---
  // Optional: Check if a token exists when the login page loads.
  // If it does, maybe try to redirect immediately or show a "logged in as..." message.
  // const existingToken = localStorage.getItem('authToken');
  // if (existingToken) {
  //    // Could potentially try validating token with a dedicated backend route here
  //    // For simplicity, we'll just let the main game page handle token validation on load
  //    // console.log("Existing token found. Consider redirecting or showing status.");
  // }
}); // End DOMContentLoaded
