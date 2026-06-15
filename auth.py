import os
from fastapi import Header, HTTPException, status
from supabase import create_client, Client

# Initialize Supabase Client
supabase_url = os.getenv("SUPABASE_URL")
supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")

if not supabase_url or not supabase_anon_key:
    # We raise an informative warning but let the server boot.
    # The application will raise 500 when authentication is attempted.
    print("WARNING: SUPABASE_URL or SUPABASE_ANON_KEY not set in environment.")

supabase: Client = None
if supabase_url and supabase_anon_key:
    # Remove mock/template indicators if they are present
    if "your-project-id" not in supabase_url and "your-supabase-anon-key" not in supabase_anon_key:
        supabase = create_client(supabase_url, supabase_anon_key)

def get_current_user(authorization: str = Header(None)) -> dict:
    """
    Dependency to verify the Supabase JWT token from the Authorization header.
    Expects header format: 'Bearer <JWT_TOKEN>'
    """
    if not supabase:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Supabase credentials are not configured in the backend .env file."
        )

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization Header."
        )

    try:
        # Check Authorization header format
        scheme, token = authorization.split()
        if scheme.lower() != 'bearer':
            raise ValueError()
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization scheme. Use 'Bearer <token>'."
        )

    try:
        # Call Supabase Auth API to get user info from JWT
        response = supabase.auth.get_user(token)
        
        # In supabase-py v2, response.user contains the user dict/object
        if not response or not getattr(response, "user", None):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired session token."
            )
            
        # Return user data as a dictionary
        user_obj = response.user
        return {
            "sub": user_obj.id,
            "email": user_obj.email,
            "user_metadata": getattr(user_obj, "user_metadata", {}) or {}
        }

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Authentication failed: {str(e)}"
        )
