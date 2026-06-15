import os
import random
import pandas as pd
import numpy as np
from xgboost import XGBClassifier

class SlaBreachPredictor:
    def __init__(self):
        self.model = None
        self.csv_path = "breach_training_data.csv"
        self.stage_map = {
            "Intake": 0,
            "Stocked at Inventary": 1,
            "Lab Surfacing": 2,
            "Coating": 3,
            "Mounting": 4,
            "QC": 5,
            "Dispatch": 6,
            "Delivered": 7
        }
        
    def generate_training_data(self, n=1000):
        """Generates mock historical data for SLA breach classification training."""
        stages = list(self.stage_map.keys())
        data = []
        
        # Approximate average minutes remaining to complete from each stage
        stage_required_minutes = {
            "Intake": 480,
            "Stocked at Inventary": 360,
            "Lab Surfacing": 240,
            "Coating": 180,
            "Mounting": 120,
            "QC": 60,
            "Dispatch": 30,
            "Delivered": 0
        }
        
        for _ in range(n):
            stage = random.choice(stages)
            stage_encoded = self.stage_map[stage]
            
            if stage == "Delivered":
                sla_remaining = 0
                will_breach = 0
            else:
                # Random remaining SLA time in minutes
                # Can range from breached (-120 mins) up to comfortably ahead (2880 mins / 48 hours)
                sla_remaining = random.randint(-120, 2880)
                
                if sla_remaining <= 0:
                    # Already breached
                    will_breach = 1
                else:
                    req_time = stage_required_minutes[stage]
                    # Calculate probability of breach based on time deficiency
                    if sla_remaining < req_time:
                        # Closer to 0 sla_remaining means higher breach probability
                        prob = 1.0 - (sla_remaining / req_time)
                        # Add some variance/noise
                        prob = min(0.99, max(0.05, prob + random.uniform(-0.15, 0.15)))
                    else:
                        prob = 0.05 + random.uniform(0.0, 0.1) # low chance of breach
                        
                    will_breach = 1 if random.random() < prob else 0
            
            data.append({
                "stage": stage,
                "stage_encoded": stage_encoded,
                "sla_remaining": sla_remaining,
                "will_breach": will_breach
            })
            
        df = pd.DataFrame(data)
        df.to_csv(self.csv_path, index=False)
        print(f"Generated mock breach training data and saved to {self.csv_path}")
        return df

    def train(self):
        """Trains the XGBoost classifier model."""
        if not os.path.exists(self.csv_path):
            df = self.generate_training_data(1000)
        else:
            df = pd.read_csv(self.csv_path)
            
        X = df[["stage_encoded", "sla_remaining"]]
        y = df["will_breach"]
        
        # Initialize and train XGBoost classifier
        self.model = XGBClassifier(
            n_estimators=50,
            max_depth=4,
            learning_rate=0.1,
            random_state=42,
            eval_metric="logloss"
        )
        self.model.fit(X, y)
        print("SLA Breach Predictor XGBoost model trained successfully.")

    def predict_probability(self, stage_name: str, sla_remaining: int) -> int:
        """Predicts the percentage probability of an SLA breach (0-100)."""
        if self.model is None:
            self.train()
            
        stage_encoded = self.stage_map.get(stage_name, 0)
        
        # If already delivered, risk is 0%
        if stage_name == "Delivered":
            return 0
            
        # If already breached, risk is 100%
        if sla_remaining <= 0:
            return 100
            
        features = pd.DataFrame([{
            "stage_encoded": stage_encoded,
            "sla_remaining": sla_remaining
        }])
        
        try:
            # predict_proba returns [prob_class_0, prob_class_1]
            probs = self.model.predict_proba(features)[0]
            breach_prob = probs[1]
            return int(round(breach_prob * 100))
        except Exception as e:
            print(f"Error predicting breach risk: {e}")
            # Fallback to simple calculation if model fails
            return 50
