// -------------------------------------------------------------
// ELUNO AI OPERATIONAL CONTROL CENTER - APPLICATION LOGIC
// -------------------------------------------------------------

let orders = [];

let inventory = [];

// Current state filters
let activeTab = "dashboard";
let selectedOrderIdForUpdate = null;

// Global Supabase Client
let supabaseClient = null;

// Initialization
document.addEventListener("DOMContentLoaded", async () => {
  try {
    // 1. Fetch Supabase config from python API
    const configRes = await fetch("/api/config");
    if (!configRes.ok) throw new Error("Could not fetch server configuration.");
    const config = await configRes.json();
    
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error("Supabase URL or Anon Key is missing from backend configuration.");
    }
    
    // 2. Initialize Supabase
    const { createClient } = supabase;
    supabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey);
    
    // 3. Retrieve user session
    let session = null;
    const { data: { session: realSession }, error: sessionError } = await supabaseClient.auth.getSession();
    session = realSession;

    // Developer bypass for testing
    if (!session && (window.location.search.includes("bypass=true") || localStorage.getItem("dev_bypass") === "true")) {
      session = {
        access_token: "dummy-token",
        user: {
          user_metadata: {
            full_name: "Developer Admin",
            role: "administrator"
          }
        }
      };
      localStorage.setItem("dev_bypass", "true");
    }

    if (!session) {
      // Redirect unauthenticated operators to login page
      window.location.href = "login.html";
      return;
    }
    
    // 4. Update header user metadata
    const user = session.user;
    const fullName = user.user_metadata?.full_name || "System Operator";
    const role = user.user_metadata?.role || "operator";
    
    // Generate initials for avatar
    const initials = fullName
      .split(" ")
      .map(part => part[0])
      .join("")
      .substring(0, 3)
      .toUpperCase();
      
    document.getElementById("header-user-avatar").textContent = initials || "OPS";
    document.getElementById("header-user-name").textContent = fullName;
    document.getElementById("header-user-role").textContent = role.charAt(0).toUpperCase() + role.slice(1);
    
    // Also update Home page greetings
    const portalOpName = document.getElementById("portal-operator-name");
    const portalOpRole = document.getElementById("portal-operator-role");
    if (portalOpName) portalOpName.textContent = fullName;
    if (portalOpRole) portalOpRole.textContent = role.charAt(0).toUpperCase() + role.slice(1);
    
    // 5. Set up Logout click handler
    const handleLogout = async () => {
      localStorage.removeItem("dev_bypass");
      await supabaseClient.auth.signOut();
      window.location.href = "login.html";
    };
    document.getElementById("btn-logout").addEventListener("click", handleLogout);
    const portalLogoutBtn = document.getElementById("portal-btn-logout");
    if (portalLogoutBtn) {
      portalLogoutBtn.addEventListener("click", handleLogout);
    }
    
    // 6. User is authenticated, reveal dashboard content
    document.body.style.display = "block";
    
    // 7. Verify JWT validation with Python backend (test request)
    try {
      const token = session.access_token;
      const response = await fetch("/api/protected-data", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        console.log("Telemetry check success. Secure payload:", data);
      } else {
        console.warn("Failed to fetch protected telemetry data from Python API.");
      }
    } catch (apiErr) {
      console.warn("Could not connect to Python API:", apiErr);
    }
    
  } catch (err) {
    console.error("Authentication check failed:", err);
    window.location.href = "login.html";
    return;
  }

  // Execute standard dashboard initializers
  initNavigation();
  initClock();
  initInventory();
  initRxMatcher();
  initStatusForm();
  initHomeAnimation();

  // Initialize with home tab selector
  await switchTab('home');
  
  // Place Order form submission listener
  const placeOrderForm = document.getElementById("place-order-form");
  if (placeOrderForm) {
    placeOrderForm.addEventListener("submit", handleOrderPlacement);
  }
  
  // Initialize ThreeJS scenes
  initThreeBackground();
  initThreeLensModel();

  document.getElementById("refresh-pipeline-btn").addEventListener("click", async () => {
    await loadOrders();
    showToast("System Synced", "All manufacturing pipeline stages successfully synced with offline lab devices.", "success");
  });

  // Lucide icon replace
  lucide.createIcons();
});

// Real-time Clock & SLA Live Ticker
function initClock() {
  const clockEl = document.getElementById("live-clock");
  
  // Clock updates every second
  setInterval(() => {
    const now = new Date();
    clockEl.textContent = now.toTimeString().split(' ')[0];
  }, 1000);

  // SLA countdown updates every 60 seconds
  setInterval(() => {
    recalculateSlas();
  }, 60000);

  // Run hourly SLA breach prediction check every hour (3600000 ms)
  setInterval(() => {
    runHourlyBreachCheck();
  }, 3600000);

  // Run initial breach check 3 seconds after startup
  setTimeout(() => {
    runHourlyBreachCheck();
  }, 3000);
}

// Dynamically recalculates remaining minutes for active orders and refreshes view if changed
function recalculateSlas() {
  let changed = false;
  orders.forEach(ord => {
    if (ord.stage !== "Delivered" && ord.createdAt) {
      const createdTime = new Date(ord.createdAt);
      const targetTime = new Date(createdTime.getTime() + ord.slaTotal * 60 * 1000);
      const now = new Date();
      const newSla = Math.round((targetTime.getTime() - now.getTime()) / (60 * 1000));
      if (ord.slaRemaining !== newSla) {
        ord.slaRemaining = newSla;
        changed = true;
      }
    } else if (ord.stage === "Delivered" && ord.slaRemaining !== 0) {
      ord.slaRemaining = 0;
      changed = true;
    }
  });

  if (changed) {
    if (activeTab === "orders") {
      initTable();
    }
    if (activeTab === "dashboard") {
      updateDashboardKPIs();
      initPredictions();
    }
  }
}

// Hourly check to predict SLA breach risk and force delay reasons if >65%
async function runHourlyBreachCheck() {
  console.log("Running hourly SLA breach risk check...");
  try {
    const session = (await supabaseClient.auth.getSession()).data.session;
    const token = session?.access_token;
    if (!token) return;

    // Refresh orders list to get fresh predictions/values
    const response = await fetch("/api/orders", {
      headers: { "Authorization": `Bearer ${token}` }
    });

    if (response.ok) {
      const fetched = await response.json();
      orders = fetched.map(mapOrderToCamelCase);
      
      // Update UI counts and KPIs
      updatePipelineCounts();
      updateDashboardKPIs();
      if (activeTab === "orders") initTable();
      if (activeTab === "predictions") initPredictions();

      // Scan for first order that breaches the 65% threshold and lacks a logged reason
      const criticalOrder = orders.find(ord => ord.stage !== "Delivered" && ord.breachRisk > 65 && !ord.delayReason);
      if (criticalOrder) {
        showToast("High SLA Breach Risk", `Order ${criticalOrder.id} has a breach risk of ${criticalOrder.breachRisk}%. Logging reason is required.`, "danger");
        openStatusModal(criticalOrder.id, true, criticalOrder.breachRisk);
      }
    }
  } catch (err) {
    console.error("Hourly breach check failed:", err);
  }
}

