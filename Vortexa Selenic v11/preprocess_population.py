import sys
import json
import numpy as np
import rasterio
from rasterio.transform import xy
from rasterio.mask import mask
import geopandas as gpd

# --- Fix Windows console encoding ---
sys.stdout.reconfigure(encoding='utf-8')


def convert_density_to_count(
    tif_path: str,
    output_path: str,
    land_shapefile: str,
    density_units: str = 'per_km2',  # change to per_km2 if per km
    target_pop: float = 7_000_000_000,
    default_crs: str = "EPSG:4326",
    verbose: bool = True
):
    """
    Convert population density GeoTIFF -> population count per pixel numpy array.

    Features:
      - Land mask to exclude ocean pixels
      - CRS fallback (default EPSG:4326)
      - Global normalization to 7.8B
      - UTF-8 safe I/O
    """
    try:
        # --- Load raster ---
        with rasterio.open(tif_path) as src:
            density = src.read(1, masked=True).astype(np.float64)
            transform = src.transform
            crs = src.crs
            res = src.res
            nrows, ncols = density.shape

            # --- Handle missing CRS ---
            if crs is None:
                print(f"⚠️ No CRS found in raster. Assigning default CRS: {default_crs}")
                crs = rasterio.crs.CRS.from_string(default_crs)

            if verbose:
                print(f"Opened raster: {tif_path}")
                print(f"  CRS: {crs}")
                print(f"  Resolution (x,y): {res}")
                print(f"  Shape: {(nrows, ncols)}")

            # --- Load land mask shapefile ---
            gdf = gpd.read_file(land_shapefile, encoding='utf-8')
            if gdf.crs is None:
                print(f"⚠️ No CRS found in shapefile. Assigning default CRS: {default_crs}")
                gdf.set_crs(default_crs, inplace=True)

            if gdf.crs != crs:
                gdf = gdf.to_crs(crs)
                if verbose:
                    print(f"  Reprojected shapefile to match raster CRS: {crs}")

            # --- Apply land mask ---
            masked_data, _ = mask(src, gdf.geometry, crop=False)
            density = np.ma.masked_array(masked_data[0], mask=(masked_data[0] == src.nodata))

            if verbose:
                land_pixels = np.count_nonzero(~density.mask)
                total_pixels = density.size
                print(f"  Land pixels kept: {land_pixels:,} / {total_pixels:,}")

            # --- Compute pixel area ---
            if getattr(crs, "is_geographic", False):
                xres_deg = abs(res[0])
                yres_deg = abs(res[1])
                rows = np.arange(nrows)
                cols0 = np.zeros(nrows, dtype=int)
                xs, lats = xy(transform, rows, cols0, offset='center')
                lats = np.array(lats)
                km_per_deg_lon = 111.320 * np.cos(np.radians(lats))
                pixel_width_km = xres_deg * km_per_deg_lon
                pixel_height_km = yres_deg * (111.132 - 0.559 * np.sin(np.radians(lats))**2 + 0.0012 * np.sin(np.radians(lats))**4)
                pixel_area_km2 = (pixel_width_km * pixel_height_km)[:, np.newaxis]
                if verbose:
                    print("  Geographic CRS branch (variable pixel area by latitude)")
            else:
                xres_m = abs(res[0])
                yres_m = abs(res[1])
                pixel_area_km2 = (xres_m * yres_m) / 1e6
                if verbose:
                    print("  Projected CRS branch (constant pixel area)")

            # --- Compute raw population counts ---
            filled = np.ma.filled(density, 0.0)
            if density_units == 'per_km2':
                pop_counts = filled * pixel_area_km2
            elif density_units == 'per_pixel':
                pop_counts = filled
            else:
                raise ValueError("density_units must be 'per_km2' or 'per_pixel'")

            total_pop_raw = float(np.sum(pop_counts))

            # --- Normalize to target population ---
            scale_factor = target_pop / total_pop_raw
            pop_counts  *= scale_factor
            total_pop_adjusted = float(np.sum(pop_counts))

            # --- Save array and metadata ---
            np.save(output_path, pop_counts)
            metadata = {
                "raster_source": tif_path,
                "land_mask_source": land_shapefile,
                "total_raw": total_pop_raw,
                "total_adjusted": total_pop_adjusted,
                "scale_factor": scale_factor,
                "target_population": target_pop,
                "crs": str(crs),
                "resolution": res,
                "default_crs_applied": (crs.to_string() == default_crs)
            }
            with open(output_path.replace(".npy", "_meta.json"), "w", encoding="utf-8") as f:
                json.dump(metadata, f, indent=2, ensure_ascii=False)

            print("\n--- Verification ---")
            print(f"Raw total population: {total_pop_raw:,.0f}")
            print(f"Applied scale factor: {scale_factor:.6f}")
            print(f"Adjusted total population: {total_pop_adjusted:,.0f}")
            print(f"Population array saved -> {output_path}")
            print(f"Metadata saved -> {output_path.replace('.npy', '_meta.json')}\n")

            return total_pop_adjusted

    except Exception as e:
        print("❌ Error in conversion:", e)
        raise


# --- Run script ---
if __name__ == '__main__':
    gpw_v4_density_file = r"population_map\gpw_v4_2020.tif"
    land_mask_file = r"land_render\ne_10m_land.shp"
    output_numpy_file = "population_count.npy"

    convert_density_to_count(gpw_v4_density_file, output_numpy_file, land_mask_file)
