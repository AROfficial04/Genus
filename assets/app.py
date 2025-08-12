import pandas as pd

# Column headers exactly as required
columns = [
    "Region Name",
    "Feeder Name",
    "Feeder Code",
    "Feeder Day2 reading",
    "Feeder Day1 reading",
    "MF Feeder",
    "DT Name",
    "DT Code",
    "DT Day2 Reading",
    "DT Day1 Reading",
    "MF DT",
    "Meter No.",
    "Meter Day1 Reading",
    "Meter Day2 Reading",
    "Daily energy",
    "Load Data"
]

# Setup hierarchy
regions = ["Region 1", "Region 2", "Region 3"]
feeders_per_region = 2
dts_per_feeder = 4
meters_per_dt = 10

# Base feeder readings
feeder_start_values = {
    "F001": (5100, 5320),
    "F002": (6200, 6430),
    "F003": (7300, 7530),
    "F004": (8400, 8630),
    "F005": (9500, 9730),
    "F006": (10600, 10830),
}

# Base DT readings pattern
dt_patterns = [
    (1000, 1050),
    (2000, 2050),
    (3000, 3050),
    (4000, 4050)
]

# Base meter advances
meter_advances = [5, 4, 6, 3, 7, 5, 6, 4, 4, 4]

rows = []

feeder_index = 0
for region in regions:
    for f in range(1, feeders_per_region + 1):
        feeder_index += 1
        feeder_code = f"F{feeder_index:03d}"
        f_day1, f_day2 = feeder_start_values[feeder_code]
        # Each feeder has 4 DTs
        for dt_num in range(1, dts_per_feeder + 1):
            dt_code = f"{feeder_code}DT{dt_num:03d}"
            dt_day1, dt_day2 = dt_patterns[dt_num - 1]
            # Each DT has 10 meters
            for m in range(1, meters_per_dt + 1):
                m_no = f"MTR-{dt_code}-{m:02d}"
                m_day1 = 100 * m
                m_day2 = m_day1 + meter_advances[m - 1]
                daily_energy_flag = "Yes" if m % 2 == 1 else "No"
                load_data_flag = "No" if m % 2 == 1 else "Yes"
                rows.append([
                    region,
                    f"Feeder {feeder_code}",
                    feeder_code,
                    f_day2,
                    f_day1,
                    1,
                    f"DT {dt_code}",
                    dt_code,
                    dt_day2,
                    dt_day1,
                    1,
                    m_no,
                    m_day1,
                    m_day2,
                    daily_energy_flag,
                    load_data_flag
                ])

# Create DataFrame
df = pd.DataFrame(rows, columns=columns)

# Save to Excel
df.to_excel("sample_feeder_dt_meter_data.xlsx", index=False)

print("✅ sample_feeder_dt_meter_data.xlsx created with", len(df), "rows")
