import os
from fastapi import FastAPI, Depends, HTTPException, status, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

from pydantic import BaseModel
from datetime import datetime
from supabase import create_client

# Load environment variables from .env
load_dotenv(override=True)

# Supabase secrets for database client instance creation
supabase_url = os.getenv("SUPABASE_URL")
supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")

# Request Validation Models
class OrderCreate(BaseModel):
    patient_name: str
    patient_email: str
    sph: str
    cyl: str
    lens_type: str
    index_value: str
    coating: str
    store: str

class OrderUpdateStatus(BaseModel):
    stage: str
    delay_reason: str = ""
    risk_probability: int = None

class InventoryUpdate(BaseModel):
    name: str
    type: str
    lens_index: str
    qty: int
    min_limit: int = 10
    mode: str = "add" # "add" or "set"

from forecaster import DemandForecaster
forecaster = DemandForecaster()

from breach_predictor import SlaBreachPredictor
breach_predictor = SlaBreachPredictor()

app = FastAPI(
    title="Eluno AI Operational Control Center API",
    description="Python backend logic and JWT verification for Eluno OMS",
    version="1.0.0"
)

@app.on_event("startup")
def startup_event():
    forecaster.train()
    breach_predictor.train()

# Set up CORS middleware for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for dev simplicity
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import our Auth dependency
from auth import get_current_user

# Helper to get authenticated Supabase client for postgrest database queries
def get_auth_client(authorization: str):
    if not supabase_url or not supabase_anon_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Supabase credentials are not configured on the server."
        )
    token = authorization.split()[1]
    client = create_client(supabase_url, supabase_anon_key)
    client.postgrest.auth(token)
    return client

# Calculate dynamic SLA remaining minutes relative to current UTC time
def compute_dynamic_sla(order: dict) -> dict:
    if not order:
        return order
    if order.get("stage") == "Delivered":
        order["sla_remaining"] = 0
        order["breach_risk"] = 0
    elif order.get("created_at"):
        try:
            from datetime import timezone
            created_at_str = order["created_at"].replace("Z", "+00:00")
            created_dt = datetime.fromisoformat(created_at_str)
            now = datetime.now(timezone.utc)
            elapsed_minutes = (now - created_dt).total_seconds() / 60.0
            sla_total = order.get("sla_total", 960) or 960
            sla_remaining = max(-999999, int(sla_total - elapsed_minutes))
            order["sla_remaining"] = sla_remaining
            
            # Predict breach risk percentage using XGBoost
            order["breach_risk"] = breach_predictor.predict_probability(
                stage_name=order.get("stage", "Intake"),
                sla_remaining=sla_remaining
            )
        except Exception as ex:
            print(f"Error computing dynamic SLA/Breach Risk for order {order.get('id')}: {ex}")
            order["breach_risk"] = 50
    else:
        order["breach_risk"] = 50
    return order

# Public API routes
@app.get("/api/health")
def health_check():
    return {
        "status": "healthy",
        "supabase_connected": bool(os.getenv("SUPABASE_URL"))
    }

@app.get("/api/config")
def get_config():
    return {
        "supabaseUrl": os.getenv("SUPABASE_URL"),
        "supabaseAnonKey": os.getenv("SUPABASE_ANON_KEY")
    }

# Live Orders Endpoints (Authenticated)
@app.get("/api/orders")
def list_orders(authorization: str = Header(None), current_user: dict = Depends(get_current_user)):
    try:
        client = get_auth_client(authorization)
        # Fetch all orders ordered by creation date descending
        response = client.table("orders").select("*").order("created_at", desc=True).execute()
        orders_list = response.data or []
        return [compute_dynamic_sla(order) for order in orders_list]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to retrieve orders: {str(e)}"
        )

