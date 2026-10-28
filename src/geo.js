// Country centroids (lat, lon) + equirectangular projection for bubble maps.
// Coordinates are approximate geographic centers — good enough for bubbles.

export const MAP_W = 1280
export const MAP_H = 720

// Keyed by lowercase canonical name.
const CENTROIDS = {
  'united states': [39.8, -98.5],
  canada: [56.1, -106.3],
  mexico: [23.6, -102.5],
  brazil: [-14.2, -51.9],
  argentina: [-35.4, -65.2],
  chile: [-33.4, -70.7],
  colombia: [4.6, -74.1],
  peru: [-9.2, -75.0],
  venezuela: [6.4, -66.6],
  'united kingdom': [54.0, -2.0],
  ireland: [53.4, -8.2],
  france: [46.6, 2.4],
  germany: [51.2, 10.4],
  spain: [40.3, -3.7],
  portugal: [39.4, -8.0],
  italy: [41.9, 12.6],
  netherlands: [52.1, 5.3],
  belgium: [50.5, 4.5],
  switzerland: [46.8, 8.2],
  austria: [47.5, 14.5],
  poland: [51.9, 19.1],
  sweden: [62.0, 15.0],
  norway: [64.5, 11.5],
  finland: [61.9, 25.7],
  denmark: [56.0, 10.0],
  greece: [39.1, 22.0],
  turkey: [38.9, 35.2],
  ukraine: [49.0, 32.0],
  russia: [61.0, 90.0],
  egypt: [26.8, 30.8],
  morocco: [31.8, -6.1],
  nigeria: [9.1, 8.7],
  kenya: [0.0, 37.9],
  'south africa': [-28.5, 24.7],
  'saudi arabia': [24.0, 45.0],
  'united arab emirates': [24.0, 54.0],
  israel: [31.0, 34.8],
  india: [21.0, 78.0],
  pakistan: [30.4, 69.3],
  bangladesh: [23.7, 90.4],
  'sri lanka': [7.9, 80.8],
  china: [35.9, 104.2],
  japan: [36.2, 138.3],
  'south korea': [35.9, 127.8],
  taiwan: [23.7, 121.0],
  'hong kong': [22.3, 114.2],
  singapore: [1.35, 103.8],
  malaysia: [4.2, 102.2],
  thailand: [15.9, 101.0],
  vietnam: [14.1, 108.3],
  indonesia: [-2.5, 118.0],
  philippines: [13.0, 122.0],
  australia: [-25.3, 133.8],
  'new zealand': [-41.0, 174.0],
}

const ALIASES = {
  usa: 'united states',
  'united states of america': 'united states',
  america: 'united states',
  us: 'united states',
  uk: 'united kingdom',
  england: 'united kingdom',
  'great britain': 'united kingdom',
  britain: 'united kingdom',
  uae: 'united arab emirates',
  dubai: 'united arab emirates',
  korea: 'south korea',
  'republic of korea': 'south korea',
  'russian federation': 'russia',
  'viet nam': 'vietnam',
  'czech republic': 'czechia',
  'ivory coast': "cote d'ivoire",
  tanzania: 'tanzania',
}

export function countryCoords(name) {
  const key = String(name || '').toLowerCase().trim()
  const canon = ALIASES[key] || key
  return CENTROIDS[canon] || null
}

/** Equirectangular projection into the 1280x720 canvas (padded). */
export function project(lat, lon) {
  const padX = 70, padY = 60
  const x = padX + ((lon + 180) / 360) * (MAP_W - padX * 2)
  const cLat = Math.min(82, Math.max(-62, lat))
  const y = padY + ((82 - cLat) / (82 + 62)) * (MAP_H - padY * 2)
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
}