// Calculate breach risk percentage for a specific order on demand
async function calculateBreachScore(orderId) {
  const btn = document.querySelector(`.btn-breach-score[data-id="${orderId}"]`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader" style="width:12px;height:12px;display:inline-block;animation:spin 1s linear infinite;"></i> Calculating...`;
    lucide.createIcons();
  }

  try {
    const session = (await supabaseClient.auth.getSession()).data.session;
    const token = session?.access_token;
    if (!token) throw new Error("No active session.");

    const response = await fetch(`/api/orders/${orderId}/predict-breach`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error("Failed to calculate breach score.");
    }

    const result = await response.json();
    
    // Find order in local list and update it
    const ord = orders.find(o => o.id === orderId);
    if (ord) {
      ord.breachRisk = result.breach_risk;
      
      // Update display in table
      initTable();

      // Show prediction toast
      showToast("Breach Risk Calculated", `Order ${orderId} has a breach risk of ${result.breach_risk}%.`, result.breach_risk > 65 ? "danger" : "success");

      // Check if breach risk is higher than 65% and delay reason is empty
      if (result.breach_risk > 65 && !ord.delayReason) {
        setTimeout(() => {
          openStatusModal(orderId, true, result.breach_risk);
        }, 800);
      }
    }
  } catch (error) {
    console.error("Error calculating breach score:", error);
    showToast("Error", error.message || "Could not calculate breach score.", "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="activity" style="width: 12px; height: 12px;"></i> Breach Score`;
      lucide.createIcons();
    }
  }
}

// Tab Switcher Navigation
async function switchTab(tabId) {
  window.scrollTo(0, 0);
  const navBtns = document.querySelectorAll(".nav-btn");
  const tabContents = document.querySelectorAll(".tab-content");
  const tabTitle = document.getElementById("current-tab-title");
  const tabSubtitle = document.getElementById("current-tab-subtitle");

  // Remove active classes
  navBtns.forEach(b => b.classList.remove("active"));
  tabContents.forEach(tc => tc.classList.remove("active"));

  // Find corresponding navbar button and highlight it
  const targetBtn = document.querySelector(`.nav-btn[data-tab="${tabId}"]`);
  if (targetBtn) targetBtn.classList.add("active");

  // Show target tab content
  const targetTab = document.getElementById(`${tabId}-tab`);
  if (targetTab) targetTab.classList.add("active");

  activeTab = tabId;

  // Toggle portal view state
  if (tabId === "home") {
    document.body.classList.add("portal-state");
    setTimeout(() => {
      if (typeof resizeCanvas === "function") resizeCanvas();
      if (typeof handleHomeScroll === "function") handleHomeScroll();
    }, 50);
  } else {
    document.body.classList.remove("portal-state");
    
    // Update headers
    const tabTitles = {
      dashboard: {
        title: "Operations Control Center",
        sub: "Real-time status overview & AI-driven bottleneck predictions"
      },
      orders: {
        title: "Order Console",
        sub: "Track lifecycle stages, filter optical criteria & log delays"
      },
      inventory: {
        title: "In-House Lens Inventory",
        sub: "Optical blanks, index limits & protective coatings stock matching"
      },
      predictions: {
        title: "TAT Predictor",
        sub: "Machine learning turnaround models & impending breach alerts"
      },
      "place-order": {
        title: "Place New Order",
        sub: "Register a new customer prescription order into the manufacturing pipeline"
      }
    };
    if (tabTitles[tabId]) {
      tabTitle.textContent = tabTitles[tabId].title;
      tabSubtitle.textContent = tabTitles[tabId].sub;
    }
  }

  // Load data as needed
  if (tabId === "orders" || tabId === "dashboard" || tabId === "predictions" || tabId === "home") {
    await loadOrders();
  }
  if (tabId === "inventory" || tabId === "home") {
    await loadInventory();
  }
  if (tabId === "orders") initTable();
  if (tabId === "inventory") initInventory();
  if (tabId === "predictions") initPredictions();

  lucide.createIcons();
}

function initNavigation() {
  const navBtns = document.querySelectorAll(".nav-btn");
  
  navBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab");
      if (tabId) switchTab(tabId);
    });
  });

  // Handle Logo click to return home
  const logoBtn = document.querySelector(".navbar-logo");
  if (logoBtn) {
    logoBtn.addEventListener("click", () => switchTab("home"));
    logoBtn.style.cursor = "pointer";
  }
}

