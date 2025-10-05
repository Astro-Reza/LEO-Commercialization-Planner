from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from skyfield.api import EarthSatellite, Topos, load, wgs84
from datetime import datetime, timezone, timedelta
from geopy.distance import geodesic, great_circle
import numpy as np
import os
import math
import rasterio
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import cartopy.crs as ccrs
import cartopy.feature as cfeature
from rasterio.features import geometry_mask
from shapely.geometry import mapping, Polygon
from shapely.ops import unary_union
from pyproj import Geod

# --- ECONOMIC ANALYSIS FUNCTION ---
def satellite_economic_analysis(population, area_km2,
                                adoption_rate=0.1,
                                arpu_monthly=5,
                                capex=500_000_000,
                                opex_annual=50_000_000):
    potential_users = population * adoption_rate
    annual_revenue = potential_users * arpu_monthly * 12
    revenue_per_km2 = (annual_revenue / area_km2) if area_km2 > 0 else 0
    population_density = (population / area_km2) if area_km2 > 0 else 0
    profit_annual = annual_revenue - opex_annual
    payback_period_years = capex / profit_annual if profit_annual > 0 else float('inf')
    
    return {
        "Potential Users": int(potential_users),
        "Annual Revenue (USD)": int(annual_revenue),
        "Revenue per km² (USD)": round(revenue_per_km2, 2),
        "Population Density (per km²)": round(population_density, 2),
        "Payback Period (years)": round(payback_period_years, 2) if payback_period_years != float('inf') else "N/A"
    }

# Initialize Flask App
app = Flask(__name__)
CORS(app)

# --- TLE Data & Skyfield Setup (Defaults) ---
tle_lines = [
    "ISS (ZARYA)",
    "1 25544U 98067A   25277.51233796  .00016717  00000-0  30327-3 0  9993",
    "2 25544  51.6416 255.4363 0006753 133.5855 226.5447 15.49479347343467"
]
ts = load.timescale()
satellite = EarthSatellite(tle_lines[1], tle_lines[2], tle_lines[0], ts)
tle_epoch = satellite.epoch.utc_datetime()

# --- Global Data Loading ---
TIF_FILE_PATH = os.path.join("population_map", "gpw_v4_2020.tif")
POPULATION_COUNT_DATA = np.load("population_count.npy")
with rasterio.open(TIF_FILE_PATH) as src:
    RASTER_TRANSFORM = src.transform
    RASTER_SHAPE = (src.height, src.width)
geod = Geod(ellps="WGS84")

# --- Helper Function ---
def calculate_spotbeam_polygon(center_lat, center_lon, radius_km, num_points=50):
    g = geodesic()
    polygon_points = []
    for i in range(num_points):
        bearing = i * (360 / num_points)
        dest_point = g.destination(point=(center_lat, center_lon), bearing=bearing, distance=radius_km)
        polygon_points.append([dest_point.longitude, dest_point.latitude])
    polygon_points.append(polygon_points[0])
    return polygon_points

# --- API Endpoints ---

@app.route('/api/update-tle', methods=['POST'])
def update_tle():
    global satellite, tle_epoch, tle_lines
    data = request.get_json()
    if not data or 'line1' not in data or 'line2' not in data or 'line3' not in data:
        return jsonify({'error': 'Invalid TLE data provided.'}), 400
    try:
        new_tle_lines = [data['line1'], data['line2'], data['line3']]
        new_satellite = EarthSatellite(new_tle_lines[1], new_tle_lines[2], new_tle_lines[0], ts)
        satellite, tle_epoch, tle_lines = new_satellite, new_satellite.epoch.utc_datetime(), new_tle_lines
        return jsonify({'message': 'TLE updated successfully.', 'name': tle_lines[0], 'epoch_iso': tle_epoch.isoformat()})
    except Exception as e:
        return jsonify({'error': f'Invalid TLE format or checksum. Details: {e}'}), 400

