// settings.js — the person's preferences for this phone.
//
// Kept in the database (kv 'settings') and in memory after init(), so any
// module can read them synchronously with getSettings(). Changing one emits
// 'settings:change' on the bus with the full new settings.

import { bus } from './bus.js';
import { getKV, setKV } from './store.js';

export const DEFAULT_SETTINGS = Object.freeze({
  userName: '',               // stamped on photos and exports ("Taken by")
  company: 'DCR Framing',
  units: 'imperial',          // 'imperial' | 'metric'
  stepLength: 0.72,           // meters per walking step, for movement between GPS fixes
  declination: null,          // magnetic declination in degrees east; null = not set (compass alignment covers it)
  photoMaxSize: 4032,         // longest side of saved photos, px
  photoQuality: 0.92,         // JPEG quality of saved photos
  videoQuality: 'high',       // 'high' (1080p) | 'standard' (720p)
  shutterSound: true,
  vibrate: true,
  keepAwake: true,            // keep the screen on while a job walk is open
  mapProvider: 'esri',        // 'esri' (satellite, no key) | 'google' (needs googleMapsKey) | 'osm' (streets)
  googleMapsKey: '',          // a Google Maps Platform browser key with the Map Tiles API enabled
  esriKey: '',                // an ArcGIS Location Platform API key (free tier); without one the public tile endpoint is used
  stampExports: true,         // print date, job and position on exported photos
  backupReminder: true,       // remind to back up after a job walk
  simulate: false,            // demo mode: fake GPS and compass (for trying the app indoors)
  onboarded: false,
});

let current = { ...DEFAULT_SETTINGS };

export async function initSettings() {
  const saved = await getKV('settings', {});
  current = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  return current;
}

export function getSettings() { return current; }

export async function updateSettings(patch) {
  current = { ...current, ...patch };
  await setKV('settings', current);
  bus.emit('settings:change', current);
  return current;
}