// Helper: Format minutes into human readable hours/minutes
function formatSla(minutes) {
  if (minutes < 0) {
    const positive = Math.abs(minutes);
    const hrs = Math.floor(positive / 60);
    const mins = positive % 60;
    return `BREACHED (${hrs > 0 ? hrs + 'h ' : ''}${mins}m ago)`;
  }
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hrs > 0 ? hrs + 'h ' : ''}${mins}m remaining`;
}

// Render Order Console Table
function initTable() {
  const tableBody = document.getElementById("orders-table-body");
  const searchVal = document.getElementById("order-search").value.toLowerCase();
  const filterStatus = document.getElementById("filter-status").value;
  const filterLens = document.getElementById("filter-lens-type").value;
  const filterLoc = document.getElementById("filter-location").value;

  tableBody.innerHTML = "";

  // Apply filters
  const filtered = orders.filter(ord => {
    const matchSearch = ord.id.toLowerCase().includes(searchVal) || 
                        ord.patientName.toLowerCase().includes(searchVal) ||
                        ord.lensType.toLowerCase().includes(searchVal);
    const matchStatus = filterStatus === "all" || ord.stage === filterStatus;
    const matchLens = filterLens === "all" || ord.lensType.includes(filterLens);
    const matchLoc = filterLoc === "all" || ord.store.includes(filterLoc);

    return matchSearch && matchStatus && matchLens && matchLoc;
  });

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 32px;">No orders matched current filter set.</td></tr>`;
    return;
  }

  filtered.forEach(ord => {
    const isBreached = ord.slaRemaining < 0;
    const isAtRisk = ord.slaRemaining > 0 && ord.slaRemaining < 90; // under 1.5h
    
    let slaClass = "success-text";
    if (isBreached) slaClass = "alert-text";
    else if (isAtRisk) slaClass = "text-warning";

    // Format breach risk text and class
    let breachRiskText = ord.breachRisk !== undefined ? `${ord.breachRisk}%` : "-";
    let breachClass = "success-text";
    if (ord.breachRisk > 65) breachClass = "alert-text font-bold";
    else if (ord.breachRisk > 40) breachClass = "text-warning font-bold";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><a href="#" class="order-link" data-id="${ord.id}">${ord.id}</a></td>
      <td>
        <div class="patient-info">
          <span class="patient-name">${ord.patientName}</span>
          <span class="patient-email">${ord.patientEmail}</span>
        </div>
      </td>
      <td>
        <span class="prescription-tag">R: ${ord.sph} | L: ${ord.cyl}</span>
      </td>
      <td>
        <div class="lens-params">
          <span class="lens-type">${ord.lensType} (1.${ord.index})</span>
          <span class="lens-details">${ord.coating}</span>
        </div>
      </td>
      <td>${ord.store}</td>
      <td class="${slaClass} font-header font-bold">${formatSla(ord.slaRemaining)}</td>
      <td class="${breachClass} font-header font-bold">${breachRiskText}</td>
      <td>
        <span class="status-pill status-${getStageClass(ord.stage)}">${ord.stage}</span>
      </td>
      <td>
        <div class="action-buttons-row">
          <button class="btn btn-sm btn-update-stage" data-id="${ord.id}">Update Stage</button>
          <button class="btn btn-sm btn-secondary btn-breach-score" data-id="${ord.id}" style="display: flex; align-items: center; gap: 4px;">
            <i data-lucide="activity" style="width: 12px; height: 12px;"></i> Breach Score
          </button>
          ${isAtRisk || isBreached ? `<button class="btn btn-sm btn-secondary text-orange notify-email" data-id="${ord.id}"><i data-lucide="mail"></i> Alert</button>` : ''}
        </div>
      </td>
    `;
    tableBody.appendChild(tr);
  });

  // Attach event listeners
  document.querySelectorAll(".btn-update-stage").forEach(btn => {
    btn.addEventListener("click", (e) => {
      openStatusModal(e.target.getAttribute("data-id"));
    });
  });

  document.querySelectorAll(".btn-breach-score").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const orderId = e.currentTarget.getAttribute("data-id");
      calculateBreachScore(orderId);
    });
  });

  document.querySelectorAll(".order-link").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openStatusModal(e.target.getAttribute("data-id"));
    });
  });

  document.querySelectorAll(".notify-email").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      simulateEmailAlert(id);
    });
  });

  // Attach filter triggers once
  if (!window.filtersAttached) {
    document.getElementById("order-search").addEventListener("input", initTable);
    document.getElementById("filter-status").addEventListener("change", initTable);
    document.getElementById("filter-lens-type").addEventListener("change", initTable);
    document.getElementById("filter-location").addEventListener("change", initTable);
    window.filtersAttached = true;
  }

  lucide.createIcons();
}

function getStageClass(stage) {
  if (stage === "Intake") return "intake";
  if (stage === "Stocked at Inventary") return "stocked-at-inventary";
  if (stage === "Lab Surfacing" || stage === "Coating" || stage === "Mounting") return "lab";
  if (stage === "QC") return "qc";
  if (stage === "Dispatch") return "dispatch";
  return "delivered";
}

// Helper: Map snake_case database schema to frontend camelCase properties
function mapOrderToCamelCase(o) {
  let slaRemaining = o.sla_remaining;
  if (o.stage !== "Delivered" && o.created_at) {
    const createdTime = new Date(o.created_at);
    const targetTime = new Date(createdTime.getTime() + o.sla_total * 60 * 1000);
    const now = new Date();
    slaRemaining = Math.round((targetTime.getTime() - now.getTime()) / (60 * 1000));
  } else if (o.stage === "Delivered") {
    slaRemaining = 0;
  }

  return {
    id: o.id,
    patientName: o.patient_name,
    patientEmail: o.patient_email,
    sph: o.sph,
    cyl: o.cyl,
    lensType: o.lens_type,
    index: o.index_value,
    coating: o.coating,
    store: o.store,
    stage: o.stage,
    slaRemaining: slaRemaining,
    slaTotal: o.sla_total,
    riskProbability: o.risk_probability,
    history: o.history || [],
    delayReason: o.delay_reason || "",
    createdAt: o.created_at,
    breachRisk: o.breach_risk
  };
}

// Fetch all orders from backend database
async function loadOrders() {
  try {
    const session = (await supabaseClient.auth.getSession()).data.session;
    const token = session?.access_token;
    if (!token) return;

    const response = await fetch("/api/orders", {
      headers: { "Authorization": `Bearer ${token}` }
    });

    if (response.ok) {
      const fetched = await response.json();
      orders = fetched.map(mapOrderToCamelCase);
      
      // Update UI counts and KPIs
      updatePipelineCounts();
      updateDashboardKPIs();
      if (activeTab === "orders") initTable();
      if (activeTab === "predictions") initPredictions();
    }
  } catch (err) {
    console.error("Failed to load orders:", err);
  }
}

// Fetch all inventory items from backend database
async function loadInventory() {
  try {
    const session = (await supabaseClient.auth.getSession()).data.session;
    const token = session?.access_token;
    if (!token) return;

    const response = await fetch("/api/inventory", {
      headers: { "Authorization": `Bearer ${token}` }
    });

    if (response.ok) {
      const fetched = await response.json();
      inventory = fetched.map(item => ({
        name: item.name,
        type: item.type,
        index: item.lens_index,
        qty: item.qty,
        minLimit: item.min_limit
      }));
      
      if (activeTab === "inventory") initInventory();
    }
  } catch (err) {
    console.error("Failed to load inventory:", err);
  }
}

// Submit Stock update to backend API
async function handleStockFeed(event) {
  event.preventDefault();
  
  const submitBtn = document.getElementById("stock-modal-submit-btn");
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i data-lucide="loader"></i> Feeding Stock...`;
  lucide.createIcons();

  const type = document.getElementById("stock-type").value;
  let name = "";
  let lens_index = "";
  
  if (type === "lens") {
    lens_index = document.getElementById("stock-lens-index-select").value;
    const nameMap = {
      "1.50": "CR-39 Standard",
      "1.60": "High Index Thin",
      "1.67": "Ultra Tough Thin",
      "1.74": "Thinnest Elite"
    };
    name = nameMap[lens_index];
  } else {
    name = document.getElementById("stock-coating-select").value;
    lens_index = "N/A";
  }

  const payload = {
    name: name,
    type: type,
    lens_index: lens_index,
    qty: parseInt(document.getElementById("stock-qty").value),
    min_limit: parseInt(document.getElementById("stock-min-limit").value)
  };

  try {
    const session = (await supabaseClient.auth.getSession()).data.session;
    const token = session?.access_token;
    if (!token) throw new Error("No active session.");

    const response = await fetch("/api/inventory", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      showToast("Stock Updated", `Successfully added ${payload.qty} units of ${payload.name}.`, "success");
      document.getElementById("stock-feed-form").reset();
      toggleStockModalFields();
      closeStockModal();
      await loadInventory();
    } else {
      const errData = await response.json();
      showToast("Stock Feed Failed", errData.detail || "Unable to update stock levels.", "error");
    }
  } catch (err) {
    console.error("Error feeding stock:", err);
    showToast("Network Error", "Unable to communicate with the central inventory core.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i data-lucide="plus-circle"></i> Feed Stock`;
    lucide.createIcons();
  }
}

// Submit Order to backend API
async function handleOrderPlacement(event) {
  event.preventDefault();
  
  const submitBtn = document.getElementById("btn-place-order-submit");
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i data-lucide="loader"></i> Placing Order...`;
  lucide.createIcons();

  const payload = {
    patient_name: document.getElementById("order-patient-name").value.trim(),
    patient_email: document.getElementById("order-patient-email").value.trim(),
    sph: document.getElementById("order-sph").value.trim(),
    cyl: document.getElementById("order-cyl").value.trim(),
    lens_type: document.getElementById("order-lens-type").value,
    index_value: document.getElementById("order-index-value").value,
    coating: document.getElementById("order-coating").value,
    store: document.getElementById("order-store").value
  };

  try {
    const session = (await supabaseClient.auth.getSession()).data.session;
    const token = session?.access_token;
    
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.detail || "Failed to submit manufacturing order.");
    }

    const rawOrder = await response.json();
    const newOrder = mapOrderToCamelCase(rawOrder);
    
    // Add to local list and alert operator
    orders.unshift(newOrder);
    const isFastTrack = newOrder.history && newOrder.history[0] && newOrder.history[0].action.includes("In-House Stock Match");
    if (isFastTrack) {
      showToast("Order Placed (In-House Match)", `Order ${newOrder.id} matches In-House stock! Prioritized for 16h delivery (SLA set to 16 hours).`, "success");
    } else {
      showToast("Order Placed (Standard Routing)", `Order ${newOrder.id} registered. Lens/Coating out of stock, routed to standard queue (SLA set to 72 hours).`, "warning");
    }
    
    // Reset form
    document.getElementById("place-order-form").reset();
    
    // Trigger celebration
    confetti({
      particleCount: 80,
      spread: 60,
      origin: { y: 0.8 },
      colors: ['#ff6b00', '#ffb380', '#ffffff']
    });

    // Open AI Suggestions Modal after a brief celebration delay
    setTimeout(() => {
      openAiModal(rawOrder.ai_suggestion, rawOrder.source);
    }, 1200);

  } catch (error) {
    showToast("Submission Failure", error.message || "An unexpected error occurred.", "danger");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i data-lucide="plus-circle"></i> Create Manufacturing Order`;
    lucide.createIcons();
  }
}

// Lens Inventory Render
function initInventory() {
  const container = document.getElementById("inventory-grid-container");
  const searchVal = document.getElementById("inventory-search").value.toLowerCase();
  
  container.innerHTML = "";

  const filtered = inventory.filter(item => {
    return item.name.toLowerCase().includes(searchVal) || 
           item.index.toLowerCase().includes(searchVal);
  });

  filtered.forEach(item => {
    const isLow = item.qty < item.minLimit;
    const progressPercent = Math.min(100, (item.qty / (item.minLimit * 3)) * 100);
    
    let barColor = "var(--gold-gradient)";
    if (item.qty < item.minLimit / 2) barColor = "var(--color-danger)";
    else if (isLow) barColor = "var(--color-warning)";

    const card = document.createElement("div");
    card.className = `inventory-card ${isLow ? 'low-stock' : ''}`;
    card.innerHTML = `
      <div class="inv-header">
        <span class="inv-name">${item.name}</span>
        <span class="inv-index">${item.index !== 'N/A' ? 'Index ' + item.index : 'Coating'}</span>
      </div>
      <div class="inv-qty-container" style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; margin-bottom: 8px;">
        <span class="inv-qty" style="font-size: 20px; font-weight: 700; color: var(--text-primary); margin: 0;">${item.qty} <span style="font-size: 12px; font-weight: 400; color: var(--text-secondary);">units</span></span>
        <div class="inv-controls" style="display: flex; gap: 4px; align-items: center;">
          <button class="btn btn-secondary btn-decrement" data-name="${item.name}" data-index="${item.index}" data-type="${item.type}" data-qty="${item.qty}" data-minlimit="${item.minLimit}" style="padding: 2px 8px; font-size: 12px; height: 28px; line-height: 1; border-radius: 4px;">-</button>
          <button class="btn btn-secondary btn-increment" data-name="${item.name}" data-index="${item.index}" data-type="${item.type}" data-qty="${item.qty}" data-minlimit="${item.minLimit}" style="padding: 2px 8px; font-size: 12px; height: 28px; line-height: 1; border-radius: 4px;">+</button>
          <button class="btn btn-orange btn-set-qty" data-name="${item.name}" data-index="${item.index}" data-type="${item.type}" data-qty="${item.qty}" data-minlimit="${item.minLimit}" style="padding: 2px 8px; font-size: 12px; height: 28px; line-height: 1; border-radius: 4px; display: flex; align-items: center; justify-content: center; width: 28px; min-width: 28px;">
            <i data-lucide="edit-3" style="width: 12px; height: 12px;"></i>
          </button>
        </div>
      </div>
      <div class="inv-progress-container">
        <div class="inv-progress-bar" style="width: ${progressPercent}%; background: ${barColor};"></div>
      </div>
      <p style="font-size: 10px; color: var(--text-muted); margin-top: 6px; margin-bottom: 0;">
        ${isLow ? `⚠️ Critical limit is ${item.minLimit}` : `Healthy level (Threshold: ${item.minLimit})`}
      </p>
    `;
    container.appendChild(card);
  });

  if (!window.invActionsAttached) {
    const gridContainer = document.getElementById("inventory-grid-container");
    if (gridContainer) {
      gridContainer.addEventListener("click", async (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        
        const name = btn.getAttribute("data-name");
        const index = btn.getAttribute("data-index");
        const type = btn.getAttribute("data-type");
        const currentQty = parseInt(btn.getAttribute("data-qty"));
        const minLimit = parseInt(btn.getAttribute("data-minlimit"));
        
        if (!name) return;
        
        let newQty = currentQty;
        let mode = "add";
        let delta = 0;
        
        if (btn.classList.contains("btn-decrement")) {
          delta = -1;
          newQty = Math.max(0, currentQty - 1);
          mode = "add";
        } else if (btn.classList.contains("btn-increment")) {
          delta = 1;
          newQty = currentQty + 1;
          mode = "add";
        } else if (btn.classList.contains("btn-set-qty")) {
          const input = prompt(`Enter absolute stock quantity for ${name} (${index !== 'N/A' ? 'Index ' + index : 'Coating'}):`, currentQty);
          if (input === null) return;
          const parsed = parseInt(input);
          if (isNaN(parsed) || parsed < 0) {
            showToast("Invalid Input", "Please enter a valid non-negative number.", "danger");
            return;
          }
          newQty = parsed;
          mode = "set";
        } else {
          return;
        }
        
        try {
          const session = (await supabaseClient.auth.getSession()).data.session;
          const token = session?.access_token;
          if (!token) throw new Error("No active session.");
          
          const payload = {
            name: name,
            type: type,
            lens_index: index,
            qty: mode === "set" ? newQty : delta,
            min_limit: minLimit,
            mode: mode
          };
          
          const res = await fetch("/api/inventory", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify(payload)
          });
          
          if (res.ok) {
            showToast("Stock Updated", `Updated ${name} to ${newQty} units.`, "success");
            await loadInventory();
          } else {
            const err = await res.json();
            showToast("Update Failed", err.detail || "Unable to modify stock.", "danger");
          }
        } catch (err) {
          showToast("Error", err.message, "danger");
        }
      });
      window.invActionsAttached = true;
    }
  }

  if (!window.invSearchAttached) {
    const searchEl = document.getElementById("inventory-search");
    if (searchEl) {
      searchEl.addEventListener("input", initInventory);
      window.invSearchAttached = true;
    }
  }
  
  lucide.createIcons();
}

