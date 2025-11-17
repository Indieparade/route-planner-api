require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Load ORS key from .env
const ORS_API_KEY = process.env.ORS_API_KEY;

const GEOCODE_URL = 'https://api.openrouteservice.org/geocode/search';
const MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-car';

// 1) Turn a postcode into coordinates (lon, lat)
async function geocodePostcode(postcode) {
  const trimmed = String(postcode).trim();
  if (!trimmed) {
    throw new Error('Empty postcode');
  }

  const res = await axios.get(GEOCODE_URL, {
    params: {
      api_key: ORS_API_KEY,
      text: trimmed,
      boundary_country: 'GB'
    }
  });

  const features = res.data.features;
  if (!features || features.length === 0) {
    throw new Error(`Could not geocode postcode: ${trimmed}`);
  }

  const [lon, lat] = features[0].geometry.coordinates;
  return { lon, lat };
}

// 2) Ask ORS Matrix API for distance & duration between all points
async function getMatrix(locations) {
  const body = {
    locations: locations.map(loc => [loc.lon, loc.lat]),
    metrics: ['distance', 'duration']
  };

  const res = await axios.post(MATRIX_URL, body, {
    headers: {
      'Authorization': ORS_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  const distances = res.data.distances;
  const durations = res.data.durations;

  if (!distances || !durations) {
    throw new Error('Matrix API did not return distances/durations');
  }

  return { distances, durations };
}

// 3) Simple nearest-neighbour route optimisation (round trip)
//    Used as a fallback when there are lots of stops.
function optimiseNearestNeighbour(matrix) {
  const n = matrix.length;
  const visited = new Array(n).fill(false);

  const route = [0]; // start at index 0
  visited[0] = true;

  for (let step = 1; step < n; step++) {
    const last = route[route.length - 1];
    let bestIdx = -1;
    let bestVal = Infinity;

    for (let i = 1; i < n; i++) {
      if (!visited[i] && matrix[last][i] < bestVal) {
        bestVal = matrix[last][i];
        bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      visited[bestIdx] = true;
      route.push(bestIdx);
    }
  }

  // Close the loop back to the depot
  route.push(0);

  return route; // array of indices, e.g. [0, 2, 3, 1, 0]
}

// 3b) Exact route optimisation using duration matrix (round trip)
//     Tries all permutations of the middle stops for up to 9 stops.
//     Minimises total driving time.
function optimiseExactByDuration(durations) {
  const n = durations.length;

  // If there are 0 or 1 stops, route is just start -> (maybe one stop) -> start
  if (n <= 2) {
    const base = [0];
    if (n === 2) base.push(1);
    base.push(0);
    return base;
  }

  // Indices 1..n-1 are the "middle" stops
  const nodes = [];
  for (let i = 1; i < n; i++) nodes.push(i);

  // If there are lots of stops, fall back to nearest neighbour
  // to avoid factorial explosion (more than 9 middle points).
  if (nodes.length > 9) {
    return optimiseNearestNeighbour(durations);
  }

  let bestRoute = null;
  let bestDuration = Infinity;

  function permute(arr, l) {
    if (l === arr.length) {
      const route = [0, ...arr, 0];
      let total = 0;
      for (let i = 0; i < route.length - 1; i++) {
        const from = route[i];
        const to = route[i + 1];
        total += durations[from][to];
      }
      if (total < bestDuration) {
        bestDuration = total;
        bestRoute = route.slice();
      }
      return;
    }

    for (let i = l; i < arr.length; i++) {
      [arr[l], arr[i]] = [arr[i], arr[l]];
      permute(arr, l + 1);
      [arr[l], arr[i]] = [arr[i], arr[l]];
    }
  }

  permute(nodes, 0);
  return bestRoute;
}
// 4) Main API endpoint: POST /api/optimise-route
// Body example:
// {
//   "start": "OL12 9EH",
//   "stops": ["OL12 9NU", "OL12 0AH", "OL12 0AE", "BB12 9BL", "M24 6XH"]
// }
app.post('/api/optimise-route', async (req, res) => {
  try {
    const { start, stops } = req.body;

    if (!start || !stops || !Array.isArray(stops) || stops.length === 0) {
      return res.status(400).json({
        error: 'Please provide "start" and a non-empty "stops" array.'
      });
    }

    // Build list of all postcodes: start + unique stops (exclude exact duplicate of start)
    const startNorm = String(start).trim().toUpperCase();

    const uniqueStops = [];
    const seen = new Set([startNorm]);

    for (const s of stops) {
      if (!s) continue;
      const norm = String(s).trim().toUpperCase();
      if (!seen.has(norm)) {
        seen.add(norm);
        uniqueStops.push(s);
      }
    }

    const allPostcodes = [start, ...uniqueStops];

    // 1) Geocode each postcode
    const coords = [];
    for (const pc of allPostcodes) {
      const c = await geocodePostcode(pc);
      coords.push(c);
    }

    // 2) Get distance & duration matrix
    const { distances, durations } = await getMatrix(coords);

    // 3) Optimise route (round trip: start -> all stops -> start) using exact duration search
    const routeIdx = optimiseExactByDuration(durations);

    // 4) Build legs & totals
    const orderedPostcodes = routeIdx.map(i => allPostcodes[i]);

    const legs = [];
    let totalDistanceKm = 0;
    let totalDurationMin = 0;

    for (let i = 0; i < routeIdx.length - 1; i++) {
      const fromIdx = routeIdx[i];
      const toIdx = routeIdx[i + 1];

      const distM = distances[fromIdx][toIdx];
      const durS = durations[fromIdx][toIdx];

      const distKm = distM / 1000;
      const distMiles = distKm * 0.621371;
      const durMin = durS / 60;

      totalDistanceKm += distKm;
      totalDurationMin += durMin;

      legs.push({
        from: allPostcodes[fromIdx],
        to: allPostcodes[toIdx],
        distance_miles: Number(distMiles.toFixed(2)),
	distance_km: Number(distKm.toFixed(2)),
        duration_min: Number(durMin.toFixed(1))
      });
    }

    // 5) Build Google Maps URL using ordered postcodes (multi-stop)
    const googleMapsUrl =
      'https://www.google.com/maps/dir/' +
      orderedPostcodes.map(pc => encodeURIComponent(pc)).join('/');

    // 6) Send response
    const totalMiles = totalDistanceKm * 0.621371;

    res.json({
      orderedStops: orderedPostcodes,
      legs,
      totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
      totalDistanceMiles: Number(totalMiles.toFixed(2)),
      totalDurationMin: Number(totalDurationMin.toFixed(1)),
      googleMapsUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Route optimisation failed',
      details: err.message
    });
  }
});

// 5) Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Route planner API listening on port ${PORT}`);
});
