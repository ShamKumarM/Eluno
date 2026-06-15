import random
import numpy as np
from datetime import datetime, timedelta
import json

def generate_sql():
    names = ["Amit Sharma", "Priya Patel", "Rajesh Kumar", "Sunita Rao", "Vijay Singh", 
             "Ananya Desai", "Rohan Mehta", "Neha Gupta", "Arjun Reddy", "Kiran Joshi",
             "Siddharth Shah", "Deepa Nair", "Sanjay Dutt", "Pooja Hegde", "Rahul Verma"]
    
    lens_types = ["Single Vision", "Bifocal", "Progressive", "Luminescent"]
    indices = ["1.50", "1.60", "1.67", "1.74"]
    coatings = ["Standard Hard Coat", "Anti-Glare ARC", "Blue Shield Shield", "Luminescent Solar Tint"]
    stores = ["Indiranagar", "Jayanagar", "Koramangala", "Online"]
    
    sphs = [round(x, 2) for x in np.arange(-6.00, 4.25, 0.25)]
    cyls = [round(x, 2) for x in np.arange(-3.00, 0.25, 0.25)]
    
    sql_statements = []
    
    # Generate 1000 insert queries
    start_date = datetime.now() - timedelta(days=365)
    
    for i in range(1000):
        name = random.choice(names)
        email = name.lower().replace(" ", "") + "@gmail.com"
        
        sph_weights = [15 if x in [-2.00, -2.50, -2.75, -3.00] else 2 for x in sphs]
        sph = random.choices(sphs, weights=sph_weights)[0]
        sph_str = f"{sph:+.2f}" if sph > 0 else f"{sph:.2f}"
        
        cyl_weights = [10 if x in [0.00, -0.50, -1.00, -1.25] else 2 for x in cyls]
        cyl = random.choices(cyls, weights=cyl_weights)[0]
        cyl_str = f"{cyl:+.2f}" if cyl > 0 else f"{cyl:.2f}"
        
        lens_type = random.choice(lens_types)
        index_val = random.choice(indices)
        coating = random.choice(coatings)
        store = random.choice(stores)
        
        created_at = start_date + timedelta(days=random.randint(0, 365), hours=random.randint(0, 23), minutes=random.randint(0, 59))
        created_at_str = created_at.strftime("%Y-%m-%d %H:%M:%S+00")
        
        hist = [
            {"time": created_at.strftime("%Y-%m-%d %H:%M"), "action": f"Order Placed at {store}"},
            {"time": (created_at + timedelta(hours=2)).strftime("%Y-%m-%d %H:%M"), "action": "Stage changed to Lab Surfacing"},
            {"time": (created_at + timedelta(hours=6)).strftime("%Y-%m-%d %H:%M"), "action": "Stage changed to QC"},
            {"time": (created_at + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M"), "action": "Stage changed to Delivered"}
        ]
        history_json = json.dumps(hist)
        
        sql = (
            f"INSERT INTO public.orders "
            f"(patient_name, patient_email, sph, cyl, lens_type, index_value, coating, store, stage, sla_remaining, sla_total, risk_probability, history, created_at) "
            f"VALUES ("
            f"'{name}', '{email}', '{sph_str}', '{cyl_str}', '{lens_type}', '{index_val}', '{coating}', '{store}', "
            f"'Delivered', 0, 960, 0, '{history_json}'::jsonb, '{created_at_str}'"
            f");"
        )
        sql_statements.append(sql)
        
    # Write to seed_data.sql
    with open("seed_data.sql", "w", encoding="utf-8") as f:
        f.write("-- Eluno Seeding Script (1000 orders)\n")
        f.write("\n".join(sql_statements))
        f.write("\n")
        
    print("Successfully generated seed_data.sql with 1000 INSERT statements.")

if __name__ == "__main__":
    generate_sql()