// Prescription intake power matcher
function initRxMatcher() {
  const form = document.getElementById("rx-matcher-form");
  const resultBox = document.getElementById("rx-match-result");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const sph = parseFloat(document.getElementById("rx-sph").value);
    const cyl = parseFloat(document.getElementById("rx-cyl").value);
    const index = document.getElementById("rx-index").value;
    const coating = document.getElementById("rx-coating").value;

    // Simulate inventory lookup logic
    // Complex prescriptions (SPH > 4 or CYL > 2) require high index
    let isAvailable = true;
    let matchMessage = "";

    const relatedLens = inventory.find(inv => inv.index === index);
    const relatedCoating = inventory.find(inv => inv.name === coating);

    if (relatedLens && relatedLens.qty < 5) {
      isAvailable = false;
      matchMessage = `In-house Optical blanks for Index ${index} are critically low (${relatedLens.qty} left). Processing this order will require outsourcing, adding 24 hours to the SLA.`;
    } else if (relatedCoating && relatedCoating.qty < 5) {
      isAvailable = false;
      matchMessage = `Selected coating "${coating}" is out of stock in laboratory. Reorder is pending. Match failed.`;
    } else if (Math.abs(sph) > 6 && index === "1.50") {
      isAvailable = false;
      matchMessage = `Prescription strength (${sph} SPH) is too high for Standard 1.50 Index. High refractive error will create thick margins. Please select 1.67 or 1.74 Index.`;
    } else {
      matchMessage = `Perfect Match! Optical blank Index ${index} is in-stock (${relatedLens ? relatedLens.qty : 0} units). Surface laboratory can begin processing immediately. SLA Met capability guaranteed.`;
    }

    resultBox.className = `match-result-box mt-24 ${isAvailable ? 'alert-border-left' : 'alert-border-left border-danger'}`;
    resultBox.innerHTML = `
      <div class="match-title ${isAvailable ? '' : 'text-danger-strong'}">
        <i data-lucide="${isAvailable ? 'check-circle' : 'x-circle'}"></i>
        <span>${isAvailable ? 'SLA Availability Confirmed' : 'SLA Match Warned'}</span>
      </div>
      <p class="match-desc">${matchMessage}</p>
    `;
    resultBox.classList.remove("hidden");
    lucide.createIcons();
  });
}

