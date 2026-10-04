const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');

const serviceAccount = require('./quake-station-firebase-adminsdk-fbsvc-a63034f825.json');

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const messaging = getMessaging();

console.log('Firebase Admin SDK initialized successfully!');

const USGS_URL_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=1&starttime=';
const NOTIFIED_COLLECTION = 'notified_quakes';
const NOTIFIED_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Distance helper (Haversine, matches the client-side distanceKm) ───────
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ─── Rule matching (mirrors NotificationSettingsService.findMatchingRule) ───
function findMatchingRule(quake, rules, globalMinMagnitude) {
  if (quake.mag != null && globalMinMagnitude != null && quake.mag >= globalMinMagnitude) {
    return { id: 'global', type: 'global', minMagnitude: globalMinMagnitude, label: 'anywhere in the world' };
  }

  for (const rule of rules) {
    if (quake.mag == null || quake.mag < rule.minMagnitude) continue;
    const d = distanceKm(rule.latitude, rule.longitude, quake.lat, quake.lng);
    if (d <= rule.radiusKm) return rule;
  }
  return null;
}

function reasonForRule(rule) {
  if (rule.type === 'global') {
    return `Magnitude ≥ ${rule.minMagnitude} anywhere in the world`;
  }
  return `Within ${rule.radiusKm}km of ${rule.label}`;
}

function buildAlertEmoji(mag) {
  if (mag >= 6.0) return '🚨';
  if (mag >= 4.0) return '⚠️';
  return 'ℹ️';
}

function buildPayload({ token, quake, matchingRule, titlePrefix = '' }) {
  const alertEmoji = buildAlertEmoji(quake.mag);
  const title = `${alertEmoji} ${titlePrefix}Magnitude ${quake.mag} Earthquake`;
  const body = `${quake.place} (${reasonForRule(matchingRule)})`;

  return {
    token,
    notification: { title, body },
    data: {
      earthquakeId: String(quake.id),
      magnitude: String(quake.mag),
    },
    android: {
      priority: quake.mag >= 4.0 ? 'high' : 'normal',
      notification: { channelId: 'default_channel_id' },
    },
  };
}

// ─── Notified-quake dedup (persisted in Firestore, survives across runs) ────
async function loadNotifiedIds(deviceToken) {
  const snap = await db.collection(NOTIFIED_COLLECTION).doc(deviceToken).get();
  if (!snap.exists) return new Set();
  const data = snap.data();
  if (!data.updatedAt || Date.now() - data.updatedAt > NOTIFIED_TTL_MS) return new Set();
  return new Set(data.quakeIds || []);
}

async function saveNotifiedIds(deviceToken, idsSet) {
  await db
    .collection(NOTIFIED_COLLECTION)
    .doc(deviceToken)
    .set({ quakeIds: Array.from(idsSet), updatedAt: Date.now() });
}

