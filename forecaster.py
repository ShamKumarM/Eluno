import math
import random
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from sklearn.ensemble import RandomForestRegressor

class DemandForecaster:
    def __init__(self):
        self.model = None
        self.lens_type_map = {
            'Single Vision': 0,
            'Bifocal': 1,
            'Progressive': 2,
            'Luminescent': 3
        }
        self.inverse_lens_type_map = {v: k for k, v in self.lens_type_map.items()}

    def generate_mock_orders(self, n=1000):
        """Generates 1,000 realistic historical orders with variations."""
        sphs = [round(x, 2) for x in np.arange(-6.00, 4.25, 0.25)]
        cyls = [round(x, 2) for x in np.arange(-3.00, 0.25, 0.25)]
        lens_types = list(self.lens_type_map.keys())
        indices = [1.50, 1.60, 1.67, 1.74]
        coatings = ['Standard Hard Coat', 'Anti-Glare ARC', 'Blue Shield Shield', 'Luminescent Solar Tint']
        stores = ['Indiranagar', 'Jayanagar', 'Koramangala', 'Online']
        
        orders_data = []
        # Generate orders distributed over the last 12 months (365 days)
        start_date = datetime.now() - timedelta(days=365)
        
        for _ in range(n):
            created_at = start_date + timedelta(days=random.randint(0, 365))
            
            # Make common sphere powers (like -2.75, -2.00, -2.50) have higher demand weights
            sph_weights = [15 if x in [-2.00, -2.50, -2.75, -3.00] else 2 for x in sphs]
            sph = random.choices(sphs, weights=sph_weights)[0]
            
            cyl_weights = [10 if x in [0.00, -0.50, -1.00, -1.25] else 2 for x in cyls]
            cyl = random.choices(cyls, weights=cyl_weights)[0]
            
            # Weighted index values (1.50 standard has higher volume)
            index_weights = [50, 30, 15, 5]
            index_val = random.choices(indices, weights=index_weights)[0]
            
            lens_type = random.choice(lens_types)
            coating = random.choice(coatings)
            store = random.choice(stores)
            
            orders_data.append({
                'sph': sph,
                'cyl': cyl,
                'lens_type': lens_type,
                'index_value': index_val,
                'coating': coating,
                'store': store,
                'month': created_at.month,
                'year': created_at.year
            })
            
        return pd.DataFrame(orders_data)

    def train(self):
        """Trains the Random Forest model on aggregated monthly demand."""
        df = self.generate_mock_orders(1000)
        
        # Aggregate orders count per month to get actual monthly demand
        agg_df = df.groupby(['year', 'month', 'index_value', 'lens_type', 'sph', 'cyl']).size().reset_index(name='monthly_demand')
        
        # Encode categorical lens types
        agg_df['lens_type_encoded'] = agg_df['lens_type'].map(self.lens_type_map)
        
        # Prepare training matrices
        X = agg_df[['index_value', 'lens_type_encoded', 'sph', 'cyl']]
        y = agg_df['monthly_demand']
        
        # Fit Random Forest Regressor
        self.model = RandomForestRegressor(n_estimators=50, max_depth=10, random_state=42)
        self.model.fit(X, y)
        print("Eluno Demand Forecasting Random Forest Model trained successfully.")

    def predict_demand(self, index_value, lens_type, sph, cyl):
        """Predicts monthly demand for a given lens specification."""
        if self.model is None:
            self.train()
            
        try:
            idx = float(index_value)
            sph_val = float(sph)
            cyl_val = float(cyl)
        except (ValueError, TypeError):
            idx, sph_val, cyl_val = 1.50, 0.00, 0.00
            
        lt_encoded = self.lens_type_map.get(lens_type, 0)
        
        # Perform inference
        features = np.array([[idx, lt_encoded, sph_val, cyl_val]])
        pred = self.model.predict(features)[0]
        
        # Ensure a clean minimum value
        return max(0.2, round(pred, 2))

    def get_replenishment_suggestion(self, index_value, lens_type, sph, cyl, current_qty):
        """Computes safety stock suggestions and Poisson stockout probabilities."""
        pred_monthly = self.predict_demand(index_value, lens_type, sph, cyl)
        
        # Convert expected monthly demand to weekly mean (lambda)
        weekly_lambda = pred_monthly / 4.33
        
        # Recommended stock level (1.5x monthly demand + safety buffer of 3 units)
        recommended_stock = int(math.ceil(1.5 * pred_monthly + 3))
        
        # Poisson cumulative distribution: P(Demand <= current_qty)
        # Numerical-stable iterative computation
        cdf = 0.0
        term = math.exp(-weekly_lambda)
        for i in range(int(current_qty) + 1):
            cdf += term
            term = term * weekly_lambda / (i + 1)
            
        # Probability of stockout next week: P(Demand > current_qty)
        stockout_prob = 1.0 - cdf
        stockout_prob_pct = int(round(max(0.0, min(1.0, stockout_prob)) * 100))
        
        # Determine frequency feedback message
        if pred_monthly >= 1.2:
            freq_msg = f"Power {sph} is frequently ordered."
        else:
            freq_msg = f"Power {sph} has regular/low demand."
            
        return {
            "expected_monthly_demand": float(round(pred_monthly, 1)),
            "recommended_stock": recommended_stock,
            "stockout_probability_pct": stockout_prob_pct,
            "freq_msg": freq_msg
        }