// TAT Predictions & Alerts List
function initPredictions() {
  const riskList = document.getElementById("predictions-risk-list");
  const dashboardBreaches = document.getElementById("critical-breach-list");
  
  if (!riskList) return;

  riskList.innerHTML = "";
  if (dashboardBreaches) dashboardBreaches.innerHTML = "";

  // Sort orders by risk probability or remaining time
  const atRiskOrders = orders.filter(o => o.slaRemaining < 120);

  if (atRiskOrders.length === 0) {
    riskList.innerHTML = `<p style="color: var(--text-muted); padding: 16px 0;">No active TAT risk alerts calculated at this hour.</p>`;
    return;
  }

  atRiskOrders.forEach(ord => {
    const isBreached = ord.slaRemaining < 0;
    const probability = ord.riskProbability;
    
    // Risk level calculations
    let riskLvlClass = "risk-level-badge";
    let riskText = "Medium SLA Risk";
    if (probability > 80 || isBreached) {
      riskLvlClass = "risk-level-badge";
      riskText = "Critical SLA Breach Risk";
    } else if (probability > 50) {
      riskLvlClass = "risk-level-badge risk-level-medium";
      riskText = "Warning Stage Risk";
    }

    const html = `
      <div class="prediction-risk-card">
        <div class="risk-details-col">
          <div class="risk-meta">
            <span class="order-badge-mini">${ord.id}</span>
            <span class="${riskLvlClass}">${riskText} (${probability}% Probability)</span>
          </div>
          <p class="risk-desc mt-12">
            Patient: <strong>${ord.patientName}</strong> (${ord.store}) is in <strong>${ord.stage}</strong> stage. 
            Estimated delay is driven by: <em>"${ord.delayReason || 'Surfacing machine scheduling queue'}"</em>.
          </p>
        </div>
        <div class="breach-sla">
          <span class="time-remaining ${isBreached ? 'alert-text' : ''}">${formatSla(ord.slaRemaining)}</span>
          <div class="action-buttons-row mt-12">
            <button class="btn btn-sm btn-orange btn-fasttrack" data-id="${ord.id}"><i data-lucide="zap"></i> Fast Track</button>
            <button class="btn btn-sm btn-secondary text-orange notify-email" data-id="${ord.id}"><i data-lucide="mail"></i> Email Alert</button>
          </div>
        </div>
      </div>
    `;

    riskList.innerHTML += html;

    // Populate dashboard critical list if exists
    if (dashboardBreaches) {
      const breachHtml = `
        <div class="breach-row">
          <div class="breach-order-info">
            <span class="order-badge-mini">${ord.id}</span>
            <div class="breach-details">
              <p>${ord.patientName} — ${ord.lensType} (1.${ord.index})</p>
              <span>Current Stage: ${ord.stage} | Store: ${ord.store}</span>
            </div>
          </div>
          <div class="breach-sla">
            <span class="time-remaining">${formatSla(ord.slaRemaining)}</span>
            <span class="breach-probability block">${probability}% Risk probability</span>
          </div>
        </div>
      `;
      dashboardBreaches.innerHTML += breachHtml;
    }
  });

  // Fast track trigger
  document.querySelectorAll(".btn-fasttrack").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      fastTrackOrder(id);
    });
  });

  // Email alert trigger in predictions tab
  document.querySelectorAll("#predictions-tab .notify-email").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      simulateEmailAlert(id);
    });
  });

  lucide.createIcons();
}

function fastTrackOrder(id) {
  const ord = orders.find(o => o.id === id);
  if (ord) {
    ord.slaRemaining += 120; // add hours or optimize speed
    ord.riskProbability = Math.max(5, ord.riskProbability - 50);
    ord.history.push({ time: new Date().toISOString().substring(0, 16), action: "AI Fast Track Routing triggered by Central Ops" });
    showToast("Fast-Track Activated", `Order ${id} has been moved to Priority SURGE routing. SLA remaining successfully padded.`, "success");
    
    // Confetti
    confetti({
      particleCount: 50,
      angle: 60,
      spread: 55,
      origin: { x: 0 },
      colors: ['#ff6b00', '#ffffff']
    });

    initPredictions();
    if (activeTab === "orders") initTable();
    if (activeTab === "dashboard") {
      updateDashboardKPIs();
      updatePipelineCounts();
    }
  }
}

// Modal handling
const modal = document.getElementById("status-modal");
const closeBtn = document.getElementById("close-modal-btn");
const cancelBtn = document.getElementById("modal-cancel-btn");
const statusForm = document.getElementById("status-update-form");
const modalNewStatus = document.getElementById("modal-new-status");
const qcCheckboxContainer = document.getElementById("qc-fail-loop-options");
const qcCheckbox = document.getElementById("qc-failed-checkbox");

function openStatusModal(orderId, isForced = false, risk = 0) {
  const ord = orders.find(o => o.id === orderId);
  if (!ord) return;

  selectedOrderIdForUpdate = orderId;
  document.getElementById("modal-order-id").textContent = orderId;
  modalNewStatus.value = ord.stage;
  document.getElementById("modal-delay-reason").value = ord.delayReason || "";
  
  // check status changes
  toggleQCOptions(ord.stage);
  
  let alertBox = document.getElementById("modal-forced-delay-alert");
  if (!alertBox) {
    alertBox = document.createElement("div");
    alertBox.id = "modal-forced-delay-alert";
    alertBox.className = "alert-border-left p-12 mb-16";
    alertBox.style.borderColor = "var(--color-danger)";
    alertBox.style.backgroundColor = "rgba(239, 83, 80, 0.08)";
    const body = document.querySelector("#status-modal .modal-body");
    body.insertBefore(alertBox, body.firstChild);
  }
  
  if (isForced) {
    alertBox.innerHTML = `
      <p class="text-danger-strong" style="display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 700;">
        <i data-lucide="shield-alert" style="width: 16px; height: 16px;"></i> High SLA Breach Risk Alert (${risk}%)
      </p>
      <p class="desc text-secondary" style="margin: 4px 0 0 0; font-size: 12px;">
        This order has been predicted to have a high risk of breaching its SLA. **You must enter a reason for the delay** before closing or updating.
      </p>
    `;
    alertBox.classList.remove("hidden");
    
    // Hide Close and Cancel buttons to force input
    document.getElementById("close-modal-btn").style.display = "none";
    document.getElementById("modal-cancel-btn").style.display = "none";
    
    // Add a flag to prevent closing when clicking the backdrop
    window.modalIsForced = true;
  } else {
    alertBox.classList.add("hidden");
    document.getElementById("close-modal-btn").style.display = "block";
    document.getElementById("modal-cancel-btn").style.display = "block";
    window.modalIsForced = false;
  }
  
  modal.classList.remove("hidden");
  lucide.createIcons();
}