@app.post("/api/orders")
def create_order(order: OrderCreate, authorization: str = Header(None), current_user: dict = Depends(get_current_user)):
    try:
        client = get_auth_client(authorization)
        
        # Check inventory for availability of the matching lens index
        in_house_lens = client.table("inventory").select("*")\
            .eq("type", "lens")\
            .eq("lens_index", order.index_value)\
            .execute()
        
        lens_qty = 0
        if in_house_lens.data:
            lens_qty = in_house_lens.data[0]["qty"]
            
        in_house_match = lens_qty >= 1
        
        # Calculate dynamic SLA times and stages based on in-house inventory match
        if in_house_match:
            sla_total = 16 * 60 # 16 hours (960 minutes)
            initial_stage = "Intake"
        else:
            sla_total = 72 * 60 # 72 hours (4320 minutes)
            initial_stage = "Stocked at Inventary"
            
        # Calculate initial AI Risk Probability
        risk_probability = 15 # low default
        if order.index_value in ["1.74", "1.67"]:
            # High-index surfacing incurs higher tool wear and queue risk
            risk_probability = 42 if order.lens_type == "Progressive" else 30
            
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        action_msg = f"Order Placed at {order.store}"
        
        if in_house_match:
            action_msg += " | In-House Stock Match (16-Hour Express Delivery SLA)"
            
            # Deduct 1 unit from inventory
            lens_rec = in_house_lens.data[0]
            client.table("inventory").update({"qty": lens_rec["qty"] - 1}).eq("id", lens_rec["id"]).execute()
        else:
            action_msg += f" | Stock Out of {order.index_value} lens (72-Hour Delivery SLA, Stage: Stocked at Inventary)"
            
        # Build initial history log
        history = [{"time": now_str, "action": action_msg}]
        
        # Insert payload into database
        payload = {
            "patient_name": order.patient_name,
            "patient_email": order.patient_email,
            "sph": order.sph,
            "cyl": order.cyl,
            "lens_type": order.lens_type,
            "index_value": order.index_value,
            "coating": order.coating,
            "store": order.store,
            "stage": initial_stage,
            "sla_remaining": sla_total,
            "sla_total": sla_total,
            "risk_probability": risk_probability,
            "history": history,
            "delay_reason": "",
            "created_by": current_user.get("sub")
        }
        
        response = client.table("orders").insert(payload).execute()
        if not response.data:
            raise Exception("No record was inserted.")
            
        inserted_order = compute_dynamic_sla(response.data[0])
        
        # Calculate stockout parameters and safety limits
        post_fulfillment_qty = max(0, lens_qty - 1 if in_house_match else 0)
        ai_suggestion = forecaster.get_replenishment_suggestion(
            index_value=order.index_value,
            lens_type=order.lens_type,
            sph=order.sph,
            cyl=order.cyl,
            current_qty=post_fulfillment_qty
        )
        
        # Add suggestion payload to response for frontend mapping
        inserted_order["ai_suggestion"] = ai_suggestion
        inserted_order["source"] = "In House" if in_house_match else "Vendor"
        
        return inserted_order
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to place order: {str(e)}"
        )

@app.put("/api/orders/{order_id}/status")
def update_order_status(order_id: str, status_update: OrderUpdateStatus, authorization: str = Header(None), current_user: dict = Depends(get_current_user)):
    try:
        client = get_auth_client(authorization)
        
        # Fetch the existing order to retrieve the current history trail
        record_res = client.table("orders").select("history, risk_probability").eq("id", order_id).execute()
        if not record_res.data:
            raise HTTPException(status_code=404, detail="Order not found.")
        
        existing = record_res.data[0]
        history = existing.get("history") or []
        
        # Create history entry
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        action_msg = f"Stage changed to {status_update.stage}"
        if status_update.delay_reason:
            action_msg += f" | Reason: {status_update.delay_reason}"
            
        history.append({"time": now_str, "action": action_msg})
        
        # Build update fields
        payload = {
            "stage": status_update.stage,
            "history": history,
            "delay_reason": status_update.delay_reason
        }
        
        # Update risk level if provided, otherwise compute a logical state change risk
        if status_update.risk_probability is not None:
            payload["risk_probability"] = status_update.risk_probability
        elif status_update.stage == "QC" and "Fail" in status_update.delay_reason:
            # QC Failure elevates risk
            payload["risk_probability"] = 92
        elif status_update.stage in ["Dispatch", "Delivered"]:
            # Finalizing stage decreases risk to zero
            payload["risk_probability"] = 0
            
        # Update record
        response = client.table("orders").update(payload).eq("id", order_id).execute()
        return compute_dynamic_sla(response.data[0])
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to update order status: {str(e)}"
        )