// ─── USGS feed ────────────────────────────────────────────────────────────
async function fetchQuakes() {
  const tenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  //const url = USGS_URL_BASE + tenMinutesAgo;
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=1&starttime=2026-10-04T14:05:23.166Z&endtime=2026-10-04T14:20:27.016Z'
  console.log(`[fetchQuakes] Querying: ${url}`);
  console.log(`[fetchQuakes] Current time (Date.now()): ${new Date().toISOString()}`);

  let response;
  try {
    response = await axios.get(url, {
      // Force no caching, no compression weirdness, explicit JSON handling
      headers: { 'Accept': 'application/geo+json, application/json' },
      // Log the raw response size to rule out truncation
      transformResponse: [(data) => {
        console.log(`[fetchQuakes] Raw response body length (chars): ${typeof data === 'string' ? data.length : 'already parsed, type: ' + typeof data}`);
        return typeof data === 'string' ? JSON.parse(data) : data;
      }],
    });
  } catch (err) {
    console.error(`[fetchQuakes] axios.get threw an error:`, err.message);
    if (err.response) {
      console.error(`[fetchQuakes] Error response status: ${err.response.status}, data:`, JSON.stringify(err.response.data).slice(0, 500));
    }
    throw err;
  }

  console.log(`[fetchQuakes] response.headers:`, JSON.stringify(response.headers));
  console.log(`[fetchQuakes] Raw response.data.metadata:`, JSON.stringify(response.data.metadata));
  console.log(`[fetchQuakes] response.data.features is array: ${Array.isArray(response.data.features)}`);
  console.log(`[fetchQuakes] response.data.features.length (raw, before map): ${response.data.features ? response.data.features.length : 'undefined'}`);

  const features = response.data.features || [];
  const mapped = features.map((f) => ({
    id: f.id,
    mag: f.properties.mag,
    place: f.properties.place || '',
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));

  console.log(`[fetchQuakes] USGS responded with ${features.length} feature(s). HTTP status: ${response.status}`);
  console.log(`[fetchQuakes] Mapped ${mapped.length} quake(s). IDs: ${mapped.map(q => q.id).join(', ')}`);
  console.log(`[fetchQuakes] metadata.count vs features.length: ${response.data.metadata?.count} vs ${features.length}`);

  return mapped;
}

// ─── Shared core: evaluate a list of quakes against every user's rules ─────
//
// Used by both the production path (real USGS quakes) and the filtering
// test path (mock quakes). Handles the dedup bookkeeping and actually
// sends via FCM. Set `dryRun: true` to log matches without sending or
// touching the dedup store (useful for testing without spamming devices).
async function processQuakesForAllUsers(quakes, { dryRun = false, titlePrefix = '' } = {}) {
  if (quakes.length === 0) {
    console.log('[processQuakes] No quakes to process.');
    return { sentCount: 0 };
  }

  const usersSnap = await db.collection('users').get();
  console.log(`[processQuakes] Loaded ${usersSnap.size} user(s).`);

  let sentCount = 0;

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();
    const deviceToken = user.deviceToken || userDoc.id;
    const userTag = `[user:${userDoc.id.slice(0, 8)}...]`;

    if (!user.globalEnabled) {
      console.log(`${userTag} SKIPPED USER: globalEnabled is false.`);
      continue;
    }
    if (!Array.isArray(user.rules) || user.rules.length === 0) {
      console.log(`${userTag} SKIPPED USER: no rules configured.`);
      continue;
    }
    if (!deviceToken) {
      console.log(`${userTag} SKIPPED USER: no deviceToken.`);
      continue;
    }

    console.log(`${userTag} Evaluating with globalMinMagnitude=${user.globalMinMagnitude}, ${user.rules.length} rule(s): [${user.rules.map(r => `${r.label}(min:${r.minMagnitude}, r:${r.radiusKm}km)`).join(', ')}]`);

    const notifiedIds = dryRun ? new Set() : await loadNotifiedIds(deviceToken);
    let changed = false;

    for (const quake of quakes) {
      const quakeTag = `${userTag} [quake:${quake.id}]`;

      if (!dryRun && notifiedIds.has(quake.id)) {
        console.log(`${quakeTag} SKIPPED: already notified (dedup).`);
        continue;
      }

      const matchingRule = findMatchingRule(quake, user.rules, user.globalMinMagnitude);
      if (!matchingRule) {
        console.log(`${quakeTag} SKIPPED: mag ${quake.mag} — no matching rule (global=${user.globalMinMagnitude}, zones checked: ${user.rules.length}).`);
        continue;
      }

      const payload = buildPayload({ token: deviceToken, quake, matchingRule, titlePrefix });

      if (dryRun) {
        console.log(`${quakeTag} [DRY RUN] Would notify (rule: ${matchingRule.id}, mag ${quake.mag}).`);
        sentCount++;
        continue;
      }

      try {
        await getMessaging().send(payload);
        sentCount++;
        notifiedIds.add(quake.id);
        changed = true;
        console.log(`${quakeTag} ✅ NOTIFIED (rule: ${matchingRule.id}, mag ${quake.mag}).`);
      } catch (err) {
        console.error(`${quakeTag} ❌ SEND FAILED: ${err.message}`);

        if (err.code === 'messaging/registration-token-not-registered') {
          console.warn(`${userTag} Token no longer registered — removing user document from Firestore.`);
          try {
            await db.collection('users').doc(userDoc.id).delete();
            await db.collection(NOTIFIED_COLLECTION).doc(deviceToken).delete().catch(() => {});
            console.log(`${userTag} Cleaned up stale user (and dedup entry).`);
          } catch (cleanupErr) {
            console.error(`${userTag} Failed to clean up stale user:`, cleanupErr.message);
          }
          // Stop processing further quakes for this now-deleted user.
          break;
        }
      }
    }

    if (!dryRun && changed) {
      await saveNotifiedIds(deviceToken, notifiedIds);
    }
  }

  console.log(`[processQuakes] Done. ${dryRun ? 'Would have sent' : 'Sent'} ${sentCount} notification(s).`);
  return { sentCount };
}