function closeModal() {
  modal.classList.add("hidden");
  selectedOrderIdForUpdate = null;
  qcCheckbox.checked = false;
  
  // Restore close buttons
  document.getElementById("close-modal-btn").style.display = "block";
  document.getElementById("modal-cancel-btn").style.display = "block";
  window.modalIsForced = false;
  const alertBox = document.getElementById("modal-forced-delay-alert");
  if (alertBox) alertBox.classList.add("hidden");
}

closeBtn.addEventListener("click", () => {
  if (!window.modalIsForced) closeModal();
});
cancelBtn.addEventListener("click", () => {
  if (!window.modalIsForced) closeModal();
});
modal.addEventListener("click", (e) => {
  if (e.target === modal && !window.modalIsForced) closeModal();
});

modalNewStatus.addEventListener("change", (e) => {
  toggleQCOptions(e.target.value);
});

function toggleQCOptions(status) {
  if (status === "QC") {
    qcCheckboxContainer.classList.remove("hidden");
  } else {
    qcCheckboxContainer.classList.add("hidden");
  }
}

// Stock Modal Event Listeners
const stockModal = document.getElementById("stock-modal");
const openStockBtn = document.getElementById("btn-open-stock-modal");
const closeStockBtn = document.getElementById("close-stock-modal-btn");
const cancelStockBtn = document.getElementById("stock-modal-cancel-btn");
const stockFeedForm = document.getElementById("stock-feed-form");

// Dropdown toggle elements
const stockTypeSelect = document.getElementById("stock-type");
const stockLensGroup = document.getElementById("stock-lens-group");
const stockCoatingGroup = document.getElementById("stock-coating-group");

function toggleStockModalFields() {
  if (!stockTypeSelect || !stockLensGroup || !stockCoatingGroup) return;
  if (stockTypeSelect.value === "lens") {
    stockLensGroup.classList.remove("hidden");
    stockCoatingGroup.classList.add("hidden");
  } else {
    stockLensGroup.classList.add("hidden");
    stockCoatingGroup.classList.remove("hidden");
  }
}

if (stockTypeSelect) {
  stockTypeSelect.addEventListener("change", toggleStockModalFields);
}

function openStockModal() {
  if (stockModal) {
    toggleStockModalFields();
    stockModal.classList.remove("hidden");
  }
}

function closeStockModal() {
  if (stockModal) stockModal.classList.add("hidden");
}

if (openStockBtn) openStockBtn.addEventListener("click", openStockModal);
if (closeStockBtn) closeStockBtn.addEventListener("click", closeStockModal);
if (cancelStockBtn) cancelStockBtn.addEventListener("click", closeStockModal);
if (stockFeedForm) stockFeedForm.addEventListener("submit", handleStockFeed);

if (stockModal) {
  stockModal.addEventListener("click", (e) => {
    if (e.target === stockModal) closeStockModal();
  });
}

// AI Suggestion Modal Controllers
const aiModal = document.getElementById("ai-suggestion-modal");
const closeAiBtn = document.getElementById("close-ai-modal-btn");
const okAiBtn = document.getElementById("ai-modal-ok-btn");

function openAiModal(aiSuggestion, source) {
  if (!aiModal) return;
  if (!aiSuggestion) return;
  
  document.getElementById("ai-sourcing-strategy").textContent = source;
  document.getElementById("ai-monthly-demand").textContent = aiSuggestion.expected_monthly_demand + " Units";
  document.getElementById("ai-demand-insight-text").textContent = aiSuggestion.freq_msg;
  document.getElementById("ai-recommended-stock").textContent = aiSuggestion.recommended_stock + " units";
  
  const probEl = document.getElementById("ai-stockout-prob");
  probEl.textContent = aiSuggestion.stockout_probability_pct + "%";
  
  // Update styling depending on probability thresholds
  if (aiSuggestion.stockout_probability_pct > 75) {
    probEl.style.color = "var(--color-danger)";
  } else if (aiSuggestion.stockout_probability_pct > 40) {
    probEl.style.color = "var(--color-warning)";
  } else {
    probEl.style.color = "var(--color-success, #2e7d32)";
  }
  
  aiModal.classList.remove("hidden");
  lucide.createIcons();
}

function closeAiModal() {
  if (aiModal) aiModal.classList.add("hidden");
  
  // Navigate back to the orders console
  const ordersTabBtn = document.querySelector('[data-tab="orders"]');
  if (ordersTabBtn) ordersTabBtn.click();
}

if (closeAiBtn) closeAiBtn.addEventListener("click", closeAiModal);
if (okAiBtn) okAiBtn.addEventListener("click", closeAiModal);
if (aiModal) {
  aiModal.addEventListener("click", (e) => {
    if (e.target === aiModal) closeAiModal();
  });
}

// Status & Delay update submit
function initStatusForm() {
  statusForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedOrderIdForUpdate) return;

    const ord = orders.find(o => o.id === selectedOrderIdForUpdate);
    if (!ord) return;

    const targetStatus = modalNewStatus.value;
    const delayReason = document.getElementById("modal-delay-reason").value.trim();

    // Enforce delay reason if modal is forced
    if (window.modalIsForced && !delayReason) {
      showToast("Reason Required", "A delay reason is required for this high SLA breach risk order.", "danger");
      return;
    }

    let finalStatus = targetStatus;
    let loopBackTriggered = false;

    // Check Quality Control Fail loop back
    if (targetStatus === "QC" && qcCheckbox.checked) {
      finalStatus = "Lab Surfacing";
      loopBackTriggered = true;
    }

    const payload = {
      stage: finalStatus,
      delay_reason: loopBackTriggered ? `QC Inspection FAILED. Looped back to Lab Surfacing. Reason: ${delayReason}` : delayReason
    };

    try {
      const session = (await supabaseClient.auth.getSession()).data.session;
      const token = session?.access_token;
      
      const response = await fetch(`/api/orders/${ord.id}/status`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || "Failed to update lifecycle stage.");
      }

      const rawUpdated = await response.json();
      const updatedOrder = mapOrderToCamelCase(rawUpdated);
      
      // Update local array object
      const index = orders.findIndex(o => o.id === updatedOrder.id);
      if (index !== -1) {
        orders[index] = updatedOrder;
      }

      if (loopBackTriggered) {
        showToast("QC Fail Loop Triggered", `Order ${ord.id} failed Quality check. Reprocessed back to Laboratory Surfacing.`, "danger");
      } else {
        if (finalStatus === "Delivered") {
          showToast("Order Delivered", `Order ${ord.id} marked as fully delivered. SLA closed.`, "success");
        } else {
          showToast("Stage Synced", `Order ${ord.id} successfully updated to stage: ${finalStatus}.`, "success");
        }
      }

      closeModal();
      
      // Update active tab views
      initTable();
      updatePipelineCounts();
      updateDashboardKPIs();
      initPredictions();

    } catch (error) {
      showToast("Sync Error", error.message || "Could not sync stage update to Supabase.", "danger");
    }
  });
}