@app.post("/api/orders/{order_id}/predict-breach")
def predict_breach(order_id: str, authorization: str = Header(None), current_user: dict = Depends(get_current_user)):
    try:
        client = get_auth_client(authorization)
        record_res = client.table("orders").select("*").eq("id", order_id).execute()
        if not record_res.data:
            raise HTTPException(status_code=404, detail="Order not found.")
        
        order = compute_dynamic_sla(record_res.data[0])
        return {
            "order_id": order_id,
            "sla_remaining": order.get("sla_remaining"),
            "stage": order.get("stage"),
            "breach_risk": order.get("breach_risk", 50)
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to predict breach: {str(e)}"
        )

# Live Inventory Endpoints (Authenticated)
@app.get("/api/inventory")
def list_inventory(authorization: str = Header(None), current_user: dict = Depends(get_current_user)):
    try:
        client = get_auth_client(authorization)
        # Fetch inventory sorted by type, then name
        response = client.table("inventory").select("*").order("type", desc=False).order("name", desc=False).execute()
        return response.data
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to retrieve inventory: {str(e)}"
        )

@app.post("/api/inventory")
def update_inventory(item: InventoryUpdate, authorization: str = Header(None), current_user: dict = Depends(get_current_user)):
    try:
        client = get_auth_client(authorization)
        
        # Check if the record already exists
        existing = client.table("inventory").select("*")\
            .eq("name", item.name)\
            .eq("lens_index", item.lens_index)\
            .execute()
            
        if existing.data:
            existing_record = existing.data[0]
            if item.mode == "set":
                new_qty = max(0, item.qty)
            else:
                new_qty = max(0, existing_record["qty"] + item.qty)
                
            response = client.table("inventory").update({
                "qty": new_qty,
                "min_limit": item.min_limit,
                "updated_at": datetime.now().isoformat()
            }).eq("id", existing_record["id"]).execute()
        else:
            response = client.table("inventory").insert({
                "name": item.name,
                "type": item.type,
                "lens_index": item.lens_index,
                "qty": item.qty,
                "min_limit": item.min_limit
            }).execute()
            
        return {"status": "success", "data": response.data}
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to update inventory: {str(e)}"
        )

# Protected API route example (requires a valid Supabase JWT in the headers)
@app.get("/api/protected-data")
def get_protected_data(current_user: dict = Depends(get_current_user)):
    return {
        "message": "Access granted to secure Eluno telemetry.",
        "user_id": current_user.get("sub"),
        "email": current_user.get("email"),
        "role": current_user.get("user_metadata", {}).get("role", "operator")
    }

