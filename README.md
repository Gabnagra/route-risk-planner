# Route Risk Planner

Open-source route risk assessment in the browser. Enter an origin, a destination and a departure time; the planner calculates the route and its alternatives and assesses each one, factor by factor, using open data.

**Live:** https://gabnagra.github.io/route-risk-planner/

## What it assesses

| Factor | Source | Coverage |
|---|---|---|
| Routes and alternatives (vehicle / on foot) | OSRM on OpenStreetMap | Global |
| Hospitals, clinics, pharmacies, police, fire stations, embassies and consulates, fuel, hotels, transit stations | Overpass API (OpenStreetMap) | Global |
| Choke points (bridges and tunnels on the route) | Overpass API (OpenStreetMap) | Global |
| Medical access: distance to the nearest mapped hospital along the route | Overpass API | Global |
| Weather at departure, midpoint and arrival (precipitation, gusts, visibility, storms, snow, fog) | Open-Meteo | Global, 16-day forecast |
| Darkness at departure or arrival | Open-Meteo (sunrise / sunset) | Global |
| Crime exposure: street-level crimes within 150 m of each 1 km segment, weighted by category | data.police.uk | England, Wales and Northern Ireland |
| Analyst risk zones: polygons drawn and rated by the user | User input | Global |

## Method

- Each factor is rated **Low / Elevated / High** and shown separately. The planner does **not** compute a probability of incident.
- Crime exposure is a **relative** index: segments are ranked by weighted crimes per km across all routes analysed, and routes are ranked against each other.
- "Highest-rated factor" summarises the most severe individual rating; it is not a composite score.
- Analyst risk zones cover areas without open crime data or where local knowledge prevails.

## Limitations

Open data can be incomplete or out of date, and public APIs are rate-limited. The tool supports, and does not replace, a professional route assessment and on-the-ground reconnaissance.

## Stack

Static HTML, CSS and JavaScript; Leaflet and Leaflet.draw. No build step and no API keys.
