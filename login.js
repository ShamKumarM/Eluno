// -------------------------------------------------------------
// ELUNO AI SYSTEM - AUTHENTICATION & SESSION MANAGEMENT LOGIC
// -------------------------------------------------------------

let supabaseClient = null;
let currentMode = "signin"; // "signin" or "signup"

// Toast Notification System
function showToast(title, message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div>
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${message}</div>
    </div>
  `;
  container.appendChild(toast);

  // Auto remove after 4 seconds
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.4s ease";
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// Initialize Supabase from FastAPI Configuration Endpoint
async function initSupabase() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("Failed to fetch configuration from backend.");
    
    const config = await res.json();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error("Supabase is not configured on the backend server.");
    }
    
    // Initialize Supabase Client using global cdn window object
    const { createClient } = supabase;
    supabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey);
    
    // Check if user is already logged in
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      // User has a valid session, redirect directly to dashboard
      window.location.href = "index.html";
    }
  } catch (error) {
    console.error("Initialization Error:", error);
    showToast(
      "Configuration Required", 
      "Backend server requires valid Supabase credentials. Check your .env file.", 
      "danger"
    );
  }
}

// Set up event listeners for forms and tabs
document.addEventListener("DOMContentLoaded", () => {
  initSupabase();

  const tabSignInBtn = document.getElementById("tab-signin");
  const tabSignUpBtn = document.getElementById("tab-signup");
  const groupFullName = document.getElementById("group-fullname");
  const groupRole = document.getElementById("group-role");
  const authForm = document.getElementById("auth-form");
  const authSubmitBtn = document.getElementById("auth-submit-btn");
  const authBtnText = document.getElementById("auth-btn-text");

  // Tab switching: Sign In
  tabSignInBtn.addEventListener("click", () => {
    currentMode = "signin";
    tabSignInBtn.classList.add("active");
    tabSignUpBtn.classList.remove("active");
    groupFullName.classList.add("hidden");
    groupRole.classList.add("hidden");
    authBtnText.textContent = "Authenticate Operator";
    
    // Change submit button icon
    const iconSpan = authSubmitBtn.querySelector("i");
    if (iconSpan) {
      iconSpan.setAttribute("data-lucide", "log-in");
      lucide.createIcons();
    }
  });

  // Tab switching: Sign Up
  tabSignUpBtn.addEventListener("click", () => {
    currentMode = "signup";
    tabSignUpBtn.classList.add("active");
    tabSignInBtn.classList.remove("active");
    groupFullName.classList.remove("hidden");
    groupRole.classList.remove("hidden");
    authBtnText.textContent = "Create Operator Account";

    // Change submit button icon
    const iconSpan = authSubmitBtn.querySelector("i");
    if (iconSpan) {
      iconSpan.setAttribute("data-lucide", "user-plus");
      lucide.createIcons();
    }
  });

  // Form submission handler
  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    if (!supabaseClient) {
      showToast("Authentication Error", "Supabase SDK is not initialized.", "danger");
      return;
    }

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const fullName = document.getElementById("fullname").value.trim();
    const role = document.getElementById("user-role").value;

    authSubmitBtn.disabled = true;
    authBtnText.textContent = currentMode === "signin" ? "Authenticating..." : "Registering Account...";

    try {
      if (currentMode === "signin") {
        // Sign in with password
        const { data, error } = await supabaseClient.auth.signInWithPassword({
          email,
          password
        });

        if (error) throw error;

        showToast("Access Granted", "Operator authentication successful. Redirecting...", "success");
        setTimeout(() => {
          window.location.href = "index.html";
        }, 1200);

      } else {
        // Sign up and record metadata (triggers db profiles creation)
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName || "System Operator",
              role: role || "operator"
            }
          }
        });

        if (error) throw error;

        // Check if email confirmation is required or if we are signed in automatically
        if (data.session) {
          showToast("Account Created", "Registration successful. Access granted.", "success");
          setTimeout(() => {
            window.location.href = "index.html";
          }, 1200);
        } else {
          showToast(
            "Confirmation Sent", 
            "Operator registered. Please check email for activation instructions.", 
            "success"
          );
          authForm.reset();
        }
      }
    } catch (err) {
      showToast("Authentication Failure", err.message || "An unexpected error occurred.", "danger");
      authSubmitBtn.disabled = false;
      authBtnText.textContent = currentMode === "signin" ? "Authenticate Operator" : "Create Operator Account";
    }
  });
});