@app.post("/api/orders/{order_id}/send-alert-email")
def send_alert_email(order_id: str, force: bool = False, authorization: str = Header(None), current_user: dict = Depends(get_current_user)):
    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        client = get_auth_client(authorization)
        record_res = client.table("orders").select("*").eq("id", order_id).execute()
        if not record_res.data:
            raise HTTPException(status_code=404, detail="Order not found.")
        
        order = record_res.data[0]
        history = order.get("history") or []
        stage = order.get("stage", "Intake")
        
        # Get receiver email (the currently logged-in user)
        receiver_email = current_user.get("email")
        if not receiver_email:
            raise HTTPException(status_code=400, detail="Recipient email not found in session.")
        
        # Calculate dynamic SLA and risk
        order_with_sla = compute_dynamic_sla(order)
        risk = order_with_sla.get("breach_risk", 0)
        
        # Check if alert was already sent for this stage (unless forced)
        already_sent = any(
            "Automated SLA Alert" in h.get("action", "") and f"Stage: {stage}" in h.get("action", "")
            for h in history
        )
        
        if already_sent and not force:
            return {
                "status": "skipped",
                "message": f"Alert already sent to {receiver_email} for stage '{stage}'."
            }
        
        # Load SMTP credentials
        smtp_host = os.getenv("SMTP_HOST")
        smtp_port = os.getenv("SMTP_PORT", "587")
        smtp_username = os.getenv("SMTP_USERNAME")
        smtp_password = os.getenv("SMTP_PASSWORD")
        smtp_sender = os.getenv("SMTP_SENDER", smtp_username)
        
        if not smtp_host or not smtp_username or not smtp_password:
            raise HTTPException(
                status_code=500,
                detail="SMTP server credentials are not fully configured in the .env file. Please set SMTP_HOST, SMTP_PORT, SMTP_USERNAME, and SMTP_PASSWORD."
            )
        
        # Create HTML message body
        msg = MIMEMultipart()
        msg['From'] = smtp_sender
        msg['To'] = receiver_email
        msg['Subject'] = f"Eluno SLA Alert - Order {order['id']} ({stage})"
        
        body = f"""
        <html>
          <body style="font-family: Arial, sans-serif; color: #333333; line-height: 1.6;">
            <div style="max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
              <div style="background-color: #ff6b00; padding: 20px; text-align: center; color: white;">
                <h2 style="margin: 0; font-size: 24px; font-weight: bold;">Eluno SLA Breach Warning</h2>
              </div>
              <div style="padding: 24px; background-color: #ffffff;">
                <p>Hello Operator,</p>
                <p>An SLA alert warning was triggered for order <strong>{order['id']}</strong>. Please find the details below:</p>
                
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                  <tr style="background-color: #f9f9f9;">
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold; width: 150px;">Order ID</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee;">{order['id']}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold;">Patient Name</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee;">{order['patient_name']}</td>
                  </tr>
                  <tr style="background-color: #f9f9f9;">
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold;">Patient Email</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee;">{order['patient_email']}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold;">Prescription</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee;">R: {order['sph']} | L: {order['cyl']}</td>
                  </tr>
                  <tr style="background-color: #f9f9f9;">
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold;">Current Stage</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold; color: #ff6b00;">{order['stage']}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold;">Time Remaining</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold;">{order_with_sla['sla_remaining']} minutes</td>
                  </tr>
                  <tr style="background-color: #f9f9f9;">
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold;">Breach Risk (XGBoost)</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold; color: {'#ef5350' if risk > 65 else '#ffa726' if risk > 40 else '#66bb6a'};">{risk}%</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold;">Logged Delay Reason</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-style: italic;">{order.get('delay_reason') or 'No explanation provided.'}</td>
                  </tr>
                </table>
                
                <p style="margin-top: 24px;">Please take appropriate actions to resolve potential manufacturing bottlenecks.</p>
              </div>
              <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 11px; color: #777777; border-top: 1px solid #eeeeee;">
                Sent automatically by Eluno Order Management System.
              </div>
            </div>
          </body>
        </html>
        """
        msg.attach(MIMEText(body, 'html'))
        
        # Connect to SMTP and send
        server = smtplib.SMTP(smtp_host, int(smtp_port))
        server.starttls()
        server.login(smtp_username, smtp_password)
        server.sendmail(smtp_sender, receiver_email, msg.as_string())
        server.quit()
        
        # Save to history trail
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        history.append({
            "time": now_str,
            "action": f"Automated SLA Alert sent to {receiver_email} (Stage: {stage}, Risk: {risk}%)"
        })
        client.table("orders").update({"history": history}).eq("id", order_id).execute()
        
        return {"status": "success", "message": f"Alert email successfully sent to {receiver_email}"}
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"SMTP email transmission failed: {str(e)}"
        )

# Serve static frontend files (index.html, styles.css, app.js, images, etc.)
# Note: Mount static files AFTER API routes to prevent catch-all conflicts
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # Run server locally on port 8000
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