// Send Real SMTP Email notification via Backend API
async function simulateEmailAlert(orderId) {
  const ord = orders.find(o => o.id === orderId);
  if (!ord) return;

  // Find corresponding alert buttons to show progress
  const btns = document.querySelectorAll(`.notify-email[data-id="${orderId}"]`);
  const originalHtmls = [];
  
  btns.forEach(btn => {
    btn.disabled = true;
    originalHtmls.push({ btn: btn, html: btn.innerHTML });
    btn.innerHTML = `<i data-lucide="loader" style="width:12px;height:12px;display:inline-block;animation:spin 1s linear infinite;margin-right:4px;vertical-align:middle;"></i> Sending...`;
  });
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  try {
    const session = (await supabaseClient.auth.getSession()).data.session;
    const token = session?.access_token;
    if (!token) throw new Error("No active authenticated session found.");

    const response = await fetch(`/api/orders/${orderId}/send-alert-email`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || "Failed to transmit SMTP alert email.");
    }

    showToast(
      "Email Dispatched",
      result.message || `Alert email successfully sent for order ${orderId}.`,
      "success"
    );
  } catch (error) {
    console.error("Error sending email alert:", error);
    showToast("Email Error", error.message || "Could not dispatch alert email.", "danger");
  } finally {
    // Restore buttons
    originalHtmls.forEach(item => {
      item.btn.disabled = false;
      item.btn.innerHTML = item.html;
    });
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }
}