// ─── PRODUCTION ─────────────────────────────────────────────────────────────
async function checkAndNotifyUsers() {
  try {
    console.log('Checking USGS for recent seismic activity...');
    const quakes = await fetchQuakes();
    console.log(`Fetched ${quakes.length} quake(s).`);
    await processQuakesForAllUsers(quakes);
  } catch (error) {
    console.error('Error running quake-monitor script:', error);
    process.exitCode = 1;
  }
}

// ─── TESTING: raw delivery check (bypasses rules, always sends to one token) ─
async function testQuakeMonitor() {
  try {
    console.log('🧪 RUNNING LOCAL BACKEND EMULATOR TEST (raw delivery)...');
    const TEST_DEVICE_TOKEN = process.env.TEST_DEVICE_TOKEN;
    if (!TEST_DEVICE_TOKEN) {
      console.error('❌ TEST_DEVICE_TOKEN is not set.');
      return;
    }

    const mockQuakes = [
      { id: `mock_quake_minor_${Date.now()}`, mag: 2.3, place: 'Minor Tremor Jakarta City', lat: -6.2088, lng: 106.8456 },
      { id: `mock_quake_major_${Date.now()}`, mag: 5.7, place: 'Major Fault Jakarta City', lat: -6.2088, lng: 106.8456 },
    ];

    // Fake "always matching" rule just for the raw delivery smoke test.
    const alwaysMatchRule = {
      id: 'test-rule',
      type: 'region',
      latitude: -6.2088,
      longitude: 106.8456,
      radiusKm: 100,
      label: 'Test Area',
      minMagnitude: 0,
    };

    for (const quake of mockQuakes) {
      const payload = buildPayload({
        token: TEST_DEVICE_TOKEN,
        quake,
        matchingRule: alwaysMatchRule,
        titlePrefix: 'Test: ',
      });
      await getMessaging().send(payload);
      console.log(`📡 Successfully dispatched Mock Quake (Mag: ${quake.mag}) to test device`);
    }

    console.log('✅ Raw delivery test complete.');
  } catch (error) {
    console.error('Error running testQuakeMonitor:', error);
  }
}

// ─── TESTING: real filtering check (uses actual Firestore rules) ───────────
async function testQuakeMonitorWithFiltering() {
  try {
    console.log('🧪 RUNNING FILTERING TEST (real rules, mock quakes)...');

    const mockQuakes = [
      { id: `mock_quake_minor_${Date.now()}`, mag: 2.3, place: 'Minor Tremor Jakarta City', lat: -6.2088, lng: 106.8456 },
      { id: `mock_quake_major_${Date.now()}`, mag: 5.7, place: 'Major Fault Jakarta City', lat: -6.2088, lng: 106.8456 },
    ];

    // dryRun: true → logs what WOULD be sent per user's real rules, without
    // actually calling FCM or touching the notified_quakes dedup store.
    // Flip to false once you're happy with the logged decisions, to also
    // receive the real push notifications on your device.
    await processQuakesForAllUsers(mockQuakes, { dryRun: false, titlePrefix: 'Test: ' });

    console.log('✅ Filtering test complete.');
  } catch (error) {
    console.error('Error running testQuakeMonitorWithFiltering:', error);
  }
}

// ─── EXECUTION SWITCHBOARD ──────────────────────────────────────────────────
checkAndNotifyUsers();            // 🟢 Production (real USGS + real rules)
// testQuakeMonitor();               // 🔵 Raw delivery smoke test (ignores rules)
//testQuakeMonitorWithFiltering();     // 🟡 Filtering test (mock quakes + real rules)