@app.route('/api/position')
def get_position():
    try:
        elapsed_seconds = float(request.args.get('elapsed_seconds', '0'))
        spotbeam_radius_km = float(request.args.get('radius_km', '1300')) # Default radius
        sim_time = tle_epoch + timedelta(seconds=elapsed_seconds)
        subpoint = wgs84.subpoint(satellite.at(ts.from_datetime(sim_time)))
        spotbeam_polygon = calculate_spotbeam_polygon(subpoint.latitude.degrees, subpoint.longitude.degrees, spotbeam_radius_km)
        return jsonify({
            'simulation_time_iso': sim_time.isoformat(),
            'elapsed_seconds': elapsed_seconds,
            'latitude': subpoint.latitude.degrees,
            'longitude': subpoint.longitude.degrees,
            'spotbeam_polygon': spotbeam_polygon
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
        
@app.route('/api/pass-intensity')
def get_pass_intensity():
    global tle_lines, ts
    try:
        duration_hours, time_step_seconds = 24, 20
        lat_bins, lon_bins = np.arange(-90, 91, 2), np.arange(-180, 181, 2)
        dwell_time_grid = np.zeros((len(lat_bins), len(lon_bins)))
        sat = EarthSatellite(tle_lines[1], tle_lines[2], tle_lines[0], ts)
        t0, t1 = ts.now(), ts.now() + timedelta(hours=duration_hours)
        time_points = ts.linspace(t0, t1, int((duration_hours * 3600) / time_step_seconds))
        subpoints = sat.at(time_points).subpoint()
        lat_indices, lon_indices = np.digitize(subpoints.latitude.degrees, lat_bins), np.digitize(subpoints.longitude.degrees, lon_bins)
        for i in range(len(lat_indices)):
            lat_idx, lon_idx = lat_indices[i] - 1, lon_indices[i] - 1
            if 0 <= lat_idx < len(lat_bins) and 0 <= lon_idx < len(lon_bins):
                dwell_time_grid[lat_idx, lon_idx] += time_step_seconds
        heatmap_data, max_dwell_time = [], np.max(dwell_time_grid)
        if max_dwell_time > 0:
            rows, cols = np.where(dwell_time_grid > 0)
            for r, c in zip(rows, cols):
                intensity = dwell_time_grid[r, c] / max_dwell_time
                heatmap_data.append([lat_bins[r] + 1, lon_bins[c] + 1, intensity])
        return jsonify({'heatmap_data': heatmap_data})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/population-density')
def generate_population_map():
    output_dir = os.path.join('static', 'textures')
    output_filename = "population_density_map.png"
    output_path = os.path.join(output_dir, output_filename)
    map_url = f'/static/textures/{output_filename}'
    os.makedirs(output_dir, exist_ok=True)
    if not os.path.exists(output_path):
        try:
            with rasterio.open(TIF_FILE_PATH) as src:
                data, transform, extent = src.read(1), src.transform, src.bounds
            cols, roll_amount = data.shape[1], data.shape[1] // 2
            data = np.roll(data, roll_amount, axis=1)
            land_feature = cfeature.NaturalEarthFeature("physical", "land", scale="110m")
            land_mask = geometry_mask([mapping(geom) for geom in land_feature.geometries()], transform=transform, invert=True, out_shape=data.shape)
            land_mask = np.roll(land_mask, roll_amount, axis=1)
            data_land = np.where(land_mask, data, -9999)
            data_log = np.log10(1 + data_land)
            cmap = plt.get_cmap('plasma')
            cmap.set_under(alpha=0)
            fig, ax = plt.subplots(figsize=(12, 6), dpi=200, subplot_kw={'projection': ccrs.PlateCarree()})
            fig.subplots_adjust(left=0, right=1, bottom=0, top=1)
            new_extent = (0, 360, extent.bottom, extent.top)
            ax.set_extent(new_extent, crs=ccrs.PlateCarree())
            ax.imshow(data_log, origin="upper", extent=new_extent, transform=ccrs.PlateCarree(), cmap=cmap, vmin=0.1)
            plt.savefig(output_path, transparent=True, bbox_inches='tight', pad_inches=0)
            plt.close(fig)
        except Exception as e:
            return jsonify({'error': f"Failed to generate map: {str(e)}"}), 500
    return jsonify({'map_url': map_url})

@app.route('/api/coverage-score')
def get_coverage_score():
    try:
        spotbeam_radius_km, time_step_seconds = 1300, 10
        mean_motion = float(tle_lines[2][52:63])
        period_seconds = (24 * 3600) / mean_motion
        covered_pixels = set()
        for t in np.arange(0, period_seconds, time_step_seconds):
            subpoint = wgs84.subpoint(satellite.at(ts.from_datetime(tle_epoch + timedelta(seconds=t))))
            lat, lon = subpoint.latitude.degrees, subpoint.longitude.degrees
            center_col, center_row = ~RASTER_TRANSFORM * (lon, lat)
            col_radius = int((spotbeam_radius_km / (111.0 * math.cos(math.radians(lat)))) / abs(RASTER_TRANSFORM.a))
            row_radius = int((spotbeam_radius_km / 111.0) / abs(RASTER_TRANSFORM.e))
            row_start, row_stop = max(0, int(center_row) - row_radius), min(RASTER_SHAPE[0], int(center_row) + row_radius + 1)
            col_start, col_stop = max(0, int(center_col) - col_radius), min(RASTER_SHAPE[1], int(center_col) + col_radius + 1)
            for r in range(row_start, row_stop):
                for c in range(col_start, col_stop): covered_pixels.add((r, c))
        total_population = np.nansum([POPULATION_COUNT_DATA[r, c] for r, c in covered_pixels])
        return jsonify({'coverage_score': int(total_population)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/coverage-area')
def get_coverage_area():
    try:
        spotbeam_width_km, time_step_seconds = 1300, 10
        mean_motion = float(tle_lines[2][52:63])
        period_seconds = (24 * 3600) / mean_motion
        all_strips, track_points = [], []
        for t in np.arange(0, period_seconds + time_step_seconds, time_step_seconds):
            subpoint = wgs84.subpoint(satellite.at(ts.from_datetime(tle_epoch + timedelta(seconds=t))))
            track_points.append((subpoint.longitude.degrees, subpoint.latitude.degrees))
        for i in range(1, len(track_points)):
            lon, lat = track_points[i]
            lon_prev, lat_prev = track_points[i-1]
            if abs(lon - lon_prev) > 180: continue
            length = np.hypot(lon - lon_prev, lat - lat_prev)
            if length > 0:
                nx, ny, half_w_deg = -(lat - lat_prev)/length, (lon - lon_prev)/length, (spotbeam_width_km / 111.0) / 2.0
                all_strips.append(Polygon([(lon_prev + nx*half_w_deg, lat_prev + ny*half_w_deg), (lon_prev - nx*half_w_deg, lat_prev - ny*half_w_deg), (lon - nx*half_w_deg, lat - ny*half_w_deg), (lon + nx*half_w_deg, lat + ny*half_w_deg)]))
        if not all_strips: return jsonify({'coverage_area_km2': 0})
        coverage_union = unary_union(all_strips)
        total_area_m2 = sum(abs(geod.polygon_area_perimeter(*poly.exterior.xy)[0]) for poly in getattr(coverage_union, 'geoms', [coverage_union]) if not poly.is_empty and hasattr(poly, 'exterior'))
        return jsonify({'coverage_area_km2': int(total_area_m2 / 1e6)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/economic-analysis')
def get_economic_analysis():
    try:
        population = int(request.args.get('population'))
        area_km2 = int(request.args.get('area_km2'))
        adoption_rate = float(request.args.get('adoption_rate', 0.1))
        arpu_monthly = float(request.args.get('arpu_monthly', 5))
        result = satellite_economic_analysis(population, area_km2, adoption_rate, arpu_monthly)
        return jsonify(result)
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid or missing input parameters. Please calculate Population and Area first.'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    os.makedirs(os.path.join('static', 'textures'), exist_ok=True)
    app.run(debug=True, port=5000)