// Toast alerts
function showToast(title, msg, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div>
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>
  `;
  container.appendChild(toast);
  
  // auto dismiss
  setTimeout(() => {
    toast.style.animation = "slide-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards";
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4000);
}

// Update counters across dashboard stages
function updatePipelineCounts() {
  const stages = ["Intake", "Stocked at Inventary", "Lab Surfacing", "Coating", "Mounting", "QC", "Dispatch"];
  stages.forEach(stg => {
    const count = orders.filter(o => o.stage === stg).length;
    const stageId = stg.toLowerCase().replace(/\s+/g, "-");
    const countEl = document.getElementById(`count-stage-${stageId}`);
    if (countEl) countEl.textContent = count;
  });
}

// Update dashboard KPI numbers
function updateDashboardKPIs() {
  const activeCount = orders.filter(o => o.stage !== "Delivered").length;
  const riskCount = orders.filter(o => o.slaRemaining < 90 && o.stage !== "Delivered").length;
  const labCount = orders.filter(o => ["Lab Surfacing", "Coating", "Mounting"].includes(o.stage)).length;

  document.getElementById("dashboard-active-count").textContent = activeCount;
  document.getElementById("dashboard-risk-count").textContent = riskCount;
  document.getElementById("dashboard-lab-count").textContent = labCount;

  // Header status
  document.getElementById("header-risk-count").textContent = riskCount;
}

// -------------------------------------------------------------
// THREE.JS 3D SCENES
// -------------------------------------------------------------

// 1. Floating Gold Dust Particle background
let bgScene, bgCamera, bgRenderer, bgParticles;

function initThreeBackground() {
  const canvas = document.getElementById("bg-3d-canvas");
  if (!canvas) return;

  const scene = new THREE.Scene();
  
  // Set camera
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 8;

  const renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Add light
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.95);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
  dirLight.position.set(2, 4, 5);
  scene.add(dirLight);

  // Load eyewear_luxury.png
  const textureLoader = new THREE.TextureLoader();
  let eyewearMesh;

  textureLoader.load("eyewear_luxury.png", (texture) => {
    // Plane geometry with scale 4.5x4.5
    const geometry = new THREE.PlaneGeometry(4.5, 4.5);
    
    // We want double sided rendering so it looks cool when it rotates.
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95
    });

    eyewearMesh = new THREE.Mesh(geometry, material);
    
    // Position X = 2.4, Y = 0 on desktop, X = 0, Y = -1.2 on mobile
    if (window.innerWidth > 992) {
      eyewearMesh.position.set(2.4, 0, 0);
    } else {
      eyewearMesh.position.set(0, -1.2, 0);
    }

    scene.add(eyewearMesh);
  });

  // Keep track of scroll position
  let scrollPercent = 0;
  let targetRotationY = 0;
  let targetRotationX = 0;
  let targetPositionY = 0;

  window.addEventListener("scroll", () => {
    const scrollY = window.scrollY;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    scrollPercent = maxScroll > 0 ? scrollY / maxScroll : 0;

    // As user scrolls, let the eyewear rotate on Y-axis (2 full rotations) and X-axis (slight tilt)
    targetRotationY = scrollPercent * Math.PI * 3.5; 
    targetRotationX = scrollPercent * Math.PI * 0.4;
    
    // Vertical offset shift
    targetPositionY = -scrollPercent * 1.5;
  });

  // Handle window resizing
  window.addEventListener("resize", () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);

    if (eyewearMesh) {
      if (w > 992) {
        eyewearMesh.position.set(2.4, targetPositionY, 0);
      } else {
        eyewearMesh.position.set(0, -1.2 + targetPositionY, 0);
      }
    }
  });

  // Animate function
  function animate() {
    requestAnimationFrame(animate);

    if (eyewearMesh) {
      // Lerp for smooth scrolling rotation
      eyewearMesh.rotation.y += (targetRotationY - eyewearMesh.rotation.y) * 0.06;
      eyewearMesh.rotation.x += (targetRotationX - eyewearMesh.rotation.x) * 0.06;
      
      // Idle floating motion
      const time = Date.now() * 0.001;
      const basePos = window.innerWidth > 992 ? 0 : -1.2;
      const currentTargetY = basePos + targetPositionY + Math.sin(time) * 0.12;
      eyewearMesh.position.y += (currentTargetY - eyewearMesh.position.y) * 0.06;
      
      // Gentle floating sway
      eyewearMesh.position.x += ((window.innerWidth > 992 ? 2.4 : 0) + Math.cos(time * 0.8) * 0.08 - eyewearMesh.position.x) * 0.06;
    }

    renderer.render(scene, camera);
  }

  animate();
}



// 2. Interactive 3D Lens Configurator inside dashboard card
let lensScene, lensCamera, lensRenderer, lensMesh;

function initThreeLensModel() {
  const container = document.getElementById("lens-3d-viewport");
  if (!container) return;

  const width = container.clientWidth;
  const height = container.clientHeight || 200;

  lensScene = new THREE.Scene();
  
  // Set local camera
  lensCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  lensCamera.position.z = 6;

  lensRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  lensRenderer.setSize(width, height);
  lensRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(lensRenderer.domElement);

  // Add lights for optical refractivity reflection
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  lensScene.add(ambientLight);

  const orangeDirectional = new THREE.DirectionalLight(0xff6b00, 2.0);
  orangeDirectional.position.set(5, 5, 2);
  lensScene.add(orangeDirectional);

  const blueFillLight = new THREE.DirectionalLight(0x4ca3ff, 1.2);
  blueFillLight.position.set(-5, -3, 2);
  lensScene.add(blueFillLight);

  // Create custom double-convex lens geometry using CSG or custom lathed curves
  const points = [];
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    const x = Math.sin(t * Math.PI) * 1.5;
    const y = (t - 0.5) * 0.4; // thickness
    points.push(new THREE.Vector2(x, y));
  }
  
  const geometry = new THREE.LatheGeometry(points, 32);
  
  // Translucent refractive glass material with blue protective reflection
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffedd5,
    transparent: true,
    opacity: 0.65,
    transmission: 0.9, // high transmission
    roughness: 0.05,
    metalness: 0.1,
    ior: 1.67, // optical index matching high index lenses!
    thickness: 1.5,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    sheen: new THREE.Color(0x00a8ff), // blue shield reflection look!
  });

  lensMesh = new THREE.Mesh(geometry, material);
  lensMesh.rotation.x = Math.PI / 6;
  lensScene.add(lensMesh);

  // Interactive mouse move tilt
  let targetRotationX = Math.PI / 6;
  let targetRotationY = 0;

  container.addEventListener("mousemove", (e) => {
    const rect = container.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / width) - 0.5;
    const y = ((e.clientY - rect.top) / height) - 0.5;
    
    targetRotationY = x * 2.5;
    targetRotationX = (y * 2.5) + (Math.PI / 6);
  });

  // Reset rotation when leaving mouse
  container.addEventListener("mouseleave", () => {
    targetRotationX = Math.PI / 6;
    targetRotationY = 0;
  });

  function animateLens() {
    requestAnimationFrame(animateLens);

    // Smooth rotation interpolation (lerp)
    lensMesh.rotation.x += (targetRotationX - lensMesh.rotation.x) * 0.08;
    lensMesh.rotation.y += (targetRotationY - lensMesh.rotation.y) * 0.08;

    // Slow idle spin on Y
    lensMesh.rotation.y += 0.003;

    lensRenderer.render(lensScene, lensCamera);
  }

  animateLens();

  // Resize handler
  window.addEventListener("resize", () => {
    const w = container.clientWidth;
    const h = container.clientHeight || 200;
    
    lensCamera.aspect = w / h;
    lensCamera.updateProjectionMatrix();
    lensRenderer.setSize(w, h);
  });
}

// -------------------------------------------------------------
// HOME PAGE SCROLL ANIMATION & OVERLAY LOGIC
// -------------------------------------------------------------
const frameCount = 240;
const currentFrame = index => `animation/ezgif-frame-${index.toString().padStart(3, '0')}.jpg`;
const images = [];
let firstFrameLoaded = false;

function initHomeAnimation() {
  const canvas = document.getElementById("animation-canvas");
  if (!canvas) return;

  // Preload frames
  for (let i = 1; i <= frameCount; i++) {
    const img = new Image();
    img.src = currentFrame(i);
    img.onload = () => {
      if (i === 1 && !firstFrameLoaded) {
        firstFrameLoaded = true;
        requestAnimationFrame(() => renderFrame(1));
      }
    };
    images.push(img);
  }

  // Bind scroll and resize events
  window.addEventListener("scroll", handleHomeScroll);
  window.addEventListener("resize", resizeCanvas);

  // Initial render calls
  setTimeout(() => {
    resizeCanvas();
    handleHomeScroll();
  }, 100);
}

function renderFrame(index) {
  const canvas = document.getElementById("animation-canvas");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  const img = images[index - 1];
  if (!img || !img.complete) return;

  // Handle high DPI screens
  const dpr = window.devicePixelRatio || 1;
  const canvasWidth = window.innerWidth;
  const canvasHeight = window.innerHeight;

  canvas.width = canvasWidth * dpr;
  canvas.height = canvasHeight * dpr;
  context.scale(dpr, dpr);

  const imgWidth = img.width || 1280;
  const imgHeight = img.height || 720;
  const imgRatio = imgWidth / imgHeight;
  const canvasRatio = canvasWidth / canvasHeight;

  let drawWidth, drawHeight, drawX, drawY;

  if (imgRatio > canvasRatio) {
    drawHeight = canvasHeight;
    drawWidth = canvasHeight * imgRatio;
    drawX = (canvasWidth - drawWidth) / 2;
    drawY = 0;
  } else {
    drawWidth = canvasWidth;
    drawHeight = canvasWidth / imgRatio;
    drawX = 0;
    drawY = (canvasHeight - drawHeight) / 2;
  }

  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.drawImage(img, drawX, drawY, drawWidth, drawHeight);
}

function handleHomeScroll() {
  const homeTab = document.getElementById("home-tab");
  if (!homeTab || !homeTab.classList.contains("active")) return;

  const scrollWrapper = document.getElementById("home-scroll-wrapper");
  if (!scrollWrapper) return;

  const rect = scrollWrapper.getBoundingClientRect();
  const totalScrollable = rect.height - window.innerHeight;
  if (totalScrollable <= 0) return;

  // Calculate progress relative to wrapper top bounding rect (from 0 to 1)
  let progress = -rect.top / totalScrollable;
  progress = Math.max(0, Math.min(1, progress));

  // Determine frame index (1 to 240)
  const frameIndex = Math.min(frameCount, Math.max(1, Math.floor(progress * (frameCount - 1)) + 1));

  requestAnimationFrame(() => {
    renderFrame(frameIndex);
    updateHomeOverlays(progress);
  });
}

function updateHomeOverlays(progress) {
  const sections = [
    document.getElementById("overlay-stage-1"),
    document.getElementById("overlay-stage-2"),
    document.getElementById("overlay-stage-3")
  ];

  sections.forEach((sec) => {
    if (!sec) return;
    const rect = sec.getBoundingClientRect();
    const secCenter = rect.top + rect.height / 2;
    const viewCenter = window.innerHeight / 2;
    
    // Calculate distance from center normalized by half window height
    const distanceFromCenter = Math.abs(secCenter - viewCenter);
    const maxDistance = window.innerHeight * 0.5;
    
    // Calculate opacity (1 at center, fading to 0 at max distance)
    let opacity = 1 - (distanceFromCenter / maxDistance);
    opacity = Math.max(0, Math.min(1, opacity));
    
    // Apply opacity and translate transform
    const card = sec.querySelector(".overlay-card");
    if (card) {
      card.style.opacity = opacity;
      card.style.transform = `translateY(${(1 - opacity) * 30}px)`;
    }
  });
}

function resizeCanvas() {
  const homeTab = document.getElementById("home-tab");
  if (!homeTab || !homeTab.classList.contains("active")) return;

  const scrollWrapper = document.getElementById("home-scroll-wrapper");
  if (!scrollWrapper) return;

  const rect = scrollWrapper.getBoundingClientRect();
  const totalScrollable = rect.height - window.innerHeight;
  let progress = totalScrollable > 0 ? -rect.top / totalScrollable : 0;
  progress = Math.max(0, Math.min(1, progress));

  const frameIndex = Math.min(frameCount, Math.max(1, Math.floor(progress * (frameCount - 1)) + 1));
  renderFrame(frameIndex);
}
